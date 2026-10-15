/**
 * media_report —— 成本估算 + 三把 key / 三条链路健康状态（规划 [2.5]）。
 *
 * action=cost  ：按用量账本 × 单价表给出预估费用（session | today | all），返回表格文本 + 免责声明。
 * action=health：三把 key 的配置状态 + 三条链路最近成功/失败 + 轻量连通性探测（5 分钟 TTL 缓存）。
 * 管理类能力合成一个工具，控制每请求固定 schema 成本。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError } from '../core/errors.mjs'
import { KEY_SPECS, keySpec } from '../core/keys.mjs'
import { renderCostReport, renderHealthReport } from '../core/cost.mjs'

const PROBE_ADAPTERS = Object.freeze({
  dashscope: 'dashscope-image',
  'dashscope-vl': 'dashscope-image',
  ark: 'ark-video',
})

/**
 * 注册 media_report。
 * @param {object} deps - ctx / config / manager / keys / getLedger / fetchImpl。
 */
export function createMediaReportTool(deps) {
  const { ctx, config, manager, keys, getLedger, switches } = deps
  const probeCache = new Map()
  const ttlMs = Number.isFinite(config.healthProbeTtlMs) && config.healthProbeTtlMs > 0 ? config.healthProbeTtlMs : 300000

  /** 共用同一条探测的其它 key（例如 DASHSCOPE_API_KEY 同时供 qwen_draw 与 ask_qwen）。 */
  const sharesProbeWithEnabled = (keyId) => {
    if (switches === undefined) return false
    const adapterId = PROBE_ADAPTERS[keyId]
    return KEY_SPECS.some(
      (other) => other.id !== keyId && PROBE_ADAPTERS[other.id] === adapterId && switches.isEnabled(other.capability) === true,
    )
  }

  async function probeOf(keyId, force = false) {
    if (config.healthProbe === false) return undefined
    const adapterId = PROBE_ADAPTERS[keyId]
    if (adapterId === undefined) return undefined
    // 开关关闭的链路不做探测（避免无谓的网络请求与误导）。
    // 例外：同一条 key / adapter 还被另一个开着的链路共用时仍然探测（结果本来就一样）。
    if (switches !== undefined && switches.isEnabled(keySpec(keyId).capability) === false && !sharesProbeWithEnabled(keyId)) return undefined
    const cached = probeCache.get(adapterId)
    if (!force && cached !== undefined && Date.now() - cached.at < ttlMs) return cached.result
    const adapter = manager.get(adapterId)
    const spec = keySpec(keyId)
    const credential = await keys.resolve(spec)
    if (credential === undefined) {
      const result = { ok: false, code: CODES.MISSING_CREDENTIAL, detail: '未配置 ' + spec.ref }
      probeCache.set(adapterId, { at: Date.now(), result })
      return result
    }
    const result = await adapter.probe({ credential: credential.value, config, fetchImpl: deps.fetchImpl })
    probeCache.set(adapterId, { at: Date.now(), result })
    return result
  }

  return defineTool({
    name: 'media_report',
    description: '媒体报告：action=cost 成本估算（scope=session|today|all）；action=health 各条链路的 key、健康与工具开关。',
    parameters: {
      action: { type: 'string', required: true, enum: ['cost', 'health'], description: 'cost=成本；health=链路健康' },
      scope: { type: 'string', enum: ['session', 'today', 'all'], description: 'cost 用：session（默认）/today/all' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.action === 'cost') {
        const scope = args.scope ?? 'session'
        const now = Date.now()
        const filter = scope === 'today' ? { since: startOfToday(now) } : {}
        if (scope === 'session') {
          const sessionId = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
          if (sessionId !== undefined) filter.sessionId = sessionId
        }
        const ledger = await getLedger()
        const records = await ledger.list(filter)
        return { report: renderCostReport({ records, config, scope, sessionId: filter.sessionId, now }) }
      }
      if (args.action === 'health') {
        const ledger = await getLedger()
        const [keyEntries, health, ledgerBackend] = await Promise.all([keys.describeAll(), ledger.healthSnapshot(), Promise.resolve(ledger.backend())])
        const probes = {}
        for (const spec of KEY_SPECS) {
          const probe = await probeOf(spec.id)
          if (probe !== undefined) probes[PROBE_ADAPTERS[spec.id]] = probe
        }
        const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
        let llmProviders
        try {
          const rows = llm?.listProviders?.()
          if (Array.isArray(rows)) llmProviders = rows.map((row) => row?.id).filter((id) => typeof id === 'string')
        } catch {
          llmProviders = undefined
        }
        const report = renderHealthReport({ keyEntries, health, probes, llmProviders, config, switches: switches?.snapshot?.() ?? {}, readerConflict: switches?.conflict?.() === true })
        return { report: report + '\n\n账本后端：' + ledgerBackend + '（storage = 宿主 storage 服务；file = 插件 JSON 回退）' }
      }
      throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：action 必须是 cost 或 health')
    },
    presentCall(args) {
      return { card: 'generic', title: args.action === 'cost' ? '成本估算' : '链路健康', kind: 'report' }
    },
  })
}

function startOfToday(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
