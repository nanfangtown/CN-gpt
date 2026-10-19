/**
 * dsh-mm-models —— DeepSeek 主脑 + GLM 读图 / Qwen 制图 / Seedance 出片。
 *
 * 规划：dsh-创作模式插件-规划.txt v0.7。
 * 本文件 = Config + 注册 7 个工具 + 提示词段落（无 persona、无前端）。
 *
 * 顶层工具（与 bash / ops_* 同级）：
 *   ask_glm        读图员（GLM-4.6V；2026-10-17 起由本插件自己注册，见 tools/reader.mjs）
 *   ask_qwen       读图员（百炼 Qwen-VL；与 ask_glm 互斥，二选一）
 *   qwen_draw      DashScope 异步文生图
 *   seedance_video 方舟 Ark 异步文生 / 图生视频
 *   video_gen      百炼异步出片（可灵 v3 / 万相 2.5，复用 DASHSCOPE_API_KEY）
 *   media_task     异步任务重查 / 补下载
 *   media_report   成本估算 + 链路健康
 */
import z from '@deepseek-ai/schemastery'

import { createTaskManager } from './tasks/manager.mjs'
import { dashscopeImageAdapter } from './tasks/adapters/dashscope-image.mjs'
import { arkVideoAdapter } from './tasks/adapters/ark-video.mjs'
import { dashscopeVideoAdapter } from './tasks/adapters/dashscope-video.mjs'
import { createQwenDrawTool } from './tools/qwen-draw.mjs'
import { createSeedanceVideoTool } from './tools/seedance-video.mjs'
import { createVideoGenTool } from './tools/video-gen.mjs'
import { createMediaTaskTool } from './tools/media-task.mjs'
import { createMediaReportTool } from './tools/media-report.mjs'
import { createReaderTools } from './tools/reader.mjs'
import { createDelegationTools } from './tools/delegation.mjs'
import { createKeyResolver } from './core/keys.mjs'
import { createReaderUsageMeter } from './core/reader-usage.mjs'
import { DEFAULT_PRICING, PRICING_ZERO_HINT, openLedger, pricingOf, pricingWarnings } from './core/cost.mjs'
import { openTaskRegistry } from './core/tasks.mjs'
import { openImageCache } from './core/cache.mjs'
import { createCallBudget, createSwitches } from './core/tool-kit.mjs'
import { READER_ALLOWED_TOOLS, inspectReaderFilters, inspectReaderRoutes, isReaderAgent, mergeReaderRoutes } from './core/reader-guard.mjs'

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
 * == 2026-10-16 第二次瘦身：去掉"身份声明"，只留可执行策略 ==
 * 实测（57/57 个读图员会话、20/26 个通用子代理会话）都带上了这段 710 B 的文本，
 * 而它开头是"你是主创兼工程师（DeepSeek 会话主模型）…最终交付由你完成"——
 * **对读图员是错的**：读图员的 persona 明说"你只能看图，其余超出能力"，
 * 两段放在同一份系统提示里直接打架（读图员 prompt 的 11.9% 是这段）。
 * 现在：删掉身份/交付叙事（那是宿主与该 agent 自身角色决定的，不该由插件越俎代庖），
 * 只保留**宿主不管、只有插件知道**的三条策略，并压到 ~1/3 字节。
 *
 * 保留的三条（缺一不可）：
 *   1. 媒体分工与成本纪律（工具出素材、生成要花钱）；
 *   2. **读图路由**：原生优先；原生被屏蔽/不支持或要省钱时走已开启的读图员；
 *      两者都不可用才如实说没有途径、不要猜图（2026-10-17 起不再写死"一律走 ask_glm"）；
 *   3. **窄委派**：子代理每轮要背全部工具 schema（实测 35 个工具 ≈ 32 KB），
 *      所以按用途选窄工具面的委派工具，别拿通用 subagent 干小活。
 */
/** 媒体分工与窄委派两条固定策略（与读图路由无关的那部分）。 */
const PROMPT_FIXED = {
  division: '【媒体分工】媒体工具只出素材与结论，交付由主模型负责并负全责；生成可能计费，先确认能力可用。',
  delegate: '【窄委派】子代理每轮背全部工具表（35个≈32KB）：跑命令/改代码用 subagent_code，查资料用 subagent_research。',
}

/**
 * 分工说明段落（按当前读图策略生成）。
 *
 * 2026-10-17：读图路由**不能写死**——出厂默认是"读图员开 + 原生屏蔽"，而用户也可以
 * 反过来配成"原生优先"。写死任何一句都会在另一种配置下变成假话（模型有眼睛却被告知
 * "没有看图途径"，或反过来被告知"走 ask_glm"但读图员已关）。
 *
 * @param {boolean} nativeBlocked - 主代理原生读图是否被屏蔽（blockMainAgentNativeVision）。
 * @returns {string} 段落文本。
 */
function buildDivisionSection(nativeBlocked) {
  const routing = nativeBlocked
    ? '【读图路由】主代理原生读图已屏蔽：图像识别/分析/审查一律走 ask_glm 或 ask_qwen（把图片路径交给它）；两个都关才如实说"没有看图途径"，不要猜图。'
    : '【读图路由】优先用原生 read_image 做细节审读；原生被屏蔽/不支持，或要批量省钱时走**已开启的** ask_glm / ask_qwen（把图片路径交给它）；两者都不可用就如实说"没有看图途径"，不要猜图。'
  return [PROMPT_FIXED.division, routing, PROMPT_FIXED.delegate].join('\n')
}

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
  // ---- 百炼视频（可灵 / 万相）：端点与业务空间 ----
  //
  // ⚠ 百炼视频的域名不是 dashscope.aliyuncs.com，而是
  //     https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1
  //   且 key 必须是华北2（北京）地域的。WorkspaceId 空着时 video_gen 会 fail-closed
  //   并指名去配置卡填 —— 绝不猜一个域名去试：付费接口上试错等于下单。
  dashscopeWorkspaceId: z
    .string()
    .default('')
    .volatile()
    .description('百炼业务空间 ID（形如 llm-xxxx；也可整串粘贴 API Host）：百炼控制台 → 业务空间管理 https://bailian.console.aliyun.com/cn-beijing/settings/workspace 的 API Host 列。用于拼出视频端点 https://{id}.cn-beijing.maas.aliyuncs.com/api/v1。'),
  dashscopeVideoBase: z
    .string()
    .default('')
    .volatile()
    .description('视频端点完整基址（可选覆盖）：留空则按 dashscopeWorkspaceId 自动拼；填了就完全以它为准（地域/域名变更时用）。'),
  videoModel: z
    .string()
    .default('kling/kling-v3-video-generation')
    .volatile()
    .description('video_gen 默认模型 id。可选：kling/kling-v3-video-generation（0.6–3.0 元/秒）、kling/kling-v3-turbo-video-generation、kling/kling-v3-omni-video-generation、wan2.5-t2v-preview（0.6–1.0 元/秒）。⚠ 换 id 必须同步存在于单价表，否则闸门 fail-closed。'),
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
  // 语义：距上次生成超过下面的 `callBudgetIdleResetMs`（默认 25 秒）即视为新一轮、计数重置。
  // 所以它限制的是**一口气连做几个**，不是整场会话的总量。默认 6 = 一次能连续出 6 张/条
  // （例如一组分镜）；超出后需等约 25 秒，或在配置卡里调大。0 = 不限制。
  // ⚠ 这两处秒数是**算出来的**（tool-kit.mjs 的 budgetMessage 由 callBudgetIdleResetMs 推算），
  // 早先注释里写死"60 秒"（那是历史默认值），值改到 25 秒后注释没跟着改 —— 已修正。
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
  videoCostLimitCNY: z.number().step(1).min(0).default(10).volatile().description('单次付费生成（出片/出图）的花费上限（元），默认 10；提交前按单价×时长（出图按张数）估算，超限直接拒绝且不产生费用。0 = 不限制。'),
  // 会话累计上限：防"反复试、每次都不贵"的烧钱模式。
  // 2026-10-15 的事故正是这种形态——22 次调用单看都不贵（4–30 秒），合计 ¥195.97。
  // 只做单次上限的话，那道闸会放行其中 10 次、合计 ¥71.69。所以两层都要有。
  videoSessionCostLimitCNY: z.number().step(1).min(0).default(30).volatile().description('单个会话的付费生成累计花费上限（元），默认 30；超出后提交前拒绝。专门防"反复试"的烧钱模式。0 = 不限制。'),
  // 强制花费确认（2026-10-15 加）：付费接口必须"先报价、再确认"才提交。
  //
  // 为什么默认开：事故的根因不是参数算错，而是**提交路径上没有任何强制意图声明**——
  // "探测参数"和"下单购买"在接口层面长得一模一样。要求调用方复述精确金额，
  // 就能让"无意识的循环试参"在第一步就停下（它每次都得先算钱）。
  // 这一层比金额上限更根本：**上限只限制花多少，确认改变的是"会不会无意识花钱"。**
  requireSpendConfirm: z.boolean().default(true).volatile().description('付费生成（出片/出图）必须先用确认参数复述预估金额才提交（默认开）。关闭后仅保留金额上限校验，供测试或明确不需要确认的场景使用。'),
  // 小额免确认（2026-10-16 加，用户要求）：只跳过上面那层"复述金额"，
  // **单次/会话上限照旧生效**，未计价也照旧 fail-closed。
  // 为什么需要它：确认流程天然是两次调用，而制图单张 0.18 元、一批最多 4 张（¥0.72），
  // 每次都多一轮往返不划算。默认 1 元正好覆盖"制图任何一批"，而出片 1 秒就是 ¥1.52 → 仍要确认。
  noConfirmUnderCNY: z
    .number()
    .min(0)
    .default(1)
    .volatile()
    .description('小额免确认阈值（元）：预估不超过它就**直接提交、不必复述金额**；单次/会话上限与"未计价 fail-closed"不受影响。默认 1（制图一批最多 4 张 = ¥0.72，免确认；出片 1 秒 = ¥1.52，仍要确认）。0 = 关闭该机制，一律要确认。'),

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
  // ---- 子代理能不能自己生成（2026-10-16 加）----
  //
  // 实测（会话日志）：**通用/原生子代理手里有 `qwen_draw`**（19/28 个会话；读图员 0/59，
  // 因为白名单挡住了）。而制图这条路在默认配置下是"**免确认**"的：
  // `noConfirmUnderCNY` 默认 1 元，一批最多 4 张 = ¥0.72 < 1 → 直接提交、不用复述金额。
  //
  // **策略决定（用户 2026-10-16 明确）**：**允许**子代理生成 —— 繁重任务里"只让主代理发指令"
  // 效率太低，而普通任务基本用不到子代理出图。所以默认**不拦**。
  // 代价与边界如实写在这里：子代理的花费记在**它自己的会话**上，主代理那次 cost(session)
  // 看不到（已补"会话树"聚合，见 core/cost.mjs 的 sessionIds），单次/会话上限也各自独立。
  //
  // 这个开关是**刹车**：无人值守跑重活、或要临时收紧时设 true，子代理立刻只能回报需求。
  blockSubagentSpend: z
    .boolean()
    .default(false)
    .volatile()
    .description('禁止**子代理**调用生成类工具（qwen_draw / seedance_video / video_gen）。'
      + '默认 false = 允许（繁重任务里让子代理直接出图，效率优先；代价是它的花费记在自己会话上，'
      + '主代理的 cost(session) 现在会连会话树一起汇总）。'
      + '设 true = 子代理只能把生成需求回报给主代理，由主代理统一编排 —— 适合无人值守跑重活时收紧。'),
  // ---- 只挡视频、不挡图片（2026-10-17 按使用要求加）----
  //
  // 为什么不复用上面那个开关：`blockSubagentSpend` 是"一刀切"（连出图都挡），
  // 而实际策略是**分级的**：子代理出一张图 ¥0.18，出片一次 ¥1.8–¥10，
  // 贵 10–50 倍且不可撤销。用户要的是"图可以、片不行"，一个布尔表达不了。
  //
  // 语义：只拦 `seedance_video` / `video_gen`；`qwen_draw`、`ask_glm` / `ask_qwen`
  // 一律不受影响。与 `blockSubagentSpend` 是**或**关系（任一为 true 就拦）。
  // 读图员本身也是子代理，但它没有这两个工具，等于天然豁免。
  blockSubagentVideoSpend: z
    .boolean()
    .default(false)
    .volatile()
    .description('禁止**子代理**调用出片工具（seedance_video / video_gen），但**不禁止出图**（qwen_draw）与读图（ask_glm / ask_qwen）。'
      + '默认 false = 允许子代理出片。设 true = 子代理只能把出片需求回报给主代理；图片生成与看图照旧可用。'
      + '与 blockSubagentSpend 是或关系（后者连出图一起挡）。'),

  // ---- 任务注册表（2026-10-13 加）：整轮失败后还能找回任务 ----
  persistTasks: z.boolean().default(true).volatile().description('把提交过的异步任务登记到本地，便于整轮失败/超时后用 media_task(action=list) 找回并补下载。'),
  taskRegistryPath: z.string().default('').volatile().description('任务注册表文件路径；留空 = %USERPROFILE%/.dsh/mm-models-tasks.json。'),
  maxRegistryEntries: z.number().step(1).min(10).default(200).volatile().description('任务注册表保留条数上限（超出丢弃最旧的）。'),
  registryTtlMs: z.number().step(3600000).min(3600000).default(604800000).volatile().description('任务注册表条目保留时长（默认 7 天），过期的查询时顺手清理。'),

  // ---- 工具开关（插件页 → gpt-CN → 配置卡，一键勾选；关闭后调用被拒，新会话不再显示）----
  // 2026-10-17 起出厂默认 = "开箱即见效果"：读图员开着、原生读图屏蔽着。
  // 想让模型用原生读图，关掉下面两个 block 开关即可（不必动读图员）。
  enableAskGlm: z.boolean().default(true).volatile().description('允许主 agent 使用 ask_glm（GLM 读图子代理）。**默认开启**：装上即走读图员，配合下面两个 block 开关就是开箱即用的确定性读图路由。与 enableAskQwen 互斥：打开它就会自动关闭 ask_qwen，反之亦然；两个都关时没有读图工具。'),
  enableAskQwen: z.boolean().default(false).volatile().description('允许主 agent 使用 ask_qwen（Qwen-VL 读图子代理）。默认关闭（与 ask_glm 互斥）。与 enableAskGlm 互斥：打开它就会自动关闭 ask_glm，反之亦然；两个都关时没有读图工具。'),

  // ---- 读图员路由（2026-10-17：工具改由插件自己注册，改完需完整重启）----
  //
  // 以前这两组值写在 cordis.patch.yml 的 tool-subagent 行里，插件靠"文本扫描配置"
  // 反推读图员是谁。现在工具在 tools/reader.mjs 里注册，路由的单一事实源就是这里。
  // ⚠ 模型 id 必须同时出现在 llm-pi-ai 的 providers.<provider>.models 白名单里，
  //   否则 spawn 会报 `pi-ai provider "glm" has no configured model "…"`（实测踩到）。
  readerGlmProvider: z.string().default('glm').volatile().description('ask_glm 的子代理路由 provider（llm-pi-ai 里配置的名字）。'),
  readerGlmModel: z.string().default('glm-5.3-flash').volatile().description('ask_glm 使用的模型 id（必须在 providers.glm.models 白名单里）。'),
  readerQwenProvider: z.string().default('qwen-vl').volatile().description('ask_qwen 的子代理路由 provider（llm-pi-ai 里配置的名字）。'),
  readerQwenModel: z.string().default('qwen3-vl-plus').volatile().description('ask_qwen 使用的模型 id（必须在 providers.qwen-vl.models 白名单里）。'),
  readerAgentPreset: z.string().default('mm-reader').volatile().description('读图员子代理的 agent preset id（persona + 只有 read_image 的工具面）。'),
  readerMaxDepth: z.number().step(1).min(1).max(9).default(2).volatile().description('读图员的绝对委派深度上限，默认 2（= 已委派的子代理也能调它，否则会报 "subagent depth 2 exceeds maxDepth 1"）。'),

  // ---- 窄委派（2026-10-18：工具改由插件自己注册，见 tools/delegation.mjs）----
  //
  // 以前是 profile 里两条 `tool-subagent` 行（agentPreset 在**装配期**校验）。
  // 2026-10-18 桌面端启用插件时热重载，preset 行还没 register、委派行已经 apply，
  // 两条工具直接报 "Unknown agent preset" —— 这是竞态，不是配置错。
  // 现在 preset 在**调用时**才解析，装配期不再依赖 preset 是否已注册。
  codeAgentPreset: z.string().default('mm-code').volatile().description('subagent_code 的 agent preset id（persona + 命令 / 文件读写 / 查找的窄工具面）。'),
  researchAgentPreset: z.string().default('mm-research').volatile().description('subagent_research 的 agent preset id（persona + 只读文件 / 网页检索的窄工具面）。'),
  delegationMaxDepth: z.number().step(1).min(1).max(9).default(1).volatile().description('窄委派（subagent_code / subagent_research）的绝对委派深度上限，默认 1（子代理不能再往下委派）。'),

  enableQwenDraw: z.boolean().default(true).volatile().description('允许主 agent 使用 qwen_draw（Qwen 制图）。'),
  blockMainAgentNativeVision: z
    .boolean()
    .default(true)
    .volatile()
    .description('屏蔽主 agent 的原生读图：打开后主 agent 的工具列表里不再有 read_image，读图只能走 ask_glm / ask_qwen。'
      + '**默认开启**（2026-10-17 起）：开箱即用的确定性读图路由，让新用户一装上就看到插件的效果。'
      + '想让模型用原生读图，把它和 blockSubagentNativeVision 一起关掉即可。改完需完整重启才生效。'),
  // ---- 屏蔽"通用子代理"的原生读图（2026-10-15 加；2026-10-17 起默认开）----
  //
  // 背景：原生子代理**天生就有 read_image**（插件只摘主代理那只眼睛，子代理留着当"眼睛"），
  // 而插件现有的三条守卫都只针对主代理。于是繁重任务里，子代理会自己读图，
  // 绕开读图员的只读契约与路由策略。这个开关把策略延伸到子代理。
  //
  // ⚠ 打开前必须满足两个前提，否则会**把看图能力整体掐掉**：
  //   ① 读图员开着（ask_glm 或 ask_qwen）；
  //   ② 读图员的 `readerMaxDepth` ≥ 2 —— 否则已委派的子代理调不动读图员
  //      （实测错误：`subagent depth 2 exceeds maxDepth 1`）。
  // 读图员**永远豁免**：判别依据取自 Config 的 reader* 路由（不是硬编码猜的），
  // 认不出读图员时本开关对子代理**不生效**（fail-open，宁可不屏蔽也不能弄瞎读图员）。
  blockSubagentNativeVision: z
    .boolean()
    .default(true)
    .volatile()
    .description('屏蔽**通用子代理**的原生读图：打开后除读图子代理（ask_glm / ask_qwen 的路由）外，其它子代理的工具表里不再有 read_image，看图必须走读图子代理。'
      + '**默认开启**（与主代理一致：全家都走读图员）；想让子代理自己看图就关掉它和 blockMainAgentNativeVision。'
      + '⚠ 打开前请确认：① 读图员开着；② readerMaxDepth ≥ 2（否则子代理调不动读图员，会彻底失去看图途径）。'
      + '读图员的判定取自 Config 的 reader* 路由；认不出读图员时本开关对子代理不生效并告警。'),
  enableSeedanceVideo: z.boolean().default(false).volatile().description('允许主 agent 使用 seedance_video（Seedance 出片）。默认关闭：Ark 未开通/门槛较高，接通后在设置里一键打开。'),
  enableVideoGen: z
    .boolean()
    .default(false)
    .volatile()
    .description('允许主 agent 使用 video_gen（百炼出片：可灵 v3 / 万相 2.5）。默认关闭：复用 DASHSCOPE_API_KEY，但需要先填业务空间 ID 并在百炼控制台开通可灵模型，接通后一键打开。'),
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
  const adapters = [dashscopeImageAdapter, arkVideoAdapter, dashscopeVideoAdapter]
  const manager = createTaskManager({ adapters, config: liveConfig, logger })
  // 注意：必须传 liveConfig（解包过的 Proxy），不能传原始 config。
  // volatile 字段在 config 上是**引用对象**（`{ get() }`），keys.mjs 里用的是
  // `nonEmptyString(config[...])`，拿到对象会判定成"没填" → 字面值 key 与
  // 自定义引用名都会被静默忽略、一路回落到默认引用名（2026-10-13 实测发现）。
  const keys = createKeyResolver(ctx, liveConfig)
  // Seedance 只读自检（2026-10-16）：拿 key 去问官方目录"哪个模型能用、单价多少"，
  // 不再靠手抄 id 表。**只读**——绝不提交任务（提交类 200 等于已下单，见 README 2026-10-15 教训）。
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

  /**
   * 取一次工具调用的**入参**。
   *
   * ⚠⚠ 2026-10-16 实测发现的生产级缺陷（本文件最值得记住的一条）：
   * harness 的守卫签名是
   *   `type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`
   * 而 `ToolExecution`（继承 `ToolExecutionInput`）里，入参字段叫 **`arguments`**：
   *   `interface ToolExecutionInput { callId; rootCallId?; name; schema?; arguments: unknown; agent?; ... }`
   * —— **没有 `args`**。本插件早期按 `exec.args` 读，于是**凡是用到入参的守卫**
   * （第三条"read 读图片"指路、第四条"委派读图"审计）在生产里拿到的永远是 `undefined`，
   * 等于**从未生效**；而单测一直是绿的，因为 fixtures 手搓的执行对象是 `{ name, args, agent }`
   * —— **测试与真实契约不一致**，这才是这次事故的根因。
   * （现场证据：主代理 `read` 一张 jpg 得到的是 harness 原生的
   * `cannot read "…jpg": binary file`，而不是本插件那条指路文案。）
   *
   * 现在两种写法都读：优先真实契约的 `arguments`，兼容既有测试/旧形态的 `args`。
   * 回归断言在 `tests/run.mjs`（用 harness 形状 `{ name, arguments, agent }` 构造执行对象）。
   */
  const argsOf = (exec) => exec?.arguments ?? exec?.args

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
   *
   * ⚠ 2026-10-18：两条窄委派工具（subagent_code / subagent_research）**有意不**加进
   *   这张表 —— 审计它们会把"改 png 尺寸 / 转格式 / 看图床路径"这类正常执行任务
   *   误判成视觉委派（读图员那条审计的误伤率实测 6/10）。保持与 2026-10-16
   *   引入窄委派时一致：窄委派的工具面里没有 read_image（preset 关着），
   *   真要看图仍应走 ask_glm / ask_qwen。
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
  /**
   * 屏蔽"通用子代理"的原生读图（见 Config 里 blockSubagentNativeVision 的说明）。
   * 与 `nativeVisionBlocked` 同族：都读实时配置，所以改开关下一个 tick 就对账。
   */
  const subagentVisionBlocked = () => liveConfig?.blockSubagentNativeVision === true

  /**
   * 读图员路由白名单。
   *
   * ⚠ 2026-10-17 改：读图工具由本插件自己注册（`tools/reader.mjs`），所以路由的
   * **单一事实源是 Config**，不再是 patch 里的 `tool-subagent-glm/-qwen` 行。
   * 契约文件扫描结果仍然并进来：旧装配、别的 profile、以及"用户手写了行"的情况
   * 都还能认出来（扫描结果为空时不影响）。
   *
   * 认不出任何路由 → 放弃对子代理的原生读图屏蔽（fail-open，绝不把读图员弄瞎）。
   */
  const configuredReaderRoutes = () => [
    {
      id: 'ask_glm',
      provider: liveConfig.readerGlmProvider,
      model: liveConfig.readerGlmModel,
      maxDepth: liveConfig.readerMaxDepth,
    },
    {
      id: 'ask_qwen',
      provider: liveConfig.readerQwenProvider,
      model: liveConfig.readerQwenModel,
      maxDepth: liveConfig.readerMaxDepth,
    },
  ].filter((route) => (typeof route.provider === 'string' && route.provider.length > 0)
    || (typeof route.model === 'string' && route.model.length > 0))

  let readerRoutes
  try {
    readerRoutes = mergeReaderRoutes([...inspectReaderRoutes(), ...configuredReaderRoutes()])
  } catch (error) {
    readerRoutes = mergeReaderRoutes(configuredReaderRoutes())
    logger?.warn?.('[mm-models] 读图员路由自检失败（已退回 Config 里的路由）：' + String(error?.message ?? error))
  }
  /** 一行读图员路由都认不出来 → 不对子代理下手。 */
  const readerRoutesUnknown = readerRoutes.routes.length === 0
  const isReader = (agent) => isReaderAgent(agent, readerRoutes)

  /**
   * 最近几次"读图屏蔽判定"的快照（新 agent 创建或策略变化时记一条）。
   *
   * 为什么要留这个：屏蔽通用子代理的原生读图**判错的代价是把读图员一起弄瞎**，
   * 而插件日志在 DSH 里不落盘、用户看不见（本项目自己的教训："看不见的告警等于没有告警"）。
   * 所以把判定结果送进 `media_report(action=health)`，让"谁被认成读图员"随时可查。
   */
  const visionDecisions = []
  /**
   * 探测：这个 agent 身上拿不拿得到 **tool scope**？
   *
   * 为什么值得探测：`ctx.systemPrompt.section()` 的 `text` 支持函数形式
   * `(context: AssembleContext) => string`，而 `AssembleContext = { scope?, signal? }`
   * （`ScopeKey` 是不透明 object）。**若能建立 scope → 读图员 的映射，就能让那段
   * "写给主模型"的提示词对读图员彻底消失（省 100%，而不是压缩 1/3）**。
   * 这条诊断就是把"拿不拿得到"变成可观测事实，结果会出现在 media_report(health) 里。
   * 拿不到就维持现状（压缩版段落），不冒险。
   */
  const probeScope = (agent) => {
    try {
      const ctx = agent?.ctx
      const seen = []
      seen.push('ctx=' + (ctx === undefined || ctx === null ? 'missing' : typeof ctx))
      if (ctx !== undefined && ctx !== null) {
        // 0.2.1 起 `ctx.tools.scope` 需要 inject 才能读，直接访问会抛
        // "cannot get property \"scope\" without inject"（2026-10-17 实测）。
        // 诊断不能因为一条探测失败就丢掉整份快照，所以逐项兜住。
        const probe = (label, read) => {
          try {
            const value = read()
            seen.push(label + '=' + (value === undefined ? 'undefined' : typeof value))
          } catch (error) {
            seen.push(label + '=err(' + String(error?.message ?? error).slice(0, 40) + ')')
          }
        }
        // 2026-10-17：0.2.1 起 `ctx.scope` 必须 inject 才能读（直接访问必抛
        // "cannot get property \"scope\" without inject"）。已确认拿不到，就不再
        // 每次探测都制造一条 err 文本，直接标注不可用；`ctx.tools.scope` 仍可探测。
        seen.push('ctx.scope=unavailable(needs-inject)')
        probe('ctx.tools.scope', () => ctx.tools?.scope)
      }
      seen.push('agent.scope=' + (agent?.scope === undefined ? 'undefined' : typeof agent.scope))
      seen.push('options.scope=' + (agent?.options?.scope === undefined ? 'undefined' : typeof agent.options.scope))
      return seen.join(' ')
    } catch (error) {
      return 'probe-error: ' + String(error?.message ?? error)
    }
  }
  const rememberVisionDecision = (agent, denied) => {
    visionDecisions.push({
      at: new Date().toISOString(),
      subagent: isSubagent(agent),
      reader: isReader(agent),
      provider: agent?.options?.provider ?? null,
      model: agent?.options?.model ?? null,
      denied: denied === true,
      scope: probeScope(agent),
    })
    if (visionDecisions.length > 5) visionDecisions.shift()
  }
  /** agent → { deny: string[]|undefined, dispose: (()=>void)|undefined }。 */
  const restrictions = new Map()

  /**
   * 这个 agent 应该被贴什么工具掩码（按**实时**配置计算）。
   *
   * 形状是 `{ allow?, deny? }`（`ctx.tools.restrict` 的原生契约），不是单纯的 deny 数组：
   * 读图员用 `allow: [read_image]` —— **白名单**比"把 35 个工具一个个 deny"更可靠，
   * 以后宿主新增全局工具也不会自动漏进读图员的工具面。
   *
   * @returns {{allow?: string[], deny?: string[]}|undefined} undefined = 无需限制。
   */
  const desiredRestriction = (agent) => {
    // 读图员：只保留看图工具（物理收窄工具面；scope 注入的 ops_bash / subagent 过滤不掉，
    // 那两个仍由下面的运行时 guard 兜底）。
    if (isReader(agent) && !readerRoutesUnknown) return { allow: [NATIVE_VISION_TOOL] }
    const deny = switches.disabledNames()
    // 原生读图（read_image）的屏蔽分两类：
    //   - 主代理：blockMainAgentNativeVision；
    //   - **通用子代理**：blockSubagentNativeVision（默认关 = 保持"子代理自己看图"的旧行为）。
    // 读图员**永远豁免**：它是插件唯一的眼睛，摘掉就直接瞎（2026-10-13 实测过这个惨状）。
    if (isSubagent(agent)) {
      // `readerRoutesUnknown` 是安全阀：认不出读图员时宁可少屏蔽一次，也不能赌。
      if (subagentVisionBlocked() && !readerRoutesUnknown && !isReader(agent)) deny.push(NATIVE_VISION_TOOL)
    } else if (nativeVisionBlocked()) {
      deny.push(NATIVE_VISION_TOOL)
    }
    return deny.length > 0 ? { deny } : undefined
  }

  const sameList = (left, right) => {
    if (left === undefined || right === undefined) return left === right
    return left.length === right.length && left.every((name, index) => name === right[index])
  }

  const sameRestriction = (left, right) => {
    if (left === undefined || right === undefined) return left === right
    return sameList(left.allow, right.allow) && sameList(left.deny, right.deny)
  }

  /** 按实时配置给一个 agent 贴/撤掩码；没有变化就不动（避免无谓的掩码链增长）。 */
  const syncAgent = (agent) => {
    const current = restrictions.get(agent)
    const desired = desiredRestriction(agent)
    if (current !== undefined && sameRestriction(current.restriction, desired)) return
    // 只在"判定结果真的变了"时记一条：新建 agent、或策略被改。稳态下不产生记录。
    rememberVisionDecision(agent, desired?.deny?.includes(NATIVE_VISION_TOOL) === true)
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
        disposeRestriction = agent.ctx.tools.restrict(desired)
        return () => disposeRestriction()
      })
      restrictions.set(agent, { restriction: { ...desired }, dispose })
    } catch (error) {
      logger?.warn?.('[mm-models] 无法为会话隐藏工具（' + JSON.stringify(desired) + '）：' + String(error?.message ?? error))
    }
  }

  /**
   * 把"当前生效的掩码"与"实时配置应有的掩码"对齐。
   * 这是"改开关立即在当前会话生效"的关键——配置是原地更新的，不会重载插件，
   * 所以必须自己周期性对账（廉价：只在值变化时才碰掩码链）。
   *
   * ⚠ 性能（2026-10-15 实测优化）：原来每秒都**逐个 agent** 重算一遍掩码，
   * 1000 个存活会话时是 2.28 ms/秒 的持续 CPU（每秒重建 1000 个 deny 数组）。
   * 但"稳态"（开关没被人改过）下这个循环什么都不需要做，纯浪费。
   * 现在先用开关签名短路：签名没变且掩码最后一次算的就是它 → 整轮跳过，
   * 固定成本只有 `signature()` 的 6 次配置读取（≈0.002 ms），**与会话数无关**。
   * 开关真被改到时，签名变了，下一个 tick 照旧完成对账（延迟上限仍是 1 秒）。
   */
  let lastSyncSignature
  const syncRestrictions = (force = false) => {
    // ⚠ 两个"原生读图屏蔽"开关都必须进签名，否则**运行时改它们不会触发对账**
    // （签名没变 → 整轮跳过 → 掩码停在旧状态，直到下一次别的原因让它重算）。
    const signature =
      switches.signature() + '|' + (nativeVisionBlocked() ? '1' : '0') + (subagentVisionBlocked() ? '1' : '0')
    if (!force && signature === lastSyncSignature) return
    lastSyncSignature = signature
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
  const isSubagent = (agent) =>
    agent?.parent !== undefined ||
    agent?.options?.subagentDepth !== undefined ||
    // 2026-10-17：0.2.1 的 preset 子代理**不一定**带 options.subagentDepth（实测：
    // 同一批读图员里有的被判成"主代理"，于是吃到 blockMainAgentNativeVision 的
    // read_image 屏蔽 —— 判错的代价是读图员直接瞎）。会话树里的 parentSession
    // 是宿主稳定提供的事实，补上它作为第三判据。
    typeof (agent?.session?.header?.parentSession ?? agent?.session?.parentSession) === 'string'

  /**
   * 第三条守卫（前置）：**`read_image` 的行为级兜底**（2026-10-16 加，实测发现）。
   *
   * ## 为什么必须再加一层（现场证据）
   * 2026-10-16 复查时发现：profile 明明写着 `blockMainAgentNativeVision: true`，
   * 装配产物 `cordis.yml` 里也是 `true`，但**主代理仍能成功调用 `read_image`**（实测读到了图）。
   * 根因是掩码的登记方式：`restrictions` 只由 `agent/created` 填充，而插件卸载时会
   * dispose 掉所有掩码（见下面的卸载 effect）。于是**任何一次重新装配/热重载之后**，
   * 早已存在的 agent 永远不会再触发 `agent/created`，它的掩码就永久丢了 ——
   * 每秒对账也救不回来，因为它只遍历 `restrictions` 里的 agent。
   * 本机 18:27 的重新装配正是这样把主代理的 `read_image` 屏蔽弄丢的。
   *
   * ## 为什么 guard 能兜住
   * guard 在**每次调用前**执行、读的是**实时配置**，与 agent 是哪一轮创建的无关，
   * 因此重载后依然生效。这也正是本插件自己的架构原则：
   * "guard 那一层仍然兜底调用被拒立即生效（schema 可见性与行为拒绝是两件事）"。
   *
   * 语义（与掩码一致，两处判据必须同源）：
   *   - 主代理：`blockMainAgentNativeVision` 打开 → 拒；
   *   - 通用子代理：`blockSubagentNativeVision` 打开 → 拒；
   *   - 读图员：**永远放行**（它是插件唯一的眼睛）；认不出读图员时也放行（fail-open）。
   */
  ctx.tools.guard((exec) => {
    if (exec?.name !== NATIVE_VISION_TOOL) return undefined
    const subagent = isSubagent(exec?.agent)
    const blocked = subagent
      ? subagentVisionBlocked() && !readerRoutesUnknown && !isReader(exec?.agent)
      : nativeVisionBlocked()
    if (!blocked) return undefined
    const readers = READER_TOOLS.filter((tool) => switches.isEnabled(tool))
    const who = subagent ? '通用子代理' : '主代理'
    return (
      '原生读图（read_image）已被 ' + PLUGIN_LABEL + ' 屏蔽（对象：' + who + '）。' +
      (readers.length > 0
        ? '看图请改用读图子代理：' + readers.join(' 或 ') + '，把图片路径交给它。'
        : '当前也没有可用的读图子代理，所以你现在没有任何看图途径；' +
          '请让用户在 插件页 → ' + PLUGIN_LABEL + ' → 配置卡 里打开 ask_glm 或 ask_qwen，然后让用户确认图片内容。') +
      '不要靠猜图片内容。'
    )
  })

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
   * 生效范围（2026-10-15 扩到子代理）：
   *   - **主代理**：无条件拦（理由同上）；
   *   - **子代理**：默认放行 —— 读图员靠这只"眼睛"，而"通用子代理自己看图"是本插件
   *     长期以来的既有行为（`blockSubagentNativeVision` 默认关）；
   *   - 但该开关打开后，通用子代理也没有 read_image 了，这时给**同样的指引**，
   *     免得它对着 "binary file" 反复乱试（这正是这条守卫最初要解决的问题）。
   */
  ctx.tools.guard((exec) => {
    if (exec?.name !== 'read') return undefined
    if (isSubagent(exec?.agent) && !(subagentVisionBlocked() && !readerRoutesUnknown && !isReader(exec.agent))) {
      return undefined
    }
    const target = pathArgOf(argsOf(exec))
    if (target === undefined || !IMAGE_PATH_RE.test(target)) return undefined
    const readers = READER_TOOLS.filter((tool) => switches.isEnabled(tool))
    const headline = '这是图片文件，通用 read 工具读不了二进制内容（只会回 "binary file"）。'
    // 走到这里只有两种可能：主代理、或"C 打开后的通用子代理"。
    // 两者里**只有"主代理且没被屏蔽原生读图"还留着 read_image**，指引必须按这个分。
    const callerHasNativeVision = !isSubagent(exec?.agent) && !nativeVisionBlocked()
    if (callerHasNativeVision) {
      return (
        headline +
        '看图请改用 read_image（把图片路径交给它）' +
        (readers.length > 0 ? '，或读图子代理：' + readers.join(' 或 ') : '') +
        '。不要用 read 重试这个路径，也不要靠猜图片内容。'
      )
    }
    return (
      headline +
      (readers.length > 0
        ? '看图请改用读图子代理：' + readers.join(' 或 ') + '，把图片路径交给它。'
        : '当前也没有可用的读图子代理（原生读图被屏蔽、读图员都没开），所以你现在没有任何看图途径；' +
          '请让用户在 插件页 → ' + PLUGIN_LABEL + ' → 配置卡 里打开 ask_glm 或 ask_qwen，然后让用户确认图片内容。') +
      '不要用 read 重试这个路径，也不要靠猜图片内容。'
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
    // ---- 2026-10-16：C 打开时这条守卫**整体让位**（它已经冗余，只剩误伤）----
    //
    // 理由（两层，都是实测/结构性的）：
    //   1. **保护已由 C 提供**：`blockSubagentNativeVision` 打开后，通用子代理**没有 `read_image`**，
    //      它想看懂图只能去调 `ask_glm` / `ask_qwen` —— 那正是这条审计想促成的那条路。
    //      也就是说"按措辞拦截"不再增加任何保护，因为**绕不过去了**。
    //   2. **误伤是实测出来的、而且不小**：拿 10 条真实的、与识图无关的委派文本喂给它，
    //      **6 条被拦**（写文档提到"读图路由"、改文案里的"读图员"、`assets/logo.png` 转格式、
    //      删一个 .png、改分辨率、以及中文惯用语"图中"）。每次误伤 = 一次废调用 +
    //      一段**永久留在会话里、每轮都重发**的错误文案 + 可能打断多步计划。
    //
    // 代价对比：真·视觉委派被放过时，子代理会自己调读图员（多一跳，但结果正确且仍受契约约束）；
    // 而误伤的 6/10 是纯损失。所以 C 打开时选择"不审计"。
    // ⚠ C 关着时行为**完全不变**（那时这条审计是唯一的防线，误伤是它的必要代价）。
    if (subagentVisionBlocked()) return undefined
    const text = delegationTextOf(argsOf(exec))
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

  /**
   * 第五条守卫：**读图员契约的运行时兜底**（2026-10-16 实测后加）。
   *
   * ## 现场（实测，不是推测）
   * 契约写的是 `toolFilter: { allow: [read_image] }`，而实测读图员的工具表是
   *   `ops_bash, read_image, subagent`
   * —— 我们让它执行 `echo OK`，它**真的返回了 OK**。也就是说"读图员被物理阉割、
   * 除图片外没有任何工具"这句承诺，在运行时是假的：
   *   - 持有 shell ⇒ 图片里的提示注入可以诱导它在本机执行命令（真实的越权面）；
   *   - 持有 subagent ⇒ 它还能再往下委派。
   * 而插件的启动自检只校验**配置文本**（allow 是否恰好 [read_image]），所以它一直报"合规"。
   *
   * ## 为什么修在 guard 层
   * 今天已经两次证明"配置/掩码说的"不等于"运行时真的"：
   *   ① 重新装配后 restrict 掩码会永久丢失（主代理在 config 写着屏蔽的情况下仍能调 read_image）；
   *   ② `exec.args` 字段名写错，让两条守卫在生产里空转 4 天。
   * guard 是唯一"每次调用都重新判定"的层，因此契约的最终保证必须落在这里。
   * （配置侧同步补 `deny`，两层都要有：配置管 schema 可见性，guard 管行为。）
   *
   * 判据与 C 用的是同一份读图员白名单（来自契约文件），所以改路由名也不会误伤。
   */
  ctx.tools.guard((exec) => {
    if (readerRoutesUnknown) return undefined // 认不出读图员 ⇒ 不拦（fail-open，绝不弄瞎）
    if (!isReader(exec?.agent)) return undefined // 只约束读图员，主代理/通用子代理不受影响
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return undefined
    if (READER_ALLOWED_TOOLS.includes(name)) return undefined // 契约内：只看图
    return (
      '读图员只被允许 ' + READER_ALLOWED_TOOLS.join(' / ') + '：' + name + ' 不在契约里，已拒绝。' +
      '你只需要把图片内容转述成结论；其余请求请回答"这需要主代理处理"，由它自己完成。'
    )
  })

  /**
   * 第七条守卫：**子代理生成刹车**（2026-10-16 加）。
   *
   * **默认不拦**（用户明确选择：繁重任务里让子代理直接出图，效率优先）。
   * 打开 `blockSubagentSpend` 时，子代理调 `qwen_draw` / `seedance_video` 会被拒，
   * 只能把生成需求回报给主代理 —— 适合无人值守跑重活、或要临时收紧成本时。
   * 另有 `blockSubagentVideoSpend`：只拦出片、不拦出图（分级刹车，2026-10-17 加）。
   *
   * 放在 guard 层的理由与其它守卫一致：配置层的 `toolFilter` 管不到按 scope 注入的工具，
   * 而 guard 每次调用都判、与 agent 是哪一轮创建的无关。
   */
  // ⚠ 2026-10-17 复查修：新加的 `video_gen` 一开始**漏在这张表外面** ——
  // 打开刹车后子代理仍能出片，而它单次最高 ¥10（4K/1080P），比制图贵一个量级。
  // 新增付费工具时这张表必须同步，否则"刹车"只刹住了便宜的那个。
  const SPEND_TOOLS = ['qwen_draw', 'seedance_video', 'video_gen']
  /** 只出片、不出图的那一档（分级刹车：图 ¥0.18/张，片 ¥1.8–10/次）。 */
  const VIDEO_SPEND_TOOLS = ['seedance_video', 'video_gen']
  ctx.tools.guard((exec) => {
    if (typeof exec?.name !== 'string' || !SPEND_TOOLS.includes(exec.name)) return undefined
    if (!isSubagent(exec?.agent)) return undefined // 主代理永远可以
    // 分级：默认都允许；两个刹车任一打开就拦（blockSubagentSpend 范围更大）。
    const isVideo = VIDEO_SPEND_TOOLS.includes(exec.name)
    if (liveConfig?.blockSubagentSpend !== true && !(isVideo && liveConfig?.blockSubagentVideoSpend === true)) return undefined
    const which = liveConfig?.blockSubagentSpend === true ? 'blockSubagentSpend=true' : 'blockSubagentVideoSpend=true'
    return (
      '⛔ ' + (isVideo ? '出片' : '生成') + '类工具（' + exec.name + '）当前只允许主代理调用（' + which + '）。' +
      (isVideo
        ? '图片生成（qwen_draw）与读图（ask_glm / ask_qwen）仍然可用。请把出片需求（画面、时长、档位、用途）回报给主代理，由它统一编排与记账。'
        : '请把生成需求（要什么图/什么片、参数、用途）回报给主代理，由它统一编排与记账。')
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
    restrictions.set(payload.agent, { restriction: undefined, dispose: undefined })
    syncAgent(payload.agent)
    // 会话树：把"子会话 → 父会话"这条边记下来（子代理的花费要顺着树汇总）。
    const link = sessionLinkOf(payload.agent)
    if (link.id !== undefined && link.parent !== undefined) sessionParents.set(link.id, link.parent)
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

  /**
   * 会话树（2026-10-16 加）：`子会话 id → 父会话 id`。
   *
   * 为什么需要它：子代理的花费**记在它自己的会话上**，所以主代理的 `media_report(cost, scope=session)`
   * 原本看不到自己派出去的子代理花了多少 —— 而这恰恰是"成本黑洞"的机制（看不见 = 管不住）。
   * 父会话 id 就在子会话的 header 里（实测：子代理会话有
   * `parentSession: "session-…"` / `origin: "subagent"` / `delegationDepth: 1`），
   * 于是可以在 `agent/created` 时把这条边记下来，之后顺着树汇总。
   */
  const sessionParents = new Map()
  /** 从 agent 上取"所在会话 id"与"父会话 id"。 */
  const sessionLinkOf = (agent) => {
    const session = agent?.session
    const id = session?.id ?? session?.header?.id
    const parent = session?.header?.parentSession ?? session?.parentSession
    return {
      id: typeof id === 'string' && id.length > 0 ? id : undefined,
      parent: typeof parent === 'string' && parent.length > 0 ? parent : undefined,
    }
  }
  /** 某个会话的全部后代会话 id（不含自己）。 */
  const descendantSessionIds = (rootId) => {
    if (typeof rootId !== 'string' || rootId.length === 0) return []
    const childrenOf = new Map()
    for (const [child, parent] of sessionParents) {
      const list = childrenOf.get(parent) ?? []
      list.push(child)
      childrenOf.set(parent, list)
    }
    const out = []
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const child of childrenOf.get(current) ?? []) {
        if (out.includes(child)) continue
        out.push(child)
        queue.push(child)
      }
    }
    return out
  }
  /**
   * 花钱/报表要用到的会话集合：自己 + 全部后代。
   * 这样"会话累计上限"和 `cost(session)` 都能覆盖子代理，而不用禁止它们生成。
   */
  const sessionIdsForSpend = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return [sessionId, ...descendantSessionIds(sessionId)]
  }
  const sessionTreeSnapshot = () => [...sessionParents.entries()].map(([child, parent]) => ({ child, parent }))

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

  // ── 读图子代理的 token 计量（2026-10-17）────────────────────────────────────
  //
  // 起因：cost 报表长期自曝「读图子代理的 token 未计入」，理由是"插件没有请求级钩子"。
  // 该结论在 0.2.0-rc.2 已不成立 —— `@deepseek-ai/dsh-llm` 的
  // `streamWithRegistration()` 走 `ctx.waterfall(this, 'llm/stream', options, next)`，
  // 而插件可以订阅这个 waterfall 并包住返回的流，观察 `usage` 分片。
  // 详见 core/reader-usage.mjs 顶部的实测依据。
  //
  // 收窄到"读图员的 provider"：主代理与其它子代理的 token 由宿主自己计量，
  // 插件重复记账只会把报表弄脏。读图员的 provider 是专属的，所以这个归因是证据支持的。
  // 认作"读图员"的 provider：与 core/cost.mjs 的 READER_ROUTES **同一组取值**
  // （那里是报表文案，这里是记账口径）。两个读图子代理在 llm-pi-ai 里的 provider id
  // 就是 'glm' 与 'qwen-vl'；它们是**专属路由**，没有别的消费者，
  // 所以按 provider 归因是证据支持的，而不是猜。
  const readerProviders = ['glm', 'qwen-vl']
  const readerUsage = createReaderUsageMeter({
    providers: readerProviders,
    record: async (entry) => {
      const ledger = await getLedger()
      await ledger.record(entry)
    },
    // 按**模型 id** 取价（单价表的键是模型 id，route.provider 是路由名，两者不等）。
    resolvePrice: (model) => pricingOf(liveConfig)[model],
    warn: (message) => logger?.warn?.(`[${name}] ${message}`),
  })
  ctx.effect(() => readerUsage.attach(ctx))

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

  // 读图能力现状一并交给 media_report：这两个开关决定"谁能看图"，是最容易被误配的语义，
  // 必须能在对话里查到（而不是只躺在插件日志里，DSH 不落盘那种日志）。
  const visionStatus = () => ({
    mainAgentBlocked: nativeVisionBlocked(),
    subagentBlocked: subagentVisionBlocked() && !readerRoutesUnknown,
    readerRoutesUnknown,
    readerProviders: readerRoutes.providers,
    readerRouteDeclarations: readerRoutes.routes.length,
    // 掩码的覆盖情况：重新装配后既有 agent 不会重回这张表，所以它会 "0/N" ——
    // 那正是"schema 层丢了、行为层靠 guard 兜"的状态，必须能被看到（2026-10-16 实测）。
    knownAgents: restrictions.size,
    maskedAgents: [...restrictions.values()].filter((entry) => Array.isArray(entry.deny) && entry.deny.length > 0).length,
    decisions: [...visionDecisions],
  })
  const deps = {
    ctx, config: liveConfig, manager, keys, getLedger, getTaskRegistry, getImageCache, budget, switches, logger, visionStatus,
    // 读图 token 计量的观测摘要：cost 报表用它把"未计入"改成实际记账情况。
    readerUsage,
    // 会话树（子代理花费汇总用）：花钱闸门与 cost 报表都靠它把子会话一起算进来。
    sessionIdsForSpend,
    sessionTreeSnapshot,
  }
  ctx.tools.register(createQwenDrawTool(deps))
  ctx.tools.register(createSeedanceVideoTool(deps))
  ctx.tools.register(createVideoGenTool(deps))
  ctx.tools.register(createMediaTaskTool(deps))
  ctx.tools.register(createMediaReportTool(deps))
  // 读图员（2026-10-17 起由插件自己注册）：描述与 schema 完全可控，
  // 不再依赖 tool-subagent 行那段"和 subagent 逐字相同"的通用文案。
  for (const definition of createReaderTools(deps)) ctx.tools.register(definition)
  // 窄委派（2026-10-18 起同样由插件自己注册）：`agentPreset` 改为**调用时**解析，
  // 不再在装配期查 preset 表 —— 热重载时 preset 尚未 register 的窗口不会再把工具打挂。
  for (const definition of createDelegationTools(deps)) ctx.tools.register(definition)

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
      // 读图路由按当前策略生成（block 开关改了要重启才生效，与它"限制在 agent 创建时"的语义一致）。
      text: buildDivisionSection(liveConfig?.blockMainAgentNativeVision === true),
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
  //
  // ⚠ 2026-10-17：读图员工具面已从 `toolFilter`（行内）迁到 preset 的 `plugins`
  // （`preset-mm-reader` → persona + tool-fs{readImage:true}），所以这条检查对
  // **旧装配**仍然有效、对新装配恒为空。preset 的"只看图"由 `cordis.patch.yml`
  // 的 `preset-mm-reader` 块保证（`read:false/write:false/edit:false`），改动时请对照。
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

  // 启动自检 ③（只告警、不改配置）：`blockSubagentNativeVision` 的前提是否成立。
  // 这个开关判错的代价是"读图员一起瞎"或"子代理彻底没有看图途径"，所以两种情况都要点名：
  //   ① 认不出读图员路由 → 开关对子代理不生效（fail-open）；
  //   ② 读图员没开 / 或读图员 maxDepth < 2 → 子代理将没有任何看图途径。
  if (subagentVisionBlocked()) {
    if (readerRoutesUnknown) {
      logger?.warn?.(
        '[mm-models] blockSubagentNativeVision 已打开，但**认不出任何读图员路由**' +
          '（Config 里的 reader* 字段与契约文件里的 tool-subagent 行都没扫到）。' +
          '为避免把读图员一起弄瞎，本次**不会**屏蔽子代理的原生读图。请检查配置。',
      )
    } else {
      logger?.info?.(
        '[mm-models] blockSubagentNativeVision 已打开；读图员豁免路由：' + readerRoutes.providers.join(', ') +
          '（来自 ' + readerRoutes.routes.length + ' 条路由声明）',
      )
      if (switches.isEnabled('ask_glm') !== true && switches.isEnabled('ask_qwen') !== true) {
        logger?.warn?.(
          '[mm-models] blockSubagentNativeVision 已打开，但 ask_glm / ask_qwen **都没开**：' +
            '通用子代理将失去读图的任何途径。请打开一个读图员，或关掉本开关。',
        )
      }
      const shallow = readerRoutes.routes.filter((route) => route.maxDepth !== undefined && Number(route.maxDepth) < 2)
      for (const route of shallow) {
        logger?.warn?.(
          '[mm-models] 读图员路由 ' + route.id + ' 的 maxDepth=' + route.maxDepth + ' < 2：' +
            '已委派的子代理调用它会被拒（实测 "subagent depth 2 exceeds maxDepth 1"），' +
            '等于本开关打开后子代理没有看图途径。请把 readerMaxDepth 设为 2。',
        )
      }
    }
  }

  logger?.info?.('[mm-models] 已注册 ask_glm / ask_qwen / qwen_draw / seedance_video / video_gen / media_task / media_report（两个读图员互斥）')
}
