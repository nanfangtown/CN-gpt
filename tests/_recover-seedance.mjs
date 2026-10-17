/**
 * 取回已付费的 seedance 2.x 产物（2026-10-15）。
 *
 * 背景：我为探测 duration 取值域而误创建了 22 个视频任务（约 ¥259），
 * 全部已在服务端跑完、费用已发生。既然钱花了，产物就不该丢。
 *
 * ⚠ 严格只读：只发 **GET**（列表 / 详情 / 下载产物 URL），**绝不 POST**。
 * key 从止血时的备份读取，因此**不需要恢复 .env 里的 key**。
 *
 * 用法：node --import ./tests/register.mjs tests/_recover-seedance.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BACKUP = join(homedir(), '.dsh', '.env.bak-arkremove-20261015-135621')
const BASE = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks'
const OUT = join(process.cwd(), '_sandbox', 'video', 'recovered')

let key
try {
  key = readFileSync(BACKUP, 'utf8').match(/^ARK_API_KEY=(.+)$/m)?.[1]?.trim()
} catch {
  // 备份不可读时回落环境
}
key = key ?? process.env.ARK_API_KEY
if (key === undefined || key.length === 0) {
  console.log('  ⛔ 拿不到 key')
  process.exit(1)
}

const headers = { Authorization: 'Bearer ' + key }
const list = await (await fetch(BASE + '?page_size=50', { headers })).json()
const items = (list.items ?? []).filter((it) => /seedance-2-/.test(it.model ?? ''))
console.log('  待取回任务: ' + items.length)

await mkdir(OUT, { recursive: true })
let saved = 0
let bytes = 0
for (const it of items) {
  const detail = await (await fetch(BASE + '/' + it.id, { headers })).json()
  if ((detail?.status ?? '') !== 'succeeded') {
    console.log('  ⏭ ' + it.id + '  ' + (detail?.status ?? '?') + '（非成功，跳过）')
    continue
  }
  const url = detail?.content?.video_url ?? detail?.video_url
  if (typeof url !== 'string' || url.length === 0) {
    console.log('  ⚠ ' + it.id + ' 成功但没有 video_url')
    continue
  }
  try {
    const res = await fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(join(OUT, it.id + '.mp4'), buf)
    bytes += buf.length
    saved += 1
    console.log('  ✅ ' + it.id + '  ' + it.model + '  ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB')
  } catch (error) {
    console.log('  ⚠ ' + it.id + ' 下载失败: ' + String(error?.message ?? error).slice(0, 70))
  }
}

console.log('')
console.log('  已取回: ' + saved + ' 个，合计 ' + (bytes / 1024 / 1024).toFixed(1) + ' MB')
console.log('  目录: ' + OUT)
