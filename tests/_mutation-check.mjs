/**
 * 变异测试（mutation testing）：证明"功能验证套件"不是假绿。
 *
 * 做法：**故意把两处优化改坏**，看验证套件会不会失败。
 * 一个测试套件如果对"故意改坏"无动于衷，那它通过就没有任何意义。
 *
 * 安全：每个变异都先备份文件，跑完立刻还原（finally），并在结束时校验文件字节完全一致。
 *
 * 运行：node tests/_mutation-check.mjs
 */
import { execFile } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const NODE = process.execPath
// ⚠ 必须用 fileURLToPath：工作区路径里有空格，URL.pathname 会留下 %20。
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const MUTATIONS = [
  {
    label: '签名恒定（等于取消短路判据 → 稳态每 tick 全量重算）',
    file: 'core/tool-kit.mjs',
    from: "signature: () => TOOL_SWITCHES.map((entry) => (isEnabled(entry.tool) ? '1' : '0')).join(','),",
    to: "signature: () => 'constant',",
  },
  {
    label: '签名单调（等于"改一个开关，其它开关的变更被吞掉"）',
    file: 'core/tool-kit.mjs',
    from: "signature: () => TOOL_SWITCHES.map((entry) => (isEnabled(entry.tool) ? '1' : '0')).join(','),",
    to: "signature: () => (isEnabled('qwen_draw') ? 'on' : 'off'),",
  },
  {
    label: '读图守卫丢掉"只看图"契约判定（等于把图片路径守卫的指路拆掉）',
    file: 'index.js',
    from: "    if (target === undefined || !IMAGE_PATH_RE.test(target)) return undefined",
    to: '    if (target === undefined) return undefined',
    expectFail: '⑤',
  },
  {
    label: '未计价闸门改回"自报金额即放行"（等于把上一轮修的洞放回来）',
    file: 'core/spend-guard.mjs',
    from: '    if (config?.allowUnpricedSpend !== true) {',
    to: '    if (typeof confirmed?.confirm_estimate === "number") return { ok: true }\n    if (config?.allowUnpricedSpend !== true) {',
  },
]

const results = []
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  const backup = original
  const mutated = original.replace(mutation.from, mutation.to)
  if (mutated === original) {
    results.push({ label: mutation.label, status: '注入失败（锚点没匹配上）' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    let output = ''
    let failed = false
    try {
      const { stdout } = await run(NODE, ['--import', './tests/register.mjs', './tests/verify-functionality.mjs'], { cwd: ROOT, encoding: 'utf8' })
      output = stdout
    } catch (error) {
      failed = true
      output = String(error.stdout ?? '') + String(error.stderr ?? '')
    }
    const tail = (output.match(/\[功能验证\] 通过 \d+，失败 \d+/) ?? ['(无结果行)']).at(-1)
    const failedCases = [...output.matchAll(/✗ (.+)/g)].map((match) => match[1].trim())
    results.push({
      label: mutation.label,
      status: failed ? '✅ 被抓住（套件失败）' : '❌ 漏网（套件仍全绿）',
      tail,
      failedCases,
    })
  } finally {
    writeFileSync(path, backup)
    // 还原校验：字节必须完全一致
    if (readFileSync(path, 'utf8') !== backup) throw new Error('还原失败：' + path)
  }
}

console.log('变异测试：故意改坏 → 看验证套件是否抓住\n')
for (const result of results) {
  console.log('· ' + result.label)
  console.log('    ' + result.status + (result.tail === undefined ? '' : '  ' + result.tail))
  for (const name of result.failedCases ?? []) console.log('      └ 抓到：' + name)
  console.log('')
}
const caught = results.filter((result) => result.status.startsWith('✅')).length
console.log(`合计：注入 ${MUTATIONS.length} 个变异，抓到 ${caught} 个，漏网 ${MUTATIONS.length - caught} 个。`)
process.exit(caught === MUTATIONS.length ? 0 : 1)
