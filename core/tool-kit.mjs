/**
 * 工具层共用小件：调用预算、会话 id、状态失败 → MediaError。
 *
 * maxCallsPerTurn（规划 [8.2]）的语义：同一会话内连续生成调用超过上限即拒绝；
 * 距上一次生成调用超过 60 秒视为新一轮（v1 的轻量实现，不订阅会话事件）。
 * 0 表示不限制。
 */
import { CODES, MediaError, classifyVendorFailure, clip, fixedMessage } from './errors.mjs'

/** 一次生成调用的软预算。 */
export function createCallBudget(config) {
  const limit = Number(config?.maxCallsPerTurn ?? 0)
  const sessions = new Map()
  /**
   * 空闲重置窗口：距上次生成超过它就视为"新的一轮"，计数清零。
   *
   * 三个名字的来历（2026-10-14）：
   *   - `callBudgetIdleResetMs` 是**配置字段名**（用户在配置卡里改的就是它）；
   *   - `idleResetMs` 是测试的注入口（直接调 createCallBudget 时传）；
   *   - 60 秒是历史默认值，现已提到配置层，默认 **25 秒**。
   *
   * 它同时决定超限文案里"请等待约 N 秒"的 N —— 秒数由同一个值算出，改一处两边一起变。
   */
  const idleResetMs = Number(config?.callBudgetIdleResetMs ?? config?.idleResetMs ?? 25_000)
  /**
   * 惰性清扫阈值：会话数超过它时，顺手把已过期的会话删掉。
   * `take()` 里每个会话本来就会重置自己的计时，但**再也不会被调用的会话**
   * 永远不会离开 Map（早期版本没有这一步，等于按会话数缓慢泄漏）。
   * 用「超过阈值才扫」而不是每次都扫，把成本摊薄成 O(1) 均摊。
   */
  const sweepThreshold = 64
  const prune = (now) => {
    if (sessions.size <= sweepThreshold) return
    for (const [key, entry] of sessions) {
      if (now - entry.lastAt > idleResetMs) sessions.delete(key)
    }
  }
  return {
    limit,
    /**
     * @returns {{ ok: boolean, count?: number, limit?: number, resetInMs?: number }}
     */
    take(sessionId) {
      if (!Number.isFinite(limit) || limit <= 0) return { ok: true }
      const now = Date.now()
      const key = sessionId ?? 'unknown'
      prune(now)
      const entry = sessions.get(key)
      if (entry === undefined || now - entry.lastAt > idleResetMs) {
        sessions.set(key, { count: 1, lastAt: now })
        return { ok: true, count: 1, limit }
      }
      if (entry.count >= limit) {
        return { ok: false, count: entry.count, limit, resetInMs: Math.max(0, idleResetMs - (now - entry.lastAt)) }
      }
      entry.count += 1
      entry.lastAt = now
      return { ok: true, count: entry.count, limit }
    },
    /** 仅供测试与诊断：当前记账中的会话数。 */
    size: () => sessions.size,
  }
}

/** 取调用会话 id（不同 harness 版本字段可能不同，做兼容读取）。 */
export function sessionIdOf(exec) {
  const session = exec?.agent?.session
  return session?.id ?? session?.header?.id ?? undefined
}

/** 预算拒绝的固定文案。 */
export function budgetMessage(info) {
  const seconds = Math.max(1, Math.ceil((info.resetInMs ?? 0) / 1000))
  return `本轮生成调用已达上限（${info.limit} 次）：这是 maxCallsPerTurn 的保护。请等待约 ${seconds} 秒后再试，或在 插件页 → gpt-CN → 配置卡 调整 maxCallsPerTurn（0 = 不限制）。`
}

/** 终态失败 → 抛给模型的人话错误。 */
export function stateFailureToError(state, { adapter, providerLabel, ref }) {
  const code = classifyVendorFailure(state.error)
  const detail = state.error === undefined ? `rawStatus=${state.rawStatus ?? 'unknown'}` : `${state.error.code}: ${clip(state.error.detail, 200)}`
  return new MediaError(code, fixedMessage(code, { provider: providerLabel, ref, detail }), {
    vendorCode: state.error?.code,
    detail,
  })
}

/** 把任意异常收敛成 MediaError（工具 execute 的最外层 catch 用）。 */
export function asMediaError(error, info) {
  if (error instanceof MediaError) return error
  return new MediaError(CODES.UNKNOWN, fixedMessage(CODES.UNKNOWN, { ...info, detail: clip(String(error?.message ?? error)) }), { cause: error })
}

/**
 * 工具开关（插件页 → gpt-CN → 配置卡 里的复选框，一键设置）。
 *
 * 语义：
 *   - guard（全局、同步、读实时配置）：关闭后任何 agent 调用该工具都会被拒，立即生效；
 *   - agent/created 时按当前开关做 restrict：新会话/新子代理的工具清单里直接不出现；
 *     已存在的会话仍会显示工具，但调用会被 guard 拒绝。
 */
export const TOOL_SWITCHES = Object.freeze([
  Object.freeze({ tool: 'ask_glm', field: 'enableAskGlm', capability: 'ask_glm', label: 'GLM 读图子代理' }),
  Object.freeze({ tool: 'ask_qwen', field: 'enableAskQwen', capability: 'ask_qwen', label: 'Qwen 读图子代理' }),
  Object.freeze({ tool: 'qwen_draw', field: 'enableQwenDraw', capability: 'qwen_draw', label: 'Qwen 制图' }),
  Object.freeze({ tool: 'seedance_video', field: 'enableSeedanceVideo', capability: 'seedance_video', label: 'Seedance 出片' }),
  Object.freeze({ tool: 'media_task', field: 'enableMediaTask', capability: 'media_task', label: '任务重查/补下载' }),
  Object.freeze({ tool: 'media_report', field: 'enableMediaReport', capability: 'media_report', label: '成本/健康报告' }),
])

/**
 * 创建开关读取器（config 是 volatile Proxy，每次读取都是当前值）。
 * @param {object} config - 插件上下文里的 liveConfig。
 */
export function createSwitches(config) {
  // 六个工具 → 配置字段的查表改成一次性构建的 Map：
  // disabledNames() 在**每秒对账**里被调用，原来每个工具都要 find() 扫一遍数组。
  const specByField = new Map(TOOL_SWITCHES.map((entry) => [entry.tool, entry]))
  const specOf = (tool) => specByField.get(tool)
  /**
   * 原始开关值（未做互斥仲裁）。
   * seedance_video / ask_glm / ask_qwen 默认关（未接通或需用户二选一）；其余默认开。
   */
  const rawOf = (tool) => {
    const spec = specOf(tool)
    if (spec === undefined) return true
    const value = config?.[spec.field]
    if (spec.tool === 'seedance_video' || spec.tool === 'ask_glm' || spec.tool === 'ask_qwen') return value === true
    return value !== false
  }
  /** 两个读图子代理同时开启：GLM 优先，ask_qwen 被压制。 */
  const conflict = () => rawOf('ask_glm') && rawOf('ask_qwen')
  const isEnabled = (tool) => {
    const raw = rawOf(tool)
    if (!raw) return false
    if (tool === 'ask_qwen' && rawOf('ask_glm')) return false
    return true
  }
  return {
    isEnabled,
    conflict,
    /** 关闭的工具名列表（用于 restrict）。 */
    disabledNames: () => TOOL_SWITCHES.filter((entry) => !isEnabled(entry.tool)).map((entry) => entry.tool),
    /** 能力 → 开关状态（用于 health 报表）。 */
    snapshot: () => Object.fromEntries(TOOL_SWITCHES.map((entry) => [entry.capability, isEnabled(entry.tool)])),
    /**
     * 六个开关的即时签名（`"1,0,1,…"`），用于**廉价判断"配置有没有变"**。
     *
     * 用途：`syncRestrictions()` 每秒跑一次，会话多时"逐个 agent 重算掩码"是纯浪费
     * （实测 1000 个会话 2.3 ms/秒）。有了签名，开关没变的那一秒可以整轮跳过，
     * 只付 6 次配置读取的固定成本（≈0.002 ms），与会话数无关。
     *
     * 为什么用字符串而不是数组：比较两个字符串是 O(1) 语义、无分配；
     * 而每次 `disabledNames()` 都要新分配一个数组，1 秒 1000 次就是 1000 个垃圾对象。
     * @returns {string} 例如 '1,0,1,1,1,1'
     */
    signature: () => TOOL_SWITCHES.map((entry) => (isEnabled(entry.tool) ? '1' : '0')).join(','),
    /** guard 拒绝时给模型/用户看的人话。 */
    disabledMessage(tool) {
      if (tool === 'ask_qwen' && conflict()) {
        return 'ask_qwen 与 ask_glm 互斥：两个读图子代理不能同时开启，当前 ask_glm 生效、ask_qwen 被停用。请在 插件页 → gpt-CN → 配置卡 关闭 ask_glm（打开 ask_qwen 会自动关闭它），或继续使用 ask_glm。'
      }
      if (tool === 'ask_glm' && conflict()) {
        return 'ask_glm 与 ask_qwen 互斥：两个读图子代理不能同时开启，当前 ask_qwen 生效、ask_glm 被停用。请在 插件页 → gpt-CN → 配置卡 关闭 ask_qwen（打开 ask_glm 会自动关闭它），或继续使用 ask_qwen。'
      }
      const spec = specOf(tool)
      const label = spec?.label ?? tool
      return '已关闭：' + tool + '（' + label + '）在 插件页 → gpt-CN → 配置卡 的开关里处于关闭状态。请不要重试；需要时请让用户打开该开关。'
    },
  }
}

/**
 * 互斥开关对：同一时刻只允许一个为真（规划 [2.2]）。
 * ask_glm / ask_qwen 都是"读图子代理"，同时挂两个只会让主模型无所适从，故二选一。
 */
export const MUTEX_PAIRS = Object.freeze([Object.freeze({ a: 'enableAskGlm', b: 'enableAskQwen' })])

/**
 * 把一组配置写入操作按互斥规则归一化，保证"同一时刻只有一个读图子代理"。
 *
 * 语义（与设置卡一致）：**最后写入者胜出**。打开一个开关的同一个批量写入里，
 * 若另一个仍是 true，就补一条把它关掉的 set。补出来的 set 排在触发它的 set
 * 之后，所以同一个 patch 里两者都被显式赋值时，以靠后的那次为准（不做"报错
 * 拒绝"，避免用户的保存莫名其妙失败）。
 *
 * @param {Array<{op: string, path: (string|number)[], value?: unknown}>} ops - 原始写入操作。
 * @returns {Array} 归一化后的新数组（不修改入参）。
 */
export function normalizeSettingsOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return Array.isArray(ops) ? ops : []
  /** 正在生效的开关值：末次写入胜出。 */
  const effective = new Map()
  const ordered = []
  const pushComplement = (name, value) => {
    if (effective.get(name) === value) return
    effective.set(name, value)
    ordered.push({ op: 'set', path: [name], value })
  }
  for (const op of ops) {
    if (op === null || typeof op !== 'object') {
      ordered.push(op)
      continue
    }
    const name = Array.isArray(op.path) ? op.path[0] : undefined
    if (op.op !== 'set' || typeof name !== 'string') {
      ordered.push(op)
      continue
    }
    // unset（删除用户层字段，回落默认值 = 关）同样让出互斥位。
    effective.set(name, op.value)
    ordered.push(op)
    for (const pair of MUTEX_PAIRS) {
      if (pair.a === name && op.value === true) pushComplement(pair.b, false)
      else if (pair.b === name && op.value === true) pushComplement(pair.a, false)
    }
  }
  return ordered
}
