/**
 * 从已完成任务的详情里读出 2.5 / 2.0-fast 的真实参数约定（只发 GET）。
 *
 * 为什么这样做：POST 探测会创建任务（我为此付了 ¥259 的学费）。
 * 而**已完成任务的详情**本身就记录了实际生效的参数——同样的信息，零风险。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BACKUP = join(homedir(), '.dsh', '.env.bak-arkremove-20261015-135621')
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

/** 收集每个模型实际用到的 duration / resolution / ratio 组合。 */
const seen = new Map()
for (const it of items) {
  const d = await (await fetch(BASE + '/' + it.id, { headers })).json()
  const key2 = d?.model ?? it.model
  if (!seen.has(key2)) seen.set(key2, { durations: new Set(), resolutions: new Set(), ratios: new Set(), keys: Object.keys(d ?? {}) })
  const e = seen.get(key2)
  if (d?.duration !== undefined) e.durations.add(d.duration)
  if (d?.resolution !== undefined) e.resolutions.add(d.resolution)
  if (d?.ratio !== undefined) e.ratios.add(d.ratio)
}

for (const [model, e] of seen) {
  console.log('  ' + model)
  console.log('    实际用过的 duration : ' + [...e.durations].sort((a, b) => a - b).join(', '))
  console.log('    实际用过的 resolution: ' + ([...e.resolutions].join(', ') || '（未回传，走默认）'))
  console.log('    实际用过的 ratio    : ' + ([...e.ratios].join(', ') || '（未回传，走默认）'))
  console.log('    详情字段            : ' + e.keys.join(', '))
}
