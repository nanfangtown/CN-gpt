/**
 * 百炼视频（可灵 / 万相）真实链路探针 —— **不花钱**是默认行为。
 *
 * 用途：在写/改适配器之后，用最小代价确证四件事（代码里标着"待实跑确证"的那几处）：
 *   ① 域名与鉴权：换用业务空间域名后，Bearer key 能不能通；
 *   ② 万相的 `parameters.size` 字段名对不对；
 *   ③ 状态枚举与 `output.video_url` 路径；
 *   ④ 响应里有没有 billing / usage 可以回写账本。
 *
 * 三种模式（按代价从低到高）：
 *   node tests/probe-dashscope-video.mjs
 *       只发一次 GET /tasks/{不存在} —— **零费用**。404 就说明"鉴权通过、端点可达"。
 *   node tests/probe-dashscope-video.mjs --submit --yes
 *       真提交一个 5 秒 720P 无声可灵任务（约 ¥3），轮询到终态并打印产物 URL。
 *   node tests/probe-dashscope-video.mjs --submit --yes --model wan2.5
 *       同上但走万相（约 ¥3）。
 *
 * 凭据来源（优先级）：命令行 --key / --workspace > 环境变量 > ~/.dsh/.env
 *   DASHSCOPE_API_KEY
 *   DASHSCOPE_WORKSPACE_ID   （百炼控制台首页的业务空间 ID；也可用 --base 直接给完整基址）
 *
 * ⚠⚠ 2026-10-17 实测血泪（别再用"故意写错参数"当免费探针）：
 *   百炼视频是**先建任务、再做参数校验**。我用 3000 字符的超长 prompt 想换一个必错的
 *   400，结果三家全都返回 200 + task_id（任务真的建出来了）：
 *     · 可灵两条：随后 FAILED，`input.prompt: size must be between 0 and 2500`（约 ¥0）；
 *     · 万相一条：**照常跑完并扣费约 ¥3**（它对提示词长度不设同一上限）。
 *   结论：**POST 到这个端点本身就是下单**。唯一免费的探针是 GET /tasks/{不存在}，
 *   也就是本脚本默认做的事；`--submit` 一定、且只应在你明确要花钱时用。
 *
 * 另一条实测：`https://dashscope.aliyuncs.com/api/v1` 上视频路由与可灵/万相模型**当前可用**
 * （不填业务空间也能跑）。文档推荐业务空间专属域名，但存量 dashscope 域名暂时仍通；
 * 两者都用 `--base` 即可切换。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes('--' + name)
const valueOf = (name) => {
  const hit = args.find((arg) => arg.startsWith('--' + name + '='))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}

/** 极简 .env 读取（只取 KEY=VALUE，去掉引号；不处理 export / 变量展开）。 */
async function readDotEnv() {
  const candidates = [join(homedir(), '.dsh', '.env'), join(process.cwd(), '.env')]
  const out = {}
  for (const file of candidates) {
    try {
      const text = await readFile(file, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
        if (match === null) continue
        const value = match[2].replace(/^['"]|['"]$/g, '').trim()
        if (value.length > 0 && out[match[1]] === undefined) out[match[1]] = value
      }
    } catch {
      // 文件不存在是正常情况。
    }
  }
  return out
}

const dotenv = await readDotEnv()
const apiKey = valueOf('key') ?? process.env.DASHSCOPE_API_KEY ?? dotenv.DASHSCOPE_API_KEY
const workspaceId = valueOf('workspace') ?? process.env.DASHSCOPE_WORKSPACE_ID ?? dotenv.DASHSCOPE_WORKSPACE_ID
const modelChoice = valueOf('model') ?? 'kling-v3'

const MODELS = {
  'kling-v3': { id: 'kling/kling-v3-video-generation', family: 'kling' },
  'kling-v3-turbo': { id: 'kling/kling-v3-turbo-video-generation', family: 'kling' },
  'kling-v3-omni': { id: 'kling/kling-v3-omni-video-generation', family: 'kling' },
  'wan2.5': { id: 'wan2.5-t2v-preview', family: 'wan' },
}

function fail(message) {
  console.error('✗ ' + message)
  process.exit(1)
}

if (apiKey === undefined || apiKey.length === 0) {
  fail('缺少 DASHSCOPE_API_KEY（环境变量 / ~/.dsh/.env / --key=... 三选一）')
}
const baseOverride = valueOf('base')
if ((workspaceId === undefined || workspaceId.length === 0) && (baseOverride === undefined || baseOverride.length === 0)) {
  fail(
    '缺少业务空间 ID / API Host。打开 https://bailian.console.aliyun.com/cn-beijing/settings/workspace ' +
      '复制 API Host，然后用 --workspace=... 传进来（或写进环境变量 DASHSCOPE_WORKSPACE_ID）；' +
      '也可以用 --base=... 直接给完整基址。',
  )
}

/** 与 adapter 的 resolveBase 同款容错：整串 host 或只要 llm-xxxx 都能用。 */
function normalizeBase(value) {
  let text = String(value).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text
  if (!/\/api\/v\d+$/i.test(text)) text = text + '/api/v1'
  return text
}

const rawBase =
  baseOverride ??
  (workspaceId.includes('.') ? `https://${workspaceId}` : `https://${workspaceId}.cn-beijing.maas.aliyuncs.com`)
const base = normalizeBase(rawBase)
const auth = { Authorization: `Bearer ${apiKey}` }

console.log('端点：' + base)
console.log('模型：' + modelChoice + ' → ' + (MODELS[modelChoice]?.id ?? '（未知）'))
console.log('')

/** ① 零费用探针：GET 一个不存在的任务。 */
async function probe() {
  const url = `${base}/tasks/mm-health-probe`
  const started = Date.now()
  const response = await fetch(url, { method: 'GET', headers: auth })
  const text = await response.text()
  console.log(`① GET /tasks/{probe} → HTTP ${response.status}（${Date.now() - started} ms）`)
  console.log('   ' + text.slice(0, 300).replace(/\s+/g, ' '))
  if (response.status === 401 || response.status === 403) {
    fail('鉴权失败：key 与地域/业务空间不匹配（百炼要求 key 与端点同属华北2 北京）')
  }
  if (response.status === 404 || response.ok) {
    console.log('   ✅ 鉴权通过、端点可达（404 = 任务不存在，符合预期）')
    return true
  }
  console.log('   ⚠ 非预期状态码，继续提交前请先确认端点')
  return false
}

/** 构造与 adapter 完全一致的请求体（改动时请同步 dashscope-video.mjs）。 */
function buildBody(model, prompt) {
  const entry = MODELS[model]
  const body = { model: entry.id, input: { prompt } }
  if (entry.family === 'kling') {
    body.parameters = { mode: 'std', duration: 5, aspect_ratio: '16:9', audio: false, watermark: false }
  } else {
    body.parameters = { size: '1280*720', duration: 5, audio: false, prompt_extend: true, watermark: false }
  }
  return body
}

/** ② 真提交（默认不执行；必须同时给 --submit 与 --yes）。 */
async function submit() {
  const entry = MODELS[modelChoice]
  if (entry === undefined) fail('未知 --model：' + modelChoice)
  const body = buildBody(modelChoice, '一只鲸鱼在云海中缓慢游动，电影感，柔和体积光')
  console.log('② 提交任务（约 ¥3：5 秒 × 720P 无声）')
  console.log('   请求体：' + JSON.stringify(body))
  const response = await fetch(`${base}/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  console.log(`   HTTP ${response.status}`)
  console.log('   ' + text.slice(0, 600))
  let json
  try {
    json = JSON.parse(text)
  } catch {
    fail('响应不是 JSON —— 端点或请求体可能不对')
  }
  const taskId = json?.output?.task_id
  if (typeof taskId !== 'string') fail('没有拿到 output.task_id —— 请求体字段名需要调整（见上面原文）')
  console.log('   task_id = ' + taskId)

  const started = Date.now()
  for (;;) {
    if (Date.now() - started > 180_000) fail('3 分钟没到终态；可用 media_task(provider=bailian, task_id) 继续查')
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const poll = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers: auth })
    const pollText = await poll.text()
    let state
    try {
      state = JSON.parse(pollText)
    } catch {
      console.log('   轮询响应不是 JSON：' + pollText.slice(0, 300))
      continue
    }
    const status = state?.output?.task_status
    console.log(`   [${Math.round((Date.now() - started) / 1000)}s] ${status}`)
    if (status === 'SUCCEEDED') {
      console.log('   ✅ 产物：' + (state.output.video_url ?? '（没有 output.video_url！字段名要改）'))
      if (state.output?.usage !== undefined) console.log('   usage：' + JSON.stringify(state.output.usage))
      if (state.output?.billing !== undefined) console.log('   billing：' + JSON.stringify(state.output.billing))
      return
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      console.log('   ✗ 终态失败：' + JSON.stringify(state).slice(0, 600))
      return
    }
  }
}

const reachable = await probe()
if (flag('submit')) {
  if (!flag('yes')) {
    console.log('')
    console.log('⚠ 提交会产生真实费用（约 ¥3）。确认无误后加 --yes 再跑一次。')
    process.exit(0)
  }
  if (!reachable) fail('探针未通过，拒绝提交（避免付费接口试错）')
  console.log('')
  await submit()
} else {
  console.log('')
  console.log('只做了零费用探针。要真跑一次提交：加 --submit --yes（约 ¥3）。')
}
