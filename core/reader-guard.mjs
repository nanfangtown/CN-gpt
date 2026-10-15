/**
 * 读图子代理的"物理阉割"契约（2026-10-13）。
 *
 * 背景：以前读图子代理的 toolFilter 放行 read / read_image / glob / grep / web_search，
 * 于是主模型会把"看看这个仓库""查一下配置"这类本地活派给子代理；子代理看不到本地环境，
 * 只能反复试错，白白烧掉上下文。现在只放行读图工具，从物理上切断环境探查。
 *
 * 这个模块是那份契约的**单一事实源**：cordis.patch.yml 里两个读图行的 toolFilter
 * 必须与它一致，启动时会自检并在日志里告警（只告警、不改配置、不拦启动）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 读图子代理唯一被允许的工具：它得能看图，别的都不给。 */
export const READER_ALLOWED_TOOLS = Object.freeze(['read_image'])

/** 读图子代理**绝不允许**出现的工具（一旦出现就是环境探查能力漏了）。 */
export const READER_FORBIDDEN_TOOLS = Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'run_code', 'web_search', 'web_fetch'])

/** 读图子代理行的 entry id。 */
export const READER_ROW_IDS = Object.freeze(['tool-subagent-glm', 'tool-subagent-qwen'])

/** 契约里的 toolFilter 形状。 */
export const READER_TOOL_FILTER = Object.freeze({ allow: [...READER_ALLOWED_TOOLS] })

/** 判断一份 toolFilter 是否满足契约；返回人话原因或 undefined。 */
export function readerFilterViolation(allow) {
  if (!Array.isArray(allow)) return 'toolFilter.allow 缺失或不是数组'
  const extra = allow.filter((name) => !READER_ALLOWED_TOOLS.includes(name))
  if (extra.length > 0) {
    const dangerous = extra.filter((name) => READER_FORBIDDEN_TOOLS.includes(name))
    return (
      'toolFilter.allow 多放了 ' + extra.join(', ') +
      (dangerous.length > 0 ? '（其中 ' + dangerous.join(', ') + ' 属于本地环境探查能力，等于把阉割又接回去了）' : '')
    )
  }
  const missing = READER_ALLOWED_TOOLS.filter((name) => !allow.includes(name))
  if (missing.length > 0) return 'toolFilter.allow 少了 ' + missing.join(', ') + '（读图员会看不到图片）'
  return undefined
}

/** 收集候选配置文件：本包自带的 bundle patch + 当前 DSH home 下各 profile 的配置。 */
function candidateFiles(dshHome) {
  // 本包自带的 patch 是契约源头，无论跑在哪个 profile 都该受检。
  const files = [join(dirname(dirname(fileURLToPath(import.meta.url))), 'cordis.patch.yml')]
  const profilesDir = join(dshHome, 'profiles')
  if (existsSync(profilesDir)) {
    for (const profile of readdirSync(profilesDir)) {
      for (const name of ['cordis.yml', 'cordis.patch.yml']) {
        const path = join(profilesDir, profile, name)
        if (existsSync(path)) files.push(path)
      }
    }
  }
  return files
}

/**
 * 扫描 profile 配置文件，检查读图子代理行是否仍满足"只看图"契约。
 *
 * 用文本扫描而不是 YAML 解析：这里只需要判断"某个 tool-subagent 行的 allow 列表里
 * 有没有出现不该出现的工具"，不值得为此给插件再加一个 YAML 依赖。
 * 找不到任何读图行时返回空数组（例如另一个 profile 或装配方式不同），不误报。
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - Harness home；默认 $DSH_HOME 或 ~/.dsh。
 * @returns {{ file: string, id: string, allow: string[], reason: string }[]} 违规清单。
 */
export function inspectReaderFilters(options = {}) {
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const violations = []
  for (const file of candidateFiles(dshHome)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const id of READER_ROW_IDS) {
      // 定位 "- id: <reader>" 之后、下一个同级 "- id:" 之前的那一段。
      const start = text.indexOf('- id: ' + id)
      if (start < 0) continue
      const rest = text.slice(start)
      const nextRow = rest.slice(1).search(/\n- id: /)
      const block = nextRow < 0 ? rest : rest.slice(0, nextRow + 1)
      const allowMatch = /allow:\s*\[([^\]]*)\]/.exec(block)
      if (allowMatch === null) continue // 没有 allow（可能是 deny 写法）→ 不在这里判
      const allow = allowMatch[1].split(',').map((name) => name.trim()).filter((name) => name.length > 0)
      const reason = readerFilterViolation(allow)
      if (reason !== undefined) violations.push({ file, id, allow, reason })
    }
  }
  return violations
}
