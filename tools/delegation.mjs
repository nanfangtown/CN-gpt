/**
 * subagent_code / subagent_research —— 两条窄委派工具（2026-10-18 起由插件自己注册）。
 *
 * ## 为什么不再用 tool-subagent 行
 * 2026-10-18 事故：桌面端在「插件页 → 启用 gpt-CN」时热重载，profile 里**新插入**的
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
 * 路由继承父代理；工具面由 `preset-mm-code` / `preset-mm-research` 决定。
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
    label: '执行子代理',
    description:
      '执行子代理（{preset}）：把一件具体的执行任务交给独立子代理——它只有命令 + 文件读写 + 查找三种工具，'
      + '专注做完一件事后返回结论与证据。适合：批量改文件、跑构建 / 测试、探查仓库结构、按清单做机械改动。'
      + '调用立刻返回子代理 id，结论稍后以消息送达；主代理自己一条命令就能做完的事不必委派。',
    promptDescription:
      '完整的执行任务说明：做什么、改哪个路径、验收标准。子代理不共享当前对话，所以它需要的信息都要写进来。',
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
 * 注册两条窄委派工具。
 * @param {object} deps - ctx / config（liveConfig Proxy）。
 * @returns {object[]} 工具定义数组。
 */
export function createDelegationTools(deps) {
  const { ctx, config } = deps

  return DELEGATION_SPECS.map((spec) => {
    // preset id 来自 Config（可热改），不要在描述里写死 mm-code / mm-research。
    const preset = presetOf(config, spec)
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
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已派出' + spec.label + '：' + value.subagentId + '。结论稍后以消息送达。',
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

      const activation = await subagents.startActivation({
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
      return { kind: 'activation', subagentId: childId }
    },
    })
  })
}
