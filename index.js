/**
 * @local/dsh-mm-models —— DeepSeek 主脑 + GLM 读图 / Qwen 制图 / Seedance 出片。
 *
 * 规划：dsh-创作模式插件-规划.txt v0.7。
 * 本文件 = Config + 注册 5 个工具 + 提示词段落（无 preset、无 persona、无前端）。
 *
 * 顶层工具（与 bash / ops_* 同级）：
 *   ask_glm        （由 cordis.patch.yml 里的官方 tool-subagent 实例提供，零代码）
 *   ask_qwen       （同上，百炼 Qwen-VL；与 ask_glm 互斥，二选一）
 *   qwen_draw      DashScope 异步文生图
 *   seedance_video 方舟 Ark 异步文生 / 图生视频
 *   media_task     异步任务重查 / 补下载
 *   media_report   成本估算 + 链路健康
 */
import z from '@deepseek-ai/schemastery'

import { createTaskManager } from './tasks/manager.mjs'
import { dashscopeImageAdapter } from './tasks/adapters/dashscope-image.mjs'
import { arkVideoAdapter } from './tasks/adapters/ark-video.mjs'
import { createQwenDrawTool } from './tools/qwen-draw.mjs'
import { createSeedanceVideoTool } from './tools/seedance-video.mjs'
import { createMediaTaskTool } from './tools/media-task.mjs'
import { createMediaReportTool } from './tools/media-report.mjs'
import { createKeyResolver } from './core/keys.mjs'
import { DEFAULT_PRICING, PRICING_ZERO_HINT, openLedger, pricingWarnings } from './core/cost.mjs'
import { openTaskRegistry } from './core/tasks.mjs'
import { openImageCache } from './core/cache.mjs'
import { createCallBudget, createSwitches } from './core/tool-kit.mjs'
import { READER_ALLOWED_TOOLS, inspectReaderFilters } from './core/reader-guard.mjs'

/** 插件名（与 package.json / cordis.patch.yml 的 id 对应）。 */
export const name = 'mm-models'

/** 需要的宿主服务；任一缺失时插件保持不激活，而不是让 profile 崩溃。 */
export const inject = ['tools', 'credentials', 'systemPrompt']

/**
 * 分工说明段落（规划 [1]）；promptSection=false 时不注册。
 *
 * == 2026-10-15 瘦身：只留"插件自有策略"，删掉与宿主重复的条款 ==
 * 原版有 7 行，其中三段（环境探查禁令 / 图像任务禁令 / 长命令禁令）与**宿主自己注入的
 * 系统指令逐字重合** —— 同一套规则在上下文里出现两遍，白占 token；改规则还要改两处，
 * 漏一处就会出现"两个版本打架"。已删除，交给宿主唯一来源。
 *
 * 留下的两条是宿主管不到的：
 *   1. 分工与交付责任（媒体工具出素材，Final 文案/代码由主模型负责）；
 *   2. **路由策略**：主模型自己看不了图时走哪个读图工具、两个读图员都没开时如实说明
 *      而不是"猜图"。这是插件才知道的信息（哪个开关开了、有没有读图工具），必须由它说。
 *
 * 刻意不列工具名以外的实现细节：工具能力已由各自 schema 呈现。
 */
const PROMPT_SECTION = [
  '你是主创兼工程师（DeepSeek 会话主模型）：媒体工具产出素材与结论，最终文案、代码与整合由你完成，并对交付负全责。',
  '不要为了使用工具而使用工具，不要把工具输出原样当成交付物；生成可能计费，编排前先确认能力可用。',
  '【读图路由】图像识别 / 分析 / 审查（看图、读图、截图理解、界面与排版检查、图表读取、确认画面内容）一律走 ask_glm 或 ask_qwen：它们只会看图，别让它们读代码 / 翻目录 / 查配置。',
  '两个读图员都没开时，如实说明"当前没有看图途径"并请用户到 插件页 → gpt-CN → 配置卡 打开，不要绕道、不要猜图。',
].join('\n')

/** 插件配置：三把 key、端点与型号、任务层、成本、落盘、开关。 */
export const Config = z.object({
  // ---- 三把 key ----
  //
  // 密钥字面值：配置卡里能看见、能改（2026-10-13 按使用要求恢复）。
  // ⚠ 代价如实说明：值会**明文落进 profile 配置**（`cordis.patch.yml`），会被备份、也可能进仓库。
  // 留空则回退到下面的引用名 → `~/.dsh/.env` / 系统环境变量，功能完全一样。
  // 两条路并存，**字面值优先**（core/keys.mjs）。
  dashscopeApiKey: z
    .string()
    .role('secret')
    .default('')
    .volatile()
    .description('DashScope API Key 字面值（配置卡里可看可改）。⚠ 明文落进 profile 配置，别提交到仓库；留空则回退下面的引用名 / ~/.dsh/.env。'),
  dashscopeApiKeyEnv: z
    .string()
    .role('credential-ref')
    .default('DASHSCOPE_API_KEY')
    .volatile()
    .description('DASHSCOPE_API_KEY 的引用名：真值放 %USERPROFILE%/.dsh/.env 或系统环境变量（推荐方式）。'),
  arkApiKey: z
    .string()
    .role('secret')
    .default('')
    .volatile()
    .description('Ark API Key 字面值（配置卡里可看可改）。⚠ 明文落进 profile 配置，别提交到仓库；留空则回退下面的引用名 / ~/.dsh/.env。'),
  arkApiKeyEnv: z
    .string()
    .role('credential-ref')
    .default('ARK_API_KEY')
    .volatile()
    .description('ARK_API_KEY 的引用名：真值放 %USERPROFILE%/.dsh/.env 或系统环境变量（推荐方式）。'),
  zhipuApiKey: z
    .string()
    .role('secret')
    .default('')
    .volatile()
    .description('智谱 API Key 字面值（配置卡里可看可改）。⚠ 明文落进 profile 配置；ask_glm 也可走 设置 → 模型 → GLM 行，留空则回退下面的引用名 / ~/.dsh/.env。'),
  zhipuApiKeyEnv: z
    .string()
    .role('credential-ref')
    .default('ZHIPU_API_KEY')
    .volatile()
    .description('ZHIPU_API_KEY 的引用名：与 设置 → 模型 → GLM 行 使用同一个 key。'),

  // ---- 端点与型号 ----
  dashscopeBase: z.string().default('https://dashscope.aliyuncs.com/api/v1').volatile().description('DashScope API 基址（异步任务）。'),
  dashscopeCompatBase: z
    .string()
    .default('https://dashscope.aliyuncs.com/compatible-mode/v1')
    .volatile()
    .description('DashScope OpenAI 兼容基址，仅用于健康探测（GET /models）。'),
  arkBase: z.string().default('https://ark.cn-beijing.volces.com/api/v3').volatile().description('方舟 Ark API 基址。'),
  qwenModel: z.string().default('qwen-image-3.0').volatile().description('qwen_draw 使用的模型 id。'),
  dashscopeImageMode: z.string().default('auto').volatile().description('DashScope 制图调用模式：auto（qwen-image 走同步，其余走异步）/ sync / async。'),
  // 模型 id 必须是**方舟实际可用的模型名或接入点 id**（2026-10-15 在真实账号上逐个探测确认）。
  //
  // 命名规律（我在这里踩过坑）：`doubao-seedance-<代>-<档>-<日期>`，**日期后缀必填且猜不出来**。
  // 1.0 世代叫 pro/lite，**2.0 起改叫 fast/mini**（不再有 pro）——所以拿 `doubao-seedance-2-0-pro`
  // 去试必然 404。国际版用 `dreamina-` 前缀，国内用 `doubao-`。最省事是去控制台详情页复制 id。
  //
  // 实测可用（duration 取值域已探明）：
  //   doubao-seedance-2-5-260628            4–30 秒   最强（约 1.519 元/秒）← 当前默认
  //   doubao-seedance-2-0-fast-260128       4–15 秒   中档（约 0.998 元/秒）
  //   doubao-seedance-1-0-pro-fast-251015   2–12 秒   最便宜（约 0.206 元/秒）
  seedanceModel: z.string().default('doubao-seedance-2-5-260628').volatile().description('seedance_video 使用的模型 id 或接入点 id（ep-xxxx）。默认最强的 doubao-seedance-2-5-260628（约 1.519 元/秒，单段最长 30 秒）；更省可换 doubao-seedance-2-0-fast-260128（约 0.998 元/秒）或 doubao-seedance-1-0-pro-fast-251015（约 0.206 元/秒）。'),

  // ---- 任务层 ----
  //
  // ⚠ 这几个"等待上限"是**同步阻塞**的：填多大，这一轮就真可能卡多久。
  // 默认值按"够用但**早失败**"来定（2026-10-14 收紧，原来分别是 10 分钟 / 30 分钟）：
  //   - 出图（qwen-image 同步模式）实测/公开资料都在 10–45 秒量级；
  //     超过 3 分钟基本是卡住或连接异常，**早失败早重试**比干等 10 分钟划算得多；
  //   - 出片（Seedance）点一次要跑几分钟，15 分钟够覆盖高峰；
  //   - 而且插件已有**任务注册表 + media_task 兜底**：超时不再等于白做，
  //     可以事后 action=list / status / download 把产物捞回来。
  taskTimeoutMs: z.number().step(1000).min(1000).default(180000).volatile().description('图片任务同步等待上限（毫秒），默认 3 分钟。超时后任务仍可用 media_task 找回。'),
  videoTimeoutMs: z.number().step(1000).min(1000).default(900000).volatile().description('视频任务同步等待上限（毫秒），默认 15 分钟。超时后任务仍可用 media_task 找回。'),
  taskPollIntervalMs: z.number().step(500).min(500).default(5000).volatile().description('轮询起始间隔（毫秒）；轻微退避至 10 秒封顶。'),
  taskPollMaxIntervalMs: z.number().step(500).min(500).default(10000).volatile().description('轮询间隔上限（毫秒）。'),
  httpTimeoutMs: z.number().step(1000).min(1000).default(60000).volatile().description('单次 HTTP 请求超时（毫秒）。视频产物下载可能较慢，必要时调大。'),
  queryRetries: z.number().step(1).min(0).default(2).volatile().description('幂等查询（GET）的额外重试次数；提交（POST）永不自动重发。'),
  // 同一会话"连续生成"的调用上限（2026-10-14 由 3 提到 6）。
  // 语义：距上次生成超过 60 秒即视为新一轮、计数重置。所以它限制的是**一口气连做几个**，
  // 不是整场会话的总量。默认 6 = 一次能连续出 6 张/条（例如一组分镜）；
  // 超出后需等约 60 秒，或在配置卡里调大。0 = 不限制。
  maxCallsPerTurn: z.number().step(1).min(0).default(6).volatile().description('同一会话连续生成调用上限，默认 6；0 = 不限制。距上次调用超过下面的空闲窗口即视为新一轮。'),
  // 空闲窗口：超过它就认为"新的一轮开始了"，连续生成计数清零。
  // 它同时决定超限文案里"请等待约 N 秒"的 N（文案的秒数由这个值算出，改这里两边一起变）。
  callBudgetIdleResetMs: z.number().step(1000).min(1000).default(25000).volatile().description('连续生成的空闲重置窗口（毫秒），默认 25 秒：距上次生成超过它即视为新一轮、计数清零。'),

  // ⛔ 花费闸门（2026-10-15 加）：单次出片预估金额超过它就**在提交前拒绝**。
  //
  // 为什么默认不是 0（不限）：出片按次计费且不可撤销，提交即扣费。
  // 2026-10-15 的事故（22 个误建任务、账单 ¥195.97）根因就是提交路径上没有金额校验。
  // 默认 10 元 = 允许常用的 2–6 秒短片段，但挡住"一口气跑 30 秒 × 多个"这类烧钱组合。
  // 需要不受限时显式设 0——**让"放开限制"成为一个有意识的动作**。
  videoCostLimitCNY: z.number().step(1).min(0).default(10).volatile().description('单次出片的花费上限（元），默认 10；提交前按单价×时长估算，超限直接拒绝且不产生费用。0 = 不限制。'),
  // 会话累计上限：防"反复试、每次都不贵"的烧钱模式。
  // 2026-10-15 的事故正是这种形态——22 次调用单看都不贵（4–30 秒），合计 ¥195.97。
  // 只做单次上限的话，那道闸会放行其中 10 次、合计 ¥71.69。所以两层都要有。
  videoSessionCostLimitCNY: z.number().step(1).min(0).default(30).volatile().description('单个会话的出片累计花费上限（元），默认 30；超出后提交前拒绝。专门防"反复试"的烧钱模式。0 = 不限制。'),
  // 强制花费确认（2026-10-15 加）：付费接口必须"先报价、再确认"才提交。
  //
  // 为什么默认开：事故的根因不是参数算错，而是**提交路径上没有任何强制意图声明**——
  // "探测参数"和"下单购买"在接口层面长得一模一样。要求调用方复述精确金额，
  // 就能让"无意识的循环试参"在第一步就停下（它每次都得先算钱）。
  // 这一层比金额上限更根本：**上限只限制花多少，确认改变的是"会不会无意识花钱"。**
  requireSpendConfirm: z.boolean().default(true).volatile().description('付费出片必须先用确认参数复述预估金额才提交（默认开）。关闭后仅保留金额上限校验，供测试或明确不需要确认的场景使用。'),

  // ---- 落盘 ----
  outDir: z.string().default('gen').volatile().description('图片产物目录（相对会话工作目录，或绝对路径）。'),
  videoOutDir: z.string().default('gen/video').volatile().description('视频产物目录（相对会话工作目录，或绝对路径）。'),
  maxDownloadBytes: z.number().step(1024).min(1024).default(209715200).volatile().description('单个产物下载上限（字节），默认 200 MiB（视频可能较大）。'),
  maxInlineImageBytes: z.number().step(1024).min(1024).default(10485760).volatile().description('图生视频时本地首帧图的内联上限（字节），默认 10 MiB。'),
  ledgerPath: z.string().default('').volatile().description('账本 JSON 回退路径；留空 = %USERPROFILE%/.dsh/mm-models-ledger.json（优先使用宿主 storage 服务）。'),

  // ---- 出图缓存（2026-10-13 加）：同样的 prompt + 参数不重复计费 ----
  cacheResults: z.boolean().default(true).volatile().description('开启出图缓存：相同 prompt + 模型 + 尺寸 + 张数直接复用上次产物，不再计费。默认开。'),
  cacheTtlMs: z.number().step(3600000).min(0).default(86400000).volatile().description('出图缓存有效期（默认 24 小时）；0 = 永不过期。'),
  cacheKeySalt: z.string().default('').volatile().description('出图缓存加盐：改掉它等于让所有旧缓存立即失效（想强制重新生成时用）。'),
  maxCacheEntries: z.number().step(1).min(1).default(200).volatile().description('出图缓存条数上限（超出丢弃最旧的）。'),

  // ---- 成本（可编辑单价表；查不到官方价的型号用 null = 未计价，不要写 0）----
  //
  // ⚠ `z.dict(z.any())` 是"什么都收"：2026-10-12 有一份占位表把每个模型的单价都写成 0，
  // 它把出厂真价表整个顶掉（profile 的 pricing 是**整体替换**语义），于是报表把真钱
  // 显示成 0.0000，而代码只在 description 里写了"不要写 0" —— 没有机器拦得住。
  //
  // 为什么不用 schema 拦：本项目实测所用的 schemastery 3.18.4 **没有 `.refine()`**
  // （dict/object 上只有 inner/sKey/toString），z.dict(z.any()) 在 schema 层无法约束值。
  // 所以校验放在运行时，且做成"能在对话里看见"：`pricingWarnings()` 的结果会进
  // media_report(health) 报告的「单价表」段，启动时也打日志。见 core/cost.mjs。
  pricing: z
    .dict(z.any())
    .default(DEFAULT_PRICING)
    .volatile()
    .description(`单价表：key = 模型 id（**必须是真实模型 id，不是简称**）；字段 unit/unitPrice/inputPrice/outputPrice/currency/asOf/source/tiers。未计价用 null（不要写 0，0 会被读成免费）。${PRICING_ZERO_HINT} 自检结果见 media_report(health)。`),

  // ---- 花费闸门（2026-10-15 事故后加）----
  allowUnpricedSpend: z
    .boolean()
    .default(false)
    .volatile()
    .description('允许"未计价"模型的花费放行。默认关闭（fail-closed）：查不到单价就拒绝提交。'
      + '关闭时调用方无法用自报金额绕过闸门；确实要出未计价的片子，请用户把这里打开，'
      + '再带 confirm_unpriced=true 显式确认。'),

  // ---- 任务注册表（2026-10-13 加）：整轮失败后还能找回任务 ----
  persistTasks: z.boolean().default(true).volatile().description('把提交过的异步任务登记到本地，便于整轮失败/超时后用 media_task(action=list) 找回并补下载。'),
  taskRegistryPath: z.string().default('').volatile().description('任务注册表文件路径；留空 = %USERPROFILE%/.dsh/mm-models-tasks.json。'),
  maxRegistryEntries: z.number().step(1).min(10).default(200).volatile().description('任务注册表保留条数上限（超出丢弃最旧的）。'),
  registryTtlMs: z.number().step(3600000).min(3600000).default(604800000).volatile().description('任务注册表条目保留时长（默认 7 天），过期的查询时顺手清理。'),

  // ---- 工具开关（插件页 → gpt-CN → 配置卡，一键勾选；关闭后调用被拒，新会话不再显示）----
  enableAskGlm: z.boolean().default(false).volatile().description('允许主 agent 使用 ask_glm（GLM 读图子代理）。与 enableAskQwen 互斥：打开它就会自动关闭 ask_qwen，反之亦然；两个都关时没有读图工具。'),
  enableAskQwen: z.boolean().default(false).volatile().description('允许主 agent 使用 ask_qwen（Qwen-VL 读图子代理）。与 enableAskGlm 互斥：打开它就会自动关闭 ask_glm，反之亦然；两个都关时没有读图工具。'),
  enableQwenDraw: z.boolean().default(true).volatile().description('允许主 agent 使用 qwen_draw（Qwen 制图）。'),
  blockMainAgentNativeVision: z
    .boolean()
    .default(false)
    .volatile()
    .description('屏蔽主 agent 的原生读图：打开后主 agent 的工具列表里不再有 read_image，读图只能走 ask_glm / ask_qwen。改完需完整重启才生效。'),
  enableSeedanceVideo: z.boolean().default(false).volatile().description('允许主 agent 使用 seedance_video（Seedance 出片）。默认关闭：Ark 未开通/门槛较高，接通后在设置里一键打开。'),
  enableMediaTask: z.boolean().default(true).volatile().description('允许主 agent 使用 media_task（异步任务重查/补下载）。'),
  enableMediaReport: z.boolean().default(true).volatile().description('允许主 agent 使用 media_report（成本估算/链路健康）。'),

  // ---- 生成物是否附回模型上下文（2026-10-13 加，默认关）----
  // 背景：qwen_draw 默认产 2048×2048 / 数 MB 的 PNG。把它作为图片内容块塞回上下文会带来两个问题：
  //   1. 视觉路由要为此做额外工作（DeepSeek 适配器会先尝试 Files API 上传，失败才降级 base64 内联），
  //      上传/传输一旦失败就是 TRANSPORT，而它属于可重试码，会连试 5 次后让整轮失败——图其实早就落盘了；
  //   2. 收获极低：DeepSeek 路由对单图有 **1024 token 的硬上限**，2048×2048 一定会被大幅降采样，
  //      模型看到的从来不是原图。
  // 所以默认只回"路径 + 规格"文本；需要模型自己看一眼构图时再打开开关。
  attachResultImages: z
    .boolean()
    .default(false)
    .volatile()
    .description('把生成/下载的图片作为图片内容块附回模型上下文。默认关（只回文件路径）：避免大图触发上传/传输失败拖垮整轮，且多数路由本来就会把它降采样。'),
  maxAttachImageBytes: z
    .number()
    .step(1024)
    .min(0)
    .default(4194304)
    .volatile()
    .description('附回上下文的单张图片字节上限（默认 4 MiB）；超过则只回路径。0 = 不限制。'),

  // ---- 其它 ----
  promptSection: z.boolean().default(true).volatile().description('是否注册"分工说明"系统提示词段落。'),
  degradeToText: z.boolean().default(false).volatile().description('保留开关：ask_glm 读图失败时是否给出明显的替代指引（默认关闭）。'),
  healthProbe: z.boolean().default(true).volatile().description('media_report(action=health) 是否做轻量连通性探测。'),
  healthProbeTtlMs: z.number().step(1000).min(1000).default(300000).volatile().description('健康探测结果缓存 TTL（毫秒），默认 5 分钟。'),
})

/**
 * 注册 5 个工具 + 提示词段落。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已按 Config 校验的配置。
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  // volatile 字段是"引用"（改设置后无需重启）：统一在读取时解包成当前值。
  const liveConfig = new Proxy(config, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
    },
  })
  const adapters = [dashscopeImageAdapter, arkVideoAdapter]
  const manager = createTaskManager({ adapters, config: liveConfig, logger })
  // 注意：必须传 liveConfig（解包过的 Proxy），不能传原始 config。
  // volatile 字段在 config 上是**引用对象**（`{ get() }`），keys.mjs 里用的是
  // `nonEmptyString(config[...])`，拿到对象会判定成"没填" → 字面值 key 与
  // 自定义引用名都会被静默忽略、一路回落到默认引用名（2026-10-13 实测发现）。
  const keys = createKeyResolver(ctx, liveConfig)
  const budget = createCallBudget(liveConfig)
  const switches = createSwitches(liveConfig)

  // 工具开关（第一层）：全局 guard 读实时配置，关闭后调用立即被拒（对已存在的会话同样有效）。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return undefined
    return switches.isEnabled(name) ? undefined : switches.disabledMessage(name)
  })

  // 「多此一举」拦截（2026-10-13）：读图子代理只在"图不在上下文里"时才该被调用。
  //
  // 起因：用户粘贴的图会以图像块进主上下文，主代理**本来就看得到**；但它不确定自己能不能看，
  // 于是又派读图员复述一遍 —— 同一张图付两遍 token（实测某会话里 ask_qwen 被调了 9 次）。
  //
  // 判据（两条互补，覆盖两种情形）：
  //   1. 上下文里已经有图（会话日志里有 image 块）→ 主代理直接看，派子代理纯属浪费 → 拒绝；
  //   2. 主路由被声明为纯文本（整段日志里从未出现 image 块）→ 它自己根本看不了，
  //      派子代理是**唯一**正确的做法 → 放行。
  //
  // 第 2 条正是可观测的"路由图像能力"代理信号：图片投影取决于路由（支持图片的路由拿到图像块，
  // 纯文本路由拿到占位文本），所以"历史里有没有出现过 image 块"就等价于"这条路能不能看图"。
  //
  // 安全取向：只认这两种确定情形，判不出来就放行（fail-open）。判定本身再包一层 try，
  // 任何异常都不能拦住一次本来合法的读图。
  const READER_TOOLS = ['ask_glm', 'ask_qwen']
  const NATIVE_VISION_TOOL = 'read_image'
  /** 指路文案里的插件显示名（与 package.json meta.title / locale 保持一致）。 */
  const PLUGIN_LABEL = 'gpt-CN'

  const entryHasImage = (entry) => {
    const content = entry?.data?.content
    return Array.isArray(content) && content.some((block) => block?.type === 'image')
  }
  /** 扫描整段会话日志，找出"上下文内有内联图"与"该轮之后的内容"的边界。 */
  const imageInContextIndex = (log) => {
    let lastImage = -1
    let lastUserMessage = -1
    for (let index = 0; index < log.length; index += 1) {
      const entry = log[index]
      if (entryHasImage(entry)) lastImage = index
      if (entry?.type === 'user/message') lastUserMessage = index
    }
    // 图片必须由**用户消息**带入才算"它自己看得到"：
    // 工具结果里的图（子代理返回的图像块）不代表主代理的模型路由支持看图。
    if (lastImage < 0 || lastUserMessage < 0) return -1
    if (lastImage !== lastUserMessage || !entryHasImage(log[lastUserMessage])) return -1
    // 只在该轮之后没有新内容时才算"当前上下文里有图"——用户发新消息后重新计。
    return lastImage === log.length - 1 ? lastImage : -1
  }

  /**
   * 图片扩展名判定（用路径后缀，不读文件内容 —— 便宜且绝不误伤）。
   * 覆盖常见位图；`.svg` 是文本，故意不算。
   */
  const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif|ico)$/i

  /** 从工具入参里取"可能是文件路径"的字符串。 */
  const pathArgOf = (args) => {
    if (typeof args === 'string') return args
    if (args === null || typeof args !== 'object') return undefined
    // 常见入参名；取第一个命中的（read 用的是 file_path / path）。
    for (const key of ['file_path', 'filePath', 'path', 'file', 'target_file', 'filename', 'file_paths', 'paths']) {
      const value = args[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim()
    }
    return undefined
  }

  /**
   * 视觉任务委派工具的名字。
   * DSH 原生的通用委派工具（`dsh-tool-subagent`），`toolName` 可在配置里改，
   * 所以两个默认名都认；读图子代理自己也叫 ask_glm/ask_qwen，不在此列。
   */
  const DELEGATION_TOOLS = ['subagent', 'subagent_fork']

  /** 取委派调用的"任务描述"（spawn/fork 都是 prompt / description）。 */
  const delegationTextOf = (args) => {
    if (args === null || typeof args !== 'object') return ''
    const parts = []
    for (const key of ['prompt', 'description', 'task', 'instructions']) {
      const value = args[key]
      if (typeof value === 'string') parts.push(value)
    }
    return parts.join('\n')
  }

  /**
   * 文字里是否点名了"读图/看图"这类**视觉意图**。
   *
   * ⚠ 门槛故意收窄，只认明确的"读/看/描述/审查 + 图"组合，不认单个"图"字 ——
   * 否则"帮我画一张图"（出图，不是读图）会被误伤。
   */
  const VISION_INTENT_RE =
    /(读图|看图|识图|图片识别|图像识别|图像分析|图像审查|截图理解|看截图|看这张|看下这|看图说话|画的是|图里|图中|图上有|辨认|画面内容|视觉检查|排版检查|渲染检查|read the image|read image|look at the image|describe the image|image recognition|inspect the screenshot|review the screenshot)/i

  /** 这段委派描述看起来是要"读图"吗？（图片文件路径 或 明确的视觉意图） */
  const looksLikeVisionDelegation = (text) => {
    if (typeof text !== 'string' || text.trim().length === 0) return false
    if (IMAGE_PATH_RE.test(text)) return true
    return VISION_INTENT_RE.test(text)
  }

  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || !READER_TOOLS.includes(name)) return undefined
    // 主代理被屏蔽了原生读图时，"自己看"这条路不存在，所以永远不能拦读图员。
    if (liveConfig?.blockMainAgentNativeVision === true) return undefined
    const log = exec?.agent?.session?.log
    if (!Array.isArray(log) || log.length === 0) return undefined
    // 整段历史里都没出现内联图 → 这条路看不了图，派读图员是对的。
    if (!log.some(entryHasImage)) return undefined
    // 有内联图，但当前上下文已经不是"图片紧跟在末尾"的状态（用户又发了别的）→ 不武断。
    if (imageInContextIndex(log) < 0) return undefined
    // guard 的返回值是**字符串原因**（不是 post-execute 的 {kind, feedback}）。
    return (
      '这张图已经在本对话的上下文里（它作为图像块随用户消息进来了），你可以直接看图，不需要读图员。' +
      '请直接基于图作答，不要重试 ' + name + '；' +
      '只有当你需要它读"另一个不在上下文里的图片文件路径"时，才调用读图员。'
    )
  })

  // 工具开关（第二层）：把已关闭的工具从 agent 的继承清单里 restrict 掉，模型看不到 schema。
  //
  // ⚠ 这一层必须是**可对账的实时状态**，不能只在 agent 创建时装一次。
  // 实测（2026-10-13）：配置写入走 `ConfigEditor.edit()` → `resolveConfig(runtime, next)`，
  // 也就是**原地更新配置、并不重载插件**；而 restrict 的掩码是创建时算的，
  // 于是"在配置卡里切换读图子代理"在当前会话里不生效，用户必须新开对话才看得到
  // （现象：已新增一个工具 / 减少一个工具，滞后又诡异）。
  //
  // 现在：每个 agent 记下"当前生效的 deny"，`syncRestrictions()` 按**实时配置**重算，
  // 变了就撤掉旧掩码、贴上新掩码（restrict 的 dispose 会解除限制）。
  // guard 那一层仍然兜底"调用被拒立即生效"（schema 可见性与行为拒绝是两件事）。
  //
  // 另外承担"屏蔽主 agent 原生读图"（blockMainAgentNativeVision）：
  // 只对**主 agent** 下 deny —— 子代理必须留着 read_image 当眼睛，否则读图员会瞎。
  // 判据用 `agent.options.subagentDepth`（主 agent 的 options 只有 provider/model）；
  // 不能用 agent.parent，也不能用工具可见性 —— 两者都实测失败，详见 isSubagent 的注释。
  const nativeVisionBlocked = () => liveConfig?.blockMainAgentNativeVision === true
  /** agent → { deny: string[]|undefined, dispose: (()=>void)|undefined }。 */
  const restrictions = new Map()

  /**
   * 这个 agent 应该被 deny 掉哪些工具（按**实时**配置计算）。
   * @returns {string[]|undefined} 空数组 = 无需限制。
   */
  const desiredDeny = (agent) => {
    const deny = switches.disabledNames()
    // 原生读图只对主 agent 屏蔽；子代理必须留着这只"眼睛"（读图员全靠它）。
    if (nativeVisionBlocked() && !isSubagent(agent)) deny.push(NATIVE_VISION_TOOL)
    return deny.length > 0 ? deny : undefined
  }

  const sameDeny = (left, right) => {
    if (left === undefined || right === undefined) return left === right
    return left.length === right.length && left.every((name, index) => name === right[index])
  }

  /** 按实时配置给一个 agent 贴/撤掩码；没有变化就不动（避免无谓的掩码链增长）。 */
  const syncAgent = (agent) => {
    const current = restrictions.get(agent)
    const desired = desiredDeny(agent)
    if (current !== undefined && sameDeny(current.deny, desired)) return
    if (current?.dispose !== undefined) {
      try {
        current.dispose()
      } catch {
        // 忽略：掩码已被释放
      }
    }
    if (desired === undefined) {
      restrictions.delete(agent)
      return
    }
    if (agent?.ctx?.tools?.restrict === undefined) return
    try {
      let disposeRestriction
      const dispose = agent.ctx.effect(() => {
        disposeRestriction = agent.ctx.tools.restrict({ deny: desired })
        return () => disposeRestriction()
      })
      restrictions.set(agent, { deny: [...desired], dispose })
    } catch (error) {
      logger?.warn?.('[mm-models] 无法为会话隐藏工具（' + desired.join(', ') + '）：' + String(error?.message ?? error))
    }
  }

  /**
   * 把"当前生效的掩码"与"实时配置应有的掩码"对齐。
   * 这是"改开关立即在当前会话生效"的关键——配置是原地更新的，不会重载插件，
   * 所以必须自己周期性对账（廉价：只在值变化时才碰掩码链）。
   */
  const syncRestrictions = () => {
    for (const agent of [...restrictions.keys()]) syncAgent(agent)
  }

  /**
   * 这个 agent 是不是子代理（而不是主 agent）？
   *
   * 判据：子代理的 `agent.options` 里带 `subagentDepth`（由 subagent 运行时注入）；
   * 主 agent 的 options 只有 `{provider, model}`。
   *
   * ⚠ 两个坑（都是实测踩出来的，2026-10-13）：
   * 1. `agent.parent` **不能**用来判断 —— 实测主 agent 与读图子代理的 `hasParent` 都是 false；
   * 2. `tools.get()` / `tools.schemas()` 在 `agent/created` 时刻都返回**未受限制的全集**
   *    （agent 自己的 restrict 与 tool-subagent 的 toolFilter 都在这个事件之后才装上），
   *    所以那一刻也分不出主/子。
   * 早期版本就栽在这两点上：把子代理误判成主 agent，连它也 deny 掉 read_image，
   * 后果是读图员直接瞎掉 —— 真实 glm-4.6v 拿不到工具，只能把
   * `<tool_call>read_image{...}` 当普通文本吐出来（tests/e2e-readers.mjs 阶段 A 实测）。
   */
  const isSubagent = (agent) => agent?.parent !== undefined || agent?.options?.subagentDepth !== undefined

  /**
   * 第三条守卫：**拦住"用通用 read 去读图片"的瞎撞**（2026-10-13 实测问题）。
   *
   * 现场：模型想看图 → 退而用通用 `read` 读 PNG，连撞两次、每次只拿到
   * `cannot read "…png": binary file` —— **那两句话对模型零指引**，它只能继续乱试、白烧 token。
   *
   * ⚠ 这里**无条件拦**（不只在屏蔽原生读图时）：读图片的字节流对文本模型毫无意义，
   * 无论原生读图开没开，这条路都拿不到"看懂图"的结果。指引则按当前**真实可用**的工具给，
   * 免得让它去试一个已经不存在的工具：
   *   - 原生读图可用 → 让它用 `read_image`；
   *   - 原生读图被屏蔽且某个读图员开着 → 让它用那个读图员；
   *   - 都没有 → 老实说没有可用的读图途径，让用户去开一个。
   *
   * 只对主代理生效：子代理（读图员）需要读文件就让它读，不能误伤它那只"眼睛"。
   */
  ctx.tools.guard((exec) => {
    if (exec?.name !== 'read' || isSubagent(exec?.agent)) return undefined
    const target = pathArgOf(exec?.args)
    if (target === undefined || !IMAGE_PATH_RE.test(target)) return undefined
    const readers = READER_TOOLS.filter((tool) => switches.isEnabled(tool))
    const headline = '这是图片文件，通用 read 工具读不了二进制内容（只会回 "binary file"）。'
    if (nativeVisionBlocked()) {
      return (
        headline +
        (readers.length > 0
          ? '看图请改用读图子代理：' + readers.join(' 或 ') + '，把图片路径交给它。'
          : '当前也没有可用的读图子代理（原生读图被屏蔽、读图员都没开），所以你现在没有任何看图途径；' +
            '请让用户在 插件页 → ' + PLUGIN_LABEL + ' → 配置卡 里打开 ask_glm 或 ask_qwen，然后让用户确认图片内容。') +
        '不要用 read 重试这个路径，也不要靠猜图片内容。'
      )
    }
    return (
      headline +
      '看图请改用 read_image（把图片路径交给它）' +
      (readers.length > 0 ? '，或读图子代理：' + readers.join(' 或 ') : '') +
      '。不要用 read 重试这个路径，也不要靠猜图片内容。'
    )
  })

  /**
   * 第四条守卫：**审计"委派子代理去看图"**（2026-10-13 实测问题）。
   *
   * 现场：模型宁可 spawn 一个通用子代理替它读图，也不用 `ask_glm` / `ask_qwen`。
   * 那条路绕开了本插件的一切约束（读图员只读契约、成本记账、互斥仲裁），
   * 而且子代理拿到的图与主代理看到的是同一套降采样结果，质量并不会更好。
   *
   * 为什么只能在 guard 层做：`subagent` 的工具**注册**属于官方包，插件无法全局摘除
   * （`tools.restrict` 明确"绝不过滤自己那一层注册的"），也拿不到 spawn 的创建钩子。
   * 但 guard 能在**调用发出前**拿到完整入参，于是就有了这个审计点 ——
   * 判据不是"是不是视觉任务"（那太窄），而是**委派描述里有没有"帮我读图"的语义**：
   *   - 出现图片文件路径（.png/.jpg/…），或
   *   - 出现明确的视觉意图词（读图 / 看图 / 截图理解 / 排版检查 / read the image …）。
   *
   * 门槛故意收窄：不认单个"图"字，所以"帮我画一张图"（出图）不会被误伤。
   * 只审主代理；委派工具自己的名字可在配置里改，所以默认名都认。
   *
   * ⚠ 已知边界（写清楚，不假装完备）：这是**语义审计**，靠文字线索判定。
   * 模型若用不含路径、也不含上述字眼的措辞（例如"看看这个文件里画的什么"里
   * 恰好没命中词表），仍可能绕过。真正零漏网的做法是彻底禁用委派工具，
   * 代价是主代理失去一切委派能力 —— 本项目当前选择"只禁视觉用途"。
   */
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || !DELEGATION_TOOLS.includes(name)) return undefined
    if (isSubagent(exec?.agent)) return undefined
    const text = delegationTextOf(exec?.args)
    if (!looksLikeVisionDelegation(text)) return undefined
    const readers = READER_TOOLS.filter((tool) => switches.isEnabled(tool))
    const headline =
      '已拦截：不要为"读图/看图"去委派 ' + name + '。这类图像任务**只能**由读图子代理完成，' +
      '委派通用子代理会绕开读图员的只读契约、成本记账与互斥仲裁，画质也不会更好。'
    if (readers.length > 0) {
      return headline + '请直接调用 ' + readers.join(' 或 ') + '，把图片路径交给它。不要重试 ' + name + '。'
    }
    return (
      headline +
      '当前 ask_glm 与 ask_qwen 都没开，你现在没有任何看图途径；' +
      '请让用户在 插件页 → ' + PLUGIN_LABEL + ' → 配置卡 里打开其中一个，' +
      '然后由用户确认图片内容。不要重试 ' + name + '，也不要靠猜图片内容。'
    )
  })

  /** 对账周期：够快（人感觉不到）又够省（一次数组比较）。 */
  const RESTRICT_SYNC_MS = 1000
  ctx.effect(() => {
    const timer = setInterval(syncRestrictions, RESTRICT_SYNC_MS)
    // 不要因为这个定时器把进程钉住（测试/CLI 场景尤其重要）。
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  ctx.on('agent/created', (payload) => {
    if (payload?.agent === undefined) return
    // 先落一条记录（即使当前不需要限制），这样配置之后变严也能立刻对上账——
    // 否则"创建时无需限制"的 agent 永远不会被 syncRestrictions 看到。
    restrictions.set(payload.agent, { deny: undefined, dispose: undefined })
    syncAgent(payload.agent)
  })
  ctx.on('agent/disposed', (payload) => {
    const current = restrictions.get(payload?.agent)
    if (current?.dispose !== undefined) {
      try {
        current.dispose()
      } catch {
        // 忽略：agent 即将被释放
      }
    }
    restrictions.delete(payload?.agent)
  })
  ctx.effect(() => () => {
    for (const current of restrictions.values()) {
      if (current?.dispose === undefined) continue
      try {
        current.dispose()
      } catch {
        // 忽略
      }
    }
    restrictions.clear()
  })

  let ledgerPromise
  const getLedger = () => {
    ledgerPromise ??= openLedger(ctx, liveConfig, logger)
    return ledgerPromise
  }
  // 插件卸载时关闭已打开的账本领域。
  ctx.effect(() => () => {
    if (ledgerPromise !== undefined) {
      ledgerPromise.then((ledger) => ledger.close()).catch(() => {})
    }
  })

  // 任务注册表：整轮失败/超时后还能用 media_task(action=list) 把任务找回来。
  let taskRegistryPromise
  const getTaskRegistry = () => {
    if (liveConfig?.persistTasks === false) return Promise.resolve(undefined)
    taskRegistryPromise ??= openTaskRegistry(ctx, liveConfig, logger)
    return taskRegistryPromise
  }
  ctx.effect(() => () => {
    if (taskRegistryPromise !== undefined) {
      taskRegistryPromise.then((registry) => registry.close()).catch(() => {})
    }
  })

  // 出图缓存：相同 prompt + 参数直接复用，不再计费。
  let imageCachePromise
  const getImageCache = () => {
    if (liveConfig?.cacheResults === false) return Promise.resolve(undefined)
    imageCachePromise ??= openImageCache(liveConfig, logger)
    return imageCachePromise
  }

  const deps = { ctx, config: liveConfig, manager, keys, getLedger, getTaskRegistry, getImageCache, budget, switches, logger }
  ctx.tools.register(createQwenDrawTool(deps))
  ctx.tools.register(createSeedanceVideoTool(deps))
  ctx.tools.register(createMediaTaskTool(deps))
  ctx.tools.register(createMediaReportTool(deps))

  // 可选显式降级（规划 [6.4]，默认关闭）：读图子代理失败时给出"不要卡住"的替代指引。
  const degradeToText = typeof config.degradeToText?.get === 'function' ? config.degradeToText.get() : config.degradeToText
  if (degradeToText === true) {
    ctx.on('tools/post-execute', (exec, result, next) => {
      if ((exec?.name !== 'ask_glm' && exec?.name !== 'ask_qwen') || result?.isError !== true) return next()
      const text = Array.isArray(result.content)
        ? result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
        : ''
      const guidance = text.length > 0 ? text.slice(0, 300) : '（未取得厂商细节）'
      return {
        kind: 'block',
        feedback: [
          {
            type: 'text',
            text: '读图失败（' + exec.name + '）：' + guidance + '\n提示：请改用文字描述，或换一张更清晰的图片；也可以继续推进不依赖这张图的工作，不要卡住。',
          },
        ],
      }
    })
  }

  const promptSection = typeof config.promptSection?.get === 'function' ? config.promptSection.get() : config.promptSection
  if (promptSection !== false) {
    ctx.systemPrompt.section({
      name: 'mm-models:division',
      order: 210,
      text: PROMPT_SECTION,
    })
  }

  // 启动自检 ①（只告警，不改配置、不拦启动）：单价表是否够用。
  // 2026-10-15 事故：seedanceModel 换成新模型 id，而单价表只有旧键 'seedance-2.0'，
  // 于是出片在花费闸门处 fail-closed，**工具静默不可用、日志里一个字都没有**。
  // 现在这类"配置引用了查不到价的模型"会在启动时就点名，并同样出现在 media_report(health) 里。
  // 传 liveConfig：pricing 虽是普通字段，但取值统一走解包 Proxy，避免两套读取语义。
  try {
    for (const warning of pricingWarnings(liveConfig)) {
      logger?.warn?.('[mm-models] 单价表告警：' + warning)
    }
  } catch (error) {
    logger?.debug?.('[mm-models] 单价表自检跳过：' + String(error?.message ?? error))
  }

  // 启动自检 ②（只告警，不改配置、不拦启动）：读图子代理必须仍然"只看图"。
  // 契约在 core/reader-guard.mjs；一旦有人把 read / glob / grep 之类加回
  // toolFilter.allow，环境探查能力就漏回去了，这里要让人在日志里立刻看见。
  // 一次性检查（没有需要清理的副作用），所以不包 ctx.effect。
  try {
    for (const item of inspectReaderFilters()) {
      logger?.warn?.(
        '[mm-models] 读图子代理安全告警：' + item.id + ' 的 toolFilter 不符合"只看图"契约（' + item.reason + '）。' +
          '契约要求 allow 恰好为 [' + READER_ALLOWED_TOOLS.join(', ') + ']；文件：' + item.file,
      )
    }
  } catch (error) {
    logger?.debug?.('[mm-models] 读图子代理自检跳过：' + String(error?.message ?? error))
  }

  logger?.info?.('[mm-models] 已注册 qwen_draw / seedance_video / media_task / media_report（ask_glm / ask_qwen 由 tool-subagent 行提供，互斥）')
}
