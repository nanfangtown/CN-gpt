/**
 * subagent_code / subagent_research —— 两条窄委派工具（2026-10-18 起由插件自己注册）。
 *
 * ## 为什么不再用 tool-subagent 行
 * 2026-10-18 事故：桌面端在「插件页 → 启用 CN-gpt」时热重载，profile 里**新插入**的
 * `tool-subagent-code` / `tool-subagent-research` 两行直接在启动审计里报
 *   `RemoteError: Unknown agent preset: mm-code`
 *   `RemoteError: Unknown agent preset: mm-research`
 * 而同一批插入的 `preset-mm-code` / `preset-mm-research` 本身是好的 —— 读图员
 * （插件用 `startActivation` 自己注册、**调用时**才解析 preset）一直可用。
 *
 * 根因（读 dsh-tool-subagent 0.2.1 源码确认）：`agentPreset` 是**装配期**校验的 ——
 *   `apply()` → `SubagentPresetSelection.validate()` → `agentPresets.readDocument(id)`
 * 而 `@deepseek-ai/dsh-agent-preset` 的注册是**激活期**异步完成的
 *   `Service.init` → `agentPresets.register(config)`
 * 热重载时 `recomposeProfile()` 会把整棵树并发重启（`EntryGroup.update` 用 `Promise.all`），
 * 新插入的 preset 行还没走到 `register()`，委派行已经 `apply()` 并查找 preset 了。
 * 冷启动时导入顺序恰好让 preset 先注册，所以本地/测试里看不出来 —— 这是一个
 * **只在首次热重载出现**的竞态，不是配置写错，重试一次就能好，但下次还会犯。
 *
 * ## 现在怎么做
 * 与 `tools/reader.mjs` 同一条路：工具由插件注册，`agentPreset` 在**调用时**才交给
 * `subagents.startActivation()`。装配期不再存在"preset 还不存在"的窗口。
 * 顺带把描述写清楚（stock 工具的文案与 `subagent` 逐字相同，模型分不出三者）。
 *
 * ## 有意不做
 * 不做模型选择（`list_subagent_models` / `agent_preset` 枚举）：窄委派的卖点是
 * "工具面收窄 + 少一层配置"，多一个可选模型只会让子代理更容易跑偏。
 * 路由默认继承父代理；`subagent_script` 例外，可按 Config 注入 minimax 路线 ——
 * 预检不过时**会明确告诉你原因**并回落父路线（2026-11-11 起不再静默）。
 * 工具面由 `preset-mm-code` / `preset-mm-research` 决定。
 *
 * ## 失败语义
 * 与官方工具一致：参数错误、服务缺失都在**派出前**抛错（不消耗一次子代理创建）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError } from '../core/errors.mjs'

/**
 * 两条窄委派的差异只有 preset 与文案，其余完全共用。
 * preset 字段名指向 Config（可热改），所以这里存**字段名**而不是值。
 */
const DELEGATION_SPECS = Object.freeze([
  Object.freeze({
    tool: 'subagent_code',
    presetField: 'codeAgentPreset',
    fallbackPreset: 'mm-code',
    route: 'parent',
    label: '执行子代理',
    description:
      '核心编码子代理（{preset}）：把需要设计与判断的编码任务交给独立子代理（工具面只有命令 + 文件读写 + 查找）。'
      + '适合：模块/接口设计、跨文件重构、根因分析、算法改造。'
      + '脚本层任务（跑构建/测试到绿、批量机械改动）请改用 subagent_script。'
      + '返回子代理 id，结论稍后送达；几行能改完的不必委派。',
    promptDescription:
      '完整的编码任务说明：要改什么、验收标准是什么、哪些边界不能碰。子代理不共享当前对话，所以它需要的信息都要写进来。',
  }),
  Object.freeze({
    tool: 'subagent_script',
    presetField: 'scriptAgentPreset',
    fallbackPreset: 'mm-code',
    route: 'script',
    label: '脚本子代理',
    description:
      '脚本子代理（{preset}）：机械 / 多轮 / 大输出的活交给它——跑构建或测试到绿、装依赖、排查环境、'
      + '批量重命名 / 替换 / 加注释 / 格式化、生成一次性脚本、数据转换与批量抓取。'
      + '工具面只有命令 + 文件读写 + 查找，不做设计判断。'
      + '**不要**把模块设计、接口重构、根因分析、算法改造交给它——那些用 subagent_code 或主代理自己做。'
      + '返回子代理 id，结论稍后送达。',
    promptDescription:
      '完整的执行说明：跑什么命令 / 改哪些路径、判定成功的标准、失败时允许试到哪一步。',
  }),
  Object.freeze({
    tool: 'subagent_research',
    presetField: 'researchAgentPreset',
    fallbackPreset: 'mm-research',
    label: '资料子代理',
    description:
      '资料子代理（{preset}）：把需要检索与交叉验证的问题交给只读的研究子代理——它只有只读文件 + 网页检索 / 抓取，'
      + '不改文件、不跑命令，返回结论与来源链接。适合：查文档、比对版本行为、核实外部事实、收集多来源资料。'
      + '调用立刻返回子代理 id，结论稍后以消息送达。',
    promptDescription:
      '完整的检索问题：要查什么、判断标准是什么、需要哪些来源。子代理不共享当前对话，所以背景与约束都要写进来。',
  }),
])

/**
 * 读出当前生效的 preset id（Config 字段可能被热改）。
 * @param {object} config - liveConfig Proxy。
 * @param {object} spec - DELEGATION_SPECS 的一项。
 * @returns {string} preset id。
 */
function presetOf(config, spec) {
  const value = config[spec.presetField]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : spec.fallbackPreset
}

/**
 * 读一个配置值，去空后当字符串用。
 * @param {unknown} value - 配置值（liveConfig 里可能是普通值）。
 * @returns {string} 去空字符串；非字符串一律当空。
 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把可能很长的错误压成一行可读文本（换行折成空格、限长）。
 * @param {unknown} error - 抛出的错误。
 * @param {number} [max] - 最大字符数。
 * @returns {string} 一行文本（永不为空）。
 */
function oneLine(error, max = 160) {
  const raw = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim()
  if (raw.length === 0) return '未知原因'
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw
}

/**
 * 脚本层子代理的模型路线**决定**（不只是路线）。
 *
 * 2026-11-11：预检失败以前是**静默**回落父路线 —— 工具返回永远同一句话、
 * 日志里也没有痕迹。于是"以为在花订阅额度、实际在花主路线 token"在插件里
 * 没有任何观测点；而它在花钱路径上的原则恰恰是 fail-closed + 可见。
 *
 * 现在每条分支都返回结构化决定（applied / code / reason），由调用方写进
 * 工具结果并记日志 —— 路由可以回落，但**不允许悄悄回落**。
 *
 * code 取值：
 *   - `applied`     预检通过，已注入；
 *   - `unverified`  拿不到 `llm.resolveCallConfig`，没法预检，仍按配置注入；
 *   - `disabled`    `scriptRouteEnabled=false`（配置里显式关掉，属正常状态）；
 *   - `incomplete`  `scriptProvider` / `scriptModel` 有一个是空的（写漏）；
 *   - `unresolved`  预检抛错（provider 未注册 / 模型不在清单 / 会话不允许…）。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} config - liveConfig Proxy。
 * @returns {Promise<{ applied: boolean, code: string, route?: object, reason?: string }>} 决定。
 */
async function scriptRouteDecision(ctx, config) {
  if (config.scriptRouteEnabled === false) {
    return { applied: false, code: 'disabled', reason: 'scriptRouteEnabled=false' }
  }
  const provider = textOf(config.scriptProvider)
  const model = textOf(config.scriptModel)
  if (provider === '' || model === '') {
    return { applied: false, code: 'incomplete', reason: 'scriptProvider / scriptModel 有一个是空的' }
  }
  const effort = textOf(config.scriptReasoningEffort)
  const route = { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') {
    // 拿不到预检能力就照常注入：路由本身可能是好的，只是没法提前验证 —— 但要标出来。
    return { applied: true, code: 'unverified', route, reason: '拿不到 llm.resolveCallConfig，未做预检' }
  }
  try {
    await llm.resolveCallConfig({ ...route })
  } catch (error) {
    return { applied: false, code: 'unresolved', route, reason: oneLine(error) }
  }
  return { applied: true, code: 'applied', route }
}

/**
 * 把路由决定渲染成一句话（工具结果显示给模型/用户的那一行）。
 * @param {object} [route] - 工具结果里的 route 字段。
 * @returns {string} 片段（没有 route 时为空串）。
 */
function routeLine(route) {
  if (route === undefined || route === null) return ''
  const label = (route.provider ?? '?') + ' / ' + (route.model ?? '?')
  if (route.code === 'disabled') return '模型路线：继承父会话（scriptRouteEnabled=false）。'
  if (route.applied === true) {
    if (route.code === 'unverified') return '模型路线：' + label + '（未预检：' + (route.reason ?? '') + '）。'
    return '模型路线：' + label + '。'
  }
  const target = route.provider === undefined ? '' : '本想走 ' + label + '，'
  // "无需重试"必须写在这里：描述里加这句话会超 schema 预算（每个请求都要发），
  // 而模型真正需要它的时刻就是拿到这条结果的时候。
  return '⚠ 未注入模型路线（' + target + route.code + '：' + (route.reason ?? '') + '）；本次按父会话路线执行，无需重试。'
}

/**
 * 注册两条窄委派工具。
 * @param {object} deps - ctx / config（liveConfig Proxy）。
 * @returns {object[]} 工具定义数组。
 */
export function createDelegationTools(deps) {
  const { ctx, config, logger } = deps

  return DELEGATION_SPECS.map((spec) => {
    // preset id 来自 Config（可热改），不要在描述里写死 mm-code / mm-research。
    const preset = presetOf(config, spec)
    /**
     * 路由决定落到日志：只有"本该注入却没注入"才 warn，显式关闭只记 debug。
     * @param {object} [decision] - scriptRouteDecision 的结果。
     */
    const noteRoute = (decision) => {
      if (decision === undefined || decision.applied === true) return
      const detail = '[mm-models] ' + spec.tool + ' 未注入模型路线（' + decision.code + '）：'
        + (decision.reason ?? '') + '；子代理按父会话路线派出。'
      if (decision.code === 'disabled') logger?.debug?.(detail)
      else logger?.warn?.(detail)
    }
    return defineTool({
      name: spec.tool,
      description: spec.description.replaceAll('{preset}', preset),
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: '3-5 个词的任务名，用于在界面上显示（例如「修登录超时」「查 SSE 断连原因」）。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: spec.promptDescription,
      },
      cwd: {
        type: 'string',
        description: '子代理的工作目录（可选）；省略则继承当前会话。相对路径按它解析。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
          // 只有 subagent_script 才有：实际模型路线（含"没注入成功"的原因）。
          route: {
            type: 'object',
            additionalProperties: false,
            properties: {
              applied: { type: 'boolean', required: true },
              code: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已派出' + spec.label + '：' + value.subagentId + '。' + routeLine(value.route) + '结论稍后以消息送达。',
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      if (prompt.length === 0) {
        throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：prompt 不能为空。**本次未派出子代理。**')
      }
      if (description.length === 0) {
        throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：description 不能为空。**本次未派出子代理。**')
      }

      const parent = exec?.agent
      if (parent === undefined || parent === null) {
        throw new MediaError(CODES.UNKNOWN, '窄委派工具需要调用方 agent（exec.agent 未定义）')
      }

      const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
      if (subagents === undefined || typeof subagents.startActivation !== 'function') {
        throw new MediaError(
          CODES.UNKNOWN,
          'subagents 服务不可用：dsh-subagent 未加载，' + spec.tool + ' 无法派出子代理。**本次未派出子代理。**',
        )
      }
      if (typeof subagents.getProvider === 'function' && subagents.getProvider('spawn') === undefined) {
        throw new MediaError(
          CODES.UNKNOWN,
          'spawn 提供方未注册：dsh-subagent 的本地 spawn 后端未加载，' + spec.tool + ' 无法派出子代理。**本次未派出子代理。**',
        )
      }

      const maxDepth = Number(config.delegationMaxDepth)
      const request = {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        agentPreset: presetOf(config, spec),
        ...(typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? { cwd: args.cwd.trim() } : {}),
        ...(Number.isFinite(maxDepth) && maxDepth > 0 ? { maxDepth } : {}),
      }

      // 模型路由：只有标了 route: 'script' 的工具才注入 agentOptions。
      // 预检不过就不加这个字段 —— 子代理照父路线派出，工具不会因此不可用；
      // 但**不允许静默**：决定同时进日志与工具结果（2026-11-11）。
      let decision
      if (spec.route === 'script') {
        decision = await scriptRouteDecision(ctx, config)
        noteRoute(decision)
        if (decision.applied === true) request.agentOptions = decision.route
      }

      // 同 tools/reader.mjs：0.2.2-rc.2 起 `startActivation` 收扁平 spec，
      // `request` 嵌套是旧形状；两代都传，避免升级后再踩一次。
      const activation = await subagents.startActivation({
        ...request,
        provider: 'spawn',
        label: description,
        request,
        signal: exec.signal,
        delivery: 'parent',
      })
      const childId = activation?.childId
      if (typeof childId !== 'string' || childId.length === 0) {
        throw new MediaError(
          CODES.UNKNOWN,
          '派出' + spec.label + '失败：subagents.startActivation 没有返回 childId',
        )
      }
      return {
        kind: 'activation',
        subagentId: childId,
        ...(decision === undefined
          ? {}
          : {
              route: {
                applied: decision.applied === true,
                code: decision.code,
                ...(decision.route === undefined
                  ? {}
                  : { provider: decision.route.provider, model: decision.route.model }),
                ...(decision.reason === undefined ? {} : { reason: decision.reason }),
              },
            }),
      }
    },
    })
  })
}
