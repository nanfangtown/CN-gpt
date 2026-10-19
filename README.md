# dsh-mm-models

> **给 DeepSeek 主脑补上「眼睛 + 画笔 + 摄像机 + 剪辑台」。**
>
> `0.1.1` · 本地优先 · 不收集遥测 · MIT · 需要 DeepSeek Harness `0.2.1+`

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）bundle：把 GLM / Qwen-VL 读图、Qwen 制图、Seedance / 可灵 / 万相出片做成与 `bash`、`ops_*` 同级的顶级工具，并共用一层异步任务管理、一套多 key 管理与一套**花钱闸门**。

DeepSeek 主模型负责思考与交付；外部模型只负责"看 / 画 / 拍"这些它原生没有的能力。

## 它提供什么

| 工具 | 能力 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ask_glm` | GLM 读图子代理 | ✅ 开 | 看图、截图、PDF、图表、手写、界面 → 结构化结论 |
| `ask_qwen` | Qwen-VL 读图子代理 | ⛔ 关 | 与 `ask_glm` 二选一；中文界面 / 密集文字更强 |
| `qwen_draw` | Qwen 文生图 / 图生图 | ✅ 开 | 产物落盘 + 返回路径；可选把图附回上下文 |
| `seedance_video` | 火山方舟 Seedance 出片 | ⛔ 关 | 文生 / 图生视频，异步任务 |
| `video_gen` | 百炼出片：可灵 v3 / 万相 2.5 | ⛔ 关 | 复用 `DASHSCOPE_API_KEY`，需业务空间 ID |
| `media_task` | 异步任务重查 / 补下载 | ✅ 开 | 整轮失败后按 `provider + task_id` 找回产物 |
| `media_report` | 成本估算 / 链路健康 | ✅ 开 | 账本、单价自检、三把 key 与四条链路状态 |
| `subagent_code` | 窄工具面执行子代理 | 常开 | 只有命令 + 文件读写 + 查找；适合改代码 / 跑构建 |
| `subagent_research` | 窄工具面资料子代理 | 常开 | 只有只读文件 + 网页检索；适合查文档 / 核实事实 |

> 后两个工具是"窄委派"：通用子代理每轮要背全部工具表（约 35 个 / 32 KB），这两个只背 7 / 5 个（约 5.7 / 3.0 KB）。读图员本身也是子代理。

## 为什么不是"让主模型自己看图"

- 主路由对单图常有 token 上限（例如 DeepSeek 路由 `MAX_IMAGE_TOKENS = 1024`），大图会被大幅降采样；交给没有该上限的视觉模型反而更准。
- 图片内容块会把"上传 / 传输失败"的风险带进每一轮对话；产物几 MB 时尤其明显。
- 读图员是**只读**子代理：工具面只有 `read_image`，不会读代码、翻目录、跑命令。

所以默认策略是：**主代理不看原图，读图员看；主代理拿文字结论**。如果你更喜欢原生读图，见下面的开关。

## 安装

前置：DSH Desktop `0.2.1-rc.1` 或更高（`0.2.x` 线），profile 默认 `desktop`。

```bat
:: 从本地目录安装（当前推荐；尚未发布到 npm）
dsh plugin --profile desktop add "D:\path\to\dsh-mm-models"

:: 或从 clone 下来的仓库安装
git clone <repo-url> dsh-mm-models
dsh plugin --profile desktop add ".\dsh-mm-models"
```

装完**完整重启 DSH**。安装会在 profile 里加两行 + 三个 agent preset：

1. `llm-pi-ai` —— 注册两条读图路由：`providers.glm`（智谱）与 `providers.qwen-vl`（百炼）。
2. `mm-models` —— 插件本体（9 个工具 + 一段可关闭的分工提示词）。

> ⚠ **第 1 行是覆盖语义**：`config` 整体替换，不与已有 `providers` 深合并。
> 如果你在 设置 → 模型 里配过自定义 provider，安装前先备份 `cordis.patch.yml`，
> 或安装后把 `providers.glm` / `providers.qwen-vl` 合并进你原有的配置。
> 不需要插件代配路由时，删掉 `cordis.patch.yml` 的第 1 行，再手工在设置里添加 GLM / Qwen-VL 路由。

配置卡入口：侧栏「插件」→ 已安装 → `dsh-mm-models`（显示名 **gpt-CN**）→ 组合包详情 → 配置卡。

## 三把 key

| Key | 给谁用 | 推荐放法 |
| --- | --- | --- |
| `ZHIPU_API_KEY` | `ask_glm` | 设置 → 模型 → GLM 行；或 `~/.dsh/.env` |
| `DASHSCOPE_API_KEY` | `qwen_draw` / `ask_qwen` / `video_gen` | `~/.dsh/.env` 或配置卡引用名 |
| `ARK_API_KEY` | `seedance_video` | `~/.dsh/.env` 或配置卡引用名 |

```bash
cp .env.example ~/.dsh/.env   # 然后填入真值；不要把填好的 .env 提交到仓库
```

解析优先级：**配置卡字面值 > 凭据服务 / 引用名 > 环境变量 / `~/.dsh/.env`**。
三条链路互相独立：缺任何一把 key 只影响对应工具，不会让插件加载失败。

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
```

所有生成类调用都返回本地文件路径；是否把图片附回模型上下文由 `attachResultImages` 控制（默认关，只回路径）。

## 花钱闸门

这是插件最核心的安全设计。所有付费提交（出图 / 出片）都走同一道收口：

1. **未计价 = 拒绝**：单价表查不到、单价为 `0` 或负数，一律 fail-closed；调用方自报金额不作数。
2. **单次上限**：默认 `videoCostLimitCNY = 10` 元。
3. **会话累计上限**：默认 `videoSessionCostLimitCNY = 30` 元，含子代理会话树。
4. **复述金额**：预估超过 `noConfirmUnderCNY`（默认 1 元）时必须传回精确到分的 `confirm_estimate`。

单价表在配置卡里可改；**填错价拦不住**（只拦"缺档位"），请按厂商官网核对。
金额是估算，不是账单。详见 [SECURITY.md](SECURITY.md)。

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
| [docs/ENGINEERING-NOTES.md](docs/ENGINEERING-NOTES.md) | 完整工程记录：设计取舍、事故复盘、性能与测试数据（历史快照，可能过时） |
| [docs/reports/](docs/reports/) | 三次修复 / 性能 / 读图路由的专项报告 |
| [SECURITY.md](SECURITY.md) | 密钥处理、花费安全、漏洞报告方式 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、测试、提交规范、发布流程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [tests/README.md](tests/README.md) | 测试矩阵与试运行脚本 |

## 开发

```bash
npm install          # 只装一个 devDependency（schemastery）
npm test             # 离线套件：不需要 DSH、不需要 key、不联网、不花钱
npm run test:docs    # 文档相对链接检查
```

测试的边界：

- **离线套件**用本地假厂商（`tests/mock-providers.mjs`）跑完 提交 → 轮询 → 下载 → 记账，CI 在 Linux / Windows × Node 20 / 22 上跑。
- **真实 harness 脚本**（`tests/e2e-*.mjs`）需要本机 DSH 安装与真 key，`SKIPPED:` 与通过可区分，`DSH_E2E_STRICT=1` 时跳过会以 78 退出。
- 变异测试（`npm run test:mutation`）会**直接改写工作区源码**再还原，不要与其它测试并发跑。

## 名字

插件页显示名是 **gpt-CN**（包名 `dsh-mm-models`，插件 id `mm-models`）。**这是玩梗，不是技术栈**——调用链里 GPT 含量 0%，实际是 GLM / Qwen / Seedance / 可灵 / 万相。主脑仍是 DeepSeek。

## 许可

MIT。见 [LICENSE](LICENSE)。
