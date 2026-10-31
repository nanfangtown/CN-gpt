# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。
本项目在 `0.x` 期间允许有行为变更，破坏性变更会写在 `Changed` 里。

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
