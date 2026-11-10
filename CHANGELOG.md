# Changelog

## [0.3.0] - 2026-11-10

### Added

- **`run_batch`（批量执行）**：一次跑多条命令（测试 / 构建 / 批量检查 / CI 复现），返回每条的命令、退出码、耗时、输出尾巴（≤200 字符）与失败摘要，完整日志落 `gen/batch/`。
  - **为什么**：成本大头是**步数 × 上下文**——逐条跑 12 个测试文件 = 54 步 / 3M cacheRead；合成一次调用后是 1 步，实测 cacheRead 约降到 1/28。
  - **串行 / 并行**：默认串行；`parallel: true` 按 `batchParallelLimit`（默认 4）并发，结果顺序不变；与 `stop_on_error` 互斥。实测 4 个测试文件 2.18 s → 1.04 s。
  - **脚本入口**：`script: "test"` 直接读 `package.json` 脚本，按 `&&` 拆条、`npm run` 递归展开（最多 3 层）；没装 npm 的机器也能跑官方测试入口。
  - **退出码保真**：Windows 下用包装脚本绕开 `powershell -Command` 把 3 压成 1 的问题；超时用 `taskkill /T` 收整棵进程树。
  - **环境隔离**：子进程剔除 `*_API_KEY` / `*_TOKEN` / `*SECRET` 等密钥变量，与原生 shell 的 shell-env 策略一致。
  - 新增 `tests/run-batch.test.mjs`（16 项，离线、不花钱）。
- **`blockNativeShell`（激进模式，默认关）**：屏蔽主 agent 的 `pwsh` / `bash` / `ops_bash`，命令只能经 `run_batch` 执行。shell 是执行基底，所以默认关；子代理不受影响；与 `enableRunBatch=false` 同时打开时启动自检告警。
- **合并 `dsh-minimax-connect` 0.3.0（MIT）**：新增 bundle 行 `mm-minimax`，注册 `minimax` LLM provider 与设置卡（积分 / 签到 / 订阅额度 / 模型清单）。
- **合并 `dsh-coding-minimax`**：新增 `subagent_script` 工具（脚本 / 构建 / 测试 / 批量机械改动），默认走 `minimax/MiniMax-M3.1-Flash`，预检不过静默回落父路线。
- 新增 `THIRD_PARTY_NOTICES.md`。

### Changed

- `subagent_code` 改为**核心编码**专用（设计 / 重构 / 根因），不再绑定 MiniMax 路线；与 `subagent_script` 的分工写进工具描述。
- 提示词加强"批量执行"：触发从"跑测试 / 构建"扩到"改完代码跑回归、多包 / 多端 / 多版本验证、CI 复现"，点名 `script:"test"`，并加"依赖上一条输出才能决定下一条的不要批"的反向约束；该行由 `enableRunBatch` 控制。提示词段落预算 960 → 1200 B。
- 配置卡新增 `run_batch`、`blockNativeShell`、`batchMaxCommands`、`batchCommandTimeoutMs`、`batchParallelLimit`。

### Fixed

- 修掉 0.3.0 遗留的 5 项红灯：工具数断言（11→13）、`subagent_code` schema 超预算、出厂 patch 对齐把 `mm-minimax` 行的键算进来、客户端测试不认识 `react/jsx-runtime` 与 `useCallback`。
- 假 React 的两个真实缺陷：`createElement` 切换 slots 时**没有恢复 cursor**（嵌套组件让父组件 hook 下标漂移）、页面组件没走 `createElement`（cursor 跨次累积）。vendored 设置卡引入嵌套组件后才暴露。
- `verify-functionality` ① 在没有 git / 浅克隆时**显式 SKIPPED**，不再假失败。
- `run_batch` 子进程不再继承密钥环境变量（首跑时导致"缺 key"测试拿到真 key）。

### Tests

- `run.mjs` 142 项、`run-batch` 16 项、全套 13 个文件全绿；新增"提示词由 `enableRunBatch` 控制"、"shell 屏蔽与子代理豁免"等回归断言。

# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。
本项目在 `0.x` 期间允许有行为变更，破坏性变更会写在 `Changed` 里。

## [0.2.2] - 2026-11-01

### Added

- **读图回合闸门（`guard/turn-gate.mjs`）**：修复"派了读图员却抢先作答"。
  主 agent 派出读图员后，闸门在宿主 `agent/pre-step`（模型下一次开口之前）等结论回来，
  取回后才允许开下一步——模型在物理上无法抢答。四个开关：
  `readerGate`（总闸）、`readerGateImageHint`（本轮有图未取证 → 注入提醒）、
  `readerGateForceEvidence`（无证据收尾 → 补一个纠正回合）、`readerGateTimeoutMs`（默认 90s，超时 fail-open）。
  只作用于读图员：出片 / 视频 / 复杂工作流的异步链路完全不动（它们不登记在闸门表里）。
  状态可在 `media_report(action=health)` 的 `visionStatus.turnGate` 里查到。
- **有图自动跑本地 OCR（`autoOcrOnImage`，默认开）**：闸门在模型开口前先把图里的"字"抄一遍
  （免费、离线、约 0.4s），作为证据注入——不需要模型决定，所以不会出现"为省事直接派读图员"。
  OCR 失败或认不出字（照片/画面）时不注入，退回原有的提醒路径。
- **读图员预读 OCR**：派单前先本地抄字，把结果附在给读图员的 prompt 里让它校对错字、补漏行
  （同一张图上，读图员从"从零描述"变成"核对 + 补版式/归属"）。
- **批量读图（`readerBatchMode`，默认关闭）**：打开后 schema 里只有 `image_paths`（数组，≤ `readerBatchMax`），
  不再提供单图入口——批量是**显式开启**的强制模式，出厂仍是一图一读图员。
  定位：**一次读一批**——同一批图分两次调用会各自独立、无法互相参照；
  结论必须按「图1/图2」分段；超过上限点名拒绝（不静默截断），请分组成多次调用；
  不相关或每张要分别提问就分开调用。
  收益是形状唯一、行为可预测（没有"逐张调三次"的岔路）；代价是单图精细度与失败隔离下降。
  实现细节：`image_path` 仍被**接受**（旧会话/旧测试兼容），但批量模式的 schema 里不出现。

### Fixed

- **无扩展名的粘贴图现在能走本地 OCR**：`.dsh/attachments/v1/objects/…` 是无后缀对象，
  过去 `ocr_image` 直接按后缀拒绝（"纯文字截图先走 OCR"在最常见场景下失效）。
  现在按文件头嗅探格式（PNG/JPEG/WEBP/HEIC…），并在交给 WinRT 前复制成带后缀的临时文件
  （实测同一个文件无后缀时 `StorageFile` 打不开、复制成 `image.png` 后同一份字节立刻可 OCR）。
- **自动 OCR 在真实粘贴图上不触发**：会话日志里，粘贴图消息只有 `image` 块 + 用户那句短话，
  **本地路径不在消息文本里**（模型看到的那行 `Normalized copy …` 是渲染层补的）。
  闸门现在能从 `attachment.attachmentId`（`sha256:<hex>`）还原
  `<DSH_HOME>/attachments/v1/objects/<前两位>/<hex>`，粘贴图也能自动 OCR。
- 闸门为什么开在 `pre-step` 而不是 `turn-stopping`：宿主顺序是**先 step**（assistant 文本已
  流式发出、已入库）**后 turn-stopping**，在后者拦只能"补一条更正"，拦不住"先说错"。

### Changed

- `media_report(action=health)` 增加「读图闸门：开/关 ｜ 在等 N」一行；`verbose` 下补
  「上次 OCR 找到 X 张/成功 Y 张」，用来区分"没找到图"与"OCR 失败"。

## [0.2.1] - 2026-10-31

### Added

- **发布到 npm**：包名 `dsh-mm-models`。`dsh plugin --profile desktop add dsh-mm-models`
  即可安装，装到的是预构建代码，用户不需要授权任何构建脚本（DSH 把这句转发给 profile 内的 pnpm）。
  README 安装段改为 npm 优先，本地目录保留为"改源码 / 跟未发布分支"的方式。
- **CI 发布流水线** `.github/workflows/publish.yml`：推 `v*` 标签触发，先硬校验
  "标签 == `v` + `package.json` 版本"，再跑离线套件，最后 `npm publish --provenance`
  （来源证明）。鉴权支持 `NPM_TOKEN` 与 Trusted Publisher（OIDC）两种。
- **维护者文档** `PUBLISHING.md`：发布前置、两种鉴权、发布后验证、出错回滚口径。

### Changed

- `files` 补 `SECURITY.md` / `CHANGELOG.md`，npm 包内的文档链接不再指向包外；
  README 的文档链接改为绝对地址（npm 页面只渲染 README，相对路径会失效）。
- `prepublishOnly` 钉住 `npm test && npm run test:docs`，本地误发会被拦。

## [0.2.0] - 2026-10-31

### Added

- **本地 OCR `ocr_image`**（2026-10-30）：纯文字截图（报错 / 日志 / 代码 / 表格 / 文档 / 聊天记录）
  不再派读图子代理 —— 用 Windows 自带的 `Windows.Media.Ocr` 直接抄字：免费、离线、截图不出网，
  通常 0.3–1.5 秒。按内容自动在中文 / 英文引擎间选择（中文引擎会把 ASCII 认成形近字），
  小字自动放大后重认一次，并按词框把引擎拆乱的行重排回阅读顺序（中文不再逐字带空格）。
  与读图员互补：图表读数 / 排版 / 画面仍走 `ask_qwen`；开关 `enableOcrImage` 默认开，
  `media_report(action=health)` 里有一行「本地 OCR」状态。
- **MiniMax（海螺）出片**：新增 `minimax_video`（文生 / 图生 / 首尾帧），走 MiniMax v1
  `POST /v1/video_generation` → `GET /v1/query/video_generation` → `GET /v1/files/retrieve`；
  独立 `MINIMAX_API_KEY`，国内 `.cn` / 国际 `.io` 可配。
- 按条计费：`unit: call` + `tiers`（分辨率 × 时长），缺档位 fail-closed；账本/健康/成本报表同步。
- 测试：适配器契约 12 项 + 工具层闸门/记账 5 项；CI 增加 OCR / MiniMax suite。

### Changed

- **读图员默认模型升级到 `qwen3.8-max`**（2026-10-31）：`qwen-vl` provider 白名单新增
  `qwen3.8-max`，`readerQwenModel` 默认切到它，保留 `qwen3-vl-plus` 作回退；实测支持图像输入，
  文本逐字与场景事实探针均通过；单价表新增 `qwen3.8-max`（未计价，需按官网补价）。
- **读图员 prompt 从“文字优先”改为“内容优先”**：persona 由“文字与结构”改为“内容进行转述”，
  新增“区分看到的与推断的”；默认问题、子代理指令模板与两个工具的 description 不再只提
  文字/界面，补上人物、物体、布局、光线与场景；工具 schema 总量仍守住上限。
- **出片模型互斥**：`seedance_video` / `video_gen` / `minimax_video` 三选一；
  设置卡打开一个自动关闭另外两个，Host 侧 `normalizeSettingsOps` + guard 双重兜底。
- 子代理出片刹车（`blockSubagentSpend` / `blockSubagentVideoSpend`）覆盖 `minimax_video`。

## [0.1.1] - 2026-10-19

首个公开版本。功能在 2026-10 的开发期逐步落地，这里按主题汇总。

### Added

- **9 个顶级工具**：`ask_glm` / `ask_qwen`（读图）、`qwen_draw`（制图）、
  `seedance_video` / `video_gen`（出片）、`media_task`（任务找回）、`media_report`（成本 / 健康）、
  `subagent_code` / `subagent_research`（窄委派）。
- **读图员自己注册**：`ask_glm` / `ask_qwen` 不再依赖 `tool-subagent` 行，工具描述、schema 与
  只读契约都由插件控制；子代理用 `preset-mm-reader` 固定"只有 `read_image`"的工具面。
- **百炼出片**：可灵 v3 / v3-turbo / v3-omni、万相 2.5，复用 `DASHSCOPE_API_KEY` 与异步视频协议。
- **窄委派**：`subagent_code`（命令 + 文件读写 + 查找，约 7 个工具面）与
  `subagent_research`（只读 + 联网，约 5 个工具面），避免每个子代理背全部 35 个工具的 schema。
- **花费闸门**：未计价 fail-closed、单次上限、会话累计（含子代理会话树）、精确金额复述、
  小额免确认；提交不重试，提交后失败仍按 taskId 补记。
- **任务注册表与出图缓存**：整轮失败后可用 `media_task` 找回；相同 prompt + 参数不重复计费。
- **成本 / 健康报表**：账本与单价自检、三把 key 状态、四条链路最近成功/失败与轻量探测。

### Changed

- 公开显示名统一为 **`CN-gpt`**（与仓库同名）；包名保持 `dsh-mm-models`，插件 id 保持 `mm-models`。
- 包名从 `@local/dsh-mm-models` 改为无 scope 的 `dsh-mm-models`，便于公开安装。
- 出厂默认改为"开箱即见效果"：读图员开、主代理与通用子代理的原生读图默认屏蔽；
  可在配置卡里关掉两个 `block*` 开关回到原生读图。
- 文档拆分：面向使用者的 README 与开发期工程记录（`docs/ENGINEERING-NOTES.md`）分离；
  三次专项报告归档到 `docs/reports/`。
- 公开文档不再依赖本机路径；测试路径统一走 `tests/_paths.mjs`。
- `package.json` 移除 `private`，补 `author` / `engines.node` / `publishConfig`。

### Fixed

- CI 首次真实运行暴露的三处问题：`tests/register.mjs` 只去 desktop profile 找真实
  schemastery（全新 clone 找不到就退出）、Node 20 没有 `module.registerHooks`、
  `verify-functionality` 依赖历史 commit 而 CI 默认浅克隆。现在优先找仓库自己的
  `node_modules`，矩阵改为 Node 22 / 24，checkout 用完整历史；失败用例输出 annotation。
- `isInside` 在 Windows 8.3 短路径（CI 的 `RUNNER~1`）下把"根目录内的新文件"误判成越界：
  目标不存在时改为对最近存在的祖先做 `realpath`，再拼回剩余段（2026-10-19 真实 CI）。
- `media_report(action=health, verbose=true)` 的 Markdown 表格被读图路由行与互斥告警打断
  （表格中间插入空行与普通段落，渲染成两截）。
- 制图此前没有走金额闸门（2026-10-16）：未计价模型也能提交，且不需要确认。
- 单价写成 `0` 会把整道闸门关掉；未计价时 `confirm_estimate` 可被自报金额绕过（2026-10-15）。
- 出片模型 id 与单价表键不一致导致 fail-closed、且日志静默（2026-10-15）。
- `read_image` 守卫读错入参字段名（`args` vs `arguments`），生产里从未生效（2026-10-16）。
- 测试"间歇性假绿"：测试目录改为每轮唯一；缺 key 的 e2e 用 `SKIPPED:` 与通过区分。
- 产物下载失败无差别重试三遍、体积上限先读满内存再拒绝（2026-10-13）。

### Security

- 密钥只从 配置卡字面值 → 凭据服务 / 引用名 → 环境变量 / `~/.dsh/.env` 解析，
  不进日志、不进错误消息、不进健康报表。
- 无 postinstall、无自动下载二进制；产物只写配置的目录，本地读图有 containment 断言。
