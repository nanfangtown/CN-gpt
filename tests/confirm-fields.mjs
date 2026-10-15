/**
 * 真 key 实跑确证（规划 [13] S1–S3，不做任何猜测）。
 *
 * 用真 key 跑一次最小 submit（+ 必要时的 poll/fetch），把真实响应形状写成脱敏报告，
 * 据此冻结 core/fields.mjs 与 README 的"接线说明"。
 *
 * 注意：这会调用真实付费 API。
 *   图片：1 张，费用很小；视频：会产生真实视频费用，必须显式 --ark 才跑。
 *
 * 用法：
 *   set DASHSCOPE_API_KEY=... & set ARK_API_KEY=...
 *   node tests/confirm-fields.mjs          # 只确证 DashScope 制图（sync/async 自动识别）
 *   node tests/confirm-fields.mjs --ark    # 追加确证 Ark 出片
 *
 * 输出：tests/field-report-<时间戳>.md（key 打码、URL 去掉签名参数）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskManager } from '../tasks/manager.mjs'
import { dashscopeImageAdapter } from '../tasks/adapters/dashscope-image.mjs'
import { arkVideoAdapter } from '../tasks/adapters/ark-video.mjs'
import { DASHSCOPE_FIELDS, ARK_FIELDS, getPath } from '../core/fields.mjs'

const OUT_DIR = dirname(fileURLToPath(import.meta.url))

function mask(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  return value.length <= 8 ? '****' : value.slice(0, 4) + '…' + value.slice(-2)
}

/** 去掉 URL 的查询串（签名），并打码 key 字段。 */
function sanitize(node, depth = 0) {
  if (depth > 8) return '…'
  if (Array.isArray(node)) return node.map((item) => sanitize(item, depth + 1))
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (/key|token|secret|authorization/i.test(key)) out[key] = mask(String(value))
    else if (typeof value === 'string' && /^https?:/i.test(value)) out[key] = value.split('?')[0] + (value.includes('?') ? '?<signed>' : '')
    else out[key] = sanitize(value, depth + 1)
  }
  return out
}

/** 同步模式的字段对照（路径含数组，手工导航更直观）。 */
function syncChecklist(json) {
  const requestId = json?.request_id
  const content = json?.output?.choices?.[0]?.message?.content
  const image = Array.isArray(content) ? content.find((part) => typeof part?.image === 'string')?.image : undefined
  const count = json?.usage?.output_image_count
  const width = json?.usage?.output_width
  const height = json?.usage?.output_height
  return [
    '- request_id: ' + (requestId ? '✅ ' + requestId : '❌'),
    '- output.choices[].message.content[].image: ' + (image ? '✅ ' + image.split('?')[0] : '❌'),
    '- usage.output_image_count: ' + (count !== undefined ? '✅ ' + count : '❌'),
    '- usage.output_width/height: ' + (width !== undefined && height !== undefined ? '✅ ' + width + 'x' + height : '❌'),
  ]
}

function checklist(json, fields, ids) {
  const rows = []
  for (const id of ids) {
    const paths = Array.isArray(fields[id]) ? fields[id] : [fields[id]]
    const hits = paths.filter((path) => getPath(json, path) !== undefined)
    rows.push(`- ${id}: ${hits.length > 0 ? '✅ ' + hits.join(' / ') : '❌ 未命中（实际形状见下方 JSON）'}`)
  }
  return rows
}

/** 记录最后一次响应原文（脱敏报告用），同时把响应交回调用方。 */
function recordingFetch(sink) {
  return async (url, init) => {
    const response = await fetch(url, init)
    response
      .clone()
      .text()
      .then((text) => {
        sink.text = text
        sink.url = String(url).split('?')[0]
      })
      .catch(() => {})
    return response
  }
}

async function confirmImage(report) {
  const key = process.env.DASHSCOPE_API_KEY
  if (key === undefined || key.trim().length === 0) {
    report.push('## DashScope 文生图\n\n跳过：未设置 DASHSCOPE_API_KEY。\n')
    return
  }
  const config = {
    dashscopeBase: 'https://dashscope.aliyuncs.com/api/v1',
    qwenModel: process.env.MM_QWEN_MODEL ?? 'qwen-image-3.0',
    dashscopeImageMode: process.env.MM_DASHSCOPE_MODE ?? 'auto',
    taskTimeoutMs: 300000,
    taskPollIntervalMs: 5000,
    taskPollMaxIntervalMs: 10000,
    httpTimeoutMs: 60000,
    queryRetries: 2,
    maxDownloadBytes: 52428800,
  }
  const manager = createTaskManager({ adapters: [dashscopeImageAdapter], config })
  const mode = dashscopeImageAdapter.modeFor(config)
  const spec = { model: config.qwenModel, prompt: '极简线条鲸鱼，白底，单色', n: 1, size: '1024*1024' }
  report.push('## DashScope 文生图')
  report.push(`- 模型：${spec.model}；size=${spec.size}；n=${spec.n}；模式=${mode}（dashscopeImageMode=${config.dashscopeImageMode}）`)

  const sink = {}
  const fetchImpl = recordingFetch(sink)
  let taskRef
  try {
    taskRef = await manager.submit({ adapterId: 'dashscope-image', spec, credential: key, fetchImpl, submitTimeoutMs: config.taskTimeoutMs })
    report.push(`- submit：✅ ${mode === 'sync' ? '同步返回 request_id=' : '异步 task_id='}${taskRef.taskId}`)
  } catch (error) {
    report.push(`- submit：❌ ${error.code} ${error.message}`)
    report.push('')
    return
  }

  let state
  if (taskRef.state !== undefined) {
    state = { ...taskRef.state, adapter: taskRef.adapter, taskId: taskRef.taskId }
    report.push(`- 同步生成：状态=${state.status}，产物 ${state.artifacts.length} 个`)
  } else {
    state = await manager.wait(taskRef, { credential: key, fetchImpl })
    report.push(`- wait：状态=${state.status}（rawStatus=${state.rawStatus}），产物 ${state.artifacts.length} 个，耗时 ${state.elapsedMs}ms`)
    const query = dashscopeImageAdapter.buildQuery(taskRef.taskId, { credential: key, config })
    const raw = await fetch(query.url, { headers: query.headers })
    sink.text = await raw.text()
    sink.url = query.url.split('?')[0]
  }

  let json
  try {
    json = JSON.parse(sink.text ?? '{}')
  } catch {
    json = undefined
  }
  report.push('- 原始响应（' + (sink.url ?? '?') + '）：')
  if (mode === 'sync') {
    report.push(...syncChecklist(json ?? {}))
  } else {
    report.push(...checklist(json ?? {}, DASHSCOPE_FIELDS, ['taskIdPaths', 'statusPaths', 'resultPaths', 'resultUrlPaths', 'usageImageCountPaths']))
  }
  report.push('')
  report.push('```json')
  report.push(JSON.stringify(sanitize(json ?? {}), null, 2))
  report.push('```')
  if (state.artifacts.length > 0) {
    const files = await manager.fetchArtifacts(state, { outDir: join(OUT_DIR, '_sandbox', 'confirm'), nameHint: 'confirm-qwen', signal: new AbortController().signal })
    report.push(`- fetch：✅ 落盘 ${files.map((file) => file.path).join(', ')}（${files[0]?.bytes ?? 0} bytes，${files[0]?.mediaType ?? '?'}）`)
  }
  report.push('')
}

async function confirmVideo(report) {
  const key = process.env.ARK_API_KEY
  if (key === undefined || key.trim().length === 0) {
    report.push('## Ark 视频\n\n跳过：未设置 ARK_API_KEY。\n')
    return
  }
  const config = {
    arkBase: 'https://ark.cn-beijing.volces.com/api/v3',
    seedanceModel: process.env.MM_SEEDANCE_MODEL ?? 'seedance-2.0',
    taskTimeoutMs: 900000,
    taskPollIntervalMs: 5000,
    taskPollMaxIntervalMs: 10000,
    httpTimeoutMs: 60000,
    queryRetries: 2,
    maxDownloadBytes: 209715200,
  }
  const manager = createTaskManager({ adapters: [arkVideoAdapter], config })
  const spec = { model: config.seedanceModel, prompt: '海浪拍打沙滩，日系动画风', duration: 5, resolution: '720p', ratio: '16:9' }
  report.push('## Ark 文生视频')
  report.push(`- 模型：${spec.model}；duration=${spec.duration}s；resolution=${spec.resolution}；ratio=${spec.ratio}`)
  const sink = {}
  const fetchImpl = recordingFetch(sink)
  let taskRef
  try {
    taskRef = await manager.submit({ adapterId: 'ark-video', spec, credential: key, fetchImpl })
    report.push(`- submit：✅ task_id=${taskRef.taskId}`)
  } catch (error) {
    report.push(`- submit：❌ ${error.code} ${error.message}`)
    report.push('')
    return
  }
  const state = await manager.wait(taskRef, { credential: key, fetchImpl })
  report.push(`- wait：状态=${state.status}（rawStatus=${state.rawStatus}），产物 ${state.artifacts.length} 个，耗时 ${state.elapsedMs}ms`)
  const query = arkVideoAdapter.buildQuery(taskRef.taskId, { credential: key, config })
  const raw = await fetch(query.url, { headers: query.headers })
  sink.text = await raw.text()
  sink.url = query.url.split('?')[0]
  let json
  try {
    json = JSON.parse(sink.text ?? '{}')
  } catch {
    json = undefined
  }
  report.push(`- 查询 HTTP：${sink.url ?? '?'}`)
  report.push(...checklist(json ?? {}, ARK_FIELDS, ['taskIdPaths', 'statusPaths', 'videoUrlPaths', 'errorCodePaths', 'usageSecondsPaths']))
  report.push('')
  report.push('```json')
  report.push(JSON.stringify(sanitize(json ?? {}), null, 2))
  report.push('```')
  if (state.status === 'succeeded' && state.artifacts.length > 0) {
    const files = await manager.fetchArtifacts(state, { outDir: join(OUT_DIR, '_sandbox', 'confirm'), nameHint: 'confirm-seedance', signal: new AbortController().signal })
    report.push(`- fetch：✅ 落盘 ${files.map((file) => file.path).join(', ')}（${files[0]?.bytes ?? 0} bytes）`)
  }
  report.push('')
}

const report = []
report.push('# 真 key 实跑确证报告（规划 [13] S1–S3）')
report.push('')
report.push(`- 时间：${new Date().toISOString()}`)
report.push(`- Node：${process.version}`)
report.push('- 说明：本报告用于冻结 core/fields.mjs；key 已打码，URL 已去掉签名参数。')
report.push('')

await confirmImage(report)
if (process.argv.includes('--ark')) await confirmVideo(report)
else report.push('## Ark 视频\n\n未启用：需要显式传入 --ark（会产生真实视频费用）。\n')

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
const target = join(OUT_DIR, `field-report-${stamp}.md`)
await mkdir(OUT_DIR, { recursive: true })
await writeFile(target, report.join('\n'), 'utf8')
console.log(report.join('\n'))
console.log('\n报告已写入：' + target)
