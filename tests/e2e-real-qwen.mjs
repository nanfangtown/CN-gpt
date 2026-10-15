/**
 * 真实 DashScope 制图链路（父 brain 用假 LLM，qwen_draw 走真实同步接口）：
 *   假 LLM → qwen_draw → 真实 dashscope multimodal-generation（sync）→ 图片落盘 → 回传。
 * 需要 DASHSCOPE_API_KEY（或 QWEN_KEY）；不使用 Ark。
 * 运行：QWEN_KEY=... node tests/e2e-real-qwen.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApp, resolveCli, profileHint } from './_paths.mjs'
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
const GEN = join(WORK, 'gen')
const APP = resolveApp() ?? process.env.DSH_APP ?? ''
const CLI = resolveCli()
const OVERLAY = join(SANDBOX, 'overlay-real-qwen.yml')

// 补读 ~/.dsh/.env —— 此前这里只读 process.env，导致 DASHSCOPE_API_KEY 明明
// 就在 .env 里、本脚本却永远"跳过"（同目录的 glm / errors 两个脚本都会补读）。
loadKeysFromDshEnv(['DASHSCOPE_API_KEY', 'QWEN_KEY'])
const key = process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_KEY
if (key === undefined || key.trim().length === 0) {
  skipE2e('未设置 DASHSCOPE_API_KEY / QWEN_KEY（环境变量与 ~/.dsh/.env 都没有）', ['DASHSCOPE_API_KEY'])
}

await mkdir(GEN, { recursive: true })
const before = (await readdir(GEN)).filter((name) => name.startsWith('qwen-')).length

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
  // 隔离持久化：避免写进用户真实的 ~/.dsh（也避免缓存把被测路径短路）。
  '- id: mm-models',
  '  config:',
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
  DASHSCOPE_API_KEY: key,
  PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? ''),
}

const child = spawn(APP, [CLI, '--profile', 'mmtest', '--patch', OVERLAY, '画一张鲸鱼，插画风格'], { env, cwd: WORK })
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

const after = (await readdir(GEN)).filter((name) => name.startsWith('qwen-')).length
const failures = []
if (code !== 0) failures.push('headless exit code ' + code)
if (llm.state.qwenDrawCalls < 1) failures.push('mock parent never called qwen_draw')
if (!stdout.includes('已生成 1 张图片')) failures.push('tool result missing from stdout')
if (/Error:/.test(stdout)) failures.push('qwen_draw returned an error')
if (after <= before) failures.push('no new image landed in work/gen')
if (/did not activate/.test(stderr)) failures.push('an entry did not activate: ' + stderr.slice(0, 300))

await llm.close()
if (failures.length > 0) {
  console.error('\nREAL-QWEN E2E FAIL: ' + failures.join('; '))
  process.exitCode = 1
} else {
  console.log('\nREAL-QWEN E2E OK：真实 qwen-image 同步制图完成并落盘。')
}
