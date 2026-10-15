/**
 * Ark（火山方舟）视频生成 adapter —— 厂商差异只允许出现在这里与 core\fields.mjs。
 * 端点：https://ark.cn-beijing.volces.com/api/v3 ，Bearer ARK_API_KEY
 *
 * ⚠ 提交/查询字段是预期形态，需一次实跑确证（规划 [13] B）：content 数组形状、
 *   首帧图字段（URL / base64）、duration/resolution/ratio 取值域、video_url 路径。
 */
import { CODES, classifyHttpError } from '../../core/errors.mjs'
import { unitPriceOf } from '../../core/cost.mjs'
import { ARK_FIELDS as F, firstPath, mapRawStatus, setPath } from '../../core/fields.mjs'

/** 从查询响应里抽视频 URL（签名 URL 只用于下载）。 */
function videoUrls(json) {
  const url = firstPath(json, F.videoUrlPaths)
  return typeof url === 'string' && url.length > 0 ? [url] : []
}

/** 由查询响应组装归一化 State。 */
function parseState(json, { taskId }) {
  const rawStatus = firstPath(json, F.statusPaths)
  const mapped = mapRawStatus(F, rawStatus)
  const status = mapped === 'unknown' ? 'running' : mapped
  const errorCode = firstPath(json, F.errorCodePaths)
  const errorMessage = firstPath(json, F.errorMessagePaths)
  const progress = firstPath(json, F.progressPaths)
  const state = {
    status,
    rawStatus,
    ...(progress === undefined ? {} : { progress: typeof progress === 'number' ? progress : String(progress) }),
    artifacts: status === 'succeeded' ? videoUrls(json) : [],
    ...(status === 'failed'
      ? { error: { code: typeof errorCode === 'string' ? errorCode : 'UNKNOWN', detail: typeof errorMessage === 'string' ? errorMessage : '' } }
      : {}),
  }
  if (mapped === 'unknown') state.unknownStatus = true
  if (rawStatus === undefined) state.unknownStatus = true
  if (taskId !== undefined) state.taskId = taskId
  return state
}

export const arkVideoAdapter = {
  id: 'ark-video',
  providerKey: 'seedance',
  kind: 'video',
  label: 'Seedance 出片 (Ark)',
  providerLabel: '方舟 Ark',
  credentialRef: 'ARK_API_KEY',

  /** POST {base}{submitPath} */
  buildSubmit(spec, { credential, config }) {
    const body = {}
    setPath(body, F.bodyModel, spec.model)
    const content = [{ type: 'text', text: spec.prompt }]
    if (spec.image !== undefined && spec.image !== null) {
      // 首帧图：{ url } 或 { dataUrl }（工具层已把本地文件转成 data URL）。
      const imageUrl = spec.image.url ?? spec.image.dataUrl
      if (typeof imageUrl === 'string' && imageUrl.length > 0) {
        content.push({ type: 'image_url', image_url: { url: imageUrl } })
      }
    }
    setPath(body, F.bodyContent, content)
    if (spec.duration !== undefined) setPath(body, F.bodyDuration, spec.duration)
    if (spec.resolution !== undefined && spec.resolution !== '') setPath(body, F.bodyResolution, spec.resolution)
    if (spec.ratio !== undefined && spec.ratio !== '') setPath(body, F.bodyRatio, spec.ratio)
    if (spec.fps !== undefined) setPath(body, F.bodyFps, spec.fps)
    return {
      url: `${String(config.arkBase).replace(/\/+$/, '')}${F.submitPath}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body,
    }
  },

  parseSubmit(json) {
    return {
      taskId: firstPath(json, F.taskIdPaths),
      rawStatus: firstPath(json, F.statusPaths),
    }
  },

  buildQuery(taskId, { credential, config }) {
    return {
      url: `${String(config.arkBase).replace(/\/+$/, '')}${F.queryPath(taskId)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
    }
  },

  parseQuery(json, context = {}) {
    return parseState(json, context)
  },

  extractArtifacts(json) {
    return videoUrls(json)
  },

  mapHttpError(status, body) {
    return classifyHttpError(status, body)
  },

  /** 按秒计价；支持 pricing.tiers（{upToSeconds, unitPrice} 升序）。未计价时为 null。 */
  estimateCost(spec, pricing) {
    const entry = pricing?.[spec.model] ?? {}
    const units = Number(spec.duration ?? 5)
    let unitPrice = unitPriceOf(entry)
    if (Array.isArray(entry.tiers) && entry.tiers.length > 0) {
      const sorted = [...entry.tiers].sort((a, b) => Number(a.upToSeconds) - Number(b.upToSeconds))
      const tier = sorted.find((item) => units <= Number(item.upToSeconds)) ?? sorted.at(-1)
      const tierPrice = unitPriceOf(tier)
      if (tierPrice !== null) unitPrice = tierPrice
    }
    return {
      model: spec.model,
      unitKind: 'second',
      units,
      unitPrice,
      currency: entry.currency ?? 'CNY',
      amount: unitPrice === null ? null : Number((units * unitPrice).toFixed(6)),
    }
  },

  /** 轻量健康探测：GET 一个不存在的任务；404 视为鉴权通过、端点可达。 */
  async probe({ credential, config, fetchImpl }) {
    const url = `${String(config.arkBase).replace(/\/+$/, '')}${F.queryPath('mm-health-probe')}`
    try {
      const response = await (fetchImpl ?? fetch)(url, { method: 'GET', headers: { Authorization: `Bearer ${credential}` } })
      if (response.ok) return { ok: true, detail: `GET /tasks/{probe} → HTTP ${response.status}` }
      if (response.status === 401 || response.status === 403) return { ok: false, code: CODES.AUTH, detail: `GET /tasks/{probe} → HTTP ${response.status}` }
      if (response.status === 404) return { ok: true, detail: 'GET /tasks/{probe} → HTTP 404（鉴权通过，端点可达）' }
      return { ok: false, code: statusToCode(response.status), detail: `GET /tasks/{probe} → HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, code: CODES.UNAVAILABLE, detail: `连接失败：${error?.message ?? error}` }
    }
  },
}

function statusToCode(status) {
  if (status === 401 || status === 403) return CODES.AUTH
  if (status === 429) return CODES.RATE_LIMIT
  if (status >= 500) return CODES.UNAVAILABLE
  return CODES.UNKNOWN
}

/** 默认导出的字段常量，便于测试断言。 */
export { F as arkFields }
