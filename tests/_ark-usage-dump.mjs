/**
 * 逐字段 dump 一个真实任务的详情，弄清 `usage` 到底给了什么（只发 GET）。
 *
 * 为什么要做：我先前用 `usage.total_tokens × 刊例价` 推算出 ¥212.98，
 * 但用户说控制台查不到扣费——**说明我的推算口径可能不对**。
 * 在继续下结论之前，先把原始字段看清楚。
 */
import { readFileSync } from 'node:fs'

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
const items = (list.items ?? []).filter((it) => /seedance-2-/.test(it.model ?? ''))

// 取一个成功任务，完整打印
const target = items.find((it) => it.status === 'succeeded') ?? items[0]
const detail = await (await fetch(BASE + '/' + target.id, { headers })).json()
console.log('  === 完整任务详情 ===')
console.log(JSON.stringify(detail, null, 2))
console.log('')

// 对比不同时长任务的 usage，确认换算关系
console.log('  === usage 随时长变化 ===')
for (const it of items) {
  const d = await (await fetch(BASE + '/' + it.id, { headers })).json()
  if (d?.status !== 'succeeded') continue
  const u = d.usage ?? {}
  console.log(
    '   ' + String(d.model).padEnd(32) + ' dur=' + String(d.duration).padStart(2) +
      '  total=' + String(u.total_tokens ?? 0).padStart(7) +
      '  completion=' + String(u.completion_tokens ?? 0).padStart(7) +
      '  per_sec=' + (u.total_tokens === undefined ? '?' : Math.round(u.total_tokens / d.duration)),
  )
}
