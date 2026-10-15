/**
 * 零成本 A/B 对比：只读**已经存在**的会话日志，不跑引擎、不调模型、不花一分钱。
 *
 * 为什么需要它：
 *   "插件到底有没有提升"很难直接测——跑两个游戏各要几小时和几块钱，而且项目不同、
 *   模型状态不同，变量根本控制不住。但有一组**免费且客观**的代理指标可以从日志里数出来：
 *
 *     1. **每 100 步的原生读图调用数**（`read_image`）
 *        —— 插件生效时它应当趋近 0（读图被强制走 ask_glm/ask_qwen）。
 *     2. **是否出现"自造读图脚本"**（如 see.py / 直接打视觉模型端点）
 *        —— 有插件时不该出现；没有时模型会自己造轮子。
 *     3. **读图员调用数**（`ask_glm` / `ask_qwen`）
 *        —— 插件把"看图"变成一次函数调用。
 *
 *   三者都是**行为指纹**：同样的任务，走插件的会话在这三项上和裸跑明显不同。
 *   成本（tokens / 费用）也能从用量账本按会话时间窗切出来。
 *
 * 用法：
 *   node tests/vision-ab-report.mjs "D:\ds 2"                    # 单工作区报告
 *   node tests/vision-ab-report.mjs "D:\ds 2" "C:\...\default-workspace"   # 并排对比
 *
 * 开销：纯本地读文件 + 解压，毫秒级，零 API 调用。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inflateAll } from './_zstd.mjs'

const SESSIONS_ROOT = join(process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh'), 'sessions')

/**
 * 工作区路径 → 会话目录名（实测规则，4/4 验证过）。
 *   `\` `/` `:` → `-`；空格与 CJK → `~XXXX`（四位十六进制大写）；`.` 与 `-` 原样。
 * @param {string} workspace - 绝对路径。
 * @returns {string} 目录名（形如 `--D-DS~0020WORK~0020AREA--`）。
 */
export function namespaceOf(workspace) {
  return (
    '--' +
    workspace
      .replace(/[\\/:]/g, '-')
      .replace(/[^A-Za-z0-9.\-]/g, (ch) => '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
      .replace(/-+/g, '-') +
    '--'
  )
}

/**
 * 官方单价（元 / 百万 tokens），2026-10-15 取自
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * deepseek-flash：空闲时段是高峰时段的一半；高峰时段为北京时间周一至周五
 * 9:00–12:00 与 14:00–18:00。这里**两个价位都算**并给区间，避免猜时段猜错。
 */
const PRICING = {
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
}

/** 用一份单价算费用（元）。 */
function costOf(usage, rate) {
  return (
    (usage.cacheReadTokens / 1e6) * rate.cacheHit +
    (usage.inputTokens / 1e6) * rate.cacheMiss +
    (usage.outputTokens / 1e6) * rate.output
  )
}

/**
 * 从日志自身求和 token 用量。
 *
 * 为什么不用用量账本按时间窗切：会话可能隔天续接，时间窗一小一大就会圈进
 * 大量无关用量（实测把 B 的 ¥0.94 算成了 ¥144）。而每条 `assistant/message`
 * 都带 `data.usage`，直接求和既精确又不依赖墙钟时间。
 */
function usageOf(events) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const u = event.data?.usage
    if (u === null || u === undefined) continue
    total.inputTokens += u.inputTokens ?? 0
    total.outputTokens += u.outputTokens ?? 0
    total.cacheReadTokens += u.cacheReadTokens ?? 0
    total.cacheWriteTokens += u.cacheWriteTokens ?? 0
  }
  total.totalTokens = total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens
  return total
}

/**
 * 分析一个会话日志。
 * @param {string} file - session.v4.jsonl.zstd 路径。
 * @returns {object|null} 统计结果。
 */
function analyzeSession(file) {
  let events
  try {
    const text = inflateAll(readFileSync(file)).toString('utf8')
    events = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return null
  }
  if (events.length === 0) return null
  const calls = events.filter((e) => e.type === 'tool/call')
  const count = (name) => calls.filter((c) => c.data?.name === name).length
  const times = events.filter((e) => typeof e.time === 'number').map((e) => e.time)
  const results = events.filter((e) => e.type === 'tool/result')
  return {
    id: events[0]?.id ?? '?',
    startedAt: times[0] ?? 0,
    endedAt: times[times.length - 1] ?? 0,
    events: events.length,
    steps: events.filter((e) => e.type === 'assistant/message').length,
    turns: events.filter((e) => e.type === 'turn/start').length,
    calls: calls.length,
    readImage: count('read_image'),
    askReader: count('ask_glm') + count('ask_qwen'),
    subagent: count('subagent') + count('subagent_fork'),
    // 只在**工具调用参数**里找自造脚本，避免把提示词/文档里的提及算进来
    ownVisionScript: calls.some((c) => /(see|look|view|vision|看图|读图)[\w-]*\.py/i.test(c.data?.arguments ?? '')),
    errorRate: results.length === 0 ? 0 : (results.filter((e) => e.data?.message?.isError === true).length / results.length) * 100,
    usage: usageOf(events),
  }
}

/**
 * 汇总一个工作区。
 * @param {string} workspace - 绝对路径。
 * @returns {object} { workspace, namespace, sessions, totals }
 */
export function summarizeWorkspace(workspace) {
  const namespace = namespaceOf(workspace)
  const dir = join(SESSIONS_ROOT, namespace)
  const sessions = []
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const stat = analyzeSession(file)
      if (stat !== null) sessions.push(stat)
    }
  }
  sessions.sort((a, b) => a.startedAt - b.startedAt)
  const totals = sessions.reduce(
    (acc, s) => ({
      steps: acc.steps + s.steps,
      calls: acc.calls + s.calls,
      readImage: acc.readImage + s.readImage,
      askReader: acc.askReader + s.askReader,
      subagent: acc.subagent + s.subagent,
      ownVisionScript: acc.ownVisionScript || s.ownVisionScript,
      sessions: acc.sessions + 1,
    }),
    { steps: 0, calls: 0, readImage: 0, askReader: 0, subagent: 0, ownVisionScript: false, sessions: 0 },
  )
  // 用量：直接对每个会话日志里的 usage 求和（不依赖墙钟时间窗）
  const usage = sessions.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.usage.inputTokens,
      outputTokens: acc.outputTokens + s.usage.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + s.usage.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + s.usage.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return {
    workspace,
    namespace,
    sessions,
    totals,
    usage,
    cost: { offPeak: costOf(usage, PRICING.offPeak), peak: costOf(usage, PRICING.peak) },
    found: existsSync(dir),
  }
}

/** 每 100 步的比率（步数为 0 时返回 0）。 */
const per100 = (value, steps) => (steps === 0 ? 0 : (value / steps) * 100)

/** 渲染一个工作区的报告。 */
function render(result) {
  const lines = []
  lines.push(`工作区：${result.workspace}`)
  lines.push(`  会话目录：${result.namespace}${result.found ? '' : '  ⚠ 不存在（路径写错了？）'}`)
  lines.push(`  会话数：${result.totals.sessions}｜步数：${result.totals.steps}｜工具调用：${result.totals.calls}`)
  if (result.sessions.length > 0) {
    const last = result.sessions[result.sessions.length - 1]
    lines.push(`  最近一次会话：${new Date(last.startedAt).toLocaleString()}（${last.steps} 步 / ${last.calls} 调用）`)
  }
  lines.push('')
  lines.push('  视觉路径指纹：')
  lines.push(`    原生 read_image 调用：${String(result.totals.readImage).padStart(4)}  （每 100 步 ${per100(result.totals.readImage, result.totals.steps).toFixed(1)} 次）`)
  lines.push(`    读图员调用(glm/qwen)：${String(result.totals.askReader).padStart(4)}  （每 100 步 ${per100(result.totals.askReader, result.totals.steps).toFixed(1)} 次）`)
  lines.push(`    委派子代理：${String(result.totals.subagent).padStart(4)}`)
  lines.push(`    自造读图脚本：${result.totals.ownVisionScript ? '❌ 有（说明视觉工具不顺手）' : '✅ 无'}`)
  lines.push('')
  lines.push('  Token 用量（由日志内 usage 求和，非估算）：')
  const u = result.usage
  lines.push(`    输入·未命中缓存：${(u.inputTokens / 1e6).toFixed(2)}M`)
  lines.push(`    输入·命中缓存  ：${(u.cacheReadTokens / 1e6).toFixed(2)}M`)
  lines.push(`    输出            ：${(u.outputTokens / 1e6).toFixed(2)}M`)
  lines.push(`    合计            ：${(u.totalTokens / 1e6).toFixed(2)}M tokens`)
  lines.push(`  费用（官方单价，deepseek-flash）：空闲时段 ¥${result.cost.offPeak.toFixed(2)} ～ 高峰时段 ¥${result.cost.peak.toFixed(2)}`)
  return lines.join('\n')
}

const workspaces = process.argv.slice(2)
if (workspaces.length === 0) {
  console.log('用法：node tests/vision-ab-report.mjs "<工作区绝对路径>" ["<另一个工作区>"]')
  console.log('例：  node tests/vision-ab-report.mjs "D:\\ds 2" "C:\\Users\\<你>\\Documents\\deepseek-harness\\default-workspace"')
  process.exit(1)
}
const results = workspaces.map(summarizeWorkspace)
for (const result of results) {
  console.log(render(result))
  console.log('')
}
if (results.length === 2) {
  const [a, b] = results
  console.log('—— 对比 ——')
  console.log(`  原生读图（每百步）：A ${per100(a.totals.readImage, a.totals.steps).toFixed(1)}  vs  B ${per100(b.totals.readImage, b.totals.steps).toFixed(1)}`)
  console.log(`  读图员（每百步）  ：A ${per100(a.totals.askReader, a.totals.steps).toFixed(1)}  vs  B ${per100(b.totals.askReader, b.totals.steps).toFixed(1)}`)
  console.log(`  费用（空闲/高峰） ：A ¥${a.cost.offPeak.toFixed(2)}/${a.cost.peak.toFixed(2)}  vs  B ¥${b.cost.offPeak.toFixed(2)}/${b.cost.peak.toFixed(2)}`)
  console.log(`  单步成本（空闲）  ：A ¥${(a.cost.offPeak / Math.max(1, a.totals.steps)).toFixed(4)}  vs  B ¥${(b.cost.offPeak / Math.max(1, b.totals.steps)).toFixed(4)}`)
}
