/**
 * media_report —— 成本估算 + 四把 key / 各条链路健康状态（规划 [2.5]）。
 *
 * action=cost  ：按用量账本 × 单价表给出预估费用（session | today | all），返回表格文本 + 免责声明。
 * action=health：四把 key 的配置状态 + 各条链路最近成功/失败 + 轻量连通性探测（5 分钟 TTL 缓存）。
 * 管理类能力合成一个工具，控制每请求固定 schema 成本。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CODES, MediaError } from '../core/errors.mjs'
import { KEY_SPECS, keySpec } from '../core/keys.mjs'
import { renderCostReport, renderHealthReport } from '../core/cost.mjs'
import { resolveOutDir } from '../core/deliver.mjs'

const PROBE_ADAPTERS = Object.freeze({
  dashscope: 'dashscope-image',
  'dashscope-vl': 'dashscope-image',
  ark: 'ark-video',
  minimax: 'minimax-video',
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

  /**
   * 今日批次分布（读 run_batch 落的 `batch/index.jsonl`）。
   *
   * 2026-11-11：判断"该不该开激进模式""提示词有没有效"，要看的是**批大小分布**，
   * 不是感觉。没有数据时返回空串——缺数据不是告警，不该占版面。
   * ⚠ `verbose` 必须当参数传进来：这个 helper 定义在 execute 之外，闭包里拿不到它
   * （初版就踩了 ReferenceError "verbose is not defined"，只有"今天有批次"时才暴露）。
   * @param {object} exec - 工具执行上下文（用来解析会话目录）。
   * @param {boolean} verbose - 是否输出直方图明细。
   * @returns {Promise<string>} 一行摘要（verbose 时多一行直方图）。
   */
  async function batchStatsLine(exec, verbose) {
    let text
    try {
      const outDir = typeof config?.outDir === 'string' && config.outDir.trim() !== '' ? config.outDir : 'gen'
      text = await readFile(join(resolveOutDir({ configValue: outDir, exec }), 'batch', 'index.jsonl'), 'utf8')
    } catch {
      return ''
    }
    const since = startOfToday(Date.now())
    const rows = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line)
        if (Number.isFinite(row?.at) && row.at >= since && Number.isFinite(row?.n)) rows.push(row)
      } catch {
        // 坏行忽略：索引是辅助数据，不能因为它让整个报告失败
      }
    }
    if (rows.length === 0) return ''
    const calls = rows.length
    const cmds = rows.reduce((sum, row) => sum + row.n, 0)
    const singles = rows.filter((row) => row.n === 1).length
    let out =
      '\n\n批量执行（今日）：' + calls + ' 次调用 / ' + cmds + ' 条命令 ｜ 单命令批次 ' + singles +
      ' 次（' + Math.round((singles / calls) * 100) + '%）' + (cmds > 0 ? ' ｜ 若逐条跑需 ' + cmds + ' 步' : '')
    if (verbose) {
      const hist = new Map()
      for (const row of rows) hist.set(row.n, (hist.get(row.n) ?? 0) + 1)
      out += '\n批大小分布：' +
        [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => 'N=' + n + '×' + c).join('、')
    }
    return out
  }

  async function probeOf(keyId, force = false) {    if (config.healthProbe === false) return undefined
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
        const extraConflictNotes = (switches?.conflictNotes?.() ?? []).filter((note) => note.includes('生视频模型'))
        const report = renderHealthReport({
          keyEntries,
          health,
          probes,
          llmProviders,
          config,
          switches: switches?.snapshot?.() ?? {},
          readerConflict: switches?.conflict?.() === true,
          extraConflictNotes,
          verbose,
        })
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
          // 本地 OCR（2026-10-30）：纯文字截图走它、不走读图员，所以"它开没开"同样属于
          // "谁能看图"的一部分，且它的可用性取决于系统 OCR 语言包（首次调用才暴露）。
          const ocrOn = typeof switches?.isEnabled === 'function' ? switches.isEnabled('ocr_image') === true : true
          backendLine += '\n本地 OCR：' + (ocrOn ? '✅ 开（Windows 引擎，不出网）' : '⛔ 关')
          // 读图回合闸门（2026-11-01）：闸门卡住时必须一眼看出"是在等谁"。
          // 紧凑模式只给状态与 pending（预算红线 2600 B），明细放 verbose。
          const gate = vision.turnGate
          if (gate !== undefined && gate !== null) {
            backendLine +=
              '\n读图闸门：' + (gate.enabled === false ? '⛔ 关' : '✅ 开') +
              ' ｜ 在等 ' + String(gate.pending ?? 0)
            if (verbose) {
              backendLine +=
                '（等待上限 ' + String(Math.round(Number(gate.timeoutMs ?? 0) / 1000)) + 's，已登记 ' +
                String(gate.known ?? 0) + ' 个'
              // 上次自动 OCR：tried=找到几张图（找到但失败也会记），ok=成功拿到文本几张。
              // 粘贴图的路径只在 image 块里——这行用来区分"没找到图"与"OCR 失败"。
              if (gate.lastAutoOcr !== undefined && gate.lastAutoOcr !== null) {
                backendLine += '；上次 OCR 找到 ' + String(gate.lastAutoOcr.tried ?? 0) +
                  ' 张/成功 ' + String(gate.lastAutoOcr.ok ?? 0) + ' 张'
              }
              backendLine += '）'
            }
          }
          if (vision.readerRoutesUnknown) {
            backendLine += '\n⚠ **认不出任何读图员路由**：已放弃对子代理的原生读图屏蔽（fail-open），请检查契约文件。'
          }
          if (verbose) {
            // ⚠ 这行在 verbose 下**必须无条件下发**（它解释的是"掩码为什么可能不在"，
            // 与当前有没有判定记录无关；曾因放在 decisions 判空里而在测试环境消失）。
            backendLine +=
              '\n\n（verbose）掩码在 agent 创建时贴；装配前就存在的会话会在下一次 pre-step 被"收养"并补上 —— 行为层另有 guard 兜底。'
            if (Array.isArray(vision.maskAudit) && vision.maskAudit.length > 0) {
              backendLine += '\n掩码对账（最近 ' + vision.maskAudit.length + ' 次）：\n' +
                vision.maskAudit
                  .map((row) =>
                    '· ' + (row.kind === 'subagent' ? '子代理' : '主代理') +
                    ' deny=' + String(row.deny ?? 0) +
                    ' restrict=' + (row.hasRestrict === true ? '有' : '无') +
                    ' → ' + String(row.outcome) +
                    (row.error === undefined ? '' : '：' + String(row.error)))
                  .join('\n')
            }
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
        backendLine += await batchStatsLine(exec, verbose)
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
