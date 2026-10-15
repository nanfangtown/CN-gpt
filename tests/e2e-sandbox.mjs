/**
 * 沙箱端到端试运行（不装进真实 desktop profile、不联网、不花 key）：
 *   假 LLM（OpenAI 兼容 SSE）→ 真实 dsh headless agent loop → 真实插件 → 假厂商。
 *
 * 前置：用 dsh 的 plugin 命令把本包装进 _sandbox/dshhome/profiles/mmtest（见 tests/README.md）。
 * 运行：node --import ./tests/register.mjs ./tests/e2e-sandbox.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApp, resolveCli, profileHint } from './_paths.mjs'
import { startMockLlm } from './mock-llm.mjs'
import { startMockProviders } from './mock-providers.mjs'
import { skipE2e } from './_env.mjs'

// 前置检查：沙箱 profile 是**一次性**建出来的，全新 clone 没有它。
// 缺了就直接说清怎么建，而不是把 dsh 的内部堆栈丢给用户。
{
  const hint = profileHint()
  if (hint !== undefined) skipE2e(hint)
}


const __dirname = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(__dirname, '..', '_sandbox')
const DSH_HOME = join(SANDBOX, 'dshhome')
const WORK = join(SANDBOX, 'work')
const APP = resolveApp() ?? process.env.DSH_APP ?? ''
// resolveCli 找不到 CLI 时会**抛异常**（不是返回 undefined）。以前这会让顶层
// 未捕获异常把退出码变成 1，与其它 e2e 的"跳过"约定不一致；这里统一成显式跳过。
let CLI
try {
  CLI = resolveCli()
} catch (error) {
  skipE2e('无法定位 dsh CLI：' + String(error?.message ?? error))
}
const OVERLAY = join(SANDBOX, 'overlay-mock-llm.yml')

const providers = await startMockProviders()
const llm = await startMockLlm()
await mkdir(WORK, { recursive: true })
await mkdir(join(WORK, 'gen'), { recursive: true })

const overlay = [
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
  '      mock:',
  '        displayName: Mock LLM (trial run)',
  '        apiKeyEnv: MOCK_API_KEY',
  '        api: openai-completions',
  '        baseURL: ' + llm.base + '/v1',
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
  "  name: '@local/dsh-mm-models'",
  '  config:',
  '    dashscopeApiKey: null',
  '    dashscopeApiKeyEnv: DASHSCOPE_API_KEY',
  '    arkApiKey: null',
  '    arkApiKeyEnv: ARK_API_KEY',
  '    dashscopeBase: ' + providers.base + '/dashscope/api/v1',
  '    dashscopeCompatBase: ' + providers.base + '/dashscope/compatible-mode/v1',
  '    arkBase: ' + providers.base + '/ark/api/v3',
  '    maxCallsPerTurn: 0',
  '    taskTimeoutMs: 60000',
  '    videoTimeoutMs: 60000',
  '    taskPollIntervalMs: 500',
  '    taskPollMaxIntervalMs: 1000',
  '    outDir: ' + JSON.stringify(join(WORK, 'gen')),
  '    videoOutDir: ' + JSON.stringify(join(WORK, 'gen', 'video')),
  '    ledgerPath: ' + JSON.stringify(join(WORK, 'ledger.json')),
  // 隔离新加的两个持久化：不隔离的话会写进用户真实的 ~/.dsh，
  // 而且**上次试运行的出图缓存会让本次命中**，A/A2 就测不到真实提交链路了。
  '    imageCachePath: ' + JSON.stringify(join(WORK, 'image-cache.json')),
  '    taskRegistryPath: ' + JSON.stringify(join(WORK, 'tasks.json')),
  // A/A2 要验证"真实提交 + 账本增长"，所以这里关掉缓存（缓存本身由单测与场景 A3 覆盖）。
  '    cacheResults: false',
  '    pricing:',
  '      qwen-image-3.0: { unit: image, unitPrice: 0.5, currency: CNY, asOf: 2026-10-12 }',
  '      seedance-2.0: { unit: second, unitPrice: 0.2, currency: CNY, asOf: 2026-10-12 }',
  '      glm-4.6v: { unit: ktoken, inputPrice: 0, outputPrice: 0, currency: CNY, asOf: 2026-10-12 }',
  '',
].join('\n')
await writeFile(OVERLAY, overlay, 'utf8')


// 场景 B 覆盖层：把 ask_glm 的子代理路由改到 mock（真实 GLM 需要 key，留待用户实跑确证）。
// 读图子代理默认关闭、且与 ask_qwen 互斥，所以这里显式打开 ask_glm。
// 注意：patch 对 mm-models 是"整体替换 config"，所以要沿用主覆盖层里那份完整配置。
const overlayReader = [
  ...overlay.split('\n').filter((line) => line !== ''),
  '    enableAskGlm: true',
  '    enableAskQwen: false',
  '',
  '- id: tool-subagent-glm',
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  '  config:',
  '    provider: spawn',
  '    toolName: ask_glm',
  '    backgroundMode: one-shot',
  '    enableRunInBackground: true',
  '    maxDepth: 1',
  '    agentOptions: { provider: mock, model: mock-1 }',
  '    persona: >-',
  '      你是多模态阅读员。只看图说话，不臆测。',
  '    toolFilter: { allow: [read, read_image] }',
  '',
].join('\n')
const READER_OVERLAY = join(SANDBOX, 'overlay-reader.yml')
await writeFile(READER_OVERLAY, overlayReader, 'utf8')

// 场景 A3 覆盖层：显式**打开**出图缓存，验证"同样的 prompt 第二次不再真的调用厂商"。
// 其余配置沿用主覆盖层（含隔离后的 imageCachePath）。
const overlayCache = [
  ...overlay
    .split('\n')
    .filter((line) => line !== '' && !line.includes('cacheResults: false')),
  '    cacheResults: true',
  '',
].join('\n')
const CACHE_OVERLAY = join(SANDBOX, 'overlay-cache.yml')
await writeFile(CACHE_OVERLAY, overlayCache, 'utf8')

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  DSH_HOME,
  DSH_PERMISSION_MODE: 'danger-full-access',
  DASHSCOPE_API_KEY: 'test-dashscope-key',
  ARK_API_KEY: 'test-ark-key',
  MOCK_API_KEY: 'test-mock-key',
  PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? ''),
}

function runHeadless(overlayPath, task) {
  return new Promise((resolve) => {
    const child = spawn(APP, [CLI, '--profile', 'mmtest', '--patch', overlayPath, task], { env, cwd: WORK })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const failures = []

/** 宿主 storageDomain 的 JSON 后台文件；记录条数应随每次成功生成增长。 */
const STORAGE_LEDGER = join(DSH_HOME, 'storages', 'mm_media_ledger.json')
async function ledgerRecords() {
  try {
    const parsed = JSON.parse(await readFile(STORAGE_LEDGER, 'utf8'))
    return Object.keys(parsed.tables?.usage ?? {}).length
  } catch {
    return 0
  }
}

// ---- 场景 A：主脑 → qwen_draw → 产物（跑两次：第二次顺带验证账本领域能重新打开）----
const ledgerBefore = await ledgerRecords()
const a = await runHeadless(OVERLAY, '画一张鲸鱼，插画风格')
console.log('--- 场景A exit:', a.code)
console.log(a.stdout.trim().slice(0, 1200))
if (a.code !== 0) failures.push('A exit code ' + a.code)
if (llm.state.qwenDrawCalls < 1) failures.push('A: mock LLM never asked for qwen_draw')
if (providers.submitCount('qwen') < 1) failures.push('A: qwen_draw never reached the mock DashScope')
const usedSync = providers.state.requests.some((entry) => entry.path.includes('multimodal-generation'))
if (!usedSync && providers.tasks.size < 1) failures.push('A: neither sync submit nor async task was observed')
if (!a.stdout.includes('已生成 1 张图片')) failures.push('A: tool result missing from stdout')
if (/did not activate/.test(a.stderr)) failures.push('A: an entry did not activate: ' + a.stderr.slice(0, 300))
const ledgerAfterA = await ledgerRecords()
if (ledgerAfterA <= ledgerBefore) failures.push('A: 宿主 storageDomain 账本没有增长（可能退回了 JSON 回退）')

const a2 = await runHeadless(OVERLAY, '再画一张鲸鱼，插画风格')
console.log('--- 场景A2 exit:', a2.code)
if (a2.code !== 0) failures.push('A2 exit code ' + a2.code)
const ledgerAfterA2 = await ledgerRecords()
if (ledgerAfterA2 <= ledgerAfterA) failures.push('A2: 重新打开账本领域失败（storage 记录没有增长）')

// ---- 场景 A3：出图缓存真的省下第二次厂商调用（关掉 A/A2 的缓存后单独验证）----
// 先清掉可能来自上轮试运行的缓存，保证 A3a 一定是"首次真实调用"。
await rm(join(WORK, 'image-cache.json'), { force: true })
const submitsBeforeA3 = providers.submitCount('qwen')
const a3a = await runHeadless(CACHE_OVERLAY, '画一只缓存测试用的猫')
console.log('--- 场景A3a（缓存开启，首次）exit:', a3a.code)
if (a3a.code !== 0) failures.push('A3a exit code ' + a3a.code)
const submitsAfterFirst = providers.submitCount('qwen')
if (submitsAfterFirst <= submitsBeforeA3) failures.push('A3a: 首次调用没有真的提交到 mock 厂商')

const a3b = await runHeadless(CACHE_OVERLAY, '画一只缓存测试用的猫')
console.log('--- 场景A3b（同样的 prompt，应命中缓存）exit:', a3b.code)
if (a3b.code !== 0) failures.push('A3b exit code ' + a3b.code)
const submitsAfterSecond = providers.submitCount('qwen')
if (submitsAfterSecond !== submitsAfterFirst) {
  failures.push('A3b: 命中缓存后仍然提交了厂商调用（' + submitsAfterFirst + ' → ' + submitsAfterSecond + '）—— 缓存没生效')
}
if (!a3b.stdout.includes('缓存命中')) failures.push('A3b: 结果里没有标注"缓存命中"')

// ---- 场景 B：主脑 → ask_glm（子代理）→ 读图结论 ----
const b = await runHeadless(READER_OVERLAY, '让读图员描述一张图片')
console.log('--- 场景B exit:', b.code)
console.log(b.stdout.trim().slice(0, 1200))
if (b.code !== 0) failures.push('B exit code ' + b.code)
if (llm.state.askGlmCalls < 1) failures.push('B: mock LLM never asked for ask_glm')
if (llm.state.readerRuns < 1) failures.push('B: the ask_glm child agent never ran')
if (!b.stdout.includes('图中是一只鲸鱼')) failures.push('B: child reading result missing from stdout')
if (/did not activate/.test(b.stderr)) failures.push('B: an entry did not activate: ' + b.stderr.slice(0, 300))

// ---- 场景 B2/B3：degradeToText=true 的钩子在真实 pipeline 里不炸 ----
const overlayDegrade = overlayReader.replace('    maxCallsPerTurn: 0', '    maxCallsPerTurn: 0\n    degradeToText: true')
const DEGRADE_OVERLAY = join(SANDBOX, 'overlay-degrade.yml')
await writeFile(DEGRADE_OVERLAY, overlayDegrade, 'utf8')

const b2 = await runHeadless(DEGRADE_OVERLAY, '让读图员描述一张图片 [reader-fail]')
console.log('--- 场景B2（ask_glm 失败 + degradeToText）exit:', b2.code)
console.log(b2.stdout.trim().slice(0, 800))
if (b2.code !== 0) failures.push('B2 exit code ' + b2.code)
if (llm.state.readerFailures < 1) failures.push('B2: the reader child never hit the injected 401')
if (!b2.stdout.includes('不要卡住')) failures.push('B2: degradeToText guidance missing from stdout')
if (/did not activate/.test(b2.stderr)) failures.push('B2: an entry did not activate: ' + b2.stderr.slice(0, 300))

const b3 = await runHeadless(DEGRADE_OVERLAY, '画一张鲸鱼，插画风格')
console.log('--- 场景B3（正常工具 + degradeToText 钩子）exit:', b3.code)
if (b3.code !== 0) failures.push('B3 exit code ' + b3.code)
if (!b3.stdout.includes('已生成 1 张图片')) failures.push('B3: normal tool call broken while degradeToText listener is registered')

// ---- 场景 B4：media_report(cost/health) 在真实 harness 里跑通 ----
const b4 = await runHeadless(OVERLAY, '报告一下链路健康和成本')
console.log('--- 场景B4（media_report）exit:', b4.code)
console.log(b4.stdout.trim().slice(0, 1600))
if (b4.code !== 0) failures.push('B4 exit code ' + b4.code)
if (llm.state.reportCalls < 2) failures.push('B4: mock LLM did not call media_report twice')
if (!b4.stdout.includes('链路健康')) failures.push('B4: health report missing from stdout')
if (!b4.stdout.includes('DASHSCOPE_API_KEY')) failures.push('B4: key status missing from health report')
if (!b4.stdout.includes('成本估算')) failures.push('B4: cost report missing from stdout')
if (!/qwen_draw: ✅ 可用|qwen_draw: ❌ 当前不可用/.test(b4.stdout)) failures.push('B4: capability summary missing')
if (/did not activate/.test(b4.stderr)) failures.push('B4: an entry did not activate: ' + b4.stderr.slice(0, 300))

await llm.close()
await providers.close()
if (failures.length > 0) {
  console.error('\nE2E FAIL: ' + failures.join('; '))
  process.exitCode = 1
} else {
  console.log('\nE2E OK：真实 agent loop 走通 qwen_draw 与 ask_glm(子代理) 两条链路。')
}
