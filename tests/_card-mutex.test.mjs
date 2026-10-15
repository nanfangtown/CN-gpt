/**
 * 设置卡互斥行为测试（Host 之外唯一的客户端代码，纯逻辑、不需要 DOM）。
 *
 * 做法：把 client.js 当作模块脚本在 vm 里执行，取出 window.__ModuleLoader__ 注册的
 * factory，只注入一个假的 React；再从 slots.register 拿回卡片定义的 inject()，
 * 直接驱动其中的表单模型（edit / save / discard / getSnapshot）。
 *
 * 运行：node tests/_card-mutex.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let mod
const sandbox = { window: { __ModuleLoader__: { load(definition) { mod = definition } } }, console }
vm.createContext(sandbox)
vm.runInContext(source, sandbox)
const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
const exported = mod.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

/** 跨 vm realm 比较写入操作：比结构而不是原型。 */
const opsAre = (got, want, message) => assert.equal(JSON.stringify(got), JSON.stringify(want), message)

/** 假的 configForms scope：记录 mutate 的调用并维护"当前生效配置"。 */
function makeHolder(initial) {
  const holder = { value: { ...initial }, calls: [], revision: 1 }
  holder.scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: holder.revision, value: { ...holder.value }, user: { ...holder.value } }),
    subscribe: () => () => {},
    async mutate(ops) {
      holder.calls.push(ops)
      for (const op of ops) holder.value[op.path[0]] = op.value
      holder.revision += 1
      return true
    },
  }
  return holder
}

let registered
let holder
const ctx = {
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: Object.assign((key) => key, { register: () => () => {} }),
  slots: {
    inject: (name, callback) => callback(),
    register: (options) => {
      registered = options
      return () => {}
    },
  },
  configForms: { whileServed: (entries, callback) => callback(), get: () => holder.scope },
}

/** 挂载设置卡，按顺序执行编辑动作，必要时保存；返回保存前后的快照。 */
async function mount(initial, actions, { save = true, forceSave = false } = {}) {
  holder = makeHolder(initial)
  registered = undefined
  exported.apply(ctx)
  const api = registered.inject()
  const store = api.hooks.mmModels
  for (const [name, text] of actions) api.edit(name, text)
  const before = store.getSnapshot()
  // forceSave：密钥框"清空"这种写入不脏（空白 secret 不算 dirty），但用户确实动了，
  // 所以测试要能强制走一次保存来看真实写入。
  if (save && (before.dirty || forceSave)) await api.save()
  return { before, after: store.getSnapshot(), edit: api.edit, discard: api.discard }
}

const switches = () => ({ glm: holder.value.enableAskGlm, qwen: holder.value.enableAskQwen })

const cases = []
function test(name, fn) {
  cases.push({ name, fn })
}

test('两个都关 → 打开 ask_glm：ask_qwen 已是对的，不重复写', async () => {
  const { before } = await mount({ enableAskGlm: false, enableAskQwen: false }, [['enableAskGlm', 'true']])
  assert.equal(before.fields.enableAskGlm.text, 'true')
  assert.equal(before.fields.enableAskQwen.text, 'false')
  assert.equal(before.fields.enableAskGlm.dirty, true)
  assert.equal(before.dirty, true)
  opsAre(holder.calls[0], [{ op: 'set', path: ['enableAskGlm'], value: true }])
  assert.deepEqual(switches(), { glm: true, qwen: false })
})

test('ask_qwen 开着 → 打开 ask_glm：先关 ask_qwen、再开 ask_glm', async () => {
  const { before } = await mount({ enableAskGlm: false, enableAskQwen: true }, [['enableAskGlm', 'true']])
  assert.equal(before.fields.enableAskQwen.text, 'false', 'UI 上 ask_qwen 立即变关')
  opsAre(holder.calls[0], [
    { op: 'set', path: ['enableAskQwen'], value: false },
    { op: 'set', path: ['enableAskGlm'], value: true },
  ], '末次写入必须是用户点开的那个')
  assert.deepEqual(switches(), { glm: true, qwen: false })
})

test('ask_glm 开着 → 打开 ask_qwen：先关 ask_glm、再开 ask_qwen（反向同理）', async () => {
  const { before } = await mount({ enableAskGlm: true, enableAskQwen: false }, [['enableAskQwen', 'true']])
  assert.equal(before.fields.enableAskGlm.text, 'false', 'UI 上 ask_glm 立即变关')
  opsAre(holder.calls[0], [
    { op: 'set', path: ['enableAskGlm'], value: false },
    { op: 'set', path: ['enableAskQwen'], value: true },
  ], '末次写入必须是用户点开的那个')
  assert.deepEqual(switches(), { glm: false, qwen: true })
})

test('关闭开着的那个：不牵连另一个', async () => {
  await mount({ enableAskGlm: true, enableAskQwen: false }, [['enableAskGlm', 'false']])
  opsAre(holder.calls[0], [{ op: 'set', path: ['enableAskGlm'], value: false }])
  assert.deepEqual(switches(), { glm: false, qwen: false })
})

test('反复切换（开→关→开）：无残留脏状态，只写必要的一条', async () => {
  const { before } = await mount({ enableAskGlm: false, enableAskQwen: false }, [
    ['enableAskGlm', 'true'],
    ['enableAskGlm', 'false'],
    ['enableAskGlm', 'true'],
  ])
  opsAre(holder.calls[0], [{ op: 'set', path: ['enableAskGlm'], value: true }])
  assert.equal(before.fields.enableAskQwen.dirty, false, 'ask_qwen 已是对的，不应标脏')
  assert.deepEqual(switches(), { glm: true, qwen: false })
})

test('来回换两次：最后一次点开的胜出（ask_glm → ask_qwen）', async () => {
  await mount({ enableAskGlm: false, enableAskQwen: false }, [['enableAskGlm', 'true'], ['enableAskQwen', 'true']])
  const batch = holder.calls[0]
  // 关键不变量：只写必要的一条，且"最后被点开的那个"出现在批量末尾（末次写入生效）。
  assert.equal(JSON.stringify(batch.at(-1)), JSON.stringify({ op: 'set', path: ['enableAskQwen'], value: true }), '末次操作必须是被点开的 ask_qwen')
  assert.equal(batch.filter((op) => op.path[0] === 'enableAskQwen' && op.value === true).length, 1, 'ask_qwen 不应被写两次')
  assert.deepEqual(switches(), { glm: false, qwen: true }, '最后一次点开的 ask_qwen 胜出')
})

test('放弃修改：被自动关闭的开关一并复原，不落盘', async () => {
  const { edit, discard } = await mount({ enableAskGlm: true, enableAskQwen: false }, [], { save: false })
  edit('enableAskQwen', 'true')
  const store = registered.inject().hooks.mmModels
  assert.equal(store.getSnapshot().fields.enableAskGlm.text, 'false', '暂存里 ask_glm 已被自动关闭')
  discard()
  assert.equal(store.getSnapshot().fields.enableAskGlm.text, 'true', '放弃后复原')
  assert.equal(store.getSnapshot().dirty, false)
  assert.equal(holder.calls.length, 0, '放弃不应写入')
})

test('无关开关不受影响：翻转 qwen_draw 不触碰读图开关', async () => {
  await mount({ enableAskGlm: true, enableAskQwen: false, enableQwenDraw: true }, [['enableQwenDraw', 'false']])
  opsAre(holder.calls[0], [{ op: 'set', path: ['enableQwenDraw'], value: false }])
  assert.deepEqual(switches(), { glm: true, qwen: false })
})


let failed = 0
for (const item of cases) {
  try {
    await item.fn()
    console.log('  \u2713 ' + item.name)
  } catch (error) {
    failed += 1
    console.log('  \u2717 ' + item.name)
    console.log('    ' + String(error?.message ?? error).split('\n').slice(0, 6).join('\n    '))
  }
}
console.log('\n[设置卡互斥] 通过 ' + (cases.length - failed) + '，失败 ' + failed)
if (failed > 0) process.exitCode = 1
