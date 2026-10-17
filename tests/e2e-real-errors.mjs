/**
 * 真实端点错误映射 + 开关验证（不产生任务、不花钱）：
 *   A. 假 brain → qwen_draw（故意无效 key）→ 期望 AUTH 人话；
 *   B. 假 brain → seedance_video（开关打开、Ark key 无模型权限）→ 期望 BAD_REQUEST + 厂商要点；
 *   C. 假 brain → seedance_video（默认开关关闭）→ 期望"已关闭"拒绝、工具清单与提示词都没有它；
 *   D. 假 brain → ask_glm（关闭由官方 tool-subagent 注册的工具）→ 同样清单隐藏 + 幻觉调用被拒。
 * 需要 ARK_API_KEY；DashScope 用故意无效 key（只要 401 映射）。
 * 运行：ARK_API_KEY=... node tests/e2e-real-errors.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
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
const APP = resolveApp() ?? process.env.DSH_APP ?? ''
const CLI = resolveCli()
const OVERLAY = join(SANDBOX, 'overlay-real-errors.yml')

// 场景 B 需要真实的 ARK_API_KEY（Ark 鉴权通过、型号未开通 → 404 映射）。
const { source } = loadKeysFromDshEnv(['ARK_API_KEY', 'ZHIPU_API_KEY'])
const keys = readyKeys(['ARK_API_KEY', 'ZHIPU_API_KEY'])
console.log('可用 key：' + (keys.length > 0 ? keys.join(' / ') : '（无）') + (source === undefined ? '' : '（来源 ' + source + '）'))
if (!keys.includes('ARK_API_KEY')) {
  console.log('提示：没有 ARK_API_KEY，场景 B（Ark 404 映射）会退化成"未配置 key"的 MISSING_CREDENTIAL 断言。')
}

await mkdir(WORK, { recursive: true })
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
  // 隔离持久化：不隔离的话会写进用户真实的 ~/.dsh；而且**上一轮的出图缓存会让本次命中**，
  // 于是"用无效 key 触发 401"的场景根本不会发请求，AUTH 映射就测不到了（2026-10-14 实测）。
  '- id: mm-models',
  "  name: 'dsh-mm-models'",
  '  config:',
  '    imageCachePath: ' + JSON.stringify(join(WORK, 'image-cache.json')),
  '    taskRegistryPath: ' + JSON.stringify(join(WORK, 'tasks.json')),
  '    cacheResults: false',
  '    persistTasks: false',
  '',
].join('\n')
await writeFile(OVERLAY, overlay, 'utf8')

// 打开 seedance 开关的覆盖层（其余字段回落 schema 默认=真实端点）。
//
// ⚠ 这里**故意钉一个不存在的接入点 id**，而不是用真实模型名。
// 起因（2026-10-15）：这个用例原本依赖"账号未开通"才报 `MODEL_UNAVAILABLE`——
// 用户把方舟开通之后，同一个请求变成了 `BAD_REQUEST`（真参数错误），测试立刻失败。
// **依赖账号权限状态的测试是脆弱的**：换账号、开通/退订都会让它乱跳。
// 钉一个形态合法但必然不存在的 ep- 接入点，就能确定性地拿到 `InvalidEndpointOrModel`。
const SEEDANCE_OVERLAY = join(SANDBOX, 'overlay-seedance-on.yml')
await writeFile(
  SEEDANCE_OVERLAY,
  [
    '- id: mm-models',
    "  name: 'dsh-mm-models'",
    '  config:',
    '    enableSeedanceVideo: true',
    // 形态合法（方舟接入点就是 ep- 开头）但必然不存在 → 稳定复现 MODEL_UNAVAILABLE
    '    seedanceModel: ep-0000000000000-nonexistent',
    '    maxCallsPerTurn: 0',
    '',
  ].join('\n'),
  'utf8',
)

// 关闭 ask_glm 的覆盖层（ask_glm 由官方 tool-subagent 行注册，验证"关别人的工具"也彻底）。
const ASKGLM_OFF_OVERLAY = join(SANDBOX, 'overlay-askglm-off.yml')
await writeFile(
  ASKGLM_OFF_OVERLAY,
  ['- id: mm-models', "  name: 'dsh-mm-models'", '  config:', '    enableAskGlm: false', '    enableAskQwen: false', '    maxCallsPerTurn: 0', ''].join('\n'),
  'utf8',
)

const baseEnv = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  DSH_HOME,
  DSH_PERMISSION_MODE: 'danger-full-access',
  MOCK_API_KEY: 'test-mock-key',
  PATH: join(SANDBOX, 'bin') + ';' + (process.env.PATH ?? ''),
}

function runHeadless(task, envOverride = {}, extraOverlay) {
  const env = { ...baseEnv, ...envOverride }
  const patches = extraOverlay === undefined ? [OVERLAY] : [OVERLAY, extraOverlay]
  return new Promise((resolve) => {
    const args = [CLI, '--profile', 'mmtest']
    for (const patch of patches) args.push('--patch', patch)
    args.push(task)
    const child = spawn(APP, args, { env, cwd: WORK })
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

// A：故意无效的 DashScope key（401 映射，不产生任何费用）
const a = await runHeadless('画一张鲸鱼，插画风格', { DASHSCOPE_API_KEY: 'sk-invalid-error-mapping' })
console.log('--- 无效 DashScope key：exit', a.code)
console.log(a.stdout.trim().slice(0, 600))
if (a.code !== 0) failures.push('qwen scenario exit code ' + a.code)
if (!a.stdout.includes('无效或已过期')) failures.push('AUTH 人话缺失')

/** 取一段新请求里模型实际看到的工具名（验证 restrict 隐藏层）。 */
function toolNamesSince(index) {
  return llm.state.requests
    .slice(index)
    .flatMap((request) => (Array.isArray(request.tools) ? request.tools : []).map((tool) => tool?.function?.name))
    .filter((name) => typeof name === 'string')
}

/** 取一段新请求的 system/developer 提示词（排除 tools 与 tool 结果，避免把 guard 文案算进来）。 */
function promptTextSince(index) {
  return llm.state.requests
    .slice(index)
    .flatMap((request) => {
      const messages = Array.isArray(request.messages) ? request.messages : []
      return messages
        .filter((message) => message.role === 'system' || message.role === 'developer')
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')))
    })
    .join('\n')
}

// B：Ark key 有效但无模型权限（404 映射）；需要显式打开开关，否则会先被 guard 拦下
const beforeB = llm.state.requests.length
const b = await runHeadless('做一段海浪视频', {}, SEEDANCE_OVERLAY)
console.log('--- Ark 无模型权限（开关打开）：exit', b.code)
console.log(b.stdout.trim().slice(0, 600))
if (b.code !== 0) failures.push('ark scenario exit code ' + b.code)
// 有 Ark key 时会走到厂商 **404 InvalidEndpointOrModel.NotFound**（模型未开通 / 接入点不存在）。
// ⚠ 这里以前断言的是「参数不被接受」——那是**把 bug 当规格**：404 被通用映射成 BAD_REQUEST，
// 于是"去控制台开通/换接入点"被说成"改 duration/size"，用户照着改永远改不好。
// 2026-10-15 修正为断言正确分类（MODEL_UNAVAILABLE）。
if (keys.includes('ARK_API_KEY')) {
  if (!b.stdout.includes('模型/接入点不可用')) failures.push('MODEL_UNAVAILABLE 人话缺失')
  if (!b.stdout.includes('不是参数问题')) failures.push('应明确否定"参数问题"这个误导')
  if (b.stdout.includes('参数不被接受')) failures.push('模型未开通不该被说成参数错误')
} else if (!b.stdout.includes('未配置 ARK_API_KEY')) {
  failures.push('没有 ARK_API_KEY 时应报"未配置 ARK_API_KEY"')
}
if (!toolNamesSince(beforeB).includes('seedance_video')) failures.push('开关打开时 seedance_video 应出现在工具清单里')
if (!promptTextSince(beforeB).includes('主创兼工程师')) failures.push('分工提示词段落缺失')
// 读图员是**唯一有意的例外**：「图像任务禁令」必须点名 ask_glm / ask_qwen 才能下达禁令。
// 其余工具名仍然不出现（不泄漏能力）。
if (/seedance_video|qwen_draw|media_task|media_report/.test(promptTextSince(beforeB))) {
  failures.push('分工提示词段落不应出现其它工具名')
}
if (!promptTextSince(beforeB).includes('图像任务禁令')) failures.push('分工提示词段落应含图像任务禁令')

// C：默认开关关闭 → 不触网，直接给出"已关闭"的可读拒绝；且工具清单里不应出现 seedance_video
const beforeC = llm.state.requests.length
const c = await runHeadless('做一段海浪视频')
console.log('--- seedance 开关关闭：exit', c.code)
console.log(c.stdout.trim().slice(0, 600))
if (c.code !== 0) failures.push('switch scenario exit code ' + c.code)
if (!c.stdout.includes('已关闭')) failures.push('开关拒绝文案缺失')
if (toolNamesSince(beforeC).includes('seedance_video')) failures.push('开关关闭时 seedance_video 不应出现在工具清单里')
if (promptTextSince(beforeC).includes('seedance_video')) failures.push('开关关闭时提示词不应提到 seedance_video')

// D：关闭 ask_glm（官方 tool-subagent 注册的工具）→ 清单里没有、提示词不提、幻觉调用被 guard 拒绝
const beforeD = llm.state.requests.length
const d = await runHeadless('让读图员描述图片', {}, ASKGLM_OFF_OVERLAY)
console.log('--- ask_glm 开关关闭：exit', d.code)
console.log(d.stdout.trim().slice(0, 600))
if (d.code !== 0) failures.push('ask_glm-off scenario exit code ' + d.code)
if (!d.stdout.includes('已关闭：ask_glm')) failures.push('ask_glm 关闭后应给出 guard 拒绝')
if (toolNamesSince(beforeD).includes('ask_glm')) failures.push('ask_glm 关闭后不应出现在工具清单里')
// 图像禁令会**点名** ask_glm（"图像任务只能走 ask_glm / ask_qwen"），所以点名不是泄漏。
// 真正该守的是：关掉之后**工具清单里不能再有它**（上一行已断言），提示词里的点名属于禁令文本。
// 这里只断言禁令仍然在（而不是断言"不出现工具名"——那与禁令本身矛盾）。
if (!promptTextSince(beforeD).includes('图像任务禁令')) failures.push('分工提示词段落应始终含图像任务禁令')

await llm.close()
if (failures.length > 0) {
  console.error('\nREAL-ERROR E2E FAIL: ' + failures.join('; '))
  process.exitCode = 1
} else {
  console.log('\nREAL-ERROR E2E OK：真实 401/404 被映射成可读人话；开关关闭时工具从清单/提示词消失，幻觉调用被 guard 拒绝，且整轮不中断。')
}
