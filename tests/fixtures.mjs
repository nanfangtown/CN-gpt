/** 测试夹具：真实 PNG/MP4 字节 + 假 host ctx。 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 生成一张真实可解码的 PNG（RGB，8bit）。 */
export function makePng(width, height, rgb = [200, 40, 60]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 生成一段近似 MP4 的字节（ftyp 盒子，够签名识别与落盘）。 */
export function makeMp4(size = 64) {
  const head = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00])
  const body = Buffer.alloc(Math.max(0, size - head.length), 0x00)
  return Buffer.concat([head, body])
}

/**
 * 假 host ctx：只实现插件用到的服务面（credentials / attachments / storageDomain / llm / tools / systemPrompt / effect）。
 * @param {object} options - credentials（refName → value）/ attachments / llmProviders / saveImage。
 */
export function createFakeCtx(options = {}) {
  const credentials = new Map(Object.entries(options.credentials ?? {}))
  const tools = []
  const guards = []
  const sections = []
  const disposers = []
  const listeners = []
  const warnings = []
  let attachmentSeq = 0

  const ctx = {
    logger: {
      info() {},
      warn(message) {
        warnings.push(String(message))
      },
      debug() {},
      error() {},
    },
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            const key = String(ref).replace(/^ref:/, '')
            const value = credentials.get(key)
            return value === undefined ? undefined : { value, source: 'environment' }
          },
          async describe(ref) {
            const key = String(ref).replace(/^ref:/, '')
            const value = credentials.get(key)
            return { configured: value !== undefined, source: value === undefined ? undefined : 'environment', writable: true }
          },
        }
      }
      if (name === 'attachments') {
        if (options.attachments === false) return undefined
        return {
          async saveImage({ data, mediaType, name }) {
            attachmentSeq += 1
            return options.saveImage === undefined
              ? { attachmentId: `att-${attachmentSeq}`, mediaType, bytes: data.length, width: 4, height: 4, name }
              : options.saveImage({ data, mediaType, name, seq: attachmentSeq })
          },
        }
      }
      if (name === 'storageDomain') return options.storageDomain
      if (name === 'llm') return { listProviders: () => (options.llmProviders ?? []).map((id) => ({ id })) }
      // 2026-10-17：读图员由插件自己注册，执行时要拿 subagents 服务。
      // 默认「没有这个服务」，需要它的用例显式传 options.subagents。
      if (name === 'subagents') return options.subagents
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    on(event, callback) {
      listeners.push({ event, callback })
      return () => {}
    },
    tools: {
      register(definition) {
        tools.push(definition)
      },
      guard(guard) {
        // 记录注册顺序（label 为 null 时测试仍可按顺序取用）。
        // 测试通过 run.mjs 的 guardOf(fake, label) 按**标签**取用，避免散落的下标耦合。
        guards.push({ label: null, fn: guard })
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
  }
  return { ctx, tools, guards, sections, disposers, listeners, credentials, warnings }
}

/** 构造 exec（工具执行上下文的最小实现）。 */
export function makeExec({ cwd, sessionId = 'sess-test', signal } = {}) {
  return {
    agent: { session: { id: sessionId, header: { cwd: cwd ?? process.cwd() } } },
    signal: signal ?? new AbortController().signal,
  }
}

/**
 * 假 storageDomain：内存版领域，验证"优先使用宿主 storage 服务"的账本路径。
 * 只实现 open(spec) → domain.table(name).{get,put,entries,keys,size} + close()。
 */
export function createFakeStorageDomain() {
  const openDomains = new Map()
  return {
    opened: openDomains,
    async open(spec) {
      const tables = new Map(Object.keys(spec.tables ?? {}).map((name) => [name, new Map()]))
      const domain = {
        name: spec.name,
        table(name) {
          const table = tables.get(name)
          if (table === undefined) throw new Error(`no table ${name}`)
          return {
            get: (key) => table.get(key),
            put: async (key, value) => {
              table.set(key, value)
            },
            delete: async (key) => table.delete(key),
            entries: () => table.entries(),
            keys: () => table.keys(),
            get size() {
              return table.size
            },
          }
        },
        async close() {
          openDomains.delete(spec.name)
        },
      }
      openDomains.set(spec.name, { spec, domain })
      return domain
    },
  }
}

/** 生成左右两半不同颜色的真实 PNG（用于视觉模型实跑验证）。 */
export function makeSplitPng(width, height, leftRgb, rightRgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const rgb = x < width / 2 ? leftRgb : rightRgb
      const at = rowStart + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
