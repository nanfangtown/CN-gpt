/**
 * 设置卡离线测试：用 vm 加载 client.js，假 React/ctx/configForms 验证
 *   - 注册进 plugins.bundle.config，key = 包名；
 *   - 开关与文本字段的编辑/保存/放弃、非法数字拦截、保存失败反馈；
 *   - 页面树里有 5 个开关与保存按钮，summary 视图不渲染。
 * 运行：node tests/client-card.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * 假 React：支持 createElement + 可用的 useState / useEffect。
 *
 * 为什么必须支持 hook：
 *   - `KeyRow` 用 useState 存"正在输入的新值" → 不支持就测不了"输入 → 保存"的真实交互；
 *   - 页面用 useEffect 拉凭据状态（describe）→ 不支持就永远停在 loading，测不到"已配置/来自哪层"。
 *
 * 语义取舍（够用即可，不追求 React 的调度）：
 *   - useState 的槽位挂在**组件函数**上，所以重新渲染同一个组件时状态延续；
 *   - useEffect 每次渲染都同步执行一次（记录 cursor 占位），因此 describe 会被调用；
 *     它是异步的，测试里 await 一个微任务即可看到结果。
 */
function makeFakeReact() {
  const byComponent = new Map()
  let slots = []
  let cursor = 0
  const useState = (initial) => {
    const index = cursor++
    if (slots.length <= index) slots.push({ value: typeof initial === 'function' ? initial() : initial })
    const slot = slots[index]
    return [
      slot.value,
      (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      },
    ]
  }
  const useEffect = (fn) => {
    cursor++
    try {
      fn()
    } catch {
      // 忽略：测试里的 effect 失败不应让渲染整体失败
    }
  }
  return {
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        if (!byComponent.has(type)) byComponent.set(type, [])
        const saved = slots
        slots = byComponent.get(type)
        cursor = 0
        const out = type({ ...(props ?? {}), children })
        slots = saved
        return out
      }
      return { type, props: props ?? {}, children }
    },
    useState,
    useEffect,
  }
}
const fakeReact = makeFakeReact()
const sandbox = {
  window: { __ModuleLoader__: { load(definition) { sandbox.__definition = definition } } },
  console,
}
vm.runInNewContext(code, sandbox, { filename: 'client.js' })
assert.equal(sandbox.__definition.id, '@local/dsh-mm-models', 'client module id')
const mod = sandbox.__definition.factory((name) => {
  assert.equal(name, 'react')
  return fakeReact
})
assert.equal(
  JSON.stringify(mod.inject),
  JSON.stringify(['slots', 'locale', 'configForms', 'remote', 'remote.credentials']),
  '须声明 remote.credentials 才能拿到官方凭据服务',
)

// ---- 假 Host 配置表单 ----
const mutations = []
let snapshot = {
  status: 'ready',
  writable: true,
  revision: 7,
  value: {
    enableSeedanceVideo: false,
    qwenModel: 'qwen-image-3.0',
    promptSection: true,
    taskTimeoutMs: 600000,
    videoTimeoutMs: 1800000,
    taskPollIntervalMs: 5000,
  },
  base: { enableSeedanceVideo: true, qwenModel: 'qwen-image-3.0' },
  user: {},
}

// ---- 假凭据服务（官方凭据服务的客户端一侧）----
//
// ⚠ 必须模拟**真实的 RemoteResult 包装**：官方走 ctx.remote.credentials，远端调用返回
//   `{ ok: true, value }` 或 `{ ok: false, error }`，而不是裸数据。
//   第一版实现就是直接 await 裸数据，导致真机上 describe 的结果取不到、
//   三把 key 全显示"未配置"。这个夹具就是为抓住那类错误而写的。
const credentialCalls = []
const credentialStore = new Map()
const ok = (value) => ({ ok: true, value })
const fail = (message) => ({ ok: false, error: { message } })
const credentialService = {
  async describe(refs) {
    credentialCalls.push({ op: 'describe', refs })
    if (credentialService.failDescribe === true) return fail('describe failed')
    const out = {}
    for (const ref of refs) {
      const entry = credentialStore.get(ref)
      out[ref] = entry === undefined ? { configured: false, writable: true } : { configured: true, source: entry.source, writable: entry.writable !== false }
    }
    return ok(out)
  },
  async set(ref, value) {
    credentialCalls.push({ op: 'set', ref, value })
    if (credentialService.failNext === true) {
      credentialService.failNext = false
      return fail('set rejected')
    }
    credentialStore.set(ref, { value, source: 'store' })
    return ok(undefined)
  },
  async unset(ref) {
    credentialCalls.push({ op: 'unset', ref })
    credentialStore.delete(ref)
    return ok(undefined)
  },
}
const scope = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  async mutate(ops, revision) {
    mutations.push({ ops, revision })
    if (scope.failNext === true) {
      scope.failNext = false
      return false
    }
    const value = { ...snapshot.value }
    const user = { ...snapshot.user }
    for (const op of ops) {
      if (op.op === 'set') {
        value[op.path[0]] = op.value
        user[op.path[0]] = op.value
      } else {
        delete value[op.path[0]]
        delete user[op.path[0]]
      }
    }
    snapshot = { ...snapshot, revision: revision + 1, value, user }
    return true
  },
}

const registered = []
const fakeCtx = {
  // 官方客户端用的是 ctx.remote.credentials（不是 ctx.get('credentials')）——
  // 按真机形状提供，才能测出"取法写错"这类 bug。
  remote: { credentials: credentialService },
  locale: { bind: () => (key) => 'T:' + key, register: () => () => {} },
  configForms: {
    whileServed(namespaces, register) {
      const off = register(new Set(namespaces))
      return () => off?.()
    },
    get(entryId) {
      assert.equal(entryId, 'mm-models')
      return scope
    },
  },
  slots: {
    inject(_owner, callback) {
      const off = callback()
      return () => off?.()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
  effect(callback) {
    return callback()
  },
}
mod.apply(fakeCtx)

// ---- 注册点 ----
assert.equal(registered.length, 1)
const { options, component } = registered[0]
assert.equal(options.name, 'plugins.bundle.config')
assert.equal(options.key, '@local/dsh-mm-models')
assert.equal(typeof options.inject, 'function')
const props = options.inject()
assert.equal(typeof props.edit, 'function')
assert.equal(typeof props.save, 'function')
assert.equal(typeof props.discard, 'function')
assert.equal(typeof props.hooks.mmModels.getSnapshot, 'function')
assert.ok(props.credentials, '凭据服务必须注入给卡片')
// 注入的是包装对象 { api, source }（api 才是远端命名空间）
assert.equal(typeof props.credentials.api.set, 'function')
assert.equal(typeof props.credentials.api.unset, 'function')
assert.equal(typeof props.credentials.api.describe, 'function')
assert.equal(props.credentials.source, 'remote.credentials', '须走官方路径 ctx.remote.credentials')

// ---- 初始状态 ----
let state = props.hooks.mmModels.getSnapshot()
assert.equal(state.available, true)
assert.equal(state.writable, true)
assert.equal(state.dirty, false)
assert.equal(state.fields.enableSeedanceVideo.text, 'false')
assert.equal(state.fields.qwenModel.text, 'qwen-image-3.0')

// ---- 编辑开关 + 文本，保存 ----
props.edit('enableSeedanceVideo', 'true')
props.edit('qwenModel', 'qwen-image-2.1-pro')
state = props.hooks.mmModels.getSnapshot()
assert.equal(state.dirty, true)
assert.equal(state.fields.enableSeedanceVideo.dirty, true)
await props.save()
assert.equal(mutations.length, 1)
assert.equal(mutations[0].revision, 7, 'save should pin the staged baseline revision')
assert.equal(
  JSON.stringify(mutations[0].ops),
  JSON.stringify([
    { op: 'set', path: ['enableSeedanceVideo'], value: true },
    { op: 'set', path: ['qwenModel'], value: 'qwen-image-2.1-pro' },
  ]),
)
state = props.hooks.mmModels.getSnapshot()
assert.equal(state.dirty, false, 'drafts clear after a landed save')
assert.equal(state.fields.enableSeedanceVideo.text, 'true')

// ---- 非法数字：不入队、不保存 ----
props.edit('taskTimeoutMs', 'abc')
state = props.hooks.mmModels.getSnapshot()
assert.equal(state.fields.taskTimeoutMs.invalid, true)
await props.save()
assert.equal(mutations.length, 1, 'invalid number must not be written')
props.discard()
assert.equal(props.hooks.mmModels.getSnapshot().dirty, false)

// ---- 保存失败：failed 反馈、草稿保留 ----
scope.failNext = true
props.edit('promptSection', 'false')
await props.save()
state = props.hooks.mmModels.getSnapshot()
assert.equal(state.failed, true)
assert.equal(state.dirty, true, 'drafts survive a rejected save')
props.discard()

// 先摆好凭据夹具：DashScope 来自环境层、Zhipu 存在凭据文件里、Ark 未配置
credentialStore.set('DASHSCOPE_API_KEY', { value: 'sk-x', source: 'environment' })
credentialStore.set('ZHIPU_API_KEY', { value: 'z', source: 'store' })

// ---- 渲染：summary 不画，页面有 5 个开关 + 保存按钮 ----
assert.equal(component({ view: 'summary', t: (key) => key }), null)
const pageProps = {
  view: 'page',
  t: (key) => 'T:' + key,
  useMmModels: (selector) => selector(props.hooks.mmModels.getSnapshot()),
  edit: props.edit,
  save: props.save,
  discard: props.discard,
  // 真机上由 slot inject 提供；测试必须同样传入，否则卡片拿不到凭据服务。
  credentials: props.credentials,
}
const tree = component(pageProps)
const flat = []
const walk = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item)
    return
  }
  if (typeof node === 'object' && node.type !== undefined) {
    flat.push(node)
    walk(node.children ?? node.props?.children)
  }
}
walk(tree)
const switches = flat.filter((node) => node.type === 'button' && node.props?.role === 'switch')
// 14 个布尔开关：6 个 enable* + blockMainAgentNativeVision + attachResultImages + cacheResults
// + persistTasks + requireSpendConfirm + 3 个 misc
assert.equal(switches.length, 14, 'fourteen boolean switches rendered')
assert.equal(switches.filter((node) => String(node.props['aria-label']).includes('field.enable')).length, 6, 'six enable* tool switches (ask_glm + ask_qwen + draw + video + task + report)')
assert.ok(
  switches.some((node) => String(node.props['aria-label']).includes('field.enableAskQwen')),
  'ask_qwen switch rendered next to ask_glm',
)
assert.ok(
  switches.some((node) => String(node.props['aria-label']).includes('field.blockMainAgentNativeVision')),
  'native-vision block switch rendered',
)
/** 重新渲染并拍平（describe 是异步的，需要再取一次树）。 */
const rerenderTree = () => {
  const nodes = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === "object" && node.type !== undefined) {
      nodes.push(node)
      visit(node.children ?? node.props?.children)
    }
  }
  visit(component(pageProps))
  return nodes
}

// 密钥行：三把 key 各一，走官方凭据服务（值不回显，凭服务不提供）
const mutationsBeforeKeys = mutations.length
const secretInputs = flat.filter((node) => node.type === "input" && node.props?.type === "password")
assert.equal(secretInputs.length, 3, "应渲染 3 个密钥输入框（实际 " + secretInputs.length + " 个）")
const secretLabels = secretInputs.map((node) => String(node.props["aria-label"]))
for (const expected of ["key.dashscope", "key.ark", "key.zhipu"]) {
  assert.ok(secretLabels.some((label) => label.includes(expected)), "缺少密钥行：" + expected)
}
for (const input of secretInputs) {
  assert.equal(input.props.autoComplete, "off", "密钥框应关闭浏览器自动填充：" + input.props["aria-label"])
  assert.equal(typeof input.props.onChange, "function", "密钥框必须可编辑：" + input.props["aria-label"])
  // 关键：服务不返回值，所以框里永远是空的 —— 不是"没显示"，而是拿不到
  assert.equal(input.props.value, "", "密钥框不得回显已存值（凭据服务不提供）：" + input.props["aria-label"])
}

// describe 是异步的：等一个微任务让 useEffect 里的调用落地
await new Promise((resolve) => setTimeout(resolve, 0))

// ---- 状态来自 describe：已配置 + 来自哪一层 ----
assert.equal(credentialCalls.some((call) => call.op === "describe"), true, "页面加载应调用 credentials.describe")
/** 取节点的纯文本（children 可能是字符串或数组）。 */
const textOf = (node) => (Array.isArray(node.children) ? node.children.flat(Infinity).join("") : String(node.children ?? ""))
// describe 的 Promise 在上面已 await；重新渲染以取到"已配置"状态的那一版树。
const afterDescribe = rerenderTree()
const credentialBadges = afterDescribe.filter((node) => /T:key.(set|unset)/.test(textOf(node)))
assert.equal(credentialBadges.length, 3, "三把 key 各有一个配置状态徽标（实际 " + credentialBadges.length + " 个）")
// 状态必须来自 describe：DashScope 来自环境层、Zhipu 来自凭据文件、Ark 未配置
const badgeTexts = credentialBadges.map(textOf)
assert.ok(badgeTexts.some((text) => text.includes("T:key.set") && text.includes("T:key.sourceEnv")), "应显示 来自环境变量：" + JSON.stringify(badgeTexts))
assert.ok(badgeTexts.some((text) => text.includes("T:key.set") && text.includes("T:key.sourceStore")), "应显示 来自凭据文件：" + JSON.stringify(badgeTexts))
assert.ok(badgeTexts.some((text) => text.includes("T:key.unset")), "未配置的应显示未配置：" + JSON.stringify(badgeTexts))

// ---- 交互：直接驱动渲染树里的按钮，验证真的调到凭据服务 ----
const rerender = () => {
  const nodes = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === "object" && node.type !== undefined) {
      nodes.push(node)
      visit(node.children ?? node.props?.children)
    }
  }
  visit(component(pageProps))
  return nodes
}
/** 按 aria-label 找按钮。 */
const findButton = (nodes, label) =>
  nodes.filter((node) => node.type === "button").find((node) => String(node.props["aria-label"] ?? "").includes(label))
/** 找到某把 key 的输入框并模拟输入。 */
const typeInto = (nodes, label, value) => {
  const input = nodes
    .filter((node) => node.type === "input")
    .find((node) => String(node.props["aria-label"]).includes(label))
  assert.ok(input, "找不到输入框：" + label)
  input.props.onChange({ target: { value } })
}

// 掩码 → 明文切换（纯客户端状态；重渲染会重新 describe，但绝不能 set/unset）
const writesBefore = () => credentialCalls.filter((call) => call.op !== "describe").length
const writesAtReveal = writesBefore()
const revealBtn = findButton(flat, "T:key.reveal T:key.dashscope")
assert.ok(revealBtn, "应有一个显示/隐藏按钮")
revealBtn.props.onClick()
const revealed = rerender().filter((node) => node.type === "input").find((node) => String(node.props["aria-label"]).includes("key.dashscope"))
assert.equal(revealed.props.type, "text", "点显示后应为明文")
assert.equal(writesBefore(), writesAtReveal, "切换显示不得产生任何凭据写入")

// 输入 + 点保存 → credentials.set(ref, value)
credentialCalls.length = 0
typeInto(rerender(), "key.dashscope", "sk-rotated-new-value")
const saveBtn = findButton(rerender(), "T:key.save T:key.dashscope")
assert.equal(saveBtn.props.disabled, false, "输入了值之后保存按钮应可用")
await saveBtn.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const setCall = credentialCalls.find((call) => call.op === "set")
assert.ok(setCall, "应调用 credentials.set")
assert.equal(setCall.ref, "DASHSCOPE_API_KEY", "ref 必须是环境变量名")
assert.equal(setCall.value, "sk-rotated-new-value")
assert.equal(mutations.length, mutationsBeforeKeys, "改密钥不得写 profile 配置（值不进配置文件）")

// 清除 → credentials.unset(ref)
credentialCalls.length = 0
const clearBtn = findButton(rerender(), "T:key.clear T:key.zhipu")
assert.ok(clearBtn, "已配置的 key 应有清除按钮")
await clearBtn.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(credentialCalls.find((call) => call.op === "unset")?.ref, "ZHIPU_API_KEY", "清除应调用 credentials.unset")

// 只读层（例如启动环境传入）必须挡住写入
credentialStore.set("ARK_API_KEY", { value: "a", source: "environment", writable: false })
rerender()
await new Promise((resolve) => setTimeout(resolve, 0))
// describe 是异步的：先重渲染触发一轮，等结果落地后再取树断言
const lockedRow = rerender().filter((node) => node.type === "input").find((node) => String(node.props["aria-label"]).includes("key.ark"))
assert.equal(lockedRow.props.disabled, true, "只读来源的密钥框应禁用")

// set 失败要有反馈，不能静默
credentialService.failNext = true
credentialCalls.length = 0
typeInto(rerender(), "key.dashscope", "sk-will-fail")
await findButton(rerender(), "T:key.save T:key.dashscope").props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.ok(
  rerender().some((node) => textOf(node).includes("T:key.failed")),
  "凭据写入失败应显示失败提示",
)

assert.ok(switches.some((node) => String(node.props['aria-label']).includes('field.enableSeedanceVideo') && node.props['aria-checked'] === true))
const buttons = flat.filter((node) => node.type === 'button').map((node) => (node.children ?? []).flat().join(''))
assert.ok(buttons.some((label) => label.includes('T:save')), 'save button rendered')
assert.ok(flat.some((node) => node.type === 'p' && String(node.children ?? '').includes('T:note')), 'note rendered')

// 官方获取入口：四把 key 各一个外链（方舟额外多一个"开通模型"入口，共 5 个），且必须带安全属性
const anchors = flat.filter((node) => node.type === 'a')
assert.equal(anchors.length, 5, '应渲染 5 个外链（4 个 key 入口 + 1 个方舟开通入口），实际 ' + anchors.length + ' 个')
const hrefs = anchors.map((node) => String(node.props?.href ?? ''))
for (const expected of ['alibabacloud.com', 'docs.volcengine.com', 'docs.bigmodel.cn', 'platform.deepseek.com']) {
  assert.ok(
    hrefs.some((href) => href.includes(expected)),
    '缺少入口链接：' + expected + '（实际 ' + JSON.stringify(hrefs) + '）',
  )
}
// 方舟的 key 与"模型开通"是两件事：只有 key 而没开通，调用任何模型都返回 404。
// 所以卡片必须同时给出"开通管理"入口（2026-10-15 实测踩到 InvalidEndpointOrModel.NotFound）。
assert.ok(
  hrefs.some((href) => href.includes('openManagement')),
  '缺少方舟"开通模型"入口（只有 key 链接会让用户卡在 404）：' + JSON.stringify(hrefs),
)
for (const anchor of anchors) {
  assert.ok(String(anchor.props.href).startsWith('https://'), '入口链接必须走 https：' + anchor.props.href)
  assert.equal(anchor.props.target, '_blank', '外链应新窗口打开：' + anchor.props.href)
  assert.ok(String(anchor.props.rel).includes('noreferrer'), '外链应带 rel=noreferrer：' + anchor.props.href)
}

// ---- 时间类字段的人类可读换算（2026-10-14）----
// 裸毫秒（`1800000`）谁也看不出是 30 分钟；而这些超时是**同步阻塞等待**，
// 填太长会把一整轮卡住，所以必须在卡片上看得见代价。
const textOfAll = (node) => (Array.isArray(node.children) ? node.children.flat(Infinity).join("") : String(node.children ?? ""))
const unitHints = rerenderTree().filter((node) => /T:unit\.(equals|durationHint)/.test(textOfAll(node))).map(textOfAll)
assert.ok(unitHints.length >= 4, '时间字段应有可读换算提示（实际 ' + unitHints.length + ' 个）')
assert.ok(unitHints.some((text) => text.includes('10 分钟')), '600000 应显示为 10 分钟：' + JSON.stringify(unitHints))
assert.ok(unitHints.some((text) => text.includes('30 分钟')), '1800000 应显示为 30 分钟：' + JSON.stringify(unitHints))

// 明显超长的同步等待要给警告（阈值 30 分钟），且只是提示、不产生写入
const beforeLong = mutations.length
props.edit('videoTimeoutMs', '7200000')
const longWarn = rerenderTree().filter((node) => /T:unit\.longWait/.test(textOfAll(node)))
assert.equal(longWarn.length, 1, '超长等待应给出警告（实际 ' + longWarn.length + ' 个）')
assert.equal(mutations.length, beforeLong, '仅渲染警告不得产生写入')
props.discard()

// 边界：**默认值绝不能自己触发警告**（出图 3 分钟、出片 15 分钟）
// —— 2026-10-14 踩过：出片默认 15 分钟，而阈值曾是 10 分钟，默认配置自己就报警。
props.edit('taskTimeoutMs', '180000')
const defaultTaskWarn = rerenderTree().filter((node) => /T:unit\.longWait/.test(textOfAll(node)))
assert.equal(defaultTaskWarn.length, 0, '出图默认 3 分钟不应报警')
props.discard()
props.edit('videoTimeoutMs', '900000')
const defaultVideoWarn = rerenderTree().filter((node) => /T:unit\.longWait/.test(textOfAll(node)))
assert.equal(defaultVideoWarn.length, 0, '出片默认 15 分钟不应报警（阈值必须高于所有默认值）')
props.discard()

console.log('[client-card] 全部通过：注册点 / 开关读写 / 非法值拦截 / 失败反馈 / 渲染 / Key 获取入口 / 时间单位')
