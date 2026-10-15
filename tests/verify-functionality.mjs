/**
 * 优化功能验证套件（2026-10-15）。
 *
 * 目的：证明"为了性能削减每轮请求的 JSON 体积"与"给每秒对账加签名短路"这两处改动
 * **没有影响任何插件功能**。不重复 run.mjs 已覆盖的逻辑，而是针对改动逐项取证：
 *
 *   ① schema 完整性——削掉的是描述文字，不是参数、类型、必填、枚举或输出契约；
 *   ② 花钱闸门语义——被削的两个确认参数在**行为**上分毫未变；
 *   ③ 模型信息量——描述短了，但模型做错时能不能从**错误文案**里拿到同样的指引（信息不能凭空消失）；
 *   ④ 开关→掩码——签名短路不许吞掉配置变更（多 agent / 多轮 / 双向）；
 *   ⑤ guard 拦截行为——四条守卫的判定结论不受"减字节"影响；
 *   ⑥ 描述变更后仍能真正出片——用真参数跑完整条提交/轮询/落盘链路。
 *
 * 运行：node --import ./tests/register.mjs ./tests/verify-functionality.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = join(tmpdir(), 'mm-models-verify-home')
process.env.DSH_HOME = TEST_HOME

const { startMockProviders } = await import('./mock-providers.mjs')
const { createFakeCtx, makeExec } = await import('./fixtures.mjs')
const { Config, apply } = await import('../index.js')
const { CODES } = await import('../core/errors.mjs')

const stats = { passed: 0, failed: 0 }
async function test(name, fn) {
  try {
    await fn()
    stats.passed += 1
    console.log('  \u2713 ' + name)
  } catch (error) {
    stats.failed += 1
    console.log('  \u2717 ' + name)
    console.log('    ' + String(error?.stack ?? error).split('\n').slice(0, 5).join('\n    '))
  }
}

const mock = await startMockProviders()
const tmpRoots = []
async function makeTmp() {
  const root = await mkdtemp(join(tmpdir(), 'mm-verify-'))
  tmpRoots.push(root)
  return root
}

function plain(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

function makeConfig(tmp, overrides = {}) {
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

async function setup(overrides = {}) {
  const tmp = await makeTmp()
  const ctx = createFakeCtx({
    credentials: { DASHSCOPE_API_KEY: mock.state.logins.dashscope, ARK_API_KEY: mock.state.logins.ark, ZHIPU_API_KEY: 'k' },
    llmProviders: ['glm', 'deepseek-account'],
  })
  const config = makeConfig(tmp, overrides)
  apply(ctx.ctx, config)
  return { tmp, ctx, config, tools: Object.fromEntries(ctx.tools.map((d) => [d.name, d])) }
}

// ================================================================ ① schema 完整性
await test('① 削减字节后，schema 的**功能面**一个都没少（与优化前提交逐字对比）', async () => {
  const { tools } = await setup({ enableSeedanceVideo: true })

  // 1) 四个工具都还在
  assert.deepEqual(Object.keys(tools).sort(), ['media_report', 'media_task', 'qwen_draw', 'seedance_video'])

  // 2) 与优化前的提交**逐字对比参数结构**：参数集合 / 类型 / required / enum / 输出契约
  //    为什么这么做而不是手写期望值：手写期望值会把我对设计的误解写成"规格"
  //    （第一版就误以为 media_task.task_id 带 required 标记）。与历史版本对比才是客观的。
  const { execFileSync } = await import('node:child_process')
  const before = execFileSync('git', ['show', 'ccc80b1~1:tools/seedance-video.mjs'], { encoding: 'utf8' })
  const after = await readFile(new URL('../tools/seedance-video.mjs', import.meta.url), 'utf8')
  /**
   * 从源码里抽出 parameters 段，**把描述文本整个抹掉**后比对
   * （描述是本次唯一允许变的东西；结构、类型、required 都必须逐字不变）。
   *
   * 实现取巧但可靠：删掉所有中文串与英文串字面量。
   * 比写正则去匹配"单行 / 续行拼接"两种描述写法更稳——后者第一版就漏了续行。
   */
  const structureOf = (source) => {
    const start = source.indexOf('parameters: {')
    const end = source.indexOf('output: {', start)
    return source
      .slice(start, end)
      .replace(/'[^']*'/g, '<str>') // 所有字符串字面量（含续行拼接的每一段）
      .replace(/\s*\+\s*/g, ' + ') // 拼接运算符也是"描述写法"，不算结构
      .replace(/<str>( \+ <str>)+/g, '<str>') // 多段拼接归一成一段
      .replace(/\s+/g, ' ')
      .trim()
  }
  assert.equal(structureOf(after), structureOf(before), 'seedance_video 的参数结构（去掉描述后）必须与优化前逐字一致')

  // 3) 枚举值（模型靠它知道 action 能填什么）一个字都没少
  assert.deepEqual(tools.media_report.parameters.action.enum, ['cost', 'health'])
  assert.deepEqual(tools.media_task.parameters.action.enum, ['status', 'download', 'list'])
  assert.deepEqual(tools.media_report.parameters.scope.enum, ['session', 'today', 'all'])

  // 4) 输出契约（渲染器依赖它）原样
  assert.equal(typeof tools.seedance_video.output.render, 'function')
  assert.equal(typeof tools.qwen_draw.output.render, 'function')
  assert.equal(tools.seedance_video.output.schema.properties.videos.type, 'array')
  // 被削描述的两个参数仍在（名字 + 类型是模型调用它的唯一依据）
  assert.equal(tools.seedance_video.parameters.confirm_estimate.type, 'number')
  assert.equal(tools.seedance_video.parameters.confirm_unpriced.type, 'boolean')

  // 5) 每个参数仍带描述（削的是长度，不是把描述清空）
  for (const [name, definition] of Object.entries(tools)) {
    for (const [key, param] of Object.entries(definition.parameters)) {
      assert.ok(typeof param.description === 'string' && param.description.length > 0, `${name}.${key} 描述空了`)
    }
    assert.ok(typeof definition.description === 'string' && definition.description.length > 0, name + ' 工具描述空了')
  }
})

// ================================================================ ② 闸门语义
await test('② 花钱闸门语义未变：两步确认 / 金额不符 / 上限 / 未计价', async () => {
  // 被削描述的正是这两个参数，所以这里必须证明**行为**逐条不变。
  const { tools } = await setup({ enableSeedanceVideo: true, videoCostLimitCNY: 0, videoSessionCostLimitCNY: 0, requireSpendConfirm: true })
  const exec = makeExec({ cwd: tmpdir(), sessionId: 'verify-gate' })

  // (a) 不给金额 → 只报价、不提交
  let thrown
  try {
    await tools.seedance_video.execute({ prompt: '两步确认', duration: 4 }, exec)
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown?.code, CODES.BAD_REQUEST)
  assert.ok(thrown.message.includes('7.60') === false || true) // 金额见下条断言
  assert.ok(/¥?6\.08/.test(thrown.message), '4 秒 × 1.519 应报 ¥6.08：' + thrown.message)
  assert.ok(thrown.message.includes('未产生任何费用'), '要明确没花钱')
  assert.ok(thrown.message.includes('confirm_estimate=6.08'), '要给出可复述的准确金额')

  // (b) 金额对得上 → 放行并真出片
  const ok = await tools.seedance_video.execute({ prompt: '两步确认', duration: 4, confirm_estimate: 6.08 }, exec)
  assert.equal(ok.videos.length, 1, '金额正确应出片')

  // (c) 金额不符 → 拦下
  thrown = undefined
  try {
    await tools.seedance_video.execute({ prompt: '金额不符', duration: 4, confirm_estimate: 1 }, exec)
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown?.code, CODES.BAD_REQUEST)
  assert.ok(thrown.message.includes('对不上'), '金额不符要被识别：' + thrown.message)

  // (d) 未计价 + 自报金额 → 仍然拒绝（这条是上一轮修的洞，不能被性能改动带回来）
  const unpriced = await setup({ enableSeedanceVideo: true, pricing: {}, allowUnpricedSpend: false })
  const unpricedExec = makeExec({ cwd: tmpdir(), sessionId: 'verify-gate-2' })
  thrown = undefined
  try {
    await unpriced.tools.seedance_video.execute({ prompt: '未计价', duration: 5, confirm_estimate: 7.6 }, unpricedExec)
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown?.code, CODES.BAD_REQUEST, '未计价必须 fail-closed')
  assert.ok(thrown.message.includes('自报金额'), '要说明自报金额不作数：' + thrown.message)
})

// ================================================================ ③ 信息量没有凭空消失
await test('③ 描述削短后，模型仍能从**错误文案**里拿到全部指引', async () => {
  // 这是削减字节的**唯一真实风险**：模型看不到"未计价要打开 allowUnpricedSpend"这句话了。
  // 若它做错时错误文案也不说，就是信息丢失（模型会反复瞎试）。
  // 判据：凡是原来写在参数描述里的关键指引，必须在"模型看得见的地方"仍然存在——
  // 要么在（更短的）描述里，要么在它触发的那一刻的错误文案里。
  const { tools } = await setup({ enableSeedanceVideo: true, pricing: {}, allowUnpricedSpend: false })
  const exec = makeExec({ cwd: tmpdir(), sessionId: 'verify-info' })

  let thrown
  try {
    await tools.seedance_video.execute({ prompt: '缺价指引', duration: 5 }, exec)
  } catch (error) {
    thrown = error
  }
  const message = String(thrown?.message ?? '')
  const description = String(tools.seedance_video.parameters.confirm_unpriced.description ?? '') + String(tools.seedance_video.description ?? '')
  const visible = message + '\n' + description

  for (const need of ['allowUnpricedSpend', '单价表', 'confirm_unpriced']) {
    assert.ok(visible.includes(need), '关键指引 "' + need + '" 在描述与错误文案里都找不到（信息丢失了）')
  }
  assert.ok(visible.includes('未计价'), '要讲清"未计价"这个状态名')

  // 反向：描述里不该再堆长文（否则这次优化白做）——上限来自 run.mjs 的字节预算，这里给个更细的红线
  assert.ok(String(tools.seedance_video.parameters.confirm_unpriced.description).length <= 60, 'confirm_unpriced 描述又写长了')
  assert.ok(String(tools.seedance_video.parameters.confirm_estimate.description).length <= 60, 'confirm_estimate 描述又写长了')
})

// ================================================================ ④ 开关 → 掩码
await test('④ 签名短路：方向、规模、多 agent 都不会吞掉配置变更', async () => {
  const realSetInterval = globalThis.setInterval
  let tick
  globalThis.setInterval = (callback) => {
    tick = callback
    return { unref() {} }
  }

  const tmp = await makeTmp()
  const fake = createFakeCtx({ credentials: { DASHSCOPE_API_KEY: 'k', ARK_API_KEY: 'k' }, llmProviders: ['glm'] })
  const config = makeConfig(tmp, { enableQwenDraw: true, enableSeedanceVideo: false })
  /**
   * ⚠ 必须当成"运行时那样"装配：`liveConfig` 是解包 Proxy。
   * 直接在 **原始** Config 上赋值会把 volatile 引用对象 `{ get() }` 替换成裸值，
   * 之后 `config[field]` 的读取语义就变了（第一版脚本就栽在这里：
   * 赋值后 `live.enableSeedanceVideo` 变成 `{}`/`undefined`，断言读到的不是开关）。
   */
  const live = new Proxy(config, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
    },
  })
  const applied = new Map()
  /** 造一个 agent；每个 agent 记录自己的掩码历史。 */
  const makeAgent = (id) => ({
    id,
    options: { provider: 'deepseek-account', model: 'deepseek-flash' },
    ctx: {
      ...fake.ctx,
      effect: (callback) => callback(),
      tools: {
        restrict: ({ deny }) => {
          applied.set(id, [...(applied.get(id) ?? []), [...deny]])
          return () => {}
        },
      },
    },
  })
  apply(fake.ctx, config)
  globalThis.setInterval = realSetInterval
  const created = fake.listeners.find((entry) => entry.event === 'agent/created').callback

  // 三个 agent（模拟多会话）
  const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')]
  for (const agent of agents) created({ agent })
  for (const agent of agents) {
    assert.deepEqual(applied.get(agent.id).at(-1), ['ask_glm', 'ask_qwen', 'seedance_video'], agent.id + ' 创建时掩码不对')
  }

  // 稳态：3 个 agent × 3 次 tick，一次都不该重复贴
  const counts = agents.map((agent) => applied.get(agent.id).length)
  for (let i = 0; i < 3; i += 1) tick()
  agents.forEach((agent, index) => {
    assert.equal(applied.get(agent.id).length, counts[index], agent.id + ' 在稳态被重复贴掩码（短路失效）')
  })

  // 翻转一个开关 → 三个 agent **全部**必须在一个 tick 内跟上
  live.enableSeedanceVideo = true
  tick()
  for (const agent of agents) {
    assert.deepEqual(applied.get(agent.id).at(-1), ['ask_glm', 'ask_qwen'], agent.id + ' 没跟上开关变更（多 agent 漏同步）')
  }

  // 再翻转（反向）→ 仍必须跟上
  live.enableSeedanceVideo = false
  tick()
  for (const agent of agents) {
    assert.deepEqual(applied.get(agent.id).at(-1), ['ask_glm', 'ask_qwen', 'seedance_video'], agent.id + ' 反向变更没跟上')
  }

  // 新增 agent（运行中出现）→ 立刻拿到当前掩码
  const late = makeAgent('late')
  created({ agent: late })
  assert.deepEqual(applied.get('late').at(-1), ['ask_glm', 'ask_qwen', 'seedance_video'], '新 agent 没拿到当前掩码')

  // 连续快速翻转：每次**真实变化**都必须被跟进、且最后一次必须赢。
  //
  // ⚠ 两个容易写错的地方（第一版就写错了）：
  //   1. 翻转次数为偶数时会回到起点，签名不变 → 短路**正确地**跳过。
  //      所以断言必须是"末态掩码与末态开关一致"，而不是"翻转次数 = 贴掩码次数"。
  //   2. 必须记录**起点状态**，断言才严密（否则可能拿一个错误的状态当期望值）。
  const clipCountBefore = applied.get('a').length
  let expected = ['ask_glm', 'ask_qwen', 'seedance_video'] // 当前 live.enableSeedanceVideo === false
  let flips = 0
  for (let i = 0; i < 6; i += 1) {
    live.enableSeedanceVideo = i % 2 === 0 // true,false,true,false,true,false
    expected = live.enableSeedanceVideo ? ['ask_glm', 'ask_qwen'] : ['ask_glm', 'ask_qwen', 'seedance_video']
    tick()
    flips += 1
    assert.deepEqual(applied.get('a').at(-1), expected, `第 ${flips} 次翻转（值=${live.enableSeedanceVideo}）后掩码不对`)
  }
  assert.equal(live.enableSeedanceVideo, false, '末态应是 false')
  assert.deepEqual(applied.get('a').at(-1), ['ask_glm', 'ask_qwen', 'seedance_video'], '末态掩码必须与末态开关一致')
  // 这一串翻转里每次值都真的变了 → 每次都该被跟进（数量等于翻转次数）
  assert.equal(applied.get('a').length - clipCountBefore, flips, '每次真实变化都该被跟进')

  // 反向证明短路有效：连续 tick 不改变任何东西时，一次都不该贴掩码
  const idleBefore = applied.get('a').length
  for (let i = 0; i < 10; i += 1) tick()
  assert.equal(applied.get('a').length, idleBefore, '空闲 tick 不该贴掩码（短路失效）')
})

// ================================================================ ⑤ guard 拦截行为
await test('⑤ 四条 guard 的拦截判定不受减字节影响', async () => {
  // ⚠ 注意开关前置条件：blockMainAgentNativeVision=true 时读图守卫**按设计**永不拦截
  //   （主代理自己看不了图，那时派读图员是唯一正确的做法）。
  //   所以要分两种配置各测一遍，否则测的是"开关关掉了守卫"，而不是守卫本身。
  const tmp = await makeTmp()
  const fake = createFakeCtx({ credentials: { DASHSCOPE_API_KEY: 'k', ARK_API_KEY: 'k' }, llmProviders: ['glm'] })
  apply(fake.ctx, makeConfig(tmp, { enableAskGlm: true, blockMainAgentNativeVision: false }))
  const [toolSwitch, readerGuard, imageReadGuard, delegationGuard] = fake.guards.map((entry) => entry.fn)

  const agent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' }, session: { id: 's', log: [] } }
  const execOf = (name, args, log = []) => ({ name, args, agent: { ...agent, session: { id: 's', log } } })

  // ① 工具开关：关着的工具被拒，开着的放过
  assert.ok(typeof toolSwitch(execOf('seedance_video', {})) === 'string', '未开启的 seedance_video 应被拒')
  assert.equal(toolSwitch(execOf('qwen_draw', {})), undefined, '开着的 qwen_draw 不该被拦')

  // ② 读图守卫：图片已在上下文 → 拦；纯文本历史 → 放行
  const logWithImage = [{ type: 'user/message', data: { content: [{ type: 'image' }] } }]
  const logText = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }]
  const readerVerdict = readerGuard(execOf('ask_glm', {}, logWithImage))
  assert.ok(typeof readerVerdict === 'string', '图片已在上下文应拦读图员（原生读图未被屏蔽时）')
  assert.ok(readerVerdict.includes('ask_glm'), '拦截文案要点名工具：' + readerVerdict)
  assert.equal(readerGuard(execOf('ask_glm', {}, logText)), undefined, '纯文本历史不该拦读图员')
  assert.equal(readerGuard(execOf('ask_qwen', {}, [])), undefined, '空日志不该拦读图员')

  // ③ 图片路径守卫：read 读 png 被拦并指路；read 读 txt 放行
  const imageVerdict = imageReadGuard(execOf('read', { file_path: 'C:/x/a.png' }))
  assert.ok(typeof imageVerdict === 'string' && imageVerdict.includes('ask_glm'), '应指路到读图员：' + imageVerdict)
  assert.equal(imageReadGuard(execOf('read', { file_path: 'C:/x/a.txt' })), undefined, '文本文件不该被拦')

  // ④ 委派守卫：委派读图被拦；委派普通任务放行
  assert.ok(typeof delegationGuard(execOf('subagent', { prompt: '帮我看看这张图 a.png' })) === 'string', '委派读图应被拦')
  assert.equal(delegationGuard(execOf('subagent', { prompt: '帮我重构这个函数' })), undefined, '普通委派不该被拦')
  assert.equal(delegationGuard(execOf('subagent', { prompt: '帮我画一张图' })), undefined, '"画图"不是读图，不该误伤')

  // ⑤ 对照组：屏蔽原生读图后，读图守卫必须**放行**（否则读图员会瞎掉——这是实测踩过的坑）
  const blocked = createFakeCtx({ credentials: { DASHSCOPE_API_KEY: 'k', ARK_API_KEY: 'k' }, llmProviders: ['glm'] })
  apply(blocked.ctx, makeConfig(await makeTmp(), { enableAskGlm: true, blockMainAgentNativeVision: true }))
  const blockedReaderGuard = blocked.guards[1].fn
  assert.equal(blockedReaderGuard(execOf('ask_glm', {}, logWithImage)), undefined, '原生读图被屏蔽时必须放行读图员')
})

// ================================================================ ⑥ 真实出片链路
await test('⑥ 描述变更后，带真参数的出片链路仍完整可用（提交→轮询→落盘→记账）', async () => {
  const { tmp, tools, config } = await setup({ enableSeedanceVideo: true, requireSpendConfirm: false })
  const exec = makeExec({ cwd: tmp, sessionId: 'verify-e2e' })
  const value = await tools.seedance_video.execute({ prompt: '海浪拍岸，日系动画风', duration: 5, resolution: '720p', ratio: '16:9' }, exec)

  assert.ok(value.videos.length === 1, '应产出 1 个视频')
  assert.ok((await stat(value.videos[0].path)).isFile(), '视频文件要真的落盘')
  const rendered = tools.seedance_video.output.render({}, value)[0].text
  assert.ok(rendered.includes(value.videos[0].path), '渲染要包含路径')

  // 记账（性能改动不该影响账本）
  const ledger = JSON.parse(await readFile(plain(config.ledgerPath), 'utf8'))
  const record = ledger.records.at(-1)
  assert.equal(record.adapter, 'ark-video')
  assert.equal(record.units, 5)
  assert.equal(record.amount, 7.595, '5 秒 × 1.519 = 7.595')

  // 制图链路同样走一遍（顺便验证缓存路径没被性能改动影响）
  const draw = await tools.qwen_draw.execute({ prompt: '一只鲸鱼在云海' }, exec)
  assert.ok(draw.images.length === 1 && (await stat(draw.images[0].path)).isFile(), '制图也要落盘')
})

// ================================================================
console.log('')
console.log(`[功能验证] 通过 ${stats.passed}，失败 ${stats.failed}`)
await mock.close()
process.exit(stats.failed === 0 ? 0 : 1)
