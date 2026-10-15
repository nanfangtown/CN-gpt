/**
 * 读一个 DSH 会话日志（.jsonl / .jsonl.zstd），打印事件类型统计与关键事件。
 * 用于人工核查"某个真实会话里到底发生了什么"。
 *
 * 用法：node tests/_read-session.mjs <sessionDir|logFile> [关键词...]
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

async function load(path) {
  const buffer = await readFile(path)
  if (path.endsWith('.zstd')) {
    try {
      return zstdDecompressSync(buffer).toString('utf8')
    } catch (error) {
      return '<<zstd 解压失败: ' + error.message + '>>'
    }
  }
  return buffer.toString('utf8')
}

async function findLogs(dir) {
  const out = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/session.*\.jsonl/.test(entry.name)) out.push(path)
    }
  }
  const info = await stat(dir)
  if (info.isFile()) return [dir]
  await walk(dir)
  return out
}

const target = process.argv[2]
if (target === undefined || !existsSync(target)) {
  console.error('用法：node tests/_read-session.mjs <sessionDir|logFile> [关键词...]')
  process.exit(2)
}
const keywords = process.argv.slice(3)
const logs = await findLogs(target)

for (const log of logs) {
  const text = await load(log)
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  console.log('=== ' + log)
  console.log('行数：' + lines.length + '，字节：' + text.length)
  const types = new Map()
  for (const line of lines) {
    const match = /"type"\s*:\s*"([^"]+)"/.exec(line)
    const type = match === null ? '(no type)' : match[1]
    types.set(type, (types.get(type) ?? 0) + 1)
  }
  console.log('事件类型：' + [...types.entries()].map(([k, v]) => k + '×' + v).join(', '))
  if (keywords.length > 0) {
    console.log('--- 命中关键词的行（截断 400 字符）---')
    for (const line of lines) {
      if (keywords.some((word) => line.includes(word))) console.log('  > ' + line.slice(0, 400))
    }
  }
  console.log()
}
