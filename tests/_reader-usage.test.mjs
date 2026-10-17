/**
 * 读图 token 计量（core/reader-usage.mjs）的独立验证。
 *
 * 要证明五件事，缺一不可：
 *   ① 字段口径对：token-meter 的 usageTokens() = input + cacheRead + cacheWrite + output
 *   ② 只认读图员：其它 provider 的调用**原样放行、不记账**
 *   ③ 旁路透明：分片不改、异常不吞、终结语义保持
 *   ④ 不伪造金额：单价未知就写 null（0 会被报表显示成免费、并让闸门失效）
 *   ⑤ 有界：环缓冲不会无限增长
 *
 * 运行：node tests/_reader-usage.test.mjs
 */
import assert from 'node:assert/strict'
import {
  tokensOf, routeOf, observeStream, createReaderUsageMeter, READER_ADAPTER,
} from '../core/reader-usage.mjs'
import { amountOf } from '../core/cost.mjs'

let pass = 0
const ok = (name) => { pass++; console.log(`  ok  ${name}`) }

/** 把（同步/异步）可迭代或 thenable 收成数组。 */
async function collect(iterableOrPromise) {
  const out = []
  for await (const item of await iterableOrPromise) out.push(item)
  return out
}

/** 造一个按顺序吐分片的流。 */
async function* streamOf(chunks) {
  for (const c of chunks) yield c
}

const usageChunk = (usage) => ({ type: 'usage', usage })

/** 装一个 meter 并抓出它注册的 handler（模拟 cordis 的 ctx.on）。 */
function attachMeter(meter) {
  const handlers = []
  const ctx = {
    on(name, handler) {
      assert.equal(name, 'llm/stream', '只应订阅 llm/stream')
      handlers.push(handler)
      return () => {}
    },
  }
  const stop = meter.attach(ctx)
  return { handler: handlers[0], handlers, stop }
}

/** 模拟 cordis waterfall 的一次派发：handler(options, next)。 */
function fire(handler, options, chunks = []) {
  let nextCalled = false
  const result = handler(options, () => { nextCalled = true; return streamOf(chunks) })
  return { result, nextCalled: () => nextCalled }
}

// ── ① 字段口径 ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(
    tokensOf({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 2 }),
    { input: 120, output: 30, cacheRead: 5, cacheWrite: 2 },
  )
  ok('tokensOf：四个桶都取到')

  assert.deepEqual(tokensOf({ inputTokens: 10, outputTokens: 4 }),
    { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 })
  ok('tokensOf：缓存桶缺省补 0')

  assert.equal(tokensOf({}), null, '两个主桶都没有 → 不是可用 usage')
  assert.equal(tokensOf(null), null)
  assert.equal(tokensOf({ inputTokens: 'x', outputTokens: 3 }).input, 0, '非数字当 0')
  assert.equal(tokensOf({ inputTokens: -5, outputTokens: 1 }).input, 0, '负数当 0（不能倒扣）')
  ok('tokensOf：脏输入不抛且不产生负值')

  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 }
  const t = tokensOf(usage)
  assert.equal(
    t.input + t.cacheRead + t.cacheWrite + t.output,
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens,
    '必须与 token-meter 的 usageTokens() 口径一致（对账前提）',
  )
  ok('tokensOf：与 token-meter 的 usageTokens() 口径一致')
}

// ── ② routeOf ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(routeOf({ provider: 'glm', model: 'glm-4.6v' }), { provider: 'glm', model: 'glm-4.6v' })
  assert.deepEqual(routeOf({ provider: 42 }), { provider: undefined, model: undefined })
  assert.deepEqual(routeOf(null), { provider: undefined, model: undefined })
  ok('routeOf：非字符串字段不冒充 route')

  // 会话归属（2026-10-17 加）：宿主 `llm/stream` 的请求对象带 sessionId。
  // 拿到它是"读图花费能被会话累计上限看见"的前提（没有归属的记录会被按会话过滤掉）。
  assert.equal(routeOf({ provider: 'glm', model: 'glm-4.6v', sessionId: 'sess-abc' }).sessionId, 'sess-abc')
  assert.equal(
    'sessionId' in routeOf({ provider: 'glm', model: 'glm-4.6v' }),
    false,
    '拿不到归属时不许凭空加字段（宁可漏归属，不可伪造归属）',
  )
  assert.equal(routeOf({ provider: 'glm', model: 'glm-4.6v', sessionId: '' }).sessionId, undefined, '空串不算归属')
  assert.equal(routeOf({ provider: 'glm', model: 'glm-4.6v', sessionId: 123 }).sessionId, undefined, '非字符串不算归属')
  ok('routeOf：拿到 sessionId 才带会话归属，拿不到绝不伪造')
}

// ── ③ 旁路透明 ───────────────────────────────────────────────────────────────
{
  const chunks = [
    { type: 'text-delta', text: 'a' },
    usageChunk({ inputTokens: 5, outputTokens: 1 }),
    { type: 'finish', reason: 'stop' },
  ]
  const seen = []
  const got = await collect(observeStream(() => streamOf(chunks), (c) => seen.push(c)))
  assert.equal(seen.length, 1, '只对 usage 分片回调')
  assert.deepEqual(got, chunks, '分片必须原样透出（不改、不丢、不乱序）')
  assert.ok(got[1] === chunks[1], '透出的必须是同一个对象，不是拷贝')
  ok('observeStream：分片原样透出且只回调 usage')

  const boom = new Error('provider blew up')
  async function* failing() {
    yield { type: 'text-delta', text: 'x' }
    throw boom
  }
  await assert.rejects(
    () => collect(observeStream(() => failing(), () => { throw new Error('observer bug') })),
    (e) => e === boom,
    '观察者出错时，原始异常必须照旧抛出',
  )
  ok('observeStream：观察者异常不污染原流异常')

  const got2 = await collect(observeStream(() => streamOf(chunks), () => { throw new Error('observer bug') }))
  assert.deepEqual(got2, chunks, '即使回调抛错，流也必须走完')
  ok('observeStream：回调抛错时流仍走完')
}

// ── ④ 只认读图员 + 不伪造金额 ───────────────────────────────────────────────
const recorded = []
const meter = createReaderUsageMeter({
  providers: ['glm', 'qwen-vl'],
  record: (r) => { recorded.push(r) },
  maxEntries: 3,
})
const { handler, stop } = attachMeter(meter)
assert.equal(typeof stop, 'function', 'attach 必须返回 disposer')
ok('attach：订阅 llm/stream 并返回 disposer')

{
  const deepseek = fire(handler, { provider: 'deepseek', model: 'deepseek-flash' })
  assert.ok(deepseek.nextCalled(), '非读图员必须放行到 next()')
  assert.equal(recorded.length, 0, '非读图员一律不记账')
  ok('只认读图员：deepseek 放行且不记账')

  const anonymous = fire(handler, { model: 'x' })
  assert.ok(anonymous.nextCalled(), '没有 provider 也必须放行')
  assert.equal(recorded.length, 0)
  ok('只认读图员：缺 provider 放行且不记账')

  const glmCall = fire(handler, { provider: 'glm', model: 'glm-4.6v' },
    [usageChunk({ inputTokens: 1000, outputTokens: 200 }), { type: 'finish' }])
  // ⚠ 时序：读图员分支的 next() 在**生成器内部**调用（observeStream 开始迭代时），
  // 所以此刻还没触发。先收流，再断言它确实被放行了 —— 这一点必须验，
  // 否则"包了一层观察"可能悄悄变成"截断了这次模型调用"。
  const forwarded = await collect(glmCall.result)
  assert.ok(glmCall.nextCalled(), '读图员也必须放行到 next()（只是延迟到流开始迭代时）')
  assert.equal(forwarded.length, 2, '分片数不变')
  assert.equal(recorded.length, 1, 'usage 分片应产生一条记录')

  const rec = recorded[0]
  assert.equal(rec.adapter, READER_ADAPTER)
  assert.equal(rec.unitKind, 'ktoken')
  assert.equal(rec.units, 1200, 'units = 入 + 出（+ 缓存）')
  assert.equal(rec.inputTokens, 1000, 'inputTokens 必须单独落盘（amountOf 按它乘价）')
  assert.equal(rec.outputTokens, 200, 'outputTokens 必须单独落盘')
  assert.equal(rec.inputPrice, null, '未计价必须写 null')
  assert.equal(rec.unitPrice, null, '未计价必须写 null')
  assert.equal(rec.amount, null, '金额未知必须写 null（不能写 0）')
  assert.notEqual(rec.unitPrice, 0, '绝不能写 0——0 会被报表显示成免费且让闸门失效')
  assert.ok(typeof rec.note === 'string' && rec.note.includes('1000'), 'note 要留下可核对的原始 token 数')
  ok('读图员：usage 落一条 ktoken 记录，单价/金额为 null')
}

// ── ⑥ 会话归属：有则落账、无则不伪造（2026-10-17 加） ───────────────────────
{
  const recs = []
  const withSession = createReaderUsageMeter({ providers: ['glm'], record: (r) => recs.push(r) })
  const { handler: hs } = attachMeter(withSession)
  await collect(fire(hs, { provider: 'glm', model: 'glm-4.6v', sessionId: 'sess-abc' },
    [usageChunk({ inputTokens: 10, outputTokens: 2 })]).result)
  assert.equal(recs.length, 1)
  assert.equal(
    recs[0].sessionId,
    'sess-abc',
    '会话归属必须落进记录——否则闸门按 sessionId 汇总时会把这笔读图花费整个过滤掉',
  )
  ok('会话归属：拿到 sessionId 就写进账本')

  const recs2 = []
  const without = createReaderUsageMeter({ providers: ['glm'], record: (r) => recs2.push(r) })
  const { handler: hn } = attachMeter(without)
  await collect(fire(hn, { provider: 'glm', model: 'glm-4.6v' },
    [usageChunk({ inputTokens: 10, outputTokens: 2 })]).result)
  assert.equal('sessionId' in recs2[0], false, '拿不到归属时不许凭空加字段（不能伪造会话）')
  ok('会话归属：拿不到时不加字段，绝不伪造')
}

{
  const before = recorded.length
  await collect(fire(handler, { provider: 'glm', model: 'glm-4.6v' },
    [usageChunk({ inputTokens: 0, outputTokens: 0 })]).result)
  assert.equal(recorded.length, before, '0 token 不该产生空记录')
  ok('零 token：不产生空记录')
}

{
  for (let i = 0; i < 10; i++) {
    await collect(fire(handler, { provider: 'qwen-vl', model: 'qwen3-vl-plus' },
      [usageChunk({ inputTokens: 10, outputTokens: 1 })]).result)
  }
  const summary = meter.summary()
  assert.ok(summary.entries <= 3, '环缓冲必须有界，实际=' + summary.entries)
  assert.equal(summary.observed, 12, 'observed 计数器不受环缓冲限制（1 读图 + 1 零token + 10 循环）')
  // ⚠ 有界的代价：最早的 glm 记录被 qwen 挤出去了，所以摘要里只剩 1 条路由。
  // 这不是 bug，是"有界"的必然结果 —— 账本才是权威数据源，摘要只是速览。
  assert.equal(summary.routes.length, 1, '环缓冲满时，摘要只保留最近的路由')
  ok('有界：环缓冲封顶，计数器不封顶（摘要会丢最早项，账本才是权威）')
}

{
  // 路由聚合本身要正确：用容量足够的 meter 验两条路由都在
  const recs = []
  const wide = createReaderUsageMeter({ providers: ['glm', 'qwen-vl'], record: (r) => recs.push(r), maxEntries: 50 })
  const { handler: hw } = attachMeter(wide)
  await collect(fire(hw, { provider: 'glm', model: 'glm-4.6v' }, [usageChunk({ inputTokens: 100, outputTokens: 20 })]).result)
  await collect(fire(hw, { provider: 'qwen-vl', model: 'qwen3-vl-plus' }, [usageChunk({ inputTokens: 300, outputTokens: 40 })]).result)
  await collect(fire(hw, { provider: 'qwen-vl', model: 'qwen3-vl-plus' }, [usageChunk({ inputTokens: 300, outputTokens: 40 })]).result)
  const s = wide.summary()
  assert.equal(s.routes.length, 2, '容量足够时两条路由都要出现')
  const qwen = s.routes.find((r) => r.provider === 'qwen-vl')
  assert.equal(qwen.calls, 2, '同一路由应聚合')
  assert.equal(qwen.tokens, 2 * 340, 'token 应按调用累加')
  ok('摘要：按 provider/model 聚合调用数与 token 数')
}

// ── ⑤ 单价解析：按**模型 id**取价并写进记录（未计价仍如实写 null） ─────────────
{
  const recs = []
  const priced = createReaderUsageMeter({
    providers: ['glm'],
    record: (r) => recs.push(r),
    // 单价表键是模型 id；provider 是路由名，两者不等——这里刻意验"按 model 查"
    resolvePrice: (model) => (model === 'glm-4.6v'
      ? { unit: 'ktoken', inputPrice: 0.5, outputPrice: 1.5, currency: 'CNY', asOf: '2026-10-17' }
      : undefined),
  })
  const { handler: hp } = attachMeter(priced)
  await collect(fire(hp, { provider: 'glm', model: 'glm-4.6v' },
    [usageChunk({ inputTokens: 1000, outputTokens: 100 })]).result)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].model, 'glm-4.6v', '记录必须带模型 id（按 provider 查价会查空）')
  assert.equal(recs[0].inputPrice, 0.5, 'ktoken 取 inputPrice')
  assert.equal(recs[0].outputPrice, 1.5, 'ktoken 取 outputPrice')
  assert.equal(recs[0].unitPrice, 0.5, 'unitPrice 供展示（priceCell 读它）')
  assert.equal(recs[0].currency, 'CNY')
  assert.ok(recs[0].note.includes('2026-10-17'), 'note 要写明取价日期')
  assert.equal(recs[0].amount, null, '金额交由账本统一按 unitKind 计算，记录里不预算（避免两处口径漂移）')
  // 关键：用**真实的 amountOf** 验字段形状。只靠自己写断言很容易漏掉
  // 「记录写 units+unitPrice，而 amountOf 读 inputTokens+inputPrice」这种静默错配
  // ——那样金额会被算成 0，正是 2026-10-15 那个"真钱显示成免费"的同一个坑。
  const amount = amountOf(recs[0])
  // 入 1000 token × 0.5 元/千 = 0.5；出 100 × 1.5 = 0.15；合计 0.65
  assert.equal(amount, 0.65, 'amountOf 必须能从这条记录算出 0.65，实际=' + amount)
  assert.notEqual(amount, 0, '金额不能是 0')
  ok('单价解析：按模型 id 取价，且 amountOf 能真的算出金额（0.65）')

  // 表里查不到 → 如实未计价，绝不能变成 0
  const recs2 = []
  const unpriced = createReaderUsageMeter({
    providers: ['glm'], record: (r) => recs2.push(r), resolvePrice: () => undefined,
  })
  const { handler: hu } = attachMeter(unpriced)
  await collect(fire(hu, { provider: 'glm', model: 'glm-4.6v' }, [usageChunk({ inputTokens: 5, outputTokens: 5 })]).result)
  assert.equal(recs2[0].unitPrice, null, '查不到价写 null')
  assert.notEqual(recs2[0].unitPrice, 0, '绝不能写 0')
  ok('单价解析：查不到价时如实 null，不伪造 0')

  // 取价函数抛错不能影响记账
  const recs3 = []
  const boomPrice = createReaderUsageMeter({
    providers: ['glm'], record: (r) => recs3.push(r),
    resolvePrice: () => { throw new Error('price table corrupt') },
  })
  const { handler: hb } = attachMeter(boomPrice)
  await collect(fire(hb, { provider: 'glm', model: 'glm-4.6v' }, [usageChunk({ inputTokens: 7, outputTokens: 3 })]).result)
  assert.equal(recs3.length, 1, '取价抛错仍要记账')
  assert.equal(recs3[0].unitPrice, null)
  ok('单价解析：取价抛错时降级为未计价，记账不受影响')
}

// ── ⑥ 落账失败不能影响模型调用 ───────────────────────────────────────────────
{
  const thrown = createReaderUsageMeter({ providers: ['glm'], record: () => { throw new Error('ledger down') } })
  const { handler: h2 } = attachMeter(thrown)
  const survived = await collect(fire(h2, { provider: 'glm', model: 'g' },
    [usageChunk({ inputTokens: 1, outputTokens: 1 }), { type: 'finish' }]).result)
  assert.equal(survived.length, 2, '落账抛错也必须把流走完')
  ok('落账同步失败：不影响模型调用')

  const asyncFail = createReaderUsageMeter({ providers: ['glm'], record: async () => { throw new Error('async down') } })
  const { handler: h3 } = attachMeter(asyncFail)
  await collect(fire(h3, { provider: 'glm', model: 'g' }, [usageChunk({ inputTokens: 1, outputTokens: 1 })]).result)
  await new Promise((r) => setTimeout(r, 10))
  ok('落账异步失败：被吞掉并记日志，不产生未处理拒绝')
}

console.log(`\n${pass} 通过 / 0 失败`)
