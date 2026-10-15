/**
 * 落盘、命名、内容块（规划 [3.4] 下载策略 / [8.1] core\deliver.mjs）。
 *
 * 约定：
 *   - 产物落 outDir（图片 gen\，视频 gen\video\）；不自动删用户文件；
 *   - 文件名 = 提示词片段 + 时间戳 + 短哈希，冲突时追加序号；
 *   - 图片优先交给 ctx.attachments 持久化为附件，返回图片内容块；服务缺失时退化为文字 + 本地路径；
 *   - 签名 URL 只用于下载，绝不写进工具结果。
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'

import { CODES, MediaError } from './errors.mjs'

/** 会话工作目录（与 dsh-tool-fs 相同的取值方式）。 */
export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

/**
 * 解析产物目录。相对路径按会话工作目录（无会话时按进程 cwd）解析。
 * @param {object} options - configValue（Config 里的 outDir）/ exec / now。
 * @returns {string} 绝对目录。
 */
export function resolveOutDir({ configValue, exec }) {
  const base = sessionCwd(exec) ?? process.cwd()
  const value = typeof configValue === 'string' && configValue.trim().length > 0 ? configValue.trim() : 'gen'
  return isAbsolute(value) ? value : resolve(base, value)
}

/** 文件名安全化：保留中英文、数字、-_，其余折叠为 _。 */
export function slugify(text, max = 32) {
  const raw = typeof text === 'string' ? text.trim() : ''
  const safe = raw
    .replace(/[\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/[^\p{Script=Han}a-zA-Z0-9._-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  const clipped = safe.slice(0, max)
  return clipped.length > 0 ? clipped : 'media'
}

/** YYYYMMDD-HHmmss。 */
export function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 短哈希（避免同名覆盖）。 */
export function shortHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 6)
}

/** 确保目录存在。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

/** 生成不冲突的目标路径。 */
export function uniquePath(dir, name, ext) {
  const suffix = ext.startsWith('.') ? ext : `.${ext}`
  const base = `${name}${suffix}`
  if (!existsSync(join(dir, base))) return join(dir, base)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = join(dir, `${name}-${index}${suffix}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${name}-${Date.now()}${suffix}`)
}

const MEDIA_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
})

/** 由 URL / 文件名猜媒体类型。 */
export function mediaTypeFromName(urlOrPath) {
  try {
    const pathname = new URL(urlOrPath).pathname
    return MEDIA_TYPES[extname(pathname).toLowerCase()]
  } catch {
    return MEDIA_TYPES[extname(urlOrPath).toLowerCase()]
  }
}

/** 由二进制签名猜媒体类型（先 PNG/JPEG/GIF/WebP，再 MP4/WebM）。 */
export function mediaTypeFromBytes(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString('latin1')
    if (brand.startsWith('qt')) return 'video/quicktime'
    return 'video/mp4'
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm'
  return undefined
}

const EXT_BY_MEDIA_TYPE = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
})

/** 媒体类型 → 默认扩展名。 */
export function extensionFor(mediaType, fallback = '.bin') {
  return EXT_BY_MEDIA_TYPE[mediaType] ?? fallback
}

/** 读出 PNG/JPEG/GIF 的像素尺寸；识别不了返回 undefined（用于无附件服务时的文字结果）。 */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 16) return undefined
  // PNG: IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后。
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  // GIF: 逻辑屏幕描述符。
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  // JPEG: 扫描 SOF0-SOF15。
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      if (length < 2) break
      offset += 2 + length
    }
  }
  return undefined
}

/**
 * 下载产物到本地。签名 URL 只用一次，不落进结果。
 *
 * 失败一律抛 `MediaError`，并**明确标注 `retriable`**：
 *   - `retriable: false` —— 体积超限、HTTP 4xx。重试不会改变结果，
 *     调用方（tasks/manager.mjs fetchArtifacts）据此**跳过重试**。
 *     2026-10-13 之前这里是裸 Error，manager 只看"抛没抛"，
 *     于是超过 maxDownloadBytes 的产物会被**完整重下三次**（字节全白流）。
 *   - `retriable: true` —— 网络层异常、HTTP 5xx/429。
 *   - 调用方主动取消时是 ABORTED，不参与重试判定。
 *
 * 体积上限按**流式**执行：先看 content-length 快速拒绝，读到一半超限立刻中止，
 * 不把超限产物整个读进内存（旧实现先 arrayBuffer() 再判，等于先吃满内存再报错）。
 *
 * @param {string} url - 产物 URL。
 * @param {object} options - outDir / name / signal / maxBytes / fetchImpl / expectedMediaType。
 * @returns {{ path: string, bytes: number, mediaType: string, contentType?: string }}
 */
export async function downloadToFile(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024
  let response
  try {
    response = await fetchImpl(url, options.signal === undefined ? {} : { signal: options.signal })
  } catch (error) {
    if (options.signal?.aborted) {
      throw new MediaError(CODES.ABORTED, '已取消本地等待：产物下载被中止', { cause: error, retriable: false })
    }
    throw new MediaError(CODES.UNAVAILABLE, `产物下载失败：${clipMessage(error)}`, { cause: error, retriable: true })
  }
  if (!response.ok) {
    // 4xx（签名过期/不存在）重试无意义；429/5xx 值得重试。
    const status = Number(response.status)
    const retriable = status === 408 || status === 425 || status === 429 || status >= 500
    throw new MediaError(CODES.UNAVAILABLE, `产物下载失败：HTTP ${status}`, { status, retriable })
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new MediaError(CODES.BAD_REQUEST, `产物过大：${declaredLength} 字节超过上限 ${maxBytes}`, { retriable: false })
  }

  const buffer = await readBodyWithLimit(response, maxBytes, options.signal)
  const contentType = response.headers.get('content-type') ?? undefined
  const mediaType = options.expectedMediaType ?? mediaTypeFromBytes(buffer) ?? mediaTypeFromName(url) ?? contentType?.split(';')[0]?.trim() ?? 'application/octet-stream'
  await ensureDir(options.outDir)
  let urlExt = '.bin'
  try {
    urlExt = extname(new URL(url).pathname) || '.bin'
  } catch {
    urlExt = extname(String(url)) || '.bin'
  }
  const ext = extensionFor(mediaType, urlExt)
  const path = uniquePath(options.outDir, options.name ?? `artifact-${shortHash(url)}`, ext)
  await writeFile(path, buffer)
  return { path, bytes: buffer.byteLength, mediaType, ...(contentType === undefined ? {} : { contentType }) }
}

/** 异常 → 短消息（不引 errors.clip，避免循环依赖之外的额外耦合）。 */
function clipMessage(error) {
  const text = String(error?.message ?? error ?? '未知错误')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 读响应体，边读边计数，超过上限立刻中止。
 * 没有流式读取能力（部分测试替身）时退化为一次性读取后再判。
 */
async function readBodyWithLimit(response, maxBytes, signal) {
  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new MediaError(CODES.BAD_REQUEST, `产物过大：${buffer.byteLength} 字节超过上限 ${maxBytes}`, { retriable: false })
    }
    return buffer
  }
  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new MediaError(CODES.BAD_REQUEST, `产物过大：已读 ${total} 字节超过上限 ${maxBytes}`, { retriable: false })
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    // 主动中止下载，别让服务端继续推。
    try {
      await reader.cancel()
    } catch {
      // 取消失败不影响抛出原因。
    }
    if (error instanceof MediaError) throw error
    if (signal?.aborted) throw new MediaError(CODES.ABORTED, '已取消本地等待：产物下载被中止', { cause: error, retriable: false })
    throw new MediaError(CODES.UNAVAILABLE, `产物下载中断：${clipMessage(error)}`, { cause: error, retriable: true })
  }
  return Buffer.concat(chunks, total)
}

/**
 * 把图片持久化为 harness 附件（需要 ctx.attachments；缺失时返回 undefined）。
 * 附件是"图片内容块"到达模型的前提。
 */
export async function attachImage(ctx, { bytes, mediaType, name }) {
  const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
  if (attachments === undefined || typeof attachments.saveImage !== 'function') return undefined
  try {
    const ref = await attachments.saveImage({ data: bytes, mediaType, name })
    if (ref === undefined || ref === null) return undefined
    return ref
  } catch {
    return undefined
  }
}

/** 附件引用 → 模型可见的图片内容块。 */
export function imageContentBlock(ref) {
  return {
    type: 'image',
    attachment: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
    },
  }
}

/**
 * 这张图要不要作为内容块附回模型上下文？
 *
 * 默认**不附**（`attachResultImages` 默认 false）。理由见 Config 里的注释：
 * 大图会触发视觉路由的上传/内联工作，失败即 TRANSPORT 并连试 5 次、拖垮整轮；
 * 而多数路由对单图有硬性 token 上限（DeepSeek 是 1024），本来就会降采样。
 *
 * @param {object} config - 插件配置（volatile 已解包）。
 * @param {object} image - { attachmentId, bytes }。
 * @returns {boolean}
 */
export function shouldAttachImage(config, image) {
  if (config?.attachResultImages !== true) return false
  if (typeof image?.attachmentId !== 'string' || image.attachmentId.length === 0) return false
  const cap = Number(config?.maxAttachImageBytes ?? 0)
  if (Number.isFinite(cap) && cap > 0 && Number(image.bytes) > cap) return false
  return true
}

/** 供结果/日志用的短路径显示。 */
export function displayPath(path, cwd = process.cwd()) {
  const absolute = resolve(path)
  const base = resolve(cwd)
  return absolute.startsWith(base) ? absolute.slice(base.length + 1) : absolute
}

/** 从 URL 提取不含签名的文件名提示。 */
export function nameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname
    return basename(pathname) || 'artifact'
  } catch {
    return basename(String(url)) || 'artifact'
  }
}
