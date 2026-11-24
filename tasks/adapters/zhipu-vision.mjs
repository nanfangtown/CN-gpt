/**
 * 智谱 GLM 视觉路由的**只读探针**（2026-11-21 加，修 P2：ask_glm 一直"未探测"）。
 *
 * 为什么单独一个 adapter：健康报告统一走 `manager.get(adapterId).probe()`，
 * 而 GLM 不是本插件的任务链路（读图员由 llm-pi-ai 路由直接跑），没有 submit/query。
 * 这里只实现 probe，`kind: 'probe'` 说明它不参与任务流水线。
 *
 * 探什么：`GET {zhipuBase}/models`（OpenAI 兼容的模型清单，与 chat/completions 同一把 key）。
 *   - 200：key 有效 → 若配置的 readerGlmModel 不在清单里，**仍然报失败**：
 *     那种状态下滑 agent 会在 spawn 时报 `pi-ai provider "glm" has no configured model "…"`，
 *     等到用户真的去读图才发现，代价是白等一轮。提前说清更省事。
 *   - 401/403：key 不对 → AUTH（文案点名 key 与区域/基址）。
 *   - 404：端点不存在（账号/网关差异）→ 不算鉴权失败，如实报"该厂商没有可用探测端点"。
 *
 * ⚠ 探针**不花钱**：只用 GET。绝不为了"探活"去发一次 chat/completions ——
 *   那和"为探测参数而下单"是同一类错误（见 core/spend-guard.mjs 顶部的事故记录）。
 */
import { CODES } from '../../core/errors.mjs'

/** 官方默认基址（与 llm-pi-ai 里 providers.glm.baseURL 一致）。 */
export const ZHIPU_DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4'

/**
 * 归一化基址：允许粘 `.../v4`、带不带协议、末尾斜杠。
 * @param {object} config - 插件 Config（取 zhipuBase）。
 * @returns {string} 不带尾部斜杠的基址。
 */
export function resolveZhipuBase(config) {
  let text = String(config?.zhipuBase ?? ZHIPU_DEFAULT_BASE).trim().replace(/\/+$/, '')
  if (text.length === 0) text = ZHIPU_DEFAULT_BASE
  if (!/^https?:\/\//iu.test(text)) text = 'https://' + text
  return text
}

/**
 * 从清单响应里抽模型 id（兼容 OpenAI 的 `data[].id` 与 `models[].slug` 两种形态）。
 * @param {unknown} json - 已解析的响应。
 * @returns {string[]|undefined} 模型 id 列表；解析不出来返回 undefined。
 */
export function modelIdsOf(json) {
  if (json === null || typeof json !== 'object') return undefined
  const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : undefined
  if (rows === undefined) return undefined
  const ids = rows
    .map((row) => row?.id ?? row?.slug ?? row?.model)
    .filter((id) => typeof id === 'string' && id.length > 0)
  return ids.length === 0 ? undefined : ids
}

export const zhipuVisionAdapter = {
  id: 'zhipu-vision',
  providerKey: 'zhipu',
  kind: 'probe',
  label: '智谱 GLM 视觉探针',
  providerLabel: '智谱 GLM',
  credentialRef: 'ZHIPU_API_KEY',

  /**
   * 轻量连通性探测。
   * @param {object} options - { credential, config, fetchImpl }。
   * @returns {Promise<{ok: boolean, code?: string, detail: string}>} 探测结果。
   */
  async probe({ credential, config, fetchImpl } = {}) {
    const url = `${resolveZhipuBase(config)}/models`
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
        return {
          ok: false,
          code: CODES.AUTH,
          detail:
            `GET /models → HTTP ${response.status}。请核对 ZHIPU_API_KEY 与 设置 → 模型 → GLM 行的 baseURL ` +
            `（` + resolveZhipuBase(config) + '）。',
        }
      }
      if (response.status === 429) return { ok: false, code: CODES.RATE_LIMIT, detail: 'GET /models → HTTP 429' }
      if (response.status === 404) {
        return {
          ok: false,
          code: CODES.UNAVAILABLE,
          detail: 'GET /models → HTTP 404：该基址没有模型清单端点（探针不可用，不代表 key 无效）',
        }
      }
      if (response.status >= 500) return { ok: false, code: CODES.UNAVAILABLE, detail: `GET /models → HTTP ${response.status}` }
      if (!response.ok) return { ok: false, code: CODES.UNAVAILABLE, detail: `GET /models → HTTP ${response.status}` }

      const ids = modelIdsOf(json)
      const configured = typeof config?.readerGlmModel === 'string' ? config.readerGlmModel.trim() : ''
      if (ids !== undefined && configured.length > 0) {
        const hit = ids.some((id) => id === configured || id.toLowerCase() === configured.toLowerCase())
        if (!hit) {
          return {
            ok: false,
            code: CODES.MODEL_UNAVAILABLE,
            detail:
              `GET /models → HTTP 200（key 有效），但清单里没有 readerGlmModel=「${configured}」。` +
              '请核对 设置 → 模型 → GLM 行 providers.glm.models 白名单（不在白名单里，读图员 spawn 会直接失败）。',
          }
        }
      }
      return {
        ok: true,
        detail:
          'GET /models → HTTP 200' +
          (ids === undefined ? '（未解析模型清单，仅确认鉴权通过）' : `（${ids.length} 个模型，含 ${configured}）`),
      }
    } catch (error) {
      return { ok: false, code: CODES.UNAVAILABLE, detail: `连接失败：${error?.message ?? error}` }
    }
  },
}
