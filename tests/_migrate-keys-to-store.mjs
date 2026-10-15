/**
 * 一次性维护脚本：把 `~/.dsh/.env` 里已配置的 key 登记进官方凭据文件
 * （`<harness home>/.credentials.yaml` 的 `refs:` 段）。
 *
 * 为什么需要它（2026-10-13）：
 *   DSH 官方凭据服务的可见层是「启动环境 > 凭据文件 > 项目 .env > ~/.dsh/.env」，
 *   它的 `describe` **看不到 harness 启动后由 .env 注入进程环境的那一层**。
 *   而本插件的解析器直接读 `process.env`，所以会出现：
 *       插件实际能解析（key 正常工作）  vs  卡片显示「未配置」
 *   这个脚本把 .env 里的值**复制一份**进凭据文件，让官方服务的认知与实际情况一致。
 *
 * 安全性：
 *   - **不删除、不修改 .env**（用户明确选择保留）；
 *   - 写入前备份凭据文件为 `.credentials.yaml.bak-<时间戳>`；
 *   - 两处都有值时**不覆盖**凭据文件里的值（那是更权威的一层）；
 *   - 默认干跑（--apply 才真写）。
 *
 * 用法：
 *   node tests/_migrate-keys-to-store.mjs            # 干跑，只打印计划
 *   node tests/_migrate-keys-to-store.mjs --apply    # 实际写入
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnvFile } from './_env.mjs'

/** 要迁移的引用名。 */
const REFS = ['DASHSCOPE_API_KEY', 'ARK_API_KEY', 'ZHIPU_API_KEY']

const apply = process.argv.includes('--apply')
const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const envPath = join(home, '.env')
const storePath = join(home, '.credentials.yaml')

const mask = (value) => (value.length <= 8 ? '***' : value.slice(0, 4) + '…' + value.slice(-3) + ' [' + value.length + ']')

// ---- 读 .env ----
let env = {}
try {
  env = parseEnvFile(readFileSync(envPath, 'utf8'))
} catch (error) {
  console.error('读不到 ' + envPath + '：' + String(error?.message ?? error))
  process.exit(1)
}

// ---- 读凭据文件，取出 refs（极简解析：只认顶层 refs: 段的两空格缩进项）----
let storeText = ''
try {
  storeText = readFileSync(storePath, 'utf8')
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.error('读不到 ' + storePath + '：' + String(error?.message ?? error))
    process.exit(1)
  }
}
const existingRefs = {}
{
  const lines = storeText.split(/\r?\n/)
  const start = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^\S/.test(line) && line.trim().length > 0) break // 下一段
      const m = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (m !== null && m[2].trim().length > 0) existingRefs[m[1]] = m[2].trim()
    }
  }
}

// ---- 计划 ----
const plan = []
for (const ref of REFS) {
  const fromEnv = (env[ref] ?? '').trim()
  const inStore = (existingRefs[ref] ?? '').length > 0
  if (fromEnv.length === 0 && !inStore) {
    plan.push({ ref, action: 'skip', why: '.env 与凭据文件里都没有' })
    continue
  }
  if (inStore) {
    plan.push({ ref, action: 'keep', why: '凭据文件里已有（更权威，不覆盖）' })
    continue
  }
  plan.push({ ref, action: 'add', why: '.env → 凭据文件', value: fromEnv, masked: mask(fromEnv) })
}

console.log('# 把 .env 里的 key 登记进官方凭据文件')
console.log('  .env       : ' + envPath)
console.log('  凭据文件   : ' + storePath)
console.log('  模式       : ' + (apply ? '实际写入' : '干跑（加 --apply 才写）'))
console.log('')
for (const item of plan) {
  console.log('  [' + item.action + '] ' + item.ref.padEnd(20) + (item.masked ? item.masked + '  ' : '') + item.why)
}

const toAdd = plan.filter((item) => item.action === 'add')
if (toAdd.length === 0) {
  console.log('')
  console.log('无需写入：' + (plan.every((i) => i.action === 'keep') ? '凭据文件里都已存在' : '没有可迁移的值'))
  process.exit(0)
}
if (!apply) {
  console.log('')
  console.log('干跑结束。确认无误后执行：node tests/_migrate-keys-to-store.mjs --apply')
  process.exit(0)
}

// ---- 写入：在 refs: 段插入/新建，保留 records 段原样 ----
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
if (storeText.length > 0) {
  copyFileSync(storePath, storePath + '.bak-' + stamp)
  console.log('')
  console.log('已备份：' + storePath + '.bak-' + stamp)
}

const additions = toAdd.map((item) => '  ' + item.ref + ': ' + JSON.stringify(item.value))
let next
if (/^refs:\s*$/m.test(storeText)) {
  // 已有 refs: 段 → 插到它开头
  next = storeText.replace(/^refs:\s*$/m, ['refs:', ...additions].join('\n'))
} else if (storeText.trim().length === 0) {
  next = ['version: 1', '', 'refs:', ...additions, ''].join('\n')
} else {
  // 没有 refs: 段 → 插到 version 行之后（保持 records 段不动）
  next = storeText.replace(/^(version:\s*\d+\s*)$/m, ['$1', '', 'refs:', ...additions].join('\n'))
  if (next === storeText) next = ['version: 1', '', 'refs:', ...additions, '', storeText.trimStart()].join('\n')
}
if (!next.endsWith('\n')) next += '\n'
writeFileSync(storePath, next, { mode: 0o600 })
console.log('已写入 ' + toAdd.length + ' 条 refs（文件权限 600）')
console.log('')
console.log('下一步：')
console.log('  - 凭据文件 watch=true，官方服务会自动重载，无需重启；')
console.log('  - 回滚：把 .bak-<时间戳> 覆盖回去即可；')
console.log('  - .env 未做任何修改（旧值保留，凭据文件会压过它）。')
