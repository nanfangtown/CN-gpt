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
  const { ctx, config, manager, keys, getLedger, getTaskRegistry, switches, readerUsage } = deps
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
      // 2026-10-16 加：报告默认走**紧凑模式**。理由（实测）：一次 health 返回约 2.7–3.5 KB，
      // 而工具结果会**永久留在会话里、之后每轮都重发**——反复查健康度是线性开销。
      // 紧凑模式只删"样板/图例/明细"，**不删任何告警**（插件自家规矩：看不见的告警等于没有告警）。
      // ⚠ 描述刻意写短：参数描述是 per-request 成本（有 schema 字节预算测试盯着）。
      verbose: { type: 'boolean', description: 'true = 完整明细' },
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
      const verbose = args.verbose === true
      if (args.action === 'cost') {
        const scope = args.scope ?? 'session'
        const now = Date.now()
        const filter = scope === 'today' ? { since: startOfToday(now) } : {}
        let sessionId
        let childSessionCount = 0
        if (scope === 'session') {
          sessionId = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
          if (sessionId !== undefined) {
            // 会话树（2026-10-16）：`scope=session` 汇总**自己 + 后代子代理会话**。
            // 子代理默认允许出图（效率优先），它的花费记在自己会话上；不聚合的话
            // 主代理"看不见自己派出去的子代理花了多少"——那正是成本黑洞的机制（看不见 = 管不住）。
            const ids = deps.sessionIdsForSpend?.(sessionId) ?? [sessionId]
            childSessionCount = Math.max(0, ids.length - 1)
            if (ids.length === 1) filter.sessionId = ids[0]
            else filter.sessionIds = ids
          }
        }
        const ledger = await getLedger()
        const records = await ledger.list(filter)
        return { report: renderCostReport({ records, config, scope, sessionId, now, verbose, childSessionCount, readerUsage: readerUsage?.summary?.() ?? null }) }
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
        const report = renderHealthReport({ keyEntries, health, probes, llmProviders, config, switches: switches?.snapshot?.() ?? {}, readerConflict: switches?.conflict?.() === true, verbose })
        let backendLine = '\n\n账本后端：' + ledgerBackend + '（storage = 宿主 storage 服务；file = 插件 JSON 回退）'
        // 退回文件后端是**降级**，必须说清原因：否则表现就是"报表里历史用量凭空消失"，
        // 而用户没有任何线索。两种起因都要走这里：
        //   ① 2026-10-15 实发：一条未计价记录过不了 zod 校验，整个账本领域 open() 失败；
        //   ② 2026-10-15 复查实发：`ctx.get('storageDomain')` 未命中（服务没拿到），
        //      当时这一支是**静默**的 —— 报表对着磁盘上的 15 条真实记录说"没有用量记录"。
        // 措辞对两种起因都成立，所以不写"打不开"，只写"没有落在 storage 领域"。
        const fallbackReason = typeof ledger.storageError === 'function' ? ledger.storageError() : undefined
        let registryBackend
        let registryReason
        if (typeof getTaskRegistry === 'function') {
          try {
            const registry = await getTaskRegistry()
            registryBackend = typeof registry?.backend === 'function' ? registry.backend() : registry?.backend
            registryReason = typeof registry?.storageError === 'function' ? registry.storageError() : undefined
          } catch (error) {
            registryBackend = '读取失败（' + String(error?.message ?? error) + '）'
          }
        }
        // ---- 后端一行化（2026-10-16 瘦身）----
        // 原来每种后端各占一段、还带一句图例（"storage = 宿主 storage 服务；file = 插件 JSON 回退"），
        // 每次 health 都重复，而它**永久留在会话里、之后每轮重发**。现在：
        //   - 正常（都是 storage）：压成一行，无图例；
        //   - 降级到 file：**照样完整点名 + 给出原因**（告警一个字都不省，这是插件的底线）。
        const shortBackend = String(ledgerBackend) + (registryBackend === undefined ? '' : '、' + String(registryBackend))
        backendLine = '\n\n账本/注册表后端：' + shortBackend + (shortBackend === 'storage、storage' ? '' : '（storage = 宿主服务；file = 本地 JSON 回退）')
        if (ledgerBackend === 'file' && fallbackReason !== undefined && fallbackReason !== null) {
          backendLine +=
            '\n\n⚠ **账本没有落在宿主 storage 领域，已退回 JSON 文件**：磁盘上的历史用量仍在 `~/.dsh/storages/mm_media_ledger.json`，' +
            '但报表读不到它，所以上面/下面的数字**不是全部历史**。原因：' +
            String(fallbackReason?.message ?? fallbackReason)
        }
        if (registryBackend === 'file' && registryReason !== undefined && registryReason !== null) {
          backendLine +=
            '\n\n⚠ **任务注册表没有落在宿主 storage 领域，已退回 JSON 文件**：提交过的任务仍能用 media_task(action=list) 找回，' +
            '但这些登记不进 storage 领域（换环境/清 home 就丢了）。原因：' +
            String(registryReason?.message ?? registryReason)
        }
        // 「谁能看图」是这套插件最容易被误配的语义（判错就有人瞎掉），所以放进报告。
        // 紧凑模式只留一行结论；判定快照（最近 5 条）与掩码注意事项放 verbose。
        const vision = typeof deps.visionStatus === 'function' ? deps.visionStatus() : undefined
        if (vision !== undefined) {
          const mark = (blocked) => (blocked ? '⛔' : '✅')
          backendLine +=
            '\n\n原生读图：主代理' + mark(vision.mainAgentBlocked) + ' 通用子代理' + mark(vision.subagentBlocked) +
            ' ｜ 读图员豁免：' + (vision.readerProviders.length > 0 ? vision.readerProviders.join(',') : '（无）') +
            '（契约 ' + vision.readerRouteDeclarations + ' 处）' +
            ' ｜ 掩码 ' + String(vision.maskedAgents ?? 0) + '/' + String(vision.knownAgents ?? 0)
          if (vision.readerRoutesUnknown) {
            backendLine += '\n⚠ **认不出任何读图员路由**：已放弃对子代理的原生读图屏蔽（fail-open），请检查契约文件。'
          }
          if (verbose) {
            // ⚠ 这行在 verbose 下**必须无条件下发**（它解释的是"掩码为什么可能不在"，
            // 与当前有没有判定记录无关；曾因放在 decisions 判空里而在测试环境消失）。
            backendLine += '\n\n（verbose）掩码只在 agent 创建时贴，重新装配后会丢 —— 行为层由 guard 兜底。'
            if (Array.isArray(vision.decisions) && vision.decisions.length > 0) {
              backendLine +=
                '\n最近的原生读图判定：\n' +
                vision.decisions
                  .map(
                    (row) =>
                      '· ' + (row.subagent ? '子代理' : '主代理') + (row.reader ? '（读图员）' : '') +
                      ' provider=' + String(row.provider) + ' model=' + String(row.model) +
                      ' → ' + (row.denied ? '已屏蔽 read_image' : '保留 read_image') +
                      (row.scope === undefined ? '' : ' ｜ ' + row.scope),
                  )
                  .join('\n')
            }
          }
        }
        return { report: report + backendLine }
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
