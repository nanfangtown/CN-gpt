/**
 * 试运行脚本的路径解析（开源友好：不硬编码任何本机路径）。
 *
 * 三件事：
 *   1. 沙箱目录一律**相对本包**解析（`<包根>/_sandbox`），换台机器 clone 下来就能用；
 *   2. DSH 应用与 CLI 的位置按「环境变量 → 常见安装位置」探测，找不到就明确报错，
 *      而不是拿一个本机绝对路径去 spawn 然后抛一个看不懂的 ENOENT；
 *   3. 允许用 `DSH_APP` / `DSH_CLI` 覆盖。
 *
 * 环境变量：
 *   DSH_APP   DeepSeek Harness 可执行文件（Electron 应用）
 *   DSH_CLI   dsh CLI 的 bin.js（在包里时也接受 .asar 内路径）
 *   DSH_HOME  Harness home；试运行默认用 <包根>/_sandbox/dshhome
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** 包根目录（tests/ 的上一级）。 */
export const PACKAGE_ROOT = resolve(here, '..')

/** 试运行沙箱根目录：<包根>/_sandbox（已被 .gitignore 排除）。 */
export const SANDBOX = join(PACKAGE_ROOT, '_sandbox')

/** 试运行用的 Harness home（放会话/附件/凭据），默认沙箱内。 */
export const DSH_HOME = process.env.DSH_HOME_FOR_TESTS ?? join(SANDBOX, 'dshhome')

/** 试运行工作目录（产物落在这里）。 */
export const WORK = join(SANDBOX, 'work')

/** 复用的测试夹具图。 */
export const FIXTURE_PNG = join(WORK, 'whale.png')

const CLI_RELATIVE = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

/** asar 内的路径普通 fs 看不见（只有 Electron 能读），所以按归档文件本身判断存在性。 */
function existsAsCli(path) {
  const marker = path.indexOf('.asar')
  return marker < 0 ? existsSync(path) : existsSync(path.slice(0, marker + '.asar'.length))
}

const APP_NAME = 'DeepSeek Harness'

/**
 * 常见安装根目录：Windows 默认安装位置 / Program Files / 用户目录 / macOS。
 * 注意不要往这里塞 `~/.dsh/dsh-runtimes` 之类的目录 —— 那里是运行时二进制，不是应用安装位。
 */
function installRoots() {
  const roots = []
  const { LOCALAPPDATA, PROGRAMFILES, USERPROFILE } = process.env
  if (LOCALAPPDATA !== undefined) roots.push(join(LOCALAPPDATA, 'Programs', APP_NAME), join(LOCALAPPDATA, APP_NAME))
  if (PROGRAMFILES !== undefined) roots.push(join(PROGRAMFILES, APP_NAME))
  if (USERPROFILE !== undefined) roots.push(join(USERPROFILE, APP_NAME))
  roots.push(join('/Applications', APP_NAME + '.app', 'Contents'))
  return roots
}

/**
 * 从"当前进程就是 Electron 应用"这一事实推出安装根目录（最可靠的一种）。
 * tests 常常由 DSH 自己拉起，此时 process.execPath 就是应用可执行文件。
 */
function rootFromExecPath() {
  const exec = process.execPath
  if (typeof exec !== 'string' || !/DeepSeek Harness|deepseek-harness/i.test(exec)) return undefined
  return join(dirname(exec), '..')
}

/**
 * Windows 注册表里的安装位置（有界、失败即忽略）。
 * 标准位置之外的安装（例如装在别的盘）只靠猜目录是找不到的，注册表是最可靠的来源。
 */
function rootsFromWindowsRegistry() {
  if (process.platform !== 'win32') return []
  try {
    const script =
      "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |" +
      " Where-Object { $_.DisplayName -like '*DeepSeek Harness*' -and $_.InstallLocation } |" +
      ' Select-Object -ExpandProperty InstallLocation'
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 8000,
    })
    return String(out.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/** 该路径下是否真的有 DSH 应用（用来筛掉注册表里的残影）。 */
function appAt(root) {
  const exe = process.platform === 'darwin' ? APP_NAME : APP_NAME + '.exe'
  const candidate = process.platform === 'darwin' ? join(root, 'MacOS', exe) : join(root, exe)
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 找 dsh CLI 的 bin.js。
 * 顺序：`DSH_CLI` → 运行中的应用自身 → 常见安装位置 / Windows 注册表。
 * @returns {string} 路径。
 * @throws {Error} 找不到时抛出，并给出可操作的提示。
 */
export function resolveCli() {
  const probeRoots = [rootFromExecPath(), ...installRoots(), ...rootsFromWindowsRegistry()]
  // 注册表里可能有安装残影：只在其下确实存在应用可执行文件时才采信。
  const roots = probeRoots.filter((value) => typeof value === 'string' && value.length > 0 && appAt(value) !== undefined)
  const candidates = [
    process.env.DSH_CLI,
    ...roots.map((root) => join(root, 'resources', 'app.asar', CLI_RELATIVE)),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  const found = candidates.find((path) => existsAsCli(path))
  if (found === undefined) {
    throw new Error(
      'DSH CLI 未找到。请用环境变量指定，例如：\n' +
        '  DSH_CLI=<安装目录>/resources/app.asar/' + CLI_RELATIVE + '\n' +
        '  可选：DSH_APP=<DeepSeek Harness 可执行文件>',
    )
  }
  return found
}

/**
 * 找 Electron 应用可执行文件（CLI 在 asar 内时必须由它来跑）。
 * @returns {string|undefined} 找不到返回 undefined（调用方自行决定是否报错）。
 */
export function resolveApp() {
  const candidates = [process.env.DSH_APP, ...[...installRoots(), ...rootsFromWindowsRegistry()].map((root) => appAt(root))]
    .filter((value) => typeof value === 'string' && value.length > 0)
  return candidates.find((path) => existsSync(path))
}

/** CLI 在 asar 内 → 必须交给 Electron 以 Node 模式运行；否则直接用 node。 */
export function launchCommand(cli) {
  if (!cli.includes('.asar')) return { command: process.execPath, prefix: [] }
  const app = resolveApp()
  if (app === undefined) {
    throw new Error('CLI 位于 app.asar 内，需要 Electron 来执行：请设置 DSH_APP=<DeepSeek Harness 可执行文件>')
  }
  return { command: app, prefix: [] }
}

/**
 * 试运行用的沙箱 profile 是否已初始化。
 *
 * 这些 harness 脚本按 `--profile mmtest` 启动，而那个 profile 是**一次性前置步骤**建出来的
 * （见 tests/README 第 2 节）。全新 clone 没有它，dsh 会抛一大段 asar 内部堆栈 —— 这里
 * 提前拦住并给出可照抄的初始化命令。
 *
 * @param {string} name - profile 名，默认 mmtest。
 * @returns {string|undefined} 通过时返回 undefined，否则返回给人看的说明。
 */
export function profileHint(name = 'mmtest') {
  const manifest = join(DSH_HOME, 'profiles', name, 'package.json')
  if (existsSync(manifest)) return undefined
  return (
    '沙箱 profile "' + name + '" 尚未初始化（找不到 ' + manifest + '）。\n' +
    '这些脚本需要真实 harness，先按 tests/README 第 2 节建一次（只需一次）：\n' +
    '  set DSH_HOME=' + DSH_HOME + '\n' +
    '  "%DSH_APP%" "%DSH_CLI%" plugin --profile ' + name + ' add "' + PACKAGE_ROOT + '"\n' +
    '不需要真实 harness 的验证请直接跑：node --import ./tests/register.mjs ./tests/run.mjs'
  )
}

