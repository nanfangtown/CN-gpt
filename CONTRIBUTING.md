# 参与贡献

感谢你愿意花时间。这个项目是一个**本地运行的 DSH 插件**，最需要的三类贡献是：
真实使用中的 bug 报告、对"付费路径 / 读图路由"边界的审查、以及文档纠错。

## 开发环境

- Node.js **20.6+**（测试用到 `--import`；CI 跑 20 / 22）
- 可选：DeepSeek Harness `0.2.1+`（只有 `tests/e2e-*.mjs` 需要）
- **不需要任何 API key**：离线套件用本地假厂商，不联网、不花钱

```bash
git clone https://github.com/nanfangtown/CN-gpt.git
cd CN-gpt
npm install          # 只装 @deepseek-ai/schemastery 一个 devDependency
npm test             # 离线全量套件
npm run test:docs    # 文档相对链接检查
```

## 测试矩阵

| 命令 | 需要 DSH / key | 覆盖 |
| --- | --- | --- |
| `npm test` | 否 / 否 | 配置默认值、9 个工具的注册面、submit → poll → fetch、错误映射、账本、花费闸门、开关、读图守卫、卡片 |
| `npm run test:docs` | 否 / 否 | README / docs / CONTRIBUTING 的相对链接 |
| `npm run test:mutation` | 否 / 否 | 故意改坏关键逻辑，确认测试会红（**会改写工作区源码再还原，勿与其它测试并发**） |
| `npm run test:perf` | 否 / 否 | 每请求固定成本与 guard 链开销 |
| `npm run test:sizes` | 否 / 否 | 9 个工具 schema 的字符数 |
| `node --import ./tests/register.mjs ./tests/e2e-*.mjs` | 是 / 是 | 真实 harness / 真实厂商；缺条件时打印 `SKIPPED:` |

`tests/README.md` 有路径探测、沙箱初始化和各 e2e 的详细说明。

## 代码结构

```text
index.js              Config + 9 个工具注册 + 提示词段落 + 六条 guard
client.js             插件页里的配置卡（唯一前端代码）
core/                 字段映射、错误、密钥、成本/账本、落盘、工具开关、读图守卫
tasks/                异步任务 manager + 三个厂商 adapter
tools/                每个顶层工具一个文件
cordis.patch.yml      bundle 补丁层：读图路由 + 3 个 agent preset + 插件本体
tests/                离线套件、假厂商、假 LLM、真实 harness e2e
```

## 修改约定（重要）

1. **付费路径必须过 `core/spend-guard.mjs`**：新增加一个"提交即扣费"的调用，就要过
   `estimateSpend` + `authorizeSpend`；未计价必须 fail-closed，不能用自报金额放行。
2. **不要静默降级**：账本、storage、key、探测失败都要在 `media_report(health)` 或错误文案里
   点名原因。"读不到就当作 0"会直接关掉会话累计上限。
3. **工具描述有字节预算**：每个请求都会带全部工具 schema，`npm run test:sizes` 会打印成本；
   加长描述前先看这组数字。
4. **新配置项要三处同步**：`index.js` 的 `Config`、`cordis.patch.yml` 的出厂模板、
   以及 `tests/run.mjs` 的"发布用 patch 与出厂 Config 对齐"用例。
5. **不硬编码本机路径**：测试里统一走 `tests/_paths.mjs`；插件本体不出现绝对路径。
6. **密钥永不入库**：`.env`、`.credentials*` 已在 `.gitignore`；测试只用桩。

## 提交与 PR

- 提交信息用 Conventional Commits 前缀（`feat:` / `fix:` / `docs:` / `test:` / `chore:`），
  标题写"做了什么、为什么"，中文可以。
- PR 请说明：改了什么、为什么、跑了哪些命令、有没有行为变更。
- 涉及付费 / 密钥 / 读图屏蔽的改动，请额外写清**最坏情况**与回滚方式。
- 提交前至少跑 `npm test` 与 `npm run test:docs`；改文档再加跑一次链接检查。

## 发布流程（维护者）

1. 更新 `CHANGELOG.md`，`package.json` 的 `version` 同步。
2. `npm test && npm run test:docs`，再跑一次 `npm pack --dry-run` 检查包内容。
3. 打 tag（`v0.1.1`）并推送；GitHub Actions 跑离线矩阵。
4. 可选发布 npm：`npm publish --access public`（`private` 已移除，`publishConfig` 为 public）。
5. 发布后在一个干净的 profile 里按 README 安装一遍，确认 `--dump-config` 里有两行 + 三个 preset。

## 安全

不要开 public issue 贴密钥、账单或可复现的敏感值。见 [SECURITY.md](SECURITY.md)。

## 行为准则

参与即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
