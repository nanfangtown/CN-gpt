/**
 * DashScope（阿里云百炼）文生图 adapter —— 厂商差异只允许出现在这里与 core\fields.mjs。
 *
 * 两种模式（2026-10-12 真跑确证）：
 *   - sync  ：qwen-image 系列走 `multimodal-generation/generation`，同步返回签名图片 URL；
 *             本账号不支持异步调用（X-DashScope-Async 会 403 AccessDenied）。
 *   - async ：wanx 等系列走 `text2image/image-synthesis` + `tasks/{id}` 轮询。
 * `dashscopeImageMode: auto|sync|async`（默认 auto：qwen-image → sync，其余 → async）。
 */
import { CODES, classifyHttpError } from '../../core/errors.mjs'
import { unitPriceOf } from '../../core/cost.mjs'
import { DASHSCOPE_FIELDS as F, DASHSCOPE_SYNC_FIELDS as S, firstPath, getPath, mapRawStatus, setPath } from '../../core/fields.mjs'

const base = (config) => String(config.dashscopeBase ?? '').replace(/\/+$/, '')

/** 异步模式：从查询响应里抽产物 URL 列表。 */
function asyncArtifactUrls(json) {
  const rows = firstPath(json, F.resultPaths)
  if (!Array.isArray(rows)) return []
  const urls = []
  for (const row of rows) {
    if (typeof row === 'string' && row.length > 0) {
      urls.push(row)
      continue
    }
    const url = firstPath(row, F.resultUrlPaths)
    if (typeof url === 'string' && url.length > 0) urls.push(url)
  }
  return urls
}

/** 同步模式：从 output.choices[].message.content[].image 抽产物 URL。 */
function syncArtifactUrls(json) {
  const choices = firstPath(json, S.choicesPaths)
  const urls = []
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const content = firstPath(choice, S.contentPaths)
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const url = firstPath(part, S.imagePaths)
        if (typeof url === 'string' && url.length > 0) urls.push(url)
      }
    }
  }
  if (urls.length === 0) urls.push(...asyncArtifactUrls(json))
  return urls
}

/** 异步模式：查询响应 → 归一化 State。 */
function parseAsyncState(json, { taskId }) {
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
    artifacts: status === 'succeeded' ? asyncArtifactUrls(json) : [],
    ...(status === 'failed'
      ? { error: { code: typeof errorCode === 'string' ? errorCode : 'UNKNOWN', detail: typeof errorMessage === 'string' ? errorMessage : '' } }
      : {}),
  }
  if (mapped === 'unknown' || rawStatus === undefined) state.unknownStatus = true
  if (taskId !== undefined) state.taskId = taskId
  return state
}

/** 同步模式：提交响应 → taskRef 的 state（无需轮询）。 */
function parseSyncState(json) {
  const urls = syncArtifactUrls(json)
  const usageCount = firstPath(json, S.usageImageCountPaths)
  const width = firstPath(json, S.usageWidthPaths)
  const height = firstPath(json, S.usageHeightPaths)
  return {
    status: 'succeeded',
    rawStatus: 'SUCCEEDED',
    artifacts: urls,
    usage: {
      imageCount: typeof usageCount === 'number' && Number.isFinite(usageCount) ? usageCount : urls.length,
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
    },
    ...(urls.length === 0 ? { error: { code: 'EmptyArtifacts', detail: '同步响应里没有 image 字段' } } : {}),
  }
}

export const dashscopeImageAdapter = {
  id: 'dashscope-image',
  providerKey: 'qwen',
  kind: 'image',
  label: 'Qwen 制图 (DashScope)',
  providerLabel: 'DashScope',
  credentialRef: 'DASHSCOPE_API_KEY',

  /** 模式决策：auto 时 qwen-image 系列走同步（本账号实跑不支持异步），其余走异步。 */
  modeFor(config) {
    const requested = String(config?.dashscopeImageMode ?? 'auto').toLowerCase()
    if (requested === 'sync') return 'sync'
    if (requested === 'async') return 'async'
    return /^qwen-image/i.test(String(config?.qwenModel ?? '')) ? 'sync' : 'async'
  },

  buildSubmit(spec, { credential, config, mode = this.modeFor(config) } = {}) {
    if (mode === 'sync') {
      const body = {}
      setPath(body, F.bodyModel, spec.model)
      setPath(body, S.bodyMessages, [
        { [S.bodyRole]: S.roleUser, [S.bodyContent]: [{ [S.bodyText]: spec.prompt }] },
      ])
      const parameters = { [S.bodyN]: spec.n ?? 1, [S.bodyPromptExtend]: false, [S.bodyWatermark]: false }
      if (spec.size !== undefined && spec.size !== '') parameters[S.bodySize] = spec.size
      if (spec.negativePrompt !== undefined && spec.negativePrompt !== '') parameters[S.bodyNegative] = spec.negativePrompt
      setPath(body, S.bodyParameters, parameters)
      return {
        url: `${base(config)}${S.submitPath}`,
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body,
        mode: 'sync',
      }
    }
    const body = {}
    setPath(body, F.bodyModel, spec.model)
    setPath(body, F.bodyPrompt, spec.prompt)
    setPath(body, F.bodyN, spec.n ?? 1)
    if (spec.negativePrompt !== undefined && spec.negativePrompt !== '') setPath(body, F.bodyNegative, spec.negativePrompt)
    if (spec.size !== undefined && spec.size !== '') setPath(body, F.bodySize, spec.size)
    return {
      url: `${base(config)}${F.submitPath}`,
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', [F.asyncHeader]: 'enable' },
      body,
      mode: 'async',
    }
  },

  parseSubmit(json, { mode = 'async' } = {}) {
    if (mode === 'sync') {
      const requestId = firstPath(json, S.requestIdPaths)
      return {
        taskId: typeof requestId === 'string' && requestId.length > 0 ? requestId : `sync-${Date.now().toString(36)}`,
        rawStatus: 'SUCCEEDED',
        state: parseSyncState(json),
      }
    }
    return { taskId: firstPath(json, F.taskIdPaths), rawStatus: firstPath(json, F.statusPaths) }
  },

  buildQuery(taskId, { credential, config }) {
    return {
      url: `${base(config)}${F.queryPath(taskId)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
    }
  },

  parseQuery(json, context = {}) {
    return parseAsyncState(json, context)
  },

  extractArtifacts(json) {
    const urls = syncArtifactUrls(json)
    return urls.length > 0 ? urls : asyncArtifactUrls(json)
  },

  mapHttpError(status, body) {
    return classifyHttpError(status, body)
  },

  /** 按张计价。未计价时 unitPrice/amount 为 null（不要 Number(null)=0，那会报成"免费"）。 */
  estimateCost(spec, pricing) {
    const entry = pricing?.[spec.model] ?? {}
    const unitPrice = unitPriceOf(entry)
    const units = Number(spec.n ?? 1)
    return {
      model: spec.model,
      unitKind: 'image',
      units,
      unitPrice,
      currency: entry.currency ?? 'CNY',
      amount: unitPrice === null ? null : Number((units * unitPrice).toFixed(6)),
    }
  },

  /** 轻量健康探测：优先 OpenAI 兼容 /models；不可用时退回 GET 一个不存在的 task。 */
  async probe({ credential, config, fetchImpl }) {
    const attempts = []
    const compatBase = String(config.dashscopeCompatBase ?? '').trim()
    if (compatBase.length > 0) attempts.push({ label: 'GET /models', url: `${compatBase.replace(/\/+$/, '')}/models`, method: 'GET' })
    attempts.push({ label: 'GET /tasks/{probe}', url: `${base(config)}${F.queryPath('mm-health-probe')}`, method: 'GET' })
    let last
    for (const attempt of attempts) {
      try {
        const response = await (fetchImpl ?? fetch)(attempt.url, { method: attempt.method, headers: { Authorization: `Bearer ${credential}` } })
        if (response.ok) return { ok: true, detail: `${attempt.label} → HTTP ${response.status}` }
        if (response.status === 401 || response.status === 403) return { ok: false, code: CODES.AUTH, detail: `${attempt.label} → HTTP ${response.status}` }
        last = `${attempt.label} → HTTP ${response.status}`
        if (response.status === 404) return { ok: true, detail: `${last}（鉴权通过，端点可达）` }
      } catch (error) {
        last = `${attempt.label} → ${error?.message ?? error}`
      }
    }
    return { ok: false, code: CODES.UNAVAILABLE, detail: last ?? 'unknown' }
  },
}

/** 默认导出的字段常量，便于测试断言。 */
export { F as dashscopeFields, S as dashscopeSyncFields }
