/**
 * 读图子代理的 token 计量（2026-10-17）。
 *
 * == 为什么存在 ==
 * `media_report(cost)` 里长期挂着一句自曝：「读图子代理（ask_glm / ask_qwen）的 token
 * **未计入本报表**」，理由是「DSH 只在工具层给插件留了钩子，**没有请求级钩子**」。
 *
 * 该结论在 **0.2.0-rc.2 已不成立**。实测 `@deepseek-ai/dsh-llm/lib/index.js`：
 *
 *     streamWithRegistration(options, prepared) {
 *       return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
 *     }
 *
 * 而 cordis 的 `dispatch()` 会把开头的 service 剥成 `this`：
 *
 *     const thisArg = typeof args[0] === 'object' ... ? args.shift() : null
 *     const name = args.shift()
 *     ... hook.callback.bind(thisArg)
 *
 * 所以插件订阅 `ctx.on('llm/stream', function (options, next) { ... })` 即可拿到
 * 完整请求对象与 `next`，**并包住返回的流** → 观察 `usage` 分片。
 * 协议顺序（`dsh-llm` README §不变式）：`usage` 先于终止 `finish`。
 *
 * == 边界（刻意收窄）==
 * 1. **只记读图员的 provider**（默认 glm / qwen-vl）。主代理与其它子代理的 token
 *    由宿主自己计量，本插件重复记账只会把报表弄脏。
 * 2. **只包一个异步生成器**，分片原样 `yield` 转发，不检查/不改写流本身。
 * 3. **任何异常都不许影响这次模型调用**：观察是旁路，坏掉最多少一条账。
 * 4. 环缓冲有上限：读图调用会长期累积，无界数组迟早吃满内存。
 *
 * == 为什么按 provider 归因 ==
 * 读图员的 provider 是**专属**的（glm / qwen-vl 在配置里只挂给读图子代理），
 * 所以 provider 足以把这三类调用分辨开——这是**证据支持的归因**，不是猜测。
 *
 * == 会话归属（2026-10-17 修）==
 * 这里原本写着"`llm/stream` 的 options 里没有 sessionId"，据此**不写** sessionId。
 * 但宿主契约里 `options.sessionId` 是存在的 —— dsh 自己的不变量检查就写着
 * 「a loop-built request must carry a session id」，并会 `ctx.sessions.get(options.sessionId)`。
 * 旧结论已不成立，而它的代价是实测出来的：**没有 sessionId 的记录会被"本会话已花多少"
 * 按会话过滤掉**，于是读图花费对会话累计上限永远不可见（账本记了账，闸门却瞎）。
 * 现在：拿到就写、拿不到就**不写这个字段**（不是写 undefined，更不是编一个 id）——
 * 既不伪造归属，也不放弃真实归属。
 */

/** 账本里的 adapter 标识（与 dashscope-image / ark-video 并列）。 */
export const READER_ADAPTER = 'llm-reader'

/** 默认认作"读图员"的 provider id。 */
export const DEFAULT_READER_PROVIDERS = Object.freeze(['glm', 'qwen-vl'])

/** 从 usage 分片里取 token 数。字段名依据 token-meter 的 `usageTokens()`：
 *  `inputTokens + cacheReadTokens? + cacheWriteTokens? + outputTokens`。 */
export function tokensOf(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)
  const input = usage.inputTokens
  const output = usage.outputTokens
  // 两个主桶都缺 → 这不是一个可用的 usage 分片，别硬凑。
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null
  return {
    input: num(input),
    output: num(output),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
  }
}

/** 从一次请求的 options 里取 provider / model（两者都可能是 undefined）。 */
export function routeOf(options) {
  if (options === null || typeof options !== 'object') return { provider: undefined, model: undefined }
  const provider = options.provider
  const model = options.model
  const route = {
    provider: typeof provider === 'string' ? provider : undefined,
    model: typeof model === 'string' ? model : undefined,
  }
  // 会话归属（见文件头「会话归属」）：拿到才加键。不加 `sessionId: undefined`——
  // 那会让现有调用方与断言为一个本就不存在的字段买单，也更容易被误读成"归属已确定"。
  const sessionId = options.sessionId
  if (typeof sessionId === 'string' && sessionId.length > 0) route.sessionId = sessionId
  return route
}

/**
 * 包一个返回"异步可迭代流"的函数，在流里观察 usage 分片。
 *
 * 返回的是**包装函数**而不是流本身：调用方拿到的是同一个流的转发，
 * 分片对象原样透出（不做拷贝、不做校验），`return()`/`throw()` 语义由 `for await` 保持。
 *
 * @param {() => unknown} produce 产出流的函数（waterfall 的 next）。
 * @param {(chunk:object)=>void} onUsage 看到 usage 分片时回调（内部已 try 包裹）。
 * @returns {AsyncGenerator} 转发流。
 */
export async function* observeStream(produce, onUsage) {
  const stream = await produce()
  for await (const chunk of stream) {
    try {
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
        onUsage(chunk)
      }
    } catch {
      // 观察失败绝不能影响这次调用。
    }
    yield chunk
  }
}

/**
 * 创建读图用量记录器。
 *
 * @param {object} deps
 * @param {string[]} [deps.providers] 认作读图员的 provider（默认 glm / qwen-vl）。
 * @param {(record:object)=>Promise<void>|void} deps.record 落账回调（由 index.js 接到账本）。
 * @param {(model:string)=>object|null} [deps.resolvePrice] 按**模型 id** 解析单价（从单价表）。
 *   为什么不按 provider：单价表的键是模型 id（`glm-4.6v`），而 route.provider 是路由名
 *   （`glm`），两者不相等——按 provider 查必然查空。
 * @param {(msg:string)=>void} [deps.warn] 日志。
 * @param {number} [deps.maxEntries] 环缓冲上限（仅用于报表展示，落账不依赖它）。
 */
export function createReaderUsageMeter(deps) {
  const {
    providers = DEFAULT_READER_PROVIDERS,
    record,
    resolvePrice,
    warn = () => {},
    maxEntries = 200,
  } = deps
  const readerProviders = new Set(providers)

  /** 已观测到的用量（有界）。仅用于报表摘要；账本才是权威。 */
  const entries = []
  let observed = 0

  /** 一次 usage 分片 → 一条账本记录（或 null 表示不该记）。 */
  function toRecord(route, tokens) {
    const units = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
    if (units <= 0) return null
    const model = route.model ?? 'unknown'
    // 单价在**落账时**解析并写进记录：账本因此自包含（单价表日后改价不会篡改历史）。
    //
    // ⚠ 字段形状必须与 `amountOf()` 对 ktoken 的读法一致（2026-10-17 核对）：
    //   它读的是 `record.inputTokens` / `record.outputTokens`（不是 units！），
    //   以及记录自带的 `inputPrice` / `outputPrice`。
    //   只写 units + unitPrice 的话，金额会被静默算成 0 —— 而 0 正是本仓库
    //   2026-10-15 那个"把真钱显示成免费"事故的同一个坑。
    let inputPrice = null
    let outputPrice = null
    let currency = 'CNY'
    let priceNote = '单价未在表内（unit=ktoken），金额需按智谱/百炼控制台核对'
    if (typeof resolvePrice === 'function') {
      try {
        const entry = resolvePrice(model)
        if (entry?.unit === 'ktoken') {
          const ip = Number.isFinite(entry.inputPrice) ? entry.inputPrice : null
          const op = Number.isFinite(entry.outputPrice) ? entry.outputPrice : null
          // 只有正数才算"已计价"——0 是"宣称免费"，与 null 一样不可用。
          if ((ip !== null && ip > 0) || (op !== null && op > 0)) {
            inputPrice = ip
            outputPrice = op
            if (typeof entry.currency === 'string' && entry.currency.length > 0) currency = entry.currency
            priceNote = entry?.asOf ? `单价取自 ${entry.asOf}` : '单价取自单价表'
          }
        }
      } catch {
        // 取价失败 → 如实写未计价，不影响记账本身。
      }
    }
    const ledgerEntry = {
      at: new Date().toISOString(),
      adapter: READER_ADAPTER,
      provider: route.provider ?? 'unknown',
      model,
      unitKind: 'ktoken',
      units,
      // ktoken 的两个计量桶必须单独落盘：amountOf() 按 inputTokens/outputTokens 分别乘价。
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      inputPrice,
      outputPrice,
      unitPrice: inputPrice, // 展示用（priceCell 读 unitPrice）；金额一律走 amountOf
      currency,
      amount: null, // 由账本统一按 unitKind='ktoken' 计算，这里不预算（避免两处口径漂移）
      note: `读图子代理 token：入 ${tokens.input} / 出 ${tokens.output}` +
        (tokens.cacheRead > 0 || tokens.cacheWrite > 0
          ? ` / 缓存读 ${tokens.cacheRead}、写 ${tokens.cacheWrite}`
          : '') +
        `；${priceNote}`,
    }
    // 有会话归属才写：缺失时不加键，记录形状与旧账完全一致（见文件头「会话归属」）。
    if (route.sessionId !== undefined) ledgerEntry.sessionId = route.sessionId
    return ledgerEntry
  }

  return {
    /**
     * 订阅 `llm/stream`。返回 disposer。
     *
     * Handler 签名依据 cordis `dispatch()` 的实测语义：`(options, next)`，
     * `this` 被绑定为发事件的 service。
     *
     * @param {object} ctx cordis 插件上下文。
     */
    attach(ctx) {
      const handler = function (options, next) {
        const route = routeOf(options)
        // 非读图员的调用：**原样放行**，一个字节都不碰。
        if (route.provider === undefined || !readerProviders.has(route.provider)) {
          return next()
        }
        return observeStream(
          () => next(),
          (chunk) => {
            const tokens = tokensOf(chunk.usage)
            if (tokens === null) return
            observed++
            const entry = toRecord(route, tokens)
            if (entry === null) return
            if (entries.length >= maxEntries) entries.shift()
            entries.push({ ...route, ...tokens, units: entry.units, at: entry.at })
            // 落账是旁路：失败只记日志，绝不向上抛（否则会打断这次模型调用）。
            try {
              Promise.resolve(record(entry)).catch((error) => {
                warn(`读图用量落账失败：${error instanceof Error ? error.message : String(error)}`)
              })
            } catch (error) {
              warn(`读图用量落账失败：${error instanceof Error ? error.message : String(error)}`)
            }
          },
        )
      }
      if (typeof ctx?.on !== 'function') return () => {}
      const stop = ctx.on('llm/stream', handler)
      return typeof stop === 'function' ? stop : () => {}
    },

    /** 观测摘要（给报表用）。 */
    summary() {
      const byRoute = new Map()
      for (const e of entries) {
        const key = `${e.provider}/${e.model}`
        const hit = byRoute.get(key) ?? { provider: e.provider, model: e.model, calls: 0, tokens: 0 }
        hit.calls++
        hit.tokens += e.input + e.cacheRead + e.cacheWrite + e.output
        byRoute.set(key, hit)
      }
      return {
        observed,
        entries: entries.length,
        routes: [...byRoute.values()],
      }
    },
  }
}
