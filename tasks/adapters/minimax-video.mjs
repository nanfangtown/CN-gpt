/**
 * MiniMax（海螺）视频生成 adapter —— 文生 / 图生 / 首尾帧共用一条协议。
 *
 * 官方协议（2026-10-20 核对）：
 *   POST {base}/v1/video_generation
 *        body: { model, prompt?, duration?, resolution?, first_frame_image?, last_frame_image? }
 *   GET  {base}/v1/query/video_generation?task_id=...
 *   GET  {base}/v1/files/retrieve?file_id=...
 *
 * ⚠ 三条与 Ark / 百炼不同的硬约束：
 *   1. **HTTP 200 ≠ 成功**：v1 的错误只写在 `base_resp.status_code` 里；
 *      1004 = 鉴权失败、1002 = 限流、1008 = 余额不足、1026/1027 = 内容审核。
 *   2. **状态大小写不一致**：查询返回 `Success` / `Fail`，回调示例是 `success` / `failed`；
 *      这里统一 lower-case 后再映射。
 *   3. **成功只给 file_id，不给直链**：还要再调 `/v1/files/retrieve?file_id=...`
 *      换 `file.download_url`（官方明确 1 小时有效，必须立刻下载）。
 *
 * 计费：Hailuo 系列按**条**（分辨率 × 时长），不是按秒。单价表用 `unit: call` +
 * `tiers:[{resolution, duration, unitPrice}]`；`unitPrice` 只是兜底展示价。
 * 这与 video_gen 的“按秒 × 模式”不同，所以 estimateCost 单独实现。
 *
 * ⚠ 区域：`api.minimax.cn`（国内）/ `api.minimax.io`（国际）的 **key 不通用**；
 *   旧域名 `api.minimaxi.com` 仍可用。默认国内 `.cn`，可在配置卡改。
 */
import { CODES, MediaError, classifyHttpError } from '../../core/errors.mjs'
import { unitPriceOf } from '../../core/cost.mjs'
import { MINIMAX_FIELDS as F, firstPath, mapRawStatus } from '../../core/fields.mjs'

/** 默认基址：国内站。国际 key 请改成 https://api.minimax.io。 */
export const MINIMAX_DEFAULT_BASE = 'https://api.minimax.cn'

/** 默认模型：支持 T2V / I2V / 首尾帧，价格与 2.3 同档。 */
export const MINIMAX_DEFAULT_MODEL = 'MiniMax-Hailuo-02'

/**
 * 模型能力矩阵（官方 2026-10-20）。
 *
 * 只收当前主推的 Hailuo 三代；`T2V-01*` / `I2V-01*` / `video-01` 已从官方模型清单
 * 移除或属历史 id，故意不做默认项，避免把用户带到“能调但不再维护”的路上。
 *
 * resolutions 的值是“允许的时长”，不是单纯的分辨率列表：
 *   1080P 只允许 6 秒；512P 只允许图生视频。
 */
export const MINIMAX_MODELS = Object.freeze({
  'hailuo-02': Object.freeze({
    id: 'MiniMax-Hailuo-02',
    label: '海螺 02',
    t2v: true,
    i2v: true,
    lastFrame: true,
    resolutions: Object.freeze({ '512P': Object.freeze([6, 10]), '768P': Object.freeze([6, 10]), '1080P': Object.freeze([6]) }),
  }),
  'hailuo-2.3': Object.freeze({
    id: 'MiniMax-Hailuo-2.3',
    label: '海螺 2.3',
    t2v: true,
    i2v: true,
    lastFrame: false,
    resolutions: Object.freeze({ '768P': Object.freeze([6, 10]), '1080P': Object.freeze([6]) }),
  }),
  'hailuo-2.3-fast': Object.freeze({
    id: 'MiniMax-Hailuo-2.3-Fast',
    label: '海螺 2.3 Fast',
    t2v: false,
    i2v: true,
    lastFrame: false,
    resolutions: Object.freeze({ '768P': Object.freeze([6, 10]), '1080P': Object.freeze([6]) }),
  }),
})

/** 短名/真实 id → 模型条目；认不出来返回 undefined（不静默兜底）。 */
export function resolveMinimaxModel(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return undefined
  if (MINIMAX_MODELS[text] !== undefined) return { alias: text, ...MINIMAX_MODELS[text] }
  for (const [alias, entry] of Object.entries(MINIMAX_MODELS)) {
    if (entry.id === text) return { alias, ...entry }
  }
  return undefined
}

/** 归一化基址：允许粘贴 `.../v1`、带不带协议、末尾斜杠。 */
export function resolveMinimaxBase(config) {
  let text = String(config?.minimaxBase ?? MINIMAX_DEFAULT_BASE).trim().replace(/\/+$/, '')
  if (text.length === 0) text = MINIMAX_DEFAULT_BASE
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text
  // 文档把 `/v1` 放在 path 里；用户把整串 `.../v1` 粘进来也能用。
  if (/\/v1$/i.test(text)) text = text.slice(0, -3)
  return text
}

/** MiniMax v1 的 `base_resp.status_code` → 统一错误码。 */
export function mapVendorCode(code) {
  const value = Number(code)
  if (value === 1002 || value === 1039 || value === 1041) return CODES.RATE_LIMIT
  if (value === 1004 || value === 2049) return CODES.AUTH
  if (value === 1008 || value === 2056) return CODES.QUOTA
  if (value === 1026 || value === 1027) return CODES.POLICY_REJECTED
  if (value === 2013) return CODES.BAD_REQUEST
  if (value === 1000 || value === 1001 || value === 1013 || value === 1024 || value === 1033) return CODES.UNAVAILABLE
  return CODES.UNKNOWN
}

/** 拼一句人话的厂商错误（保留原始 code 与 status_msg）。 */
function vendorFailure(json) {
  const code = firstPath(json, F.baseRespCodePaths)
  const message = firstPath(json, F.baseRespMessagePaths)
  const mapped = mapVendorCode(code)
  return new MediaError(
    mapped,
    `MiniMax 返回错误（base_resp.status_code=${String(code ?? '未知')}）：${String(message ?? '没有错误说明')}` +
      (mapped === CODES.AUTH ? '。请检查 MINIMAX_API_KEY 是否与 minimaxBase 同区域（国内 .cn / 国际 .io 的 key 不通用）。' : ''),
    { vendorCode: code === undefined ? undefined : String(code) },
  )
}

/** 请求体里的图片值：优先公网 URL，其次 data URL。 */
function imageValue(image) {
  if (image === undefined || image === null) return undefined
  const value = image.url ?? image.dataUrl
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 规格校验 + 归一化。工具层在报价前也调用它，避免“参数不支持”被误报成“未计价”。
 * @param {object} spec - { model, prompt, image, lastImage, duration, resolution }。
 * @returns {{resolved: object, prompt: string, first?: string, last?: string, resolution: string, duration: number}}
 */
export function validateMinimaxSpec(spec) {
  const resolved = resolveMinimaxModel(spec.model)
  if (resolved === undefined) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：未知的 MiniMax 视频模型「${String(spec.model ?? '')}」。可选：` +
        Object.keys(MINIMAX_MODELS).join(' / ') +
        `。**本次未提交、未产生任何费用。** 请在 插件页 → CN-gpt → 配置卡 的 minimaxModel 里选择。`,
    )
  }
  const prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : ''
  if (prompt.length > 2000) {
    throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：MiniMax prompt 上限 2000 字符。**本次未提交、未产生任何费用。**')
  }
  const first = imageValue(spec.image)
  const last = imageValue(spec.lastImage)
  if (first === undefined && last !== undefined) {
    throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：只给尾帧、不给首帧没有意义。**本次未提交、未产生任何费用。**')
  }
  if (prompt.length === 0 && first === undefined) {
    throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：文生视频必须给 prompt；图生视频请给 image（首帧图）。**本次未提交、未产生任何费用。**')
  }
  if (resolved.t2v === false && first === undefined) {
    throw new MediaError(CODES.BAD_REQUEST, `参数不被接受：${resolved.label} 只支持图生视频，请给 image。**本次未提交、未产生任何费用。**`)
  }
  if (last !== undefined && resolved.lastFrame !== true) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：${resolved.label} 不支持首尾帧，只有 Hailuo-02 支持。**本次未提交、未产生任何费用。**`,
    )
  }
  const resolution = typeof spec.resolution === 'string' && spec.resolution.length > 0 ? spec.resolution : '768P'
  const allowedDurations = resolved.resolutions[resolution]
  if (allowedDurations === undefined) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：${resolved.label} 不支持分辨率 ${resolution}。可选：${Object.keys(resolved.resolutions).join(' / ')}。**本次未提交、未产生任何费用。**`,
    )
  }
  if (resolution === '512P' && first === undefined) {
    throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：512P 只用于图生视频（需要 image）。**本次未提交、未产生任何费用。**')
  }
  const duration = Number(spec.duration ?? 6)
  if (!allowedDurations.includes(duration)) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：${resolved.label} 在 ${resolution} 下只支持 ${allowedDurations.join(' / ')} 秒。**本次未提交、未产生任何费用。**`,
    )
  }
  return { resolved, prompt, first, last, resolution, duration }
}

export const minimaxVideoAdapter = {
  id: 'minimax-video',
  providerKey: 'minimax',
  kind: 'video',
  label: 'MiniMax 出片（海螺）',
  providerLabel: 'MiniMax（海螺）',
  credentialRef: 'MINIMAX_API_KEY',

  /**
   * 提交请求。三种玩法共用 `/v1/video_generation`：
   *   - 只有 prompt：文生视频；
   *   - first_frame_image：图生视频；
   *   - first_frame_image + last_frame_image：首尾帧。
   */
  buildSubmit(spec, { credential, config }) {
    const { resolved, prompt, first, last, resolution, duration } = validateMinimaxSpec(spec)

    const body = { [F.bodyModel]: resolved.id }
    if (prompt.length > 0) body[F.bodyPrompt] = prompt
    body[F.bodyDuration] = duration
    body[F.bodyResolution] = resolution
    if (first !== undefined) body[F.bodyFirstFrame] = first
    if (last !== undefined) body[F.bodyLastFrame] = last
    return {
      url: `${resolveMinimaxBase(config)}${F.submitPath}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body,
    }
  },

  /** 提交响应：先查 base_resp，再取 task_id。 */
  parseSubmit(json) {
    const code = firstPath(json, F.baseRespCodePaths)
    if (code !== undefined && Number(code) !== 0) throw vendorFailure(json)
    return {
      taskId: firstPath(json, F.taskIdPaths),
    }
  },

  buildQuery(taskId, { credential, config }) {
    return {
      url: `${resolveMinimaxBase(config)}${F.queryPath(taskId)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
    }
  },

  /** 查询响应 → 归一化 State；成功时把 file_id 留给 resolveArtifacts。 */
  parseQuery(json, context = {}) {
    const code = firstPath(json, F.baseRespCodePaths)
    if (code !== undefined && Number(code) !== 0) throw vendorFailure(json)
    const rawStatus = firstPath(json, F.statusPaths)
    const mapped = mapRawStatus(F, typeof rawStatus === 'string' ? rawStatus.toLowerCase() : rawStatus)
    const status = mapped === 'unknown' ? 'running' : mapped
    const fileId = firstPath(json, F.fileIdPaths)
    const state = {
      status,
      rawStatus,
      artifacts: [],
      ...(status === 'succeeded' && fileId !== undefined ? { fileId: String(fileId) } : {}),
      ...(status === 'failed'
        ? {
            error: {
              code: String(rawStatus ?? 'FAILED'),
              detail: String(firstPath(json, F.baseRespMessagePaths) ?? rawStatus ?? ''),
            },
          }
        : {}),
    }
    if (mapped === 'unknown' || rawStatus === undefined) state.unknownStatus = true
    if (context.taskId !== undefined) state.taskId = context.taskId
    return state
  },

  /** MiniMax 成功只给 file_id；下载前必须换一次带时效的 download_url。 */
  async resolveArtifacts(state, { credential, config, fetchImpl, signal } = {}) {
    if (state?.fileId === undefined) return []
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new MediaError(CODES.AUTH, 'MiniMax 取文件需要 API Key，但当前没有可用凭据。')
    }
    const url = `${resolveMinimaxBase(config)}${F.retrievePath(state.fileId)}`
    const response = await (fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text().catch(() => '')
    let json
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (!response.ok) {
      const mapped = classifyHttpError(response.status, json ?? text)
      throw new MediaError(mapped.code, `MiniMax 取文件失败（HTTP ${response.status}）：${String(mapped.detail ?? '')}`, {
        status: response.status,
        vendorCode: mapped.vendorCode,
      })
    }
    const code = firstPath(json, F.baseRespCodePaths)
    if (code !== undefined && Number(code) !== 0) throw vendorFailure(json)
    const downloadUrl = firstPath(json, F.downloadUrlPaths)
    if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) {
      throw new MediaError(CODES.UNKNOWN, 'MiniMax 取文件成功，但响应里没有 file.download_url（官方字段可能变更）。')
    }
    return [downloadUrl]
  },

  extractArtifacts() {
    // 成功响应里没有直链，只有 file_id；由 resolveArtifacts 补拿。
    return []
  },

  mapHttpError(status, body) {
    return classifyHttpError(status, body)
  },

  /**
   * 按条计价：档位 = 分辨率 × 时长。
   *
   * 与 video_gen 的差别：那里是“单价 × 秒”，这里是“一条多少钱”。
   * tiers 一旦存在就必须精确命中；没有对应档位返回 null，让闸门 fail-closed。
   */
  estimateCost(spec, pricing) {
    const entry = pricing?.[spec.model] ?? {}
    const resolved = resolveMinimaxModel(spec.model)
    const resolution = typeof spec.resolution === 'string' && spec.resolution.length > 0 ? spec.resolution : '768P'
    const duration = Number(spec.duration ?? 6)
    const unitKind = entry.unit === 'second' ? 'second' : 'call'
    const tiers = Array.isArray(entry.tiers) ? entry.tiers : []
    let unitPrice
    if (tiers.length > 0) {
      const exact = tiers.find(
        (tier) => String(tier?.resolution ?? '') === resolution && Number(tier?.duration) === duration,
      )
      unitPrice = exact === undefined ? null : unitPriceOf(exact)
    } else {
      unitPrice = unitPriceOf(entry)
    }
    const units = unitKind === 'second' ? duration : 1
    return {
      model: spec.model,
      modelLabel: resolved?.label,
      resolution,
      duration,
      unitKind,
      units,
      unitPrice,
      currency: entry.currency ?? 'CNY',
      amount: unitPrice === null ? null : Number((units * unitPrice).toFixed(6)),
    }
  },

  /**
   * 健康探测：`/v1/files/retrieve?file_id=1`。
   *
   * 该接口必定返回 HTTP 200；`base_resp` 为 1004/2049 = key 不认，其他 code
   * （例如文件不存在）说明鉴权已过、端点可达。这与百炼/Ark 的 404 判定同理。
   */
  async probe({ credential, config, fetchImpl }) {
    const url = `${resolveMinimaxBase(config)}${F.retrievePath('1')}`
    try {
      const response = await (fetchImpl ?? fetch)(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      })
      const text = await response.text().catch(() => '')
      let json
      try {
        json = text.length > 0 ? JSON.parse(text) : undefined
      } catch {
        json = undefined
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: CODES.AUTH, detail: `GET /v1/files/retrieve → HTTP ${response.status}` }
      }
      if (response.status === 429) return { ok: false, code: CODES.RATE_LIMIT, detail: `HTTP 429` }
      if (response.status >= 500) return { ok: false, code: CODES.UNAVAILABLE, detail: `HTTP ${response.status}` }
      if (!response.ok) {
        const mapped = classifyHttpError(response.status, json ?? text)
        return { ok: false, code: mapped.code, detail: `HTTP ${response.status}` }
      }
      const code = firstPath(json, F.baseRespCodePaths)
      const message = firstPath(json, F.baseRespMessagePaths)
      if (Number(code) === 0) return { ok: true, detail: 'GET /v1/files/retrieve → HTTP 200（status_code=0）' }
      const mapped = mapVendorCode(code)
      if (mapped === CODES.AUTH) return { ok: false, code: mapped, detail: `status_code=${code}：${String(message ?? '')}` }
      if (mapped === CODES.RATE_LIMIT || mapped === CODES.QUOTA || mapped === CODES.UNAVAILABLE) {
        return { ok: false, code: mapped, detail: `status_code=${code}：${String(message ?? '')}` }
      }
      // 文件不存在 / 参数错误 = key 已通过、端点可达。
      return { ok: true, detail: `GET /v1/files/retrieve → HTTP 200（status_code=${String(code)}，鉴权通过）` }
    } catch (error) {
      return { ok: false, code: CODES.UNAVAILABLE, detail: `连接失败：${error?.message ?? error}` }
    }
  },
}

/** 默认导出的字段常量，便于测试断言。 */
export { F as minimaxFields }
