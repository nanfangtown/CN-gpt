/**
 * 真实智谱读图链路（父 brain 仍用假 LLM，子代理 ask_glm 走真实 GLM 路由）：
 *   假 LLM → ask_glm（tool-subagent, spawn）→ 真实智谱 glm-4.6v → 真读一张"左红右蓝"PNG。
 * 需要 ZHIPU_API_KEY；不使用 DashScope / Ark。
 * 运行：ZHIPU_API_KEY=... node tests/e2e-real-glm.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApp, resolveCli, profileHint } from './_paths.mjs'
import { makeSplitPng } from './fixtures.mjs'
import { startMockLlm } from './mock-llm.mjs'
import { loadKeysFromDshEnv, readyKeys, skipE2e } from './_env.mjs'

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
const CLI = resolveCli()
const OVERLAY = join(SANDBOX, 'overlay-real-glm.yml')

loadKeysFromDshEnv(['ZHIPU_API_KEY'])
if (!readyKeys(['ZHIPU_API_KEY']).includes('ZHIPU_API_KEY')) {
  skipE2e('未设置 ZHIPU_API_KEY（环境变量与 ~/.dsh/.env 都没有）', ['ZHIPU_API_KEY'])
}

await mkdir(WORK, { recursive: true })
await writeFile(join(WORK, 'whale.png'), makeSplitPng(160, 80, [220, 30, 30], [30, 60, 220]))

const llm = await startMockLlm()
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
  // 读图子代理默认关闭（且与 ask_qwen 互斥），这里显式打开 ask_glm。
  '- id: mm-models',
  '  config:',
  '    enableAskGlm: true',
  '    enableAskQwen: false',
  // 隔离持久化：避免写进用户真实的 ~/.dsh（也避免缓存把被测路径短路）。
  '    imageCachePath: ' + JSON.stringify(join(WORK, 'image-cache.json')),
  '    taskRegistryPath: ' + JSON.stringify(join(WORK, 'tasks.json')),
  '    cacheResults: false',
  '    persistTasks: false',
  '',
].join('\n')
await writeFile(OVERLAY, overlay, 'utf8')

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  DSH_HOME,
  DSH_PERMISSION_MODE: 'danger-full-access',
  MOCK_API_KEY: 'test-mock-key',
  PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? ''),
}

const child = spawn(APP, [CLI, '--profile', 'mmtest', '--patch', OVERLAY, '让读图员描述图片'], { env, cwd: WORK })
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
const code = await new Promise((resolve) => child.on('close', resolve))

console.log('--- dsh headless exit:', code)
console.log('--- stdout ---')
console.log(stdout.trim().slice(0, 2000))
console.log('--- stderr (tail) ---')
console.log(stderr.trim().split('\n').slice(-8).join('\n'))

const failures = []
if (code !== 0) failures.push('headless exit code ' + code)
if (llm.state.askGlmCalls < 1) failures.push('mock parent never called ask_glm')
if (!stdout.includes('红') || !stdout.includes('蓝')) failures.push('real GLM reader answer (左红右蓝) missing from stdout')
if (/subagent run failed|Error:/.test(stdout)) failures.push('ask_glm returned an error')
if (/did not activate/.test(stderr)) failures.push('an entry did not activate: ' + stderr.slice(0, 300))

await llm.close()
if (failures.length > 0) {
  console.error('\nREAL-GLM E2E FAIL: ' + failures.join('; '))
  process.exitCode = 1
} else {
  console.log('\nREAL-GLM E2E OK：真实 ask_glm 子代理用 glm-4.6v 读到了"左红右蓝"。')
}
