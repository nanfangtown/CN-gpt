/**
 * 归一化错误码与固定人话文案。
 *
 * 规划依据：[3.2] 归一化错误码 / [6.2] 失败分类与固定文案。
 * 约定：
 *   - 对外只暴露这里的 code，绝不把厂商原文当错误码；
 *   - 任何 key、签名 URL、内部请求头都不进 message；
 *   - 文案里提到"本插件"一律指 dsh-mm-models。
 */

/** 归一化错误码（厂商差异在 adapter 里收口）。 */
export const CODES = Object.freeze({
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  BAD_REQUEST: 'BAD_REQUEST',
  POLICY_REJECTED: 'POLICY_REJECTED',
  UNAVAILABLE: 'UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  /**
   * 模型 / 接入点不存在或账号未开通（2026-10-15 加）。
   *
   * 与 `BAD_REQUEST` 分开：前者让用户"改参数"是无效建议，后者才是。
   * 方舟遇到这种情况返回 HTTP 404，若按 404 通用映射会误报成参数错误。
   */
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
})

/** 归一化异步任务状态（规划 [3.2]）。 */
export const STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
})

/** 确定的终态。 */
export const TERMINAL_STATES = new Set([STATES.SUCCEEDED, STATES.FAILED])

/** 表示"Key 缺失"时给用户下一步的落点（插件设置页）。 */
const PLUGIN_SETTINGS_HINT = '插件页 → CN-gpt → 配置卡'

/** 结果里出现的固定错误对象：文案已经是给模型/用户看的人话。 */
export class MediaError extends Error {
  /**
   * @param {string} code - CODES 之一。
   * @param {string} message - 固定人话文案（已包含处理建议）。
   * @param {object} [options] - detail（厂商要点，已截断）/ status / vendorCode / retriable / cause。
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MediaError'
    this.code = code
    this.detail = options.detail
    this.status = options.status
    this.vendorCode = options.vendorCode
    this.retriable = options.retriable ?? false
  }
}

/** 把厂商原始 message 截成适合进工具结果的长度。 */
export function clip(text, max = 300) {
  if (typeof text !== 'string') return ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

/**
 * 从厂商错误体里抽取 code / message 要点。
 * 兼容 { code, message }、{ error: {...} }、{ output: {...} }、{ data: {...} } 等常见形状。
 * @param {unknown} body - 已解析的 JSON（也可能是纯文本）。
 * @returns {{ vendorCode?: string, detail: string }}
 */
export function readVendorError(body) {
  if (body === undefined || body === null) return { detail: '' }
  if (typeof body === 'string') return { detail: clip(body) }
  const candidates = [body, body.error, body.output, body.data]
  let vendorCode
  let detail = ''
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || typeof candidate !== 'object') continue
    if (vendorCode === undefined && typeof candidate.code === 'string') vendorCode = candidate.code
    if (detail === '' && typeof candidate.message === 'string') detail = clip(candidate.message)
    if (detail === '' && typeof candidate.msg === 'string') detail = clip(candidate.msg)
    if (detail === '' && typeof candidate.error_msg === 'string') detail = clip(candidate.error_msg)
  }
  return vendorCode === undefined ? { detail } : { vendorCode, detail }
}

const POLICY_MARKERS = [
  'datainspectionfailed',
  'data_inspection',
  'content_filter',
  'contentfilter',
  'content policy',
  'contentpolicy',
  'sensitivecontent',
  'sensitive_content',
  'risk_control',
  'riskcontrol',
  'prohibited',
  'policyrejected',
]

/** 厂商错误文本是否属于"内容被平台拒绝"。 */
export function looksLikePolicy(body) {
  const { vendorCode, detail } = readVendorError(body)
  const text = `${vendorCode ?? ''} ${detail}`.toLowerCase()
  return POLICY_MARKERS.some((marker) => text.includes(marker))
}

/** 余额/配额类错误文本。 */
export function looksLikeQuota(body) {
  const { vendorCode, detail } = readVendorError(body)
  const text = `${vendorCode ?? ''} ${detail}`.toLowerCase()
  return ['insufficientbalance', 'insufficient_quota', 'quotaexceeded', 'quota_exceeded', 'arrears', 'overdue', 'balance'].some(
    (marker) => text.includes(marker),
  )
}

/**
 * "模型 / 接入点不存在或未开通"类错误文本（2026-10-15 加）。
 *
 * 为什么单独识别：方舟对这种情况返回 **HTTP 404**，而 404 在通用映射里落到
 * `BAD_REQUEST`（"参数不被接受，可尝试改 duration/resolution/size"）——
 * **把一个"账号没开通/模型 id 不对"说成了"参数不对"**，用户照着改参数永远改不好。
 * 实测原文：`InvalidEndpointOrModel.NotFound: The model or endpoint seedance-2.0
 * does not exist or you do not have access to it.`
 *
 * @param {unknown} body - 厂商响应体。
 * @returns {boolean}
 */
export function looksLikeModelUnavailable(body) {
  const { vendorCode, detail } = readVendorError(body)
  const text = `${vendorCode ?? ''} ${detail}`.toLowerCase()
  return [
    'invalidendpointormodel',
    'endpointormodel',
    'modelnotfound',
    'model_not_found',
    'modelnotopen',
    'model_not_open',
    'service_not_activated',
    'not activated',
    'no permission to access model',
    'does not exist or you do not have access',
  ].some((marker) => text.includes(marker))
}

/**
 * HTTP 状态 + 错误体 → 归一化错误码（厂商 adapter 的 mapHttpError 默认实现）。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 已解析的错误体。
 * @returns {{ code: string, vendorCode?: string, detail: string }}
 */
export function classifyHttpError(status, body) {
  const { vendorCode, detail } = readVendorError(body)
  const withCode = (code) => (vendorCode === undefined ? { code, detail } : { code, vendorCode, detail })
  if (status === 401 || status === 403) return withCode(CODES.AUTH)
  if (status === 429) return withCode(CODES.RATE_LIMIT)
  if (status === 402 || looksLikeQuota(body)) return withCode(CODES.QUOTA)
  if (looksLikePolicy(body)) return withCode(CODES.POLICY_REJECTED)
  if (status >= 500) return withCode(CODES.UNAVAILABLE)
  // "模型/接入点不存在或未开通"必须先于通用 404→BAD_REQUEST 判定，
  // 否则会被误报成"参数不被接受"（实测方舟返回 404 + InvalidEndpointOrModel.NotFound）。
  if (looksLikeModelUnavailable(body)) return withCode(CODES.MODEL_UNAVAILABLE)
  if (status === 400 || status === 404 || status === 409 || status === 422) return withCode(CODES.BAD_REQUEST)
  return withCode(CODES.UNKNOWN)
}

/** 网络层错误是否属于"连接根本没建立、请求未发出"（提交可安全重试一次）。 */
const PRE_SEND_CAUSE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DNS_RESOLVE_FAILED',
])

/**
 * @param {unknown} error - fetch/网络异常。
 * @returns {boolean} true 表示可以确认提交请求没有到达厂商（仅此情形允许重发一次）。
 */
export function isPreSendError(error) {
  let current = error
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (typeof current.code === 'string' && PRE_SEND_CAUSE_CODES.has(current.code)) return true
    current = current.cause
  }
  return false
}

/** 是否是取消/超时信号导致的本地中断。 */
export function isAbortError(error) {
  if (error === undefined || error === null) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR' || error.code === 'UND_ERR_ABORTED'
}

/**
 * 生成固定人话文案（规划 [6.2]）。
 * @param {string} code - 归一化错误码。
 * @param {object} info - ref/provider/providerKey/pluginLabel/timeoutMs/attempts/taskId/detail/where。
 * @returns {string}
 */
export function fixedMessage(code, info = {}) {
  const provider = info.provider ?? '厂商'
  const ref = info.ref ?? '（未命名 key）'
  const detail = info.detail === undefined || info.detail === '' ? '厂商未给出细节' : info.detail
  switch (code) {
    case CODES.MISSING_CREDENTIAL:
      return `未配置 ${ref}：请在 ${PLUGIN_SETTINGS_HINT} 填写，或把 key 写进 %USERPROFILE%\.dsh\.env`
    case CODES.AUTH:
      return `${ref} 无效或已过期：请在 ${PLUGIN_SETTINGS_HINT} 更新后重试`
    case CODES.RATE_LIMIT:
      if (info.where === 'submit') return `${provider}侧限流：任务未创建，建议稍后再试（本插件不会自动重发提交）`
      return `${provider}侧限流：已退避重试 ${info.attempts ?? 1} 次仍未成功，建议稍后再试`
    case CODES.QUOTA:
      return `账户余额/配额不足：请到${provider}平台充值或换 key`
    case CODES.BAD_REQUEST:
      return `参数不被接受：${detail}；可尝试改 duration/resolution/size`
    case CODES.POLICY_REJECTED:
      return `内容被平台策略拒绝：请调整提示词后重试（本插件不会自动重试）`
    case CODES.MODEL_UNAVAILABLE:
      return (
        `模型/接入点不可用：${provider} 说这个模型 id 不存在，或你的账号没有权限（${detail}）。` +
        `这不是参数问题，改 duration/size 无效。请到 ${provider} 控制台确认：① 该模型是否已开通；` +
        `② 若该模型需要推理接入点，请把 ${PLUGIN_SETTINGS_HINT} 里的模型 id 换成接入点 id（形如 ep-xxxx）。`
      )
    case CODES.UNAVAILABLE:
      if (info.where === 'submit') {
        return `${provider}侧暂时不可用（连接失败/5xx）：本插件不会自动重发提交；请稍后用 media_task 查询是否已创建，或再次调用本工具`
      }
      return `${provider}侧暂时不可用（连接失败/5xx）：请稍后重试；若已有 task_id，可用 media_task 重查`
    case CODES.TIMEOUT: {
      const seconds = Math.max(1, Math.round((info.timeoutMs ?? 0) / 1000))
      const task = info.taskId === undefined ? '（未能取得 task_id）' : info.taskId
      return `等待超过 ${seconds} 秒仍未完成：远端任务未取消，可用 media_task(provider=${info.providerKey ?? '?'}, task_id=${task}) 重查或者下载`
    }
    case CODES.ABORTED: {
      const task = info.taskId === undefined ? '（未能取得 task_id）' : info.taskId
      return `已取消本地等待：远端任务未取消，task_id 已保留（${task}）`
    }
    default:
      return `厂商返回未识别错误：${detail}`
  }
}

/**
 * 任意异常 → MediaError（保证工具侧只看到归一化错误）。
 * @param {unknown} error - 抛出物。
 * @param {object} info - 生成固定文案所需的上下文。
 * @returns {MediaError}
 */
export function normalizeError(error, info = {}) {
  if (error instanceof MediaError) return error
  if (isAbortError(error)) return new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, info), { cause: error })
  return new MediaError(CODES.UNKNOWN, fixedMessage(CODES.UNKNOWN, { ...info, detail: clip(String(error?.message ?? error)) }), { cause: error })
}

/** 厂商终态失败（查询响应里的 error 字段）→ 归一化错误码。 */
export function classifyVendorFailure(error) {
  const body = { code: error?.code, message: error?.detail }
  if (looksLikeModelUnavailable(body)) return CODES.MODEL_UNAVAILABLE
  if (looksLikePolicy(body)) return CODES.POLICY_REJECTED
  if (looksLikeQuota(body)) return CODES.QUOTA
  return CODES.UNKNOWN
}
