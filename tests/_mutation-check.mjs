/**
 * 变异测试（mutation testing）：证明"功能验证套件"不是假绿。
 *
 * 做法：**故意把每一处关键逻辑改坏**（当前 12 处），看验证套件会不会失败。
 * 一个测试套件如果对"故意改坏"无动于衷，那它通过就没有任何意义。
 *
 * ⚠ 已知局限（别把它当成"套件有效的证明"）：
 *   - 判据是**子进程退出码非零**，语法错 / 导入错 / 基线本来就红都会被算成"抓住"；
 *   - 它**直接改写工作区源码**（无隔离）→ 期间并发跑别的测试会看到变异体、得到伪失败；
 *   - 只覆盖被列出来的这 12 处，`tools/*`、`tasks/*`、`deliver.mjs` 等仍是零变异。
 *   收紧方案：改用 `git worktree` 隔离 + 只认"目标用例失败"（记在 README 的待办里）。
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
  // ---- 2026-10-15 第二轮：零价闸门 + 账本 schema（跑离线套件 run.mjs）----
  {
    label: '零价闸门改回"只判 null"（等于让 unitPrice:0 算出 ¥0 并放行三层闸门）',
    file: 'core/spend-guard.mjs',
    from: '  if (price === null || !Number.isFinite(price) || price <= 0) {',
    to: '  if (price === null || !Number.isFinite(price)) {',
    suite: 'run.mjs',
  },
  {
    label: 'isPriced 改回"非 null 即已计价"（等于让 0 冒充已计价、自检重新变哑）',
    file: 'core/cost.mjs',
    from: '  return priceAboveZero(unitPriceOf(entry))',
    to: '  return unitPriceOf(entry) !== null',
    suite: 'run.mjs',
  },
  {
    label: '账本 schema 撤回 null 放行（等于重新毒化领域 → 静默退回空 JSON 账本）',
    file: 'core/cost.mjs',
    from: '        unitPrice: z.number().nullable(),',
    to: '        unitPrice: z.number(),',
    suite: 'run.mjs',
  },
  {
    label: '去掉 invalidRecords 护栏（等于下一次形状漂移仍然整领域打不开）',
    file: 'core/cost.mjs',
    from: "        invalidRecords: 'backup-and-skip',\n",
    to: '',
    suite: 'run.mjs',
  },
  // ---- 2026-10-15 第三轮：本轮修复自己也要被证明"测得住" ----
  // 只加代码不加变异，等于新写的断言**可能根本没被执行到**；下面四条各自对应本轮的一个修复。
  {
    label: '账单价格列改回"只判 null"（等于让单价 0 重新显示成 ¥0.0000 = 真钱显示成免费）',
    file: 'core/cost.mjs',
    from: "  if (!priceAboveZero(price)) return '零价（无效）'",
    to: "  if (false) return '零价（无效）'",
    suite: 'run.mjs',
  },
  {
    label: '账本降级重新变回静默（等于"服务拿不到"时报表又说"没有用量记录"）',
    file: 'core/cost.mjs',
    from: '  } else {\n    // ⚠ 这一支以前是**静默**的',
    to: '  } else if (false) {\n    // ⚠ 这一支以前是**静默**的',
    suite: 'run.mjs',
  },
  {
    label: '出厂模板的 seedanceModel 改回别名（等于新装用户出片被闸门锁死）',
    file: 'cordis.patch.yml',
    from: '        seedanceModel: doubao-seedance-2-5-260628',
    to: '        seedanceModel: seedance-2.0',
    suite: 'run.mjs',
  },
  {
    label: '出厂模板漏掉一个字段（等于新装用户看不到那道花费闸门）',
    file: 'cordis.patch.yml',
    from: '        allowUnpricedSpend: false\n',
    to: '',
    suite: 'run.mjs',
  },
  {
    label: '制图闸门改回直接放行（等于把"无确认即扣费"放回来）',
    file: 'tools/qwen-draw.mjs',
    from: '        if (!verdict.ok) throw new MediaError(CODES.BAD_REQUEST, verdict.message)',
    to: '        if (false) throw new MediaError(CODES.BAD_REQUEST, verdict.message)',
    suite: 'run.mjs',
  },
  {
    label: '小额免确认改成不看金额（等于阈值成了绕过单次上限的后门）',
    file: 'core/spend-guard.mjs',
    from: '  if (noConfirmUnder !== null && estimated <= noConfirmUnder) return { ok: true }',
    to: '  if (noConfirmUnder !== null) return { ok: true }',
    suite: 'run.mjs',
  },
  {
    label: '会话花费读不到时改回 return 0（等于静默关掉会话累计上限）',
    file: 'core/tool-kit.mjs',
    from: 'export async function sessionSpentOrThrow({ getLedger, sessionId, sessionIds, providerLabel }) {',
    to: 'export async function sessionSpentOrThrow({ getLedger, sessionId, sessionIds, providerLabel }) {\n  return 0',
    suite: 'run.mjs',
  },
  // ---- 2026-10-15 第四轮：B/C（读图员的深度与"通用子代理不许自己读图"）----
  {
    label: '通用子代理的原生读图屏蔽改成"连读图员一起屏蔽"（等于把读图员弄瞎）',
    file: 'index.js',
    from: '      if (subagentVisionBlocked() && !readerRoutesUnknown && !isReader(agent)) deny.push(NATIVE_VISION_TOOL)',
    to: '      if (subagentVisionBlocked()) deny.push(NATIVE_VISION_TOOL)',
    suite: 'run.mjs',
  },
  {
    label: '原生读图兜底守卫去掉（等于重新装配丢掉掩码后，read_image 又能被主代理调用）',
    file: 'index.js',
    from: "    if (exec?.name !== NATIVE_VISION_TOOL) return undefined",
    to: "    if (exec?.name !== NATIVE_VISION_TOOL) return undefined\n    if (true) return undefined",
    suite: 'run.mjs',
  },
  {
    label: '读图员豁免名单只认写死的 id（等于自定义/改名的读图行认不出来 → 被一起屏蔽）',
    file: 'core/reader-guard.mjs',
    from: '      if (READER_ROW_IDS.includes(row.id) || handsOutImage) found.push({ file, id: row.id, block: row.block })',
    to: '      if (READER_ROW_IDS.includes(row.id)) found.push({ file, id: row.id, block: row.block })',
    suite: 'run.mjs',
  },
  {
    label: '读图行取值时不排除注释（等于把注释里的示例 maxDepth 当成真实配置 → 自检误报）',
    file: 'core/reader-guard.mjs',
    from: '    const code = stripComments(block)',
    to: '    const code = block',
    suite: 'run.mjs',
  },
  {
    label: '读图员行 maxDepth 退回 1（等于子代理调不动读图员 → C 打开后没有看图途径）',
    file: 'cordis.patch.yml',
    from: '        maxDepth: 2\n        agentOptions: { provider: glm, model: glm-4.6v }',
    to: '        maxDepth: 1\n        agentOptions: { provider: glm, model: glm-4.6v }',
    suite: 'run.mjs',
  },
  {
    label: '守卫改回只读 `exec.args`（等于让"read 读图片指路"与"委派读图审计"重新变成生产死代码）',
    file: 'index.js',
    from: '  const argsOf = (exec) => exec?.arguments ?? exec?.args',
    to: '  const argsOf = (exec) => exec?.args',
    suite: 'run.mjs',
  },
  {
    label: 'C 打开时委派审计不让位（等于把实测 6/10 的非视觉委派误伤留着）',
    file: 'index.js',
    from: '    if (subagentVisionBlocked()) return undefined\n    const text = delegationTextOf(argsOf(exec))',
    to: '    const text = delegationTextOf(argsOf(exec))',
    suite: 'run.mjs',
  },
  // ---- 2026-10-16 第五轮：读图员契约（运行时兜底 + 配置 deny）、窄委派行、报告体积 ----
  {
    label: '读图员契约守卫去掉（等于读图员又能跑 shell —— 实测它真的执行过 echo OK）',
    file: 'index.js',
    from: "    if (!isReader(exec?.agent)) return undefined // 只约束读图员，主代理/通用子代理不受影响",
    to: '    return undefined',
    suite: 'run.mjs',
  },
  {
    label: '读图员的 deny 名单被删（等于只剩 allow，实测那样会漏出 ops_bash）',
    file: 'cordis.patch.yml',
    from: '          deny: [pwsh, ops_glob, ops_grep, ops_replace, ops_inspect_local_file,\n',
    to: '          deny: [\n',
    suite: 'run.mjs',
  },
  {
    label: '窄委派行的工具面放开（等于让 subagent_code 也背 35 个工具）',
    file: 'cordis.patch.yml',
    from: '          allow: [read, edit, write, glob, grep]',
    to: '          allow: [read, edit, write, glob, grep, pwsh, workflow, web_search, web_fetch, skill, subagent_fork]',
    suite: 'run.mjs',
  },
  {
    label: 'toolFilter 里写非全局名（等于每次 spawn 抛错、读图链路整个打挂）',
    file: 'cordis.patch.yml',
    from: '          deny: [pwsh, ops_glob, ops_grep, ops_replace, ops_inspect_local_file,\n',
    to: '          deny: [ops_bash, run_code, pwsh, ops_glob, ops_grep, ops_replace, ops_inspect_local_file,\n',
    suite: 'run.mjs',
  },
  {
    label: '报告默认改回 verbose（等于把 2.1 KB 的样板重新塞进每轮上下文）',
    file: 'tools/media-report.mjs',
    from: '      const verbose = args.verbose === true',
    to: '      const verbose = true',
    suite: 'run.mjs',
  },
  // ---- 2026-10-16 第六轮：子代理生成（默认允许 + 会话树汇总）----
  {
    label: '子代理生成刹车默认生效（等于把用户明确选择的"允许子代理出图"改回禁止）',
    file: 'index.js',
    from: '    if (liveConfig?.blockSubagentSpend !== true && !(isVideo && liveConfig?.blockSubagentVideoSpend === true)) return undefined',
    to: '    // 默认允许（被变异移除）',
    suite: 'run.mjs',
  },
  {
    label: '会话累计不再覆盖会话树（等于把花费挪进子代理会话即可绕开累计上限）',
    file: 'tools/qwen-draw.mjs',
    from: '              sessionIds: deps.sessionIdsForSpend?.(sessionId),',
    to: '              sessionIds: undefined,',
    suite: 'run.mjs',
  },
  {
    label: 'cost(session) 不再汇总子代理会话（等于主代理看不见子代理花了多少）',
    file: 'tools/media-report.mjs',
    from: '            else filter.sessionIds = ids',
    to: '            else filter.sessionId = sessionId',
    suite: 'run.mjs',
  },
]

const results = []
/**
 * 「被中断也要还原」保护（2026-10-16 加）：原来只有 `finally` 里还原，
 * 进程被 Ctrl-C / 被杀时 **变异体就留在工作区**了 —— 当天真的发生过一次
 * （外面看起来像"代码突然坏了"，实际是残留的变异体，白排查了一轮）。
 * 现在额外挂 exit/SIGINT/SIGTERM，随时把当前变异体写回备份。
 */
let pendingRestore
const restoreNow = () => {
  if (pendingRestore === undefined) return
  const { path, backup } = pendingRestore
  pendingRestore = undefined
  try {
    writeFileSync(path, backup)
    process.stderr.write('\n[mutation] 已还原被中断的变异体：' + path + '\n')
  } catch {
    process.stderr.write('\n[mutation] ⚠ 还原失败，请检查：' + path + '\n')
  }
}
process.on('exit', restoreNow)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreNow()
    process.exit(1)
  })
}

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
    pendingRestore = { path, backup }
    let output = ''
    let failed = false
    try {
      // 每个变异可以指定跑哪套用例（默认"功能验证"；零价/账本 schema 那几条在 run.mjs）。
      const suite = mutation.suite ?? 'verify-functionality.mjs'
      const { stdout } = await run(NODE, ['--import', './tests/register.mjs', './tests/' + suite], { cwd: ROOT, encoding: 'utf8' })
      output = stdout
    } catch (error) {
      failed = true
      output = String(error.stdout ?? '') + String(error.stderr ?? '')
    }
    const tail = (output.match(/\[(?:功能验证|试运行结果)\] 通过 \d+，失败 \d+/) ?? ['(无结果行)']).at(-1)
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
    // ⚠ 必须清掉挂起标记：否则正常收尾时 exit 兜底又会"还原"一次（内容相同、无害，
    // 但会打出一行"已还原被中断的变异体"，看起来像出事了——2026-10-16 实际发生过）。
    pendingRestore = undefined
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
