/**
 * 紧急移除 ARK_API_KEY（2026-10-15，用户要求立即止血）。
 *
 * 为什么写成脚本而不是手改：涉及两个文件、两种格式（`.env` 是 KEY=VALUE，
 * `.credentials.yaml` 是 YAML），手改容易改坏或漏改；写成脚本可以：
 *   1. **先备份**再改（可一键恢复）；
 *   2. **改完自检**——确认所有解析路径都读不到 key 了；
 *   3. 幂等：重复跑不会二次破坏。
 *
 * 用法：
 *   node tests/_remove-ark-key.mjs --dry-run     # 只看会改什么
 *   node tests/_remove-ark-key.mjs --apply       # 真改（自动备份）
 *   node tests/_remove-ark-key.mjs --restore <备份时间戳>   # 恢复
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH = join(homedir(), '.dsh')
const ENV_FILE = join(DSH, '.env')
const CRED_FILE = join(DSH, '.credentials.yaml')
const KEY = 'ARK_API_KEY'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run') || argv.length === 0
const apply = argv.includes('--apply')
const restoreIndex = argv.indexOf('--restore')

/** 生成时间戳，形如 20261015-135608。 */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

if (restoreIndex >= 0) {
  const tag = argv[restoreIndex + 1]
  if (tag === undefined) {
    console.log('  用法: --restore <时间戳>，例如 --restore 20261015-135608')
    process.exit(1)
  }
  let restored = 0
  for (const [target, src] of [
    [ENV_FILE, `${ENV_FILE}.bak-arkremove-${tag}`],
    [CRED_FILE, `${CRED_FILE}.bak-arkremove-${tag}`],
  ]) {
    if (!existsSync(src)) {
      console.log('  ⚠ 找不到备份: ' + src)
      continue
    }
    copyFileSync(src, target)
    console.log('  已恢复 ' + target)
    restored += 1
  }
  console.log('  共恢复 ' + restored + ' 个文件。**key 重新可用**，请确认这是你要的。')
  process.exit(0)
}

/**
 * 从 `.env` 文本里移除指定 key 的行（含注释掉的）。
 * @param {string} text - 原文。
 * @returns {{ text: string, removed: number }}
 */
function stripEnv(text) {
  const lines = text.split('\n')
  const kept = lines.filter((line) => !new RegExp('^\\s*' + KEY + '\\s*=').test(line))
  return { text: kept.join('\n'), removed: lines.length - kept.length }
}

/**
 * 从 `.credentials.yaml` 文本里移除 ARK 相关条目。
 *
 * 该文件的形状是：
 *   version: 1
 *   refs:
 *     DASHSCOPE_API_KEY: ...
 *     ARK_API_KEY: ...
 * 所以只删"缩进 + ARK_API_KEY:"那一行，**不碰其它 key**。
 * @param {string} text - 原文。
 * @returns {{ text: string, removed: number }}
 */
function stripCredentials(text) {
  const lines = text.split('\n')
  const kept = lines.filter((line) => !new RegExp('^\\s+' + KEY + '\\s*:').test(line))
  return { text: kept.join('\n'), removed: lines.length - kept.length }
}

const plan = []
if (existsSync(ENV_FILE)) {
  const before = readFileSync(ENV_FILE, 'utf8')
  const { text, removed } = stripEnv(before)
  plan.push({ file: ENV_FILE, text, removed, backup: `${ENV_FILE}.bak-arkremove-${stamp()}` })
}
if (existsSync(CRED_FILE)) {
  const before = readFileSync(CRED_FILE, 'utf8')
  const { text, removed } = stripCredentials(before)
  plan.push({ file: CRED_FILE, text, removed, backup: `${CRED_FILE}.bak-arkremove-${stamp()}` })
}

console.log('  计划修改:')
for (const p of plan) console.log('   ' + (p.removed > 0 ? '会删 ' + p.removed + ' 行' : '无需修改') + '  ' + p.file)

if (!apply) {
  console.log('')
  console.log('  这是预演（--dry-run）。确认无误后加 --apply 执行。')
  process.exit(0)
}

for (const p of plan) {
  if (p.removed === 0) continue
  copyFileSync(p.file, p.backup)
  writeFileSync(p.file, p.text)
  console.log('  已改 ' + p.file + '（备份 ' + p.backup + '）')
}

// 自检：确认所有解析路径都读不到 ARK key
console.log('')
console.log('  自检（应全部为"读不到"）:')
process.env.DSH_HOME = DSH
const { createKeyResolver, keySpec } = await import('../core/keys.mjs')
const resolver = createKeyResolver({}, {
  arkApiKey: null,
  arkApiKeyEnv: KEY,
  zhipuApiKey: null, zhipuApiKeyEnv: 'ZHIPU_API_KEY',
  dashscopeApiKey: null, dashscopeApiKeyEnv: 'DASHSCOPE_API_KEY',
})
const ark = await resolver.resolve(keySpec('ark'))
console.log('   ark 解析结果: ' + (ark === undefined ? '✅ 读不到（已摘除）' : '❌ 仍能读到，来源=' + ark.source))
const zhipu = await resolver.resolve(keySpec('zhipu'))
console.log('   zhipu 解析结果: ' + (zhipu === undefined ? '⚠ 也读不到（你可能还没配）' : '✅ 仍可用，来源=' + zhipu.source))
