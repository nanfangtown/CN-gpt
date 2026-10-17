/**
 * 出图缓存（2026-10-13 加）。
 *
 * 解决什么：`qwen_draw` 相同 prompt + 相同参数调两次就是两次计费、两张几乎一样的图。
 * 出图是**按张计费**的（qwen-image-3.0 0.18 元/张），重复生成纯属浪费。
 *
 * 设计要点：
 *   - 键 = prompt + 模型 + 尺寸 + 张数 + 负面提示 + **盐**（`cacheKeySalt`）。
 *     盐是给人用的"我要重新生成一次"开关：改掉盐即让所有旧缓存失效，不用删文件。
 *   - 命中后**不再计费**（不写账本、不消耗调用预算），并在结果里明确标注"缓存命中"，
 *     免得用户以为这次没花钱却看到账单少了一笔而困惑。
 *   - 命中后校验产物文件仍存在；文件被删就当未命中（避免返回死路径）。
 *   - 缓存写坏 / 读不动**绝不影响出图**：失败只记日志。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// 2026-10-17：升到 2 —— 键里新增了**输入图指纹**（图生图）。
// 不升版本的话，一张"文生图"的旧缓存会被"图生图"请求命中，返回一张完全无关的图。
const CACHE_VERSION = 2
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** 缓存文件位置（与账本、任务注册表同处 ~/.dsh）。 */
export function cacheFilePath(config) {
  const configured = typeof config?.imageCachePath === 'string' ? config.imageCachePath.trim() : ''
  if (configured.length > 0) return configured
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'mm-models-image-cache.json')
}

/**
 * 输入图指纹：只哈希，不把 data URL 原样塞进缓存键（一张图可能上 MB）。
 * @param {Array<{url?: string, dataUrl?: string}>} [images] - 图生图的输入图。
 * @returns {string} 无图时返回空串（纯文生图的键因此与历史语义一致）。
 */
export function imagesFingerprintOf(images) {
  if (!Array.isArray(images) || images.length === 0) return ''
  const joined = images.map((image) => image?.url ?? image?.dataUrl ?? '').join('\n')
  return createHash('sha256').update(joined).digest('hex').slice(0, 16)
}

/**
 * 计算缓存键。
 *
 * 只纳入**影响出图结果**的字段；盐用来强制失效。
 * @param {object} spec - { model, prompt, n, size?, negativePrompt?, images? }。
 * @param {object} config - 插件 Config（取 cacheKeySalt）。
 * @returns {string} 16 进制摘要。
 */
export function cacheKeyOf(spec, config) {
  const salt = typeof config?.cacheKeySalt === 'string' ? config.cacheKeySalt : ''
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    salt,
    model: spec?.model ?? '',
    prompt: spec?.prompt ?? '',
    n: Number(spec?.n ?? 1),
    size: spec?.size ?? '',
    negativePrompt: spec?.negativePrompt ?? '',
    // 图生图：同一句 prompt 配不同的原图，必须是不命中同一个缓存的两件事。
    images: imagesFingerprintOf(spec?.images),
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

function maxEntriesOf(config) {
  const value = Number(config?.maxCacheEntries)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_MAX_ENTRIES
}

function ttlOf(config) {
  const value = Number(config?.cacheTtlMs)
  if (Number.isFinite(value) && value >= 0) return value
  return DEFAULT_TTL_MS
}

async function readCache(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return { version: CACHE_VERSION, entries: parsed.entries }
    }
  } catch {
    // 首次运行 / 文件损坏 → 空缓存。
  }
  return { version: CACHE_VERSION, entries: [] }
}

async function writeCache(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function expired(entry, now, ttl) {
  if (ttl === 0) return false
  const at = Number(entry?.at)
  if (!Number.isFinite(at)) return true
  return now - at > ttl
}

/** 产物的本地路径是否都还在（被删了就当未命中，别返回死路径）。 */
async function artifactsAlive(images) {
  if (!Array.isArray(images) || images.length === 0) return false
  for (const image of images) {
    if (typeof image?.path !== 'string' || image.path.length === 0) return false
    try {
      const info = await stat(image.path)
      if (!info.isFile() || info.size === 0) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 打开出图缓存。
 * @param {object} config - 插件 Config（liveConfig）。
 * @param {object} [logger] - 可选 logger。
 * @returns {Promise<object>} cache：{ get, put, path }
 */
export async function openImageCache(config, logger) {
  const log = (level, message) => {
    const fn = logger?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(logger, '[mm-models] ' + message)
      } catch {
        // 日志失败不影响缓存。
      }
    }
  }
  const path = cacheFilePath(config)
  let writeChain = Promise.resolve()
  const enqueue = (task) => {
    const next = writeChain.then(task, task)
    writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return {
    path,
    /**
     * 查缓存。命中返回产物数组（与工具返回的 images 同形状），未命中返回 undefined。
     * @param {string} key - cacheKeyOf 的结果。
     */
    async get(key) {
      try {
        const state = await readCache(path)
        const now = Date.now()
        const ttl = ttlOf(config)
        const entry = state.entries.find((row) => row?.key === key)
        if (entry === undefined) return undefined
        if (expired(entry, now, ttl)) return undefined
        if (!(await artifactsAlive(entry.images))) {
          log('debug', '出图缓存命中但产物已被删除，按未命中处理：' + key)
          return undefined
        }
        return entry.images
      } catch (error) {
        log('warn', '读取出图缓存失败（按未命中处理）：' + String(error?.message ?? error))
        return undefined
      }
    },
    /**
     * 写缓存。失败只记日志，绝不影响出图。
     * @param {string} key - cacheKeyOf 的结果。
     * @param {object[]} images - 工具返回的 images 数组。
     * @param {object} meta - { model, prompt } 便于人工排查。
     */
    async put(key, images, meta = {}) {
      if (!Array.isArray(images) || images.length === 0) return false
      try {
        await enqueue(async () => {
          const state = await readCache(path)
          const kept = state.entries.filter((row) => row?.key !== key)
          kept.unshift({ key, at: Date.now(), model: meta.model, prompt: meta.prompt, images })
          await writeCache(path, { version: CACHE_VERSION, entries: kept.slice(0, maxEntriesOf(config)) })
        })
        return true
      } catch (error) {
        log('warn', '写出图缓存失败（不影响本次调用）：' + String(error?.message ?? error))
        return false
      }
    },
  }
}
