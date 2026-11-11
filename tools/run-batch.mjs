/**
 * run_batch —— 一次跑一批命令（2026-11-10）。
 *
 * ## 为什么要有它
 *
 * 逐条跑命令的成本不在执行，而在**步数**：每条 shell 调用都是一步，
 * 每一步都要重发一遍上下文。实测一轮 12 个测试文件逐条跑 = 54 步、3M cacheRead。
 * 同一批命令合成一次调用后，规划粒度不变（主代理仍决定跑哪批、看结果、再决定），
 * 但步数从 N 降到 1 —— 这是上下文成本的主要来源。
 *
 * ## 语义（刻意的边界）
 *   - **串行**：命令之间有依赖是常态（build → test），并发留给调用方显式拆分；
 *   - **每条独立进程**：一条失败不影响后面的（除非 stop_on_error）；
 *   - **完整输出落盘**：回给模型的只有退出码 + 失败摘要，正文在日志文件里，
 *     需要细节时用 read 去读，避免每次调用都把几百行灌进上下文；
 *   - **不改变权限面**：命令字符串与原生 shell 工具同源，没有新增越权路径。
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError } from '../core/errors.mjs'
import { displayPath, resolveOutDir, sessionCwd, shortHash, slugify, stamp } from '../core/deliver.mjs'

/** 单条命令最多捕获多少字节（超出只留尾部；完整日志本来就在文件里）。 */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

/** 失败摘要最多回多少字符（中文按字符算，避免一条断言刷屏）。 */
const MAX_DETAIL_CHARS = 600

/**
 * 密钥类环境变量（与原生 shell 的 shell-env 策略对齐）。
 *
 * 2026-11-10 实测：宿主进程里带着 DASHSCOPE_API_KEY / MINIMAX_API_KEY / ZHIPU_API_KEY，
 * 直接 `env: process.env` 会把它们灌进批量命令的子进程；而原生 shell 环境里一个都没有。
 * 于是"缺 key"的测试会突然拿到真 key 去撞 mock（AUTH），生产里也会让任意批量脚本
 * 看见用户的密钥。这里按名字过滤，行为与原生 shell 对齐。
 */
const SECRET_ENV_RE = /(API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i

/**
 * 构造子进程环境：继承宿主环境，但剔掉密钥类变量。
 * @param {NodeJS.ProcessEnv} source - 源环境（默认 process.env）。
 * @returns {NodeJS.ProcessEnv} 过滤后的环境。
 */
function childEnvOf(source) {
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (!SECRET_ENV_RE.test(key)) out[key] = value
  }
  return out
}

/**
 * Windows 包装脚本：把真实退出码写到文件里再退出 0。
 *
 * 为什么必须这样：`powershell.exe -Command "& node x.mjs"` 在子进程失败时
 * **只会返回 1**（实测 3 → 1），丢掉真实退出码；而 run_batch 的契约是"退出码原样保留"。
 * 命令用 base64 传入，彻底避开引号转义；退出码走独立文件，不污染 stdout。
 * 只含 ASCII，PowerShell 5.1 读取无编码问题。
 */
/**
 * Windows 包装脚本：把真实退出码写到文件里再退出 0。
 *
 * 为什么必须这样：`powershell.exe -Command "& node x.mjs"` 在子进程失败时
 * **只会返回 1**（实测 3 → 1），丢掉真实退出码；而 run_batch 的契约是"退出码原样保留"。
 * 命令用 base64 传入，彻底避开引号转义；退出码走独立文件，不污染 stdout。
 *
 * ⚠ 这个模板**必须只含 ASCII**：脚本以 UTF-8 无 BOM 写盘，而 Windows PowerShell 5.1
 * 按系统 ANSI 码页读取未标 BOM 的 .ps1 —— 夹一句中文注释就会变乱码、整段解析失败
 * （2026-11-11 实测：测试里 4 个退出码用例全变 0）。要写说明，写在 JS 注释里。
 */
const WINDOWS_WRAPPER = `param([string]$B64,[string]$Out)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($B64))
$global:LASTEXITCODE = 0
$Error.Clear()
Invoke-Expression $cmd
$ok = $?
$lastError = $Error[0]
$missing = ($null -ne $lastError) -and ($lastError.Exception -is [System.Management.Automation.CommandNotFoundException])
# Native non-zero code wins; then statement failure; then command-not-found; else 0.
$code = if ($LASTEXITCODE -ne 0) { $LASTEXITCODE } elseif (-not $ok) { 1 } elseif ($missing) { 1 } else { 0 }
Set-Content -LiteralPath $Out -Value $code -Encoding Ascii
`

/**
 * 构造一条命令的 shell 调用。
 * @param {string} command - 调用方给的命令原文。
 * @param {{ wrapper?: string, exitFile?: string }} [paths] - Windows 包装脚本与退出码文件。
 * @returns {{ file: string, args: string[] }} 可执行文件与参数（不经过额外 shell 拼接）。
 */
function shellOf(command, paths = {}) {
  if (process.platform === 'win32') {
    const ps = process.env.MM_BATCH_POWERSHELL ?? 'powershell.exe'
    if (paths.wrapper !== undefined && paths.exitFile !== undefined) {
      return {
        file: ps,
        args: [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', paths.wrapper,
          '-B64', Buffer.from(command, 'utf8').toString('base64'),
          '-Out', paths.exitFile,
        ],
      }
    }
    // 兜底：没有包装脚本时至少把编码设对（退出码会退化成 1，仅用于异常路径）
    const wrapped = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' + command
    return { file: ps, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped] }
  }
  return { file: '/bin/bash', args: ['-lc', command] }
}

/**
 * 杀掉整棵进程树。
 *
 * 只 kill 父进程会留下孙进程（PowerShell → node → …），在 Windows 上尤其明显；
 * 超时/取消必须连子进程一起收掉，否则它们会继续占端口、写文件。
 * @param {import('node:child_process').ChildProcess} child - 子进程。
 */
function killTree(child) {
  if (child === undefined || child === null) return
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // 进程可能已经退出；下面的 kill 再兜一次
    }
  }
  try {
    child.kill()
  } catch {
    // 已退出
  }
}

/**
 * 跑一条命令，收集输出与退出码。
 * @param {{ command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, wrapper?: string, exitFile?: string }} input - 参数。
 * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean, truncated: boolean, durationMs: number, error?: string }>}
 */
function runOne({ command, cwd, timeoutMs, signal, wrapper, exitFile }) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const { file, args } = shellOf(command, { wrapper, exitFile })
    let child
    try {
      child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvOf(process.env) })
    } catch (error) {
      resolvePromise({
        exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false,
        durationMs: Date.now() - started, error: String(error?.message ?? error),
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false

    const collect = (current, chunk) => {
      const next = current + String(chunk)
      if (next.length <= MAX_CAPTURE_BYTES) return next
      truncated = true
      return next.slice(next.length - MAX_CAPTURE_BYTES)
    }
    child.stdout?.on('data', (chunk) => { stdout = collect(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = collect(stderr, chunk) })

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise({ exitCode, stdout, stderr, timedOut, aborted, truncated, durationMs: Date.now() - started })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    const onAbort = () => {
      aborted = true
      killTree(child)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        exitCode: null, stdout, stderr, timedOut, aborted, truncated,
        durationMs: Date.now() - started, error: String(error?.message ?? error),
      })
    })
    /** 从退出码文件取最终码（Windows 包装脚本写的），再收尾。 */
    const finalizeFromFile = (code) => {
      // Windows：真实退出码在包装脚本写的文件里（`powershell -Command` 会把 3 压成 1）。
      let finalCode = code
      if (exitFile !== undefined) {
        try {
          const parsed = Number.parseInt(readFileSync(exitFile, 'utf8').trim(), 10)
          if (Number.isFinite(parsed)) finalCode = parsed
        } catch {
          // 命令自己调了 exit / 进程被杀 ⇒ 没有退出码文件，退回进程码
        }
        try {
          rmSync(exitFile, { force: true })
        } catch {
          // 删不掉就留着，不影响结果
        }
      }
      finish(finalCode)
    }

    child.on('close', (code) => {
      finalizeFromFile(code)
    })

    // 2026-11-11 实测事故：命令里带 `cmd /c start "" xxx.html` 时，被拉起的 GUI 进程
    // 继承了 stdout/stderr 管道；子进程（powershell）已经退出，但管道不关，
    // 'close' 永远不触发 —— 整次工具调用挂死，最终被宿主判成 "outcome unknown"。
    // 进程退出（'exit'）才代表命令跑完：给 400ms 排空剩余输出，然后强制收尾。
    child.on('exit', (code) => {
      if (settled) return
      const drain = setTimeout(() => {
        if (settled) return
        try { child.stdout?.destroy() } catch { /* 已关闭 */ }
        try { child.stderr?.destroy() } catch { /* 已关闭 */ }
        finalizeFromFile(code)
      }, 400)
      if (typeof drain.unref === 'function') drain.unref()
      child.once('close', () => clearTimeout(drain))
    })
  })
}

// ============================================================================
// 共享进程模式（2026-11-11 加，默认关）
//
// 现状是"每条命令 spawn 一个 powershell.exe"，实测 0.43s/条（进程冷启动）。
// 手写循环只付一次。共享模式：一批命令在**同一个** shell 进程里跑，
// 每条命令的 stdout/stderr/退出码/耗时写进**独立文件** —— 不靠 stdout 分隔符，
// 因为"输出里恰好包含分隔符"会把归属搞错，那是会假绿的错误。
//
// 已知代价与缓解（都实测过，见 tests/run-batch.test.mjs）：
//   · `Set-Location` 在 `& { }` 子作用域里**会泄漏**（实测）→ 每条之前保存、之后还原；
//   · `$env:X` 是进程级、也会泄漏（实测）→ 每条之后按快照还原；
//   · 命令里 `exit` 会**带走整个 shell**（实测）→ 后面的命令标 SKIPPED，绝不假绿；
//   · 超时按整批预算（timeout_ms × 条数）→ 到点杀进程树，当前标 TIMEOUT、其余 SKIPPED。
//   · POSIX 用 `( eval ... )` 子 shell，本来就隔离 cd/env/exit。
// ============================================================================
const SHARED_PS_RUNNER = `param([string]$Dir, [int]$Count, [int]$StopOnError)
$ErrorActionPreference = 'Continue'
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env0 = @{}
foreach ($e in Get-ChildItem Env:) { $env0[$e.Name] = [string]$e.Value }
for ($i = 1; $i -le $Count; $i++) {
  $cmdFile = Join-Path $Dir ('cmd-' + $i + '.txt')
  $outFile = Join-Path $Dir ('o' + $i + '.txt')
  $errFile = Join-Path $Dir ('e' + $i + '.txt')
  $codeFile = Join-Path $Dir ('c' + $i + '.txt')
  $timeFile = Join-Path $Dir ('t' + $i + '.txt')
  $cmd = [string](Get-Content -LiteralPath $cmdFile -Raw -Encoding UTF8)
  $loc = (Get-Location).Path
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $global:LASTEXITCODE = 0
  $ok = $true
  try {
    $script = '$global:LASTEXITCODE = 0; ' + $cmd
    & ([scriptblock]::Create($script)) 1> $outFile 2> $errFile
    $ok = $?
  } catch {
    (($_ | Out-String)) | Out-File -LiteralPath $errFile -Append -Encoding utf8
    $ok = $false
  } finally {
    $sw.Stop()
    Set-Location -LiteralPath $loc -ErrorAction SilentlyContinue
    foreach ($k in @($env0.Keys)) {
      if ([Environment]::GetEnvironmentVariable($k) -ne $env0[$k]) { [Environment]::SetEnvironmentVariable($k, $env0[$k]) }
    }
    foreach ($e in @(Get-ChildItem Env:)) {
      if (-not $env0.ContainsKey($e.Name)) { [Environment]::SetEnvironmentVariable($e.Name, $null) }
    }
  }
  $code = 0
  if ($global:LASTEXITCODE -ne 0) { $code = [int]$global:LASTEXITCODE }
  elseif (-not $ok) { $code = 1 }
  Set-Content -LiteralPath $codeFile -Value $code -Encoding Ascii
  Set-Content -LiteralPath $timeFile -Value $sw.ElapsedMilliseconds -Encoding Ascii
  if (($code -ne 0) -and ($StopOnError -eq 1)) { break }
}
`

const SHARED_SH_RUNNER = `#!/bin/bash
dir="$1"; count="$2"; stop="$3"
for ((i=1; i<=count; i++)); do
  cmd=$(cat "$dir/cmd-$i.txt")
  start=$(date +%s%3N 2>/dev/null || echo 0)
  ( eval "$cmd" ) > "$dir/o$i.txt" 2> "$dir/e$i.txt"
  code=$?
  end=$(date +%s%3N 2>/dev/null || echo 0)
  echo "$code" > "$dir/c$i.txt"
  echo $((end-start)) > "$dir/t$i.txt"
  if [ "$code" -ne 0 ] && [ "$stop" = "1" ]; then break; fi
done
`

/** 读一个可选文件；不存在返回 undefined（用来判断"这条命令有没有跑过"）。 */
function readMaybe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 去掉 UTF-8 BOM（Windows PowerShell 的 `Out-File -Encoding utf8` 会写 BOM）。 */
function stripBom(text) {
  return text !== undefined && text.codePointAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 还原被 PowerShell 包过一层的**原生 stderr**。
 *
 * 共享模式下 `2> file` 走的是 PowerShell 的错误流：原生命令的 stderr 会被包成
 * "node : <原始行> / At line: / CategoryInfo : NotSpecified ... NativeCommandError"。
 * 逐条模式用管道拿的是裸字节，所以这里必须把那层壳剥掉，否则 tail / detail 里全是
 * 位置信息和命令原文（2026-11-11 实测：stderr 尾巴变成 `+ $global:LASTEXITCODE = 0; ...`）。
 * @param {string} text - 原始 stderr 文本。
 * @returns {string} 尽量接近原生的 stderr。
 */
function cleanStderr(text) {
  // 只认"原生 stderr 被 PowerShell 包了一层"这一种情况（其标志是 NativeCommandError）。
  // ⚠ 不要额外要求 CategoryInfo：PS 5.1 对原生命令只给 `At line:`、`+ 命令原文` 与
  //   `FullyQualifiedErrorId : NativeCommandError` 这几行，没有 CategoryInfo ——
  //   加了那个条件就永远匹配不上（2026-11-11 实测：尾巴里剩下 `+ $global:LASTEXITCODE = 0; ...`）。
  if (text === '' || !/NativeCommandError/.test(text)) return text
  const kept = []
  for (const line of text.split(/\r?\n/)) {
    // 位置信息行：英文 `At line:` / 中文（本机 PS 5.1 是中文界面）`所在位置 行:`。
    if (/^\s*(At (line|char):|所在位置)/i.test(line)) break
    // `+ CategoryInfo …` / `+ FullyQualifiedErrorId …` / `+ ~~~~`（位置指示符）都丢掉。
    if (/^\s*\+/.test(line)) continue
    if (line.trim() === '') continue
    // 原生命令的第一行是 `<命令名> : <原始内容>`，把前缀剥掉。
    kept.push(line.replace(/^[^:]{1,80} : /, ''))
  }
  const joined = kept.join('\n').trim()
  return joined === '' ? text : joined + '\n'
}

/**
 * 共享进程执行一批命令。
 * @param {{ commands: string[], cwd: string, timeoutMs: number, stopOnError: boolean, logRoot: string, signal?: AbortSignal, logger?: object }} input - 参数。
 * @returns {Promise<object[]>} 与逐条模式同形的结果记录（外加 skipped 标记）。
 */
export async function runSharedBatch({ commands, cwd, timeoutMs, stopOnError, logRoot, signal, logger }) {
  const dir = join(logRoot, 'shared')
  await mkdir(dir, { recursive: true })
  for (let i = 0; i < commands.length; i += 1) {
    await writeFile(join(dir, 'cmd-' + (i + 1) + '.txt'), commands[i], 'utf8')
  }
  const win = process.platform === 'win32'
  const runner = join(logRoot, win ? 'shared-runner.ps1' : 'shared-runner.sh')
  await writeFile(runner, win ? SHARED_PS_RUNNER : SHARED_SH_RUNNER, 'utf8')

  const file = win ? (process.env.MM_BATCH_POWERSHELL ?? 'powershell.exe') : '/bin/bash'
  const args = win
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, dir, String(commands.length), stopOnError ? '1' : '0']
    : [runner, dir, String(commands.length), stopOnError ? '1' : '0']
  // 超时口径：单条预算 × 条数 = 整批上限（文档里写清楚，避免"一条慢命令拖垮整批还没人发现"）。
  const deadlineMs = Math.max(2000, timeoutMs * commands.length)

  const outcome = await new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvOf(process.env) })
    } catch (error) {
      resolvePromise({ spawnError: String(error?.message ?? error), exitCode: null, timedOut: false, aborted: false })
      return
    }
    let timedOut = false
    let aborted = false
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise({ exitCode: code, timedOut, aborted })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, deadlineMs)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => {
      aborted = true
      killTree(child)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (error) => {
      logger?.debug?.('[mm-models] 共享 shell 进程错误：' + String(error?.message ?? error))
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })

  const records = []
  let firstMissing
  for (let i = 0; i < commands.length; i += 1) {
    const n = i + 1
    const codeText = readMaybe(join(dir, 'c' + n + '.txt'))
    if (codeText === undefined) {
      if (firstMissing === undefined) firstMissing = i
      continue
    }
    const stdout = stripBom(readMaybe(join(dir, 'o' + n + '.txt')) ?? '')
    const stderr = cleanStderr(stripBom(readMaybe(join(dir, 'e' + n + '.txt')) ?? ''))
    const ms = Number((readMaybe(join(dir, 't' + n + '.txt')) ?? '').trim())
    records[i] = {
      exitCode: Number(codeText.trim()),
      stdout,
      stderr,
      durationMs: Number.isFinite(ms) ? ms : 0,
      timedOut: false,
    }
  }

  // 补上"没写结果"的那几条，三种情形必须可区分：
  //   ① 超时 → 当前那条标 TIMEOUT（不是 skipped）；
  //   ② 命令里的 exit 带走 shell → 当前那条按 shell 的退出码算 FAIL，后续 SKIPPED；
  //   ③ 其它（stop_on_error 主动 break / 正常提前结束）→ 一律 SKIPPED，绝不假绿。
  for (let i = 0; i < commands.length; i += 1) {
    if (records[i] !== undefined) continue
    const isFirstMissing = i === firstMissing
    const processCode = outcome.exitCode === null ? null : Number(outcome.exitCode)
    if (isFirstMissing && outcome.timedOut === true) {
      records[i] = { exitCode: null, stdout: '', stderr: '', durationMs: 0, timedOut: true, skipped: false }
    } else if (isFirstMissing && processCode !== null && processCode !== 0) {
      records[i] = {
        exitCode: Math.abs(processCode) || 1,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        skipped: false,
        shellExited: true,
      }
    } else {
      records[i] = {
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        skipped: true,
        stopOnError: stopOnError === true,
      }
    }
  }

  // 落日志 + 生成与逐条模式同形的记录。
  const results = []
  for (let i = 0; i < commands.length; i += 1) {
    const command = commands[i]
    const r = records[i]
    const logName = String(i + 1).padStart(2, '0') + '-' + slugify(command.split(/\s+/)[0] ?? 'cmd', 24) + '.log'
    const logPath = join(logRoot, logName)
    if (r.skipped !== true) {
      try {
        await writeFile(
          logPath,
          '$ ' + command + '\n(exit ' + (r.exitCode ?? 'null') + ', ' + r.durationMs + ' ms'
            + (r.timedOut ? ', TIMEOUT' : '') + ', shared-shell)\n\n'
            + (r.stdout.length > 0 ? '=== stdout ===\n' + r.stdout + '\n' : '')
            + (r.stderr.length > 0 ? '=== stderr ===\n' + r.stderr + '\n' : ''),
          'utf8',
        )
      } catch (error) {
        logger?.debug?.('[mm-models] run_batch 写日志失败（已忽略）：' + String(error?.message ?? error))
      }
    }
    const ok = r.exitCode === 0
    const skipped = r.skipped === true
    results.push({
      index: i + 1,
      command,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut === true,
      truncated: false,
      logPath: displayPath(logPath, cwd),
      tail: skipped ? '' : tailOf(r),
      tailComplete: !skipped && (r.stdout.length + r.stderr.length) <= 260,
      ...(skipped
        ? {
            detail: r.shellExited === true
              ? '这条命令执行了 exit，整批共享 shell 被带走；后续命令未执行。'
              : (r.stopOnError === true
                ? 'stop_on_error：前面有命令失败，这条未执行。'
                : (outcome.timedOut === true
                  ? '整批超时（' + Math.round(deadlineMs / 1000) + 's 预算），这条及后续命令未执行。'
                  : '未执行（共享 shell 提前结束，或进程启动失败）。')),
          }
        : (ok ? {} : { detail: r.shellExited === true ? '这条命令 exit 带走了共享 shell。' : excerptOf(r) })),
      skipped,
    })
  }
  return results
}

/**
 * 取最后 1–2 行非空输出（成功命令也要回）。
 *
 * 2026-11-10 实测教训：只回退出码时，模型为了拿"通过 13，失败 0"这种汇总结论，
 * 会再去列目录 + 读 4 个日志（5 步、16K token）。这些结论本来就写在每条命令的末尾，
 * 直接回一行尾巴就能省掉整轮追查。
 * @param {{ stdout: string, stderr: string }} result - 单条命令的结果。
 * @param {number} [max] - 最大字符数。
 * @returns {string} 尾巴文本（可能为空串）。
 */function tailOf(result, max = 200) {
  const raw = (result.stdout.trim().length > 0 ? result.stdout : result.stderr).trim()
  if (raw.length === 0) return ''
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return ''
  // 优先挑"像结论"的行：`node --test` 这类 runner 会把真正有用的 pass/fail 埋在中段，
  // 末尾只剩 duration_ms。没有命中就退回最后两行。
  const interesting = lines.slice(-15).filter((line) => /(通过|失败|PASS|FAIL|pass\s|fail\s|ALL PASS|错误|error|✗|✓)/i.test(line))
  const picked = interesting.length > 0 ? interesting.slice(-2) : lines.slice(-2)
  const tail = picked.join(' / ')
  return tail.length > max ? tail.slice(tail.length - max) : tail
}

/**
 * 取一段失败摘要：优先 stderr，其次 stdout，只保留尾部若干行。
 * @param {{ stdout: string, stderr: string }} result - 单条命令的结果。
 * @returns {string} 摘要文本（可能为空串）。
 */
function excerptOf(result) {
  const raw = (result.stderr.trim().length > 0 ? result.stderr : result.stdout).trim()
  if (raw.length === 0) return ''
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const tail = lines.slice(-6).join('\n')
  return tail.length > MAX_DETAIL_CHARS ? tail.slice(tail.length - MAX_DETAIL_CHARS) : tail
}

/**
 * 把 package.json 的脚本体拆成多条命令（2026-11-10）。
 *
 * 只按 `&&` 切；遇到会改变语义的构造（`||`、反引号、`$(`、行首 `cd`）就整段当一条执行——
 * 拆开 `cd sub && ...` 会让第二条命令回到原目录，那是错的。
 * @param {string} text - 脚本体。
 * @returns {string[]} 命令列表。
 */
function splitScript(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  if (/\|\||`|\$\(/.test(text)) return [text.trim()]
  const parts = []
  let current = ''
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '&' && text[index + 1] === '&') {
      parts.push(current)
      current = ''
      index += 1
      continue
    }
    current += ch
  }
  parts.push(current)
  const trimmed = parts.map((part) => part.trim()).filter((part) => part.length > 0)
  if (trimmed.length === 0) return []
  if (trimmed.some((part) => /^cd\b/i.test(part))) return [text.trim()]
  return trimmed
}

/** `npm run test` / `npm test` / `pnpm run x` / `yarn x` 的引用形式。 */
const SCRIPT_REF_RE = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\p{L}\p{N}_.:@-]+)$/u

/**
 * 把脚本展开成命令：`npm run x` 会递归替换成 scripts.x 的内容（最多 3 层，防环）。
 * @param {Record<string, string>} scripts - package.json 的 scripts。
 * @param {string} name - 脚本名。
 * @param {number} [depth] - 当前深度。
 * @param {Set<string>} [seen] - 防环。
 * @returns {string[]|null} 命令列表；脚本不存在返回 null。
 */
function expandScript(scripts, name, depth = 0, seen = new Set()) {
  if (depth > 3) return null
  if (typeof scripts[name] !== 'string') return null
  if (seen.has(name)) return null
  seen.add(name)
  const out = []
  for (const part of splitScript(scripts[name])) {
    const ref = SCRIPT_REF_RE.exec(part)
    if (ref !== null && typeof scripts[ref[1]] === 'string') {
      const expanded = expandScript(scripts, ref[1], depth + 1, seen)
      if (expanded !== null) {
        out.push(...expanded)
        continue
      }
    }
    out.push(part)
  }
  return out
}

/**
 * 有并发上限的 map：结果按输入顺序返回。
 * @param {unknown[]} items - 输入。
 * @param {number} limit - 并发上限。
 * @param {(item: unknown, index: number) => Promise<unknown>} worker - 单个任务。
 * @returns {Promise<unknown[]>} 结果数组（顺序与输入一致）。
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/**
 * 批次里有没有**shell 级** `exit`（会带走共享 shell 的那种）。
 *
 * 只认"命令段开头是 exit"：`exit 9`、`cd x; exit`、`a && exit` 都算；
 * `node -e "process.exit(9)"`、`cmd /c exit 4` 不算——那是子进程自己退出。
 * 判错的代价不对称：漏判 = 共享 shell 被杀（后续 SKIPPED，仍不假绿）；
 * 误判 = 白走一次 isolated（慢一点，结果不变）。
 * @param {string[]} commands - 命令列表。
 * @returns {boolean} 命中返回 true。
 */
export function hasShellExit(commands) {
  return commands.some((command) => /(?:^|[;&|\n])\s*exit(?=\s|;|$)/i.test(command))
}

/**
 * 注册 run_batch。
 * @param {object} deps - config（liveConfig）/ logger。
 */
export function createRunBatchTool(deps) {
  const { config, logger } = deps
  const valueOf = (key, fallback) => (config?.[key] === undefined || config?.[key] === null ? fallback : config[key])

  return defineTool({
    name: 'run_batch',
    description:
      '批量执行：一次跑多条命令（测试/构建/批量检查），可并行，也可直接跑 package.json 脚本名。'
      + '顺序相关的命令一次全传，别一条一次调用。'
      + '默认共用一个 shell；含 shell 级 exit 时自动改走独立进程。'
      + '返回退出码与输出尾巴，完整日志落盘。结论以 tail 为准。',
    parameters: {
      commands: {
        type: 'array',
        items: { type: 'string' },
        description: '要执行的命令（1..batchMaxCommands）。与 script 二选一。',
      },
      script: {
        type: 'string',
        description: 'package.json 脚本名（如 "test"）；与 commands 二选一。',
      },
      parallel: { type: 'boolean', description: '并行执行（默认串行）；与 stop_on_error 互斥。' },
      cwd: { type: 'string', description: '工作目录；默认当前会话目录' },
      stop_on_error: { type: 'boolean', description: '遇错即停（默认 false：全部跑完再汇总）' },
      timeout_ms: { type: 'integer', description: '单条命令超时（毫秒）；默认取配置 batchCommandTimeoutMs' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          passed: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          timedOut: { type: 'integer' },
          skipped: { type: 'integer' },
          shellMode: { type: 'string' },
          shellModeFallback: { type: 'boolean' },
          durationMs: { type: 'integer', required: true },
          logDir: { type: 'string', required: true },
          script: { type: 'string' },
          parallel: { type: 'boolean' },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                command: { type: 'string', required: true },
                exitCode: { type: 'integer' },
                durationMs: { type: 'integer', required: true },
                timedOut: { type: 'boolean' },
                truncated: { type: 'boolean' },
                skipped: { type: 'boolean' },
                logPath: { type: 'string', required: true },
                tail: { type: 'string' },
                tailComplete: { type: 'boolean' },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const shared = value.shellMode === 'shared'
        const lines = [
          '批量执行：' + value.total + ' 条命令（' + (value.parallel === true ? '并行' : '串行')
            + (shared ? ' · 共享 shell' : '')
            + (value.shellModeFallback === true ? ' · 含 exit，已改走独立进程' : '') + '）｜通过 ' + value.passed + ' ｜失败 ' + value.failed
            + (value.skipped > 0 ? ' ｜未执行 ' + value.skipped : '')
            + (value.timedOut > 0 ? ' ｜超时 ' + value.timedOut : '')
            + ' ｜总耗时 ' + (value.durationMs / 1000).toFixed(1) + ' s',
        ]
        if (typeof value.script === 'string') lines.push('脚本：' + value.script + '（展开为 ' + value.total + ' 条命令）')
        for (const item of value.results) {
          const state = item.skipped === true
            ? 'SKIPPED'
            : item.exitCode === 0 ? 'PASS' : item.timedOut === true ? 'TIMEOUT' : 'FAIL'
          lines.push(
            item.index + '. ' + state + '  ' + item.command
              + '  (' + (item.durationMs / 1000).toFixed(1) + ' s'
              + (item.exitCode === null || item.exitCode === undefined ? '' : ', exit ' + item.exitCode) + ')',
          )
          if (typeof item.tail === 'string' && item.tail.length > 0) {
            lines.push('   ↳ ' + item.tail + (item.tailComplete === true ? '  （完整输出，无需再读日志）' : ''))
          }
          if (typeof item.detail === 'string' && item.detail.length > 0 && state !== 'PASS') {
            for (const line of item.detail.split('\n')) lines.push('   ' + line)
          }
        }
        lines.push('日志目录：' + value.logDir)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (valueOf('enableRunBatch', true) === false) {
        throw new MediaError(CODES.POLICY_REJECTED, 'run_batch 已被关闭（配置 enableRunBatch=false）。请改用原生 shell 逐条执行。')
      }

      const hasScript = typeof args?.script === 'string' && args.script.trim().length > 0
      const raw = args?.commands
      const hasCommands = Array.isArray(raw) && raw.length > 0
      if (hasScript === hasCommands) {
        throw new MediaError(CODES.BAD_REQUEST, 'commands 与 script 必须二选一：要么给命令数组，要么给 package.json 里的脚本名。')
      }

      const cwd = typeof args?.cwd === 'string' && args.cwd.trim().length > 0
        ? args.cwd.trim()
        : (sessionCwd(exec) ?? process.cwd())
      const configuredTimeout = Number(valueOf('batchCommandTimeoutMs', 120000))
      const requestedTimeout = Number(args?.timeout_ms)
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : configuredTimeout
      const stopOnError = args?.stop_on_error === true
      const parallel = args?.parallel === true
      if (parallel && stopOnError) {
        throw new MediaError(CODES.BAD_REQUEST, 'parallel 与 stop_on_error 不能同时用：并行模式下已经起跑的命令停不下来。')
      }
      const parallelLimit = Math.max(1, Math.min(8, Number(valueOf('batchParallelLimit', 4)) || 4))

      /** 脚本模式（2026-11-10）：直接跑 package.json 里的脚本名，不必手抄命令。 */
      let commands
      let scriptName
      if (hasScript) {
        scriptName = args.script.trim()
        let pkg
        try {
          pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
        } catch {
          throw new MediaError(CODES.BAD_REQUEST, '读不到 ' + join(cwd, 'package.json') + '（script 模式需要它）。请检查 cwd。')
        }
        const scripts = pkg?.scripts !== null && typeof pkg?.scripts === 'object' ? pkg.scripts : {}
        const expanded = expandScript(scripts, scriptName)
        if (expanded === null || expanded.length === 0) {
          const available = Object.keys(scripts).slice(0, 12).join(', ')
          throw new MediaError(
            CODES.BAD_REQUEST,
            'package.json 里没有脚本 "' + scriptName + '"' + (available.length > 0 ? '。可用：' + available : '。'),
          )
        }
        commands = expanded
      } else {
        commands = raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0)
        if (commands.length === 0) {
          throw new MediaError(CODES.BAD_REQUEST, 'commands 里没有非空命令。')
        }
      }
      const maxCommands = Number(valueOf('batchMaxCommands', 20))
      if (Number.isFinite(maxCommands) && commands.length > maxCommands) {
        throw new MediaError(
          CODES.BAD_REQUEST,
          '共 ' + commands.length + ' 条命令，超过上限 ' + maxCommands + '（batchMaxCommands）。请分组成多次调用，不要静默截断。',
        )
      }

      // stamp() 只到秒：同一秒内两次 run_batch 会撞目录并互相覆盖日志，所以补 6 位哈希。
      const logRoot = join(resolveOutDir({ configValue: valueOf('outDir', 'gen'), exec }), 'batch', stamp() + '-' + shortHash(String(Date.now()) + Math.random()))
      await mkdir(logRoot, { recursive: true })
      // Windows 包装脚本（每批写一次）：退出码走独立文件，不被 PowerShell 压成 1。
      let wrapper
      if (process.platform === 'win32') {
        wrapper = join(logRoot, 'run-batch-wrapper.ps1')
        await writeFile(wrapper, WINDOWS_WRAPPER, 'utf8')
      }

      /**
       * 跑一条命令并落日志，返回结果记录与是否被取消。
       * @param {number} index - 序号（从 0 开始）。
       * @param {string} command - 命令原文。
       * @returns {Promise<{ record: object, aborted: boolean }>} 结果。
       */
      const runItem = async (index, command) => {
        const result = await runOne({
          command, cwd, timeoutMs, signal: exec?.signal,
          wrapper,
          exitFile: wrapper === undefined ? undefined : join(logRoot, 'exit-' + (index + 1) + '.txt'),
        })
        const logName = String(index + 1).padStart(2, '0') + '-' + slugify(command.split(/\s+/)[0] ?? 'cmd', 24) + '.log'
        const logPath = join(logRoot, logName)
        try {
          await writeFile(
            logPath,
            '$ ' + command + '\n(exit ' + (result.exitCode ?? 'null') + ', ' + result.durationMs + ' ms'
              + (result.timedOut ? ', TIMEOUT' : '') + (result.truncated ? ', captured-tail-only' : '') + ')\n\n'
              + (result.stdout.length > 0 ? '=== stdout ===\n' + result.stdout + '\n' : '')
              + (result.stderr.length > 0 ? '=== stderr ===\n' + result.stderr + '\n' : ''),
            'utf8',
          )
        } catch (error) {
          logger?.debug?.('[mm-models] run_batch 写日志失败（已忽略）：' + String(error?.message ?? error))
        }

        const ok = result.exitCode === 0
        return {
          aborted: result.aborted === true,
          record: {
            index: index + 1,
            command,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut === true,
            truncated: result.truncated === true,
            logPath: displayPath(logPath, cwd),
            tail: tailOf(result),
            // 2026-11-10：输出本来就短时明确说"这就是全文"。
            // 实测模型会为了"逐字核对"去读 4 个日志（多花 4 步）——它不信任被截断的尾巴。
            // 标出 tailComplete 后，短输出的结论就不需要二次取证。
            tailComplete: result.truncated !== true && (result.stdout.length + result.stderr.length) <= 260,
            ...(ok ? {} : { detail: result.error ?? excerptOf(result) }),
          },
        }
      }

      // 执行模式（2026-11-11 第二轮）：默认 shared —— 一批命令共用一个 shell，省掉
      // 每条一次的进程冷启动（实测 ~0.35–0.43s/条）。cd / $env 逐条还原（见 runSharedBatch）。
      // shell 级 `exit` 会带走共享 shell：**检测到就自动改走 isolated**，而不是让模型自己拆批
      // （实测 5 个会话里 3 个把 exit 单独拆出去跑，prompt 直接翻倍）。
      // 判错方向是安全的——误判只是白慢一次，结果等价。
      const configuredShell = String(valueOf('batchShellMode', 'shared'))
      const shellExitDetected = configuredShell === 'shared' && hasShellExit(commands)
      const shellMode = shellExitDetected ? 'isolated' : configuredShell
      const shared = shellMode === 'shared'
      if (shared && parallel) {
        throw new MediaError(CODES.BAD_REQUEST, 'shared 模式不支持 parallel：共享 shell 本身就是串行的。要并行请用 isolated（batchShellMode: isolated）。')
      }

      const started = Date.now()
      let results
      if (shared) {
        results = await runSharedBatch({
          commands, cwd, timeoutMs, stopOnError, logRoot, signal: exec?.signal, logger,
        })
      } else if (parallel) {
        const settled = await mapLimit(commands, parallelLimit, (command, index) => runItem(index, command))
        const aborted = settled.find((item) => item.aborted === true)
        if (aborted !== undefined) {
          throw new MediaError(CODES.ABORTED, 'run_batch 已取消。完整日志：' + displayPath(logRoot, cwd))
        }
        results = settled.map((item) => item.record)
      } else {
        results = []
        for (let index = 0; index < commands.length; index += 1) {
          const { record, aborted } = await runItem(index, commands[index])
          results.push(record)
          if (aborted) {
            throw new MediaError(CODES.ABORTED, 'run_batch 已取消（第 ' + (index + 1) + ' 条命令时中止）。完整日志：' + displayPath(logRoot, cwd))
          }
          if (record.exitCode !== 0 && stopOnError) break
        }
      }

      const passed = results.filter((item) => item.exitCode === 0).length
      const skipped = results.filter((item) => item.skipped === true).length
      return {
        cwd,
        total: results.length,
        passed,
        failed: results.length - passed,
        timedOut: results.filter((item) => item.timedOut === true).length,
        skipped,
        shellMode,
        shellModeFallback: shellExitDetected,
        durationMs: Date.now() - started,
        logDir: displayPath(logRoot, cwd),
        ...(scriptName === undefined ? {} : { script: scriptName }),
        parallel,
        results,
      }
    },
  })
}
