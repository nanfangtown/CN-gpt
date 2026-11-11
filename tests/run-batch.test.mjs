/**
 * run_batch 验收（2026-11-10）。
 *
 * 边界：**不联网、不花钱**；只在本机临时目录里跑 node 脚本。
 * 覆盖：串行顺序 / 退出码保留 / stop_on_error / 超时杀进程树 / 大输出截断+落盘 /
 *       cwd 解析 / 空数组拒绝 / 超上限点名拒绝 / 开关关闭时拒付。
 *
 * 运行：node --import ./tests/register.mjs ./tests/run-batch.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRunBatchTool, runSharedBatch } from '../tools/run-batch.mjs'
import { CODES } from '../core/errors.mjs'

const stats = { passed: 0, failed: 0 }
async function test(name, fn) {
  try {
    await fn()
    stats.passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    stats.failed += 1
    console.log('  ✗ ' + name)
    console.log('    ' + String(error?.stack ?? error).split('\n').slice(0, 5).join('\n    '))
  }
}

/** 本机 node 绝对路径（命令里不依赖 PATH）。 */
const NODE = process.execPath

/**
 * 写一个临时脚本，返回"在 PowerShell / bash 里都能直接跑"的命令串。
 * 走脚本文件而不是 `node -e`，避免测试自己陷进引号转义。
 * @param {string} dir - 目录。
 * @param {string} name - 文件名。
 * @param {string} code - 脚本内容。
 * @returns {Promise<string>} 可直接交给 run_batch 的命令。
 */
async function scriptCommand(dir, name, code) {
  const file = join(dir, name + '.mjs')
  await writeFile(file, code, 'utf8')
  return process.platform === 'win32'
    ? '& "' + NODE + '" "' + file + '"'
    : '"' + NODE + '" "' + file + '"'
}

async function makeCase(configOverrides = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'mm-run-batch-'))
  await mkdir(join(tmp, 'gen'), { recursive: true })
  const config = {
    enableRunBatch: true,
    batchMaxCommands: 20,
    batchCommandTimeoutMs: 10000,
    outDir: 'gen',
    // 生产默认是 shared（2026-11-11 第二轮）。这里显式钉成 isolated，让"不关心模式"的用例
    // 继续测每条一个干净进程的语义；shared 的行为由 sharedCase 覆盖，默认值另有专门用例。
    batchShellMode: 'isolated',
    ...configOverrides,
  }
  const tool = createRunBatchTool({ config, logger: { debug() {} } })
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  return { tmp, tool, exec }
}

/** 断言抛出的 MediaError 带指定 code。 */
async function expectCode(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.equal(error?.code, code, '期望错误码 ' + code + '，实际 ' + error?.code + '：' + error?.message)
    return
  }
  assert.fail('应该抛错（' + code + '），但调用成功了')
}

console.log('[run_batch 验收]')

await test('单条成功：退出码 0、计数正确、日志落盘', async () => {
  const { tmp, tool, exec } = await makeCase()
  const cmd = await scriptCommand(tmp, 'ok', 'console.log("hello-run-batch")')
  const value = await tool.execute({ commands: [cmd] }, exec)
  assert.equal(value.total, 1)
  assert.equal(value.passed, 1)
  assert.equal(value.failed, 0)
  assert.equal(value.results[0].exitCode, 0)
  assert.ok(value.logDir.length > 0, '必须返回日志目录')
  const dir = join(tmp, 'gen', 'batch')
  const days = await readdir(dir)
  assert.equal(days.length, 1, '应生成一个批次目录')
  const files = (await readdir(join(dir, days[0]))).filter((name) => name.endsWith('.log'))
  assert.equal(files.length, 1, '每条命令一个日志文件')
  const log = await readFile(join(dir, days[0], files[0]), 'utf8')
  assert.ok(log.includes('hello-run-batch'), '日志里要有完整输出：' + log.slice(0, 200))
  // 2026-11-10：成功命令也要回输出尾巴 —— 否则"通过数/失败数"这类结论只能再去读日志。
  assert.ok(String(value.results[0].tail ?? '').includes('hello-run-batch'), '成功命令必须带 tail：' + value.results[0].tail)
  assert.equal(value.results[0].tailComplete, true, '短输出必须标记为完整')
  const rendered = tool.output.render({}, value)[0].text
  assert.ok(rendered.includes('hello-run-batch'), '渲染表里要能直接看到尾巴：' + rendered)
  assert.ok(rendered.includes('完整输出'), '短输出的尾巴要标注“完整”，省掉二次取证：' + rendered)
})

await test('多条命令按顺序串行执行', async () => {
  const { tmp, tool, exec } = await makeCase()
  const a = await scriptCommand(tmp, 'a', 'console.log("A")')
  const b = await scriptCommand(tmp, 'b', 'console.log("B")')
  const value = await tool.execute({ commands: [a, b] }, exec)
  assert.equal(value.total, 2)
  assert.deepEqual(value.results.map((item) => item.index), [1, 2])
  assert.ok(value.results[0].logPath.length > 0 && value.results[1].logPath.length > 0)
})

await test('失败码被保留（不吞成 1）', async () => {
  const { tmp, tool, exec } = await makeCase()
  const cmd = await scriptCommand(tmp, 'fail3', 'process.exit(3)')
  const value = await tool.execute({ commands: [cmd] }, exec)
  assert.equal(value.failed, 1)
  assert.equal(value.results[0].exitCode, 3, '退出码必须原样保留')
})

await test('stop_on_error=true 时遇错即停', async () => {
  const { tmp, tool, exec } = await makeCase()
  const bad = await scriptCommand(tmp, 'bad', 'process.exit(1)')
  const good = await scriptCommand(tmp, 'good', 'console.log("never")')
  const value = await tool.execute({ commands: [bad, good], stop_on_error: true }, exec)
  assert.equal(value.total, 1, '第一条失败后不应再跑第二条')
  assert.equal(value.failed, 1)
})

await test('超时：杀掉进程树并标记 timedOut', async () => {
  const { tmp, tool, exec } = await makeCase({ batchCommandTimeoutMs: 5000 })
  const cmd = await scriptCommand(tmp, 'slow', 'setTimeout(() => {}, 30000)')
  const started = Date.now()
  const value = await tool.execute({ commands: [cmd], timeout_ms: 1000 }, exec)
  assert.ok(Date.now() - started < 15000, '不应等到脚本自然结束')
  assert.equal(value.timedOut, 1)
  assert.equal(value.results[0].timedOut, true)
  assert.notEqual(value.results[0].exitCode, 0)
})

await test('大输出：回给模型的是摘要，完整内容在日志里', async () => {
  const { tmp, tool, exec } = await makeCase()
  const cmd = await scriptCommand(tmp, 'big', 'console.log("x".repeat(20000)); process.exit(2)')
  const value = await tool.execute({ commands: [cmd] }, exec)
  assert.equal(value.failed, 1)
  const detail = value.results[0].detail ?? ''
  assert.ok(detail.length <= 600, '失败摘要必须截断（实际 ' + detail.length + ' 字符）')
  const rendered = tool.output.render({}, value)[0].text
  assert.ok(rendered.length < 3000, '渲染结果不能把 2 万字符灌回上下文：' + rendered.length)
})

await test('cwd 生效：命令在会话目录里跑', async () => {
  const { tmp, tool, exec } = await makeCase()
  const cmd = await scriptCommand(tmp, 'pwd', 'console.log(process.cwd())')
  await tool.execute({ commands: [cmd] }, exec)
  const days = await readdir(join(tmp, 'gen', 'batch'))
  const files = await readdir(join(tmp, 'gen', 'batch', days[0]))
  const log = await readFile(join(tmp, 'gen', 'batch', days[0], files[0]), 'utf8')
  assert.ok(log.toLowerCase().includes(tmp.toLowerCase().slice(0, 8)), '输出里应包含会话目录：' + log.slice(0, 200))
})

await test('不把密钥类环境变量带进子进程（与原生 shell 一致）', async () => {
  const { tmp, tool, exec } = await makeCase()
  process.env.MM_UNIT_TEST_API_KEY = 'should-not-leak'
  try {
    const cmd = await scriptCommand(tmp, 'env', 'console.log(process.env.MM_UNIT_TEST_API_KEY ?? "ABSENT")')
    await tool.execute({ commands: [cmd] }, exec)
  } finally {
    delete process.env.MM_UNIT_TEST_API_KEY
  }
  const days = await readdir(join(tmp, 'gen', 'batch'))
  const files = await readdir(join(tmp, 'gen', 'batch', days[0]))
  const log = await readFile(join(tmp, 'gen', 'batch', days[0], files.find((name) => name.endsWith('.log'))), 'utf8')
  assert.ok(log.includes('ABSENT'), '密钥类环境变量必须被剔除：' + log.slice(0, 200))
  assert.ok(!log.includes('should-not-leak'), '不得把密钥值写进日志：' + log.slice(0, 200))
})

await test('并行：3 条各 600ms 的命令总耗时明显短于串行，且顺序保持', async () => {
  const { tmp, tool, exec } = await makeCase()
  const a = await scriptCommand(tmp, 'p1', 'setTimeout(() => {}, 600)')
  const b = await scriptCommand(tmp, 'p2', 'setTimeout(() => {}, 600)')
  const c = await scriptCommand(tmp, 'p3', 'setTimeout(() => {}, 600)')
  const started = Date.now()
  const value = await tool.execute({ commands: [a, b, c], parallel: true }, exec)
  const wall = Date.now() - started
  assert.equal(value.parallel, true)
  assert.equal(value.passed, 3)
  assert.ok(wall < 1600, '并行应明显快于 1800ms 串行（实际 ' + wall + ' ms）')
  assert.deepEqual(value.results.map((item) => item.command), [a, b, c], '结果顺序必须与输入一致')
  assert.deepEqual(value.results.map((item) => item.index), [1, 2, 3])
})

await test('parallel 与 stop_on_error 互斥 → BAD_REQUEST', async () => {
  const { tmp, tool, exec } = await makeCase()
  const cmd = await scriptCommand(tmp, 'x', 'console.log(1)')
  await expectCode(tool.execute({ commands: [cmd], parallel: true, stop_on_error: true }, exec), CODES.BAD_REQUEST)
})

await test('script 模式：读 package.json，按 && 拆条执行', async () => {
  const { tmp, tool, exec } = await makeCase()
  const a = await scriptCommand(tmp, 's1', 'console.log("A")')
  const b = await scriptCommand(tmp, 's2', 'console.log("B")')
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: a + ' && ' + b, unit: a } }), 'utf8')
  const value = await tool.execute({ script: 'test' }, exec)
  assert.equal(value.script, 'test')
  assert.equal(value.total, 2, '应拆成两条命令')
  assert.equal(value.passed, 2)
  assert.ok(tool.output.render({}, value)[0].text.includes('脚本：test'))
})

await test('script 模式：npm run 引用会递归展开', async () => {
  const { tmp, tool, exec } = await makeCase()
  const a = await scriptCommand(tmp, 'n1', 'console.log("N")')
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'x', scripts: { unit: a, chain: 'npm run unit' } }), 'utf8')
  const value = await tool.execute({ script: 'chain' }, exec)
  assert.equal(value.total, 1)
  assert.equal(value.passed, 1)
  assert.ok(value.results[0].command.includes('n1'), '应展开成 unit 的命令：' + value.results[0].command)
})

await test('script 模式：脚本不存在 / 与 commands 同时给 → BAD_REQUEST', async () => {
  const { tmp, tool, exec } = await makeCase()
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'echo hi' } }), 'utf8')
  await expectCode(tool.execute({ script: 'nope' }, exec), CODES.BAD_REQUEST)
  await expectCode(tool.execute({ script: 'test', commands: ['echo hi'] }, exec), CODES.BAD_REQUEST)
  await expectCode(tool.execute({}, exec), CODES.BAD_REQUEST)
})

await test('不存在的命令 → 非零退出码（不能假绿）', async () => {
  // 2026-11-11 实测：`npm test`（本机没有 npm）曾返回 exit 0，因为 PowerShell 的
  // $LASTEXITCODE 在"命令不存在"时仍是 0。这个用例钉住"语句失败必须报失败"。
  const { tmp, tool, exec } = await makeCase()
  const value = await tool.execute({ commands: ['dsh-definitely-not-a-command-xyz'] }, exec)
  assert.equal(value.failed, 1, '不存在的命令必须算失败')
  assert.notEqual(value.results[0].exitCode, 0, '退出码不能是 0：' + value.results[0].exitCode)
})

await test('孙进程占着输出管道时，命令仍按时返回（GUI / 分离进程）', async () => {
  // 2026-11-11 事故：`cmd /c start "" x.html` 拉起的 GUI 进程继承了 stdout/stderr，
  // 子进程（powershell）退出后管道不关，'close' 永不触发 → 工具调用挂死（宿主判 outcome unknown）。
  const { tmp, tool, exec } = await makeCase()
  const cmd = await scriptCommand(tmp, 'leak', [
    "import { spawn } from 'node:child_process'",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { detached: true, stdio: 'inherit' })",
    'child.unref()',
    "console.log('parent-done')",
  ].join('\n'))
  const started = Date.now()
  const value = await tool.execute({ commands: [cmd], timeout_ms: 5000 }, exec)
  const wall = Date.now() - started
  assert.ok(wall < 2500, '不能等孙进程 3 秒：实际 ' + wall + 'ms')
  assert.equal(value.passed, 1)
  assert.ok(String(value.results[0].tail ?? '').includes('parent-done'), '退出前输出要保留：' + value.results[0].tail)
})

await test('空数组 / 全空白命令 → BAD_REQUEST', async () => {
  const { tool, exec } = await makeCase()
  await expectCode(tool.execute({ commands: [] }, exec), CODES.BAD_REQUEST)
  await expectCode(tool.execute({ commands: ['   ', ''] }, exec), CODES.BAD_REQUEST)
})

await test('超过 batchMaxCommands 点名拒绝，不静默截断', async () => {
  const { tmp, tool, exec } = await makeCase({ batchMaxCommands: 2 })
  const a = await scriptCommand(tmp, 'a', 'console.log(1)')
  await expectCode(tool.execute({ commands: [a, a, a] }, exec), CODES.BAD_REQUEST)
})

await test('enableRunBatch=false 时拒绝执行并指路', async () => {
  const { tmp, tool, exec } = await makeCase({ enableRunBatch: false })
  const cmd = await scriptCommand(tmp, 'x', 'console.log(1)')
  await expectCode(tool.execute({ commands: [cmd] }, exec), CODES.POLICY_REJECTED)
})

// ---------------------------------------------------------------- 共享进程模式（2026-11-11）
// 动机：每条命令 spawn 一个 powershell.exe ≈ 0.43s，34 条就是 14.6s；手写循环只付一次。
// 下面钉住"省时间但不牺牲正确性"的六条：退出码、归属、状态还原、stop_on_error、exit、超时。

const sharedCase = async (overrides = {}) => makeCase({ batchShellMode: 'shared', ...overrides })

await test('shared：退出码逐条保真（0 / 3 / 5 / 不存在的命令）', async () => {
  const { tmp, tool, exec } = await sharedCase()
  const ok = await scriptCommand(tmp, 's-ok', 'console.log("shared-ok")')
  const c3 = await scriptCommand(tmp, 's-3', 'process.exit(3)')
  const c5 = await scriptCommand(tmp, 's-5', 'process.exit(5)')
  const missing = 'dsh-definitely-not-a-command-xyz'
  const value = await tool.execute({ commands: [ok, c3, c5, missing] }, exec)

  assert.equal(value.shellMode, 'shared')
  assert.equal(value.total, 4)
  assert.equal(value.passed, 1, '只有第 1 条是通过')
  assert.equal(value.skipped, 0, '没有命令被杀掉')
  assert.equal(value.results[0].exitCode, 0)
  assert.equal(value.results[1].exitCode, 3, '退出码 3 不能被压平：' + JSON.stringify(value.results[1]))
  assert.equal(value.results[2].exitCode, 5, '退出码 5 不能被压平：' + JSON.stringify(value.results[2]))
  // 不存在的命令：Windows 的 PowerShell 里 $LASTEXITCODE 仍是 0，靠 $? 记 1；POSIX 是 127。
  assert.equal(value.results[3].exitCode, process.platform === 'win32' ? 1 : 127, '不存在的命令必须非零：' + JSON.stringify(value.results[3]))
  const rendered = tool.output.render({}, value)[0].text
  assert.ok(rendered.includes('共享 shell'), '渲染要标明共享模式：' + rendered)
})

await test('shared：输出按命令归属，不靠 stdout 分隔符（伪造也不串条）', async () => {
  const { tmp, tool, exec } = await sharedCase()
  const a = await scriptCommand(tmp, 's-a', 'console.log("::SHARED::1::")')
  const b = await scriptCommand(tmp, 's-b', 'console.log("second-shared-line")')
  const c = await scriptCommand(tmp, 's-c', 'console.error("third-shared-error"); process.exit(2)')
  const value = await tool.execute({ commands: [a, b, c] }, exec)

  assert.ok(String(value.results[0].tail).includes('::SHARED::1::'), '第一条输出归第一条：' + value.results[0].tail)
  assert.ok(String(value.results[1].tail).includes('second-shared-line'), '第二条输出归第二条：' + value.results[1].tail)
  assert.ok(!String(value.results[1].tail).includes('::SHARED::'), '第一条的输出不能串到第二条：' + value.results[1].tail)
  assert.equal(value.results[2].exitCode, 2)
  assert.ok(String(value.results[2].detail ?? '').includes('third-shared-error'), '失败摘要要来自自己的 stderr：' + value.results[2].detail)
})

await test('shared：cd 与 $env 不会泄漏到下一条（逐条还原）', async () => {
  const { tmp, tool, exec } = await sharedCase()
  const leak = process.platform === 'win32'
    ? "Set-Location C:\\Windows; $env:DSH_SHARED_LEAK = 'yes'; Write-Output 'leaked'"
    : 'cd /tmp; export DSH_SHARED_LEAK=yes; echo leaked'
  const check = process.platform === 'win32'
    ? "Write-Output ((Get-Location).Path); Write-Output ('LEAK=' + [string]$env:DSH_SHARED_LEAK)"
    : 'pwd; echo "LEAK=${DSH_SHARED_LEAK}"'
  const value = await tool.execute({ commands: [leak, check] }, exec)

  const tail = String(value.results[1].tail ?? '')
  const normal = (text) => text.replaceAll('/', '\\').toLowerCase()
  assert.ok(normal(tail).includes(normal(tmp)), '下一条必须在原工作目录（cd 被还原）：' + tail)
  assert.ok(!normal(tail).includes('windows'), '不能停留在 C:\\Windows：' + tail)
  assert.ok(tail.includes('LEAK=') && !tail.includes('LEAK=yes'), '$env 必须被还原：' + tail)
})

await test('shared：stop_on_error 停在正确的位置，后续标 SKIPPED', async () => {
  const { tmp, tool, exec } = await sharedCase()
  const ok = await scriptCommand(tmp, 's-ok2', 'console.log("ok")')
  const bad = await scriptCommand(tmp, 's-bad', 'process.exit(7)')
  const after = await scriptCommand(tmp, 's-after', 'console.log("should-not-run")')
  const value = await tool.execute({ commands: [ok, bad, after], stop_on_error: true }, exec)

  assert.equal(value.results[0].exitCode, 0)
  assert.equal(value.results[1].exitCode, 7)
  assert.equal(value.results[2].skipped, true, '遇错即停后，后续命令必须标 SKIPPED（不是 PASS）')
  assert.equal(value.results[2].exitCode, null)
  const rendered = tool.output.render({}, value)[0].text
  assert.ok(rendered.includes('SKIPPED'), '渲染里要出现 SKIPPED：' + rendered)
})

await test('shared 原始语义（直接调 runSharedBatch，绕过自动回退）：exit 带走整批、后续 SKIPPED', async () => {
  // 2026-11-11 第二轮：execute() 检测到 shell 级 exit 会自动改走 isolated，
  // 所以这条契约只能直接对 runSharedBatch 断言——它是回退失效时的最后一道"不假绿"。
  const tmp = await mkdtemp(join(tmpdir(), 'mm-shared-exit-'))
  const logRoot = join(tmp, 'logs')
  await mkdir(logRoot, { recursive: true })
  const results = await runSharedBatch({
    commands: ['exit 9', 'node -v'], cwd: tmp, timeoutMs: 10000, stopOnError: false,
    logRoot, signal: undefined, logger: { debug() {} },
  })

  assert.equal(results[0].exitCode, 9, '共享 shell 的退出码要如实上报：' + JSON.stringify(results[0]))
  if (process.platform === 'win32') {
    assert.equal(results[1].skipped, true, 'Windows 上 exit 带走了共享 shell，后续必须标 SKIPPED')
    assert.equal(results[1].exitCode, null)
  } else {
    // POSIX 用子 shell 跑每条命令，exit 只结束自己 —— 后续照跑（这是更理想的语义）
    assert.equal(results[1].exitCode, 0, 'POSIX 子 shell 隔离 exit：' + JSON.stringify(results[1]))
  }
})

await test('shared：整批超时 → 当前标 TIMEOUT、后续 SKIPPED；且不支持 parallel', async () => {
  const { tool, exec } = await sharedCase()
  const sleep = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10'
  const value = await tool.execute({ commands: [sleep, 'node -v'], timeout_ms: 1000 }, exec)
  assert.equal(value.results[0].timedOut, true, '卡住的命令要标 TIMEOUT：' + JSON.stringify(value.results[0]))
  assert.equal(value.results[1].skipped, true, '超时后剩余命令标 SKIPPED：' + JSON.stringify(value.results[1]))

  await expectCode(tool.execute({ commands: ['node -v'], parallel: true }, exec), CODES.BAD_REQUEST)
})

// ------------------------------------------------ 默认共享 + exit 自动回退（2026-11-11 第二轮）
// 动机：实测 5 个插件会话里有 3 个把 `exit` 拆出去单独跑（1+18+1 / 19+1 / 5+15），
// prompt 直接翻倍。与其靠提示词求模型别拆，不如工具自己兜住：检测到 shell 级 exit
// 就改走 isolated——结果等价，只是慢一点。

await test('默认（不配 batchShellMode）走 shared', async () => {
  const { tool, exec } = await makeCase({ batchShellMode: undefined })
  const value = await tool.execute({ commands: ['node -v'] }, exec)
  assert.equal(value.shellMode, 'shared', '默认必须是 shared：' + JSON.stringify(value.shellMode))
  assert.equal(value.shellModeFallback, false)
  assert.equal(value.results[0].exitCode, 0)
})

await test('shared 下出现 shell 级 exit → 自动改走 isolated，后续照跑', async () => {
  const { tmp, tool, exec } = await sharedCase()
  const after = await scriptCommand(tmp, 's-after3', 'console.log("still-here")')
  const value = await tool.execute({ commands: ['node -v; exit 9', after] }, exec)

  assert.equal(value.shellMode, 'isolated', '检测到 exit 必须改走独立进程：' + JSON.stringify(value.shellMode))
  assert.equal(value.shellModeFallback, true)
  assert.equal(value.results[0].exitCode, 9, 'exit 9 的退出码要如实上报：' + JSON.stringify(value.results[0]))
  assert.equal(value.results[1].skipped, undefined, '后续命令不能被 exit 带走：' + JSON.stringify(value.results[1]))
  assert.equal(value.results[1].exitCode, 0)
  assert.ok(String(value.results[1].tail).includes('still-here'))
  const rendered = tool.output.render({}, value)[0].text
  assert.ok(rendered.includes('改走独立进程'), '渲染要说明发生了什么：' + rendered)
})

await test('子进程的 exit 不算 shell 级 exit（仍走 shared）', async () => {
  const { tool, exec } = await sharedCase()
  const value = await tool.execute({ commands: ['node -e "process.exit(6)"', 'node -v'] }, exec)
  assert.equal(value.shellMode, 'shared', 'process.exit 不该触发回退：' + JSON.stringify(value.shellMode))
  assert.equal(value.shellModeFallback, false)
  assert.equal(value.results[0].exitCode, 6)
  assert.equal(value.results[1].exitCode, 0)
})

console.log('[run_batch] 通过 ' + stats.passed + '，失败 ' + stats.failed)
if (stats.failed > 0) process.exit(1)
