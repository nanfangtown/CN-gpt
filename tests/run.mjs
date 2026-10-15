/**
 * 试运行：不安装 dsh、不联网、不花 key 的完整验收。
 *
 * 覆盖：配置默认值 → 5 个工具的注册面 → submit/poll/fetch 全链路 →
 *       错误归一化与固定文案 → 超时/取消保留 task_id → media_task 补下载 →
 *       成本账本两种后端 + 报表 → 健康探测 → 预算保护 → 附件退化路径。
 *
 * 运行：node --import ./tests/register.mjs ./tests/run.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠ 隔离 DSH_HOME（必须在任何插件代码 import 之前设好）。
// 不隔离的话，没显式传 imageCachePath / taskRegistryPath / ledgerPath 的用例会回落到
// `homedir()/.dsh`，**把测试数据写进用户真实的家目录**（2026-10-14 实测）。
// 指向进程临时目录下一个固定子目录；下面还会**先清空**它——否则上一轮残留的
// 出图缓存会让本轮命中缓存，真实提交链路就测不到了（2026-10-14 踩到，8 条用例挂）。
const TEST_HOME = join(tmpdir(), 'mm-models-test-home')
await rm(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

import { startMockProviders } from './mock-providers.mjs'
import { createFakeCtx, createFakeStorageDomain, makeExec, makePng } from './fixtures.mjs'
import { Config, apply } from '../index.js'
import { createTaskManager } from '../tasks/manager.mjs'
import { dashscopeImageAdapter } from '../tasks/adapters/dashscope-image.mjs'
import { arkVideoAdapter } from '../tasks/adapters/ark-video.mjs'
import { CODES, MediaError, classifyHttpError, fixedMessage, isPreSendError } from '../core/errors.mjs'
import { DEFAULT_PRICING, isPriced, pricingOf, pricingWarnings, renderCostReport, zeroPriceOverrides } from '../core/cost.mjs'
import { createCallBudget, normalizeSettingsOps } from '../core/tool-kit.mjs'
import { READER_FORBIDDEN_TOOLS, inspectReaderFilters, readerFilterViolation } from '../core/reader-guard.mjs'
import { downloadToFile, imageSize, mediaTypeFromBytes, shouldAttachImage } from '../core/deliver.mjs'

const stats = { passed: 0, failed: 0 }
const tmpRoots = []

async function test(name, fn) {
  try {
    await fn()
    stats.passed += 1
    console.log('  \u2713 ' + name)
  } catch (error) {
    stats.failed += 1
    console.log('  \u2717 ' + name)
    console.log('    ' + String(error?.stack ?? error).split('\n').slice(0, 4).join('\n    '))
  }
}

/**
 * guard / 监听器的注册顺序契约（**唯一的顺序耦合点**，集中在这里）。
 *
 * 为什么不能用"探行为"来选：工具开关 guard 在**全部开关都打开**时对所有工具
 * 都返回 undefined，此时没有任何探针能把"它"和别的 guard 区分开。
 * 所以这里不猜，而是把顺序写成显式常量，并在 fixtures 里给每个 guard 打上标签，
 * 让标签与实际顺序**对不上时立刻报错**，而不是静默选错对象。
 *
 * 顺序由 index.js 的 apply() 决定：先工具开关，后读图守卫。
 */
const GUARD_TOOL_SWITCH = 'tool-switch'
const GUARD_READER = 'reader-guard'
const GUARD_IMAGE_READ = 'image-read-guard'
const GUARD_VISION_DELEGATION = 'vision-delegation-guard'

function guardOf(fake, label) {
  const hit = (fake.guards ?? []).find((entry) => entry?.label === label)
  assert.ok(hit, `apply() 应注册 guard: ${label}（实际标签：${(fake.guards ?? []).map((entry) => entry?.label ?? '(无)').join(', ')}）`)
  return hit.fn
}

function makeConfig(mock, tmp, overrides = {}) {
  return new Config({
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
    ledgerPath: join(tmp, 'ledger.json'),
    ...overrides,
  })
}

function setup(mock, tmp, options = {}) {
  const config = makeConfig(mock, tmp, options.overrides)
  const credentials = { DASHSCOPE_API_KEY: 'test-dashscope-key', ARK_API_KEY: 'test-ark-key', ZHIPU_API_KEY: 'test-zhipu-key', ...(options.credentials ?? {}) }
  const fake = createFakeCtx({
    credentials,
    attachments: options.attachments,
    storageDomain: options.storageDomain,
    llmProviders: options.llmProviders ?? ['glm', 'deepseek-account'],
    saveImage: options.saveImage,
  })
  apply(fake.ctx, config)
  // 给 guard 打标签。这是**测试侧对注册顺序的显式断言**：顺序一变就在这里报错，
  // 而不是让后面某条用例拿着错误的 guard 静默跑出假绿。
  assert.equal(fake.guards.length, 4, 'apply() 应恰好注册四个 guard（工具开关 + 读图守卫 + 图片路径守卫 + 视觉委派守卫）')
  fake.guards[0].label = GUARD_TOOL_SWITCH
  fake.guards[1].label = GUARD_READER
  fake.guards[2].label = GUARD_IMAGE_READ
  fake.guards[3].label = GUARD_VISION_DELEGATION
  const tools = Object.fromEntries(fake.tools.map((definition) => [definition.name, definition]))
  return { config, fake, tools }
}

async function expectError(promise, code, contains) {
  let thrown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, 'expected the call to fail, but it resolved')
  if (code !== undefined) assert.equal(thrown.code, code, 'expected code ' + code + ', got ' + thrown.code + ': ' + thrown.message)
  if (contains !== undefined) {
    for (const needle of [].concat(contains)) assert.ok(String(thrown.message).includes(needle), 'expected message to include "' + needle + '": ' + thrown.message)
  }
  return thrown
}

async function makeTmp() {
  const root = await mkdtemp(join(tmpdir(), 'mm-models-test-'))
  tmpRoots.push(root)
  return root
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** volatile 字段在 Config 实例上是引用对象；断言时先解包。 */
function plain(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * 把 Config 实例包成 index.js 里 liveConfig 那样的解包 Proxy。
 * 必须这么做：volatile 字段在 Config 上是引用对象 `{ get() }`，
 * keys.mjs 用 `nonEmptyString(config[...])` 读取，直接读会拿到对象、
 * 被判成"没填"（实测过：字面值与自定义引用名都会被静默忽略）。
 */
function plainConfig(config) {
  return new Proxy(config, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
    },
  })
}

/**
 * 把一串配置写入操作折叠成"最终谁开着"，并按运行时的互斥仲裁（GLM 优先）算出生效结果。
 * 与设置卡/guard 的语义一致，用于断言互斥行为而不去逐条比对操作列表。
 */
function finalSwitchState(ops) {
  const raw = { enableAskGlm: false, enableAskQwen: false }
  for (const op of ops) {
    const name = op?.op === 'set' && Array.isArray(op.path) ? op.path[0] : undefined
    if (name !== undefined && Object.hasOwn(raw, name)) raw[name] = op.value === true
  }
  return { enableAskGlm: raw.enableAskGlm, enableAskQwen: raw.enableAskQwen && raw.enableAskGlm !== true }
}

function newExec(tmp, options = {}) {
  const controller = new AbortController()
  return { exec: makeExec({ cwd: tmp, sessionId: options.sessionId, signal: options.ignoreSignal ? undefined : controller.signal }), controller }
}

async function main() {
  const mock = await startMockProviders()
  console.log('\n[mm-models 试运行] 本地假厂商：' + mock.base + '\n')

  // ---------------------------------------------------------------- 配置与注册面
  await test('Config 默认值：三把 key 引用名 / 型号 / 超时 / 真实单价', async () => {
    const config = new Config({})
    assert.equal(plain(config.dashscopeApiKeyEnv), 'DASHSCOPE_API_KEY')
    assert.equal(plain(config.arkApiKeyEnv), 'ARK_API_KEY')
    assert.equal(plain(config.zhipuApiKeyEnv), 'ZHIPU_API_KEY')
    assert.equal(plain(config.qwenModel), 'qwen-image-3.0')
    assert.equal(plain(config.seedanceModel), 'doubao-seedance-2-5-260628')
    // 任务等待上限（2026-10-14 收紧）：出图 3 分钟、出片 15 分钟。
    // 它们是**同步阻塞**的等待上限，默认取"够用但早失败"；超时后仍可靠任务注册表找回。
    assert.equal(plain(config.taskTimeoutMs), 180000)
    assert.equal(plain(config.videoTimeoutMs), 900000)
    // 连续生成上限（2026-10-14 由 3 提到 6）：它限制"一口气连做几个"，空闲 60 秒后重置。
    assert.equal(plain(config.maxCallsPerTurn), 6)
    // 真实单价（**不是估算**）：
    //   - qwen-image-3.0：百炼官方 0.18 元/张（2026-10-13）；
    //   - doubao-seedance-1-0-pro-fast-251015：0.206 元/秒（2026-10-15 校准，
    //     媒体口径「1 条 5 秒 1080P = 1.03 元」，折算后 5 秒正好 1.03，零偏差）；
    //   - 其余型号查不到确定价格 → null = 未计价（**不是 0**，0 会被读成免费）。
    assert.equal(plain(config.pricing)['qwen-image-3.0'].unitPrice, 0.18)
    assert.equal(plain(config.pricing)['doubao-seedance-1-0-pro-fast-251015'].unitPrice, 0.206)
    assert.equal(plain(config.pricing)['glm-4.6v'].inputPrice, null)
    assert.equal(plain(config.promptSection), true)
  })

  await test('成本报表：未计价显式写「未计价」，不伪装成 0.0000', async () => {
    const at = new Date().toISOString()
    const records = [
      { at, sessionId: 's', adapter: 'dashscope-image', model: 'qwen-image-3.0', unitKind: 'image', units: 4, unitPrice: 0.18, currency: 'CNY', amount: 0.72 },
      { at, sessionId: 's', adapter: 'ark-video', model: 'doubao-seedance-1-0-pro-fast-251015', unitKind: 'second', units: 5, unitPrice: null, currency: 'CNY', amount: null },
    ]
    const text = renderCostReport({ records, config: { pricing: plain(new Config({}).pricing) }, scope: 'session' })
    assert.ok(text.includes('0.7200 CNY'), '已计价部分要算出金额：' + text)
    assert.ok(text.includes('未计价'), '未计价型号要显式标注：' + text)
    assert.ok(!/seedance-2\.0 \| 1 \| 5 second \| 0\.0000/.test(text), '未计价不得渲染成 0.0000：' + text)
    assert.ok(text.includes('实际花费高于此数'), '合计要说明还有未计价部分：' + text)
    assert.ok(!text.includes('undefined'), '不得出现 undefined 单位：' + text)
  })

  await test('apply() 注册 4 个工具 + 分工说明段落（ask_glm 由配置行提供）', async () => {
    const tmp = await makeTmp()
    const { fake, tools } = setup(mock, tmp)
    assert.deepEqual(Object.keys(tools).sort(), ['media_report', 'media_task', 'qwen_draw', 'seedance_video'])
    assert.equal(fake.sections.length, 1)
    assert.equal(fake.sections[0].name, 'mm-models:division')
    const sectionText = typeof fake.sections[0].text === 'function' ? fake.sections[0].text({}) : fake.sections[0].text
    assert.ok(sectionText.includes('主创') && sectionText.includes('不要为了使用工具而使用工具'))
    // 段落基本不列工具名（不泄漏能力）。**唯一有意的例外**是读图员：
    // 「图像任务禁令」必须点名 ask_glm / ask_qwen，否则没法下达"只许走这两条路"的指令。
    assert.ok(!/qwen_draw|seedance_video|media_task|media_report/.test(sectionText), '提示词段落不应出现其它工具名')
    assert.ok(sectionText.includes('ask_glm') && sectionText.includes('ask_qwen'), '读图路由策略必须点名两个读图员')
  })

  await test('提示词段落与开关无关：打开 seedance 后仍不出现其它工具名', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableSeedanceVideo: true, requireSpendConfirm: false  } })
    const sectionText = typeof fake.sections[0].text === 'function' ? fake.sections[0].text({}) : fake.sections[0].text
    assert.ok(!/qwen_draw|seedance_video|media_task|media_report/.test(sectionText))
  })

  await test('promptSection=false 时不注册段落', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { promptSection: false } })
    assert.equal(fake.sections.length, 0)
  })

  // ---------------------------------------------------------------- 工具开关
  await test('工具开关：seedance_video / 两个读图子代理默认关闭，guard 拒绝；其余默认放行', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp)
    const guard = guardOf(fake, GUARD_TOOL_SWITCH)
    const denied = guard({ name: 'seedance_video' })
    assert.equal(typeof denied, 'string')
    assert.ok(denied.includes('已关闭') && denied.includes('seedance_video'), denied)
    assert.equal(guard({ name: 'qwen_draw' }), undefined)
    assert.equal(guard({ name: 'bash' }), undefined, '不认识的名字不应被拦截')
    // 读图子代理默认两个都关：没有预设读图员，由用户在设置卡里二选一。
    assert.equal(typeof guard({ name: 'ask_glm' }), 'string', 'ask_glm 默认关闭')
    assert.equal(typeof guard({ name: 'ask_qwen' }), 'string', 'ask_qwen 默认关闭')
    assert.ok(guard({ name: 'ask_glm' }).includes('已关闭'), '两个都关时是普通"已关闭"，不是互斥文案')
  })

  await test('工具开关：打开后 guard 放行；新 agent 的 restrict 名单随开关变化', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableSeedanceVideo: true, requireSpendConfirm: false, enableAskGlm: true  } })
    const guard = guardOf(fake, GUARD_TOOL_SWITCH)
    assert.equal(guard({ name: 'seedance_video' }), undefined)
    assert.equal(guard({ name: 'ask_glm' }), undefined)

    const createdListener = fake.listeners.find((entry) => entry.event === 'agent/created')
    assert.ok(createdListener !== undefined, 'apply() 应监听 agent/created')
    const denyLists = []
    const agent = {
      ctx: {
        effect(callback) {
          const disposer = callback()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        tools: {
          restrict(filter) {
            denyLists.push(filter.deny)
            return () => {}
          },
        },
      },
    }
    createdListener.callback({ agent, source: 'test' })
    // 顺序无关比较：deny 名单的语义是集合，"谁先谁后"不是契约。
    assert.deepEqual([...denyLists.at(-1)].sort(), ['ask_qwen'], '开了 ask_glm 之后只有互斥的 ask_qwen 在 deny 名单里')

    const tmp2 = await makeTmp()
    const offSetup = setup(mock, tmp2)
    const offListener = offSetup.fake.listeners.find((entry) => entry.event === 'agent/created')
    offListener.callback({ agent, source: 'test' })
    assert.deepEqual([...denyLists.at(-1)].sort(), ['ask_glm', 'ask_qwen', 'seedance_video'].sort(), '关闭的工具应进入该 agent 的 deny 名单')
  })

  // ---------------------------------------------------------------- 读图子代理互斥
  await test('互斥：开了 ask_glm 则 ask_qwen 被拒；换成 ask_qwen 则 ask_glm 被拒', async () => {
    const tmp = await makeTmp()
    const glmOnly = setup(mock, tmp, { overrides: { enableAskGlm: true } })
    const glmGuard = guardOf(glmOnly.fake, GUARD_TOOL_SWITCH)
    assert.equal(glmGuard({ name: 'ask_glm' }), undefined)
    assert.equal(typeof glmGuard({ name: 'ask_qwen' }), 'string', 'ask_glm 开着时 ask_qwen 应被拒')

    const tmp2 = await makeTmp()
    const qwenOnly = setup(mock, tmp2, { overrides: { enableAskQwen: true } })
    const qwenGuard = guardOf(qwenOnly.fake, GUARD_TOOL_SWITCH)
    assert.equal(qwenGuard({ name: 'ask_qwen' }), undefined)
    assert.equal(typeof qwenGuard({ name: 'ask_glm' }), 'string', 'ask_qwen 开着时 ask_glm 应被拒')
  })

  await test('互斥：两个都是 true（手改配置）→ GLM 优先，冲突文案点名 ask_qwen', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskGlm: true, enableAskQwen: true } })
    const guard = guardOf(fake, GUARD_TOOL_SWITCH)
    assert.equal(guard({ name: 'ask_glm' }), undefined, '冲突时 GLM 生效')
    const denied = guard({ name: 'ask_qwen' })
    assert.ok(denied.includes('互斥') && denied.includes('ask_glm'), denied)
    // restrict 名单同样只压 ask_qwen。
    const createdListener = fake.listeners.find((entry) => entry.event === 'agent/created')
    const denyLists = []
    createdListener.callback({
      agent: { ctx: { effect: (cb) => cb() ?? (() => {}), tools: { restrict: (f) => (denyLists.push(f.deny), () => {}) } } },
      source: 'test',
    })
    assert.equal(denyLists.at(-1).includes('ask_glm'), false, 'GLM 不应被隐藏')
    assert.ok(denyLists.at(-1).includes('ask_qwen'), 'ask_qwen 应被隐藏')
  })

  await test('热更新：配置原地变更后，掩码会对账（无需新开会话）', async () => {
    // 起因：配置写入是 resolveConfig 原地更新，不重载插件；早期版本只在 agent/created
    // 算一次掩码，于是"在配置卡里切换读图子代理"在当前会话里不生效（要新开对话）。
    const tmp = await makeTmp()
    const { fake, config } = setup(mock, tmp)
    const created = fake.listeners.find((entry) => entry.event === 'agent/created')

    const denyLists = []
    const agent = {
      options: { provider: 'deepseek-account', model: 'deepseek-flash' },
      ctx: {
        effect: (callback) => {
          const disposer = callback()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        tools: {
          restrict(filter) {
            denyLists.push([...filter.deny])
            return () => {}
          },
        },
      },
    }

    created.callback({ agent, source: 'startup' })
    assert.ok(denyLists.length >= 1, '创建时应贴一次掩码')
    assert.ok(denyLists.at(-1).includes('ask_qwen'), '默认（两个读图员都关）应 deny ask_qwen')

    // 原地改实时配置：打开 ask_qwen（等价于在配置卡里保存）
    plain(config).enableAskQwen = true
    // 对账周期是 1s，等它跑一轮（不新开 agent、不触发任何事件）
    await new Promise((resolve) => setTimeout(resolve, 1300))

    const latest = denyLists.at(-1)
    assert.ok(!latest.includes('ask_qwen'), '打开 ask_qwen 后，掩码应在当前会话里撤销对它的 deny：' + JSON.stringify(latest))
    assert.ok(latest.includes('ask_glm'), '互斥的另一侧应被 deny：' + JSON.stringify(latest))

    // 反向：关掉 ask_qwen、打开 ask_glm
    plain(config).enableAskQwen = false
    plain(config).enableAskGlm = true
    await new Promise((resolve) => setTimeout(resolve, 1300))
    const flipped = denyLists.at(-1)
    assert.ok(!flipped.includes('ask_glm'), '打开 ask_glm 后不应再 deny 它：' + JSON.stringify(flipped))
    assert.ok(flipped.includes('ask_qwen'), 'ask_qwen 应被 deny：' + JSON.stringify(flipped))
  })

  await test('热更新：无变化时不重复贴掩码（避免掩码链无限增长）', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp)
    const created = fake.listeners.find((entry) => entry.event === 'agent/created')
    let calls = 0
    const agent = {
      options: { provider: 'p', model: 'm' },
      ctx: {
        effect: (callback) => {
          const disposer = callback()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        tools: {
          restrict() {
            calls += 1
            return () => {}
          },
        },
      },
    }
    created.callback({ agent, source: 'startup' })
    const afterCreate = calls
    await new Promise((resolve) => setTimeout(resolve, 1300))
    assert.equal(calls, afterCreate, '配置没变时不应再贴掩码（实际 ' + calls + ' 次，创建后 ' + afterCreate + ' 次）')
  })

  await test('normalizeSettingsOps：打开一个读图开关会自动补写关闭另一个', async () => {
    assert.deepEqual(normalizeSettingsOps([{ op: 'set', path: ['enableAskQwen'], value: true }]), [
      { op: 'set', path: ['enableAskQwen'], value: true },
      { op: 'set', path: ['enableAskGlm'], value: false },
    ])
    assert.deepEqual(normalizeSettingsOps([{ op: 'set', path: ['enableAskGlm'], value: true }]), [
      { op: 'set', path: ['enableAskGlm'], value: true },
      { op: 'set', path: ['enableAskQwen'], value: false },
    ])
    // 关闭一个开关不需要补写任何东西。
    assert.deepEqual(normalizeSettingsOps([{ op: 'set', path: ['enableAskGlm'], value: false }]), [
      { op: 'set', path: ['enableAskGlm'], value: false },
    ])
    // 同一个批量里两个都被显式赋值 → 末次写入胜出（不做"报错拒绝"，避免保存莫名失败）。
    // 中途可能出现"开了又关"的冗余 set，无害；只断言最终生效值。
    const bothOn = normalizeSettingsOps([
      { op: 'set', path: ['enableAskGlm'], value: true },
      { op: 'set', path: ['enableAskQwen'], value: true },
    ])
    assert.deepEqual(finalSwitchState(bothOn), { enableAskGlm: false, enableAskQwen: true }, '后者打开时应把前者关掉')
    const qwenThenGlm = normalizeSettingsOps([
      { op: 'set', path: ['enableAskQwen'], value: true },
      { op: 'set', path: ['enableAskGlm'], value: true },
    ])
    assert.deepEqual(finalSwitchState(qwenThenGlm), { enableAskGlm: true, enableAskQwen: false }, '反过来同理')
    // 冗余 set 只出现在"同一批量里两个都显式打开"这种病态输入里，正常路径只有两条。
    assert.equal(normalizeSettingsOps([{ op: 'set', path: ['enableAskGlm'], value: true }]).length, 2)
    // 无关字段原样通过，且不修改入参。
    const input = [{ op: 'set', path: ['enableQwenDraw'], value: false }]
    assert.deepEqual(normalizeSettingsOps(input), [{ op: 'set', path: ['enableQwenDraw'], value: false }])
    assert.deepEqual(input, [{ op: 'set', path: ['enableQwenDraw'], value: false }], '入参不应被修改')
  })

  // ---------------------------------------------------------------- qwen_draw 成功链路
  await test('qwen_draw：产物落盘 + 尺寸 + 图片内容块 + 账本一条记录', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {
      overrides: {
        // 这个用例专门验证"附图块"这条路径，所以显式打开 attachResultImages（默认是关的）。
        attachResultImages: true,
        pricing: { ...plain(new Config({}).pricing), 'qwen-image-3.0': { unit: 'image', unitPrice: 0.5, currency: 'CNY', asOf: '2026-10-12' } },
      },
    })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '一只鲸鱼在云海' }, exec)
    assert.ok(value.taskId.startsWith('sync-'), 'default qwen-image mode should be sync, got ' + value.taskId)
    assert.equal(value.images.length, 1)
    const image = value.images[0]
    assert.equal(image.mediaType, 'image/png')
    assert.equal(image.width, 4)
    assert.equal(image.height, 4)
    assert.ok(image.attachmentId.length > 0)
    assert.ok((await stat(image.path)).isFile(), 'image file should exist')
    const blocks = tools.qwen_draw.output.render({ prompt: 'x' }, value)
    assert.ok(blocks[0].text.includes('已生成 1 张图片'))
    assert.ok(blocks.some((block) => block.type === 'image' && block.attachment.attachmentId === image.attachmentId))
    const ledger = await readJson(join(tmp, 'ledger.json'))
    assert.equal(ledger.records.length, 1)
    assert.equal(ledger.records[0].adapter, 'dashscope-image')
    assert.equal(ledger.records[0].units, 1)
    assert.equal(ledger.records[0].unitPrice, 0.5)
    assert.equal(ledger.records[0].amount, 0.5)
    assert.equal(ledger.records[0].sessionId, 'sess-test')
    assert.ok(ledger.health['dashscope-image'].lastSuccess)
    const serialized = JSON.stringify(value)
    assert.ok(!serialized.includes('test-dashscope-key'), 'key must not leak into the tool result')
    assert.ok(!serialized.includes('127.0.0.1'), 'signed/artifact URLs must not leak into the tool result')
  })

  await test('qwen_draw：n=2 与 size 归一化（1024x768 → 1024*768）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp)
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '双图', n: 2, size: '1024x768' }, exec)
    assert.equal(value.images.length, 2)
    const submit = mock.state.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('multimodal-generation')).at(-1)
    assert.equal(submit.body.parameters.size, '1024*768')
    assert.equal(submit.body.parameters.n, 2)
    assert.equal(submit.body.input.messages[0].content[0].text, '双图')
    const ledger = await readJson(join(tmp, 'ledger.json'))
    assert.equal(ledger.records.at(-1).units, 2)
    // 真实单价 0.18 元/张 × 2 张 = 0.36（此前内置表是占位 0，所以这里才断言到金额）
    assert.equal(ledger.records.at(-1).unitPrice, 0.18)
    assert.equal(ledger.records.at(-1).amount, 0.36)
  })

  await test('qwen_draw 同步模式：一次 POST 直接出图，不轮询 /tasks', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp)
    const { exec } = newExec(tmp)
    const before = mock.state.requests.filter((entry) => entry.method === 'GET' && entry.path.includes('/dashscope/api/v1/tasks/')).length
    const value = await tools.qwen_draw.execute({ prompt: '同步模式不轮询' }, exec)
    const after = mock.state.requests.filter((entry) => entry.method === 'GET' && entry.path.includes('/dashscope/api/v1/tasks/')).length
    assert.equal(after - before, 0, 'sync mode must not poll /tasks')
    assert.equal(value.images.length, 1)
    const submit = mock.state.requests.filter((entry) => entry.method === 'POST').at(-1)
    assert.ok(submit.path.includes('multimodal-generation'), 'sync mode must use the multimodal-generation path')
    assert.ok(!('X-DashScope-Async' in submit.headers), 'sync mode must not send the async header')
  })

  await test('dashscopeImageMode=async：仍走异步轮询与 media_task 重查；sync 下 media_task 给可读说明', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async' } })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '异步模式' }, exec)
    assert.ok(value.taskId.startsWith('ds-'), 'async mode should return the vendor task id')
    const polls = mock.state.requests.filter((entry) => entry.method === 'GET' && entry.path.includes('/tasks/' + value.taskId)).length
    assert.ok(polls > 0, 'async mode must poll /tasks')
    const status = await tools.media_task.execute({ provider: 'qwen', task_id: value.taskId }, exec)
    assert.equal(status.status, 'succeeded')

    const syncTmp = await makeTmp()
    const syncSetup = setup(mock, syncTmp)
    const syncExec = newExec(syncTmp).exec
    const syncValue = await syncSetup.tools.qwen_draw.execute({ prompt: '同步 media_task' }, syncExec)
    const unsupported = await syncSetup.tools.media_task.execute({ provider: 'qwen', task_id: syncValue.taskId }, syncExec)
    assert.equal(unsupported.status, 'unsupported')
    assert.ok(unsupported.detail.includes('同步模式'))
  })

  await test('qwen_draw：任务"成功但没有产物字段" → 显式报错，不伪装成功', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp)
    const { exec } = newExec(tmp)
    const error = await expectError(tools.qwen_draw.execute({ prompt: '[noartifact] 空产物' }, exec), CODES.UNKNOWN, ['没有图片地址', '待实跑确证'])
    assert.ok(error.message.includes('待实跑确证'))
    const ledger = await readJson(join(tmp, 'ledger.json'))
    assert.equal(ledger.records.length, 0, 'failed task must not be recorded as usage')
  })

  // ---------------------------------------------------------------- 出图缓存（不重复计费）
  await test('出图缓存：相同 prompt+参数第二次命中，不再计费也不新增账本记录', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { imageCachePath: join(tmp, 'cache.json') } })
    const { exec } = newExec(tmp)

    const first = await tools.qwen_draw.execute({ prompt: '同一只鲸鱼', n: 1 }, exec)
    assert.ok(first.cached !== true, '首次应是真实调用')

    const postsAfterFirst = mock.state.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('multimodal-generation')).length
    const ledgerAfterFirst = (await readJson(join(tmp, 'ledger.json'))).records.length

    const second = await tools.qwen_draw.execute({ prompt: '同一只鲸鱼', n: 1 }, exec)
    assert.equal(second.cached, true, '第二次应命中缓存')
    assert.equal(second.images[0].path, first.images[0].path, '命中应复用同一份产物')
    assert.ok(second.taskId.startsWith('cache:'), '命中时 taskId 应标明是缓存：' + second.taskId)

    const postsAfterSecond = mock.state.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('multimodal-generation')).length
    assert.equal(postsAfterSecond, postsAfterFirst, '命中缓存后不应再发出图请求')
    const ledgerAfterSecond = (await readJson(join(tmp, 'ledger.json'))).records.length
    assert.equal(ledgerAfterSecond, ledgerAfterFirst, '命中缓存后不应新增账本记录（没花钱）')

    const text = tools.qwen_draw.output.render({}, second)[0].text
    assert.ok(text.includes('缓存命中'), '结果要明确标注是缓存命中：' + text)
  })

  await test('出图缓存：prompt 变了不命中；改 cacheKeySalt 让旧缓存全部失效', async () => {
    const tmp = await makeTmp()
    const cachePath = join(tmp, 'cache.json')
    const { tools } = setup(mock, tmp, { overrides: { imageCachePath: cachePath } })
    const { exec } = newExec(tmp)

    await tools.qwen_draw.execute({ prompt: '鲸鱼A' }, exec)
    const other = await tools.qwen_draw.execute({ prompt: '鲸鱼B' }, exec)
    assert.ok(other.cached !== true, 'prompt 不同不应命中')

    const registry = await readJson(cachePath)
    assert.equal(registry.entries.length, 2, '两个不同 prompt 应有两条缓存')

    // 改盐 = 强制重新生成（不必删文件）
    const salted = setup(mock, tmp, { overrides: { imageCachePath: cachePath, cacheKeySalt: 'v2' } })
    const afterSalt = await salted.tools.qwen_draw.execute({ prompt: '鲸鱼A' }, newExec(tmp).exec)
    assert.ok(afterSalt.cached !== true, '改了盐之后旧缓存不应再命中')
  })

  await test('出图缓存：产物被删除后不算命中（不返回死路径）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { imageCachePath: join(tmp, 'cache.json') } })
    const { exec } = newExec(tmp)
    const first = await tools.qwen_draw.execute({ prompt: '会被删掉的图' }, exec)
    await rm(first.images[0].path, { force: true })

    const second = await tools.qwen_draw.execute({ prompt: '会被删掉的图' }, exec)
    assert.ok(second.cached !== true, '产物没了就不该命中，应重新出图')
    assert.ok((await stat(second.images[0].path)).isFile(), '重新出图的产物应存在')
  })

  await test('出图缓存：cacheResults=false 时完全不走缓存', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { cacheResults: false, imageCachePath: join(tmp, 'cache.json') } })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: '不缓存' }, exec)
    const second = await tools.qwen_draw.execute({ prompt: '不缓存' }, exec)
    assert.ok(second.cached !== true, '关闭缓存后每次都应真实调用')
  })

  // ---------------------------------------------------------------- 任务注册表（整轮失败后捞回）
  await test('提交任务即登记；media_task(action=list) 能把它找回来', async () => {
    const tmp = await makeTmp()
    const registryPath = join(tmp, 'tasks.json')
    const { tools } = setup(mock, tmp, { overrides: { taskRegistryPath: registryPath } })
    const { exec } = newExec(tmp)

    const value = await tools.qwen_draw.execute({ prompt: '登记试试', n: 2 }, exec)
    assert.ok(value.taskId.length > 0)

    // 注册表文件应已落盘（默认走 JSON 文件后端；没有 storage 服务时）
    const registry = await readJson(registryPath)
    assert.equal(registry.tasks.length, 1, '提交后应登记一条')
    assert.equal(registry.tasks[0].taskId, value.taskId)
    assert.equal(registry.tasks[0].provider, 'qwen')
    assert.equal(registry.tasks[0].status, 'submitted')
    assert.equal(registry.tasks[0].n, 2)

    // list 动作应能列出来 —— 这正是"整轮挂了之后"的找回入口
    const listed = await tools.media_task.execute({ action: 'list' }, exec)
    assert.equal(listed.action, 'list')
    assert.equal(listed.tasks.length, 1)
    assert.equal(listed.tasks[0].taskId, value.taskId)
    assert.ok(listed.tasks[0].prompt.includes('登记试试'))
    const text = tools.media_task.output.render({ action: 'list' }, listed)[0].text
    assert.ok(text.includes(value.taskId), '列表要打出 task_id：' + text)

    // 按 provider 筛选
    const onlySeedance = await tools.media_task.execute({ action: 'list', provider: 'seedance' }, exec)
    assert.equal(onlySeedance.tasks.length, 0)
    const onlyQwen = await tools.media_task.execute({ action: 'list', provider: 'qwen' }, exec)
    assert.equal(onlyQwen.tasks.length, 1)
  })

  await test('persistTasks=false 时不登记（也不建文件）', async () => {
    const tmp = await makeTmp()
    const registryPath = join(tmp, 'tasks-off.json')
    const { tools } = setup(mock, tmp, { overrides: { persistTasks: false, taskRegistryPath: registryPath } })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: '不登记', n: 1 }, exec)
    await assert.rejects(stat(registryPath), '关闭后不应创建注册表文件')
    const listed = await tools.media_task.execute({ action: 'list' }, exec)
    assert.equal(listed.tasks.length, 0)
  })

  await test('注册表写坏了也不影响出图（尽力而为的旁路）', async () => {
    const tmp = await makeTmp()
    // 指向一个"目录"当文件用 → 写入必然失败
    const badPath = join(tmp, 'as-dir')
    await mkdir(badPath, { recursive: true })
    const { tools } = setup(mock, tmp, { overrides: { taskRegistryPath: badPath } })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '照样出图' }, exec)
    assert.ok(value.images.length === 1, '注册表失败不应影响出图结果')
    assert.ok(value.images[0].bytes > 0)
  })

  // ---------------------------------------------------------------- 用 read 读图片：拦住并指路
  await test('用 read 读图片会被拦下，且指引按"当前真实可用的工具"给', async () => {
    // 起因（2026-10-13 实测）：模型想看图 → 退而用通用 read 读 PNG，
    // 连撞两次只拿到 `cannot read "…png": binary file`（零指引），继续乱试白烧 token。
    //
    // ⚠ 这里**无条件拦**：读图片的字节流对文本模型毫无意义，原生读图开没开都一样。
    //   （第一版把这个条件写反了，写成"只在屏蔽原生读图时拦"，结果该拦时不拦。）
    const tmp = await makeTmp()
    const mainAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' } }

    // 情形 1：原生读图被屏蔽 + ask_glm 开着 → 指向 ask_glm
    const blocked = setup(mock, tmp, { overrides: { blockMainAgentNativeVision: true, enableAskGlm: true } })
    const guardBlocked = guardOf(blocked.fake, GUARD_IMAGE_READ)
    for (const target of ['D:\\work\\chibi_head.png', '/tmp/a.JPG', 'ref/x.webp', 'y.jpeg', 'z.gif']) {
      const reason = guardBlocked({ name: 'read', args: { file_path: target }, agent: mainAgent })
      assert.ok(typeof reason === 'string' && reason.length > 0, '应拦下：' + target)
      assert.ok(reason.includes('ask_glm'), '应指向当前开着的读图员：' + reason)
      assert.ok(!reason.includes('read_image'), '不该推荐已被屏蔽的 read_image：' + reason)
      assert.ok(reason.includes('不要用 read 重试'), '必须明确禁止重试：' + reason)
    }

    // 情形 2：原生读图可用 → 指向 read_image
    const tmp2 = await makeTmp()
    const native = setup(mock, tmp2)
    const reasonNative = guardOf(native.fake, GUARD_IMAGE_READ)({ name: 'read', args: { file_path: 'x.png' }, agent: mainAgent })
    assert.ok(reasonNative.includes('read_image'), '原生读图可用时应指向 read_image：' + reasonNative)

    // 情形 3：原生读图被屏蔽 + 读图员都没开 → 老实说没有途径（不能编一个不存在的工具）
    const tmp3 = await makeTmp()
    const none = setup(mock, tmp3, { overrides: { blockMainAgentNativeVision: true } })
    const reasonNone = guardOf(none.fake, GUARD_IMAGE_READ)({ name: 'read', args: { file_path: 'x.png' }, agent: mainAgent })
    assert.ok(reasonNone.includes('没有任何看图途径'), '没有途径时要说清楚：' + reasonNone)
    assert.ok(!reasonNone.includes('read_image'), '不该推荐已被屏蔽的 read_image：' + reasonNone)
    assert.ok(reasonNone.includes('读图员都没开'), '要说明读图员都没开，而不是说成可用：' + reasonNone)
    // 只有"真的没途径"时才需要把用户引到配置卡（有可用工具时不该多此一举）
    assert.ok(reasonNone.includes('gpt-CN'), '没途径时要指路到配置卡：' + reasonNone)

    // 不误伤：非图片、无路径、子代理、别的工具
    assert.equal(guardBlocked({ name: 'read', args: { file_path: 'D:\\work\\notes.md' }, agent: mainAgent }), undefined, '文本文件不该被拦')
    assert.equal(guardBlocked({ name: 'read', args: { file_path: 'src/icon.svg' }, agent: mainAgent }), undefined, 'svg 是文本，不该被拦')
    assert.equal(guardBlocked({ name: 'read', args: {}, agent: mainAgent }), undefined, '没有路径参数不该被拦')
    assert.equal(guardBlocked({ name: 'read', args: { file_path: 'x.png' }, agent: { options: { subagentDepth: 1 } } }), undefined, '子代理放行（读图员靠它）')
    assert.equal(guardBlocked({ name: 'bash', args: { file_path: 'x.png' }, agent: mainAgent }), undefined, '只针对 read 工具')
  })

  // ---------------------------------------------------------------- 委派子代理去读图：审计并拦截
  await test('委派子代理"读图"会被拦下；非视觉委派不受影响', async () => {
    // 起因（2026-10-13）：模型宁可 spawn 通用子代理替它读图，也不用 ask_glm/ask_qwen，
    // 那条路绕开读图员的只读契约、成本记账与互斥仲裁。
    // 只能在 guard 层审计：subagent 的注册属于官方包，插件无法全局摘除，也没有 spawn 钩子。
    const tmp = await makeTmp()
    const mainAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' } }

    const on = setup(mock, tmp, { overrides: { enableAskGlm: true } })
    const guard = guardOf(on.fake, GUARD_VISION_DELEGATION)

    const visionTasks = [
      '看一下 D:/work/chibi_head.png 画的是什么',
      '读取图片 D:/work/whale.png 并描述内容',
      '帮我看看这张截图有没有排版问题',
      'read the image at /tmp/a.jpg and describe it',
      'inspect the screenshot for layout issues',
      '图中人物是什么表情？',
    ]
    for (const prompt of visionTasks) {
      for (const tool of ['subagent', 'subagent_fork']) {
        const reason = guard({ name: tool, args: { description: '读图', prompt }, agent: mainAgent })
        assert.ok(typeof reason === 'string' && reason.length > 0, '应拦下：' + tool + ' / ' + prompt)
        assert.ok(reason.includes('ask_glm'), '应指向可用读图员：' + reason)
        assert.ok(reason.includes('已拦截'), '应明确说已拦截：' + reason)
        assert.ok(reason.includes('不要重试'), '应禁止重试：' + reason)
      }
    }

    // 不误伤：正常委派（无图片路径、无视觉意图）必须放行
    const fineTasks = [
      '帮我查一下 DSH 插件的 toolFilter API 怎么用',
      '重构 core/cost.mjs 并补单测',
      '分析这份 README 的结构是否清晰',
      '画一张鲸鱼的图', // 出图 ≠ 读图
      '用 qwen_draw 生成一张插画',
      'review my TypeScript code for bugs',
    ]
    for (const prompt of fineTasks) {
      assert.equal(
        guard({ name: 'subagent', args: { description: '干活', prompt }, agent: mainAgent }),
        undefined,
        '不应拦正常委派：' + prompt,
      )
    }

    assert.equal(guard({ name: 'subagent', args: { prompt: '看图 a.png' }, agent: { options: { subagentDepth: 1 } } }), undefined, '子代理放行')
    assert.equal(guard({ name: 'ask_glm', args: { prompt: '看图 a.png' }, agent: mainAgent }), undefined, '读图员本身放行')
    assert.equal(guard({ name: 'qwen_draw', args: { prompt: '看图 a.png' }, agent: mainAgent }), undefined, '非委派工具不审')
    assert.equal(guard({ name: 'subagent', args: {}, agent: mainAgent }), undefined, '空入参放行')

    // 没有可用读图员时：不能推荐不存在的工具，要说清"没途径"
    const off = await makeTmp()
    const offGuard = guardOf(setup(mock, off).fake, GUARD_VISION_DELEGATION)
    const noReader = offGuard({ name: 'subagent', args: { prompt: '看下 a.png' }, agent: mainAgent })
    assert.ok(noReader.includes('都没开'), '要说清读图员没开：' + noReader)
    assert.ok(noReader.includes('gpt-CN'), '要指路到配置卡：' + noReader)
    assert.ok(noReader.includes('没有任何看图途径'), '要说明没有途径：' + noReader)
  })

  // ---------------------------------------------------------------- 模型未开通：404 ≠ 参数错误
  await test('模型未开通/接入点不存在（404）→ MODEL_UNAVAILABLE，而不是"参数不被接受"', async () => {
    // 起因（2026-10-15 实测）：方舟对"模型 id 不对或账号没权限"返回 **HTTP 404**，
    // 而 404 在通用映射里落到 BAD_REQUEST，文案变成"参数不被接受…可尝试改 duration/size"——
    // 把"去控制台开通"说成了"改参数"，用户照着改永远改不好。
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { enableSeedanceVideo: true, requireSpendConfirm: false  } })
    const { exec } = newExec(tmp)
    const error = await expectError(tools.seedance_video.execute({ prompt: '[model] 测试' }, exec), CODES.MODEL_UNAVAILABLE)
    // 必须点明"不是参数问题"，否则模型会继续去调 duration/size
    assert.ok(error.message.includes('不是参数问题'), '要明确否定"参数问题"这个误导：' + error.message)
    assert.ok(error.message.includes('开通'), '要指向控制台开通：' + error.message)
    assert.ok(error.message.includes('ep-'), '要提示接入点 id 形态：' + error.message)
    assert.ok(/does not exist or you do not have access/.test(error.message), '要保留厂商原文：' + error.message)

    // 对照：真正的参数错误仍然归 BAD_REQUEST（提示改参数是对的）
    const params = await expectError(tools.seedance_video.execute({ prompt: '[bad] 测试' }, exec), CODES.BAD_REQUEST)
    assert.ok(params.message.includes('参数不被接受'), '真参数错误应保持原样：' + params.message)
  })

  // ---------------------------------------------------------------- 花费闸门（2026-10-15）
  await test('花费闸门：预估超限时在**提交前**拒绝，不产生任何费用', async () => {
    // 起因：出片按次计费且不可撤销。2026-10-15 因提交路径上没有金额校验，
    // 误建 22 个任务、账单 ¥195.97。闸门必须拦住"提交"这一步本身。
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {
      overrides: { enableSeedanceVideo: true, videoCostLimitCNY: 5 },
    })
    const { exec } = newExec(tmp)
    // mock 是共享的，前面用例的提交会留在 lastSubmit 里，所以用**时间戳**判断本次有没有提交
    const before = Date.now()
    // 2.5 单价 1.519 元/秒 × 5 秒 = ¥7.60 > ¥5 上限 → 应被拦
    const blocked = await expectError(
      tools.seedance_video.execute({ prompt: '闸门测试', duration: 5, confirm_estimate: 7.6 }, exec),
      CODES.BAD_REQUEST,
      ['超过', '未产生任何费用'],
    )
    assert.ok(blocked.message.includes('videoCostLimitCNY'), '要指出是哪个配置项：' + blocked.message)
    // 关键断言：本次没有任何提交到达厂商（证明拦在提交**之前**，而不是提交后报错）
    const last = mock.state.lastSubmit
    assert.ok(last === undefined || last.at < before, '被拦下时不该有任何提交到达厂商，实际收到 ' + JSON.stringify(last))

    // 上限设 0（不限）时应当放行
    const tmp2 = await makeTmp()
    const { tools: tools2 } = setup(mock, tmp2, {
      overrides: { enableSeedanceVideo: true, videoCostLimitCNY: 0 },
    })
    const { exec: exec2 } = newExec(tmp2)
    const value = await tools2.seedance_video.execute({ prompt: '闸门测试放行', duration: 5, confirm_estimate: 7.6 }, exec2)
    assert.equal(value.videos.length, 1, '上限为 0 时应正常出片（返回 1 个视频）')
    assert.equal(value.spec.duration, 5, '放行后 duration 应原样生效')
  })

  await test('花费闸门（会话累计）：防"反复试、每次都不贵"的烧钱模式', async () => {
    // 为什么需要第二层：2026-10-15 的事故形态是 22 次 4–30 秒的调用，
    // 单次上限 10 元会放行其中 10 次、合计 ¥71.69。单次闸挡不住"批量"。
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {
      overrides: {
        enableSeedanceVideo: true,
        videoCostLimitCNY: 0, // 单次不限，只测累计
        videoSessionCostLimitCNY: 10,
      },
    })
    const { exec } = newExec(tmp)
    // 默认模型 2.5 = 1.519 元/秒：4 秒 = ¥6.08 → 第一次放行（累计 ¥6.08 < ¥10），
    // 第二次 6.08 + 6.08 = ¥12.16 > ¥10 → 拦下。
    const first = await tools.seedance_video.execute({ prompt: '累计一', duration: 4, confirm_estimate: 6.08 }, exec)
    assert.equal(first.videos.length, 1, '第一次应放行（累计 ¥6.08 < ¥10）')
    const blocked = await expectError(
      tools.seedance_video.execute({ prompt: '累计二', duration: 4, confirm_estimate: 6.08 }, exec),
      CODES.BAD_REQUEST,
      ['会话累计上限', '未产生任何费用'],
    )
    assert.ok(blocked.message.includes('videoSessionCostLimitCNY'), '要指出是哪个配置项：' + blocked.message)
  })

  await test('花费闸门（确认层）：防"循环试参"——这是事故的真正根因', async () => {
    // 2026-10-15 事故复盘：肇事脚本逐个试 duration=2,3,4,…,30，用"返回 200 即通过"当判据。
    // 但 200 的真实含义是**任务已创建、已开始计费**——22 个任务、账单 ¥195.97。
    // 根因不是"参数算错"，而是**提交路径上没有任何强制意图声明**：
    // "探测参数"与"下单购买"在接口层面长得一模一样。
    //
    // 这个用例逐字复现那次肇事循环，断言：**它一次都提交不出去**。
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {
      overrides: {
        enableSeedanceVideo: true,
        // 上限全部放开——**只留确认层**，这样才能证明"确认"本身的作用，
        // 而不是被金额上限挡住（那样就测不出根因是否修好）。
        videoCostLimitCNY: 0,
        videoSessionCostLimitCNY: 0,
        requireSpendConfirm: true,
      },
    })
    const { exec } = newExec(tmp)
    const before = Date.now()
    let blocked = 0
    const durations = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 30]
    for (const duration of durations) {
      try {
        await tools.seedance_video.execute({ prompt: 'probe', duration }, exec)
      } catch (error) {
        if (error?.code === CODES.BAD_REQUEST) blocked += 1
        else throw error
      }
    }
    assert.equal(blocked, durations.length, '肇事循环的每一次调用都应被拦下，实际拦下 ' + blocked + '/' + durations.length)
    const last = mock.state.lastSubmit
    assert.ok(last === undefined || last.at < before, '肇事循环不该有任何一次提交到达厂商：' + JSON.stringify(last))

    // 对照：带上正确的预估金额后放行（证明闸门能放行，不是"永远打不开"）
    const value = await tools.seedance_video.execute({ prompt: '确认后出片', duration: 4, confirm_estimate: 6.08 }, exec)
    assert.equal(value.videos.length, 1, '确认金额正确后应正常出片')
    // 金额报错也要拦住：报一个不对的数
    const mismatch = await expectError(
      tools.seedance_video.execute({ prompt: '金额报错', duration: 4, confirm_estimate: 1 }, exec),
      CODES.BAD_REQUEST,
      ['对不上', '未产生任何费用'],
    )
    assert.ok(mismatch.message.includes('6.08'), '要给出正确金额供复述：' + mismatch.message)
  })

  // ------------------------------------------- 未计价路径（2026-10-15 第二轮：堵住自报金额绕过）
  await test('花费闸门（未计价）：自报金额不能当放行凭证', async () => {
    // 事故形态：2026-10-15 换模型 id 时忘了改单价表的键，于是该模型"查不到价"。
    // 初版闸门在未计价分支写的是"只要 confirm_estimate 是数字就放行"——
    // 等于调用方自己报一个数（`confirm_estimate: 1`）就能推开闸门，还顺带跳过单次/会话上限。
    // 现在的语义：金额算不出来时**只有人能放行**，数字在此完全不作数。
    const tmp = await makeTmp()
    const defaults = plain(new Config({}).pricing)
    const { 'doubao-seedance-2-5-260628': _dropped, ...withoutSeedance } = defaults
    const { tools } = setup(mock, tmp, {
      overrides: { enableSeedanceVideo: true, pricing: withoutSeedance },
    })
    const { exec } = newExec(tmp)
    const before = Date.now()

    // ① 不给确认 → 拒绝，且必须说明"未计价"与"不接受自报金额"
    const blocked = await expectError(
      tools.seedance_video.execute({ prompt: '未计价一', duration: 5 }, exec),
      CODES.BAD_REQUEST,
      ['未计价', '未产生任何费用'],
    )
    assert.ok(blocked.message.includes('allowUnpricedSpend'), '要点名放行开关：' + blocked.message)
    assert.ok(blocked.message.includes('自报金额'), '要说明"自报金额不作数"：' + blocked.message)

    // ② **关键**：带上一个看起来合理的自报金额，仍然不放行（这正是被堵住的那个洞）
    const bypass = await expectError(
      tools.seedance_video.execute({ prompt: '未计价二', duration: 5, confirm_estimate: 7.6 }, exec),
      CODES.BAD_REQUEST,
      ['未计价'],
    )
    assert.ok(bypass.message.includes('自报金额'), '自报金额必须被明确拒绝：' + bypass.message)

    // ③ 本次一个字都没提交到厂商
    const last = mock.state.lastSubmit
    assert.ok(last === undefined || last.at < before, '未计价时不该有任何提交：' + JSON.stringify(last))

    // ④ 用户打开 allowUnpricedSpend 后，仍须 confirm_unpriced 显式放行；
    //    只给数字（哪怕金额正确）也不算确认。
    const tmp2 = await makeTmp()
    const { tools: tools2 } = setup(mock, tmp2, {
      overrides: { enableSeedanceVideo: true, pricing: withoutSeedance, allowUnpricedSpend: true },
    })
    const { exec: exec2 } = newExec(tmp2)
    const stillBlocked = await expectError(
      tools2.seedance_video.execute({ prompt: '未计价三', duration: 5, confirm_estimate: 7.6 }, exec2),
      CODES.BAD_REQUEST,
      ['confirm_unpriced', '未产生任何费用'],
    )
    assert.ok(stillBlocked.message.includes('未知价格'), '要讲清这是"按未知价格出片"：' + stillBlocked.message)

    // ⑤ 开关 + confirm_unpriced=true → 放行（证明它不是"永远打不开"）
    const allowed = await tools2.seedance_video.execute(
      { prompt: '未计价四', duration: 5, confirm_unpriced: true },
      exec2,
    )
    assert.equal(allowed.videos.length, 1, '用户显式放行后应正常出片')
  })

  // ------------------------------------------- 单价表自检（2026-10-15 事故的"零告警"部分）
  await test('单价表自检：配置的模型查不到价时必须点名，不能静默锁死', async () => {
    // 事故的可修复部分：出片工具因为"模型 id 换了、单价键没换"而 fail-closed，
    // 但过程里**没有任何告警**，用户只看到"出片用不了"。
    const defaults = plain(new Config({}).pricing)
    const { 'doubao-seedance-2-5-260628': _dropped, ...withoutSeedance } = defaults

    const missing = pricingWarnings({ seedanceModel: 'doubao-seedance-2-5-260628', qwenModel: 'qwen-image-3.0', pricing: withoutSeedance })
    assert.equal(missing.length, 1, '应恰好报出出片模型缺价：' + JSON.stringify(missing))
    assert.ok(missing[0].includes('seedanceModel'), '要点名是哪个配置项引用了它：' + missing[0])
    assert.ok(missing[0].includes('doubao-seedance-2-5-260628'), '要点名具体模型 id：' + missing[0])
    assert.ok(missing[0].includes('fail-closed'), '要说明后果是"提交被拦"：' + missing[0])

    // 出厂默认表必须自洽：三个 seedance 真实模型 id 都在，且都有非零单价
    for (const id of ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-1-0-pro-fast-251015']) {
      assert.ok(isPriced(defaults[id]), '出厂表应给 ' + id + ' 配价')
      assert.ok(defaults[id].unitPrice > 0, id + ' 的单价必须 > 0（0 会被读成免费）：' + defaults[id].unitPrice)
    }
    // 默认配置（模型 id + 出厂表）必须零告警 —— 否则每次启动都在报警
    const clean = pricingWarnings({ seedanceModel: 'doubao-seedance-2-5-260628', qwenModel: 'qwen-image-3.0', pricing: defaults })
    assert.deepEqual(clean, [], '出厂配置不该有任何单价告警：' + JSON.stringify(clean))
  })

  await test('单价表自检：把出厂价写成 0 必须被点名（真钱不许显示成免费）', async () => {
    // 本机实况（2026-10-12 写的占位表）：qwen-image-3.0 单价 0，于是"16 张图"报 0.0000 CNY。
    const defaults = plain(new Config({}).pricing)
    const zeroed = {
      ...defaults,
      'qwen-image-3.0': { unit: 'image', unitPrice: 0, currency: 'CNY', asOf: '2026-10-12' },
    }
    const overrides = zeroPriceOverrides(zeroed)
    assert.equal(overrides.length, 1, '应报出 1 条被零价顶掉的条目：' + JSON.stringify(overrides))
    assert.equal(overrides[0].key, 'qwen-image-3.0')
    assert.ok(overrides[0].message.includes('免费'), '要说清"0 = 宣称免费"的后果：' + overrides[0].message)

    // 用 null 表达"未计价"同样是"把有价的东西写成没价"，一样要报（并且提示可以删键）
    const nulled = { ...defaults, 'qwen-image-3.0': { unit: 'image', unitPrice: null, currency: 'CNY' } }
    assert.equal(zeroPriceOverrides(nulled).length, 1, 'null 覆盖出厂价也要报出来')

    // 对照：用户**改价**（写自己的合同价）是允许的，不该报
    const repriced = { ...defaults, 'qwen-image-3.0': { unit: 'image', unitPrice: 0.5, currency: 'CNY' } }
    assert.equal(zeroPriceOverrides(repriced).length, 0, '改价是合法操作，不该报警')
  })

  // ---------------------------------------------------------------- 生成物附回上下文（默认关）
  await test('attachResultImages 默认关：只回路径，不插图块（避免大图拖垮整轮）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp)
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '一只鲸鱼在云海' }, exec)
    const blocks = tools.qwen_draw.output.render({ prompt: 'x' }, value)
    assert.equal(blocks.filter((block) => block.type === 'image').length, 0, '默认不应出现任何 image 块')
    const text = blocks.map((block) => block.text ?? '').join('\n')
    assert.ok(text.includes(value.images[0].path), '必须回文件路径：' + text)
    assert.ok(text.includes('未把图片内容附回上下文'), '应说明为何没有图块：' + text)
  })

  await test('attachResultImages 打开但超上限：仍只回路径', async () => {
    // 夹具图只有 73 字节，而 maxAttachImageBytes 有 step(1024)（最小 1024），
    // 走真实管线永远触发不了"超限"分支 —— 所以直接单测判定函数。
    const big = { attachmentId: 'att-big', bytes: 5_707_775, mediaType: 'image/png' }
    const small = { attachmentId: 'att-small', bytes: 73, mediaType: 'image/png' }
    assert.equal(shouldAttachImage({ attachResultImages: true, maxAttachImageBytes: 4194304 }, big), false, '5.7 MB 图超过 4 MiB 上限，应只回路径')
    assert.equal(shouldAttachImage({ attachResultImages: true, maxAttachImageBytes: 4194304 }, small), true)
    assert.equal(shouldAttachImage({ attachResultImages: true, maxAttachImageBytes: 0 }, big), true, '0 = 不限制')
    assert.equal(shouldAttachImage({ attachResultImages: false, maxAttachImageBytes: 0 }, small), false, '开关关着就不附')
    assert.equal(shouldAttachImage({ attachResultImages: true }, { bytes: 10 }), false, '缺 attachmentId 不附')
  })

  await test('attachResultImages 打开且在上限内：图块回来；0 = 不限制', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { attachResultImages: true, maxAttachImageBytes: 0 } })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '一只鲸鱼在云海' }, exec)
    const blocks = tools.qwen_draw.output.render({ prompt: 'x' }, value)
    assert.ok(blocks.some((block) => block.type === 'image'), '开关打开且不限额时应附图块')
  })

  // ---------------------------------------------------------------- 失败矩阵与固定文案
  const failureCases = [
    { marker: '[auth]', code: CODES.AUTH, contains: ['无效或已过期', '插件页 → gpt-CN → 配置卡'], posts: 1 },
    { marker: '[rate]', code: CODES.RATE_LIMIT, contains: ['任务未创建', '不会自动重发提交'], posts: 1 },
    { marker: '[policy]', code: CODES.POLICY_REJECTED, contains: ['策略拒绝'], posts: 1 },
    { marker: '[bad]', code: CODES.BAD_REQUEST, contains: ['参数不被接受', 'size'], posts: 1 },
    { marker: '[quota]', code: CODES.QUOTA, contains: ['余额'], posts: 1 },
    { marker: '[5xx]', code: CODES.UNAVAILABLE, contains: ['不会自动重发提交', 'media_task'], posts: 1 },
    { marker: '[conn]', code: CODES.UNAVAILABLE, contains: ['暂时不可用'], posts: 1 },
  ]
  for (const item of failureCases) {
    await test('qwen_draw 失败映射：' + item.marker + ' → ' + item.code + '（提交只发一次）', async () => {
      const tmp = await makeTmp()
      const { tools } = setup(mock, tmp)
      const { exec } = newExec(tmp)
      const before = mock.submitCount('qwen')
      await expectError(tools.qwen_draw.execute({ prompt: item.marker + ' 测试' }, exec), item.code, item.contains)
      assert.equal(mock.submitCount('qwen') - before, item.posts, 'submit POST count')
      const ledger = await readJson(join(tmp, 'ledger.json'))
      assert.equal(ledger.records.length, 0, 'failed task must not be recorded')
      assert.ok(ledger.health['dashscope-image'].lastFailure, 'failure should be noted in health')
    })
  }

  await test('缺 key → MISSING_CREDENTIAL（点名 key 与填写位置）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { credentials: { DASHSCOPE_API_KEY: undefined } })
    const { exec } = newExec(tmp)
    await expectError(tools.qwen_draw.execute({ prompt: 'x' }, exec), CODES.MISSING_CREDENTIAL, ['DASHSCOPE_API_KEY', '插件页 → gpt-CN → 配置卡'])
  })

  await test('提交（POST）只在"请求未发出"时重试一次；收到响应后绝不重发', async () => {
    const config = newConfigOnly()
    const manager = createTaskManager({ adapters: [dashscopeImageAdapter, arkVideoAdapter], config })
    const spec = { model: 'qwen-image-3.0', prompt: 'x', n: 1 }
    let calls = 0
    const preSend = async () => {
      calls += 1
      const error = new TypeError('fetch failed')
      error.cause = { code: 'ECONNREFUSED' }
      throw error
    }
    await expectError(manager.submit({ adapterId: 'dashscope-image', spec, credential: 'k', fetchImpl: preSend }), CODES.UNAVAILABLE, ['不会自动重发提交'])
    assert.equal(calls, 2, 'pre-send failure should retry exactly once')

    calls = 0
    const afterSend = async () => {
      calls += 1
      return new Response(JSON.stringify({ code: 'InternalError', message: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    await expectError(manager.submit({ adapterId: 'dashscope-image', spec, credential: 'k', fetchImpl: afterSend }), CODES.UNAVAILABLE)
    assert.equal(calls, 1, 'an answered 5xx must never be resent')
  })

  await test('isPreSendError：只有连接从未建立才算 pre-send', async () => {
    assert.equal(isPreSendError({ cause: { code: 'ECONNREFUSED' } }), true)
    assert.equal(isPreSendError({ cause: { code: 'ECONNRESET' } }), false)
    assert.equal(isPreSendError({ code: 'UND_ERR_ABORTED' }), false)
    assert.equal(isPreSendError(new TypeError('fetch failed')), false)
  })

  await test('classifyHttpError / 固定文案抽查', async () => {
    assert.equal(classifyHttpError(401, {}).code, CODES.AUTH)
    assert.equal(classifyHttpError(429, {}).code, CODES.RATE_LIMIT)
    assert.equal(classifyHttpError(500, {}).code, CODES.UNAVAILABLE)
    assert.equal(classifyHttpError(400, { code: 'DataInspectionFailed', message: 'x' }).code, CODES.POLICY_REJECTED)
    assert.equal(classifyHttpError(400, { code: 'InsufficientBalance', message: 'x' }).code, CODES.QUOTA)
    const timeout = fixedMessage(CODES.TIMEOUT, { providerKey: 'qwen', taskId: 'ds-9', timeoutMs: 600000 })
    assert.ok(timeout.includes('600 秒') && timeout.includes('ds-9') && timeout.includes('media_task(provider=qwen'))
    const aborted = fixedMessage(CODES.ABORTED, { taskId: 'ark-3' })
    assert.ok(aborted.includes('已取消本地等待') && aborted.includes('ark-3'))
  })

  // ---------------------------------------------------------------- 超时 / 取消保留 task_id
  await test('qwen_draw：等待超时 → TIMEOUT，保留 task_id，远端任务未取消且可重查', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async', taskTimeoutMs: 2000, taskPollIntervalMs: 500, taskPollMaxIntervalMs: 500 } })
    const { exec } = newExec(tmp)
    const before = mock.submitCount('qwen')
    const error = await expectError(tools.qwen_draw.execute({ prompt: '[stall] 永不完成' }, exec), CODES.TIMEOUT)
    assert.equal(mock.submitCount('qwen') - before, 1)
    const match = /task_id=([A-Za-z0-9_-]+)/.exec(error.message)
    assert.ok(match, 'timeout message should carry the task id')
    const taskId = match[1]
    const state = await tools.media_task.execute({ provider: 'qwen', task_id: taskId }, exec)
    assert.equal(state.taskId, taskId)
    assert.equal(state.status, 'running')
  })

  await test('qwen_draw：取消 → ABORTED，保留 task_id', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async', taskTimeoutMs: 10000, taskPollIntervalMs: 500, taskPollMaxIntervalMs: 500 } })
    const controller = new AbortController()
    const exec = makeExec({ cwd: tmp, signal: controller.signal })
    const pending = tools.qwen_draw.execute({ prompt: '[stall] 取消我' }, exec)
    // 等提交完成、进入轮询后再取消，确保 task_id 已保留。
    setTimeout(() => controller.abort(), 1200)
    const error = await expectError(pending, CODES.ABORTED, ['已取消本地等待'])
    // 取消路径保留的 id 必须是**它自己那个任务**的 id：抠出来回查一次。
    // （旧写法只断言 /[a-z]+-\d+/，连 "wait-3" 都能匹配，等于没验证。）
    const match = /（([A-Za-z0-9_-]+)）/.exec(error.message)
    assert.ok(match, 'ABORTED 文案里应带 task_id：' + error.message)
    const taskId = match[1]
    // 回查必须用**新的、未取消的** exec：原 exec 的 signal 已经 abort，
    // 拿它去查只会再拿一次 ABORTED，证明不了 id 有效。
    const state = await tools.media_task.execute({ provider: 'qwen', task_id: taskId }, makeExec({ cwd: tmp }))
    assert.equal(state.taskId, taskId)
    assert.equal(state.status, 'running', '远端任务不该被取消，仍应可重查')
  })

  // ---------------------------------------------------------------- 轮询退避重试（此前整层不可达）
  await test('轮询退避：第一次 429 → 自动退避重试并成功', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async', queryRetries: 1 } })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '[poll429] 先限流再成功' }, exec)
    assert.equal(value.images.length, 1)
    assert.ok((await stat(value.images[0].path)).isFile(), '产物应已落盘')
    const polls = mock.state.requests.filter((entry) => entry.method === 'GET' && entry.path.includes('/dashscope/api/v1/tasks/')).length
    assert.ok(polls >= 3, '应至少轮询 3 次（1 次 429 + 1 次 RUNNING + 1 次 SUCCEEDED），实际 ' + polls)
  })

  await test('轮询退避：第一次 503 → 同样被重试（UNAVAILABLE 亦属可重试）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async', queryRetries: 1 } })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '[poll503] 先 503 再成功' }, exec)
    assert.equal(value.images.length, 1)
  })

  await test('轮询退避：持续 500 → 重试耗尽后抛出，次数 = queryRetries + 1', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async', queryRetries: 1, taskTimeoutMs: 4000 } })
    const { exec } = newExec(tmp)
    const before = mock.state.requests.filter((entry) => entry.method === 'GET' && entry.path.includes('/dashscope/api/v1/tasks/')).length
    const error = await expectError(tools.qwen_draw.execute({ prompt: '[pollfail] 一直 500' }, exec), CODES.UNAVAILABLE)
    const polls = mock.state.requests.filter((entry) => entry.method === 'GET' && entry.path.includes('/dashscope/api/v1/tasks/')).length - before
    assert.equal(polls, 2, 'queryRetries=1 → 共 2 次尝试，实际 ' + polls)
    assert.match(error.message, /暂时不可用/, '应给 UNAVAILABLE 的固定人话')
  })

  // ---------------------------------------------------------------- 产物下载重试与体积上限（此前整层不可达）
  await test('产物下载：404 是确定性失败 → 只尝试一次，绝不重下', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {})
    const { exec } = newExec(tmp)
    const before = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length
    const error = await expectError(tools.qwen_draw.execute({ prompt: '[art404] 产物不存在' }, exec), CODES.UNAVAILABLE)
    const hits = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length - before
    assert.equal(hits, 1, 'HTTP 404 不该重试，实际下载尝试 ' + hits + ' 次')
    assert.match(error.message, /404/)
  })

  await test('产物下载：第一次 503 是瞬时失败 → 重试后成功', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {})
    const { exec } = newExec(tmp)
    const before = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length
    const value = await tools.qwen_draw.execute({ prompt: '[art5xx-then-ok] 抖一下' }, exec)
    const hits = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length - before
    assert.equal(value.images.length, 1)
    assert.ok((await stat(value.images[0].path)).isFile(), '重试后产物应落盘')
    assert.equal(hits, 2, '应恰好重试一次，实际 ' + hits)
  })

  await test('产物体积上限：声明超限 → 快速拒绝且只尝试一次', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { maxDownloadBytes: 1024 * 1024 } })
    const { exec } = newExec(tmp)
    const before = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length
    const error = await expectError(tools.qwen_draw.execute({ prompt: '[artbig-header] 太大' }, exec), CODES.BAD_REQUEST)
    const hits = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length - before
    assert.equal(hits, 1, '体积超限不该重试，实际 ' + hits + ' 次')
    assert.match(error.message, /超过上限/)
  })

  await test('产物体积上限：未声明长度但流式超限 → 中途中止且只尝试一次', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { maxDownloadBytes: 1024 * 1024 } })
    const { exec } = newExec(tmp)
    const before = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length
    const error = await expectError(tools.qwen_draw.execute({ prompt: '[artbig-stream] 流式太大' }, exec), CODES.BAD_REQUEST)
    const hits = mock.state.requests.filter((entry) => entry.path.startsWith('/art/')).length - before
    assert.equal(hits, 1, '流式中止后同样不该重试，实际 ' + hits + ' 次')
    assert.match(error.message, /超过上限/)
  })

  // ---------------------------------------------------------------- 下载失败的 retriable 分类（downloadToFile 直测）
  await test('downloadToFile：失败的 retriable 分类正确（确定性 vs 瞬时）', async () => {
    const tmp = await makeTmp()
    const make = (status, body) => async () => ({
      ok: status < 400,
      status,
      headers: new Map([['content-type', 'application/json']]),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      body: null,
    })
    const tooBig = Buffer.alloc(2048, 1)
    // 声明长度即超限 → BAD_REQUEST 且不可重试
    const declared = await downloadToFile('http://127.0.0.1/art/a.png', {
      outDir: join(tmp, 'dl'),
      maxBytes: 1024,
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Map([['content-length', '2048']]), arrayBuffer: async () => tooBig.buffer, body: null }),
    }).catch((error) => error)
    assert.ok(declared instanceof MediaError, '应抛 MediaError 而不是裸 Error')
    assert.equal(declared.code, CODES.BAD_REQUEST)
    assert.equal(declared.retriable, false)

    const notFound = await downloadToFile('http://127.0.0.1/art/none.png', { outDir: join(tmp, 'dl'), maxBytes: 1024, fetchImpl: make(404, Buffer.from('{}')) }).catch((error) => error)
    assert.equal(notFound.retriable, false, 'HTTP 404 不该重试')

    const serverError = await downloadToFile('http://127.0.0.1/art/boom.png', { outDir: join(tmp, 'dl'), maxBytes: 1024, fetchImpl: make(503, Buffer.from('{}')) }).catch((error) => error)
    assert.equal(serverError.retriable, true, 'HTTP 503 应该可重试')

    const network = await downloadToFile('http://127.0.0.1/art/net.png', { outDir: join(tmp, 'dl'), maxBytes: 1024, fetchImpl: async () => { throw new Error('socket hang up') } }).catch((error) => error)
    assert.equal(network.retriable, true, '网络异常应该可重试')
  })

  // ---------------------------------------------------------------- 调用预算（Map 清理 / 60 秒重置 / 扣减时机）
  await test('createCallBudget：60 秒空闲后重置，且过期会话会被清扫', async () => {
    const budget = createCallBudget({ maxCallsPerTurn: 1, idleResetMs: 40 })
    assert.equal(budget.take('s1').ok, true)
    assert.equal(budget.take('s1').ok, false, '同一会话第二次应被拒')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(budget.take('s1').ok, true, '空闲超过 idleResetMs 后应重置')
    assert.equal(budget.size(), 1)
    // 灌入一批会话，触发惰性清扫：只有最近用过的 s1 应该留下。
    await new Promise((resolve) => setTimeout(resolve, 60))
    for (let index = 0; index < 80; index += 1) budget.take('bulk-' + index)
    assert.ok(budget.size() <= 80, '清扫应把已过期的 s1 删掉，实际 ' + budget.size())
  })

  await test('qwen_draw：参数错/缺 key 不消耗配额（配额只在提交前扣）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { maxCallsPerTurn: 1 } })
    const { exec } = newExec(tmp)
    // 两次无效调用：空 prompt、缺 key。它们都不该花掉名额。
    await expectError(tools.qwen_draw.execute({ prompt: '   ' }, exec), CODES.BAD_REQUEST)
    const noKeyTmp = await makeTmp()
    const noKey = setup(mock, noKeyTmp, { overrides: { maxCallsPerTurn: 1 }, credentials: { DASHSCOPE_API_KEY: undefined } })
    await expectError(noKey.tools.qwen_draw.execute({ prompt: '缺 key' }, makeExec({ cwd: noKeyTmp })), CODES.MISSING_CREDENTIAL)
    // 唯一的那次配额应该还在。
    const value = await tools.qwen_draw.execute({ prompt: '正常出图' }, exec)
    assert.equal(value.images.length, 1)
  })

  // ---------------------------------------------------------------- media_task
  await test('media_task：status 重查 + download 补下载（异步模式）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async' } })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '补下载测试' }, exec)
    const status = await tools.media_task.execute({ provider: 'qwen', task_id: value.taskId }, exec)
    assert.equal(status.status, 'succeeded')
    assert.equal(status.artifactCount, 1)
    const recoveredRoot = join(tmp, 'recovered')
    const downloaded = await tools.media_task.execute({ provider: 'qwen', task_id: value.taskId, action: 'download', out_dir: recoveredRoot }, exec)
    assert.equal(downloaded.files.length, 1)
    assert.ok((await stat(downloaded.files[0].path)).isFile())
    const text = tools.media_task.output.render({}, downloaded)[0].text
    assert.ok(text.includes('succeeded') && text.includes(downloaded.files[0].path))
  })

  await test('media_task：错误 provider / 空 task_id / 缺 key 的参数校验', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { credentials: { ARK_API_KEY: undefined } })
    const { exec } = newExec(tmp)
    await expectError(tools.media_task.execute({ provider: 'nope', task_id: 'x' }, exec), CODES.BAD_REQUEST)
    await expectError(tools.media_task.execute({ provider: 'qwen', task_id: '   ' }, exec), CODES.BAD_REQUEST)
    await expectError(tools.media_task.execute({ provider: 'seedance', task_id: 'ark-1' }, exec), CODES.MISSING_CREDENTIAL, ['ARK_API_KEY'])
  })

  // ---------------------------------------------------------------- seedance_video
  await test('seedance_video：文生视频落盘 + 按秒记账 + 渲染', async () => {
    const tmp = await makeTmp()
    const { config, tools } = setup(mock, tmp, {
      overrides: { requireSpendConfirm: false, pricing: { ...plain(new Config({}).pricing), 'doubao-seedance-2-5-260628': { unit: 'second', unitPrice: 1.519, currency: 'CNY', asOf: '2026-10-15' } } },
    })
    const { exec } = newExec(tmp)
    const value = await tools.seedance_video.execute({ prompt: '海浪拍岸', duration: 5 }, exec)
    assert.ok(value.taskId.startsWith('ark-'))
    assert.equal(value.videos.length, 1)
    assert.ok((await stat(value.videos[0].path)).isFile())
    assert.equal(value.videos[0].mediaType, 'video/mp4')
    const text = tools.seedance_video.output.render({}, value)[0].text
    assert.ok(text.includes(value.videos[0].path) && text.includes('5s'))
    const ledger = await readJson(plain(config.ledgerPath))
    const record = ledger.records.at(-1)
    assert.equal(record.adapter, 'ark-video')
    assert.equal(record.unitKind, 'second')
    assert.equal(record.units, 5)
    // 新默认单价 0.206 元/秒（媒体口径 1 条 5 秒 1080P = 1.03 元）
    assert.equal(record.amount, 7.595)
  })

  await test('seedance_video：图生视频把本地首帧转成 data URL 并放进 content 数组', async () => {
    const tmp = await makeTmp()
    // 这个用例验证"首帧图怎么进 content 数组"，不是支付流程，故走确认层逃生口。
    const { tools } = setup(mock, tmp, { overrides: { requireSpendConfirm: false } })
    const { exec } = newExec(tmp)
    const pngPath = join(tmp, 'frame.png')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(pngPath, makePng(3, 3))
    const value = await tools.seedance_video.execute({ prompt: '让画面动起来', image: pngPath, duration: 5 }, exec)
    assert.ok(value.taskId.startsWith('ark-'))
    const submit = mock.state.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('/contents/generations/tasks')).at(-1)
    const imageEntry = submit.body.content.find((entry) => entry.type === 'image_url')
    assert.ok(imageEntry !== undefined, 'content should carry image_url')
    assert.ok(imageEntry.image_url.url.startsWith('data:image/png;base64,'))
    assert.equal(submit.body.duration, 5)
  })

  // ---------------------------------------------------------------- media_report
  await test('media_report(cost)：scope=session/all 数字自洽并带免责声明', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {
      overrides: {
        requireSpendConfirm: false,
        pricing: {
          ...plain(new Config({}).pricing),
          'qwen-image-3.0': { unit: 'image', unitPrice: 0.5, currency: 'CNY', asOf: '2026-10-12' },
          'doubao-seedance-2-5-260628': { unit: 'second', unitPrice: 1.519, currency: 'CNY', asOf: '2026-10-15' },
        },
      },
    })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: '报告用图' }, exec)
    await tools.seedance_video.execute({ prompt: '报告用视频', duration: 5 }, exec)
    const session = await tools.media_report.execute({ action: 'cost' }, exec)
    assert.ok(session.report.includes('qwen-image-3.0'))
    assert.ok(session.report.includes('doubao-seedance-1-0-pro-fast-251015'))
    assert.ok(session.report.includes('合计：8.0950 CNY'))
    assert.ok(session.report.includes('估算值，非账单'))
    assert.ok(session.report.includes('读图子代理（ask_glm / ask_qwen，当前路由：'), '要交代读图子代理这条链路的计费状态')
    // 2026-10-15 加：这一格必须说清"为什么算不出来"＋"去哪儿看真实用量"，
    // 而不只是一句"未计入"（宿主没有请求级钩子，插件确实拦不到，详见 core/cost.mjs）。
    assert.ok(session.report.includes('没有请求级钩子'), '要说明未计入的原因：' + session.report)
    const today = await tools.media_report.execute({ action: 'cost', scope: 'today' }, exec)
    assert.ok(today.report.includes('合计：8.0950 CNY'))
    const other = await tools.media_report.execute({ action: 'cost', scope: 'session' }, makeExec({ cwd: tmp, sessionId: 'other-session' }))
    assert.ok(other.report.includes('没有符合条件的用量记录'))
  })

  await test('media_report(health)：三把 key 状态 + 最近成功/失败 + 探测 + GLM 读图路由', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {
      credentials: { ZHIPU_API_KEY: undefined },
      llmProviders: ['glm', 'deepseek-account'],
      overrides: { enableSeedanceVideo: true, requireSpendConfirm: false, enableAskGlm: true  },
    })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: '健康报告用图' }, exec)
    const health = await tools.media_report.execute({ action: 'health' }, exec)
    assert.ok(health.report.includes('DASHSCOPE_API_KEY'))
    assert.ok(health.report.includes('✅ 已配置'))
    assert.ok(health.report.includes('ZHIPU_API_KEY'))
    assert.ok(health.report.includes('❌ 未配置'))
    assert.ok(health.report.includes('读图路由（ask_glm → llm-pi-ai providers.glm）'))
    assert.ok(health.report.includes('✅ 已注册'))
    assert.ok(health.report.includes('qwen_draw: ✅ 可用'))
    assert.ok(health.report.includes('seedance_video: ✅ 可用'))
    assert.ok(health.report.includes('ask_qwen: ⛔ 已在设置中关闭'), '互斥下 ask_qwen 应显示为关闭而不是"不可用"')
    assert.ok(health.report.startsWith('# 链路健康'))
  })

  await test('media_report(health)：切到 ask_qwen → 报告 qwen-vl 路由，并在冲突时点出被压制的一方', async () => {
    const tmp = await makeTmp()
    const only = setup(mock, tmp, {
      llmProviders: ['glm', 'qwen-vl', 'deepseek-account'],
      overrides: { enableAskQwen: true },
    })
    const { exec } = newExec(tmp)
    const report = (await only.tools.media_report.execute({ action: 'health' }, exec)).report
    assert.ok(report.includes('读图路由（ask_qwen → llm-pi-ai providers.qwen-vl）'), report)
    assert.ok(report.includes('ask_qwen: ✅ 可用'), report)
    assert.ok(report.includes('ask_glm: ⛔ 已在设置中关闭'), report)
    assert.ok(!report.includes('⚠ 与'), '只有一个读图子代理开启时不应报冲突')

    // 手改配置把两个都打开：报告应点名冲突，并说明谁被压制。
    const tmp2 = await makeTmp()
    const both = setup(mock, tmp2, {
      llmProviders: ['glm', 'qwen-vl', 'deepseek-account'],
      overrides: { enableAskGlm: true, enableAskQwen: true },
    })
    const conflictReport = (await both.tools.media_report.execute({ action: 'health' }, newExec(tmp2).exec)).report
    assert.ok(conflictReport.includes('⚠ 与 ask_qwen 同时处于开启状态'), conflictReport)
    assert.ok(conflictReport.includes('ask_glm: ✅ 可用'), conflictReport)
    assert.ok(conflictReport.includes('ask_qwen: ⛔ 已在设置中关闭'), conflictReport)
  })

  await test('media_report(health)：ask_qwen 的 qwen-vl 路由缺失时点明要检查哪一行', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, {
      llmProviders: ['glm', 'deepseek-account'], // 没注册 qwen-vl
      overrides: { enableAskQwen: true },
    })
    const report = (await tools.media_report.execute({ action: 'health' }, newExec(tmp).exec)).report
    assert.ok(report.includes('❌ 未注册（检查 llm-pi-ai providers.qwen-vl 配置）'), report)
    assert.ok(report.includes('ask_qwen: ❌ 当前不可用'), report)
  })

  await test('media_report(health)：错误 key 的探测区分 AUTH，缺 key 的链路标记不可用', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { credentials: { DASHSCOPE_API_KEY: 'wrong-key', ARK_API_KEY: undefined }, overrides: { enableSeedanceVideo: true, requireSpendConfirm: false  } })
    const { exec } = newExec(tmp)
    const health = await tools.media_report.execute({ action: 'health' }, exec)
    assert.ok(health.report.includes('AUTH'), 'dashscope probe should report AUTH: ' + health.report)
    assert.ok(health.report.includes('qwen_draw: ❌ 当前不可用'))
    assert.ok(health.report.includes('seedance_video: ❌ 当前不可用'))
  })

  await test('media_report(health)：报告里必须有「单价表」段，且缺价/零价都在对话里可见', async () => {
    // 为什么钉这条：2026-10-15 的那次故障（出片锁死 + 真钱显示成免费）**在对话里完全看不见**——
    // 用户只能看到"出片用不了"，没有任何线索指向单价表。日志里的告警也容易被忽略。
    // 所以自检结果必须出现在 health 报告里。
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { enableSeedanceVideo: true, requireSpendConfirm: false } })
    const { exec } = newExec(tmp)
    const ok = await tools.media_report.execute({ action: 'health' }, exec)
    assert.ok(ok.report.includes('## 单价表'), 'health 报告要含单价表段：' + ok.report)
    assert.ok(ok.report.includes('doubao-seedance-2-5-260628'), '要点名在用的出片模型 id')
    assert.ok(ok.report.includes('✅ 已计价'), '出厂配置应显示已计价：' + ok.report)
    assert.ok(ok.report.includes('自检：✅ 未发现问题'), '干净配置应显式说明自检通过：' + ok.report)

    // 对照：把出片模型的价格删掉 → 报告必须点出来，而不是静默
    const tmp2 = await makeTmp()
    const defaults = plain(new Config({}).pricing)
    const { 'doubao-seedance-2-5-260628': _dropped, ...withoutSeedance } = defaults
    const { tools: tools2 } = setup(mock, tmp2, {
      overrides: { enableSeedanceVideo: true, requireSpendConfirm: false, pricing: withoutSeedance },
    })
    const { exec: exec2 } = newExec(tmp2)
    const bad = await tools2.media_report.execute({ action: 'health' }, exec2)
    assert.ok(bad.report.includes('❌ **未计价**'), '缺价的模型要标红：' + bad.report)
    assert.ok(bad.report.includes('自检：❌ 发现 1 个问题'), '自检要报出问题条数：' + bad.report)
    assert.ok(bad.report.includes('seedanceModel'), '要点名是哪个配置项引用了缺价模型：' + bad.report)
  })

  await test('media_report(health)：关闭的开关显示 ⛔，且不再探测该链路', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp) // 默认 enableSeedanceVideo=false
    const { exec } = newExec(tmp)
    const before = mock.state.probes.length
    const health = await tools.media_report.execute({ action: 'health' }, exec)
    assert.ok(health.report.includes('| seedance_video | ⛔ 关'), health.report)
    assert.ok(health.report.includes('seedance_video: ⛔ 已在设置中关闭'))
    const arkProbes = mock.state.probes.slice(before).filter((entry) => String(entry.path).startsWith('/ark/'))
    assert.equal(arkProbes.length, 0, '关闭的链路不应被探测')
    const dashProbes = mock.state.probes.slice(before).filter((entry) => String(entry.path).includes('compatible-mode'))
    assert.ok(dashProbes.length >= 1, '开启的链路应正常探测')
  })

  // ---------------------------------------------------------------- 读图子代理"只看图"契约
  await test('reader-guard：判定函数认出漏回去的环境探查能力', async () => {
    assert.equal(readerFilterViolation(['read_image']), undefined, '恰好 [read_image] 应通过')
    const withRead = readerFilterViolation(['read', 'read_image', 'glob', 'grep', 'web_search'])
    assert.ok(withRead !== undefined && withRead.includes('read'), withRead)
    assert.ok(withRead.includes('环境探查'), '应点名这是环境探查能力：' + withRead)
    assert.ok(readerFilterViolation([]).includes('看不到图片'), '少了读图工具也要报')
    assert.ok(readerFilterViolation(undefined) !== undefined, '缺失也要报')
    // 本包自带的 cordis.patch.yml 必须满足契约（否则就是源码被改歪了）。
    assert.ok(READER_FORBIDDEN_TOOLS.includes('read') && READER_FORBIDDEN_TOOLS.includes('bash'))
  })

  await test('reader-guard：扫描真实配置文件，抓到被改回 read 的读图行', async () => {
    // 当前仓库自带的 patch 应满足契约。
    assert.deepEqual(inspectReaderFilters({ dshHome: join(tmpdir(), 'no-such-dsh-home') }), [], '自带 patch 应满足契约')

    // 造一个"把 read 加回去"的假 profile，应被抓到。
    const root = await makeTmp()
    const profileDir = join(root, 'profiles', 'fake')
    await mkdir(profileDir, { recursive: true })
    await writeFile(
      join(profileDir, 'cordis.yml'),
      [
        '- id: tool-subagent-glm',
        "  name: '@deepseek-ai/dsh-tool-subagent'",
        '  config:',
        '    toolName: ask_glm',
        '    toolFilter:',
        '      allow: [read, read_image, glob, grep, web_search]',
        '- id: tool-subagent-qwen',
        "  name: '@deepseek-ai/dsh-tool-subagent'",
        '  config:',
        '    toolName: ask_qwen',
        '    toolFilter:',
        '      allow: [read_image]',
        '- id: mm-models',
        '',
      ].join('\n'),
      'utf8',
    )
    const violations = inspectReaderFilters({ dshHome: root })
    assert.equal(violations.length, 1, '应只报被抓到的那一行：' + JSON.stringify(violations))
    assert.equal(violations[0].id, 'tool-subagent-glm')
    assert.ok(violations[0].reason.includes('read'), violations[0].reason)
    assert.ok(violations[0].file.endsWith('cordis.yml'))
  })

  await test('reader-guard 自检：apply() 时发现漏回去的读图工具会打告警', async () => {
    const root = await makeTmp()
    const profileDir = join(root, 'profiles', 'fake')
    await mkdir(profileDir, { recursive: true })
    await writeFile(
      join(profileDir, 'cordis.yml'),
      ['- id: tool-subagent-glm', "  name: '@deepseek-ai/dsh-tool-subagent'", '  config:', '    toolFilter:', '      allow: [read, read_image]', ''].join('\n'),
      'utf8',
    )
    const before = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const tmp = await makeTmp()
      const { fake } = setup(mock, tmp)
      const hit = fake.warnings.find((line) => line.includes('读图子代理安全告警') && line.includes('tool-subagent-glm'))
      assert.ok(hit !== undefined, '应打出安全告警，实际告警：' + JSON.stringify(fake.warnings))
      assert.ok(hit.includes('read'), '告警要点名多出来的工具：' + hit)
    } finally {
      if (before === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = before
    }
  })

  // ---------------------------------------------------------------- 「多此一举」拦截
  await test('读图守卫：图已在上下文 → 拒绝派读图员；只有路径 → 放行', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp)
    // 按行为挑读图守卫：造一条"图片就贴在末尾、且是用户消息带的"历史，
    // 只有读图守卫会对这个形状返回拒绝原因（工具开关此时放行 ask_qwen）。
    const readerGuard = guardOf(fake, GUARD_READER)
    assert.ok(readerGuard !== undefined, 'apply() 应注册读图守卫')

    const userText = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
    const userImage = (name) => ({
      type: 'user/message',
      data: {
        content: [
          { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', name } },
          { type: 'text', text: '这是谁' },
        ],
      },
    })
    const withLog = (entries) => ({ name: 'ask_qwen', agent: { session: { log: entries } } })

    // ① 图片作为最后一条用户消息进来 → 主代理自己看得到 → 拒绝并给出可读说明
    //    注意：guard 的返回值是字符串（与工具开关的 disabledMessage 一致）。
    const inline = readerGuard(withLog([userImage('截图.png')]))
    assert.equal(typeof inline, 'string', 'guard 应返回字符串原因，实际：' + JSON.stringify(inline))
    assert.ok(inline.includes('已经在本对话的上下文里'), inline)
    assert.ok(inline.includes('ask_qwen'), '应点名被拒的工具')

    // ② 只有路径、历史里从没有内联图 → 这条路看不了图，派读图员是唯一正确做法 → 放行
    assert.equal(readerGuard(withLog([userText('读一下 D:/x/图.png，这是谁')])), undefined)
    assert.equal(readerGuard(withLog([userText('随便说点什么')])), undefined)

    // ③ 用户后来又发了别的消息（图不在末尾）→ 不武断拦截
    assert.equal(readerGuard(withLog([userImage('截图.png'), userText('那这个呢')])), undefined)

    // ④ 工具结果里的图不算（那不代表主代理的路由支持看图）
    assert.equal(
      readerGuard(withLog([userText('看下这个'), { type: 'tool/result', data: { content: [{ type: 'image' }] } }])),
      undefined,
    )

    // ⑤ 其他工具一律不受影响
    assert.equal(readerGuard({ name: 'ops_bash', agent: { session: { log: [userImage('截图.png')] } } }), undefined)
    // ask_glm 同样适用
    assert.equal(typeof readerGuard({ name: 'ask_glm', agent: { session: { log: [userImage('截图.png')] } } }), 'string')

    // ⑥ 拿不到会话日志 → fail-open（绝不因为判定失败而拦住合法读图）
    assert.equal(readerGuard({ name: 'ask_qwen', agent: {} }), undefined)
    assert.equal(readerGuard({ name: 'ask_qwen' }), undefined)
    assert.equal(readerGuard(withLog([])), undefined)
  })

  await test('读图守卫：屏蔽原生读图时永不拦截（那时主代理确实看不了）', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { blockMainAgentNativeVision: true, enableAskQwen: true } })
    const readerGuard = guardOf(fake, GUARD_READER)
    assert.ok(readerGuard !== undefined, 'apply() 应注册读图守卫')
    const entries = [
      {
        type: 'user/message',
        data: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc' } }, { type: 'text', text: '这是谁' }] },
      },
    ]
    assert.equal(
      readerGuard({ name: 'ask_qwen', agent: { session: { log: entries } } }),
      undefined,
      '屏蔽原生读图时，读图员是唯一出路，必须放行',
    )
  })

  // ---------------------------------------------------------------- 密钥输入框（字面值）
  await test('密钥优先级：字面值 > 引用名 > .env', async () => {
    const tmp = await makeTmp()
    // 环境里给了旧值，卡里填了新字面值 → 必须用字面值。
    const { fake, config } = setup(mock, tmp, {
      credentials: { DASHSCOPE_API_KEY: 'from-env-dashscope', ARK_API_KEY: 'from-env-ark' },
      overrides: { dashscopeApiKey: 'literal-key-from-card' },
    })
    const { createKeyResolver, keySpec } = await import('../core/keys.mjs')
    // ⚠ 必须像 index.js 那样传**解包过的** config：volatile 字段在 Config 实例上
    // 是引用对象 `{ get() }`，直接读会得到对象 → 被判定成"没填"。
    const keys = createKeyResolver(fake.ctx, plainConfig(config))
    const hit = await keys.resolve(keySpec('dashscope'))
    assert.equal(hit.value, 'literal-key-from-card', '字面值必须压过 .env')
    assert.equal(hit.source, 'literal')
    // 没填字面值的那把 -> 走引用名
    const ark = await keys.resolve(keySpec('ark'))
    assert.equal(ark.value, 'from-env-ark')
    assert.notEqual(ark.source, 'literal')
  })

  await test('密钥优先级：清空字面值（空串）→ 回落到 .env，不是"没有 key"', async () => {
    const tmp = await makeTmp()
    const { fake, config } = setup(mock, tmp, {
      credentials: { DASHSCOPE_API_KEY: 'from-env-dashscope' },
      // 用户在卡里清空了输入框 → 写回空串
      overrides: { dashscopeApiKey: '' },
    })
    const { createKeyResolver, keySpec } = await import('../core/keys.mjs')
    const keys = createKeyResolver(fake.ctx, plainConfig(config))
    const hit = await keys.resolve(keySpec('dashscope'))
    assert.equal(hit.value, 'from-env-dashscope', '空字面值必须回落，而不是判定成缺 key')
    assert.equal(hit.source, 'environment')
  })

  await test('密钥引用名：卡里改的引用名真的被用上', async () => {
    const tmp = await makeTmp()
    const { fake, config } = setup(mock, tmp, {
      credentials: { MY_OWN_DASHSCOPE: 'value-under-custom-ref' },
      overrides: { dashscopeApiKeyEnv: 'MY_OWN_DASHSCOPE' },
    })
    const { createKeyResolver, keySpec } = await import('../core/keys.mjs')
    const keys = createKeyResolver(fake.ctx, plainConfig(config))
    const hit = await keys.resolve(keySpec('dashscope'))
    assert.equal(hit.ref, 'MY_OWN_DASHSCOPE', '应使用卡里改过的引用名')
    assert.equal(hit.value, 'value-under-custom-ref')
  })

  // ---------------------------------------------------------------- 主代理原生读图开关
  await test('blockMainAgentNativeVision：主 agent 被 deny read_image，子代理不受影响', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { blockMainAgentNativeVision: true, enableAskQwen: true } })
    const createdListener = fake.listeners.find((entry) => entry.event === 'agent/created')
    assert.ok(createdListener !== undefined)

    const seen = []
    const makeAgent = (options) => ({
      options,
      ctx: {
        effect: (cb) => {
          const disposer = cb()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        tools: {
          restrict(filter) {
            seen.push({ options, deny: filter.deny })
            return () => {}
          },
        },
      },
    })

    // 主 agent：options 只有 provider/model（实测形状）。
    createdListener.callback({ agent: makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash' }), source: 'startup' })
    assert.ok(seen.at(-1).deny.includes('read_image'), '主 agent 应被 deny read_image：' + JSON.stringify(seen.at(-1)))

    // 读图子代理：options 里带 subagentDepth（实测形状）——必须保留 read_image。
    createdListener.callback({ agent: makeAgent({ provider: 'glm', model: 'glm-4.6v', subagentDepth: 1 }), source: 'startup' })
    assert.ok(
      !seen.at(-1).deny.includes('read_image'),
      '子代理不应被 deny read_image（否则读图员会瞎）：' + JSON.stringify(seen.at(-1)),
    )
  })

  await test('blockMainAgentNativeVision 默认关闭：主 agent 保留原生读图', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskQwen: true } })
    const createdListener = fake.listeners.find((entry) => entry.event === 'agent/created')
    const seen = []
    createdListener.callback({
      agent: {
        options: { provider: 'deepseek-account', model: 'deepseek-flash' },
        ctx: {
          effect: (cb) => cb() ?? (() => {}),
          tools: {
            restrict(filter) {
              seen.push(filter.deny)
              return () => {}
            },
          },
        },
      },
      source: 'startup',
    })
    assert.equal(seen.some((deny) => deny.includes('read_image')), false, '开关默认关时不应 deny read_image')
  })

  // ---------------------------------------------------------------- 提示词段落内容
  await test('提示词段落：只留插件自有策略，禁止抄回宿主已注入的禁令', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp)
    const sectionText = typeof fake.sections[0].text === 'function' ? fake.sections[0].text({}) : fake.sections[0].text

    // ---- 反面：这些条款由宿主系统指令注入，插件再写一遍就是重复占用上下文 ----
    // 2026-10-15 瘦身：原版 7 行里有三段与宿主逐字重合（同一套规则出现两遍、
    // 改规则要改两处、漏一处就出现两个版本打架）。这里把它钉成断言，
    // 防止以后有人"为了保险"再抄回来。
    for (const duplicated of ['环境探查禁令', '长命令禁令', '严禁委派子代理', '看不到本地环境', 'run_in_background', '冷启动', '原生多模态', 'subagent_fork']) {
      assert.ok(!sectionText.includes(duplicated), '宿主已注入的条款不应在插件提示词里重复：' + duplicated)
    }

    // ---- 正面：插件自有、宿主无从得知的两件事 ----
    assert.ok(sectionText.includes('主创') && sectionText.includes('不要为了使用工具而使用工具'), '应保留分工与交付责任')
    assert.ok(sectionText.includes('读图路由'), '应保留读图路由策略（这是插件才知道的信息）')
    assert.ok(sectionText.includes('ask_glm') && sectionText.includes('ask_qwen'), '路由策略要点名两个读图员')
    assert.ok(sectionText.includes('只会看图'), '要点明读图员的边界')
    assert.ok(sectionText.includes('没有看图途径'), '没读图员时要如实说明')
    assert.ok(sectionText.includes('不要绕道、不要猜图'), '要禁止"猜图"这条退路')

    // 读图员是唯一有意的例外；其它工具名仍不出现
    assert.ok(!/qwen_draw|seedance_video|media_task|media_report/.test(sectionText), '仍不应出现其它工具名')
  })

  // ---------------------------------------------------------------- 预算 / 退化 / 账本后端
  await test('maxCallsPerTurn=1：第二次连续生成被拒，文案指向配置项', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { maxCallsPerTurn: 1 } })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: '预算内' }, exec)
    await expectError(tools.qwen_draw.execute({ prompt: '超预算' }, exec), CODES.RATE_LIMIT, ['maxCallsPerTurn', '上限'])
  })

  await test('degradeToText=true：ask_glm 失败时替换为"不要卡住"的指引', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { degradeToText: true } })
    const listener = fake.listeners.find((entry) => entry.event === 'tools/post-execute')
    assert.ok(listener !== undefined, 'post-execute listener should be registered')
    let nextCalled = false
    const next = () => {
      nextCalled = true
      return { kind: 'accept' }
    }
    const decision = listener.callback({ name: 'ask_glm' }, { isError: true, content: [{ type: 'text', text: '厂商 401 未授权' }] }, next)
    assert.equal(decision.kind, 'block')
    assert.ok(decision.feedback[0].text.includes('厂商 401'))
    assert.ok(decision.feedback[0].text.includes('不要卡住'))
    const passthrough = listener.callback({ name: 'qwen_draw' }, { isError: true }, next)
    assert.equal(passthrough.kind, 'accept')
    assert.equal(nextCalled, true)
  })

  await test('degradeToText=false（默认）：不注册 post-execute 监听', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp)
    assert.equal(fake.listeners.filter((entry) => entry.event === 'tools/post-execute').length, 0)
  })

  await test('无附件服务时：图片仍落盘，结果退化为路径 + 文本，不崩', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { attachments: false })
    const { exec } = newExec(tmp)
    const value = await tools.qwen_draw.execute({ prompt: '无附件' }, exec)
    assert.equal(value.images.length, 1)
    assert.equal(value.images[0].attachmentId, undefined)
    assert.ok((await stat(value.images[0].path)).isFile())
    const blocks = tools.qwen_draw.output.render({}, value)
    assert.ok(blocks.every((block) => block.type === 'text'))
    assert.ok(blocks[0].text.includes('已生成 1 张图片'))
  })

  await test('账本优先使用宿主 storageDomain（不落 JSON 文件）', async () => {
    const tmp = await makeTmp()
    const storageDomain = createFakeStorageDomain()
    const { tools } = setup(mock, tmp, { storageDomain })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: 'storage 账本' }, exec)
    const report = await tools.media_report.execute({ action: 'cost' }, exec)
    assert.ok(report.report.includes('qwen-image-3.0'))
    // 内置表已带真实单价（0.18 元/张），所以这里不再出现 0.0000。
    assert.ok(/合计：0\.1800 CNY/.test(report.report), '应算出真实金额：' + report.report)
    assert.ok(!report.report.includes('未计价型号'), '有官方价的型号不应被判为未计价：' + report.report)
    const health = await tools.media_report.execute({ action: 'health' }, exec)
    assert.ok(health.report.includes('账本后端：storage'))
    await assert.rejects(stat(join(tmp, 'ledger.json')), 'JSON fallback file must not be created when storage works')
  })

  await test('media_report 参数校验：未知 action 报 BAD_REQUEST', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp)
    const { exec } = newExec(tmp)
    await expectError(tools.media_report.execute({ action: 'nope' }, exec), CODES.BAD_REQUEST)
  })

  await test('seedance_video 缺 key → MISSING_CREDENTIAL 点名 ARK_API_KEY', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { credentials: { ARK_API_KEY: undefined } })
    const { exec } = newExec(tmp)
    await expectError(tools.seedance_video.execute({ prompt: 'x' }, exec), CODES.MISSING_CREDENTIAL, ['ARK_API_KEY'])
  })

  await test('图像工具函数：PNG 尺寸 / 签名识别', async () => {
    const png = makePng(7, 5)
    assert.deepEqual(imageSize(png), { width: 7, height: 5 })
    assert.equal(mediaTypeFromBytes(png), 'image/png')
    const { makeMp4 } = await import('./fixtures.mjs')
    assert.equal(mediaTypeFromBytes(makeMp4()), 'video/mp4')
  })

  await test('Config 语义来源：CI 必须跑在真实的 schemastery 上（不是最小替身）', async () => {
    // register.mjs 会优先用真实的 @deepseek-ai/schemastery，找不到才回落到替身。
    // 替身把 .volatile()/.role() 实现成 no-op，而生产里 .volatile() 会让字段变成
    // 引用对象 { get() }（index.js 必须用 liveConfig 解包）——这条差异是实测踩过的坑。
    // 所以：CI 里要求真包；本地如果只有替身，至少要**说出来**，而不是静默全绿。
    const { schemaSemantics, schemaSemanticsSource } = await import('./register.mjs')
    assert.ok(['real', 'stub'].includes(schemaSemantics), '语义来源应为 real 或 stub，实际 ' + schemaSemantics)
    if (schemaSemantics === 'stub') {
      if ((process.env.DSH_REQUIRE_REAL_SCHEMASTERY ?? '').trim() === '1') {
        assert.fail('DSH_REQUIRE_REAL_SCHEMASTERY=1 时不应回落到替身（register.mjs 本应已拦截）')
      }
      console.log('    \u2139 本次跑在 schemastery 替身上（.volatile()/.role() 为 no-op），Config 语义与生产不同——仅适用于无真包的环境。')
    } else {
      assert.ok(schemaSemanticsSource.includes('schemastery'), '真实来源路径应指向 schemastery，实际 ' + schemaSemanticsSource)
    }
  })

  // ---------------------------------------------------------------- 收尾
  await mock.close()
  for (const root of tmpRoots) await rm(root, { recursive: true, force: true })

  console.log('\n[试运行结果] 通过 ' + stats.passed + '，失败 ' + stats.failed + '\n')
  if (stats.failed > 0) process.exitCode = 1
}

/** 只用于不依赖 mock 端点的单测（重试策略等）。 */
function newConfigOnly(overrides = {}) {
  return new Config({ maxCallsPerTurn: 0, ...overrides })
}

await main()
