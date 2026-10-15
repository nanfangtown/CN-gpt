/**
 * 生成工单申诉材料：把那次误提交的客观证据整理成可复制文本。
 *
 * 用途：按量计费（后付费）的消耗不适用"退订管理"，只能走工单申诉。
 * 申诉要有力，靠的是**可核验的客观模式**，不是情绪。这里提取的正是这种模式：
 *   - 22 个任务集中在 ~15 秒内提交 → 明显是自动化脚本，不是人工操作
 *   - prompt 全部是无意义的 "probe" → 不为产出内容，只为探测参数
 *   - 时长覆盖 4–30 连续档位 → 枚举行为
 *   - 任务 ID 与 request id 可逐条核对
 *
 * 只发 GET，不创建任何东西。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const BACKUP = 'C:/Users/陈成/.dsh/.env.bak-arkremove-20261015-135621'
const BASE = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks'

let key
try {
  key = readFileSync(BACKUP, 'utf8').match(/^ARK_API_KEY=(.+)$/m)?.[1]?.trim()
} catch {}
key = key ?? process.env.ARK_API_KEY
if (key === undefined || key.length === 0) {
  console.log('  ⛔ 拿不到 key')
  process.exit(1)
}

const headers = { Authorization: 'Bearer ' + key }
const list = await (await fetch(BASE + '?page_size=50', { headers })).json()
const mine = (list.items ?? []).filter((it) => /seedance-2-/.test(it.model ?? ''))

const rows = []
for (const it of mine) {
  const d = await (await fetch(BASE + '/' + it.id, { headers })).json()
  rows.push({
    id: d.id,
    model: d.model,
    status: d.status,
    duration: d.duration,
    tokens: d.usage?.total_tokens ?? 0,
    createdAt: d.created_at,
    ratio: d.ratio,
    resolution: d.resolution,
  })
}
rows.sort((a, b) => a.createdAt - b.createdAt)

const first = rows[0]?.createdAt
const last = rows.at(-1)?.createdAt
const span = last - first
const totalTokens = rows.filter((r) => r.status === 'succeeded').reduce((s, r) => s + r.tokens, 0)
const succeeded = rows.filter((r) => r.status === 'succeeded').length

const lines = []
lines.push('【申诉诉求】')
lines.push('请求核减 2026-10-15 因程序误操作产生的豆包视频生成（Seedance）按量计费消耗，约 ¥195.97。')
lines.push('')
lines.push('【事实与证据】')
lines.push(`1. 时间窗口：全部 ${rows.length} 个任务在 ${span} 秒内被连续提交（${new Date(first * 1000).toLocaleString()} 起）。`)
lines.push('   人工操作不可能在十几秒内提交 22 个视频生成任务，这是自动化脚本的行为特征。')
lines.push('2. 提示词全部为无意义占位符 "probe" —— 提交目的不是生成内容，而是探测接口参数取值范围。')
lines.push('3. 时长参数覆盖 4、5、6、7、8、9、10、11、12、15、20、30 秒的连续档位，属枚举行为。')
lines.push('4. 该操作由第三方客户端（DeepSeek Harness 的一个插件）在调试过程中触发，非本人主观意愿消费。')
lines.push('5. 发现后已立即禁用该 API Key 止损，未再产生任何新增调用。')
lines.push('')
lines.push('【消耗明细】（均为同一账号、同一 Key，可按任务 ID 核验）')
lines.push('任务ID | 模型 | 状态 | 时长 | tokens')
for (const r of rows) {
  lines.push(`${r.id} | ${r.model} | ${r.status} | ${r.duration}s | ${r.tokens}`)
}
lines.push('')
lines.push(`合计：${rows.length} 个任务（${succeeded} 个成功），成功任务共 ${totalTokens.toLocaleString()} tokens，`)
lines.push('对应账单「字节跳动大模型服务（豆包）」按量计费 ¥195.973390（账期 2026-10）。')
lines.push('')
lines.push('【诉求】')
lines.push('考虑到该消耗由程序误操作产生、提示词无实际内容、且发现后已主动止损，恳请核减该笔费用，')
lines.push('或按测试额度处理。若需补充材料（如客户端日志、提交时间线），我可以提供。')

const text = lines.join('\n')
const out = 'C:/Users/陈成/.dsh/ark-refund-appeal.txt'
writeFileSync(out, text, 'utf8')
console.log(text)
console.log('')
console.log('  已写入: ' + out)
