/**
 * 图片入参解析（2026-10-17 抽出）。
 *
 * `qwen_draw` 的图生图与 `seedance_video` 的图生视频**共用同一套约束**，所以放在这里而不是
 * 各写一份——两份实现迟早会漂移，而这条链路上漂移的代价是"安全边界失守"。
 *
 * 本地路径要过三关：**在允许的根目录内** → **是普通文件且在体积上限内** → **内容签名确实是图片**。
 * 只改扩展名的假图片会被最后一条拦下。
 *
 * 为什么要有 containment：本插件用 `node:fs` 直接读写，**不受宿主工作区沙箱约束**；
 * 入参若能指向任意可读文件，就等于一条"把本机文件 base64 发到第三方 API"的通道
 * （2026-10-16 评审实测：可读 `~/.dsh/.env`）。
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, resolve } from 'node:path'
import { CODES, MediaError } from './errors.mjs'
import { imageSize, isInside, mediaTypeFromBytes } from './deliver.mjs'

/**
 * 允许读取本地图片的根目录。
 *
 * 默认只有**会话工作目录**；环境变量 `DSH_MM_MODELS_IMAGE_ROOTS` 可按平台路径分隔符
 * 追加额外根目录（给"图在另一个项目目录里"这种真实用法留的口子，且必须由用户显式设置）。
 *
 * @param {object} exec - 工具执行上下文（取 agent.session.header.cwd）。
 * @returns {string[]} 允许的根目录列表。
 */
export function allowedImageRoots(exec) {
  const roots = []
  const cwd = exec?.agent?.session?.header?.cwd
  roots.push(typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd())
  const extra = process.env.DSH_MM_MODELS_IMAGE_ROOTS
  if (typeof extra === 'string') {
    for (const piece of extra.split(delimiter)) {
      const trimmed = piece.trim()
      if (trimmed.length > 0) roots.push(trimmed)
    }
  }
  return roots
}

/**
 * 把图片参数解析成 `{ url }` 或 `{ dataUrl, display }`。
 *
 * @param {string} image - http(s) URL，或本地文件路径（绝对/相对会话工作目录）。
 * @param {object} options - { exec, maxBytes, label }：label 只影响报错文案（如"首帧图"/"输入图"）。
 * @returns {Promise<{url?: string, dataUrl?: string, display: string}>}
 */
export async function resolveImageArg(image, { exec, maxBytes, label = '输入图' } = {}) {
  const trimmed = String(image).trim()
  if (trimmed.length === 0) throw new MediaError(CODES.BAD_REQUEST, `参数不被接受：${label} 不能是空字符串`)
  if (/^https?:\/\//iu.test(trimmed)) return { url: trimmed, display: trimmed }
  const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)

  const roots = allowedImageRoots(exec)
  let allowed = false
  for (const root of roots) {
    if (await isInside(path, root)) {
      allowed = true
      break
    }
  }
  if (!allowed) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：本地${label}只允许来自会话工作目录` +
        (roots.length > 1 ? '、或 DSH_MM_MODELS_IMAGE_ROOTS 里列出的目录' : '') +
        '；请把图片复制进工作目录，或改用图片 URL。' +
        `（被拒绝的绝对路径：${resolve(path)}）`,
    )
  }

  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new MediaError(CODES.BAD_REQUEST, `参数不被接受：${label}指向的文件读不到（` + String(error?.code ?? error?.message ?? error) + '）')
  }
  if (!info.isFile()) throw new MediaError(CODES.BAD_REQUEST, `参数不被接受：${label}不是普通文件：` + trimmed)
  if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0 && info.size > maxBytes) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：${label} ` + info.size + ' 字节超过内联上限 ' + maxBytes + '；请改用图片 URL 或压缩后重试',
    )
  }
  const bytes = await readFile(path)
  const mediaType = mediaTypeFromBytes(bytes)
  if (mediaType === undefined || !mediaType.startsWith('image/')) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：${label}按**内容签名**不是可识别的图片（支持 PNG/JPEG/GIF/WebP）；只改扩展名不算图片。`,
    )
  }
  // 带上原始尺寸：图生图要按它决定输出尺寸（否则模型会自选 2K，又慢又贵）。
  const pixels = imageSize(bytes)
  return {
    dataUrl: 'data:' + mediaType + ';base64,' + bytes.toString('base64'),
    display: basename(path),
    ...(pixels === undefined ? {} : { width: pixels.width, height: pixels.height }),
  }
}

/**
 * 图生图的输出尺寸：按**面积**把原图尺寸夹进厂商允许的区间。
 *
 * 为什么需要（2026-10-17 实测）：`qwen-image-3.0` 在不传 `size` 时会自选推荐分辨率，
 * 实测一张 256×256 的输入被放大成 **2048×2048** 输出 —— 既慢又贵，还违背"编辑这张图"的直觉。
 * 厂商约束是**总像素** 512×512 ~ 2048×2048（不是单边），所以这里按面积等比缩放。
 *
 * @param {number} width - 原图宽。
 * @param {number} height - 原图高。
 * @returns {string|undefined} `"{w}*{h}"`；尺寸不可用时返回 undefined（让模型自选）。
 */
export function sizeForEdit(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const MIN_AREA = 512 * 512
  const MAX_AREA = 2048 * 2048
  const area = width * height
  let scale = 1
  if (area < MIN_AREA) scale = Math.sqrt(MIN_AREA / area)
  else if (area > MAX_AREA) scale = Math.sqrt(MAX_AREA / area)
  // 取偶数：不少扩散实现要求宽高为偶数，奇数会被厂商侧拒绝或静默调整。
  const even = (value) => Math.min(8000, Math.max(2, Math.round(value / 2) * 2))
  return `${even(width * scale)}*${even(height * scale)}`
}

/**
 * 批量版本：多张参考图（qwen-image-3.0 支持 1–3 张，2.1 系列支持 1–10 张）。
 *
 * @param {string[]} list - 图片地址/路径列表。
 * @param {object} options - { exec, maxBytes, label, max }：max 为张数上限。
 * @returns {Promise<Array<{url?: string, dataUrl?: string, display: string}>>}
 */
export async function resolveImageArgs(list, { exec, maxBytes, label = '输入图', max = 3 } = {}) {
  const items = (Array.isArray(list) ? list : []).filter((item) => typeof item === 'string' && item.trim().length > 0)
  if (items.length === 0) return []
  if (items.length > max) {
    throw new MediaError(CODES.BAD_REQUEST, `参数不被接受：${label}最多 ${max} 张，实际给了 ${items.length} 张`)
  }
  const out = []
  for (const item of items) out.push(await resolveImageArg(item, { exec, maxBytes, label }))
  return out
}
