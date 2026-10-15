/**
 * 真实读图双链路 + 互斥（父 brain 用假 LLM，子代理走真实厂商路由）：
 *
 *   阶段 A：mm-models.enableAskGlm=true（ask_qwen 保持关）
 *           假 LLM → ask_glm（tool-subagent, spawn）→ 真实智谱 glm-4.6v → 真读"左红右蓝"PNG；
 *           同时验证互斥：主脑尝试调 ask_qwen 会被 guard 拒绝（不会再 spawn 一个子代理）。
 *   阶段 B：mm-models.enableAskQwen=true（ask_glm 关）
 *           假 LLM → ask_qwen（tool-subagent, spawn）→ 真实百炼 qwen3-vl-plus → 真读同一张 PNG。
 *
 * 需要 ZHIPU_API_KEY（阶段 A）与 DASHSCOPE_API_KEY（阶段 B）；缺哪个就跳过哪个阶段。
 * 运行：node tests/e2e-readers.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeSplitPng } from './fixtures.mjs'
import { startMockLlm } from './mock-llm.mjs'
import { DSH_HOME, FIXTURE_PNG, SANDBOX, WORK, launchCommand, resolveCli, profileHint } from './_paths.mjs'
import { loadKeysFromDshEnv, skipE2e } from './_env.mjs'

// 前置检查：沙箱 profile 是**一次性**建出来的，全新 clone 没有它。
// 缺了就直接说清怎么建，而不是把 dsh 的内部堆栈丢给用户。
{
  const hint = profileHint()
  if (hint !== undefined) skipE2e(hint)
}


const PNG = FIXTURE_PNG

// 补读 ~/.dsh/.env（dsh 启动时会自行加载，脚本也照做一遍）。
// 用 _env.mjs 的公共实现，别在本文件里再养一份走样的解析器。
loadKeysFromDshEnv(['ZHIPU_API_KEY', 'DASHSCOPE_API_KEY'])

let CLI
try {
  CLI = resolveCli()
  launchCommand(CLI) // 提前校验 Electron / node 的启动方式可用
} catch (error) {
  skipE2e('无法定位 dsh CLI：' + String(error?.message ?? error))
}

const has = (name) => typeof process.env[name] === 'string' && process.env[name].trim().length > 0
const zhipuReady = has('ZHIPU_API_KEY')
const dashscopeReady = has('DASHSCOPE_API_KEY')

if (!zhipuReady && !dashscopeReady) {
  skipE2e('ZHIPU_API_KEY 与 DASHSCOPE_API_KEY 都没有设置', ['ZHIPU_API_KEY', 'DASHSCOPE_API_KEY'])
}
console.log('dsh CLI：' + CLI)
console.log('可用 key：' + [zhipuReady ? 'ZHIPU_API_KEY' : undefined, dashscopeReady ? 'DASHSCOPE_API_KEY' : undefined].filter(Boolean).join(' / '))

await mkdir(WORK, { recursive: true })
await writeFile(PNG, makeSplitPng(160, 80, [220, 30, 30], [30, 60, 220]))

/** 厂商路由 + 假 LLM 路由（providers 是整体覆盖语义，所以每次都要写全）。 */
function baseOverlay(mockBase) {
  return [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      glm:',
    '        displayName: GLM (智谱·视觉)',
    '        apiKeyEnv: ZHIPU_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://open.bigmodel.cn/api/paas/v4',
    '        compat: { thinkingFormat: zai }',
    '        models:',
    '          - id: glm-4.6v',
    '            input: [text, image]',
    '            contextWindow: 200000',
    '            maxTokens: 32768',
    '      qwen-vl:',
    '        displayName: Qwen-VL (百炼·视觉)',
    '        apiKeyEnv: DASHSCOPE_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1',
    '        models:',
    '          - id: qwen3-vl-plus',
    '            input: [text, image]',
    '            contextWindow: 131072',
    '            maxTokens: 32768',
    '      mock:',
    '        displayName: Mock LLM (trial run)',
    '        apiKeyEnv: MOCK_API_KEY',
    '        api: openai-completions',
    '        baseURL: ' + mockBase + '/v1',
    '        models:',
    '          - id: mock-1',
    '            input: [text]',
    '            contextWindow: 128000',
    '            maxTokens: 8192',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: mock',
    '    model: mock-1',
    '- id: mm-models',
    '  config:',
    '    enableAskGlm: __GLM__',
    '    enableAskQwen: __QWEN__',
    '    blockMainAgentNativeVision: __BLOCK__',
    // 隔离持久化：不隔离会写进用户真实的 ~/.dsh，而且**出图缓存会让重复 prompt 命中**，
    // 把真正的被测路径短路掉（2026-10-14 在 e2e-real-errors 上踩到过）。
    '    imageCachePath: ' + JSON.stringify(join(WORK, 'image-cache.json')),
    '    taskRegistryPath: ' + JSON.stringify(join(WORK, 'tasks.json')),
    '    cacheResults: false',
    '    persistTasks: false',
    '',
  ].join('\n')
}

async function headless(overlayPath, prompt) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME,
    DSH_PERMISSION_MODE: 'danger-full-access',
    MOCK_API_KEY: 'test-mock-key',
    PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? ''),
  }
  // asar 内的 CLI 交给 Electron 以 Node 模式跑（Node 自身读不了 asar）；否则直接用 node。
  const { command } = launchCommand(CLI)
  const child = spawn(command, [CLI, '--profile', 'mmtest', '--patch', overlayPath, prompt], { env, cwd: WORK })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { code, stdout, stderr }
}

/**
 * 模型实际看到的工具名（区分主代理与读图子代理）。
 * 用来验证"主代理原生读图"开关：主代理那边应该没有 read_image，子代理那边必须还在。
 */
function toolReport(llmState) {
  const main = new Set()
  const child = new Set()
  for (const request of llmState.requests) {
    const text = JSON.stringify(request)
    const isChild = text.includes('视觉阅读员') || text.includes('多模态阅读员') || text.includes('只看图说话')
    for (const tool of Array.isArray(request.tools) ? request.tools : []) {
      if (typeof tool?.function?.name !== 'string') continue
      const target = isChild ? child : main
      target.add(tool.function.name)
    }
  }
  return { main: [...main].sort(), child: [...child].sort() }
}

/** 取工具结果里给模型看的内容（判断读图员到底有没有读到）。 */
function toolResults(llmState) {
  const out = []
  for (const request of llmState.requests) {
    for (const message of Array.isArray(request.messages) ? request.messages : []) {
      if (message.role === 'tool') out.push(String(message.content ?? ''))
    }
  }
  return out
}

const failures = []
/** 被跳过的阶段。有值时**不能**报全绿——绿色必须意味着两个阶段都真跑过。 */
const skipped = []
function check(condition, message) {
  if (!condition) failures.push(message)
  return condition
}

/**
 * 读图链路本身的错误（不含我们故意触发的互斥拒绝 —— 那条也带 "Error:" 前缀）。
 * 去掉互斥拒绝文案后再判断，避免把预期行为当失败。
 */
function readerChainError(stdout) {
  const withoutGuardRejections = stdout
    .split(/\r?\n/)
    .filter((line) => !line.includes('已关闭：') && !line.includes('互斥'))
    .join('\n')
  return /subagent run failed|Error:|error:/.test(withoutGuardRejections)
}

// ---------------------------------------------------------------- 阶段 A：真实 GLM 读图 + 互斥 + 原生读图开关
if (zhipuReady) {
  // 主脑先调 ask_glm（真实 GLM 读图），再故意碰 ask_qwen → 应被互斥 guard 拒绝。
  // 同时打开 blockMainAgentNativeVision：主代理不该再看到 read_image，但子代理必须还看得见。
  const llm = await startMockLlm({ readerTool: 'ask_glm', probeMutexTool: 'ask_qwen' })
  const overlayPath = join(SANDBOX, 'overlay-readers-glm.yml')
  await writeFile(
    overlayPath,
    baseOverlay(llm.base).replace('__GLM__', 'true').replace('__QWEN__', 'false').replace('__BLOCK__', 'true'),
    'utf8',
  )

  const result = await headless(overlayPath, '用读图员看图：左半部分和右半部分分别是什么颜色？')
  console.log('--- 阶段 A（ask_glm / 真实 glm-4.6v / 原生读图已屏蔽）exit:', result.code)
  console.log(result.stdout.trim().slice(0, 1500))

  const seen = toolReport(llm.state)
  console.log('主代理工具里有 read_image：' + seen.main.includes('read_image'))
  console.log('--- 工具结果（给模型看的原文）---')
  for (const result of toolResults(llm.state)) console.log('  > ' + result.replace(/\s+/g, ' ').slice(0, 300))

  check(result.code === 0, 'A: headless exit code ' + result.code)
  check(llm.state.askGlmCalls >= 1, 'A: 主脑没有调用 ask_glm')
  check(llm.state.mutexProbes >= 1, 'A: 主脑没有试探 ask_qwen（互斥没被验证）')
  check(llm.state.guardRejections >= 1, 'A: ask_glm 开着时 ask_qwen 没有被 guard 拒绝')
  check(!readerChainError(result.stdout), 'A: ask_glm 报错（非互斥拒绝的真实错误）')
  check(!/did not activate/.test(result.stderr), 'A: 有条目没有激活：' + result.stderr.slice(0, 300))
  // 开关的核心断言 1：主代理被摘掉原生读图。
  check(!seen.main.includes('read_image'), 'A: 开关打开后主代理不应再看到 read_image')
  // 开关的核心断言 2：读图员必须还能看图 —— 它若被一起 deny 掉，真实 GLM 会拿不到
  // 任何工具、只能把 `<tool_call>read_image` 当文本吐出来，最终答案里就不会有颜色。
  check(/红/.test(result.stdout) && /蓝/.test(result.stdout), 'A: 屏蔽原生读图后，读图子代理仍应真读到「左红右蓝」（空的答案说明读图员被一起弄瞎了）')
  await llm.close()
} else {
  console.log('阶段 A SKIPPED：未设置 ZHIPU_API_KEY')
  skipped.push('A')
}

// ---------------------------------------------------------------- 阶段 B：真实 Qwen-VL 读图 + 互斥 + 原生读图恢复
if (dashscopeReady) {
  // 反向：主脑先调 ask_qwen（真实 Qwen-VL 读图），再故意碰 ask_glm → 应被拒绝。
  // 这一阶段把开关关掉，验证主代理的原生读图能力被原样还回来（开关是双向的）。
  const llm = await startMockLlm({ readerTool: 'ask_qwen', probeMutexTool: 'ask_glm' })
  const overlayPath = join(SANDBOX, 'overlay-readers-qwen.yml')
  await writeFile(
    overlayPath,
    baseOverlay(llm.base).replace('__GLM__', 'false').replace('__QWEN__', 'true').replace('__BLOCK__', 'false'),
    'utf8',
  )

  const result = await headless(overlayPath, '用读图员看图：左半部分和右半部分分别是什么颜色？')
  console.log('--- 阶段 B（ask_qwen / 真实 qwen3-vl-plus / 原生读图保留）exit:', result.code)
  console.log(result.stdout.trim().slice(0, 1500))

  const seen = toolReport(llm.state)
  console.log('主代理工具里有 read_image：' + seen.main.includes('read_image'))

  check(result.code === 0, 'B: headless exit code ' + result.code)
  check(llm.state.askQwenCalls >= 1, 'B: 主脑没有调用 ask_qwen')
  check(llm.state.mutexProbes >= 1, 'B: 主脑没有试探 ask_glm（互斥没被验证）')
  check(llm.state.guardRejections >= 1, 'B: ask_qwen 开着时 ask_glm 没有被 guard 拒绝')
  check(!readerChainError(result.stdout), 'B: ask_qwen 报错（非互斥拒绝的真实错误）')
  check(/红/.test(result.stdout) && /蓝/.test(result.stdout), 'B: 真实 Qwen-VL 读图答案（左红右蓝）没出现在输出里')
  check(!/did not activate/.test(result.stderr), 'B: 有条目没有激活：' + result.stderr.slice(0, 300))
  check(seen.main.includes('read_image'), 'B: 开关关闭时主代理应保留原生 read_image')
  await llm.close()
} else {
  console.log('阶段 B SKIPPED：未设置 DASHSCOPE_API_KEY')
  skipped.push('B')
}

if (failures.length > 0) {
  console.error('\nREADERS E2E FAIL:\n - ' + failures.join('\n - '))
  process.exitCode = 1
} else if (skipped.length > 0) {
  // 有阶段没跑：**不能**报 OK。绿色必须意味着"两个阶段都真的读到了"。
  console.log('\nREADERS E2E PARTIAL：跳过了阶段 ' + skipped.join(' / ') + '，其余通过。')
  if ((process.env.DSH_E2E_STRICT ?? '').trim() === '1') {
    console.error('DSH_E2E_STRICT=1：有阶段被跳过，视为失败（退出码 78）。')
    process.exitCode = 78
  }
} else {
  console.log('\nREADERS E2E OK：两个读图子代理各自真实读到"左红右蓝"；互斥生效；原生读图开关双向可用（开=主代理摘掉 read_image 且子代理保留，关=原样还回）。')
}
