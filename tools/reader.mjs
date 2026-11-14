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
import { ocrFileText, resolveInputPath } from './ocr-image.mjs'

/** 没给 question 时的默认要求。 */
const DEFAULT_QUESTION =
  '描述这张图片：画面内容、人物与物体、可读文字（有就原样摘录）、布局与光线。看不清的地方直说"看不清"。'

/** 子代理收到的最小指令模板（persona 已在 preset 里，不重复身份声明）。 */
const PROMPT_TEMPLATE = [
  '读取下面这张图片并按要求回答。',
  '图片路径：{path}',
  '问题：{question}',
  '',
  '要求：',
  '- 用 read_image 读这个路径；读不到就如实说明错误，不要猜。',
  '- 先给结论，再给支撑细节；有文字就原样摘录，没有文字就描述画面、人物、物体、布局与光线。',
  '- 看不清就说看不清，不要补全。',
].join('\n')

/** 批量模式：一个读图员一次看多张，结论按编号分段。 */
const BATCH_PROMPT_TEMPLATE = [
  '依次读取下面的 {count} 张图片，按编号分别回答。',
  '',
  '{paths}',
  '',
  '问题：{question}',
  '',
  '要求：',
  '- 按顺序用 read_image 读每个路径；某张读不到就如实说明，不要拿别的图顶替。',
  '- 输出必须按「图1：…」「图2：…」分段，每段先给结论再给支撑细节。',
  '- 有文字就原样摘录；看不清就说看不清，不要补全。',
].join('\n')

/** 批量模式默认上限（再多注意力就明显稀释）。 */
const DEFAULT_BATCH_MAX = 4

/**
 * 归一化图片入参。
 *
 * 批量模式只暴露 `image_paths`；`image_path` 仍然**接受**（旧会话 / 旧测试 / 旧工具调用的兼容），
 * 但不在 schema 里出现 —— 模型看到的形状只有一个。
 *
 * @param {object} args - 工具入参。
 * @returns {string[]} 非空路径数组。
 */
function normalizeImagePaths(args) {
  const paths = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) paths.push(value.trim())
  }
  const list = args?.image_paths
  if (Array.isArray(list)) for (const item of list) push(item)
  else push(list)
  if (paths.length === 0) push(args?.image_path)
  return paths
}

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
      '读图（{model}）：把本地图片 / 截图 / 图表 / 场景照的路径交给它，返回结构化结论'
      + '（画面、人物、文字、界面、图表、布局）。**图像识别 / 分析 / 审查一律用它**——'
      + '不要靠文件名或上下文猜图，也不要用 read 去读二进制图片。派出只读子代理并立刻返回 id，'
      + '结论稍后送达（几秒到几十秒）。与 ask_qwen 二选一。',
  }),
  Object.freeze({
    tool: 'ask_qwen',
    providerField: 'readerQwenProvider',
    modelField: 'readerQwenModel',
    fallbackLabel: 'Qwen-VL',
    description:
      '读图（{model}）：把本地图片 / 截图 / 图表 / 场景照的路径交给它，返回结构化结论'
      + '（中文界面、密集文字、表格读数较强；画面 / 场景也可）。**图像识别 / 分析 / 审查一律用它**——'
      + '不要靠文件名或上下文猜图，也不要用 read 去读二进制图片。派出只读子代理并立刻返回 id，'
      + '结论稍后送达（几秒到几十秒）。与 ask_glm 二选一。',
  }),
])

/**
 * 组装给子代理的 prompt。
 * @param {{imagePaths?: string[], question?: string, prompt?: string, ocrText?: string}} input - 入参。
 * @returns {string} 文本。
 */
function buildPrompt({ imagePaths, question, prompt, ocrText }) {
  const paths = Array.isArray(imagePaths)
    ? imagePaths.filter((path) => typeof path === 'string' && path.length > 0)
    : []
  if (paths.length === 0 && typeof prompt === 'string' && prompt.length > 0) return prompt
  const asked = question === undefined || question.length === 0 ? DEFAULT_QUESTION : question
  const base = paths.length > 1
    ? BATCH_PROMPT_TEMPLATE
      .replace('{count}', String(paths.length))
      .replace('{paths}', paths.map((path, index) => '图' + (index + 1) + '：' + path).join('\n'))
      .replace('{question}', asked)
    : PROMPT_TEMPLATE
      .replace('{path}', paths[0] ?? '')
      .replace('{question}', asked)
  if (typeof ocrText !== 'string' || ocrText.trim().length === 0) return base
  // 预读文本只作"校对底稿"：本地 OCR 0.4s、免费、不出网。读图员据此正错字、补漏行，
  // 而不是从零描述——但它**不是**画面理解，版式/归属/图表读数仍以 read_image 为准。
  return base
    + '\n\n## 本地 OCR 预读（可能有错字/漏行，仅供参考；以 read_image 实际所见为准）\n'
    + ocrText.trim().slice(0, 3000)
}

/**
 * 注册两个读图员工具。
 * @param {object} deps - ctx / config（liveConfig Proxy）。
 * @returns {object[]} 工具定义数组。
 */
export function createReaderTools(deps) {
  const { ctx, config } = deps
  // 批量模式（2026-11-01）：**默认强制**。开启后 schema 里只有 `image_paths`，
  // 不再提供单图入口——形状唯一，模型没有"逐张调三次"的岔路，这是稳定性的来源。
  // 默认**关闭**（`=== true` 才开）：出厂行为维持稳定的一图一读图员，批量是显式选择。
  const batchMode = config.readerBatchMode === true
  const configuredMax = Number(config.readerBatchMax)
  const batchMax = Number.isFinite(configuredMax) && configuredMax >= 2 ? Math.floor(configuredMax) : DEFAULT_BATCH_MAX

  /**
   * 批量模式的"定位"：不改写原有描述，只把"路径交给它"这句替换成批量契约，
   * 再补一句"什么时候该分开"。**必须短**——工具 schema 每个请求都要发，单工具预算 1300 B。
   */
  const batchRewrite = (base) => base.replace(
    '把本地图片 / 截图 / 图表 / 场景照的路径交给它，返回结构化结论',
    '一次读一批图：图放 image_paths（数组，≤' + batchMax + ' 张），结论按「图1/图2」分段',
  ) + '不相关、或每张要分别提问，就分开调用。'

  return READER_SPECS.map((spec) => {
    // 型号从 Config 读（缺省/空串时回落到家族名），不要在文案里写死。
    const configuredModel = config[spec.modelField]
    const label = typeof configuredModel === 'string' && configuredModel.trim().length > 0
      ? configuredModel.trim()
      : spec.fallbackLabel
    return defineTool({
      name: spec.tool,
      description: batchMode
        ? batchRewrite(spec.description.replaceAll('{model}', label))
        : spec.description.replaceAll('{model}', label),
      parameters: batchMode
        ? {
            image_paths: {
              type: 'array',
              items: { type: 'string' },
              description: '图片路径数组（绝对或相对会话目录）；最多 ' + batchMax + ' 张，单张也用数组。',
            },
            question: {
              type: 'string',
              description: '问题（可选）。多图分别提问时按「图1：…」写；留空则逐张描述。',
            },
            prompt: {
              type: 'string',
              description: '（兜底）完整任务描述；提供时可省略图片与 question。',
            },
            cwd: {
              type: 'string',
              description: '子代理工作目录（可选）；相对图片路径按它解析。',
            },
          }
        : {
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
        render: (args, value) => {
          const count = normalizeImagePaths(args).length
          const suffix = count > 1 ? `（${count} 张图一次读）` : ''
          return [{ type: 'text', text: `已派出读图员（${label}）：${value.subagentId}${suffix}。结论稍后以消息送达。` }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
      const imagePaths = normalizeImagePaths(args)
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      const freeform = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (imagePaths.length === 0 && freeform.length === 0) {
        throw new MediaError(
          CODES.BAD_REQUEST,
          (batchMode ? '参数不被接受：image_paths 不能为空（数组，单张也传一个元素）' : '参数不被接受：image_path 不能为空')
            + '（也可以改用 prompt 传完整任务）。**本次未派出子代理。**',
        )
      }
      if (imagePaths.length > batchMax) {
        throw new MediaError(
          CODES.BAD_REQUEST,
          `一次最多读 ${batchMax} 张（本次给了 ${imagePaths.length} 张）。请分组成多次调用，`
            + '每组一个 image_paths 数组。**本次未派出子代理。**',
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

      // 预读（2026-11-01）：派单前先在本地把"字"抄一遍（0.4s、0 元、不出网），
      // 让读图员校对错字/补漏行，而不是从零描述。失败不影响读图，静默降级。
      // 批量模式下逐张抄、按「图N」分段，总预算 3000 字（超出就不带了）。
      let ocrText = ''
      if (config.autoOcrOnImage !== false && imagePaths.length > 0) {
        const parts = []
        let budget = 3000
        for (let index = 0; index < imagePaths.length && budget > 0; index += 1) {
          try {
            const absolute = resolveInputPath(imagePaths[index], exec)
            const pre = await ocrFileText({
              imagePath: absolute,
              maxChars: Math.min(budget, 1500),
              timeoutMs: 15000,
              signal: exec?.signal,
            })
            if (pre.weak === true || typeof pre.text !== 'string' || pre.text.trim().length === 0) continue
            const body = pre.text.trim()
            parts.push(imagePaths.length > 1 ? `图${index + 1}：\n${body}` : body)
            budget -= body.length
          } catch (error) {
            deps.logger?.debug?.('[mm-models] 读图员预读 OCR 失败（已忽略）：' + String(error?.message ?? error))
          }
        }
        ocrText = parts.join('\n\n')
      }

      const request = {
        prompt: [{ type: 'text', text: buildPrompt({ imagePaths, question, prompt: freeform, ocrText }) }],
        parent,
        ...(typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? { cwd: args.cwd.trim() } : {}),
        ...(typeof preset === 'string' && preset.length > 0 ? { agentPreset: preset } : {}),
        ...(typeof provider === 'string' && provider.length > 0
          && typeof model === 'string' && model.length > 0
          ? { agentOptions: { provider, model } }
          : {}),
        ...(Number.isFinite(maxDepth) && maxDepth > 0 ? { maxDepth } : {}),
      }

      // DSH 0.2.2-rc.2 起 `startActivation` 改成**扁平入参**（SubagentActivationSpec
      // extends Omit<SubagentStartRequest,'label'|'signal'>），`parent`/`prompt`/
      // `agentPreset`/`agentOptions`/`maxDepth` 都在 spec 顶层；旧版是嵌套 `request`。
      // 只传嵌套 request 时 rc.3 里 `spec.parent` 为 undefined，直接报
      // "Cannot read properties of undefined (reading 'id')"。
      // 扁平字段与旧 `request` 同时给出：两代运行时都能派出。
      const activation = await subagents.startActivation({
        ...request,
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
      // 登记到回合闸门：主 agent 的下一步会等这个 childId 结束（结论回来后才能开口）。
      deps.turnGate?.noteReaderStarted(parent, childId)
      return { kind: 'activation', subagentId: childId }
      },
    })
  })
}
