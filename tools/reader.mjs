/**
 * ask_glm / ask_qwen —— 读图员（2026-10-17 起由插件自己注册）。
 *
 * ## 为什么不再用 tool-subagent 行
 * `@deepseek-ai/dsh-tool-subagent` 的 Config 是**封闭的 7 键**
 * （provider / toolName / modelSelectionSettings / agentOptions /
 *   agentPreset / allowedAgentPresets / maxDepth），**没有 description**；
 * 工具描述由 `providerWording()` 拼死。后果：模型在 40+ 个工具里看到两个与
 * `subagent` 逐字相同的描述，完全看不出 `ask_glm` 是"读图"——
 * 这件事只能靠系统提示词那段"【读图路由】"兜着，提示词一关就彻底不可发现。
 *
 * ## 现在怎么做
 * 用 `ctx.subagents.startActivation()` 自己注册。这条路与官方实现完全相同
 * （见 dsh-tool-subagent/lib/index.js 的 `mount()`）：
 *   request = { prompt, parent, agentPreset, agentOptions, maxDepth }
 *   startActivation({ provider: 'spawn', label, request, signal, delivery: 'parent' })
 *   return { kind: 'activation', subagentId }
 *
 * 子代理仍然走 preset（默认 `mm-reader`）：persona 与"只有 read_image"
 * 的物理阉割不变，变的只是"谁注册这个工具、描述怎么写"。
 *
 * ## 有意不做
 * 官方的模型选择（`list_subagent_models` / `agent_preset` 枚举）与 steering
 * 之外的能力，读图员不需要。少一层就少一处随宿主漂移的面。
 *
 * ## 失败语义
 * 与官方工具一致：**参数错误在派出前就抛**（不消耗一次子代理创建）；
 * 服务缺失给出点名错误（`subagents` / `spawn` 提供方），而不是静默返回。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError } from '../core/errors.mjs'

/** 没给 question 时的默认要求。 */
const DEFAULT_QUESTION =
  '描述这张图片：画面内容、可读文字（原样摘录）、界面元素与布局。看不清的地方直说"看不清"。'

/** 子代理收到的最小指令模板（persona 已在 preset 里，不重复身份声明）。 */
const PROMPT_TEMPLATE = [
  '读取下面这张图片并按要求回答。',
  '图片路径：{path}',
  '问题：{question}',
  '',
  '要求：',
  '- 用 read_image 读这个路径；读不到就如实说明错误，不要猜。',
  '- 先给结论，再给支撑细节；可读文字原样摘录。',
  '- 看不清就说看不清，不要补全。',
].join('\n')

/**
 * 两个读图员的差异只有路由与文案，其余完全共用。
 * 路由字段名指向 Config（可热改），所以这里存**字段名**而不是值。
 *
 * ⚠ 描述里的 `{model}` 在注册时用 Config 的当前值替换 —— 不要在文案里写死型号。
 *   2026-10-17 踩过：描述写死 `GLM-4.6V`，而配置默认已经换成 `glm-5.3-flash`，
 *   结果工具自称 4.6V、实际调 5.3-flash（用户一眼就看出来了）。
 */
const READER_SPECS = Object.freeze([
  Object.freeze({
    tool: 'ask_glm',
    providerField: 'readerGlmProvider',
    modelField: 'readerGlmModel',
    fallbackLabel: 'GLM 视觉',
    description:
      '读图（{model}）：把本地图片 / 截图 / 图表 / 手写件的路径交给它，返回结构化文字结论'
      + '（画面内容、可读文字、界面元素、图表读数、布局）。**图像识别 / 分析 / 审查一律用它**——'
      + '不要靠文件名或上下文猜图，也不要用 read 去读二进制图片。调用会派出一个只读子代理并立刻返回 id，'
      + '结论稍后以消息送达（通常几秒到几十秒）。与 ask_qwen 二选一。',
  }),
  Object.freeze({
    tool: 'ask_qwen',
    providerField: 'readerQwenProvider',
    modelField: 'readerQwenModel',
    fallbackLabel: 'Qwen-VL',
    description:
      '读图（{model}）：把本地图片 / 截图 / 图表的路径交给它，返回结构化文字结论'
      + '（中文界面、密集文字、表格读数较强）。**图像识别 / 分析 / 审查一律用它**——'
      + '不要靠文件名或上下文猜图，也不要用 read 去读二进制图片。调用会派出一个只读子代理并立刻返回 id，'
      + '结论稍后以消息送达（通常几秒到几十秒）。与 ask_glm 二选一。',
  }),
])

/**
 * 组装给子代理的 prompt。
 * @param {{imagePath?: string, question?: string, prompt?: string}} input - 入参。
 * @returns {string} 文本。
 */
function buildPrompt({ imagePath, question, prompt }) {
  if ((imagePath === undefined || imagePath.length === 0) && typeof prompt === 'string' && prompt.length > 0) {
    return prompt
  }
  return PROMPT_TEMPLATE
    .replace('{path}', imagePath)
    .replace('{question}', question === undefined || question.length === 0 ? DEFAULT_QUESTION : question)
}

/**
 * 注册两个读图员工具。
 * @param {object} deps - ctx / config（liveConfig Proxy）。
 * @returns {object[]} 工具定义数组。
 */
export function createReaderTools(deps) {
  const { ctx, config } = deps

  return READER_SPECS.map((spec) => {
    // 型号从 Config 读（缺省/空串时回落到家族名），不要在文案里写死。
    const configuredModel = config[spec.modelField]
    const label = typeof configuredModel === 'string' && configuredModel.trim().length > 0
      ? configuredModel.trim()
      : spec.fallbackLabel
    return defineTool({
      name: spec.tool,
      description: spec.description.replaceAll('{model}', label),
      parameters: {
        image_path: {
          type: 'string',
          description: '图片文件的路径：绝对路径，或相对当前会话工作目录。推荐用法（png/jpg/webp/gif/bmp/tiff/heic/avif）。',
        },
        question: {
          type: 'string',
          description: '想问的问题（可选）。留空则要求描述画面内容与可读文字。',
        },
        prompt: {
          type: 'string',
          description: '（兼容/兜底）完整任务描述。提供它时可省略 image_path 与 question，原样交给读图员。',
        },
        cwd: {
          type: 'string',
          description: '子代理的工作目录（可选）；省略则继承当前会话。相对图片路径按它解析。',
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
        render: (_args, value) => [{ type: 'text', text: `已派出读图员（${label}）：${value.subagentId}。结论稍后以消息送达。` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
      const imagePath = typeof args.image_path === 'string' ? args.image_path.trim() : ''
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      const freeform = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (imagePath.length === 0 && freeform.length === 0) {
        throw new MediaError(
          CODES.BAD_REQUEST,
          '参数不被接受：image_path 不能为空（也可以改用 prompt 传完整任务）。**本次未派出子代理。**',
        )
      }

      const parent = exec?.agent
      if (parent === undefined || parent === null) {
        throw new MediaError(CODES.UNKNOWN, '读图员需要调用方 agent（exec.agent 未定义）')
      }

      const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
      if (subagents === undefined || typeof subagents.startActivation !== 'function') {
        throw new MediaError(
          CODES.UNKNOWN,
          'subagents 服务不可用：dsh-subagent 未加载，读图员无法派出子代理。**本次未派出子代理。**',
        )
      }
      if (typeof subagents.getProvider === 'function' && subagents.getProvider('spawn') === undefined) {
        throw new MediaError(
          CODES.UNKNOWN,
          'spawn 提供方未注册：dsh-subagent 的本地 spawn 后端未加载，读图员无法派出子代理。**本次未派出子代理。**',
        )
      }

      const provider = config[spec.providerField]
      const model = config[spec.modelField]
      const preset = config.readerAgentPreset
      const maxDepth = Number(config.readerMaxDepth)

      const request = {
        prompt: [{ type: 'text', text: buildPrompt({ imagePath, question, prompt: freeform }) }],
        parent,
        ...(typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? { cwd: args.cwd.trim() } : {}),
        ...(typeof preset === 'string' && preset.length > 0 ? { agentPreset: preset } : {}),
        ...(typeof provider === 'string' && provider.length > 0
          && typeof model === 'string' && model.length > 0
          ? { agentOptions: { provider, model } }
          : {}),
        ...(Number.isFinite(maxDepth) && maxDepth > 0 ? { maxDepth } : {}),
      }

      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: '读图',
        request,
        signal: exec.signal,
        delivery: 'parent',
      })
      const childId = activation?.childId
      if (typeof childId !== 'string' || childId.length === 0) {
        throw new MediaError(
          CODES.UNKNOWN,
          '派出读图员失败：subagents.startActivation 没有返回 childId',
        )
      }
      return { kind: 'activation', subagentId: childId }
      },
    })
  })
}
