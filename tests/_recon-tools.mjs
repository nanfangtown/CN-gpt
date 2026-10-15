/**
 * 侦察：极简模式下主代理实际拿到哪些工具（读图/子代理/压缩相关）。
 *
 * 用假 LLM 跑一次 headless，直接把模型请求里的 tools 名单打出来 —— 这是
 * 「preset 组成」最终生效的ground truth，比读 YAML 推断可靠。
 *
 * 用法：
 *   node tests/_recon-tools.mjs            :: mmtest profile（无 preset-minimal 行）
 *   node tests/_recon-tools.mjs --desktop  :: desktop profile（带 preset-minimal 行，只读探测）
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApp, resolveCli, profileHint } from './_paths.mjs'
import { startMockLlm } from './mock-llm.mjs'

// 前置检查：沙箱 profile 是**一次性**建出来的，全新 clone 没有它。
// 缺了就直接说清怎么建，而不是把 dsh 的内部堆栈丢给用户。
{
  const hint = profileHint()
  if (hint !== undefined) {
    console.log('跳过：' + hint)
    process.exit(0)
  }
}


const __dirname = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(__dirname, '..', '_sandbox')
const WORK = join(SANDBOX, 'work')
const APP = resolveApp() ?? process.env.DSH_APP ?? ''
const CLI = resolveCli()

const profile = process.argv.includes('--desktop') ? 'desktop' : 'mmtest'
const DSH_HOME = process.argv.includes('--desktop') ? undefined : join(SANDBOX, 'dshhome')

const llm = await startMockLlm()
const overlay = [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      mock:',
  '        displayName: Mock LLM (recon)',
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
  '',
].join('\n')
const { writeFile, mkdir } = await import('node:fs/promises')
await mkdir(WORK, { recursive: true })
const overlayPath = join(SANDBOX, 'overlay-recon.yml')
await writeFile(overlayPath, overlay, 'utf8')

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  DSH_PERMISSION_MODE: 'danger-full-access',
  MOCK_API_KEY: 'test-mock-key',
  PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? ''),
}
if (DSH_HOME !== undefined) env.DSH_HOME = DSH_HOME

const args = [CLI, '--profile', profile]
if (profile === 'mmtest') args.push('--patch', overlayPath)
args.push('随便说一句')

const child = spawn(APP, args, { env, cwd: WORK })
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => (stdout += chunk))
child.stderr.on('data', (chunk) => (stderr += chunk))
const code = await new Promise((resolve) => child.on('close', resolve))
await llm.close()

console.log('=== profile: ' + profile + ' | exit ' + code + ' ===')
if (stderr.trim().length > 0) console.log('stderr tail:\n' + stderr.trim().split('\n').slice(-6).join('\n'))

const tools = new Set()
const childTools = new Set()
for (const request of llm.state.requests) {
  const text = JSON.stringify(request)
  const isChild = text.includes('视觉阅读员') || text.includes('多模态阅读员') || text.includes('只看图说话')
  for (const tool of Array.isArray(request.tools) ? request.tools : []) {
    if (typeof tool?.function?.name !== 'string') continue
    if (isChild) childTools.add(tool.function.name)
    else tools.add(tool.function.name)
  }
  if (isChild && process.env.DUMP_CHILD_PROMPT === '1') {
    const messages = Array.isArray(request.messages) ? request.messages : []
    console.log('\n---- 子代理请求 #' + llm.state.requests.indexOf(request) + ' 的 system 提示词 ----')
    for (const message of messages.filter((m) => m.role === 'system' || m.role === 'developer')) {
      console.log(String(message.content ?? '').slice(0, 1500))
    }
  }
}
const names = [...tools].sort()
console.log('\n主代理实际拿到的工具（' + names.length + ' 个）：')
console.log(names.join(', '))
console.log('\n读图子代理实际拿到的工具（' + childTools.size + ' 个）：')
console.log(childTools.size > 0 ? [...childTools].sort().join(', ') : '（没观察到子代理请求）')
const readers = names.filter((name) => name === 'ask_glm' || name === 'ask_qwen')
console.log('\n读图子代理工具：' + (readers.length > 0 ? readers.join(', ') : '（一个都没有）'))
const compactionish = names.filter((name) => /compact|trim|context/i.test(name))
console.log('压缩相关工具：' + (compactionish.length > 0 ? compactionish.join(', ') : '（没有）'))
console.log('本地系统类工具：' + names.filter((name) => /bash|pwsh|read|write|edit|glob|grep/.test(name)).join(', '))
