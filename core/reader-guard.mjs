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
  const violations = []
  for (const { file, id, block } of readerRowBlocks(options)) {
    const allowMatch = /allow:\s*\[([^\]]*)\]/.exec(block)
    if (allowMatch === null) continue // 没有 allow（可能是 deny 写法）→ 不在这里判
    const allow = allowMatch[1].split(',').map((name) => name.trim()).filter((name) => name.length > 0)
    const reason = readerFilterViolation(allow)
    if (reason !== undefined) violations.push({ file, id, allow, reason })
  }
  return violations
}

/**
 * 读图员路由的**兜底**白名单（当契约文件扫不出路由时才用）。
 * 正常路径是靠 `inspectReaderRoutes()` 从读图行自己的 `agentOptions` 里读，
 * 所以用户把 provider 改名也不会把读图员一起弄瞎。
 */
export const READER_FALLBACK_PROVIDERS = Object.freeze(['glm', 'qwen-vl'])
export const READER_FALLBACK_MODEL_PREFIXES = Object.freeze(['glm-4', 'qwen3-vl', 'qwen-vl'])

/** 从一个行里抠出 `toolFilter.allow` 列表；没有 allow 写法时返回 null。 */
function allowListOf(block) {
  const match = /allow:\s*\[([^\]]*)\]/.exec(block)
  if (match === null) return null
  return match[1].split(',').map((name) => name.trim()).filter((name) => name.length > 0)
}

/**
 * 去掉整行注释，再拿去抠配置值。
 *
 * ⚠ 实测踩过：读图行的注释里就写着"规划原文写 `maxDepth: 0`（……）"，
 * 不排除注释的话，抠出来的 maxDepth 是注释里的 0 —— 启动自检会误报
 * "读图员行 maxDepth=0 < 2"，而真实取值明明是 2（2026-10-16 实测）。
 */
function stripComments(block) {
  return block
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

/**
 * 把一个配置文件切成"行块"（`- id: X` 到下一个**同级或更浅**的列表项）。
 *
 * ⚠ 两个坑（都实测踩过）：
 *   1. 缩进不能假设：读图行在插件自带 patch 里缩进 4 空格，在装配产物 `cordis.yml` 里
 *      嵌在 `insert:` 列表里、更深；
 *   2. 终结符不能只找 `- id:` —— patch 里 `- id: llm-pi-ai` 后面紧跟的是 `- insert:`
 *      （也是同级列表项），只找 `- id:` 会让第一行把整份文件吞掉，
 *      于是它凭空多出 `agentOptions` / `allow`，被误判成读图行（2026-10-16 实测）。
 *      所以凡是同级或更浅的 `- ` 列表项都算边界。
 */
function rowBlocksOf(text) {
  const rows = []
  const pattern = /(^|\n)([ \t]*)- id: ([A-Za-z0-9_.@/-]+)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[1].length
    const indent = match[2].length
    const rest = text.slice(start)
    const scanner = /(^|\n)([ \t]*)- /g
    let end = -1
    let next
    while ((next = scanner.exec(rest)) !== null) {
      if (next.index === 0) continue
      if (next[2].length <= indent) {
        end = next.index
        break
      }
    }
    rows.push({ id: match[3], block: end < 0 ? rest : rest.slice(0, end) })
  }
  return rows
}

/**
 * 扫描候选文件，产出每一处**读图行**（file / id / 该行文本）。
 *
 * 判定不再只看写死的两个 row id：**"toolFilter.allow 里放了 read_image"的行也算读图行**
 * （再要求它确实是 `dsh-tool-subagent` 的实例，避免把别的行误判进来）。
 * 2026-10-15 修：起因是 `blockSubagentNativeVision` 必须精确认出读图员，
 * 而只认 id 会让"改过 id / 自定义的读图行"认不出来 —— 那会导致通用子代理被屏蔽时
 * 连真正的读图员也一起被屏蔽（判错的代价是整条看图链路失效）。
 * 保留 id 名单是为了兼容"用 deny 写法"的已知读图行（那种行扫不到 allow）。
 */
function readerRowBlocks(options = {}) {
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const found = []
  for (const file of candidateFiles(dshHome)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const row of rowBlocksOf(text)) {
      const allow = allowListOf(row.block)
      const handsOutImage =
        allow !== null && allow.includes(READER_ALLOWED_TOOLS[0]) && row.block.includes('dsh-tool-subagent')
      if (READER_ROW_IDS.includes(row.id) || handsOutImage) found.push({ file, id: row.id, block: row.block })
    }
  }
  return found
}

/**
 * 从读图行里读出它实际使用的路由（`agentOptions: { provider, model }`）。
 *
 * 为什么要读它：`blockSubagentNativeVision`（屏蔽通用子代理的原生读图）必须
 * **精确认出读图员**——判错的代价是把读图员一起弄瞎，而那是不可接受的。
 * 硬编码 provider 名会在用户改名时静默失效，所以判别依据取自**契约文件本身**
 * （与 toolFilter 自检同一个单一事实源），扫不出来时才回落到兜底白名单。
 *
 * 支持两种写法：流式 `agentOptions: { provider: glm, model: glm-4.6v }`
 * 与块式（`agentOptions:` 换行后 `provider:` / `model:`）。扫不到就跳过，不误报。
 *
 * @param {object} [options] - 同 `inspectReaderFilters`。
 * @returns {{ file: string, id: string, provider?: string, model?: string }[]}
 */
export function inspectReaderRoutes(options = {}) {
  const routes = []
  for (const { file, id, block } of readerRowBlocks(options)) {
    // ⚠ 一切取值都必须在**去掉注释**的文本上做（注释里常有示例值，见 stripComments）。
    const code = stripComments(block)
    const flow = /agentOptions:\s*\{([^}]*)\}/.exec(code)
    const scope = flow === null ? code.slice(code.indexOf('agentOptions:')) : flow[1]
    if (scope === undefined || scope.length === 0) continue
    const provider = /\bprovider:\s*['"]?([A-Za-z0-9_.-]+)['"]?/.exec(scope)?.[1]
    const model = /\bmodel:\s*['"]?([A-Za-z0-9_.-]+)['"]?/.exec(scope)?.[1]
    if (provider === undefined && model === undefined) continue
    // maxDepth 也要读出来：它决定"已委派的子代理能不能调这个读图员"（< 2 就会被拒），
    // 是 `blockSubagentNativeVision` 能不能安全打开的前提之一，启动自检要用。
    const rawDepth = /\bmaxDepth:\s*['"]?([A-Za-z0-9_-]+)['"]?/.exec(code)?.[1]
    const maxDepth = rawDepth === undefined ? undefined : /^\d+$/.test(rawDepth) ? Number(rawDepth) : rawDepth
    routes.push({
      file,
      id,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
    })
  }
  return routes
}

/**
 * 这个 agent 是不是"读图员"（而不是通用子代理）？
 * 判据来自读图行的 `agentOptions`（provider 或 model 命中任一个即可）。
 *
 * @param {object} agent - 宿主 agent 对象（读 `agent.options`）。
 * @param {{providers: string[], modelPrefixes: string[]}} routes - 由 inspectReaderRoutes 汇总的白名单。
 * @returns {boolean}
 */
export function isReaderAgent(agent, routes) {
  const provider = agent?.options?.provider
  if (typeof provider === 'string' && routes.providers.includes(provider)) return true
  const model = agent?.options?.model
  if (typeof model === 'string' && routes.modelPrefixes.some((prefix) => model.startsWith(prefix))) return true
  return false
}

/**
 * 汇总"读图员路由白名单"：契约文件里扫到的路由 ∪ 兜底白名单。
 * @param {object} [options] - 同 `inspectReaderFilters`。
 * @returns {{ providers: string[], modelPrefixes: string[], routes: object[] }}
 */
export function mergeReaderRoutes(routes) {
  const providers = new Set(READER_FALLBACK_PROVIDERS)
  const modelPrefixes = new Set(READER_FALLBACK_MODEL_PREFIXES)
  for (const route of routes) {
    if (typeof route.provider === 'string' && route.provider.length > 0) providers.add(route.provider)
    if (typeof route.model === 'string' && route.model.length > 0) modelPrefixes.add(route.model)
  }
  return { providers: [...providers], modelPrefixes: [...modelPrefixes], routes }
}

/**
 * 从契约文件里扫出的路由 + 兜底白名单。
 *
 * ⚠ 2026-10-17 起读图工具由插件自己注册（`tools/reader.mjs`），路由的**单一事实源
 * 变成 Config**；这里保留是因为旧装配/别的 profile 里可能还有 tool-subagent 行。
 * 新代码请用 `mergeReaderRoutes()` 把 Config 路由与扫描结果合并。
 */
export function readerRouteAllowlist(options = {}) {
  return mergeReaderRoutes(inspectReaderRoutes(options))
}
