# 给 DeepSeek Harness 装上眼睛、画笔和摄像机

> **GLM/Qwen 读图 · Qwen 出图 · Seedance/可灵/海螺 出片**
> **外加一道 fail-closed 花费闸门：未计价一律拒付。**
>
> 包名 `dsh-mm-models` · 插件 id `mm-models` · `0.3.0` · 本地优先 · 不收集遥测 · MIT · 需要 DeepSeek Harness `0.2.1+`

[![npm](https://img.shields.io/npm/v/dsh-mm-models.svg)](https://www.npmjs.com/package/dsh-mm-models)
[![offline-tests](https://github.com/nanfangtown/CN-gpt/actions/workflows/offline-tests.yml/badge.svg)](https://github.com/nanfangtown/CN-gpt/actions/workflows/offline-tests.yml)
[![license](https://img.shields.io/npm/l/dsh-mm-models.svg)](https://github.com/nanfangtown/CN-gpt/blob/main/LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）bundle：把 GLM / Qwen-VL 读图、Qwen 制图、Seedance / 可灵 / 万相 / MiniMax 海螺出片做成与 `bash`、`ops_*` 同级的顶级工具，并共用一层异步任务管理、一套多 key 管理与一套**花钱闸门**。

DeepSeek 主模型负责思考与交付；外部模型只负责"看 / 画 / 拍"这些它原生没有的能力。

## 它提供什么

| 工具 | 能力 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ask_glm` | GLM 读图子代理 | ✅ 开 | 看图、截图、PDF、图表、手写、界面 → 结构化结论 |
| `ask_qwen` | Qwen-VL 读图子代理 | ⛔ 关 | 与 `ask_glm` 二选一；默认 `qwen3.8-max`，中文界面 / 密集文字 / 场景描述较强 |
| `ocr_image` | 本地 OCR（Windows 自带引擎） | ✅ 开 | 纯文字截图直接抄字：免费、离线、图片不出网，通常 0.3–1.5 秒 |
| `qwen_draw` | Qwen 文生图 / 图生图 | ✅ 开 | 产物落盘 + 返回路径；可选把图附回上下文 |
| `seedance_video` | 火山方舟 Seedance 出片 | ⛔ 关 | 文生 / 图生视频，异步任务 |
| `video_gen` | 百炼出片：可灵 v3 / 万相 2.5 | ⛔ 关 | 复用 `DASHSCOPE_API_KEY`，需业务空间 ID |
| `minimax_video` | MiniMax（海螺）出片 | ⛔ 关 | 文生 / 图生 / 首尾帧；独立 `MINIMAX_API_KEY`；按条计费 |
| `media_task` | 异步任务重查 / 补下载 | ✅ 开 | 整轮失败后按 `provider + task_id` 找回产物 |
| `media_report` | 成本估算 / 链路健康 | ✅ 开 | 账本、单价自检、四把 key 与各条链路状态 |
| `run_batch` | 批量执行（一次多条命令） | ✅ 开 | 跑测试 / 构建 / 批量检查：步数从 N 降到 1，日志落 `gen/batch/` |
| `subagent_code` | 窄工具面编码子代理 | 常开 | 命令 + 文件读写 + 查找；适合设计 / 重构 / 根因 |
| `subagent_script` | 窄工具面脚本子代理 | 常开 | 命令 + 文件读写 + 查找；跑构建 / 测试到绿 / 批量机械改动，默认走 MiniMax 路线 |
| `subagent_research` | 窄工具面资料子代理 | 常开 | 只有只读文件 + 网页检索；适合查文档 / 核实事实 |

> 后三个工具是"窄委派"：通用子代理每轮要背全部工具表（约 36 个 / 33 KB），这三个只背 7 / 7 / 5 个。读图员本身也是子代理。

## 为什么不是"让主模型自己看图"

- 主路由对单图常有 token 上限（例如 DeepSeek 路由 `MAX_IMAGE_TOKENS = 1024`），大图会被大幅降采样；交给没有该上限的视觉模型反而更准。
- 图片内容块会把"上传 / 传输失败"的风险带进每一轮对话；产物几 MB 时尤其明显。
- 读图员是**只读**子代理：工具面只有 `read_image`，不会读代码、翻目录、跑命令。

所以默认策略是：**主代理不看原图，读图员看；主代理拿文字结论**。如果你更喜欢原生读图，见下面的开关。

## 安装

前置：DSH Desktop `0.2.1-rc.1` 或更高（`0.2.x` 线），profile 默认 `desktop`。
`dsh plugin` 在 profile 内转发给 pnpm，所以 npm 上的包与本地目录都能装。

```bat
:: 从 npm 安装（推荐）——装到的是预构建代码，不需要构建脚本授权
dsh plugin --profile desktop add dsh-mm-models

:: 锁定版本，便于复现（0.3.0 发布后可用）
dsh plugin --profile desktop add dsh-mm-models@0.3.0

:: 改源码 / 跟未发布分支时，从本地目录安装
git clone https://github.com/nanfangtown/CN-gpt.git
dsh plugin --profile desktop add ".\CN-gpt"
```

装完**完整重启 DSH**。安装会在 profile 里加两行 + 三个 agent preset：

1. `llm-pi-ai` —— 注册两条读图路由：`providers.glm`（智谱）与 `providers.qwen-vl`（百炼）。
2. `mm-models` —— 插件本体（13 个工具 + 一段可关闭的分工提示词）。

> ⚠ **第 1 行是覆盖语义**：`config` 整体替换，不与已有 `providers` 深合并。
> 如果你在 设置 → 模型 里配过自定义 provider，安装前先备份 `cordis.patch.yml`，
> 或安装后把 `providers.glm` / `providers.qwen-vl` 合并进你原有的配置。
> 不需要插件代配路由时，删掉 `cordis.patch.yml` 的第 1 行，再手工在设置里添加 GLM / Qwen-VL 路由。

配置卡入口：侧栏「插件」→ 已安装 → `dsh-mm-models`（显示名 **CN-gpt**）→ 组合包详情 → 配置卡。

> **要用「机械重活走 MiniMax 积分」这条成本路线**（`subagent_script` 的默认路线）：
> 大前提是**本机安装并登录过 MiniMax Code**（Mavis）。插件读它的 OAuth 凭据，
> 登录一次之后不必保持打开 —— 细节见下文「成本路线：重型机械活走 MiniMax 积分」。
> 不装也能用，只是脚本子代理会按父会话路线跑，省不到这份钱。

## 四把 key

| Key | 给谁用 | 推荐放法 |
| --- | --- | --- |
| `ZHIPU_API_KEY` | `ask_glm` | 设置 → 模型 → GLM 行；或 `~/.dsh/.env` |
| `DASHSCOPE_API_KEY` | `qwen_draw` / `ask_qwen` / `video_gen` | `~/.dsh/.env` 或配置卡引用名 |
| `ARK_API_KEY` | `seedance_video` | `~/.dsh/.env` 或配置卡引用名 |
| `MINIMAX_API_KEY` | `minimax_video` | `~/.dsh/.env` 或配置卡引用名；国内 `.cn` / 国际 `.io` 的 key 不通用 |

```bash
cp .env.example ~/.dsh/.env   # 然后填入真值；不要把填好的 .env 提交到仓库
```

解析优先级：**配置卡字面值 > 凭据服务 / 引用名 > 环境变量 / `~/.dsh/.env`**。
各条链路互相独立：缺任何一把 key 只影响对应工具，不会让插件加载失败。

用 `media_report(action=health)` 可以在对话里直接看到每把 key 的
"是否已配置 / 来源 / 最近成功失败 / 连通性"，但**永远不回显 key 本身**。

## 用它

```text
# 读图（把本地路径交给读图员）
ask_qwen(image_path="D:/shots/ui.png", question="这个弹窗的按钮排版有什么问题？")

# 画图
qwen_draw(prompt="雨夜校园，霓虹，电影感，16:9", n=2)

# 出片（5 秒 × ¥0.8/秒 = ¥4.00，需要复述金额）
video_gen(prompt="镜头缓慢推进，雨滴打在窗上", duration=5, confirm_estimate=4)

# MiniMax 出片（768P 6 秒 = ¥2.00，按条计费）
minimax_video(prompt="镜头缓慢推进，雨滴打在窗上", duration=6, resolution="768P", confirm_estimate=2)
```

所有生成类调用都返回本地文件路径；是否把图片附回模型上下文由 `attachResultImages` 控制（默认关，只回路径）。

## 花钱闸门

这是插件最核心的安全设计。所有付费提交（出图 / 出片）都走同一道收口：

1. **未计价 = 拒绝**：单价表查不到、单价为 `0` 或负数，一律 fail-closed；调用方自报金额不作数。
2. **单次上限**：默认 `videoCostLimitCNY = 10` 元。
3. **会话累计上限**：默认 `videoSessionCostLimitCNY = 30` 元，含子代理会话树。
4. **复述金额**：预估超过 `noConfirmUnderCNY`（默认 1 元）时必须传回精确到分的 `confirm_estimate`。

单价表在配置卡里可改；**填错价拦不住**（只拦"缺档位"），请按厂商官网核对。
金额是估算，不是账单。详见 [SECURITY.md](https://github.com/nanfangtown/CN-gpt/blob/main/SECURITY.md)。

## 批量执行：把「一步」做大（`run_batch`）

逐条跑命令的成本不在执行，而在**步数**：每条命令都是一步，每步都要重发一遍上下文。
实测一轮 12 个测试文件逐条跑 = 54 步、3M cacheRead；合成一次 `run_batch` 后是 1 步。

- **串行 / 并行**：默认串行（有依赖的命令别并行）；`parallel: true` 时按 `batchParallelLimit`（默认 4）并发，结果顺序仍与输入一致。并行下 `stop_on_error` 不可用（已经起跑的命令停不下来，会直接拒绝）；
- **脚本入口**：`script: "test"` 直接读 `package.json` 的 `scripts.test`，按 `&&` 拆条执行，`npm run x` 引用递归展开（最多 3 层）。会改变语义的构造（`||`、反引号、`$(...)`、行首 `cd`）整段当一条跑——机器上没装 npm 时这一条尤其有用；
- **退出码原样保留**：Windows 下用包装脚本把真实退出码写出来（`powershell -Command` 会把 3 压成 1）；
- **只回摘要**：每条命令都带一行输出尾巴（≤ 200 字符，"通过 13，失败 0"这类结论文本一次就能看到）；输出本身很短时标注「完整输出，无需再读日志」，避免模型为"逐字核对"再读一遍日志；失败另带摘要（≤ 600 字符），完整输出落 `gen/batch/<时间戳>/<序号>-<命令>.log`；
- **超时杀进程树**：`batchCommandTimeoutMs`（默认 120 s）到点用 `taskkill /T` 连孙进程一起收；
- **上限点名拒绝**：`batchMaxCommands`（默认 20）超过就报错，不静默截断。

配置：`enableRunBatch`（默认开）、`batchMaxCommands`、`batchCommandTimeoutMs`。

### 实测：到底省多少 token、多少（2026-11-11，一次真实会话）

口径：会话日志里每条 `assistant/message` 的 `usage`（input / cacheRead / cacheWrite / output）逐条累加；
价格取 DeepSeek Flash 官方价（元/百万 token，谷价 / 峰价：命中 `0.02 / 0.04`、未命中 `1 / 2`、输出 `4 / 8`）。
用这套价复算的两轮金额与鲸鱼挂件的账本**分币不差**，所以下面的钱不是估的。

| 指标 | 实测 |
| --- | --- |
| 会话规模 | 126 步 / 5 轮 / 21.3M prompt token（其中 cacheRead 占 **99.2%**），花费 ¥2.06 |
| 每步 prompt（中位） | 189,627 token |
| `run_batch` | 44 次调用 / 92 条命令 |
| 若逐条跑 | 174 步（**多 38%**）、29.9M prompt（**多 8.63M**） |
| 折合金额（峰时） | prompt 省 ≈ ¥0.35 + output 省 ≈ ¥0.05–0.15 → **≈ ¥0.4，约占这场会话的 1/5** |

**两条结论，和直觉相反：**

1. **"省 token" 是真的，"省很多钱" 不是。** 省下来的几乎全是**缓存命中** token（¥0.04/百万），
   而输出是 ¥8/百万——差 200 倍。一条命令单独跑 ≈ 1 步 ≈ 当时上下文，
   折合 **¥0.0076/步（峰时）**，不到一分钱。
2. **N=1 时收益为零。** 实测 47 次调用里有 30 次是单命令——不是白调，是"要看输出再决定下一条"。
   收益的公式很干净：**省的钱 ≈ (N−1) × 当时上下文 × 缓存命中价**，所以它划算的条件是
   "命令多 **且** 上下文长"；命令少或会话刚开始（上下文才 1 万多 token）时，批处理基本不省钱。

### 它对"注意力"意味着什么（同一场会话实测）

工具结果体积分布：`read` **59.1%**、`web_fetch` 17.9%、`grep` 8.4%、`run_batch` **6.4%**（均值 584 字符/次）。
也就是说：**92 条命令只占工具输出的 6%；真正把上下文推到 19 万/步的，是把原文整段读进来。**

- **正面**：步数少 28% → 少 48 次"在 19 万 token 里定位下一步"；`tail` 挑的是"结论行"而不是末行
  （实测失败时直接给出 `通过 141，失败 1`，不必去读 22 秒的完整日志）；92 条命令的原始输出没有进上下文。
- **反面**：批内依赖做不了（本次 30/47 次是单命令）；`tail` 会丢细节、偶尔选错行
  （实测有一次塞的是 `CommandNotFoundException` 堆栈）；14 条命令的批次 output 只有 ~700 token —
  是"照抄清单"而不是逐条推理，对单条正确性的把关更弱。

所以它的定位是**节流阀 + 结论压缩器**，不是认知增强器：它不改变模型能力，只改变"步数"和"看到什么"。
想让长任务表现更好，按这场会话的数据排序是：**缩短上下文（先管 `read`）> 结论优先于原文 >
窄工具面 / 窄委派 > 批处理**。

## 成本路线：重型机械活走 MiniMax 积分（前提：安装并登录 MiniMax Code）

省 DeepSeek token 有两条**互不相干**的路：

1. **`run_batch`**：把一批命令压成一步，省的是主会话的「步数 × 上下文」——**零额外安装**。
2. **`subagent_script` → MiniMax 积分路线**：把机械型 / 多步 / 大输出的活交给另一条模型路线
   （`scriptProvider` / `scriptModel`，出厂 `minimax / MiniMax-M3.1-Flash`），这部分模型调用的
   花费记在 **MiniMax 订阅积分**上，不进 DeepSeek 账单。

**第 2 条的大前提：本机安装并登录过 MiniMax Code（Mavis）。** 插件不存你的 MiniMax 密码，
它读 MiniMax Code 的 OAuth 存储（`auth/prod/<region>/mcode-public/auth.json`）里的 accessToken，
并在过期前自行刷新 —— refresh_token 是单次使用的，插件按 MiniMax Code 自己的跨进程锁串行续期，
所以**登录一次之后不必保持 MiniMax Code 打开**；只有 token 族被吊销时才需要重新登录。

- **怎么确认在走这条路**：`subagent_script` 的返回会写 `模型路线：minimax / MiniMax-M3.1-Flash`；
  预检不过（provider 不在会话清单 / 模型不在白名单）会明确写
  `⚠ 未注入模型路线（…）；本次按父会话路线执行`，不再静默回落（2026-11-11 起）。
- **账本口径**：积分套餐不按 token 计价，`media_report(cost)` 对这条路记 ¥0（没有单价）。
  省下的是 DeepSeek 的 token 账单，代价是 MiniMax 的积分 / 额度。
- **本会话实测**（2026-11-11，同一场会话）：3 次脚本子代理、**21 步 / 37 万 prompt / 1.5 万 output**，
  会话日志里 `source.provider` 全是 `minimax / MiniMax-M3.1-Flash`；同样步数在主会话跑，
  DeepSeek 侧约 **¥0.20**。这与上面 `run_batch` 的 ≈¥0.4 是**两笔账，不要相加**。

> 一句话：**`run_batch` 省"重复发送"，MiniMax 路线省"这些活的模型调用本身"。**
> 前者零安装；后者装 MiniMax Code 并登录一次即可，之后不必保持打开。

## 激进模式：把原生 shell 从工具表里摘掉（`blockNativeShell`，默认关）

打开后主代理的**工具表里不再有** `pwsh` / `bash` / `ops_bash`——命令只能经 `run_batch` 执行：
要跑的命令一次都给它（只有一条时 `commands` 给一条即可）。"逐条跑"在物理上不可用，
"批量"成为唯一路径。

> 2026-11-11 改：以前是"工具还在表里、调用时才拒"。A/B 实测暴露了代价——模型先把 12 条命令
> 写成一整段 PowerShell 包装脚本、再被 guard 拒，白付**一次往返 + 6.8k output token**，
> 而那正是它本可以写对的方向。现在改成**摘工具**：模型看不到 shell，就不会先试。
> 调用层仍保留一道兜底拒绝（掩码在重新装配后可能丢失，这是本项目实测过的老问题）。

⚠ 这是**动地基**的开关，所以默认关：

- shell 是执行基底，不像 `read_image` 那样是叶子能力：打开后主代理失去交互式单步能力
  （探针、调试、看输出再决定下一步）；
- 子代理**不受影响**（`subagent_script` 仍可执行命令，它有自己的 shell 工具面）；
- 如果同时把 `enableRunBatch` 关了，主代理将**无法执行任何命令**——启动自检会告警。

保存后约 **1 秒内对既有会话生效**（掩码对账周期），新会话立即生效；不需要重启。

## 出片三选一（互斥）

`seedance_video`（方舟）、`video_gen`（百炼可灵/万相）、`minimax_video`（MiniMax 海螺）三家协议、密钥与计费都不同，**同一时刻只允许一个开启**：

- 设置卡里打开一个，会自动关闭另外两个；
- 手改配置同时打开多个时，Host 按声明顺序取第一个生效（`seedance_video` > `video_gen` > `minimax_video`），其余被压制；
- `media_report(action=health)` 会把冲突标出来。

MiniMax 的计费单位是**条**（分辨率 × 时长），与另外两家的"按秒"不同；单价表里用 `unit: call` + `tiers` 表达，缺档位一律 fail-closed。
国内 `.cn` 与国际 `.io` 的 key 不通用，`minimaxBase` 必须与 key 同区域。

## 读图路由与两个 block 开关（重要）

出厂默认：

- `enableAskGlm = true`（读图员开着）
- `blockMainAgentNativeVision = true`（主代理的 `read_image` 被摘掉）
- `blockSubagentNativeVision = true`（通用子代理也不能自己读图；读图员豁免）

**如果你没有配 GLM key**，这套默认会让主模型既看不到原生图、也叫不出读图员 —— 等于没有看图途径。
这种情况下请二选一：

- 关掉两个 `block*` 开关，回到原生读图；或
- 改用 `ask_qwen`（配 `DASHSCOPE_API_KEY`），并关掉 `ask_glm`。

`blockSubagentNativeVision` 还要求 `readerMaxDepth >= 2`，否则被委派的子代理调不动读图员。改完需要完整重启。

## 纯文字截图：本地 OCR（`ocr_image`）

读图员是"视觉理解"通道，但日常读图的大头其实是**纯文字截图**：报错、日志、代码、表格、
文档、聊天记录。这类图不需要理解画面，只需要**抄字** —— 派一次子代理意味着两跳模型调用
和一次外发，而 OCR 更便宜、更保真（不会意译、不会漏列），截图里的 key / 订单号也不出网。

`ocr_image` 用 Windows 自带的 `Windows.Media.Ocr`，没有任何额外依赖：

- **免费、离线**：不调任何 API，不需要 tesseract / Python / 在线模型；
- **快**：通常 0.3–1.5 秒（其中约 0.2 秒是 PowerShell 冷启动）；
- **会自己挑引擎**：中文界面用中文引擎；纯 ASCII（代码 / 英文日志）自动切英文引擎 ——
  中文引擎会把 `File` 认成 `Fi1e`、把 `.` 认成全角；
- **小字会放大后重认一次**：14 px 的代码截图，字符相似度从约 0.73 提到 0.87；
- **会把引擎拆乱的行按坐标拼回来**：等宽代码常被切成 `const total =` / `add(12,` / `30);`
  三段，按 y→x 重排成一行；中文也不再逐字带空格（`任 务 队 列` → `任务队列`）。
  Windows 的 OCR 对 CJK 是**按单字**出词的，所以这层重排是必需的。

分工（已写进插件提示词，模型自己会分）：

| 图里是什么 | 走哪条路 |
| --- | --- |
| 纯文字：代码 / 日志 / 报错 / 表格 / 文档 / 聊天记录 | `ocr_image` |
| 图表读数、界面排版、画面内容、照片、手写、艺术字 | `ask_qwen`（读图员） |
| `ocr_image` 返回"几乎没认出文字" | 说明这张图不是文字图，改走读图员 |

限制如实说：**缩进会丢**（行首空格没有词框可依），艺术字、低分辨率、旋转/倾斜的截图
识别率会掉，逐字抄写也不等于百分之百准确。需要"理解"而不只是"抄写"时，仍然走读图员。

调参：`enableOcrImage`（默认开）、`ocrLanguage`（默认 `auto`）、`ocrTimeoutMs`（20 s）、
`ocrMaxChars`（12000）、`ocrMaxBytes`（20 MiB）；`media_report(action=health)` 里有一行
「本地 OCR：✅ 开」可确认状态。

⚠ 语言包：Windows OCR 是**按语言**安装的。本机已有 `zh-Hans-CN` 与 `en-US`；精简系统第
一次调用会返回安装指引（设置 → 时间和语言 → 语言 → 可选功能 → 光学字符识别）。

## 读图回合闸门：结论没回来，不许先开口（0.2.2）

旧行为：模型派出读图员 → 工具立刻返回 `subagentId` → 模型**下一步**就凭印象作答，
读图结论几秒后才到。于是同一张图先给一条错的、再给一条"更正"。

0.2.2 起，插件在宿主的 `agent/pre-step` 上加了一道闸：

- 主 agent 派出读图员后，**下一步不会开始**，一直等到读图结论回来（默认上限 90 s）；
- 结论取回后并入本步消息，模型第一次看到它就是在作答的那一步；
- 为什么不在 `agent/turn-stopping` 拦：宿主顺序是**先 step**（assistant 文本已流式发出、
  已入库）**后 turn-stopping**，在那里拦只能"补一条更正"，拦不住"先说错"。

同一道闸还管两件事：

- **有图自动 OCR**（`autoOcrOnImage`，默认开）：本轮消息含图时先在本机抄一遍字
  （免费、离线、约 0.4 s）再交给模型。粘贴图在 `.dsh/attachments` 下是无扩展名对象、
  路径也不在消息文本里，插件从 `sha256` 还原对象路径再 OCR。
- **有图无证据**（`readerGateImageHint`）：模型一次读图 / OCR 都没调时注入机械提醒（每轮一次）；
  收尾仍无证据则拒绝结束该回合、补一个纠正回合（`readerGateForceEvidence`）。

只作用于读图员——出片 / 视频 / 复杂工作流的异步链路完全不动（它们不登记在闸门表里）。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `readerGate` | `true` | 闸门总开关 |
| `readerGateTimeoutMs` | `90000` | 等待上限；超时放行并提示"待确认" |
| `readerGateImageHint` | `true` | 本轮有图未取证 → 注入提醒 |
| `readerGateForceEvidence` | `true` | 无证据收尾 → 补纠正回合 |
| `autoOcrOnImage` | `true` | 有图先跑本地 OCR |

**代价要如实说：慢。** 闸门不产生延迟，它只是把读图员的延迟如实等完。视觉模型单次延迟
实测 40–200 s（含一次 120 s 的尾延迟），所以带图回合的体感会明显变慢；不接受就关掉 `readerGate`。

`media_report(action=health)` 里有一行「读图闸门：✅ 开 ｜ 在等 N」；`verbose` 下还能看到
「上次 OCR 找到 X 张/成功 Y 张」——用来区分"没找到图"和"OCR 失败"。

## 批量读图（默认关闭）

打开 `readerBatchMode` 后，读图员变成"一次读一批"：schema 里只有 `image_paths`（数组，
≤ `readerBatchMax`，默认 4），不再有单图入口。定位：

- **同一批图一次传完**：分两次调用会各自独立、无法互相参照；
- 结论按「图1/图2」分段，溯源不断；
- 超过上限**点名拒绝**（不静默截断），请分组成多次调用；
- 不相关、或每张要分别提问 → 分开调用。

收益是形状唯一、行为可预测（没有"逐张调三次"的岔路）；代价是单图精细度与失败隔离下降。
所以默认关闭，出厂行为与 0.2.1 一致。`image_path` 仍被接受（旧会话兼容），但批量 schema 里不出现。

## 兼容性

| DSH 运行时 | 结果 |
| --- | --- |
| `0.2.0-rc.x` | ⛔ 不支持（子代理的 persona / 工具面已迁移到 Agent Preset） |
| `0.2.1-alpha.*` / `0.2.1-rc.*` / `0.2.1` | ✅ |
| `0.3.0-rc.1` 及以后 | ⛔ 需重新验证（`engines.dsh` 已显式排除） |

`package.json` 的 `engines.dsh = ">=0.2.1-rc.1 <0.3.0-0"` 是给 DSH 0.2.1+ 的版本校验用的；
`peerDependencies` 里的 `@deepseek-ai/dsh-*` 由宿主提供，链接安装时必须声明，否则 harness 只会报 "failed to import"。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/ENGINEERING-NOTES.md](https://github.com/nanfangtown/CN-gpt/blob/main/docs/ENGINEERING-NOTES.md) | 完整工程记录：设计取舍、事故复盘、性能与测试数据（历史快照，可能过时） |
| [docs/reports/](https://github.com/nanfangtown/CN-gpt/tree/main/docs/reports) | 三次修复 / 性能 / 读图路由的专项报告 |
| [SECURITY.md](https://github.com/nanfangtown/CN-gpt/blob/main/SECURITY.md) | 密钥处理、花费安全、漏洞报告方式 |
| [THIRD_PARTY_NOTICES.md](https://github.com/nanfangtown/CN-gpt/blob/main/THIRD_PARTY_NOTICES.md) | 第三方代码来源与许可（vendored MiniMax 接入等） |
| [PUBLISHING.md](https://github.com/nanfangtown/CN-gpt/blob/main/PUBLISHING.md) | 发布到 npm：鉴权、首发步骤、发布后验证与回滚 |
| [CONTRIBUTING.md](https://github.com/nanfangtown/CN-gpt/blob/main/CONTRIBUTING.md) | 开发环境、测试、提交规范、发布流程 |
| [CHANGELOG.md](https://github.com/nanfangtown/CN-gpt/blob/main/CHANGELOG.md) | 版本变更 |
| [tests/README.md](https://github.com/nanfangtown/CN-gpt/blob/main/tests/README.md) | 测试矩阵与试运行脚本 |

## 开发

```bash
npm install          # 只装一个 devDependency（schemastery）
npm test             # 离线套件：14 个文件 / 约 340 项断言；不需要 DSH、不需要 key、不联网、不花钱
npm run test:batch   # 只跑 run_batch 的 18 项（串行/并行、退出码、超时、脚本入口、环境隔离）
npm run test:delegation  # 只跑窄委派的模型路线可见性（8 项：预检通过/失败/关闭/写漏/未预检）
npm run test:docs    # 文档相对链接检查
```

测试的边界：

- **离线套件**用本地假厂商（`tests/mock-providers.mjs`）跑完 提交 → 轮询 → 下载 → 记账，CI 在 Linux / Windows × Node 22 / 24 上跑。
- **真实 harness 脚本**（`tests/e2e-*.mjs`）需要本机 DSH 安装与真 key，`SKIPPED:` 与通过可区分，`DSH_E2E_STRICT=1` 时跳过会以 78 退出。
- 变异测试（`npm run test:mutation`）会**直接改写工作区源码**再还原，不要与其它测试并发跑。

## 参与

- 问题 / 需求：[GitHub Issues](https://github.com/nanfangtown/CN-gpt/issues)
- 提交代码：[CONTRIBUTING.md](https://github.com/nanfangtown/CN-gpt/blob/main/CONTRIBUTING.md)
- 安全问题：**不要**开公开 issue，按 [SECURITY.md](https://github.com/nanfangtown/CN-gpt/blob/main/SECURITY.md) 私下报告
- 行为准则：[CODE_OF_CONDUCT.md](https://github.com/nanfangtown/CN-gpt/blob/main/CODE_OF_CONDUCT.md)
- 第三方代码来源：[THIRD_PARTY_NOTICES.md](https://github.com/nanfangtown/CN-gpt/blob/main/THIRD_PARTY_NOTICES.md)

## 名字

插件页显示名暂时仍是 **CN-gpt**（历史遗留，后续统一成功能名），包名 `dsh-mm-models`，插件 id `mm-models`。**这是玩梗，不是技术栈**——调用链里 GPT 含量 0%，实际是 GLM / Qwen / Seedance / 可灵 / 万相 / MiniMax 海螺。主脑仍是 DeepSeek。

仓库标题、README 标题与 GitHub About 从 0.2.2 之后统一改成功能定位（见页面顶部），`CN-gpt` 只保留为彩蛋式别名。

## 许可

MIT。见 [LICENSE](https://github.com/nanfangtown/CN-gpt/blob/main/LICENSE)。
