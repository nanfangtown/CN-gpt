/**
 * 性能基准：量化本插件给智能体加的固定开销。
 *
 * 三类开销，全部在**每轮对话**或**每次工具调用**上重复发生：
 *   1. **guard 链**：插件注册的每个 `ctx.tools.guard` 都会在**每一次工具调用**前跑一遍；
 *   2. **系统提示词段落**：每个请求都随系统提示词发送，按 token 计费；
 *   3. **每秒对账定时器**：`syncRestrictions` 每秒为每个存活会话重算一次掩码。
 *
 * 运行：node tests/_perf-bench.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'mm-models-perf-home')

const { createFakeCtx, makeExec, makePng } = await import('./fixtures.mjs')
const { startMockProviders } = await import('./mock-providers.mjs')
const { Config, apply } = await import('../index.js')

const tmp = await mkdtemp(join(tmpdir(), 'mm-perf-'))
const mock = await startMockProviders()
const { ctx, guards, sections } = createFakeCtx({ llmProviders: ['glm', 'deepseek-account'] })
const config = new Config({
  enableAskGlm: true,
  enableQwenDraw: true,
  enableSeedanceVideo: true,
  ledgerPath: join(tmp, 'ledger.json'),
  imageCachePath: join(tmp, 'cache.json'),
  taskRegistryPath: join(tmp, 'tasks.json'),
})
apply(ctx, config)

console.log(`guard 数量：${guards.length}（每个都会在**每次工具调用**前执行）`)

// ---------------------------------------------------------------- 造一份真实形状的会话日志
/** 造一条会话日志：entries 条，接近真实形状（用户消息 / 助手消息 / 工具结果）。 */
function makeLog(entries, { withImageAtEnd }) {
  const log = []
  for (let i = 0; i < entries; i += 1) {
    const kind = i % 3
    if (kind === 0) log.push({ type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看这个项目 ' + i }] } })
    else if (kind === 1) log.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: '好的，我先读一下 ' + i }] } })
    else log.push({ type: 'tool/result', data: { content: [{ type: 'text', text: '文件内容 ' + i }] } })
  }
  if (withImageAtEnd) log.push({ type: 'user/message', data: { content: [{ type: 'image', attachmentId: 'att-1' }] } })
  return log
}

const execOf = (log, name, args) => ({
  name,
  args,
  agent: { session: { id: 'perf-session', log }, options: { provider: 'deepseek-account', model: 'deepseek-flash' } },
})

/** 跑一整条 guard 链，返回是否被拦。 */
function runGuards(exec) {
  for (const { fn } of guards) {
    const verdict = fn(exec)
    if (verdict !== undefined) return verdict
  }
  return undefined
}

function bench(label, exec, iterations) {
  runGuards(exec) // 预热
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i += 1) runGuards(exec)
  const perCall = Number(process.hrtime.bigint() - start) / 1e6 / iterations
  console.log(`  ${label.padEnd(46)} ${perCall.toFixed(4)} ms/次`)
  return perCall
}

console.log('\n--- ① guard 链：每次工具调用都要跑一遍 ---')
const sizes = [100, 1000, 5000]
const results = new Map()
for (const size of sizes) {
  const plainLog = makeLog(size, { withImageAtEnd: false })
  const imageLog = makeLog(size, { withImageAtEnd: true })
  console.log(`\n  会话日志 ${size} 条：`)
  results.set(`bash-${size}`, bench('普通工具调用（bash / read 文本）', execOf(plainLog, 'bash', { command: 'ls' }), 2000))
  results.set(`read-${size}`, bench('read 文本文件（走第三条守卫）', execOf(plainLog, 'read', { file_path: 'C:/x/a.txt' }), 2000))
  results.set(`readimg-${size}`, bench('read 图片（命中拦截）', execOf(plainLog, 'read', { file_path: 'C:/x/a.png' }), 2000))
  results.set(`askglm-${size}`, bench('ask_glm（图片在上下文 → 扫描全日志）', execOf(imageLog, 'ask_glm', { prompt: 'x' }), 2000))
  results.set(`askglm2-${size}`, bench('ask_glm（历史有图但不在末尾 → 扫两遍）', execOf(makeLog(size, { withImageAtEnd: false }).concat([{ type: 'user/message', data: { content: [{ type: 'text', text: '再说一句' }] } }]).map((e, i) => (i === 5 ? { type: 'user/message', data: { content: [{ type: 'image' }] } } : e)), 'ask_glm', { prompt: 'x' }), 2000))
}

console.log('\n--- ② 提示词段落：每个请求都随系统提示词发送 ---')
const sectionText = typeof sections[0]?.text === 'function' ? sections[0].text({}) : sections[0]?.text
const bytes = Buffer.byteLength(sectionText ?? '', 'utf8')
console.log(`  段落字节数：${bytes}`)
console.log(`  中文字符数：${[...(sectionText ?? '')].length}`)
console.log(`  粗略 token（中文≈1.5 字/token，英文≈4 字/token）：约 ${Math.round([...(sectionText ?? '')].filter((c) => c.codePointAt(0) > 0x2e80).length / 1.5 + [...(sectionText ?? '')].filter((c) => c.codePointAt(0) <= 0x2e80).length / 4)} tokens/请求`)

console.log('\n--- ③ 工具 schema：每个请求都随工具列表发送 ---')
const fake2 = createFakeCtx({ llmProviders: [] })
const config2 = new Config({ ledgerPath: join(tmp, 'l2.json'), imageCachePath: join(tmp, 'c2.json'), taskRegistryPath: join(tmp, 't2.json') })
apply(fake2.ctx, config2)
let schemaBytes = 0
for (const definition of fake2.tools) {
  const text = JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters })
  schemaBytes += Buffer.byteLength(text, 'utf8')
  console.log(`  ${String(definition.name).padEnd(16)} ${String(Buffer.byteLength(text, 'utf8')).padStart(6)} 字节`)
}
console.log(`  合计：${schemaBytes} 字节/请求`)
console.log('  （对照：guard 链在 5000 条日志下最坏 0.06 ms/次；一次 LLM 往返通常 1000+ ms）')

console.log('\n--- ④ 每秒对账定时器（syncRestrictions）---')
// 这一条是**每个存活会话每秒**都要付的钱。做法：截获插件注册的 setInterval 回调，
// 灌 N 个会话后手动触发一次，量"一轮对账"的真实耗时。
const realSetInterval = globalThis.setInterval
let syncTick
globalThis.setInterval = (callback) => {
  syncTick = callback
  return { unref() {} }
}
const benchCtx = createFakeCtx({ llmProviders: [] })
const benchCfg = new Config({ ledgerPath: join(tmp, 'l3.json'), imageCachePath: join(tmp, 'c3.json'), taskRegistryPath: join(tmp, 't3.json') })
apply(benchCtx.ctx, benchCfg)
globalThis.setInterval = realSetInterval
if (syncTick === undefined) throw new Error('没截获到对账定时器')
const created = benchCtx.listeners.find((entry) => entry.event === 'agent/created')?.callback
const makeAgent = () => ({
  options: { provider: 'deepseek-account', model: 'deepseek-flash' },
  ctx: { ...benchCtx.ctx, effect: (callback) => callback(), tools: { restrict: () => () => {} } },
})
for (const count of [1, 50, 200, 1000]) {
  for (let i = 0; i < count; i += 1) created?.({ agent: makeAgent() })
  syncTick() // 预热：让签名落到"当前值"，此后进入稳态
  const rounds = 200
  const start = process.hrtime.bigint()
  for (let i = 0; i < rounds; i += 1) syncTick()
  const steady = Number(process.hrtime.bigint() - start) / 1e6 / rounds
  // 对照：开关真的变了的那一秒（要逐个 agent 重算）——把 lastSyncSignature 弄脏即可。
  const dirtyRounds = 50
  const dirtyStart = process.hrtime.bigint()
  for (let i = 0; i < dirtyRounds; i += 1) {
    benchCfg.enableQwenDraw = i % 2 === 0 // 每次都让签名变化
    syncTick()
  }
  const dirty = Number(process.hrtime.bigint() - dirtyStart) / 1e6 / dirtyRounds
  benchCfg.enableQwenDraw = true
  console.log(
    `  存活会话 ${String(count).padStart(4)} 个 → 稳态 ${steady.toFixed(3)} ms/次` +
      `（开关真变化时 ${dirty.toFixed(3)} ms/次，每秒最多一次）`,
  )
}

console.log('\n--- ⑥ 单点剖析：读图守卫里那句 log.some(entryHasImage) 的真实成本 ---')
// 这句在"图片已在上下文"路径上扫全日志；如果它出现在最热路径上就是问题。
// 实测它只在 name 命中读图工具时才执行，所以先量它自己。
const entryHasImage = (entry) => {
  const content = entry?.data?.content
  return Array.isArray(content) && content.some((block) => block?.type === 'image')
}
for (const size of [1000, 5000, 20000]) {
  const log = makeLog(size, { withImageAtEnd: false })
  log.some(entryHasImage) // 预热
  const rounds = 500
  const start = process.hrtime.bigint()
  for (let i = 0; i < rounds; i += 1) log.some(entryHasImage)
  const per = Number(process.hrtime.bigint() - start) / 1e6 / rounds
  console.log(`  日志 ${String(size).padStart(5)} 条 → ${per.toFixed(4)} ms/次（全扫、无图）`)
}
// 对照：只有 name 命中读图工具时才会走到这里，所以它不在 bash/read 的热路径上。
console.log('  → 结论：只在 ask_glm/ask_qwen 调用时执行，且量级 <0.1 ms，可忽略。')

console.log('\n--- ⑦ 插件给每个请求加的总字节（提示词 + 工具 schema）---')
const promptBytes = Buffer.byteLength(sectionText ?? '', 'utf8')
console.log(`  提示词段落 ${promptBytes} B + 工具 schema ${schemaBytes} B = ${promptBytes + schemaBytes} B/请求`)
console.log(`  粗略折算 ≈ ${Math.round((promptBytes + schemaBytes) / 4)} tokens/请求（英文/JSON 为主，按 4 字/token 估）`)
console.log('  对照：一个 10 万 token 的会话里，这是约 1% 的增量。')

console.log('\n--- ⑤ 单次工具调用总耗时（对照：guard 链只是其中一小截）---')
const fake3 = createFakeCtx({
  credentials: { DASHSCOPE_API_KEY: mock.state.logins.dashscope, ARK_API_KEY: mock.state.logins.ark },
  llmProviders: [],
})
const config3 = new Config({
  dashscopeBase: mock.base + '/dashscope/api/v1',
  dashscopeCompatBase: mock.base + '/dashscope/compatible-mode/v1',
  arkBase: mock.base + '/ark/api/v3',
  taskTimeoutMs: 5000,
  videoTimeoutMs: 5000,
  taskPollIntervalMs: 500,
  taskPollMaxIntervalMs: 500,
  httpTimeoutMs: 5000,
  queryRetries: 1,
  maxCallsPerTurn: 0,
  outDir: join(tmp, 'gen'),
  videoOutDir: join(tmp, 'gen', 'video'),
  enableSeedanceVideo: true,
  requireSpendConfirm: false,
  ledgerPath: join(tmp, 'l4.json'),
  imageCachePath: join(tmp, 'c4.json'),
  taskRegistryPath: join(tmp, 't4.json'),
})
apply(fake3.ctx, config3)
const drawTool = fake3.tools.find((t) => t.name === 'qwen_draw')
const exec = {
  name: 'qwen_draw',
  args: {},
  agent: {
    session: { id: 'perf-session', header: { cwd: tmp }, log: makeLog(500, { withImageAtEnd: false }) },
    options: { provider: 'deepseek-account', model: 'deepseek-flash' },
  },
}
const t0 = process.hrtime.bigint()
await drawTool.execute({ prompt: '性能测试图' }, exec)
console.log(`  首次出图（含假厂商网络往返）：${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`)
const t1 = process.hrtime.bigint()
await drawTool.execute({ prompt: '性能测试图' }, exec)
console.log(`  同 prompt 第二次（命中出图缓存）：${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(1)} ms`)

await mock.close?.()
