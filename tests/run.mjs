/**
 * 试运行：不安装 dsh、不联网、不花 key 的完整验收。
 *
 * 覆盖：配置默认值 → 9 个工具的注册面 → submit/poll/fetch 全链路 →
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
//
// 2026-10-17 改：原来用**固定**子目录 + `rm(recursive, force)` 清空。
// 那个清空在 Windows 上会因文件锁而失败，而 `force: true` 把失败吞掉 ——
// 于是上一轮的出图缓存残留，本轮直接命中缓存、真实提交链路根本没被测到
// （实测：同一份代码连跑，一会儿 123 通过，一会儿"default qwen-image mode should be sync,
//   got cache:dce34907e1d5"）。固定目录 + 静默失败的清理 = 间歇性假绿。
// 现在改用 mkdtempSync：每轮唯一，**不依赖清理成功**，也不与任何其它进程抢目录。
import { mkdtempSync } from 'node:fs'
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mm-models-test-home-'))
process.env.DSH_HOME = TEST_HOME

import { startMockProviders } from './mock-providers.mjs'
import { createFakeCtx, createFakeStorageDomain, makeExec, makePng } from './fixtures.mjs'
import { Config, apply } from '../index.js'
import { createTaskManager } from '../tasks/manager.mjs'
import { dashscopeImageAdapter } from '../tasks/adapters/dashscope-image.mjs'
import { arkVideoAdapter } from '../tasks/adapters/ark-video.mjs'
import { CODES, MediaError, classifyHttpError, fixedMessage, isPreSendError } from '../core/errors.mjs'
import { cacheKeyOf } from '../core/cache.mjs'
import { DEFAULT_PRICING, isPriced, pricingOf, pricingWarnings, renderCostReport, zeroPriceOverrides } from '../core/cost.mjs'
import { authorizeSpend, estimateSpend } from '../core/spend-guard.mjs'
import { createCallBudget, createSwitches, normalizeSettingsOps, accountUnretrievedSpend, sessionSpentOrThrow } from '../core/tool-kit.mjs'
import { READER_FORBIDDEN_TOOLS, inspectReaderFilters, isReaderAgent, mergeReaderRoutes, readerFilterViolation, readerRouteAllowlist } from '../core/reader-guard.mjs'
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
const GUARD_NATIVE_VISION = 'native-vision-guard'
const GUARD_IMAGE_READ = 'image-read-guard'
const GUARD_VISION_DELEGATION = 'vision-delegation-guard'
const GUARD_READER_CONTRACT = 'reader-contract-guard'
const GUARD_SUBAGENT_SPEND = 'subagent-spend-guard'

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
    // 确认层是**给测试的逃生口**（index.js 的 requireSpendConfirm 描述里写着同一句）：
    // 单测要覆盖"提交→轮询→落盘→记账"整条链路，不该被每次都要复述金额挡住。
    // 生产默认 true。确认层本身由专门用例覆盖（含 2026-10-16 新增的**制图**闸门用例）。
    requireSpendConfirm: false,
    outDir: join(tmp, 'gen'),
    videoOutDir: join(tmp, 'gen', 'video'),
    ledgerPath: join(tmp, 'ledger.json'),
    // 2026-10-17 起出厂默认是"读图员开 + 原生读图屏蔽"（开箱即见效果）。
    // 单测多数用例验证的是具体开关/守卫逻辑与"原生可用"的旧行为，所以测试基线
    // 显式摆成"原生可用、读图员关"，避免每条用例都被出厂默认改变。
    // 出厂默认本身由「Config 默认值 / 出厂即演示」用例专门断言。
    enableAskGlm: false,
    blockMainAgentNativeVision: false,
    blockSubagentNativeVision: false,
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
    // 2026-10-17：读图员由插件自己注册，执行时要拿 subagents 服务。
    subagents: options.subagents,
  })
  apply(fake.ctx, config)
  // 给 guard 打标签。这是**测试侧对注册顺序的显式断言**：顺序一变就在这里报错，
  // 而不是让后面某条用例拿着错误的 guard 静默跑出假绿。
  assert.equal(
    fake.guards.length,
    7,
    'apply() 应恰好注册七个 guard（工具开关 + 读图守卫 + 原生读图兜底 + 图片路径守卫 + 视觉委派守卫 + 读图员契约守卫 + 子代理生成刹车）',
  )
  fake.guards[0].label = GUARD_TOOL_SWITCH
  fake.guards[1].label = GUARD_READER
  fake.guards[2].label = GUARD_NATIVE_VISION
  fake.guards[3].label = GUARD_IMAGE_READ
  fake.guards[4].label = GUARD_VISION_DELEGATION
  fake.guards[5].label = GUARD_READER_CONTRACT
  fake.guards[6].label = GUARD_SUBAGENT_SPEND
  const tools = Object.fromEntries(fake.tools.map((definition) => [definition.name, definition]))
  return { config, fake, tools }
}

/**
 * 造一个能被 apply() 管起来的假 agent，并截获插件注册的 `setInterval` 回调，
 * 以便**手动触发一次每秒对账**（否则测试要么等 1 秒、要么根本量不到）。
 *
 * 为什么需要它：2026-10-15 给对账加了"开关签名没变就整轮跳过"的短路，
 * 那是个**会吞掉配置变更**的优化——必须有测试证明"开关真变了，掩码确实在一个 tick 内跟上"。
 *
 * 用法：
 *   const harness = makeSyncHarness()
 *   const { agent, applied } = harness.install(fake)   // 在 apply() 之前调用
 *   apply(fake.ctx, config)
 *   fake.listeners.find((e) => e.event === 'agent/created').callback({ agent })
 *   harness.tick()                                     // 手动跑一次对账
 */
function makeSyncHarness() {
  const realSetInterval = globalThis.setInterval
  let tick
  globalThis.setInterval = (callback) => {
    tick = callback
    return { unref() {} }
  }
  return {
    /** 造 agent 并装上记录用的 restrict（在 apply() 之前调用）。 */
    install(fake) {
      const applied = []
      const agent = {
        options: { provider: 'deepseek-account', model: 'deepseek-flash' },
        ctx: {
          ...fake.ctx,
          effect: (callback) => callback(),
          tools: {
            restrict: ({ deny }) => {
              applied.push([...deny])
              return () => {}
            },
          },
        },
      }
      return { agent, applied }
    },
    /** 恢复 setInterval 并返回被截获的对账回调。 */
    tick: () => {
      globalThis.setInterval = realSetInterval
      if (typeof tick !== 'function') throw new Error('没截获到对账定时器')
      return tick
    },
  }
}

/**
 * 造一个只用于测 `createSwitches` 的配置 + 开关读取器。
 * `set(field)` 用于在测试里翻转某个开关（模拟"用户在配置卡里改了一下"）。
 */
function setupSwitches(overrides = {}) {
  // 与 makeConfig 同一套测试基线：出厂默认已改成"读图员开 + 原生屏蔽"，
  // 开关/签名用例需要可控的旧基线，避免默认值变化牵连一堆断言。
  const config = plainConfig(new Config({
    enableAskGlm: false,
    blockMainAgentNativeVision: false,
    blockSubagentNativeVision: false,
    ...overrides,
  }))
  return { config, switches: createSwitches(config), set: (field) => { config[field] = config[field] !== true } }
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

  await test('出厂默认（开箱即见效果）：ask_glm 开、两个 block 开、ask_qwen 关', async () => {
    // 2026-10-17 用户要求：别人装上看默认配置就能看到插件效果，不用先调。
    // 默认 = 读图员开着 + 主代理/通用子代理的原生读图都屏蔽。
    const config = new Config({})
    assert.equal(plain(config.enableAskGlm), true, '出厂默认开启 ask_glm')
    assert.equal(plain(config.enableAskQwen), false, 'ask_qwen 仍默认关（与 ask_glm 互斥，二选一）')
    assert.equal(plain(config.blockMainAgentNativeVision), true, '默认屏蔽主代理原生读图')
    assert.equal(plain(config.blockSubagentNativeVision), true, '默认屏蔽通用子代理原生读图')
    // 想用原生：把两个 block 关掉即可，读图员不必动（提示词是原生优先）。
    // 出厂模板（cordis.patch.yml）必须与这里一致 —— 由「发布用 patch 与出厂 Config 对齐」用例兜底。
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

  await test('apply() 注册 9 个工具 + 分工说明段落（读图员与窄委派都由插件自己注册）', async () => {
    const tmp = await makeTmp()
    const { fake, tools } = setup(mock, tmp)
    assert.deepEqual(Object.keys(tools).sort(), [
      'ask_glm', 'ask_qwen', 'media_report', 'media_task', 'qwen_draw',
      'seedance_video', 'subagent_code', 'subagent_research', 'video_gen',
    ])
    // 2026-10-18：窄委派也不能再用 tool-subagent 那句通用文案 —— 模型得能一眼分清
    // "执行"（会改文件）和"资料"（只读、不跑命令）。
    assert.ok(tools.subagent_code.description.includes('执行子代理'), 'subagent_code 描述必须自带身份：' + tools.subagent_code.description)
    assert.ok(tools.subagent_research.description.includes('资料子代理'), 'subagent_research 描述必须自带身份：' + tools.subagent_research.description)
    assert.ok(tools.subagent_code.parameters.prompt, '必须暴露 prompt 参数')
    assert.ok(tools.subagent_code.parameters.description, '必须暴露 description 参数')
    // 2026-10-17：读图员的描述不能再是 tool-subagent 那句通用文案 —— 那正是
    // 模型在 40+ 个工具里认不出 ask_glm 是"读图"的原因。
    assert.ok(tools.ask_glm.description.includes('读图'), 'ask_glm 描述必须自带"读图"：' + tools.ask_glm.description)
    assert.ok(tools.ask_qwen.description.includes('读图'), 'ask_qwen 描述必须自带"读图"：' + tools.ask_qwen.description)
    assert.ok(tools.ask_glm.parameters.image_path, '必须暴露 image_path 参数（而不是只给一个泛化 prompt）')
    // 2026-10-17 事故：描述写死 GLM-4.6V，配置默认却是 glm-5.3-flash —— 工具"自称 4.6V、实际调 5.3-flash"。
    // 型号必须来自 Config，改配置后描述跟着变。
    assert.ok(tools.ask_glm.description.includes('glm-5.3-flash'), '描述里的型号必须来自 Config：' + tools.ask_glm.description)
    assert.ok(tools.ask_qwen.description.includes('qwen3-vl-plus'), '描述里的型号必须来自 Config：' + tools.ask_qwen.description)
    assert.ok(!tools.ask_glm.description.includes('GLM-4.6V'), '不能残留写死的旧型号：' + tools.ask_glm.description)
    assert.equal(fake.sections.length, 1)
    assert.equal(fake.sections[0].name, 'mm-models:division')
    const sectionText = typeof fake.sections[0].text === 'function' ? fake.sections[0].text({}) : fake.sections[0].text
    // 2026-10-16 第二次瘦身：段落不再做"身份声明"（那对读图员是错的，实测 57/57 个读图员
    // 会话都带着它、占其 prompt 11.9%），只留三条可执行策略。
    assert.ok(sectionText.includes('【媒体分工】'), '要保留分工与成本纪律：' + sectionText)
    assert.ok(sectionText.includes('【读图路由】'), '要保留读图路由策略：' + sectionText)
    assert.ok(sectionText.includes('【窄委派】'), '要保留窄委派建议：' + sectionText)
    assert.ok(!sectionText.includes('你是主创兼工程师'), '不该再有"你是主创兼工程师"这类身份声明（读图员也收得到）：' + sectionText)
    // 段落基本不列工具名（不泄漏能力）。**有意的例外**是读图员与两条窄委派工具：
    // 不点名就没法下达"只许走这两条路"的指令。
    assert.ok(!/qwen_draw|seedance_video|media_task|media_report/.test(sectionText), '提示词段落不应出现其它工具名')
    assert.ok(sectionText.includes('ask_glm') && sectionText.includes('ask_qwen'), '读图路由策略必须点名两个读图员')
    // 字节预算：实测原版 710 B（274 字符），瘦身后必须显著更小，且不许再长回去。
    const bytes = Buffer.byteLength(sectionText, 'utf8')
    assert.ok(bytes <= 560, '提示词段落必须 ≤ 560 B（实测瘦身前 710 B），当前 ' + bytes + ' B')
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

  // ---------------------------------------------------------------- 读图员（2026-10-17 插件自有工具）
  // 这三条是"工具描述看不出用途"那次事故的回归网：
  //   ① 描述必须自带"读图"；② 派出的 request 形状必须与官方实现一致；
  //   ③ 服务缺失/参数为空必须在派出**之前**失败，不能留下孤儿子代理。
  await test('ask_glm：startActivation 的 request 形状（preset / 路由 / 深度 / 父 agent）', async () => {
    const tmp = await makeTmp()
    const activations = []
    const subagents = {
      getProvider: (name) => (name === 'spawn' ? { name: 'spawn' } : undefined),
      async startActivation(spec) {
        activations.push(spec)
        return { childId: 'child-1' }
      },
    }
    const { tools } = setup(mock, tmp, { subagents })
    const parent = { id: 'parent-agent', options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
    const value = await tools.ask_glm.execute(
      { image_path: 'C:/shots/a.png', question: '表格第三行第二列是什么' },
      { agent: parent, signal: undefined },
    )
    assert.deepEqual(value, { kind: 'activation', subagentId: 'child-1' })
    const spec = activations[0]
    assert.equal(spec.provider, 'spawn', '必须走 spawn 提供方')
    assert.equal(spec.delivery, 'parent', '结论必须投递给父会话')
    assert.equal(spec.label, '读图')
    assert.equal(spec.request.parent, parent)
    assert.equal(spec.request.agentPreset, 'mm-reader', 'persona 与工具面必须由 preset 决定')
    assert.deepEqual(spec.request.agentOptions, { provider: 'glm', model: 'glm-5.3-flash' })
    assert.equal(spec.request.maxDepth, 2, '已委派的子代理也要能调读图员')
    assert.equal(spec.request.prompt.length, 1)
    assert.equal(spec.request.prompt[0].type, 'text')
    assert.ok(spec.request.prompt[0].text.includes('C:/shots/a.png'), 'prompt 必须带上图片路径')
    assert.ok(spec.request.prompt[0].text.includes('表格第三行第二列是什么'), 'prompt 必须带上问题')
  })

  await test('ask_qwen：走 qwen-vl 路由；两个读图员共用 mm-reader preset', async () => {
    const tmp = await makeTmp()
    const activations = []
    const subagents = {
      getProvider: () => ({ name: 'spawn' }),
      async startActivation(spec) {
        activations.push(spec)
        return { childId: 'child-2' }
      },
    }
    const { tools } = setup(mock, tmp, { subagents })
    const value = await tools.ask_qwen.execute({ image_path: 'b.png' }, { agent: { id: 'p' }, signal: undefined })
    assert.equal(value.subagentId, 'child-2')
    assert.deepEqual(activations[0].request.agentOptions, { provider: 'qwen-vl', model: 'qwen3-vl-plus' })
    assert.equal(activations[0].request.agentPreset, 'mm-reader')
  })

  await test('读图员：参数为空 / subagents 缺失 / spawn 未注册 → 派出前就报错', async () => {
    const noService = setup(mock, await makeTmp())
    await expectError(noService.tools.ask_glm.execute({}, { agent: { id: 'p' } }), CODES.BAD_REQUEST, ['image_path'])
    await expectError(
      noService.tools.ask_glm.execute({ image_path: 'a.png' }, { agent: { id: 'p' } }),
      CODES.UNKNOWN,
      ['subagents'],
    )

    let called = false
    const noSpawn = setup(mock, await makeTmp(), {
      subagents: { getProvider: () => undefined, async startActivation() { called = true; return { childId: 'x' } } },
    })
    await expectError(
      noSpawn.tools.ask_glm.execute({ image_path: 'a.png' }, { agent: { id: 'p' } }),
      CODES.UNKNOWN,
      ['spawn'],
    )
    assert.equal(called, false, 'spawn 未注册时不能真去创建子代理')
  })

  // ---------------------------------------------------------------- 窄委派（2026-10-18 改由插件注册）
  await test('subagent_code：走 mm-code preset、depth 1、描述透传；不再在装配期查 preset', async () => {
    const tmp = await makeTmp()
    const activations = []
    const subagents = {
      getProvider: () => ({ name: 'spawn' }),
      async startActivation(spec) {
        activations.push(spec)
        return { childId: 'child-code' }
      },
    }
    const { tools } = setup(mock, tmp, { subagents })
    // 2026-10-18 事故复现点：装配阶段（apply）里**没有**任何 preset 查询 —— 只要 payload
    // 里没有 agentPreset 的读取，热重载时 preset 还没 register 也不会打挂工具。
    const value = await tools.subagent_code.execute(
      { description: '修登录超时', prompt: '把 login 的 5 秒超时改成 15 秒，跑 npm test。' },
      { agent: { id: 'p' }, signal: undefined },
    )
    assert.equal(value.subagentId, 'child-code')
    assert.equal(activations[0].provider, 'spawn')
    assert.equal(activations[0].label, '修登录超时')
    assert.equal(activations[0].delivery, 'parent')
    assert.equal(activations[0].request.agentPreset, 'mm-code')
    assert.equal(activations[0].request.maxDepth, 1)
    assert.ok(activations[0].request.prompt[0].text.includes('npm test'), '任务说明必须原样交给子代理')
    // 子代理用的是自己的路由（继承父代理），不许偷偷塞 agentOptions
    assert.equal(activations[0].request.agentOptions, undefined)
  })

  await test('subagent_research：走 mm-research preset；preset / depth 可改配置', async () => {
    const tmp = await makeTmp()
    const activations = []
    const subagents = {
      getProvider: () => ({ name: 'spawn' }),
      async startActivation(spec) {
        activations.push(spec)
        return { childId: 'child-research' }
      },
    }
    const { tools } = setup(mock, tmp, {
      subagents,
      overrides: { researchAgentPreset: 'my-research', delegationMaxDepth: 2 },
    })
    const value = await tools.subagent_research.execute(
      { description: '查 SSE 断连', prompt: '查一下 SSE 在代理后面断连的常见原因，给来源链接。', cwd: 'D:/work' },
      { agent: { id: 'p' } },
    )
    assert.equal(value.subagentId, 'child-research')
    assert.equal(activations[0].request.agentPreset, 'my-research')
    assert.equal(activations[0].request.maxDepth, 2)
    assert.equal(activations[0].request.cwd, 'D:/work')
  })

  await test('窄委派：参数为空 / subagents 缺失 / spawn 未注册 → 派出前就报错', async () => {
    const empty = setup(mock, await makeTmp())
    await expectError(
      empty.tools.subagent_code.execute({ description: 'x', prompt: '   ' }, { agent: { id: 'p' } }),
      CODES.BAD_REQUEST,
      ['prompt'],
    )
    await expectError(
      empty.tools.subagent_research.execute({ description: '  ', prompt: 'y' }, { agent: { id: 'p' } }),
      CODES.BAD_REQUEST,
      ['description'],
    )
    await expectError(
      empty.tools.subagent_code.execute({ description: 'x', prompt: 'y' }, { agent: { id: 'p' } }),
      CODES.UNKNOWN,
      ['subagents'],
    )
    let called = false
    const noSpawn = setup(mock, await makeTmp(), {
      subagents: { getProvider: () => undefined, async startActivation() { called = true; return { childId: 'x' } } },
    })
    await expectError(
      noSpawn.tools.subagent_research.execute({ description: 'x', prompt: 'y' }, { agent: { id: 'p' } }),
      CODES.UNKNOWN,
      ['spawn'],
    )
    assert.equal(called, false, 'spawn 未注册时不能真去创建子代理')
  })

  // ---------------------------------------------------------------- 工具开关
  await test('工具开关：未开启时 guard 拒绝（seedance / 两个读图员）；其余放行', async () => {
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
    assert.deepEqual([...denyLists.at(-1)].sort(), ['ask_qwen', 'video_gen'], '开了 ask_glm 之后只有互斥的 ask_qwen 与默认关闭的 video_gen 在 deny 名单里')

    const tmp2 = await makeTmp()
    const offSetup = setup(mock, tmp2)
    const offListener = offSetup.fake.listeners.find((entry) => entry.event === 'agent/created')
    offListener.callback({ agent, source: 'test' })
    assert.deepEqual([...denyLists.at(-1)].sort(), ['ask_glm', 'ask_qwen', 'seedance_video', 'video_gen'].sort(), '关闭的工具应进入该 agent 的 deny 名单')
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

  await test('qwen_draw 图生图：给 image 时请求体带图片项（先图后文），缓存键按原图区分', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { imageCachePath: join(tmp, 'cache.json') } })
    const { exec } = newExec(tmp)
    await writeFile(join(tmp, 'base.png'), makePng(8, 8))
    await tools.qwen_draw.execute({ prompt: '给这个角色补上猫耳', image: 'base.png' }, exec)
    const submit = mock.state.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('multimodal-generation')).at(-1)
    const content = submit.body.input.messages[0].content
    assert.equal(content.length, 2, '图生图的 content 必须是 [image, text]')
    assert.ok(String(content[0].image).startsWith('data:image/png;base64,'), '本地图必须转成 data URL 发出去')
    assert.equal(content[1].text, '给这个角色补上猫耳')

    // 同一句 prompt 换一张原图 → 必须是不同的缓存键；图生图也不能与文生图共用缓存。
    const cfg = plain(new Config({}))
    const keyOf = (spec) => cacheKeyOf({ model: 'qwen-image-3.0', prompt: 'p', n: 1, ...spec }, cfg)
    const keyA = keyOf({ images: [{ dataUrl: 'data:image/png;base64,AAA' }] })
    const keyB = keyOf({ images: [{ dataUrl: 'data:image/png;base64,BBB' }] })
    const keyNoImage = keyOf({})
    assert.notEqual(keyA, keyB, '不同原图必须是不同的缓存键（否则会返回上一张原图的产物）')
    assert.notEqual(keyA, keyNoImage, '图生图与文生图不能共用缓存')
  })

  await test('qwen_draw 图生图：本地图越出会话工作目录 → 拒绝且不提交', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp)
    const { exec } = newExec(tmp)
    const outside = join(tmpdir(), 'mm-outside-' + Date.now().toString(36) + '.png')
    await writeFile(outside, makePng(4, 4))
    try {
      const before = mock.state.requests.filter((entry) => entry.method === 'POST').length
      const error = await expectError(tools.qwen_draw.execute({ prompt: 'x', image: outside }, exec), CODES.BAD_REQUEST)
      assert.match(String(error.message), /工作目录/u)
      assert.equal(mock.state.requests.filter((entry) => entry.method === 'POST').length, before, '被拒绝的调用绝不能提交')
    } finally {
      await rm(outside, { force: true })
    }
  })

  await test('qwen_draw 图生图：异步模式明确拒绝（不静默丢图）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { dashscopeImageMode: 'async' } })
    const { exec } = newExec(tmp)
    await writeFile(join(tmp, 'base.png'), makePng(8, 8))
    const error = await expectError(tools.qwen_draw.execute({ prompt: 'x', image: 'base.png' }, exec), CODES.BAD_REQUEST)
    assert.match(String(error.message), /同步模式/u)
  })

  await test('qwen_draw 图生图：未给 size 时沿用原图尺寸，不自动放大到 2K', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { imageCachePath: join(tmp, 'cache.json') } })
    const { exec } = newExec(tmp)
    const lastSubmit = () =>
      mock.state.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('multimodal-generation')).at(-1)

    // 1024×1024 已在合法区间内 → 原样沿用（实测不传 size 时模型会自选 2048×2048，又慢又贵）
    await writeFile(join(tmp, 'big.png'), makePng(1024, 1024))
    await tools.qwen_draw.execute({ prompt: '改个颜色', image: 'big.png' }, exec)
    assert.equal(lastSubmit().body.parameters.size, '1024*1024', '图生图应沿用原图尺寸')

    // 64×64 小于面积下限 → 等比放大到 512×512
    await writeFile(join(tmp, 'tiny.png'), makePng(64, 64))
    await tools.qwen_draw.execute({ prompt: '再改一次', image: 'tiny.png' }, exec)
    assert.equal(lastSubmit().body.parameters.size, '512*512', '小于下限的原图要等比放大到 512×512')

    // 用户显式给了 size 时，原图尺寸不得覆盖它
    await tools.qwen_draw.execute({ prompt: '再改第三次', image: 'big.png', size: '768*768' }, exec)
    assert.equal(lastSubmit().body.parameters.size, '768*768', '显式 size 必须优先')
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
    assert.ok(reasonNone.includes('CN-gpt'), '没途径时要指路到配置卡：' + reasonNone)

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
    assert.ok(noReader.includes('CN-gpt'), '要指路到配置卡：' + noReader)
    assert.ok(noReader.includes('没有任何看图途径'), '要说明没有途径：' + noReader)
  })

  await test('⚠ 守卫必须读 harness 真实字段名 `arguments`（2026-10-16 生产级缺陷回归）', async () => {
    // 现场：harness 的类型是
    //   `type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`
    // 而 `ToolExecutionInput` 里入参字段叫 **`arguments`**，**没有 `args`**。
    // 本插件早期按 `exec.args` 读 → 用到入参的两条守卫（read 读图片指路、委派读图审计）
    // 在生产里拿到 undefined，**等于从未生效**；而单测一直绿，因为 fixtures 手搓的
    // 执行对象是 `{ name, args, agent }` —— **测试与真实契约不一致**，这才是根因。
    // 本用例**只用 harness 形状**构造执行对象，把这件事钉死。
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskGlm: true, blockMainAgentNativeVision: true } })
    const mainAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
    const harnessExec = (name, args) => ({ name, arguments: args, agent: mainAgent })

    // ① 第三条守卫：read 读图片必须被拦（用真实字段名）
    const imageGuard = guardOf(fake, GUARD_IMAGE_READ)
    const readVerdict = imageGuard(harnessExec('read', { file_path: 'C:/x/a.png' }))
    assert.ok(
      typeof readVerdict === 'string' && readVerdict.includes('ask_glm'),
      'harness 形状（arguments）下 read 读图片必须被拦并指路：' + String(readVerdict),
    )
    assert.equal(imageGuard(harnessExec('read', { file_path: 'C:/x/a.txt' })), undefined, '文本文件不该被拦')

    // ② 第四条守卫：委派读图必须被拦（用真实字段名）
    const delegationGuard = guardOf(fake, GUARD_VISION_DELEGATION)
    const delegationVerdict = delegationGuard(
      harnessExec('subagent', { description: '读图', prompt: '看一下 D:/work/a.png 画的是什么' }),
    )
    assert.ok(
      typeof delegationVerdict === 'string' && delegationVerdict.includes('已拦截'),
      'harness 形状（arguments）下委派读图必须被拦：' + String(delegationVerdict),
    )
    assert.equal(delegationGuard(harnessExec('subagent', { prompt: '重构 core/cost.mjs' })), undefined, '正常委派不该被拦')

    // ③ 兼容旧形态：`args` 也要继续能读（既有 fixtures 依赖它）
    assert.ok(
      typeof imageGuard({ name: 'read', args: { file_path: 'C:/x/a.png' }, agent: mainAgent }) === 'string',
      '`args` 形态必须继续工作',
    )

    // ④ 空/缺失入参不能炸，也不能误拦
    assert.equal(imageGuard({ name: 'read', arguments: undefined, agent: mainAgent }), undefined, '入参缺失时放行而不是抛错')
    assert.equal(imageGuard({ name: 'read', agent: mainAgent }), undefined, '完全没有入参字段时放行')
  })

  await test('C 打开时委派审计整体让位（已冗余 + 实测 6/10 误伤）；C 关着时行为不变', async () => {
    // 2026-10-16：C（blockSubagentNativeVision）打开后，通用子代理**没有 read_image**，
    // 想看懂图只能调 ask_glm / ask_qwen —— 正是这条审计想促成的路由。所以"按措辞拦截"
    // 不再提供任何保护，只剩误伤（实测：10 条非视觉委派里 6 条被拦）。
    const mainAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
    const vision = '看一下 D:/work/a.png 画的是什么'
    /** 与识图无关、但会命中词表的真实委派文本（就是那 6 条误伤）。 */
    const nonVisionTasks = [
      '帮我写一段关于读图路由的设计文档',
      '把 README 里所有"读图员"改成"识图子代理"',
      '把 assets/logo.png 转成 webp 并压缩到 50KB 以内',
      '把 D:\\shots\\old.png 从 git 里删掉并提交',
      '把 D:\\shots\\a.png 的分辨率统一改成 512x512',
      '这段报错信息里的图中路径是怎么拼出来的？帮我定位代码',
    ]

    // C 关（默认）：审计照旧 —— 视觉委派要拦，"含读图字样的非视觉文本"也拦（这就是它的误伤代价）
    const off = setup(mock, await makeTmp(), { overrides: { enableAskGlm: true } })
    const offGuard = guardOf(off.fake, GUARD_VISION_DELEGATION)
    assert.ok(
      typeof offGuard({ name: 'subagent', arguments: { prompt: vision }, agent: mainAgent }) === 'string',
      'C 关时视觉委派仍应被拦',
    )
    assert.ok(
      typeof offGuard({ name: 'subagent', arguments: { prompt: nonVisionTasks[1] }, agent: mainAgent }) === 'string',
      'C 关时含"读图"字样的文本仍被拦（既有行为，不改）',
    )

    // C 开：整体让位 —— 误伤清零，保护不减（子代理已经绕不过去了）
    const on = setup(mock, await makeTmp(), { overrides: { enableAskGlm: true, blockSubagentNativeVision: true } })
    const onGuard = guardOf(on.fake, GUARD_VISION_DELEGATION)
    for (const prompt of nonVisionTasks) {
      assert.equal(
        onGuard({ name: 'subagent', arguments: { prompt }, agent: mainAgent }),
        undefined,
        'C 开时不该拦非视觉委派（误伤）：' + prompt,
      )
    }
    assert.equal(
      onGuard({ name: 'subagent', arguments: { prompt: vision }, agent: mainAgent }),
      undefined,
      'C 开时视觉委派也放行 —— 子代理没有眼睛，它只能去调读图员（多一跳但结果仍受契约约束）',
    )
  })

  // ---------------------------------------------------------------- 读图员契约守卫（2026-10-16 实测后加）
  await test('读图员契约守卫：读图员调不通 shell / 委派 / 写文件，只能 read_image', async () => {
    // 现场（实测）：配置写的是 `toolFilter: { allow: [read_image] }`，但读图员的运行时工具表是
    // `ops_bash, read_image, subagent` —— 我们让它执行 `echo OK`，它**真的返回了 OK**。
    // 所以契约的最终保证必须落在 guard 层（配置/掩码在今天已经两次被证明不可信）。
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskGlm: true } })
    const guard = guardOf(fake, GUARD_READER_CONTRACT)
    const reader = { options: { provider: 'glm', model: 'glm-4.6v', subagentDepth: 1 } }
    const mainAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
    const generic = { options: { provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 } }

    for (const tool of ['ops_bash', 'pwsh', 'subagent', 'subagent_code', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'qwen_draw']) {
      const verdict = guard({ name: tool, arguments: {}, agent: reader })
      assert.ok(
        typeof verdict === 'string' && verdict.includes('读图员只被允许'),
        '读图员不该能调用 ' + tool + '：' + String(verdict),
      )
    }
    assert.equal(
      guard({ name: 'read_image', arguments: { file_path: 'a.png' }, agent: reader }),
      undefined,
      'read_image 必须放行 —— 那是读图员唯一的眼睛',
    )
    // 不误伤：这条守卫只管读图员
    assert.equal(guard({ name: 'ops_bash', arguments: {}, agent: mainAgent }), undefined, '主代理不受影响')
    assert.equal(guard({ name: 'ops_bash', arguments: {}, agent: generic }), undefined, '通用子代理不受影响（它归 C 管）')
    assert.equal(guard({ name: 'read_image', arguments: {}, agent: generic }), undefined, '这条守卫不管 read_image 的屏蔽（那是 C 的职责）')
  })

  await test('发布 patch：子代理已迁到 Agent Preset（0.2.1 起 persona/toolFilter 会拒绝加载）', async () => {
    const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    // ① 0.2.1 的 dsh-tool-subagent 对退役键**直接抛错**：
    //    "tool-subagent: persona is no longer supported; configure persona and tool
    //     plugins in an Agent Preset and select it with agentPreset (spawn only)"
    //    带这些键的行会整行 mount 失败 —— 2026-10-17 升级后 ask_glm 等四个工具消失的根因。
    for (const banned of ['persona:', 'toolFilter:', 'backgroundMode:', 'enableRunInBackground:']) {
      assert.ok(!text.includes(banned), '不能残留退役键：' + banned)
    }
    // ② 2026-10-17：读图员两行已删除（工具改由插件 tools/reader.mjs 注册）。
    //    留着会与插件注册的同名工具冲突，所以这里钉"必须不存在"。
    for (const banned of ['- id: tool-subagent-glm', '- id: tool-subagent-qwen']) {
      assert.ok(!text.includes(banned), '读图员行应已迁到插件自有工具，patch 里不能再有：' + banned)
    }
    // ③ 2026-10-18：两个窄委派行也已删除（工具改由插件 tools/delegation.mjs 注册）。
    //    原因：`agentPreset` 是装配期校验（validate → readDocument），而 preset 的注册是
    //    激活期异步完成的 —— 首次热重载时委派行会先 apply 并报 "Unknown agent preset"。
    //    留着这些行既会与插件注册的同名工具冲突，也会把那个竞态带回来。
    for (const banned of ['- id: tool-subagent-code', '- id: tool-subagent-research']) {
      assert.ok(!text.includes(banned), '窄委派行应已迁到插件自有工具，patch 里不能再有：' + banned)
    }
    assert.ok(!text.includes('toolName: subagent_code'), 'patch 里不能再声明 subagent_code')
    // ③ 读图员 preset 的工具面 = 只有 read_image（read/write/edit 全关）
    const readerAt = text.indexOf('- id: preset-mm-reader')
    assert.ok(readerAt >= 0, '应有 preset-mm-reader')
    const readerBlock = text.slice(readerAt, text.indexOf('- id: preset-mm-code'))
    assert.ok(readerBlock.includes("name: '@deepseek-ai/dsh-persona'"), '读图员 preset 必须有 persona')
    assert.ok(/read:\s*false/.test(readerBlock), '读图员 preset 应关闭 read')
    assert.ok(/write:\s*false/.test(readerBlock), '读图员 preset 应关闭 write')
    assert.ok(/edit:\s*false/.test(readerBlock), '读图员 preset 应关闭 edit')
    assert.ok(/readImage:\s*true/.test(readerBlock), '读图员 preset 应打开 readImage')
    assert.ok(!/dsh-tool-bash|dsh-tool-pwsh|dsh-tool-web|dsh-tool-fs-search/.test(readerBlock), '读图员 preset 不能包含命令/联网/查找工具')
    // ④ 执行与资料 preset 也要有 persona 与对应工具面
    const codeAt = text.indexOf('- id: preset-mm-code')
    const codeBlock = text.slice(codeAt, text.indexOf('- id: preset-mm-research'))
    assert.ok(codeBlock.includes("name: '@deepseek-ai/dsh-persona'") && codeBlock.includes('dsh-tool-fs-search'), '执行 preset 应有 persona + 查找工具')
    const researchAt = text.indexOf('- id: preset-mm-research')
    const researchBlock = text.slice(researchAt, researchAt + 1200)
    assert.ok(researchBlock.includes("name: '@deepseek-ai/dsh-tool-web'"), '资料 preset 应有 web 工具')
    assert.ok(/write:\s*false/.test(researchBlock), '资料 preset 不该有写权限')
  })

  await test('报告体积预算：health/cost 默认紧凑，明细只在 verbose（工具结果会永久留在会话里）', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { healthProbe: false } })
    const { exec } = newExec(tmp)
    const health = (await tools.media_report.execute({ action: 'health' }, exec)).report
    const healthVerbose = (await tools.media_report.execute({ action: 'health', verbose: true }, exec)).report
    const cost = (await tools.media_report.execute({ action: 'cost', scope: 'all' }, exec)).report
    const bytes = (text) => Buffer.byteLength(text, 'utf8')

    // 2026-10-17 新增一条能力行（dashscope_video），+95 B；上限同步上浮，仍然挡"把报表写成小作文"。
    assert.ok(bytes(health) <= 2350, '紧凑 health 超预算：' + bytes(health) + ' B（实测原版 2667 B / 线上约 3.5 KB）')
    assert.ok(bytes(cost) <= 700, '紧凑 cost 超预算：' + bytes(cost) + ' B（实测原版 895 B）')
    assert.ok(bytes(healthVerbose) > bytes(health), 'verbose 必须比紧凑更长（否则等于没实现）')
    // 红线：紧凑模式只删样板/明细，**告警一个都不能省**
    assert.ok(health.includes('原生读图：'), '紧凑模式仍要报屏蔽状态：' + health)
    assert.ok(health.includes('单价表'), '紧凑模式仍要报单价表：' + health)
    assert.ok(!health.includes('掩码只在 agent 创建时贴'), '掩码注意事项应移入 verbose')
    assert.ok(healthVerbose.includes('掩码只在 agent 创建时贴'), 'verbose 要给出完整说明')
    // 图例最多出现一次（原来"账本"和"任务注册表"各带一句图例，同一次报告里重复两遍）
    assert.ok(health.split('storage = 宿主服务').length - 1 <= 1, '后端图例不能在同一份报告里重复：' + health)
    assert.ok(health.includes('账本/注册表后端：'), '两个后端应压在同一行：' + health)
    // 2026-10-17 起：读图子代理 token **已记账**（core/reader-usage.mjs 订阅 llm/stream
    // 的 waterfall 观察 usage 分片）。所以这里不能再断言"未计入"那句——
    // 但也不能只断言"有读图字样"：报告**谎报已计入**才是新的风险。
    // 判据取"没观测到时不谎报"这一支：本用例里没有任何读图调用，报告必须如实说"尚无观测记录"。
    assert.ok(cost.includes('读图子代理'), 'cost 必须交代读图子代理的计量口径')
    assert.ok(!cost.includes('**未计入**'), '已经能记账了，不能再说"未计入"')
    assert.ok(!cost.includes('**已记账**'), '本次没有任何读图调用，绝不能谎报已记账：' + cost)
    assert.ok(cost.includes('尚无观测记录'), '没观测到就要如实说：' + cost)
    assert.ok(cost.includes('估算值，非账单'), 'cost 仍要保留免责声明')
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

  // ------------------------------------------- 制图花钱闸门（2026-10-16 补：这半边以前是敞开的）
  await test('制图花钱闸门：不确认就一分钱都不该花（含"未计价 fail-closed"与上限）', async () => {
    // 实机实测过的洞：出片有三层闸门，**制图一条都没有**——只受次数预算（maxCallsPerTurn）约束，
    // 于是"不传任何确认参数就能直接出图扣费"、"未计价模型照常提交"。
    // 现在出图这条路径必须和出片一样：先报价 → 复述金额 → 才提交。
    const tmp = await makeTmp()
    const pricing = { ...plain(new Config({}).pricing), 'qwen-image-3.0': { unit: 'image', unitPrice: 0.18, currency: 'CNY', asOf: '2026-10-16' } }
    const { tools } = setup(mock, tmp, {
      // noConfirmUnderCNY: 0 → 关掉"小额免确认"，否则 ¥0.72 会被自动放行、测不到确认层本身
      overrides: { requireSpendConfirm: true, noConfirmUnderCNY: 0, videoCostLimitCNY: 0, videoSessionCostLimitCNY: 0, pricing },
    })
    const { exec } = newExec(tmp)
    const before = mock.submitCount('qwen')

    // (a) 不传确认 → 只报价、零提交，且文案按"张"计价
    const quote = await expectError(
      tools.qwen_draw.execute({ prompt: '制图闸门', n: 4 }, exec),
      CODES.BAD_REQUEST,
      ['未产生任何费用', 'confirm_estimate=0.72', '张'],
    )
    assert.equal(mock.submitCount('qwen'), before, '没有确认就不该有任何提交到达厂商')
    // (b) 金额对不上 → 拦下，仍然零提交
    await expectError(tools.qwen_draw.execute({ prompt: '制图闸门', n: 4, confirm_estimate: 1 }, exec), CODES.BAD_REQUEST, ['对不上'])
    assert.equal(mock.submitCount('qwen'), before, '金额不符也不该提交')
    // (c) 金额对得上 → 真出图并记账
    const ok = await tools.qwen_draw.execute({ prompt: '制图闸门', n: 2, confirm_estimate: 0.36 }, exec)
    assert.equal(ok.images.length, 2)
    const ledger = await readJson(join(tmp, 'ledger.json'))
    assert.equal(ledger.records.length, 1)
    assert.equal(ledger.records[0].unitKind, 'image')
    assert.equal(ledger.records[0].units, 2)
    assert.equal(ledger.records[0].unitPrice, 0.18)
    assert.equal(ledger.records[0].amount, 0.36)
    // (d) 缓存命中不需要确认（本来就没花钱，闸门不该多收一道手续）
    const cached = await tools.qwen_draw.execute({ prompt: '制图闸门', n: 2 }, exec)
    assert.equal(cached.cached, true, '相同参数第二次应命中缓存')
    assert.equal(mock.submitCount('qwen') - before, 1, '缓存命中不该再提交')

    // (e) 报价不吃配额：确认流程天然是两次调用，maxCallsPerTurn=1 时这一对仍应出图
    //     （闸门若排在 budget.take 之后，这里会先撞 RATE_LIMIT —— 那是我修闸门时差点引入的功能退化）
    const quotaTmp = await makeTmp()
    const quotaSetup = setup(mock, quotaTmp, { overrides: { requireSpendConfirm: true, noConfirmUnderCNY: 0, maxCallsPerTurn: 1, pricing } })
    const quotaExec = newExec(quotaTmp).exec
    await expectError(quotaSetup.tools.qwen_draw.execute({ prompt: '报价不吃配额' }, quotaExec), CODES.BAD_REQUEST, ['confirm_estimate=0.18'])
    const okQuota = await quotaSetup.tools.qwen_draw.execute({ prompt: '报价不吃配额', confirm_estimate: 0.18 }, quotaExec)
    assert.equal(okQuota.images.length, 1, '报价那次不该消耗 maxCallsPerTurn 名额')
  })

  await test('制图花钱闸门：未计价模型 fail-closed（自报金额不作数）', async () => {
    const tmp = await makeTmp()
    // 阈值故意开到 10 元：**"小额免确认"救不了未计价** —— 未计价在函数开头就 fail-closed 了，
    // 根本走不到阈值那一步（否则"把阈值调大"就成了绕过单价表的后门）。
    const { tools } = setup(mock, tmp, { overrides: { requireSpendConfirm: true, noConfirmUnderCNY: 10, pricing: {}, allowUnpricedSpend: false } })
    const { exec } = newExec(tmp)
    const before = mock.submitCount('qwen')
    await expectError(tools.qwen_draw.execute({ prompt: '未计价制图', confirm_estimate: 1 }, exec), CODES.BAD_REQUEST, ['自报金额', '未产生任何费用'])
    assert.equal(mock.submitCount('qwen'), before, '未计价就绝不能提交（出片那边的洞不能从制图这边绕回来）')
  })

  await test('制图花钱闸门：单次上限与会话累计上限同样管制图（阈值再大也绕不过上限）', async () => {
    const tmp = await makeTmp()
    // 单价故意调高到 0.6/张，好让整数上限（配置项 step=1）能够咬到。
    const pricing = { ...plain(new Config({}).pricing), 'qwen-image-3.0': { unit: 'image', unitPrice: 0.6, currency: 'CNY', asOf: '2026-10-16' } }
    const { tools } = setup(mock, tmp, {
      // 阈值 10 元 ≫ 本次 1.20 元：若"小额免确认"被放在上限之前，这里就会放行 —— 测试专门盯这个顺序
      overrides: { requireSpendConfirm: true, noConfirmUnderCNY: 10, videoCostLimitCNY: 1, videoSessionCostLimitCNY: 1, pricing },
    })
    const { exec } = newExec(tmp)
    // 单次上限：2 张 = 1.20 > 1 → 拦下，并点名是哪个配置项
    const perCall = await expectError(tools.qwen_draw.execute({ prompt: '单次上限', n: 2, confirm_estimate: 1.2 }, exec), CODES.BAD_REQUEST)
    assert.ok(perCall.message.includes('videoCostLimitCNY'), '要指出是哪个配置项：' + perCall.message)
    // 会话累计：先花 0.60（放行），再花 0.60 就超 1 元 → 拦下
    await tools.qwen_draw.execute({ prompt: '第一张', confirm_estimate: 0.6 }, exec)
    const perSession = await expectError(tools.qwen_draw.execute({ prompt: '第二张', confirm_estimate: 0.6 }, exec), CODES.BAD_REQUEST)
    assert.ok(perSession.message.includes('videoSessionCostLimitCNY'), '要指出是哪个配置项：' + perSession.message)
    assert.ok(perSession.message.includes('0.60'), '要报出"已花多少"：' + perSession.message)
  })

  await test('子代理生成刹车：默认允许（效率优先），开关打开后只允许主代理', async () => {
    // 策略来自用户 2026-10-16 的决定：繁重任务里让子代理直接出图，效率优先；
    // 普通任务基本用不到子代理出图。所以默认**不拦**，只留一个刹车开关。
    const tmp = await makeTmp()
    const def = setup(mock, tmp, { overrides: { requireSpendConfirm: false } })
    const allow = guardOf(def.fake, GUARD_SUBAGENT_SPEND)
    const mainAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
    const subAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 } }
    assert.equal(allow({ name: 'qwen_draw', arguments: {}, agent: subAgent }), undefined, '默认必须允许子代理生成')
    assert.equal(allow({ name: 'seedance_video', arguments: {}, agent: subAgent }), undefined, '默认必须允许子代理出片')
    assert.equal(allow({ name: 'video_gen', arguments: {}, agent: subAgent }), undefined, '默认必须允许子代理用百炼出片')
    assert.equal(allow({ name: 'qwen_draw', arguments: {}, agent: mainAgent }), undefined, '主代理永远允许')
    assert.equal(allow({ name: 'media_report', arguments: {}, agent: subAgent }), undefined, '这条守卫只管生成类工具')

    const blocked = setup(mock, await makeTmp(), { overrides: { requireSpendConfirm: false, blockSubagentSpend: true } })
    const brake = guardOf(blocked.fake, GUARD_SUBAGENT_SPEND)
    for (const tool of ['qwen_draw', 'seedance_video', 'video_gen']) {
      const verdict = brake({ name: tool, arguments: {}, agent: subAgent })
      assert.ok(typeof verdict === 'string' && verdict.includes('只允许主代理调用'), tool + ' 应被刹车拦下：' + String(verdict))
    }
    assert.equal(brake({ name: 'qwen_draw', arguments: {}, agent: mainAgent }), undefined, '刹车不该影响主代理')

    // 分级刹车（2026-10-17）：只挡出片，不挡出图与读图。
    const videoOnly = setup(mock, await makeTmp(), { overrides: { requireSpendConfirm: false, blockSubagentVideoSpend: true } })
    const videoBrake = guardOf(videoOnly.fake, GUARD_SUBAGENT_SPEND)
    for (const tool of ['video_gen', 'seedance_video']) {
      const verdict = videoBrake({ name: tool, arguments: {}, agent: subAgent })
      assert.ok(typeof verdict === 'string' && verdict.includes('只允许主代理调用'), tool + ' 应被"只挡出片"拦下：' + String(verdict))
    }
    assert.equal(videoBrake({ name: 'qwen_draw', arguments: {}, agent: subAgent }), undefined, '只挡出片时，出图必须放行')
    assert.equal(videoBrake({ name: 'media_task', arguments: {}, agent: subAgent }), undefined, '补下载不是生成，不该拦')
    assert.equal(videoBrake({ name: 'video_gen', arguments: {}, agent: mainAgent }), undefined, '主代理永远可以出片')
  })

  await test('会话树汇总：子代理的花费计入主代理的 cost(session)（否则是看不见的黑洞）', async () => {
    const tmp = await makeTmp()
    const { tools, fake } = setup(mock, tmp, {
      overrides: { requireSpendConfirm: false, videoCostLimitCNY: 0, videoSessionCostLimitCNY: 0 },
    })
    const created = fake.listeners.find((entry) => entry.event === 'agent/created')
    // 真实形状（实测）：子会话 header 里带 parentSession。
    const childAgent = {
      session: { id: 'child-1', header: { id: 'child-1', parentSession: 'parent-1' } },
      options: { provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 },
      ctx: { effect: (cb) => cb() ?? (() => {}), tools: { restrict: () => () => {} } },
    }
    created.callback({ agent: childAgent })
    // 子代理自己出一张图（记在 child-1 会话上）
    await tools.qwen_draw.execute({ prompt: '子代理出图' }, makeExec({ cwd: tmp, sessionId: 'child-1' }))

    const report = (
      await tools.media_report.execute({ action: 'cost', scope: 'session' }, makeExec({ cwd: tmp, sessionId: 'parent-1' }))
    ).report
    assert.ok(report.includes('含 1 个子代理会话'), '标题必须写清汇总范围：' + report)
    assert.ok(report.includes('qwen-image-3.0'), '必须包含子代理那一笔：' + report)

    // 对照：子会话自己查，不该声称"含子代理会话"
    const childReport = (
      await tools.media_report.execute({ action: 'cost', scope: 'session' }, makeExec({ cwd: tmp, sessionId: 'child-1' }))
    ).report
    assert.ok(!childReport.includes('个子代理会话'), '子会话自己查不该带汇总说明：' + childReport)
  })

  await test('会话累计上限覆盖会话树：把花费挪进子会话也绕不过上限', async () => {
    const tmp = await makeTmp()
    const pricing = {
      ...plain(new Config({}).pricing),
      'qwen-image-3.0': { unit: 'image', unitPrice: 0.6, currency: 'CNY', asOf: '2026-10-16' },
    }
    const { tools, fake } = setup(mock, tmp, {
      overrides: { requireSpendConfirm: true, noConfirmUnderCNY: 0, videoCostLimitCNY: 0, videoSessionCostLimitCNY: 1, pricing },
    })
    const created = fake.listeners.find((entry) => entry.event === 'agent/created')
    created.callback({
      agent: {
        session: { id: 'child-2', header: { id: 'child-2', parentSession: 'parent-2' } },
        options: { provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 },
        ctx: { effect: (cb) => cb() ?? (() => {}), tools: { restrict: () => () => {} } },
      },
    })
    // 子代理先花 0.60（记在 child-2 会话）
    await tools.qwen_draw.execute({ prompt: '子代理第一张', confirm_estimate: 0.6 }, makeExec({ cwd: tmp, sessionId: 'child-2' }))
    // 主代理再花 0.60：只看自己的会话（0 + 0.6 ≤ 1）会放行；覆盖会话树则应拦下
    const blocked = await expectError(
      tools.qwen_draw.execute({ prompt: '主代理第二张', confirm_estimate: 0.6 }, makeExec({ cwd: tmp, sessionId: 'parent-2' })),
      CODES.BAD_REQUEST,
    )
    assert.ok(blocked.message.includes('videoSessionCostLimitCNY'), '要指出是会话累计上限：' + blocked.message)
    assert.ok(blocked.message.includes('0.60'), '要报出"已花多少"（含子代理那笔）：' + blocked.message)
  })

  await test('小额免确认（2026-10-16 加）：阈值内的制图一次调用直接出图', async () => {
    // 动机：确认流程天然是两次调用，而制图单张 ¥0.18、一批最多 4 张 → 每次多一轮往返不划算。
    // 默认阈值 1 元覆盖"制图任何一批"，出片 1 秒 ¥1.52 仍然要确认（下面第 2 段钉住）。
    const tmp = await makeTmp()
    const pricing = { ...plain(new Config({}).pricing), 'qwen-image-3.0': { unit: 'image', unitPrice: 0.18, currency: 'CNY', asOf: '2026-10-16' } }
    const { tools } = setup(mock, tmp, {
      overrides: { requireSpendConfirm: true, videoCostLimitCNY: 0, videoSessionCostLimitCNY: 0, pricing },
    })
    const { exec } = newExec(tmp)
    const before = mock.submitCount('qwen')
    // (a) n=4 = ¥0.72 ≤ 1 → 一次调用直接出图，不需要 confirm_estimate
    const ok = await tools.qwen_draw.execute({ prompt: '小额免确认', n: 4 }, exec)
    assert.equal(ok.images.length, 4, '阈值内的批量出图应一次调用完成：' + JSON.stringify(ok.images.length))
    assert.equal(mock.submitCount('qwen') - before, 1, '应恰好提交一次')
    // 记账照旧（免确认不等于不记账）
    const ledger = await readJson(join(tmp, 'ledger.json'))
    assert.equal(ledger.records[0].amount, 0.72)
    assert.equal(ledger.records[0].units, 4)

    // (b) 阈值关成 0 → 同一批又要报价了（证明这个开关真的在起作用，而不是"永远免确认"）
    const tmp2 = await makeTmp()
    const off = setup(mock, tmp2, { overrides: { requireSpendConfirm: true, noConfirmUnderCNY: 0, videoCostLimitCNY: 0, videoSessionCostLimitCNY: 0, pricing } })
    const offBefore = mock.submitCount('qwen')
    await expectError(off.tools.qwen_draw.execute({ prompt: '小额免确认关闭', n: 4 }, newExec(tmp2).exec), CODES.BAD_REQUEST, ['confirm_estimate=0.72'])
    assert.equal(mock.submitCount('qwen'), offBefore, '关掉阈值后不该提交')

    // (c) 阈值只救"小额"：出片 5 秒 = ¥7.60 仍要确认（默认 threshold 1 元对出片无效）
    const tmp3 = await makeTmp()
    const videoSetup = setup(mock, tmp3, {
      overrides: { enableSeedanceVideo: true, requireSpendConfirm: true, videoCostLimitCNY: 0, videoSessionCostLimitCNY: 0 },
    })
    const videoExec = newExec(tmp3).exec
    const videoBefore = mock.submitCount('seedance')
    await expectError(videoSetup.tools.seedance_video.execute({ prompt: '出片仍要确认', duration: 5 }, videoExec), CODES.BAD_REQUEST, ['confirm_estimate=7.6'])
    assert.equal(mock.submitCount('seedance'), videoBefore, '大额（≥¥1.52/秒）仍必须确认')
  })

  // ------------------------------------------- 账本读不到时不许静默放行（2026-10-16 补）
  await test('会话累计上限不赌账本：读不到花销就抛错，绝不 return 0 放行', async () => {
    const thrown = async (fn) => {
      try {
        await fn()
      } catch (error) {
        return error
      }
      return undefined
    }
    // ① getLedger 抛错（例如 storage 领域打不开）
    let error = await thrown(() => sessionSpentOrThrow({ getLedger: async () => { throw new Error('storage down') }, sessionId: 's', providerLabel: 'X' }))
    assert.equal(error?.code, CODES.UNAVAILABLE, '账本打不开必须报 UNAVAILABLE：' + String(error))
    assert.ok(error.message.includes('未产生任何费用'), 'fail-closed 要明确这次没花钱：' + error.message)
    // ② 环境里根本没有账本（getLedger 返回空）
    error = await thrown(() => sessionSpentOrThrow({ getLedger: async () => undefined, sessionId: 's', providerLabel: 'X' }))
    assert.equal(error?.code, CODES.UNAVAILABLE)
    // ③ 账本在，但读失败
    error = await thrown(() =>
      sessionSpentOrThrow({ getLedger: async () => ({ list: async () => { throw new Error('IO') } }), sessionId: 's', providerLabel: 'X' }),
    )
    assert.equal(error?.code, CODES.UNAVAILABLE)
    // ④ 正常账本：求和；金额为 null（未计价）的记录不计入，也不能让整个求和变成 NaN
    const sum = await sessionSpentOrThrow({
      getLedger: async () => ({ list: async () => [{ amount: 1.5 }, { amount: null }, { amount: 0.25 }] }),
      sessionId: 's',
      providerLabel: 'X',
    })
    assert.equal(sum, 1.75)
  })

  await test('提交了但没取回产物，也要把那笔钱记上（且同一 taskId 只记一次）', async () => {
    const rows = []
    const ledger = { list: async () => rows.slice(), record: async (entry) => { rows.push(entry); return true } }
    const entry = { adapter: 'ark-video', provider: '方舟 Ark', model: 'doubao-seedance-2-5-260628', unitKind: 'second', units: 5, unitPrice: 1.519, currency: 'CNY', amount: 7.595 }
    const first = await accountUnretrievedSpend({ getLedger: async () => ledger, taskId: 't-1', entry })
    assert.equal(first, true)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].taskId, 't-1')
    assert.equal(rows[0].amount, 7.595)
    assert.ok(String(rows[0].note).includes('预估'), '要标明这是预估、不是已取回产物的实付：' + rows[0].note)
    // 同一个 taskId 再来一次 → 不重复记账（media_task 补下载后不会把钱算两遍）
    const second = await accountUnretrievedSpend({ getLedger: async () => ledger, taskId: 't-1', entry })
    assert.equal(second, false, '同一 taskId 不该重复记账')
    assert.equal(rows.length, 1)
    // 没有 taskId 时什么也不做（拿不到 id 就不猜）
    assert.equal(await accountUnretrievedSpend({ getLedger: async () => ledger, taskId: '', entry }), false)
    assert.equal(rows.length, 1)
  })

  await test('qwen_draw：等待超时 → TIMEOUT 文案照旧，但那笔钱要进账本', async () => {
    // 事故形态：反复"提交完就放弃"——远端已经计费，而成功路径的记账在产物落盘之后，
    // 所以账上永远是零、会话累计上限永不触顶。超时/取消这两条路必须补记预估。
    const tmp = await makeTmp()
    const pricing = { ...plain(new Config({}).pricing), 'qwen-image-3.0': { unit: 'image', unitPrice: 0.18, currency: 'CNY', asOf: '2026-10-16' } }
    const { tools } = setup(mock, tmp, {
      overrides: { dashscopeImageMode: 'async', taskTimeoutMs: 2000, taskPollIntervalMs: 500, taskPollMaxIntervalMs: 500, pricing },
    })
    const { exec } = newExec(tmp)
    const error = await expectError(tools.qwen_draw.execute({ prompt: '[stall] 钱也要记上' }, exec), CODES.TIMEOUT)
    const match = /task_id=([A-Za-z0-9_-]+)/.exec(error.message)
    assert.ok(match, '超时文案仍要带 task_id：' + error.message)
    const ledger = await readJson(join(tmp, 'ledger.json'))
    const row = ledger.records.find((record) => record.taskId === match[1])
    assert.ok(row, '超时也要把那笔"可能已计费"的钱记上：' + JSON.stringify(ledger.records))
    assert.equal(row.unitPrice, 0.18)
    assert.equal(row.amount, 0.18)
    assert.equal(row.units, 1)
    assert.ok(String(row.note).includes('预估'))
    // 再超时一次：那是**另一次提交、另一个任务**（每次都新建远端任务），所以各记一笔、互不覆盖
    const second = await expectError(tools.qwen_draw.execute({ prompt: '[stall] 钱也要记上' }, exec), CODES.TIMEOUT)
    const secondId = /task_id=([A-Za-z0-9_-]+)/.exec(second.message)[1]
    assert.notEqual(secondId, match[1], '两次提交应是两个不同的远端任务')
    const ledger2 = await readJson(join(tmp, 'ledger.json'))
    assert.equal(ledger2.records.length, 2, '两次提交各记一笔（去重是按 taskId，不是按 prompt）')
    assert.deepEqual(ledger2.records.map((record) => record.taskId).sort(), [match[1], secondId].sort())
  })

  // ------------------------------------------- 任务注册表的 storage 后端（2026-10-16 修）
  await test('任务注册表：有 storageDomain 时真的走 storage（此前恒为 file），降级必须被 health 点名', async () => {
    // 实机长期症状：media_task(list) 每次自报「注册表后端：file」，而账本同时是 storage。
    // 根因是注册表 open() 传的是裸 JSON-Schema，而宿主契约要 defineDomain + domainTable(zod)。
    const tmp = await makeTmp()
    const storageDomain = createFakeStorageDomain()
    const { tools } = setup(mock, tmp, { storageDomain })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: '注册表走 storage' }, exec)
    const listed = await tools.media_task.execute({ action: 'list' }, exec)
    assert.equal(listed.registryBackend, 'storage', '有 storageDomain 就必须用上它（2026-10-16 前这里恒为 file）')
    assert.equal(listed.tasks.length, 1)
    assert.equal(listed.tasks[0].provider, 'qwen')
    // 领域里确实落了记录（不是只把 backend 标成 storage 就完事）
    const domain = storageDomain.opened.get('mm_media_tasks')
    assert.ok(domain, '应打开 mm_media_tasks 领域')
    assert.equal(domain.domain.table('tasks').size, 1)

    // 没有 storageDomain（环境本就不带）→ 退回文件，但必须**说清原因**，不能只写个 file 就完
    const tmp2 = await makeTmp()
    const plainSetup = setup(mock, tmp2)
    const report = await plainSetup.tools.media_report.execute({ action: 'health' }, newExec(tmp2).exec)
    assert.ok(/账本\/注册表后端：.*file/.test(report.report), '降级要在 health 里可见：' + report.report)
    assert.ok(report.report.includes('任务注册表没有落在宿主 storage 领域'), '降级要给原因：' + report.report)
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

  await test('性能：开关签名是纯函数式的稳定串，逐个开关都会改变它', async () => {
    // 签名是"每秒对账短路"的判据（2026-10-15 优化）。它一旦漏变，配置变更就会被吞掉；
    // 一旦乱变，优化就退化成每次全量重算。两个方向都要钉住。
    const { switches } = setupSwitches()
    const base = switches.signature()
    assert.equal(typeof base, 'string')
    assert.equal(base, switches.signature(), '同一状态必须得到同一个签名（否则短路失效）')
    assert.equal(base.split(',').length, 7, '七个开关都要进签名：' + base)

    const fields = ['enableAskGlm', 'enableAskQwen', 'enableQwenDraw', 'enableSeedanceVideo', 'enableVideoGen', 'enableMediaTask', 'enableMediaReport']
    for (const field of fields) {
      const one = setupSwitches()
      const before = one.switches.signature()
      one.set(field)
      assert.notEqual(one.switches.signature(), before, field + ' 变化后签名必须跟着变：' + before)
    }
  })

  await test('性能优化不许吞掉配置变更：改开关后掩码必须在一个 tick 内跟上', async () => {
    // 这是"签名短路"的**正确性**测试。短路让稳态对账从 2.28 ms/s 降到 0.001 ms/s，
    // 代价是引入了一个缓存——缓存错了就会变成"改了开关但不生效"，
    // 那正是这个插件 2026-10-13 修过的老毛病。所以必须有测试盯着。
    const tmp = await makeTmp()
    const harness = makeSyncHarness()
    const config = makeConfig(mock, tmp, { enableQwenDraw: true, enableSeedanceVideo: false })
    const fake = createFakeCtx({ credentials: { DASHSCOPE_API_KEY: 'k', ARK_API_KEY: 'k' }, llmProviders: ['glm'] })
    const { agent, applied } = harness.install(fake)
    apply(fake.ctx, config)
    const tick = harness.tick()
    const created = fake.listeners.find((entry) => entry.event === 'agent/created').callback
    created({ agent })

    // 初始状态：seedance / 两个读图员都关着 → 创建时就按实时配置贴掩码
    // （顺序跟随 TOOL_SWITCHES 的声明顺序：ask_glm、ask_qwen、seedance_video）
    assert.deepEqual(applied.at(-1), ['ask_glm', 'ask_qwen', 'seedance_video', 'video_gen'], '创建时应按实时配置贴掩码：' + JSON.stringify(applied))

    // 稳态：连跑 5 次 tick，不该有任何新掩码（短路生效）
    const before = applied.length
    for (let i = 0; i < 5; i += 1) tick()
    assert.equal(applied.length, before, '开关没变时不该反复贴掩码（短路失效）：' + JSON.stringify(applied))

    // 打开 seedance → 下一次 tick 必须重新对账，且 deny 里不再有它
    config.enableSeedanceVideo = true
    tick()
    assert.equal(applied.length, before + 1, '开关变了下一次 tick 必须重新对账：' + JSON.stringify(applied))
    assert.deepEqual(applied.at(-1), ['ask_glm', 'ask_qwen', 'video_gen'], '打开后 seedance_video 不该再被 deny：' + JSON.stringify(applied))

    // 反向：关掉 qwen_draw → 下一次 tick 必须把它 deny 掉（deny 顺序 = TOOL_SWITCHES 声明顺序）
    config.enableQwenDraw = false
    tick()
    assert.deepEqual(applied.at(-1), ['ask_glm', 'ask_qwen', 'qwen_draw', 'video_gen'], '关掉后必须立刻 deny：' + JSON.stringify(applied))
  })

  await test('性能：工具 schema 体积有上限（每个请求都要发送，胖描述是持续成本）', async () => {
    // 工具定义随**每个请求**发送，所以参数描述的字节数是 per-request 成本。
    // 2026-10-15 优化：seedance_video 从 1663 B 降到 1098 B（两个确认参数原来写了近 600 B）。
    // 这里钉一个上限，防止以后又往 schema 里写小作文（正文该写进 README，不该写进工具表）。
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { overrides: { enableSeedanceVideo: true } })
    // 2026-10-17：新增 video_gen（1132 B，与 seedance_video 同档），合计上限同步 +1200。
    // 2026-10-17：新增 ask_glm / ask_qwen（插件自有读图员，描述约 1.1 KB/个），
    // 合计上限同步上调。描述值钱的地方是"读图"这两个字，别写小作文。
    // 2026-10-18：窄委派两行改由插件注册（988 B / 957 B；stock 工具那份通用文案
    // 与 subagent 逐字相同，等于白占字节还认不出身份）。合计上限同步上调到 8.6 KB。
    const budget = { ask_glm: 1300, ask_qwen: 1300, qwen_draw: 700, seedance_video: 1200, video_gen: 1200, media_task: 800, media_report: 500, subagent_code: 1050, subagent_research: 1050 }
    let total = 0
    for (const [name, definition] of Object.entries(tools)) {
      const bytes = Buffer.byteLength(JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }), 'utf8')
      total += bytes
      assert.ok(bytes <= budget[name], `${name} 的 schema 超预算：${bytes} B > ${budget[name]} B（描述该写进 README，不是写进每个请求）`)
    }
    assert.ok(total <= 8600, '九个工具 schema 合计超预算：' + total + ' B/请求（实测 8357）')
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
    { marker: '[auth]', code: CODES.AUTH, contains: ['无效或已过期', '插件页 → CN-gpt → 配置卡'], posts: 1 },
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
    await expectError(tools.qwen_draw.execute({ prompt: 'x' }, exec), CODES.MISSING_CREDENTIAL, ['DASHSCOPE_API_KEY', '插件页 → CN-gpt → 配置卡'])
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
    // ⚠ 这些断言看的是**完整明细**（单价表键名、未计入的长解释），所以显式要 verbose。
    // 紧凑模式的体积与"告警不省"由《报告体积预算》那条用例负责。
    const session = await tools.media_report.execute({ action: 'cost', verbose: true }, exec)
    assert.ok(session.report.includes('qwen-image-3.0'))
    assert.ok(session.report.includes('doubao-seedance-1-0-pro-fast-251015'))
    assert.ok(session.report.includes('合计：8.0950 CNY'))
    assert.ok(session.report.includes('估算值，非账单'))
    assert.ok(session.report.includes('读图子代理（ask_glm / ask_qwen，当前路由：'), '要交代读图子代理这条链路的计费状态')
    // 2026-10-17 改：原来的断言是"要说明未计入的原因（没有请求级钩子）"。
    // 该结论已不成立——插件现在订阅 `llm/stream` waterfall 并在 usage 分片上记账
    // （core/reader-usage.mjs）。本用例没有任何读图调用，所以正确行为是**如实说没观测到**，
    // 并交代统计口径（从插件加载起算），而不是宣称已经算到了钱。
    assert.ok(!session.report.includes('没有请求级钩子'), '旧结论不能再出现：' + session.report)
    assert.ok(session.report.includes('尚无观测记录') || session.report.includes('尚未观测到调用'),
      'verbose 下没观测到调用也要说清：' + session.report)
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
    const health = await tools.media_report.execute({ action: 'health', verbose: true }, exec)
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
    // 表格完整性：读图路由行与互斥告警必须**在表格之后**，不能把 Markdown 表格打成两截。
    // 回归 2026-10-19 实测缺陷（verbose=true 时路由行被插在 ask_glm / ask_qwen 两行之间）。
    const reportLines = health.report.split('\n')
    const firstRow = reportLines.findIndex((line) => line.startsWith('| 能力'))
    const lastRow = reportLines.reduce((acc, line, index) => (line.startsWith('|') ? index : acc), -1)
    assert.ok(firstRow >= 0 && lastRow > firstRow, '健康报表必须包含表格')
    assert.ok(
      !reportLines.slice(firstRow, lastRow + 1).some((line) => line.trim() === ''),
      '表格行之间不允许出现空行/路由附注：' + reportLines.slice(firstRow, lastRow + 1).join('\\n'),
    )
  })

  await test('media_report(health)：切到 ask_qwen → 报告 qwen-vl 路由，并在冲突时点出被压制的一方', async () => {
    const tmp = await makeTmp()
    const only = setup(mock, tmp, {
      llmProviders: ['glm', 'qwen-vl', 'deepseek-account'],
      overrides: { enableAskQwen: true },
    })
    const { exec } = newExec(tmp)
    const report = (await only.tools.media_report.execute({ action: 'health', verbose: true }, exec)).report
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
    const conflictReport = (await both.tools.media_report.execute({ action: 'health', verbose: true }, newExec(tmp2).exec)).report
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
    const report = (await tools.media_report.execute({ action: 'health', verbose: true }, newExec(tmp).exec)).report
    assert.ok(report.includes('❌ 未注册（检查 llm-pi-ai providers.qwen-vl 配置）'), report)
    assert.ok(report.includes('ask_qwen: ❌ 当前不可用'), report)
  })

  await test('media_report(health)：错误 key 的探测区分 AUTH，缺 key 的链路标记不可用', async () => {
    const tmp = await makeTmp()
    const { tools } = setup(mock, tmp, { credentials: { DASHSCOPE_API_KEY: 'wrong-key', ARK_API_KEY: undefined }, overrides: { enableSeedanceVideo: true, requireSpendConfirm: false  } })
    const { exec } = newExec(tmp)
    const health = await tools.media_report.execute({ action: 'health', verbose: true }, exec)
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
    const health = await tools.media_report.execute({ action: 'health', verbose: true }, exec)
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
            seen.push({ options, allow: filter.allow, deny: filter.deny })
            return () => {}
          },
        },
      },
    })

    // 主 agent：options 只有 provider/model（实测形状）。
    createdListener.callback({ agent: makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash' }), source: 'startup' })
    assert.ok(seen.at(-1).deny.includes('read_image'), '主 agent 应被 deny read_image：' + JSON.stringify(seen.at(-1)))

    // 读图子代理：options 里带 subagentDepth（实测形状）——必须保留 read_image。
    // 2026-10-17 起读图员走**白名单**（allow: [read_image]），不再逐个 deny。
    createdListener.callback({ agent: makeAgent({ provider: 'glm', model: 'glm-4.6v', subagentDepth: 1 }), source: 'startup' })
    assert.ok(seen.at(-1).allow?.includes('read_image'), '读图员应是 allow 白名单且含 read_image：' + JSON.stringify(seen.at(-1)))
    assert.ok(
      !seen.at(-1).deny?.includes('read_image'),
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

  // ---------------------------------------------------------------- 通用子代理原生读图开关（C，2026-10-15 加）
  await test('blockSubagentNativeVision 默认关闭：通用子代理保留 read_image（与旧行为一致）', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskGlm: true } })
    const createdListener = fake.listeners.find((entry) => entry.event === 'agent/created')
    const seen = []
    const makeAgent = (options) => ({
      options,
      ctx: {
        effect: (cb) => cb() ?? (() => {}),
        tools: {
          restrict(filter) {
            seen.push({ options, deny: filter.deny })
            return () => {}
          },
        },
      },
    })
    // 通用子代理：字面继承父路由（deepseek-account / deepseek-flash）+ subagentDepth。
    createdListener.callback({ agent: makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 }), source: 'startup' })
    assert.equal(
      seen.at(-1).deny.includes('read_image'),
      false,
      '开关默认关时通用子代理不该被 deny read_image：' + JSON.stringify(seen.at(-1)),
    )
  })

  await test('blockSubagentNativeVision 打开：通用子代理被 deny read_image，读图员必须豁免', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskGlm: true, blockSubagentNativeVision: true } })
    const createdListener = fake.listeners.find((entry) => entry.event === 'agent/created')
    const seen = []
    const makeAgent = (options) => ({
      options,
      ctx: {
        effect: (cb) => cb() ?? (() => {}),
        tools: {
          restrict(filter) {
            seen.push({ options, allow: filter.allow, deny: filter.deny })
            return () => {}
          },
        },
      },
    })

    // 通用子代理（继承父路由）→ 必须被摘掉 read_image
    createdListener.callback({ agent: makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 }), source: 'startup' })
    assert.ok(
      seen.at(-1).deny.includes('read_image'),
      '通用子代理应被 deny read_image：' + JSON.stringify(seen.at(-1)),
    )

    // 读图员（provider 命中契约文件里的 glm）→ 必须保留。**判错就是让读图员瞎掉。**
    // 2026-10-17 起读图员改用 allow 白名单（只留 read_image），比逐个 deny 更可靠。
    createdListener.callback({ agent: makeAgent({ provider: 'glm', model: 'glm-4.6v', subagentDepth: 1 }), source: 'startup' })
    assert.ok(
      seen.at(-1).allow?.includes('read_image'),
      '读图员应是 allow 白名单且含 read_image（判据取自契约文件）：' + JSON.stringify(seen.at(-1)),
    )
    assert.equal(seen.at(-1).deny, undefined, '读图员不该再走 deny 路径：' + JSON.stringify(seen.at(-1)))

    // 只认 model 的读图员（provider 名被改过）也要豁免 —— 两个信号满足任一个即可。
    createdListener.callback({ agent: makeAgent({ provider: 'some-renamed-route', model: 'qwen3-vl-plus', subagentDepth: 1 }), source: 'startup' })
    assert.ok(
      seen.at(-1).allow?.includes('read_image'),
      'model 命中读图员路由时也该走白名单' + JSON.stringify(seen.at(-1)),
    )

    // 主代理不受这个开关影响（它归 blockMainAgentNativeVision 管）。
    createdListener.callback({ agent: makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash' }), source: 'startup' })
    assert.equal(
      seen.at(-1).deny?.includes('read_image'),
      false,
      'blockSubagentNativeVision 不该顺带屏蔽主代理（那是另一个开关的职责）：' + JSON.stringify(seen.at(-1)),
    )
  })

  await test('原生读图兜底守卫：即使掩码因重新装配丢失，read_image 调用仍被拦（2026-10-16 实测回归）', async () => {
    // 现场：profile 写着 blockMainAgentNativeVision: true、cordis.yml 里也是 true，
    // 但重新装配后主代理**仍然成功调用了 read_image**（掩码只在 agent/created 时贴，
    // 且卸载时会被 dispose；既有 agent 不会再触发 agent/created → 掩码永久丢失）。
    // 这条守卫就是那个漏洞的兜底：它每次调用都读实时配置，与 agent 何时创建无关。
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskGlm: true, blockMainAgentNativeVision: true } })
    const guard = guardOf(fake, GUARD_NATIVE_VISION)
    const mainAgent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' } }

    const verdict = guard({ name: 'read_image', file_path: 'C:/x/a.png', args: { file_path: 'C:/x/a.png' }, agent: mainAgent })
    assert.ok(typeof verdict === 'string' && verdict.length > 0, '屏蔽开关打开时必须拦下 read_image：' + String(verdict))
    assert.ok(verdict.includes('ask_glm'), '要指向当前可用的读图员：' + verdict)
    assert.ok(!verdict.includes('没有任何看图途径'), '读图员开着时不该说没有途径：' + verdict)

    // 不误伤：开关关着、读图员自己、以及别的工具都要放行。
    const off = setup(mock, await makeTmp(), { overrides: { enableAskGlm: true } })
    assert.equal(
      guardOf(off.fake, GUARD_NATIVE_VISION)({ name: 'read_image', args: {}, agent: mainAgent }),
      undefined,
      '开关关着时不该拦 read_image',
    )
    assert.equal(guard({ name: 'read', args: { file_path: 'C:/x/a.png' }, agent: mainAgent }), undefined, '这条守卫只管 read_image')
    assert.equal(
      guard({ name: 'read_image', args: {}, agent: { options: { provider: 'glm', model: 'glm-4.6v', subagentDepth: 1 } } }),
      undefined,
      '读图员自己的 read_image 必须放行',
    )
  })

  await test('blockSubagentNativeVision 打开：通用子代理的 read_image 调用也被兜底守卫拦下', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { enableAskGlm: true, blockSubagentNativeVision: true } })
    const guard = guardOf(fake, GUARD_NATIVE_VISION)
    const generic = { options: { provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 } }
    const verdict = guard({ name: 'read_image', args: {}, agent: generic })
    assert.ok(typeof verdict === 'string', '通用子代理应被拦：' + String(verdict))
    assert.ok(verdict.includes('通用子代理'), '文案要说清屏蔽对象是子代理：' + verdict)
    assert.ok(verdict.includes('ask_glm'), '要指向读图员：' + verdict)
  })

  await test('读图员豁免名单取自契约文件（不是硬编码）：改路由名也能认出来', async () => {
    // 这条是 C 的安全带：判别一旦失效，读图员会被一起弄瞎。
    const tmp = await mkdtemp(join(tmpdir(), 'mm-reader-route-'))
    tmpRoots.push(tmp)
    await mkdir(join(tmp, 'profiles', 'p'), { recursive: true })
    await writeFile(
      join(tmp, 'profiles', 'p', 'cordis.yml'),
      [
        '- id: tool-subagent-custom',
        "  name: '@deepseek-ai/dsh-tool-subagent'",
        '  config:',
        '    provider: spawn',
        '    toolName: ask_custom',
        '    maxDepth: 2',
        '    agentOptions: { provider: my-renamed-vision, model: my-vl-9 }',
        '    toolFilter: { allow: [read_image] }',
      ].join('\n'),
      'utf8',
    )
    const allow = readerRouteAllowlist({ dshHome: tmp })
    assert.ok(allow.providers.includes('my-renamed-vision'), '契约文件里的 provider 应进白名单：' + JSON.stringify(allow.providers))
    assert.ok(allow.modelPrefixes.includes('my-vl-9'), '契约文件里的 model 也应进白名单：' + JSON.stringify(allow.modelPrefixes))
    assert.equal(
      isReaderAgent({ options: { provider: 'my-renamed-vision', model: 'my-vl-9', subagentDepth: 1 } }, allow),
      true,
      '改了名字的读图员也要被认出来',
    )
    assert.equal(
      isReaderAgent({ options: { provider: 'deepseek-account', model: 'deepseek-flash', subagentDepth: 1 } }, allow),
      false,
      '通用子代理不该被误认成读图员',
    )
    // 空 home：插件自带的 patch 里**已经没有读图行**（2026-10-17 工具改由插件注册），
    // 所以扫描结果为空；白名单仍要含兜底 provider，且不能因此把通用子代理误认成读图员。
    const empty = await mkdtemp(join(tmpdir(), 'mm-reader-empty-'))
    tmpRoots.push(empty)
    const fallback = readerRouteAllowlist({ dshHome: empty })
    assert.equal(fallback.routes.length, 0, '自带 patch 里不应再有 tool-subagent 读图行')
    assert.ok(fallback.providers.includes('glm'), '兜底白名单要含 glm：' + JSON.stringify(fallback.providers))

    // 新单一事实源：Config 里的 reader* 路由经 mergeReaderRoutes 进白名单。
    const fromConfig = mergeReaderRoutes([
      { id: 'ask_glm', provider: 'glm', model: 'glm-5.3-flash', maxDepth: 2 },
      { id: 'ask_qwen', provider: 'qwen-vl', model: 'qwen3-vl-plus', maxDepth: 2 },
    ])
    assert.equal(fromConfig.routes.length, 2, 'Config 里的两个读图员路由都要在')
    assert.ok(fromConfig.providers.includes('glm') && fromConfig.providers.includes('qwen-vl'))
    assert.ok(fromConfig.modelPrefixes.includes('glm-5.3-flash'), '模型名也要进白名单')
    assert.equal(
      isReaderAgent({ options: { provider: 'glm', model: 'glm-5.3-flash' } }, fromConfig),
      true,
      'Config 路由声明必须能认出读图员',
    )
    assert.equal(
      isReaderAgent({ options: { provider: 'deepseek-account', model: 'deepseek-flash' } }, fromConfig),
      false,
      '通用子代理不该被误认成读图员',
    )
    // 读图员路由的 maxDepth 必须 ≥ 2（否则 C 打开后子代理没有看图途径）。
    for (const route of fromConfig.routes) {
      assert.ok(
        typeof route.maxDepth === 'number' && route.maxDepth >= 2,
        route.id + ' 的 maxDepth 必须 ≥ 2（实测 < 2 会让子代理调不动读图员）：' + String(route.maxDepth),
      )
    }
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

    // ---- 正面：插件自有、宿主无从得知的三件事 ----
    // 2026-10-16 第二次瘦身：**去掉身份声明**（"你是主创兼工程师…"），因为它会被注入到
    // 每一个 agent（实测 57/57 个读图员会话都带着），对读图员是错的、且与它的 persona 打架。
    assert.ok(sectionText.includes('【媒体分工】') && sectionText.includes('负全责'), '应保留分工与交付责任')
    assert.ok(sectionText.includes('读图路由'), '应保留读图路由策略（这是插件才知道的信息）')
    assert.ok(sectionText.includes('ask_glm') && sectionText.includes('ask_qwen'), '路由策略要点名两个读图员')
    assert.ok(sectionText.includes('没有看图途径'), '没读图员时要如实说明')
    // 2026-10-17：路由改成"原生优先"，不再写死"一律走 ask_glm"；但"不要猜图"这条退路必须保留。
    assert.ok(sectionText.includes('不要猜图'), '要禁止"猜图"这条退路')
    assert.ok(sectionText.includes('原生 read_image'), '原生可用时应优先原生（不再强制走读图员）')
    assert.ok(sectionText.includes('【窄委派】'), '要给出窄工具面委派的建议（子代理每轮背 35 个工具≈32KB）')
    assert.ok(!sectionText.includes('你是主创兼工程师'), '不该再有身份声明（读图员也收得到这段）')

    // 读图员是唯一有意的例外；其它工具名仍不出现
    assert.ok(!/qwen_draw|seedance_video|media_task|media_report/.test(sectionText), '仍不应出现其它工具名')
  })

  await test('提示词段落：原生被屏蔽时说「走读图员」，不让模型去试原生', async () => {
    const tmp = await makeTmp()
    const { fake } = setup(mock, tmp, { overrides: { blockMainAgentNativeVision: true } })
    const text = typeof fake.sections[0].text === 'function' ? fake.sections[0].text({}) : fake.sections[0].text
    assert.ok(text.includes('已屏蔽'), '要说清原生已被屏蔽：' + text)
    assert.ok(text.includes('ask_glm') && text.includes('ask_qwen'), '要指向读图员')
    assert.ok(text.includes('没有看图途径') && text.includes('不要猜图'), '保底与禁止猜图不能丢')
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
    assert.ok(health.report.includes('账本/注册表后端：storage'))
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

  // ================================================== 2026-10-15 事故的回归用例
  //
  // 两个真实故障，当时的套件**都没覆盖**，所以各自溜到了生产：
  //   ① 单价写成 0：预估金额算成 ¥0.00，于是单次上限 / 会话上限 / 强制确认
  //      三层闸门全部放行 —— "在单价表里写个 0"就能把整道花钱闸门关掉；
  //   ② 未计价记录（unitPrice/amount = null）过不了账本自己的 zod schema，
  //      重启后整个 storage 领域 open() 失败、静默退回空的 JSON 账本，
  //      报表里历史用量凭空消失。
  // 下面每条都写成"改坏就必须失败"的形状。

  await test('零价闸门：unitPrice=0 必须走未计价分支，不能被算成"预估 ¥0"', async () => {
    // ① 预估函数本身
    const zero = estimateSpend({ model: 'doubao-seedance-2-5-260628', duration: 30, unitPrice: 0 })
    assert.equal(zero.estimated, null, '0 元单价不得算出金额（算出来三层闸门就全过了）：' + JSON.stringify(zero))
    assert.ok(/0/.test(zero.reason) && /免费|未计价/.test(zero.reason), '理由要点明 0 是"宣称免费"还是"未知"：' + zero.reason)
    // 对照：正价必须照常预估（别把闸门修成"谁都不放行"）
    assert.equal(estimateSpend({ model: 'm', duration: 10, unitPrice: 1.519 }).estimated, 15.19, '正价必须照常预估')
    // 其它非法价也一律不算
    assert.equal(estimateSpend({ model: 'm', duration: 5, unitPrice: -1 }).estimated, null, '负价不得预估')
    assert.equal(estimateSpend({ model: 'm', duration: 5, unitPrice: null }).estimated, null, '未计价不得预估')
    assert.equal(estimateSpend({ model: 'm', duration: 5, unitPrice: Number.NaN }).estimated, null, 'NaN 不得预估')

    // ② 端到端：拿 0 价去闸门，必须被拒（而不是"复述 ¥0 即放行"）
    const gate = await authorizeSpend({
      estimate: zero,
      config: { videoCostLimitCNY: 10, videoSessionCostLimitCNY: 30, requireSpendConfirm: true, allowUnpricedSpend: false },
      spentInSession: async () => 0,
      confirmed: { confirm_estimate: 0 },
      providerLabel: '方舟 Ark',
    })
    assert.equal(gate.ok, false, '0 价 + 复述 ¥0 绝不能放行：' + JSON.stringify(gate))
  })

  await test('零价自检：在用模型被写成 0 必须在告警里点名（不能静默）', async () => {
    const base = { ...plain(new Config({}).pricing) }
    const inUse = { qwenModel: 'qwen-image-3.0', seedanceModel: 'doubao-seedance-2-5-260628' }
    // 干净配置：一条告警都不该有（对照，防止"报警报成狼来了"）
    assert.equal(pricingWarnings({ pricing: base, ...inUse }).length, 0, '干净配置不应报警')

    // 现场复刻：在用的制图模型被写成 0（2026-10-15 报表显示"16 张图 ¥0.0000"的那个配置）
    const zeroed = { ...base, 'qwen-image-3.0': { unit: 'image', unitPrice: 0, currency: 'CNY', asOf: '2026-10-12' } }
    const warnings = pricingWarnings({ pricing: zeroed, ...inUse })
    assert.ok(warnings.length >= 1, '在用模型写 0 必须有告警，实际 ' + warnings.length + ' 条')
    assert.ok(warnings.some((w) => w.includes('qwen-image-3.0')), '要点名是哪个模型：' + warnings.join(' | '))

    // 出片模型被写成 0 同样要点名（2026-10-15 出片锁死的那条路径）
    const zeroedVideo = { ...base, 'doubao-seedance-2-5-260628': { unit: 'second', unitPrice: 0, currency: 'CNY', asOf: '2026-10-12' } }
    const videoWarnings = pricingWarnings({ pricing: zeroedVideo, ...inUse })
    assert.ok(videoWarnings.some((w) => w.includes('doubao-seedance-2-5-260628')), '出片模型写 0 也要点名：' + videoWarnings.join(' | '))
  })

  await test('isPriced：0 / 负数 / null 都不算已计价，只有正数才算', async () => {
    assert.equal(isPriced({ unit: 'image', unitPrice: 0 }), false, '0 不是已计价')
    assert.equal(isPriced({ unit: 'image', unitPrice: 0.18 }), true, '正价是已计价')
    assert.equal(isPriced({ unit: 'second', unitPrice: -1 }), false, '负价不是已计价')
    assert.equal(isPriced({ unit: 'ktoken', inputPrice: 0, outputPrice: 0 }), false, 'ktoken 全 0 不是已计价')
    assert.equal(isPriced({ unit: 'ktoken', inputPrice: 0.5, outputPrice: 0 }), true, 'ktoken 有一项正价即已计价')
    assert.equal(isPriced({ unit: 'image', unitPrice: null }), false, 'null 不是已计价')
    assert.equal(isPriced(null), false, '缺条目不是已计价')
  })

  await test('账本 schema：未计价记录（unitPrice/amount = null）必须能通过校验', async () => {
    // 关键：未计价是插件**有意写入**的形态。schema 若只收 number，
    // 一条 null 记录就会让整个领域 open() 失败 → 静默退回空 JSON 账本。
    const tmp = await makeTmp()
    const storageDomain = createFakeStorageDomain()
    const { tools } = setup(mock, tmp, { storageDomain })
    const { exec } = newExec(tmp)
    await tools.qwen_draw.execute({ prompt: 'schema 检查' }, exec)

    const opened = storageDomain.opened.get('mm_media_ledger')
    assert.ok(opened !== undefined, 'storage 账本领域应已被打开')
    const usage = opened.spec.tables.usage.valueSchema
    assert.equal(usage.shape.unitPrice.isNullable, true, 'unitPrice 必须放行 null（未计价）')
    assert.equal(usage.shape.amount.isNullable, true, 'amount 必须放行 null（未计价）')
    // 对照：别把整个 schema 放松了，其余字段仍要严格
    assert.equal(usage.shape.units.isNullable, false, 'units 不该被放松')
    assert.equal(usage.shape.currency.isNullable, false, 'currency 不该被放松')
    // 宿主的官方护栏：未来再出现形状漂移时，坏记录备份跳过而不是整领域打不开
    assert.equal(opened.spec.invalidRecords, 'backup-and-skip', '必须声明宿主的备份跳过策略')
  })

  await test('账本退回文件后端时，health 报告必须说清原因（不能静默）', async () => {
    const tmp = await makeTmp()
    const broken = {
      async open() {
        throw new Error('invalid-record: stored record does not match its schema')
      },
    }
    const { tools } = setup(mock, tmp, { storageDomain: broken })
    const { exec } = newExec(tmp)
    const health = await tools.media_report.execute({ action: 'health' }, exec)
    assert.ok(/账本\/注册表后端：.*file/.test(health.report), health.report)
    assert.ok(health.report.includes('账本没有落在宿主 storage 领域'), '退化为文件后端必须点名：' + health.report)
    assert.ok(health.report.includes('invalid-record'), '要带上宿主给的原因：' + health.report)
  })

  // ⚠ 上面那条只覆盖了"服务在、但 open() 抛错"这一支。2026-10-15 实测发现**另一支是静默的**：
  // `ctx.get('storageDomain')` 压根没命中（热重载 / 装配时序）时 storageError 保持 undefined，
  // 于是报表对着磁盘上 15 条真实用量说"没有符合条件的用量记录"，而 health 只说
  // 「账本后端：file」不解释 —— 这正是"看不见的告警等于没有告警"。下面把它钉住。
  await test('storageDomain 服务拿不到时，账本降级同样必须点名（曾经是静默的）', async () => {
    const tmp = await makeTmp()
    // 刻意不传 storageDomain：就是"服务没拿到"那一支
    const { tools } = setup(mock, tmp)
    const { exec } = newExec(tmp)
    const health = await tools.media_report.execute({ action: 'health' }, exec)
    assert.ok(/账本\/注册表后端：.*file/.test(health.report), health.report)
    assert.ok(
      health.report.includes('账本没有落在宿主 storage 领域'),
      '服务拿不到时也必须解释降级原因，不能静默：' + health.report,
    )
    assert.ok(health.report.includes('storageDomain'), '原因里要写清是哪个服务：' + health.report)
  })

  await test('零价记录：报表不得把 unitPrice=0 显示成 0.0000（判据与闸门同源）', async () => {
    // 这两条记录就是本机磁盘上的真实形态：占位表时代写下的 unitPrice=0 + 未计价的出片。
    const records = [
      { at: '2026-10-13T07:30:18.983Z', adapter: 'dashscope-image', provider: 'DashScope', model: 'qwen-image-3.0', unitKind: 'image', units: 2, unitPrice: 0, currency: 'CNY', amount: 0, sessionId: 's1' },
      { at: '2026-10-15T08:02:12.379Z', adapter: 'ark-video', provider: '方舟 Ark', model: 'doubao-seedance-2-5-260628', unitKind: 'second', units: 5, unitPrice: null, currency: 'CNY', amount: null, sessionId: 's1' },
    ]
    const report = renderCostReport({ records, config: newConfigOnly(), scope: 'all' })
    assert.ok(report.includes('零价（无效）'), '单价 0 必须显式标成「零价（无效）」：' + report)
    assert.ok(!report.includes('0.0000 CNY/image'), '不得再把零价显示成 ¥0.0000（= 真钱显示成免费）：' + report)
    assert.ok(report.includes('（不可信）'), '零价组的金额要标注不可信：' + report)
    assert.ok(report.includes('另有 1 个型号单价为 0'), '合计口径要点出零价型号数：' + report)
    assert.ok(report.includes('0 不是价'), '要有一句人话解释为什么 0 不可信：' + report)
    // 对照：null（真未计价）仍然写「未计价」，两种状态不能混成一个
    assert.ok(report.includes('未计价'), '未计价（null）仍要显示未计价：' + report)
    assert.ok(report.includes('另有 1 个型号未计价'), report)
    // 合计金额不变（这里两条记录本来就都是 0）
    assert.ok(report.includes('合计：0.0000 CNY'), report)
  })

  await test('零价修复不能把钱藏起来：同一型号混有零价与正价记录时，正价金额必须留在合计里', async () => {
    // 真实场景：某型号的历史记录里混着"占位表时代（0 价）"和"修好后（0.18）"两种记录。
    const records = [
      { at: '2026-10-13T07:30:18.983Z', adapter: 'dashscope-image', provider: 'DashScope', model: 'qwen-image-3.0', unitKind: 'image', units: 2, unitPrice: 0, currency: 'CNY', amount: 0 },
      { at: '2026-10-14T07:30:18.983Z', adapter: 'dashscope-image', provider: 'DashScope', model: 'qwen-image-3.0', unitKind: 'image', units: 16, unitPrice: 0.18, currency: 'CNY', amount: 2.88 },
    ]
    const report = renderCostReport({ records, config: newConfigOnly(), scope: 'all' })
    assert.ok(report.includes('合计：2.8800 CNY'), '合计必须是记录内金额之和（2.88），不能被零价过滤吃掉：' + report)
    assert.ok(report.includes('2.8800 CNY（不可信）'), '该组的单价列是 0（取首条记录），金额列要如实打印并标注不可信：' + report)
  })

  await test('发布用 patch 与出厂 Config 对齐：不漏键、不多键、无零价、默认模型有价', async () => {
    const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const start = text.indexOf('- id: mm-models')
    assert.ok(start >= 0, 'cordis.patch.yml 里应有 mm-models 行')
    const rest = text.slice(start)
    const next = rest.slice(1).search(/\n- id: /)
    const block = next < 0 ? rest : rest.slice(0, next + 1)

    // ① 键集合必须与 Config 完全一致（缺键 ⇒ 新装用户看不到那些开关/闸门）
    const patchKeys = [...block.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
    const configKeys = Object.keys(new Config({}))
    const missing = configKeys.filter((key) => !patchKeys.includes(key))
    const extra = patchKeys.filter((key) => !configKeys.includes(key))
    assert.deepEqual(missing, [], '出厂模板漏了 Config 字段：' + missing.join('、'))
    assert.deepEqual(extra, [], '出厂模板含 Config 里不存在的字段（错别字？）：' + extra.join('、'))

    // ② 单价表里不得有 0（0 = 宣称免费，闸门按未计价处理、报表也不再显示成 0.0000）
    assert.ok(!/^ {12}unitPrice: 0(\.0+)?\s*$/m.test(block), '模板单价表里不得出现 unitPrice: 0')
    assert.ok(!/^ {12}(inputPrice|outputPrice): 0(\.0+)?\s*$/m.test(block), '模板单价表里不得出现 0 价')

    // ③ 外键：默认模型必须在单价表里有**正价**（2026-10-15 出片锁死事故的根因就是它没对上）
    const modelOf = (field) => new RegExp(`^ {8}${field}: (.+)$`, 'm').exec(block)?.[1]?.trim()
    const priceOf = (model) => {
      const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const matched = new RegExp(`\\n {10}${escaped}:\\n([\\s\\S]*?)(?=\\n {10}[^\\s]|\\n {8}[A-Za-z])`).exec(block)
      return matched === null ? null : /unitPrice:\s*([^\s]+)/.exec(matched[1])?.[1]
    }
    for (const field of ['seedanceModel', 'qwenModel']) {
      const model = modelOf(field)
      assert.ok(typeof model === 'string' && model.length > 0, `模板里 ${field} 应有取值`)
      const price = priceOf(model)
      assert.ok(price !== null && Number(price) > 0, `模板里 ${field}=${model} 在单价表中必须有正价（实际 ${price}）`)
    }
  })

  await test('DSH 兼容性声明：engines.dsh 只覆盖 0.2.1+（子代理行用 preset），排除 0.3', async () => {
    // 2026-10-17 适配 0.2.1-rc.1：新版本优先按 `engines.dsh` 判断兼容性
    // （未声明才回落 peerDependencies），且用 semver 的 includePrerelease:true 求值。
    // ⚠ 0.2.0 的 dsh-tool-subagent **不支持 agentPreset**（实测：旧包源码里 0 次出现），
    //   而本插件的子代理行已迁到 preset —— 所以下限必须是 0.2.1-rc.1，不能假装兼容 0.2.0。
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(typeof manifest.name, 'string')
    assert.equal(typeof manifest.version, 'string')
    assert.equal(typeof manifest.engines, 'object', 'package.json 必须有 engines 字段')
    const range = manifest.engines.dsh
    assert.equal(typeof range, 'string', 'engines.dsh 必须是字符串范围')
    assert.ok(range.trim().startsWith('>='), 'engines.dsh 应是显式下限范围：' + range)
    // 关键：includePrerelease 下 `<0.3.0` 会放进 0.3.0-rc.1，必须写 `<0.3.0-0`。
    assert.ok(range.includes('<0.3.0-0'), '必须排除 0.3.0 预发布：' + range)
    assert.ok(range.includes('0.2.1-rc.1'), '下限应是 0.2.1-rc.1（0.2.0 不支持 agentPreset）：' + range)
    assert.ok(!range.includes('0.2.0'), '不该再声明兼容 0.2.0：' + range)
    // peer 仍要保留：未声明 engines.dsh 的旧版 DSH 靠它判断。
    for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-storage-domain']) {
      assert.equal(typeof manifest.peerDependencies?.[peer], 'string', 'peerDependencies 必须保留 ' + peer)
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
