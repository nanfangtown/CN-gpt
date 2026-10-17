/**
 * 只读检查：误创建的那些 seedance 2.x 任务现在究竟什么状态。
 *
 * ⚠ 严格只读：**只发 GET**，绝不 POST。这个脚本的存在意义之一就是证明
 * "检查状态"和"创建任务"可以完全分开（我用 POST 探测参数那次就是因为没做这个区分）。
 *
 * key 从备份文件读取（当前 .env 已被摘除以止血）。
 * 用法：node --import ./tests/register.mjs tests/_check-ark-tasks.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BACKUP = join(homedir(), '.dsh', '.env.bak-arkremove-20261015-135621')
const BASE = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks'

let key
try {
  key = readFileSync(BACKUP, 'utf8').match(/^ARK_API_KEY=(.+)$/m)?.[1]?.trim()
} catch {
  // 备份不可读时，回落到当前环境（若已恢复 key）
}
key = key ?? process.env.ARK_API_KEY
if (key === undefined || key.length === 0) {
  console.log('  ⛔ 拿不到 key（备份和环境都没有）')
  process.exit(0)
}

const res = await fetch(BASE + '?page_size=50', { headers: { Authorization: 'Bearer ' + key } })
console.log('  只读查询 HTTP ' + res.status)
const text = await res.text()
if (res.status !== 200) {
  console.log('  响应: ' + text.replace(/\s+/g, ' ').slice(0, 220))
  console.log('')
  console.log('  → 非 200 说明 key 已失效/被禁用，无法再查询任务状态。')
  process.exit(0)
}

const json = JSON.parse(text)
const mine = (json.items ?? []).filter((it) => /seedance-2-/.test(it.model ?? ''))
const by = new Map()
for (const it of mine) {
  const k = (it.model ?? '?') + ' | ' + (it.status ?? '?')
  by.set(k, (by.get(k) ?? 0) + 1)
}
console.log('  我误创建的 2.x 任务共 ' + mine.length + ' 个：')
for (const [k, v] of [...by.entries()].sort()) console.log('   ' + String(v).padStart(3) + '  ' + k)
