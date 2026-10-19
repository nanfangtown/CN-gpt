# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。
本项目在 `0.x` 期间允许有行为变更，破坏性变更会写在 `Changed` 里。

## [Unreleased]

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

- 包名从 `@local/dsh-mm-models` 改为无 scope 的 `dsh-mm-models`，便于公开安装。
- 出厂默认改为"开箱即见效果"：读图员开、主代理与通用子代理的原生读图默认屏蔽；
  可在配置卡里关掉两个 `block*` 开关回到原生读图。
- 文档拆分：面向使用者的 README 与开发期工程记录（`docs/ENGINEERING-NOTES.md`）分离；
  三次专项报告归档到 `docs/reports/`。
- 公开文档不再依赖本机路径；测试路径统一走 `tests/_paths.mjs`。
- `package.json` 移除 `private`，补 `author` / `engines.node` / `publishConfig`。

### Fixed

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
