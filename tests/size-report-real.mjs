/**
 * 真实 harness 体积报告：跑一次 headless（假 LLM），读模型实际收到的 tools / system prompt 体积。
 * 用于优化前后对比；不会调用真实厂商（收到第一个请求后立即杀掉子进程）。
 * 运行：node tests/size-report-real.mjs [--no-bg]
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
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
const APP = resolveApp() ?? process.env.DSH_APP ?? ''
const CLI = resolveCli()
const WORK = join(SANDBOX, 'work')
const OVERLAY = join(SANDBOX, 'overlay-measure.yml')
const llm = await startMockLlm()
await mkdir(WORK, { recursive: true })
await writeFile(OVERLAY, [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      mock:',
  '        displayName: Mock',
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
  ...(process.argv.includes('--no-bg')
    ? [
        '- id: tool-subagent-glm',
        "  name: '@deepseek-ai/dsh-tool-subagent'",
        '  config:',
        '    provider: spawn',
        '    toolName: ask_glm',
        '    backgroundMode: one-shot',
        '    enableRunInBackground: false',
        '    maxDepth: 1',
        '    agentOptions: { provider: mock, model: mock-1 }',
      ]
    : []),
  '',
].join('\n'), 'utf8')

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(SANDBOX, 'dshhome'), DSH_PERMISSION_MODE: 'danger-full-access', MOCK_API_KEY: 'test-mock-key', PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? '') }
const child = spawn(APP, [CLI, '--profile', 'mmtest', '--patch', OVERLAY, '测量一下工具表体积'], { env, cwd: WORK })
const waitFor = async (timeoutMs) => {
  const started = Date.now()
  while (llm.state.requests.length === 0 && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 200))
}
await waitFor(60000)
child.kill('SIGKILL')
const request = llm.state.requests[0]
if (request === undefined) { console.log('未收到请求'); process.exit(1) }
const tools = Array.isArray(request.tools) ? request.tools : []
const rows = tools.map((tool) => ({ name: tool?.function?.name, chars: JSON.stringify(tool).length })).sort((a, b) => b.chars - a.chars)
console.log('工具总数:', rows.length, ' 全部 tools JSON:', JSON.stringify(tools).length, '字符')
for (const row of rows) console.log('  ' + String(row.name).padEnd(20) + row.chars)
const askGlm = tools.find((tool) => tool?.function?.name === 'ask_glm')
if (askGlm !== undefined) console.log('ask_glm 参数:', JSON.stringify(Object.keys(askGlm.function.parameters?.properties ?? {})))
const systemText = (request.messages ?? []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
console.log('system prompt:', systemText.length, '字符')
await llm.close()
