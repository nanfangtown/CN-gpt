/**
 * 百炼（DashScope）视频生成 adapter —— 可灵 v3 与万相 wan2.5 共用一条协议。
 * 厂商差异只允许出现在这里与 core\fields.mjs。
 *
 * 为什么能共用：两家在百炼上是**同一套异步视频协议**
 *   POST /services/aigc/video-generation/video-synthesis （X-DashScope-Async: enable）
 *   GET  /tasks/{task_id}                                （Authorization: Bearer）
 * 差异只有三处，全部在这里收口：
 *   1. 模型 id（kling/... 走路径前缀，wan 是扁平 id）；
 *   2. 分辨率参数（可灵用 parameters.mode=std|pro|4k，万相用 parameters.size="1280*720"）；
 *   3. 档位价格（按"模式 × 是否带音频"二维定价）。
 *
 * 计费口径（官方页，2026-10-17）：
 *   可灵 v3   720P 0.6 / 1080P 0.8 / 4K 3.0 元/秒（无声）；带原生音频 0.9 / 1.2 / 3.0
 *   可灵 Turbo 720P 0.8 / 1080P 1.0（固定音画同出）
 *   万相 2.5  720P 0.6 / 1080P 1.0 元/秒
 *   来源：https://help.aliyun.com/zh/model-studio/kling-v3-omni-video-generation
 *         https://help.aliyun.com/zh/model-studio/wan2-5-t2v
 *
 * ⚠ 待实跑确证（tests/probe-dashscope-video.mjs）：万相的 size 字段名、media.url 是否
 *   接受 base64、错误体形状、video_url 路径。实跑后只改本文件与 fields.mjs。
 */
import { CODES, MediaError, classifyHttpError } from '../../core/errors.mjs'
import { unitPriceOf } from '../../core/cost.mjs'
import { DASHSCOPE_VIDEO_FIELDS as F, firstPath, mapRawStatus, setPath } from '../../core/fields.mjs'

/**
 * 对外暴露的短名 → 真实模型 id。
 *
 * 短名是给人/给模型看的（`kling-v3` 比 `kling/kling-v3-video-generation` 好记），
 * 但**单价表的键必须是真实 id**（这是 2026-10-15 那次闸门锁死事故的直接教训）。
 * 所以工具层只收短名，落单价表/账本/注册表时一律用 id。
 */
export const VIDEO_MODELS = Object.freeze({
  'kling-v3': Object.freeze({ id: 'kling/kling-v3-video-generation', family: 'kling', label: '可灵 v3' }),
  'kling-v3-turbo': Object.freeze({ id: 'kling/kling-v3-turbo-video-generation', family: 'kling', label: '可灵 v3 Turbo' }),
  'kling-v3-omni': Object.freeze({ id: 'kling/kling-v3-omni-video-generation', family: 'kling', label: '可灵 v3 Omni' }),
  'wan2.5': Object.freeze({ id: 'wan2.5-t2v-preview', family: 'wan', label: '万相 2.5' }),
})

/** 分辨率模式：给人看的三档。 */
export const VIDEO_MODES = Object.freeze({
  std: Object.freeze({ label: '720P', kling: 'std', wanSize: '1280*720' }),
  pro: Object.freeze({ label: '1080P', kling: 'pro', wanSize: '1920*1080' }),
  '4k': Object.freeze({ label: '4K', kling: '4k', wanSize: undefined }),
})

/** 时长取值域（官方：3–15 秒整数；万相 5/10 秒，按文档保守处理）。 */
export const DURATION_RANGE = Object.freeze({ min: 3, max: 15, default: 5 })

/**
 * 把"配置里的模型值"解析成 { alias, id, family, label }。
 *
 * 接受两种写法：短名（`kling-v3`）或真实 id（`kling/kling-v3-video-generation`）。
 * 认不出来时**不静默兜底**：返回 undefined，由调用方给出"去配置卡改"的明确错误。
 * 静默兜底的代价见 2026-10-15：模型 id 与单价表脱钩 → 闸门 fail-closed 且无告警。
 *
 * @param {unknown} value - 配置里的 videoModel。
 * @returns {{alias: string, id: string, family: string, label: string}|undefined}
 */
export function resolveVideoModel(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return undefined
  if (VIDEO_MODELS[text] !== undefined) return { alias: text, ...VIDEO_MODELS[text] }
  for (const [alias, entry] of Object.entries(VIDEO_MODELS)) {
    if (entry.id === text) return { alias, ...entry }
  }
  return undefined
}

/**
 * 归一化端点基址：允许用户从控制台**整串粘贴 API Host**（`llm-xxx.cn-beijing.maas.aliyuncs.com`）。
 *
 * 为什么必须容错：控制台的「业务空间管理」页给的是一列 *API Host*，而文档给的
 * Base URL 是 `https://{host}/api/v1`。用户照着复制时通常只拿到前者 ——
 * 少拼一段就 404，而 404 在付费接口上很容易被当成"模型没开通"去乱试。
 *
 * @param {string} value - 用户输入（可带 https://、可带/不带 /api/v1）。
 * @returns {string} 去掉末尾斜杠的完整基址。
 */
function normalizeBase(value) {
  let text = String(value).trim().replace(/\/+$/, '')
  if (text.length === 0) return text
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text
  if (!/\/api\/v\d+$/i.test(text)) text = text + '/api/v1'
  return text
}

/**
 * 解析视频端点基址。
 *
 * 百炼视频的域名**不是** dashscope.aliyuncs.com，而是
 *   https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1
 * 且必须与 API Key 同地域（华北2 北京）。WorkspaceId 是业务空间 ID（形如 `llm-xxxx`），
 * 在百炼控制台「业务空间管理」页的 API Host 列可见；没配就直接报错——
 * 绝不猜一个默认域名去试，试错在付费接口上等于下单（2026-10-15 的 ¥195.97）。
 *
 * 容错：dashscopeWorkspaceId 里粘贴整串 host 也能用（含 `.` 就当成 host）。
 *
 * @param {object} config - 插件 Config（已解包）。
 * @returns {string} 规范化后的基址。
 */
export function resolveBase(config) {
  const explicit = String(config?.dashscopeVideoBase ?? '').trim()
  if (explicit.length > 0) return normalizeBase(explicit)
  const workspace = String(config?.dashscopeWorkspaceId ?? '').trim()
  if (workspace.length === 0) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      '参数不被接受：video_gen 需要百炼**业务空间 ID / API Host**，当前 dashscopeWorkspaceId 为空、本次未提交、未产生任何费用。' +
        '请让用户打开 百炼控制台 → 业务空间管理（https://bailian.console.aliyun.com/cn-beijing/settings/workspace），' +
        '复制 API Host 粘进配置卡的 dashscopeVideoBase（或只把 llm-xxxx 粘进 dashscopeWorkspaceId）。',
    )
  }
  // 含 `.` 视为直接给了 host，否则按 WorkspaceId 拼标准域名。
  const host = workspace.includes('.') ? workspace : `${workspace}.cn-beijing.maas.aliyuncs.com`
  return normalizeBase(`https://${host}`)
}

/** 从查询响应里抽视频 URL（可能带时效签名；绝不进工具结果，只用于下载）。 */
function videoUrls(json) {
  const urls = []
  const direct = firstPath(json, F.videoUrlPaths)
  if (typeof direct === 'string' && direct.length > 0) urls.push(direct)
  const rows = firstPath(json, F.resultsPaths)
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const url = typeof row === 'string' ? row : firstPath(row, F.resultUrlPaths)
      if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) urls.push(url)
    }
  }
  return urls
}

/** 查询响应 → 归一化 State。 */
function parseState(json, { taskId }) {
  const rawStatus = firstPath(json, F.statusPaths)
  const mapped = mapRawStatus(F, rawStatus)
  // 状态认不出来时按 running 处理（与 dashscope-image 一致）：宁可多轮询一次，
  // 也不要把"正在跑"误判成失败 —— 失败会触发退款直觉，而钱其实已经花了。
  const status = mapped === 'unknown' ? 'running' : mapped
  const errorCode = firstPath(json, F.errorCodePaths)
  const errorMessage = firstPath(json, F.errorMessagePaths)
  const state = {
    status,
    rawStatus,
    ...(status === 'succeeded' ? { artifacts: videoUrls(json) } : { artifacts: [] }),
    ...(status === 'failed'
      ? {
          error: {
            code: typeof errorCode === 'string' ? errorCode : 'UNKNOWN',
            detail: typeof errorMessage === 'string' ? errorMessage : '',
          },
        }
      : {}),
  }
  if (mapped === 'unknown' || rawStatus === undefined) state.unknownStatus = true
  if (taskId !== undefined) state.taskId = taskId
  return state
}

/** 万相的分辨率字符串（DashScope 用 `宽*高`）。 */
function wanSize(mode, ratio) {
  const preset = VIDEO_MODES[mode]?.wanSize
  if (preset === undefined) return undefined
  const [width, height] = preset.split('*').map(Number)
  if (ratio === '9:16') return `${height}*${width}`
  if (ratio === '1:1') return `${Math.min(width, height)}*${Math.min(width, height)}`
  return preset
}

export const dashscopeVideoAdapter = {
  id: 'dashscope-video',
  providerKey: 'bailian',
  kind: 'video',
  label: '百炼出片（可灵 / 万相）',
  providerLabel: '百炼（可灵/万相）',
  credentialRef: 'DASHSCOPE_API_KEY',

  /** POST {base}/services/aigc/video-generation/video-synthesis */
  buildSubmit(spec, { credential, config }) {
    const resolved = resolveVideoModel(spec.model)
    if (resolved === undefined) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        `参数不被接受：未知的视频模型「${String(spec.model ?? '')}」。可选：` +
          Object.keys(VIDEO_MODELS).join(' / ') +
          '；请在 插件页 → CN-gpt → 配置卡 的 videoModel 里选择。**本次未提交、未产生任何费用。**',
      )
    }
    const mode = VIDEO_MODES[spec.mode] === undefined ? 'std' : spec.mode
    if (spec.mode !== undefined && VIDEO_MODES[spec.mode] === undefined) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        `参数不被接受：未知画质档「${String(spec.mode)}」。可选：${Object.keys(VIDEO_MODES).join(' / ')}。**本次未提交、未产生任何费用。**`,
      )
    }
    // Turbo 只有 std/pro（官方明确不支持 4K）。必须在这里挡：4K 在 Turbo 的单价表里
    // 没有档位，若放过去，estimateCost 会 fail-closed 成"未计价"，用户看到的是
    // "去补单价"而不是"这个模型没有 4K"——错误文案会把人带到错的方向。
    if (resolved.alias === 'kling-v3-turbo' && mode === '4k') {
      throw new MediaError(
        CODES.BAD_REQUEST,
        '参数不被接受：可灵 v3 Turbo 不支持 4K（只有 std=720P / pro=1080P）。**本次未提交、未产生任何费用。** 需要 4K 请改用 kling-v3 或 kling-v3-omni。',
      )
    }
    const body = {}
    setPath(body, F.bodyModel, resolved.id)
    setPath(body, F.bodyPrompt, spec.prompt)
    if (typeof spec.negativePrompt === 'string' && spec.negativePrompt.length > 0) {
      setPath(body, F.bodyNegative, spec.negativePrompt)
    }
    // 首帧图：百炼文档只写了 http/https（JPEG/PNG，300–8000px，≤10MB）。
    // 本地文件转出来的 data URL 是否被接受**尚未实跑确证**，所以这里显式拒绝，
    // 而不是把一个可能 4xx 的请求发出去（付费接口上的"试一下"等于下单）。
    if (spec.image !== undefined && spec.image !== null) {
      const url = spec.image.url ?? spec.image.dataUrl
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        throw new MediaError(
          CODES.BAD_REQUEST,
          '参数不被接受：百炼视频的首帧图必须是 **http(s) URL**（本地路径暂不支持，文档未承诺接受 base64）。' +
            '**本次未提交、未产生任何费用。** 请先把图片放到可公开访问的地址，或改用文生视频。',
        )
      }
      setPath(body, F.bodyMedia, [{ type: 'first_frame', url }])
    }
    if (resolved.family === 'kling') {
      setPath(body, F.bodyMode, mode)
      // 图生视频以首帧宽高比为基准，文档明确"无需填写"。
      if (spec.image === undefined && typeof spec.ratio === 'string' && spec.ratio.length > 0) {
        setPath(body, F.bodyRatio, spec.ratio)
      }
      setPath(body, F.bodyDuration, spec.duration ?? DURATION_RANGE.default)
      // Turbo 固定音画同出，audio 字段不生效；其余按用户选择。
      if (resolved.alias !== 'kling-v3-turbo') setPath(body, F.bodyAudio, spec.audio === true)
    } else {
      // 万相：当前只接文生（i2v 是另一个模型 id，未纳入本 adapter）。
      if (spec.image !== undefined) {
        throw new MediaError(
          CODES.BAD_REQUEST,
          '参数不被接受：万相 wan2.5 目前只接了**文生视频**；图生视频请把 model 换成 `kling-v3` 或 `kling-v3-omni`。' +
            '**本次未提交、未产生任何费用。**',
        )
      }
      const size = wanSize(mode, spec.ratio)
      if (size === undefined) {
        throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：万相 wan2.5 不支持 4K（可选 std=720P / pro=1080P）。**本次未提交、未产生任何费用。**')
      }
      setPath(body, F.bodySize, size)
      setPath(body, F.bodyDuration, spec.duration ?? DURATION_RANGE.default)
      setPath(body, F.bodyAudio, spec.audio === true)
      setPath(body, F.bodyPromptExtend, true)
    }
    setPath(body, F.bodyWatermark, false)
    return {
      url: `${resolveBase(config)}${F.submitPath}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        [F.asyncHeader]: 'enable',
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
      url: `${resolveBase(config)}${F.queryPath(taskId)}`,
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

  /**
   * 按秒计价，档位 = 模式（720P/1080P/4K）× 是否带音频。
   *
   * 为什么必须二维：4K 是 720P 的 5 倍价（3.0 vs 0.6）。只填一个单价的话，
   * 4K 请求会被低报 5 倍 —— 闸门看着"没超上限"，实际一次就 ¥45。
   *
   * ⚠ 2026-10-17 复查修（成本安全）：**tiers 一旦存在就必须精确命中**，
   * 不再回落到条目价。旧逻辑在"tiers 里没有这个模式"时退回 `unitPrice`：
   * 有人删掉 4K 档位后，8 秒 4K 真实 ¥24 会被按 1080P 的 0.8 报成 ¥6.4，
   * 单次上限 ¥10 直接放行 —— 低报 3.75 倍。现在这种形态一律返回 null，
   * 由闸门按"未计价"fail-closed：宁可不出片，也不低报。
   *
   * 单价表条目形如：
   *   { unit:'second', unitPrice:0.8, tiers:[{mode:'std',audio:false,unitPrice:0.6}, …] }
   */
  estimateCost(spec, pricing) {
    const entry = pricing?.[spec.model] ?? {}
    const mode = VIDEO_MODES[spec.mode] === undefined ? 'std' : spec.mode
    const audio = spec.audio === true
    const units = Number(spec.duration ?? DURATION_RANGE.default)
    const tiers = Array.isArray(entry.tiers) ? entry.tiers : []
    let unitPrice
    if (tiers.length > 0) {
      const exact = tiers.find((tier) => tier?.mode === mode && Boolean(tier?.audio) === audio)
      unitPrice = exact === undefined ? null : unitPriceOf(exact)
    } else {
      // 没有 tiers = 只填了一个统一价（例如各档同价），按条目价算。
      unitPrice = unitPriceOf(entry)
    }
    return {
      model: spec.model,
      mode,
      audio,
      unitKind: 'second',
      units,
      unitPrice,
      currency: entry.currency ?? 'CNY',
      amount: unitPrice === null ? null : Number((units * unitPrice).toFixed(6)),
    }
  },

  /** 轻量健康探测：GET 一个不存在的任务；404 视为鉴权通过、端点可达。 */
  async probe({ credential, config, fetchImpl }) {
    let base
    try {
      base = resolveBase(config)
    } catch (error) {
      return { ok: false, code: CODES.BAD_REQUEST, detail: error?.message ?? '未配置业务空间 ID' }
    }
    const url = `${base}${F.queryPath('mm-health-probe')}`
    try {
      const response = await (fetchImpl ?? fetch)(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      })
      if (response.ok) return { ok: true, detail: `GET /tasks/{probe} → HTTP ${response.status}` }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: CODES.AUTH, detail: `GET /tasks/{probe} → HTTP ${response.status}` }
      }
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
export { F as dashscopeVideoFields }
