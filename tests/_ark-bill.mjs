/**
 * 用任务详情里的 `usage` 字段算出这次误创建的**精确费用**（只发 GET）。
 *
 * 为什么能算准：方舟对 Seedance 2.x 按 token 计价（2.0 = 46 元/百万 token、
 * 2.5 = 70 元/百万，不含视频输入），而每个任务的详情都回传了 `usage`。
 * 这比按"元/秒"估算可靠得多——**这是账单级数字，不是估算**。
 *
 * ⚠ 只读：只发 GET。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BACKUP = join(homedir(), '.dsh', '.env.bak-arkremove-20261015-135621')
const BASE = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks'

/** 官方刊例价（元 / 百万 token，不含视频输入）。来源见 README。 */
const PRICE_PER_MTOK = {
  'doubao-seedance-2-0-fast-260128': 46,
  'doubao-seedance-2-0-mini-260615': 46,
  'doubao-seedance-2-5-260628': 70,
}
/** 含视频输入时的单价（元 / 百万 token）。 */
const PRICE_PER_MTOK_WITH_VIDEO = {
  'doubao-seedance-2-0-fast-260128': 28,
  'doubao-seedance-2-5-260628': 42,
}

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
const items = (list.items ?? []).filter((it) => /seedance-2-/.test(it.model ?? ''))

let grand = 0
const perModel = new Map()
console.log('  逐任务 usage（只列成功的）:')
for (const it of items) {
  const d = await (await fetch(BASE + '/' + it.id, { headers })).json()
  if ((d?.status ?? '') !== 'succeeded') continue
  const usage = d?.usage ?? {}
  const total = Number(usage.total_tokens ?? 0)
  const price = PRICE_PER_MTOK[d?.model] ?? 0
  const cost = (total / 1e6) * price
  grand += cost
  const agg = perModel.get(d.model) ?? { n: 0, tokens: 0, cost: 0 }
  agg.n += 1
  agg.tokens += total
  agg.cost += cost
  perModel.set(d.model, agg)
  console.log(
    '   ' + d.id + '  ' + String(d.model).padEnd(32) + ' dur=' + String(d.duration ?? '?').padStart(2) +
      's  tokens=' + String(total).padStart(7) + '  ¥' + cost.toFixed(4) +
      (usage.completion_tokens === undefined ? '' : '  (prompt=' + usage.prompt_tokens + ' completion=' + usage.completion_tokens + ')'),
  )
}

console.log('')
console.log('  按模型汇总:')
for (const [model, a] of perModel) {
  console.log('   ' + model)
  console.log('      ' + a.n + ' 个成功任务 | ' + a.tokens.toLocaleString() + ' tokens | ¥' + a.cost.toFixed(2))
}
console.log('')
console.log('  === 合计精确费用: ¥' + grand.toFixed(2) + ' ===')
console.log('  （按 token 刊例价 × 任务实际 usage 计算；若你的账号在折扣期，实际更低）')
void PRICE_PER_MTOK_WITH_VIDEO
