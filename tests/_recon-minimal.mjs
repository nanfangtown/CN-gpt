/**
 * 侦察 2：极简模式（preset-minimal）下主代理到底拿得到哪些工具。
 *
 * 背景：desktop profile 不允许 CLI 启动（Electron 独占），所以这里在 mmtest 沙箱里
 * **复刻** desktop 的 preset 组成：
 *   - 一份 `@deepseek-ai/dsh-agent-preset` 声明，id=minimal，plugins 与 desktop 的
 *     `preset-minimal` 逐字一致（persona + persistent-shell）；
 *   - 把 desktop 里两个"全局"读图行 tool-subagent-glm / tool-subagent-qwen 也搬过来，
 *     用来回答关键问题：**全局声明的 ask_glm / ask_qwen，在 minimal 会话里可见吗？**
 *   - agent-preset-registry.default = minimal，让 headless 会话就用 minimal。
 * 另外再跑一次 default=standard 作对照，确认差异确实来自 preset。
 *
 * 用法：node tests/_recon-minimal.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApp, resolveCli, profileHint } from './_paths.mjs'
import { startMockLlm } from './mock-llm.mjs'
import { loadKeysFromDshEnv } from './_env.mjs'

// 前置检查：沙箱 profile 是**一次性**建出来的，全新 clone 没有它。
// 缺了就直接说清怎么建，而不是把 dsh 的内部堆栈丢给用户。
{
  const hint = profileHint()
  if (hint !== undefined) {
    console.log('跳过：' + hint)
    process.exit(0)
  }
}


loadKeysFromDshEnv(['ZHIPU_API_KEY', 'DASHSCOPE_API_KEY'])

const __dirname = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(__dirname, '..', '_sandbox')
const DSH_HOME = join(SANDBOX, 'dshhome')
const WORK = join(SANDBOX, 'work')
const APP = resolveApp() ?? process.env.DSH_APP ?? ''
const CLI = resolveCli()

await mkdir(WORK, { recursive: true })

/** minimal 预设的 plugins，逐字照抄 desktop 的 preset-minimal（persona + 持久 shell + 压缩组）。 */
const MINIMAL_PLUGINS = [
  '      - id: persona',
  "        name: '@deepseek-ai/dsh-persona'",
  '        config:',
  '          prefix: You are a helpful software engineer assistant.',
  '          complete: true',
  '          includeRuntimeContext: false',
  '      - id: persistent-shell',
  '        name: cordis:group',
  '        group: true',
  '        config:',
  '          - id: pty',
  "            name: '@deepseek-ai/dsh-terminal'",
  // 2026-10-13 加：压缩组（与 desktop preset-minimal 里新加的那组一致）。
  '      - id: compaction',
  '        name: cordis:group',
  '        group: true',
  '        isolate:',
  '          compaction: true',
  '          toolResultPruner: true',
  '        config:',
  '          - id: compaction-basic',
  "            name: '@deepseek-ai/dsh-compaction-basic'",
  '          - id: command-compact',
  "            name: '@deepseek-ai/dsh-command-compact'",
  '          - id: tool-result-pruner',
  "            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  '            config:',
  '              thresholdChars: 8192',
  '              headChars: 4096',
  '              tailChars: 1024',
]

/** desktop 里的两个"全局"读图行（toolFilter 为当前线上值）。 */
const READER_ROWS = (toolFilterLine) => [
  '- id: tool-subagent-glm',
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  '  config:',
  '    provider: spawn',
  '    toolName: ask_glm',
  '    backgroundMode: one-shot',
  '    enableRunInBackground: false',
  '    maxDepth: 1',
  '    agentOptions: { provider: glm, model: glm-4.6v }',
  '    persona: >-',
  '      你是多模态阅读员。只看图说话。',
  toolFilterLine,
  '',
].join('\n')

async function run(label, { defaultPreset, toolFilterLine }) {
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
    '- id: agent-preset-registry',
    "  name: '@deepseek-ai/dsh-agent-preset-registry'",
    '  config:',
    '    default: ' + defaultPreset,
    '- id: preset-minimal',
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    '    id: minimal',
    '    order: 3',
    '    plugins:',
    ...MINIMAL_PLUGINS,
    READER_ROWS(toolFilterLine),
    // 读图子代理默认关，这里显式打开 ask_glm —— 否则它即使在 preset 里也不会出现。
    '- id: mm-models',
    "  name: '@local/dsh-mm-models'",
    '  config:',
    '    enableAskGlm: true',
    '    enableAskQwen: false',
  ].join('\n')

  const overlayPath = join(SANDBOX, 'overlay-recon-minimal.yml')
  await writeFile(overlayPath, overlay, 'utf8')

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME,
    DSH_PERMISSION_MODE: 'danger-full-access',
    MOCK_API_KEY: 'test-mock-key',
    PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? ''),
  }
  const child = spawn(APP, [CLI, '--profile', 'mmtest', '--patch', overlayPath, '随便说一句'], { env, cwd: WORK })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const code = await new Promise((resolve) => child.on('close', resolve))
  await llm.close()

  const names = new Set()
  for (const request of llm.state.requests) {
    for (const tool of Array.isArray(request.tools) ? request.tools : []) {
      if (typeof tool?.function?.name === 'string') names.add(tool.function.name)
    }
  }
  const list = [...names].sort()
  console.log('\n########## ' + label + ' (exit ' + code + ') ##########')
  const stderrLines = stderr.trim().length === 0 ? [] : stderr.trim().split('\n')
  console.log('stderr 行数：' + stderrLines.length)
  for (const line of stderrLines.slice(-12)) console.log('   | ' + line)
  const badLines = stderrLines.filter((line) => /did not activate|failed|error/i.test(line))
  console.log('可疑诊断行（did not activate / failed / error）：' + (badLines.length === 0 ? '无' : badLines.length + ' 条'))
  console.log('工具数：' + list.length)
  console.log('全部：' + list.join(', '))
  const readers = list.filter((name) => name === 'ask_glm' || name === 'ask_qwen')
  console.log('>>> 读图子代理：' + (readers.length > 0 ? readers.join(', ') : '（一个都没有）'))
  return list
}

// 当前线上写法：allow 里带 5 项
const CURRENT_FILTER = '    toolFilter: { allow: [read, read_image, glob, grep, web_search] }'
const minimal = await run('minimal 预设 + 全局读图行', { defaultPreset: 'minimal', toolFilterLine: CURRENT_FILTER })
const standard = await run('standard 预设（对照）', { defaultPreset: 'standard', toolFilterLine: CURRENT_FILTER })

console.log('\n################ 结论 ################')
console.log('【注意】headless 沙箱不按 preset 组装 agent：实测把 persona 设成哨兵也传不进系统提示词，')
console.log('        persistent-shell 的 pty 工具也不出现。所以下面两个数字相同是 harness 局限，')
console.log('        不能用来判断"极简模式有没有压缩"。preset 级行为只能在 desktop app 里实测。')
console.log('minimal 会话可见 ask_glm/ask_qwen：' + (minimal.includes('ask_glm') || minimal.includes('ask_qwen') ? '是' : '否'))
console.log('standard 会话可见 ask_glm/ask_qwen：' + (standard.includes('ask_glm') || standard.includes('ask_qwen') ? '是' : '否'))
console.log('minimal 的压缩工具：' + (minimal.filter((n) => /compact|context|trim/i.test(n)).join(', ') || '（无）'))
console.log('standard 的压缩工具：' + (standard.filter((n) => /compact|context|trim/i.test(n)).join(', ') || '（无）'))
