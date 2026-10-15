/**
 * 试运行共用小件：从 ~/.dsh/.env 补齐 key（dsh 自己启动时会加载那份 .env，
 * 但这些 e2e 脚本是在 dsh 之外跑的，需要自己补一遍）。
 *
 * 只把"进程里没有、.env 里有"的键补进 process.env；绝不打印值。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 极简 KEY=VALUE 解析：忽略注释与空行，去掉成对引号。 */
export function parseEnvFile(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values[trimmed.slice(0, eq).trim()] = value
  }
  return values
}

/**
 * 把 ~/.dsh/.env 里的键补进 process.env（不覆盖已有的）。
 * @param {string[]} names - 需要补齐的键名。
 * @returns {{ loaded: string[], source: string|undefined }} 实际补齐的键与来源路径。
 */
export function loadKeysFromDshEnv(names) {
  const path = join(homedir(), '.dsh', '.env')
  let values = {}
  try {
    values = parseEnvFile(readFileSync(path, 'utf8'))
  } catch {
    return { loaded: [], source: undefined }
  }
  const loaded = []
  for (const name of names) {
    if ((process.env[name] ?? '').trim().length > 0) continue
    const value = (values[name] ?? '').trim()
    if (value.length === 0) continue
    process.env[name] = value
    loaded.push(name)
  }
  return { loaded, source: path }
}

/** 哪些 key 已就绪（只回名字，不回值）。 */
export function readyKeys(names) {
  return names.filter((name) => (process.env[name] ?? '').trim().length > 0)
}

/**
 * e2e 的"显式跳过"出口 —— 让"跳过"和"通过"在自动化里可区分。
 *
 * 背景（2026-10-13 审计）：这些 e2e 以前在缺 key 时打印一行"跳过：…"然后
 * `process.exit(0)`，于是**对 CI 而言它与通过完全一样**。4/5 个 e2e 在无 key
 * 的机器上会静默空转，绿灯毫无意义。
 *
 * 现在的行为：
 *   - 默认：打印 `SKIPPED: <原因>` 并以 0 退出（保留本地手工跑的便利）；
 *   - 设 `DSH_E2E_STRICT=1`：改为以 78 退出（EX_CONFIG），CI 或任何"我必须确认
 *     这些真的跑过"的场合都该用它。
 *
 * @param {string} reason - 跳过原因（会原样打印）。
 * @param {string[]} [missing] - 缺失的 key 名（只打印名字，绝不打印值）。
 * @returns {never} 直接结束进程。
 */
export function skipE2e(reason, missing = []) {
  const tail = missing.length === 0 ? '' : `（缺：${missing.join(', ')}）`
  console.log(`SKIPPED: ${reason}${tail}`)
  if ((process.env.DSH_E2E_STRICT ?? '').trim() === '1') {
    console.error('DSH_E2E_STRICT=1：缺前置条件的 e2e 视为失败（退出码 78）。')
    process.exit(78)
  }
  process.exit(0)
}
