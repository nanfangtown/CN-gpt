/**
 * turn-gate —— 读图员的"回合闸门"。
 *
 * ## 要解决的问题（真实事故，2026-11-01 复盘）
 *
 * 主代理派出读图员 → 工具立刻返回 activation id → **模型在下一步就凭印象作答**，
 * 读图结论还在路上。后果：
 *   1. 违反"图像结论必须来自读图员"（它自己猜了一个产品名）；
 *   2. 用户先看到一条错答案，几秒后再看到一条"更正"；
 *   3. 整个 trace 里出现"我不用等读图员"的自我说服。
 *
 * ## 为什么闸门开在 `agent/pre-step`，而不是 `agent/turn-stopping`
 *
 * 宿主 `dsh-agent-loop` 的实际顺序是：
 *
 *     step()  ← assistant 文本在这里已经流式发出、已经入库
 *       ↓
 *     turn-stopping   ← 这时再拦，用户早就看见那条答案了
 *
 * 所以 turn-stopping 只能"补一条更正"，不能"不让他先说"。
 * 真正的咽喉在**下一步开始之前**：`agent/pre-step` 是 waterfall，preStep 不返回，
 * 模型就没有下一次开口的机会。把等待放在这里，模型在物理上无法抢答。
 *
 * ## 语义（只做三件事）
 *
 *   1. **join**：主 agent 的 pre-step 里，若有未完成的读图任务 → 等它结束（有超时，fail-open），
 *      并把结论并入本次 step 的 messages。模型第一次看到结果就是在它作答的那一步。
 *   2. **提醒**：本轮消息里带图、却一次读图/OCR 都没调用 → 注入一条机械提醒（每轮一次），
 *      这条不依赖模型自觉，也不改系统提示词。
 *   3. **收尾兜底**：在 turn-stopping 再等一次（防止最后一步才派图）；仍无证据则补一回合。
 *
 * ## 明确不碰的东西
 *
 * - 视频 / 出图 / 复杂工作流的异步完全不动：它们不登记在 readers 表里，闸门对它们零影响；
 * - 读图员自己、以及任何子代理：永不被闸（否则读图员会被自己的闸门卡死）；
 * - 工具语义、provider、model、delivery='parent' 一律不变。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 闸门注入消息的来源标记（会话日志里可检索）。 */
const GATE_SOURCE = 'mm-models-turn-gate'

/** 有图未取证时的机械提醒。 */
const REMIND_TEXT = [
  '⛔ 读图闸门（机械注入，不是模型判断）：本轮消息里带了图片，但你还没有取得任何读图证据。',
  '在调用 ask_qwen / ask_glm（画面、版式、界面归属）或 ocr_image（纯文字截图）之前：',
  '- 不要描述图片内容；',
  '- 不要推断它属于哪个产品 / 哪个网站 / 什么界面；',
  '- 不要用"上下文里已经有图"代替证据——主代理的原生读图是被屏蔽的。',
  '取到证据之后再作答；证据不支持的部分写"待确认"。',
].join('\n')

/** 收尾时仍无证据的提醒。 */
const FORCE_TEXT = [
  '⛔ 读图闸门：这一轮里带了图片，但整轮没有任何读图证据（没有 ask_qwen / ask_glm / ocr_image 的结果）。',
  '请现在先取证据，再重新作答；不要重复上一版里没有证据支持的图像断言。',
].join('\n')

/** 取回读图结论时的标题。 */
const RESULT_HEADER = '[读图闸门] 以下结论由读图员在你作答之前返回，是强制取回的原始结论（不是你的记忆）：'

/** 超时提示。 */
const TIMEOUT_TEXT = '[读图闸门] 等待读图员超时，结论未取回。与这张图相关的内容请写"待确认"，不要补全。'

/** 自动 OCR 注入时的标题：说清它是什么、不是什么。 */
const AUTO_OCR_HEADER = [
  '【本地 OCR 原文 · 自动执行 · 未出网 · 可能有错字/漏行】',
  '这是"字"，不是"理解"：画面、版式、产品/界面归属仍然要派 ask_qwen；',
  '证据不支持的结论写"待确认"，不要用想象补全。',
].join('\n')

/** 默认等待上限（毫秒）。读图员通常 5–40s，90s 足够且不至于把回合钉死。 */
const DEFAULT_TIMEOUT_MS = 90000

/**
 * 创建闸门。
 *
 * @param {object} deps
 * @param {object} deps.ctx      - Cordis 上下文（用于 ctx.on）。
 * @param {object} deps.logger   - 插件 logger。
 * @param {object} deps.liveConfig - 实时配置 Proxy。
 * @param {(agent: unknown) => boolean} deps.isSubagent - 插件的子代理判定。
 * @param {(agent: unknown) => boolean} deps.isReader   - 插件的读图员判定。
 * @returns {{ noteReaderStarted: (agent: unknown, childId: string) => void, noteEvidence: (agent: unknown) => void, snapshot: () => object }}
 */
export function createTurnGate(deps) {
  const { ctx, logger, liveConfig, isSubagent, isReader, autoOcr } = deps

  /** childId → { parent, startedAt, ended, output, stopReason, consumed }。 */
  const readers = new Map()
  /** 最近一次自动 OCR 的结果（可观测：为什么注入/为什么没注入）。 */
  let lastAutoOcr
  /** agent → 每轮状态。 */
  const states = new WeakMap()

  const enabled = () => liveConfig?.readerGate !== false
  const hintOn = () => liveConfig?.readerGateImageHint !== false
  const forceOn = () => liveConfig?.readerGateForceEvidence !== false
  const autoOcrOn = () => liveConfig?.autoOcrOnImage !== false
  const timeoutMs = () => {
    const value = Number(liveConfig?.readerGateTimeoutMs)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
  }

  const stateOf = (agent) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        turn: -1,
        imageTurn: -1,
        evidenceTurn: -1,
        remindedTurn: -1,
        forcedTurn: -1,
        ocrTurn: -1,
      }
      states.set(agent, state)
    }
    return state
  }

  const safeIsSubagent = (agent) => {
    try { return isSubagent(agent) === true } catch { return true }
  }
  const safeIsReader = (agent) => {
    try { return isReader(agent) === true } catch { return false }
  }
  /** 闸门只对"主 agent"生效；判不出来时按子代理处理（宁可不拦）。 */
  const gated = (agent) => agent !== undefined && agent !== null && !safeIsSubagent(agent) && !safeIsReader(agent)

  // 不要 unref 这个定时器：等待期间进程必须保持活跃（否则测试/CLI 场景下
  // 顶层 await 会永远悬着）。200ms 的轮询开销可以忽略。
  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

  /** 该 agent 名下还没结束的读图任务。 */
  const pendingOf = (agent) => {
    const list = []
    for (const [childId, record] of readers) {
      if (record.parent !== agent) continue
      if (record.ended === true) continue
      list.push(childId)
    }
    return list
  }

  /**
   * 从消息文本或图片块还原本地图片路径。
   *
   * 三个来源：
   *   ① 普通路径 + 图片后缀；
   *   ② `.dsh/attachments/v1/objects/xx/<sha>`（文本里出现时）；
   *   ③ **图片块本身**：`{type:'image', attachment:{attachmentId:'sha256:<hex>'}}`。
   *
   * ③ 是 2026-11-01 从会话日志里挖出来的：粘贴图的本地路径**不在消息文本里**——
   * 模型看到的那行 "Normalized copy …" 是渲染层补的，原始 content 只有 image 块 + 一句用户话。
   * 所以只扫文本的版本在真实粘贴图上永远拿不到路径（自动 OCR 静默失效，退回提醒）。
   * 附件对象固定在 `<DSH_HOME>/attachments/v1/objects/<前两位>/<hex>`，直接拼即可。
   */
  function imagePathsIn(messages) {
    const EXT_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|）)]+?\.(?:png|jpe?g|webp|gif|bmp|tiff?)/gi
    const ATTACH_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|）)]*?[\\/]attachments[\\/]v1[\\/]objects[\\/][0-9a-f]{2}[\\/][0-9a-f]{16,}/gi
    const found = new Set()
    for (const message of messages ?? []) {
      const content = message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'image') {
          const resolved = attachmentPathOf(block)
          if (resolved !== undefined) found.add(resolved)
          continue
        }
        if (block?.type !== 'text' || typeof block.text !== 'string') continue
        for (const pattern of [EXT_PATH, ATTACH_PATH]) {
          for (const match of block.text.match(pattern) ?? []) found.add(match)
        }
      }
    }
    return [...found].slice(0, 3)
  }

  /** `sha256:<hex>` → 附件对象路径；认不出返回 undefined。 */
  function attachmentPathOf(block) {
    const id = block?.attachment?.attachmentId
    if (typeof id !== 'string') return undefined
    const hex = (id.startsWith('sha256:') ? id.slice(7) : id).toLowerCase()
    if (!/^[0-9a-f]{32,}$/.test(hex)) return undefined
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    return join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
  }

  /**
   * 自动 OCR：本地、免费、同步。失败一律忽略（闸门不因为 OCR 坏了而卡住）。
   * 返回值带上 `tried`：让"为什么没注入"变成可观测事实，而不是只在日志里。
   */
  async function autoOcrTexts(messages, signal) {
    if (typeof autoOcr !== 'function') return { texts: [], tried: 0 }
    const paths = imagePathsIn(messages)
    const texts = []
    for (const imagePath of paths) {
      try {
        const result = await autoOcr(imagePath, signal)
        if (result !== null && result !== undefined && result.weak !== true
          && typeof result.text === 'string' && result.text.trim().length > 0) {
          texts.push(result.text.trim())
        }
      } catch (error) {
        logger?.debug?.('[mm-models] turn-gate 自动 OCR 失败（已忽略）：' + String(error?.message ?? error))
      }
    }
    return { texts, tried: paths.length }
  }

  /** 等待该 agent 的读图任务全部结束。 */
  async function waitFor(agent, signal) {
    const deadline = Date.now() + timeoutMs()
    while (pendingOf(agent).length > 0) {
      if (signal?.aborted === true) return 'aborted'
      if (Date.now() >= deadline) return 'timeout'
      await sleep(200)
    }
    // 收尾消息（delivery）可能比 subagent/end 晚一拍落地，给一个极短的收敛窗口。
    await sleep(20)
    return 'settled'
  }

  // ------------------------------------------------------------------ 消息

  let llmModule
  async function loadLlm() {
    if (llmModule !== undefined) return llmModule
    try {
      llmModule = await import('@deepseek-ai/dsh-llm')
    } catch (error) {
      llmModule = null
      logger?.debug?.('[mm-models] turn-gate 无法加载 dsh-llm，退回手搓消息：' + String(error?.message ?? error))
    }
    return llmModule
  }

  /**
   * 造一条"闸门通知"消息。
   *
   * 优先用宿主 `createUserMessage`（带 brand id / deepFreeze，与宿主消息完全同形）；
   * 宿主包不可解析时退回手搓对象，字段保持一致（id 用随机串，宿主只当普通字符串用）。
   */
  async function makeNotice(text, summary) {
    const content = [{ type: 'text', text }]
    const source = { kind: GATE_SOURCE, form: 'notice', summary: String(summary).slice(0, 120) }
    const llm = await loadLlm()
    try {
      if (llm !== null && typeof llm.createUserMessage === 'function') {
        return llm.createUserMessage({ content, source })
      }
    } catch (error) {
      logger?.warn?.('[mm-models] turn-gate 造消息失败，退回手搓：' + String(error?.message ?? error))
    }
    return {
      id: 'mm-gate-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      role: 'user',
      content,
      source,
    }
  }

  // ------------------------------------------------------------ 证据与状态

  /** 读图员成功派出 = 取证开始（也用于"有图未取证"判定）。 */
  const noteReaderStarted = (agent, childId) => {
    if (typeof childId !== 'string' || childId.length === 0) return
    if (agent === undefined || agent === null) return
    readers.set(childId, {
      parent: agent,
      startedAt: Date.now(),
      ended: false,
      output: '',
      stopReason: undefined,
      consumed: false,
    })
    const state = stateOf(agent)
    if (state.turn >= 0) state.evidenceTurn = state.turn
  }

  /** 任何读图 / OCR 成功调用都可以记为"本轮已有证据"。 */
  const noteEvidence = (agent) => {
    if (agent === undefined || agent === null) return
    const state = stateOf(agent)
    if (state.turn >= 0) state.evidenceTurn = state.turn
  }

  ctx.on('subagent/end', (info) => {
    const childId = info?.id
    if (typeof childId !== 'string') return
    const record = readers.get(childId)
    if (record === undefined) return
    record.ended = true
    record.stopReason = info?.stopReason
    record.output = typeof info?.lastAssistantMessage === 'string' ? info.lastAssistantMessage : ''
  })

  // ----------------------------------------------------------- 宿主钩子

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    for (const [childId, record] of readers) {
      if (record.parent === agent) readers.delete(childId)
    }
  })

  /**
   * 主闸：下一步开始前。
   *
   * 顺序：先让下游算出默认 decision（next()），再在其 messages 上追加闸门内容。
   * 任何异常都放行（fail-open）——闸门坏了不能把整个 agent 卡死。
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    let base
    try {
      base = await next()
    } catch (error) {
      throw error
    }
    try {
      return await gateStep(payload, base)
    } catch (error) {
      logger?.warn?.('[mm-models] turn-gate pre-step 异常（已放行）：' + String(error?.message ?? error))
      return base
    }
  })

  async function gateStep(payload, base) {
    if (!enabled()) return base
    const agent = payload?.agent
    if (!gated(agent)) return base
    if (base?.kind !== 'enter' || !Array.isArray(base.messages)) return base

    const state = stateOf(agent)
    if (Number.isInteger(payload?.turn)) state.turn = payload.turn

    const hasImage = messagesHaveImage(base.messages) || sessionHasImage(agent)
    if (hasImage) state.imageTurn = state.turn

    // 零号条件（2026-11-01）：有图 → 先在本地把"字"抄一遍（免费、0.4s、同步）。
    // 这一步**不需要模型决定**，所以不会出现"为了省事直接派读图员"。
    if (hasImage && autoOcrOn() && state.ocrTurn !== state.turn && state.evidenceTurn !== state.turn) {
      const ocr = await autoOcrTexts(base.messages, payload?.signal)
      lastAutoOcr = { turn: state.turn, tried: ocr.tried, ok: ocr.texts.length }
      if (ocr.texts.length > 0) {
        state.ocrTurn = state.turn
        state.evidenceTurn = state.turn
        logger?.info?.('[mm-models] turn-gate：已自动 OCR ' + ocr.texts.length + ' 张图（turn=' + state.turn + '）')
        const note = await makeNotice(
          AUTO_OCR_HEADER + '\n\n' + ocr.texts.join('\n\n—\n\n'),
          '本地 OCR 自动预读（' + ocr.texts.length + ' 张）',
        )
        return { ...base, messages: [...base.messages, note] }
      }
      state.ocrTurn = state.turn
    }

    // 条件一：本轮有图，却还没取证 → 机械提醒（每轮一次）
    if (hintOn() && hasImage && state.evidenceTurn !== state.turn && state.remindedTurn !== state.turn) {
      state.remindedTurn = state.turn
      const note = await makeNotice(REMIND_TEXT, '本轮有图，尚未读取图/OCR')
      logger?.info?.('[mm-models] turn-gate：本轮含图片且无证据，已注入提醒（turn=' + state.turn + '）')
      return { ...base, messages: [...base.messages, note] }
    }

    // 条件二：读图员还在跑 → 本步先不开工
    if (pendingOf(agent).length === 0) return base
    const pending = pendingOf(agent).length
    const outcome = await waitFor(agent, payload?.signal)
    const notes = await collectResults(agent)
    if (outcome === 'timeout') {
      logger?.warn?.('[mm-models] turn-gate：等待读图员超时（' + timeoutMs() + 'ms，pending=' + pending + '），已放行本步')
      notes.push(await makeNotice(TIMEOUT_TEXT, '读图等待超时'))
    } else if (outcome === 'settled') {
      logger?.info?.('[mm-models] turn-gate：读图结论已在作答前取回（turn=' + state.turn + '）')
    }
    if (notes.length === 0) return base
    return { ...base, messages: [...base.messages, ...notes] }
  }

  /**
   * 收尾兜底。
   *
   * 这一步拦不住"答案已经发出去"（宿主先 step 后 turn-stopping），但能拦住"回合结束"：
   * 等待结束后 delivery 落回 inbox，loop 看到 nextStep 非空会再走一步，模型得以更正。
   */
  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      if (!enabled()) return
      const agent = payload?.agent
      if (!gated(agent)) return
      const state = stateOf(agent)
      if (Number.isInteger(payload?.turn)) state.turn = payload.turn

      if (pendingOf(agent).length > 0) {
        const outcome = await waitFor(agent, payload?.signal)
        if (outcome === 'timeout') {
          logger?.warn?.('[mm-models] turn-gate：收尾等待读图员超时（' + timeoutMs() + 'ms），已放行')
        }
      }

      if (
        forceOn()
        && state.imageTurn === payload?.turn
        && state.evidenceTurn !== payload?.turn
        && state.forcedTurn !== payload?.turn
      ) {
        state.forcedTurn = payload?.turn
        const note = await makeNotice(FORCE_TEXT, '本轮有图但无读图证据')
        if (injectMessage(agent, note)) {
          logger?.warn?.('[mm-models] turn-gate：本轮含图却无证据，已拒绝收尾并插入纠正回合')
        }
      }
    } catch (error) {
      logger?.warn?.('[mm-models] turn-gate turn-stopping 异常（已放行）：' + String(error?.message ?? error))
    }
  })

  // ------------------------------------------------------------- 小工具

  function injectMessage(agent, message) {
    try {
      if (typeof agent?.inject === 'function') {
        agent.inject(message)
        return true
      }
      if (typeof agent?.steer === 'function') {
        agent.steer(message)
        return true
      }
    } catch (error) {
      logger?.warn?.('[mm-models] turn-gate 注入失败：' + String(error?.message ?? error))
    }
    return false
  }

  /**
   * 取回结论：优先把 delivery 已经落进 inbox 的消息原样并入（零重复），
   * 落点不是 next-step 时退回用 `subagent/end` 捕获的原文自建一条。
   */
  async function collectResults(agent) {
    const notes = []
    const drained = drainInbox(agent)
    for (const message of drained) notes.push(message)

    const finished = []
    for (const entry of readers) {
      const [childId, record] = entry
      if (record.parent !== agent) continue
      if (record.ended !== true || record.consumed === true) continue
      finished.push([childId, record])
    }
    if (finished.length === 0) return notes

    // 取出即销账：已并入的读图记录不再参与 pending 判定，也不会越积越多。
    for (const [childId] of finished) readers.delete(childId)
    if (drained.length > 0) return notes

    const lines = finished.map(([childId, record]) => {
      if (typeof record.output === 'string' && record.output.trim().length > 0) return record.output.trim()
      return '（读图员 ' + childId + ' 未返回内容，stopReason=' + String(record.stopReason ?? 'unknown') + '）'
    })
    notes.push(await makeNotice(RESULT_HEADER + '\n\n' + lines.join('\n\n—\n\n'), '读图结论已取回'))
    return notes
  }

  /** 把已经落进 next-step 的 delivery 取出来并入本步（避免重复喂给模型）。 */
  function drainInbox(agent) {
    try {
      const inbox = agent?.inbox
      if (inbox === undefined || inbox === null) return []
      const nextStep = inbox.nextStep
      if (!Array.isArray(nextStep) || nextStep.length === 0) return []
      const fresh = [...nextStep]
      if (typeof inbox.splice === 'function') inbox.splice('next-step', 0, fresh.length, [])
      return fresh
    } catch (error) {
      logger?.debug?.('[mm-models] turn-gate 取 inbox 失败：' + String(error?.message ?? error))
      return []
    }
  }

  function messagesHaveImage(messages) {
    if (!Array.isArray(messages)) return false
    return messages.some((message) => {
      const content = message?.content
      if (Array.isArray(content)) return content.some((block) => block?.type === 'image')
      if (typeof content === 'string') return content.includes('image')
      return false
    })
  }

  /** 兜底判据：会话日志里最后一条用户消息是否带图（图片被宿主投影成文本时用）。 */
  function sessionHasImage(agent) {
    try {
      const log = agent?.session?.log
      if (!Array.isArray(log) || log.length === 0) return false
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const entry = log[index]
        if (entry?.type !== 'user/message') continue
        const content = entry?.data?.content
        return Array.isArray(content) && content.some((block) => block?.type === 'image')
      }
      return false
    } catch {
      return false
    }
  }

  return {
    noteReaderStarted,
    noteEvidence,
    snapshot: () => ({
      enabled: enabled(),
      timeoutMs: timeoutMs(),
      pending: [...readers.values()].filter((record) => record.ended !== true).length,
      known: readers.size,
      // 最近一轮自动 OCR：tried=找到几张图、ok=成功注入几张。
      // 2026-11-01 加：粘贴图的路径只存在于 image 块里，扫文本会静默失败——
      // 有这行，下一次就能一眼看出"是没找到图"还是"OCR 失败"。
      lastAutoOcr,
    }),
  }
}
