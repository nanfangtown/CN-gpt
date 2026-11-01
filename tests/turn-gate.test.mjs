/**
 * turn-gate 的最小桩测试：模拟宿主 dsh-agent-loop 的事件顺序。
 *   pre-step（带图）→ 自动 OCR / 提醒 → ask_qwen 派出 → 下一步必须等结论 → turn-stopping。
 */
import assert from 'node:assert/strict'
import { createTurnGate } from '../guard/turn-gate.mjs'

const handlers = new Map()
const logs = []
const ctx = {
  on(name, fn) {
    const list = handlers.get(name) ?? []
    list.push(fn)
    handlers.set(name, list)
  },
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m), debug: () => {} },
  effect: (fn) => fn(),
}
const fire = async (name, ...args) => {
  let result
  for (const fn of handlers.get(name) ?? []) result = await fn(...args)
  return result
}
const liveConfig = {
  readerGate: true,
  readerGateTimeoutMs: 3000,
  readerGateImageHint: true,
  readerGateForceEvidence: true,
  autoOcrOnImage: true,
}

const OCR_PATH = 'C:/Users/x/.dsh/attachments/v1/objects/92/921ad83fa3126e1a57d9445fdef3a8f874c7288dd7e9ffb7f9a22dab9630ff22'
let ocrCalls = 0
const gate = createTurnGate({
  ctx,
  logger: ctx.logger,
  liveConfig,
  isSubagent: (agent) => agent?.sub === true,
  isReader: () => false,
  autoOcr: async (imagePath) => {
    ocrCalls += 1
    ocrPaths.push(imagePath)
    return { text: '本地 OCR：图里的字', weak: false }
  },
})

const injected = []
const ocrPaths = []
const makeAgent = (id) => ({
  id,
  session: { log: [] },
  inject: (message) => injected.push(message),
  inbox: { nextStep: [], splice() {} },
})
const enter = (text) => async () => ({
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: text ?? 'hi' }] }],
})

// --- A：有图、没有可定位的图片路径 → 机械提醒 ---
const agent = makeAgent('main')
agent.session.log.push({ type: 'user/message', data: { content: [{ type: 'image' }] } })
const a = await fire('agent/pre-step', { agent, turn: 1, step: 1, signal: new AbortController().signal, messages: [] }, enter())
assert.ok(a.messages.length >= 2, 'A: 应追加一条提醒')
assert.match(JSON.stringify(a.messages.at(-1)), /读图闸门/, 'A: 提醒内容不对')
console.log('A ok: 有图无路径 → 机械提醒')

// --- A2：粘贴图（路径不在文本里，只在 image 块）→ 从 attachmentId 还原路径并自动 OCR ---
const HEX = 'ab'.repeat(32)
const agentBlock = makeAgent('main-block')
agentBlock.session.log.push({ type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + HEX } }] } })
const a2 = await fire(
  'agent/pre-step',
  { agent: agentBlock, turn: 1, step: 1, signal: new AbortController().signal, messages: [] },
  async () => ({
    kind: 'enter',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'sha256:' + HEX, name: 'image.png' } },
        { type: 'text', text: '暂不提交，你怎么看' },
      ],
    }],
  }),
)
const tail = (p) => p.split(/[\\/]/).slice(-2).join('/')
assert.ok(ocrPaths.some((p) => tail(p) === 'ab/' + HEX), 'A2: 应从 attachmentId 还原附件路径：' + ocrPaths.join(','))
assert.ok(ocrPaths.some((p) => p.includes('attachments')), 'A2: 路径应指向 attachments 对象目录')
assert.match(JSON.stringify(a2.messages.at(-1)), /本地 OCR 原文/, 'A2: 应注入 OCR 原文')
console.log('A2 ok: 粘贴图无文本路径 → 从 image 块还原并自动 OCR')

// --- B：有图 + 能找到路径 → 自动 OCR 注入（零决策） ---
const agentOcr = makeAgent('main-ocr')
agentOcr.session.log.push({ type: 'user/message', data: { content: [{ type: 'image' }] } })
const b = await fire(
  'agent/pre-step',
  { agent: agentOcr, turn: 1, step: 1, signal: new AbortController().signal, messages: [] },
  enter('图片路径：' + OCR_PATH),
)
assert.equal(ocrCalls, 2, 'B: 应自动跑一次 OCR（A2 已跑过 1 次）')
assert.match(JSON.stringify(b.messages.at(-1)), /本地 OCR 原文/, 'B: 应注入 OCR 原文')
assert.doesNotMatch(JSON.stringify(b.messages.at(-1)), /不是模型判断/, 'B: 有 OCR 时不该再提醒')
console.log('B ok: 有图带路径 → 自动 OCR 注入')

// --- C：派出读图员后的下一步必须等结论 ---
gate.noteReaderStarted(agent, 'reader-1')
let settled = false
const startedAt = Date.now()
const cPromise = fire(
  'agent/pre-step',
  { agent, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
  enter(),
).then((value) => {
  settled = true
  return value
})

await new Promise((resolve) => setTimeout(resolve, 300))
assert.equal(settled, false, 'C: 读图员未结束时 pre-step 不应返回')

gate.noteEvidence(agent)
await fire('subagent/end', { id: 'reader-1', stopReason: 'stop', lastAssistantMessage: '图里是 bilibili 评论区' })
const c = await cPromise
assert.ok(settled, 'C: 读图员结束后 pre-step 应返回')
assert.ok(Date.now() - startedAt >= 250, 'C: 应真的等过')
assert.match(JSON.stringify(c.messages.at(-1)), /bilibili/, 'C: 结论应并入 messages')
console.log('C ok: 派了没等 → 下一步被闸住，结论自动并入')

// --- D：收尾时仍无证据 → 拒绝收尾并注入纠正回合 ---
const agent2 = makeAgent('main2')
agent2.session.log.push({ type: 'user/message', data: { content: [{ type: 'image' }] } })
await fire('agent/pre-step', { agent: agent2, turn: 2, step: 1, signal: new AbortController().signal, messages: [] }, enter())
injected.length = 0
await fire('agent/turn-stopping', { agent: agent2, turn: 2, signal: new AbortController().signal })
assert.ok(injected.length >= 1, 'D: 无证据时应注入纠正回合')
console.log('D ok: 无证据收尾 → 注入纠正回合')

// --- E：关掉闸门后一切照旧 ---
liveConfig.readerGate = false
const e = await fire(
  'agent/pre-step',
  { agent: makeAgent('main3'), turn: 3, step: 1, signal: new AbortController().signal, messages: [] },
  enter(),
)
assert.equal(e.messages.length, 1, 'E: 关闸后不应改动 messages')
console.log('E ok: readerGate=false 完全放行')

// --- F：关掉自动 OCR 后回到提醒 ---
liveConfig.readerGate = true
liveConfig.autoOcrOnImage = false
const agentF = makeAgent('main4')
agentF.session.log.push({ type: 'user/message', data: { content: [{ type: 'image' }] } })
const f = await fire(
  'agent/pre-step',
  { agent: agentF, turn: 1, step: 1, signal: new AbortController().signal, messages: [] },
  enter('图片路径：' + OCR_PATH),
)
// 关掉自动 OCR 后不应再增加调用次数（此前累计 2 次）。
assert.equal(ocrCalls, 2, 'F: 关掉后不应再跑 OCR')
assert.match(JSON.stringify(f.messages.at(-1)), /读图闸门/, 'F: 应回到提醒')
console.log('F ok: autoOcrOnImage=false → 回退提醒')

console.log('\nlogs:\n' + logs.join('\n'))
console.log('\nALL PASS')
