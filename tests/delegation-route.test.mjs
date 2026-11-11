/**
 * 窄委派的**模型路线可见性**验收（2026-11-11）。
 *
 * 背景：`subagent_script` 会把 `agentOptions = { provider, model }` 注进子代理，
 * 默认走 MiniMax 订阅路线。预检（`llm.resolveCallConfig`）不通过时会**回落到父路线** ——
 * 这个回落本身是对的（工具不能因此不可用），但以前它是**静默**的：
 * 工具返回永远同一句话、日志里也没有痕迹。于是"以为在花订阅额度、实际在花主路线
 * token"这件事在插件里没有任何观测点，与它在花钱路径上的 fail-closed + 可见相矛盾。
 *
 * 本文件钉住四条不变：
 *   1. 预检通过 → 注入 agentOptions，结果与渲染都说清走了哪条路；
 *   2. 预检失败 → **不注入**、warn 一次（带原因）、结果里写明"未注入 + 原因"；
 *   3. 显式关闭 / 配置写漏 → 也能区分（disabled 只记 debug，incomplete 要 warn）；
 *   4. 拿不到预检服务 → 照旧注入，但标"未预检"；`subagent_code` / `_research` 不受影响。
 *
 * 边界：**不联网、不花钱、不派真子代理**（subagents 是假的，只记录请求）。
 *
 * 运行：node --import ./tests/register.mjs ./tests/delegation-route.test.mjs
 */
import assert from 'node:assert/strict'

import { createDelegationTools } from '../tools/delegation.mjs'

const stats = { passed: 0, failed: 0 }
async function test(name, fn) {
  try {
    await fn()
    stats.passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    stats.failed += 1
    console.log('  ✗ ' + name)
    console.log('    ' + String(error?.stack ?? error).split('\n').slice(0, 5).join('\n    '))
  }
}

/**
 * 假宿主：只实现窄委派用到的三个面（llm 预检 / subagents 派出 / logger）。
 * @param {{ resolveCallConfig?: Function|'missing', config?: object }} [options] - 预检实现与配置覆盖。
 * @returns {object} 测试夹具。
 */
function makeHarness(options = {}) {
  const warnings = []
  const debugs = []
  const activations = []
  const ctx = {
    get(name) {
      if (name === 'llm') {
        if (options.resolveCallConfig === 'missing') return undefined
        return { resolveCallConfig: options.resolveCallConfig ?? (async () => ({ provider: 'x', model: 'y' })) }
      }
      if (name === 'subagents') {
        return {
          getProvider: () => ({ id: 'spawn' }),
          async startActivation(payload) {
            activations.push(payload)
            return { childId: 'child-' + activations.length }
          },
        }
      }
      return undefined
    },
  }
  const logger = {
    info() {},
    error() {},
    warn: (message) => warnings.push(String(message)),
    debug: (message) => debugs.push(String(message)),
  }
  const defaults = {
    scriptRouteEnabled: true,
    scriptProvider: 'minimax',
    scriptModel: 'MiniMax-M3.1-Flash',
    scriptReasoningEffort: '',
    scriptAgentPreset: 'mm-code',
    codeAgentPreset: 'mm-code',
    researchAgentPreset: 'mm-research',
    delegationMaxDepth: 1,
  }
  const tools = createDelegationTools({ ctx, config: { ...defaults, ...(options.config ?? {}) }, logger })
  return {
    tools,
    byName: new Map(tools.map((tool) => [tool.name, tool])),
    warnings,
    debugs,
    activations,
  }
}

/** 执行上下文的最小实现（窄委派只读 exec.agent / exec.signal）。 */
const exec = { agent: { id: 'main' }, signal: undefined }

/** 跑一次工具并把「结果 + 渲染文本」一起取出来。 */
async function run(harness, toolName = 'subagent_script') {
  const tool = harness.byName.get(toolName)
  const value = await tool.execute({ description: '跑测试', prompt: '把测试跑绿' }, exec)
  const [block] = tool.output.render({}, value)
  return { value, text: block.text, request: harness.activations.at(-1)?.request }
}

await test('预检通过 → 注入 agentOptions，结果与渲染都点名路线', async () => {
  const harness = makeHarness()
  const { value, text, request } = await run(harness)

  assert.deepEqual(request.agentOptions, { provider: 'minimax', model: 'MiniMax-M3.1-Flash' })
  assert.deepEqual(value.route, {
    applied: true,
    code: 'applied',
    provider: 'minimax',
    model: 'MiniMax-M3.1-Flash',
  })
  assert.ok(text.includes('minimax / MiniMax-M3.1-Flash'), '渲染要说清走了哪条路：' + text)
  assert.ok(!text.includes('未注入'), '成功时不该出现"未注入"：' + text)
  assert.equal(harness.warnings.length, 0, '成功路由不该 warn')
})

await test('预检失败 → 不注入、warn 一次、结果写明原因（本机的真实报错形态）', async () => {
  const harness = makeHarness({
    resolveCallConfig: async () => {
      throw new Error('LLM provider "minimax" is not allowed for this Session')
    },
  })
  const { value, text, request } = await run(harness)

  assert.equal(request.agentOptions, undefined, '预检失败绝不能偷偷注入一条路由')
  assert.equal(value.route.applied, false)
  assert.equal(value.route.code, 'unresolved')
  assert.ok(String(value.route.reason).includes('not allowed for this Session'), '原因要原样带回：' + value.route.reason)
  assert.equal(harness.warnings.length, 1, '要 warn 一次，不能静默')
  assert.ok(harness.warnings[0].includes('subagent_script') && harness.warnings[0].includes('unresolved'), harness.warnings[0])
  assert.ok(text.includes('未注入模型路线'), '渲染要告诉模型这条路没生效：' + text)
  assert.ok(text.includes('父会话路线'), '要说清实际走了哪条路：' + text)
  assert.ok(text.includes('not allowed for this Session'), '原因要能被看到：' + text)
})

await test('配置写漏（scriptModel 为空）→ incomplete 并 warn，而不是当成"没开"', async () => {
  const harness = makeHarness({ config: { scriptModel: '  ' } })
  const { value, text, request } = await run(harness)

  assert.equal(request.agentOptions, undefined)
  assert.equal(value.route.code, 'incomplete')
  assert.equal(harness.warnings.length, 1, '写漏是配置错误，要 warn')
  assert.ok(text.includes('incomplete'), text)
})

await test('scriptRouteEnabled=false → disabled 只记 debug、不注入、渲染说明继承父会话', async () => {
  const harness = makeHarness({ config: { scriptRouteEnabled: false } })
  const { value, text, request } = await run(harness)

  assert.equal(request.agentOptions, undefined)
  assert.equal(value.route.code, 'disabled')
  assert.equal(harness.warnings.length, 0, '显式关闭不是错误，不该 warn')
  assert.equal(harness.debugs.length, 1, '但要留痕（debug）')
  assert.ok(text.includes('继承父会话'), text)
})

await test('拿不到 llm 预检服务 → 仍注入，但标 unverified', async () => {
  const harness = makeHarness({ resolveCallConfig: 'missing' })
  const { value, text, request } = await run(harness)

  assert.deepEqual(request.agentOptions, { provider: 'minimax', model: 'MiniMax-M3.1-Flash' })
  assert.equal(value.route.applied, true)
  assert.equal(value.route.code, 'unverified')
  assert.ok(text.includes('未预检'), text)
  assert.equal(harness.warnings.length, 0, '没法预检不等于失败，不 warn')
})

await test('reasoningEffort 非空时一并注入', async () => {
  const harness = makeHarness({ config: { scriptReasoningEffort: 'max' } })
  const { request } = await run(harness)

  assert.deepEqual(request.agentOptions, {
    provider: 'minimax',
    model: 'MiniMax-M3.1-Flash',
    reasoningEffort: 'max',
  })
})

await test('subagent_code / subagent_research 不受脚本路由影响（没有 route 字段、不注入）', async () => {
  const harness = makeHarness()
  for (const name of ['subagent_code', 'subagent_research']) {
    const { value, text, request } = await run(harness, name)
    assert.equal(request.agentOptions, undefined, name + ' 不该注入脚本路线')
    assert.equal(Object.hasOwn(value, 'route'), false, name + ' 的结果不该有 route 字段')
    assert.ok(!text.includes('模型路线'), name + ' 的渲染不该提脚本路线：' + text)
  }
  assert.equal(harness.warnings.length, 0)
})

await test('超长多行错误被压成一行并限长（防止一条堆栈刷屏）', async () => {
  const harness = makeHarness({
    resolveCallConfig: async () => {
      throw new Error('第一行\n第二行\n' + 'x'.repeat(500))
    },
  })
  const { value } = await run(harness)

  assert.ok(!String(value.route.reason).includes('\n'), '不能带换行：' + value.route.reason)
  assert.ok(String(value.route.reason).length <= 160, '要限长，实际 ' + String(value.route.reason).length)
})

console.log('[delegation-route] 通过 ' + stats.passed + '，失败 ' + stats.failed)
if (stats.failed > 0) process.exit(1)
