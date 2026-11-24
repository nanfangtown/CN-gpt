/**
 * MiniMax H3-Image adapter —— 文生图与图片编辑共用一条同步协议。
 *
 * 官方协议（2026-11-21 核对，见 core/fields.mjs 的 MINIMAX_IMAGE_FIELDS）：
 *   POST {base}/v1/images/generations   → 文生图
 *   POST {base}/v1/images/edits         → 图片编辑（images[].image_url，1–16 张）
 *   200 + data[] = 结果；同步返回，没有 task_id。
 *
 * 与另外四家的三处关键差异：
 *   1. **同步**：manager.run() 直接用提交响应里的 state，不进轮询（与 qwen-image 同步模式同形）。
 *      所以 `modeFor()` 恒为 `'sync'`：media_task 会如实回答"这条链路没有可重查的远端任务"。
 *   2. **部分失败也是 200**：data 恒为 n 项，失败项只有 error。只要一张成功就是 200，
 *      所以"成功张数"必须取 usage.generated_images（计费口径），不能取 data.length，也不能取 n。
 *   3. **不支持幂等**：超时/断连后服务端仍会生成并计费。所以提交超时用 minimaxImageTimeoutMs
 *      （默认 600 s，官方建议），重试策略沿用 manager 的"POST 永不自动重发"。
 *
 * 计费：官方是 token 计价（文本 15 / 图片输入 10 / 输出 25 元每百万 token），
 * 单价表用**官方给的单张参考价**，档位 = 模式（文生 / 编辑）× 面积（1K/2K/4K）。
 * 编辑按"3 张参考图"这一档取价（官方表里最贵的那行）—— 宁高不低，闸门宁可多拦。
 * 4K 目前限时 5 折，这里取**不打折**价，理由同上；打折期实际账单会低于预估。
 *
 * 区域：`api.minimax.cn`（国内）/ `api.minimax.io`（国际）的 key 不通用，
 * 基址与 minimax_video 共用 `minimaxBase`（同一个账号、同一套 key）。
 */
import { CODES, MediaError, STATES, classifyHttpError } from '../../core/errors.mjs'
import { unitPriceOf } from '../../core/cost.mjs'
import { MINIMAX_IMAGE_FIELDS as F, firstPath } from '../../core/fields.mjs'
// 基址归一化与视频共用一份实现：同一个主机、同一套"粘了 /v1 也能用"的宽容解析。
// 探活也复用视频适配器：`/v1/files/retrieve` 是只读 GET、不花钱，鉴权语义与这里一致。
import { minimaxVideoAdapter, resolveMinimaxBase } from './minimax-video.mjs'

/** 默认模型：H3 图像标准版（高速版参数与限制相同，只换 id）。 */
export const MINIMAX_IMAGE_DEFAULT_MODEL = 'MiniMax-H3-Image'

/** 支持的两档（同一套参数；只是 id 与单价不同）。 */
export const MINIMAX_IMAGE_MODELS = Object.freeze({
  standard: Object.freeze({ id: 'MiniMax-H3-Image', label: 'H3 图像标准版' }),
  highspeed: Object.freeze({ id: 'MiniMax-H3-Image-Highspeed', label: 'H3 图像极速版' }),
})

/** 面积档位（服务端默认 4K —— 我们不接受"不填就按最贵档下单"）。 */
export const MINIMAX_IMAGE_AREAS = Object.freeze(['1K', '2K', '4K'])

/** 面积档位 → 官方定义的目标像素（1K=1024²、2K=2048²、4K=4096²）。 */
const AREA_PIXELS = Object.freeze({ '1K': 1024 * 1024, '2K': 2048 * 2048, '4K': 4096 * 4096 })

/** 官方约束：面积 [655,360, 20,000,000] 像素，宽高比 [1:3, 3:1]。 */
const MIN_PIXELS = 655_360
const MAX_PIXELS = 20_000_000
const MAX_RATIO = 3

/** 支持的输出格式（`jpg` 与 `jpeg` 等价，响应会归一成 `jpeg`）。 */
const OUTPUT_FORMATS = Object.freeze(['jpeg', 'jpg', 'png', 'webp'])

/** 参考图上限（官方 1–16 张；请求体总大小 ≤ 64 MiB）。 */
export const MINIMAX_IMAGE_MAX_IMAGES = 16
const MAX_EDIT_BODY_BYTES = 64 * 1024 * 1024

/**
 * 认模型：短名/真实 id 都接受；认不出来返回 undefined（不静默兜底到默认模型，
 * 否则"配错模型 id"会被悄悄换成另一个更贵的型号）。
 * @param {unknown} value - 配置或调用方给的模型 id。
 * @returns {object|undefined} 模型条目。
 */
export function resolveMinimaxImageModel(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return undefined
  for (const [alias, entry] of Object.entries(MINIMAX_IMAGE_MODELS)) {
    if (alias === text || entry.id === text) return { alias, ...entry }
  }
  return undefined
}

/**
 * 把 `宽x高` 归一到服务的取价档位。
 *
 * 为什么需要：调用方可以用 `size: "1360x768"` 绕过 `area` 档位（官方允许），
 * 但计费仍按输出面积走。只看 area 会让"自定义大尺寸"按 1K 报价 —— 少报一个档位，
 * 闸门就会放行本该拦下的请求。所以**两个入口都收敛到档位**。
 *
 * @param {string} size - `宽x高`。
 * @returns {'1K'|'2K'|'4K'|undefined} 档位；解析不了返回 undefined（交给未计价分支）。
 */
export function areaOfSize(size) {
  const match = /^(\d{2,5})x(\d{2,5})$/u.exec(String(size ?? '').trim())
  if (match === null) return undefined
  const pixels = Number(match[1]) * Number(match[2])
  if (!Number.isFinite(pixels) || pixels <= 0) return undefined
  if (pixels <= AREA_PIXELS['1K']) return '1K'
  if (pixels <= AREA_PIXELS['2K']) return '2K'
  return '4K'
}

/**
 * 图生图的输出尺寸：按参考图尺寸夹进官方允许的区间。
 *
 * 与 qwen 的 sizeForEdit 同一个动机（不这么做服务端默认 4K，又慢又贵、还把图放大 8 倍），
 * 但边界不同：H3 是**面积** [655,360, 20,000,000]、长宽比 ≤ 3:1。
 *
 * @param {number} width - 参考图宽。
 * @param {number} height - 参考图高。
 * @returns {string|undefined} `"{w}x{h}"`；尺寸不可用返回 undefined（让工具层退回 area 档位）。
 */
export function sizeForH3Edit(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  let w = Math.round(width)
  let h = Math.round(height)
  // 先夹比例，再夹面积：只夹面积的话，超宽图仍会被 400 拒绝（比例超 3:1）。
  if (w > h * MAX_RATIO) w = h * MAX_RATIO
  if (h > w * MAX_RATIO) h = w * MAX_RATIO
  const area = w * h
  if (area < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / area)
    w *= scale
    h *= scale
  } else if (area > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / area)
    w *= scale
    h *= scale
  }
  // 取偶数：不少扩散实现要求宽高为偶数（与 qwen 的 sizeForEdit 同一条实测理由）。
  const even = (value) => Math.min(8000, Math.max(2, Math.round(value / 2) * 2))
  return `${even(w)}x${even(h)}`
}

/**
 * 归一化输出格式（`jpg` → `jpeg`）。
 * @param {unknown} value - 调用方给的格式。
 * @returns {string} 归一化格式。
 */
function normalizeFormat(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'jpg') return 'jpeg'
  return OUTPUT_FORMATS.includes(text) ? text : 'jpeg'
}

/**
 * 参考图 → 请求体里的 `image_url`（公网 URL / data URL 都直接透传）。
 * @param {object} image - resolveImageArg 的结果。
 * @returns {string|undefined} 可用的 URL 值。
 */
function imageUrlOf(image) {
  if (image === undefined || image === null) return undefined
  const value = image.url ?? image.dataUrl
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 规格校验 + 归一化。工具层在**报价之前**先调它：参数错不能等到"未计价"才报
 * （否则用户看到的建议是"去补单价"，而真正的问题是尺寸/张数不合法）。
 *
 * @param {object} spec - { model, prompt, n, area, size, format, images }。
 * @returns {object} 归一化后的规格（含 mode：'text' | 'edit'）。
 */
export function validateMinimaxImageSpec(spec) {
  const resolved = resolveMinimaxImageModel(spec?.model)
  if (resolved === undefined) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：未知的 MiniMax 图像模型「${String(spec?.model ?? '')}」。可选：` +
        Object.values(MINIMAX_IMAGE_MODELS).map((entry) => entry.id).join(' / ') +
        '。**本次未提交、未产生任何费用。** 请在 插件页 → CN-gpt → 配置卡 的 minimaxImageModel 里选择。',
    )
  }

  const prompt = typeof spec?.prompt === 'string' ? spec.prompt.trim() : ''
  if (prompt.length === 0) {
    throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：prompt 不能为空。**本次未提交、未产生任何费用。**')
  }
  if (prompt.length > 32000) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：H3-Image 的 prompt 上限 32000 字符（本次 ${prompt.length}）。**本次未提交、未产生任何费用。**`,
    )
  }

  const rawN = Number(spec?.n ?? 1)
  const n = Number.isFinite(rawN) ? Math.trunc(rawN) : 1
  if (n < 1 || n > 10) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：n 取值范围 [1, 10]（本次 ${String(spec?.n)}）。**本次未提交、未产生任何费用。**`,
    )
  }

  const images = (Array.isArray(spec?.images) ? spec.images : [])
    .map((image) => ({ image, url: imageUrlOf(image) }))
    .filter((item) => item.url !== undefined)
  if (images.length > MINIMAX_IMAGE_MAX_IMAGES) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：参考图最多 ${MINIMAX_IMAGE_MAX_IMAGES} 张（本次 ${images.length} 张）。**本次未提交、未产生任何费用。**`,
    )
  }
  if (images.length > 0) {
    // 请求体总量 ≤ 64 MiB；data URL 是 base64，按 3/4 反推原始字节估算（宁高不低）。
    const bodyBytes = images.reduce((sum, item) => sum + Math.ceil(item.url.length * 0.75), 0)
    if (bodyBytes > MAX_EDIT_BODY_BYTES) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        '参数不被接受：参考图合计约 ' +
          Math.round(bodyBytes / 1024 / 1024) +
          ' MiB，超过官方 64 MiB 上限。请改用公网图片 URL（把本地图上传到可访问地址），' +
          '或减少参考图数量。**本次未提交、未产生任何费用。**',
      )
    }
  }
  const mode = images.length > 0 ? 'edit' : 'text'

  // 尺寸：size（宽x高）与 area 二选一。
  const rawSize = typeof spec?.size === 'string' ? spec.size.trim() : ''
  let size
  if (rawSize.length > 0 && rawSize.toLowerCase() !== 'auto') {
    const match = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/u.exec(rawSize)
    if (match === null) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        `参数不被接受：size 必须是「宽x高」（如 1360x768）或 auto，本次给的是「${rawSize}」。**本次未提交、未产生任何费用。**`,
      )
    }
    const width = Number(match[1])
    const height = Number(match[2])
    const area = width * height
    if (area < MIN_PIXELS || area > MAX_PIXELS) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        `参数不被接受：size 的面积 ${area} 不在官方区间 [${MIN_PIXELS}, ${MAX_PIXELS}] 像素。**本次未提交、未产生任何费用。**`,
      )
    }
    const ratio = Math.max(width / height, height / width)
    if (ratio > MAX_RATIO + 1e-9) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        `参数不被接受：size 的宽高比 ${ratio.toFixed(2)}:1 超过官方 3:1 上限。**本次未提交、未产生任何费用。**`,
      )
    }
    size = `${width}x${height}`
  }

  let area = typeof spec?.area === 'string' ? spec.area.trim().toUpperCase() : ''
  if (area.length === 0) area = '1K'
  if (!MINIMAX_IMAGE_AREAS.includes(area)) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：area 只能是 1K / 2K / 4K（本次 ${String(spec?.area)}）。**本次未提交、未产生任何费用。**`,
    )
  }
  if (size !== undefined) {
    // 官方：size 为宽x高时再传 area 直接 400。这里提前拦，且说清"要哪个"。
    if (typeof spec?.area === 'string' && spec.area.trim().length > 0) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        '参数不被接受：size（宽x高）与 area 互斥，只能给一个 —— 官方同时传会返回 400。' +
          '想精确控制像素就只给 size；想用档位（1K/2K/4K）就只给 area。**本次未提交、未产生任何费用。**',
      )
    }
    // 未显式给 area 时，取价档位由像素反推（报价不能按 1K 报一张 4K 的图）。
    area = areaOfSize(size) ?? area
  }

  return {
    model: resolved.id,
    modelAlias: resolved.alias,
    mode,
    prompt,
    n,
    images: images.map((item) => item.image),
    imageUrls: images.map((item) => item.url),
    area,
    ...(size === undefined ? {} : { size }),
    format: normalizeFormat(spec?.format),
  }
}

/**
 * 从官方错误体里取人话（MiniMax 这代接口的错误在 `error.message`，末尾带内部码）。
 * @param {unknown} body - 已解析的 JSON 或纯文本。
 * @returns {{ code?: string, message: string }}
 */
function errorDetailOf(body) {
  if (body === undefined || body === null) return { message: '' }
  if (typeof body === 'string') return { message: body.trim().slice(0, 300) }
  const message = firstPath(body, F.errorMessagePaths)
  const code = firstPath(body, ['error.code', 'code'])
  return {
    ...(code === undefined ? {} : { code: String(code) }),
    message: typeof message === 'string' ? message.trim().slice(0, 300) : '',
  }
}

/** 内容安全类内部码（1026 = 增强后的 prompt 被拒；1027 = 生成的图被拒）。 */
function looksLikeMiniMaxPolicy(text) {
  return /content safety|content[ _-]?filter|safety check|敏感|\b10(26|27)\b/iu.test(String(text ?? ''))
}

export const minimaxImageAdapter = {
  id: 'minimax-image',
  providerKey: 'minimax',
  kind: 'image',
  label: 'MiniMax H3 制图',
  providerLabel: 'MiniMax（H3-Image）',
  credentialRef: 'MINIMAX_API_KEY',

  /**
   * 同步链路：manager.run() 直接用提交响应里的 state，不轮询。
   * media_task 靠这个判定"没有可重查的远端任务"，给出的说明才不会误导。
   */
  modeFor() {
    return 'sync'
  },

  /**
   * 组装提交请求。图生图走 `/v1/images/edits`，其余走 `/v1/images/generations`。
   * @param {object} spec - 工具层给的规格。
   * @param {{credential: string, config: object}} context - 凭据与配置。
   * @returns {object} 请求描述（manager 负责发）。
   */
  buildSubmit(spec, { credential, config } = {}) {
    const normalized = validateMinimaxImageSpec(spec)
    const body = {
      [F.bodyModel]: normalized.model,
      [F.bodyPrompt]: normalized.prompt,
      [F.bodyN]: normalized.n,
      // 只请求 url：b64_json 有总面积上限，而且产物最终都要落盘，没必要在内存里多抄一份。
      [F.bodyResponseFormat]: 'url',
      [F.bodyOutputFormat]: normalized.format,
    }
    if (normalized.mode === 'edit') {
      body[F.bodyImages] = normalized.imageUrls.map((url) => ({ [F.bodyImageUrl]: url }))
      // 编辑：给了 size 用 size；没给就沿用参考图尺寸（夹进官方区间）。
      // 不这么做服务端默认 4K —— 一次编辑会被按最贵档计费，还会把图放大。
      const size =
        normalized.size ??
        sizeForH3Edit(normalized.images[0]?.width, normalized.images[0]?.height)
      if (size !== undefined) body[F.bodySize] = size
      else {
        body[F.bodySize] = 'auto'
        body[F.bodyArea] = normalized.area
      }
    } else if (normalized.size !== undefined) {
      body[F.bodySize] = normalized.size
    } else {
      body[F.bodySize] = 'auto'
      body[F.bodyArea] = normalized.area
    }
    return {
      url: `${resolveMinimaxBase(config)}${normalized.mode === 'edit' ? F.editPath : F.generatePath}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body,
      mode: 'sync',
    }
  },

  /**
   * 解析同步响应。
   *
   * ⚠ 判据是 `data[].error`，不是 HTTP 码：只要有一张成功，HTTP 就是 200。
   * 成功张数以 `usage.generated_images` 为准（计费口径）；取不到才退回成功项个数。
   *
   * @param {object} json - 响应 JSON。
   * @returns {{taskId: string, rawStatus: string, state: object}}
   */
  parseSubmit(json) {
    const data = firstPath(json, F.dataPaths)
    const rows = Array.isArray(data) ? data : []
    const urls = []
    const sizes = []
    const partialFailures = []
    for (const row of rows) {
      if (row === undefined || row === null || typeof row !== 'object') continue
      const error = row[F.errorPath]
      if (error !== undefined && error !== null) {
        const detail = errorDetailOf({ error })
        partialFailures.push({
          code: detail.code ?? 'unknown',
          message: detail.message,
        })
        continue
      }
      const url = row[F.urlPath]
      if (typeof url === 'string' && url.length > 0) {
        urls.push(url)
        if (typeof row[F.sizePath] === 'string') sizes.push(row[F.sizePath])
      }
    }
    const usageCount = Number(firstPath(json, F.usageCountPaths))
    const generated = Number.isFinite(usageCount) && usageCount >= 0 ? usageCount : urls.length
    const requestId = firstPath(json, F.requestIdPaths)
    const taskId = typeof requestId === 'string' && requestId.length > 0 ? requestId : `h3-${Date.now().toString(36)}`

    if (urls.length === 0) {
      const detail =
        partialFailures.length > 0
          ? partialFailures.map((item) => `${item.code}: ${item.message}`).join('；')
          : '响应里没有 data[].url'
      const policy = partialFailures.some((item) => looksLikeMiniMaxPolicy(item.message) || item.code === '1026' || item.code === '1027')
      return {
        taskId,
        rawStatus: 'FAILED',
        state: {
          status: STATES.FAILED,
          rawStatus: 'FAILED',
          artifacts: [],
          error: { code: policy ? CODES.POLICY_REJECTED : CODES.UNKNOWN, detail },
          usage: { imageCount: 0 },
        },
      }
    }
    return {
      taskId,
      rawStatus: 'SUCCEEDED',
      state: {
        status: STATES.SUCCEEDED,
        rawStatus: 'SUCCEEDED',
        artifacts: urls,
        usage: { imageCount: generated },
        ...(sizes.length === 0 ? {} : { sizes }),
        ...(partialFailures.length === 0 ? {} : { partialFailures }),
      },
    }
  },

  /** 同步链路不提供查询：保持契约完整（manager 只在 poll 模式才调它）。 */
  buildQuery() {
    throw new MediaError(CODES.BAD_REQUEST, 'MiniMax H3-Image 是同步接口：没有可重查的远端任务')
  },

  /** 同步链路没有轮询，故不会走到这里；显式报错胜过静默返回空状态。 */
  parseQuery() {
    throw new MediaError(CODES.BAD_REQUEST, 'MiniMax H3-Image 是同步接口：没有可重查的远端任务')
  },

  extractArtifacts(json) {
    return (Array.isArray(firstPath(json, F.dataPaths)) ? firstPath(json, F.dataPaths) : [])
      .map((row) => row?.[F.urlPath])
      .filter((url) => typeof url === 'string' && url.length > 0)
  },

  /**
   * HTTP 错误 → 归一化错误码。
   *
   * 不能直接复用通用映射：官方对"全部图片未过内容安全"返回 **422**，
   * 而通用映射会把 422 归到 BAD_REQUEST，文案就变成"改 duration/resolution/size" ——
   * 对内容安全来说这是**无效建议**（用户改尺寸永远改不好）。
   */
  mapHttpError(status, body) {
    const detail = errorDetailOf(body)
    const fallback = classifyHttpError(status, body)
    const policy = status === 422 || looksLikeMiniMaxPolicy(detail.message) || looksLikeMiniMaxPolicy(fallback.detail)
    if (policy) {
      return {
        code: CODES.POLICY_REJECTED,
        detail: detail.message === '' ? '内容未通过平台安全检查（422）' : detail.message,
        ...(detail.code === undefined && fallback.vendorCode === undefined
          ? {}
          : { vendorCode: detail.code ?? fallback.vendorCode }),
      }
    }
    return {
      code: fallback.code,
      detail: detail.message === '' ? fallback.detail : detail.message,
      ...(detail.code === undefined ? (fallback.vendorCode === undefined ? {} : { vendorCode: fallback.vendorCode }) : { vendorCode: detail.code }),
    }
  },

  /**
   * 按张计价：档位 = 模式（文生 / 编辑）× 面积（1K/2K/4K）。
   *
   * tiers 一旦存在就必须**精确命中**；没有对应档位返回 null → 闸门 fail-closed。
   * 这比"退回一个兜底价"安全：兜底价一旦写错，等于给某档位开后门。
   */
  estimateCost(spec, pricing) {
    const entry = pricing?.[spec?.model] ?? {}
    const resolved = resolveMinimaxImageModel(spec?.model)
    const mode = Array.isArray(spec?.images) && spec.images.length > 0 ? 'edit' : 'text'
    const requestedSize = typeof spec?.size === 'string' && spec.size.trim().length > 0 ? spec.size.trim() : undefined
    const area = requestedSize === undefined ? (typeof spec?.area === 'string' ? spec.area : '1K') : areaOfSize(requestedSize)
    const tiers = Array.isArray(entry.tiers) ? entry.tiers : []
    let unitPrice
    if (tiers.length > 0) {
      const exact = tiers.find((tier) => String(tier?.mode ?? '') === mode && String(tier?.area ?? '') === area)
      unitPrice = exact === undefined ? null : unitPriceOf(exact)
    } else {
      unitPrice = unitPriceOf(entry)
    }
    const units = Number(spec?.n ?? 1)
    return {
      model: spec?.model,
      modelLabel: resolved?.label,
      mode,
      area,
      unitKind: 'image',
      units,
      unitPrice,
      currency: entry.currency ?? 'CNY',
      amount: unitPrice === null ? null : Number((units * unitPrice).toFixed(6)),
    }
  },

  /**
   * 健康探测：复用视频适配器的 `/v1/files/retrieve?file_id=1`。
   *
   * 为什么不是打 images 接口：那是 POST，打一次就是一次生成、一次计费 ——
   * 健康探测绝不能花钱。`files/retrieve` 恒返回 200 + base_resp，
   * 鉴权失败是 1004/2049，够判断 key 与区域。
   */
  probe(options) {
    return minimaxVideoAdapter.probe(options)
  },
}
