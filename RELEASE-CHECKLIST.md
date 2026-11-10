# 发布清单（维护者）

代码侧的开源准备已经做完；下面这些是**只有维护者能决定/执行**的事项。逐项勾掉即可发布。

## 1. 身份与仓库地址

- [x] 仓库：`https://github.com/nanfangtown/CN-gpt`（空仓库，默认分支 `main`）。
- [x] `package.json` 已补 `repository` / `homepage` / `bugs` 三个字段。
- [x] README 的 clone 地址与 CI 徽章已指向真仓库。
- [x] `.github/ISSUE_TEMPLATE/config.yml` 的两个入口已指向真仓库。
- [x] `SECURITY.md` / `CODE_OF_CONDUCT.md` 已补 Private vulnerability reporting 与维护者主页。
- [x] 公开显示名统一为 **`CN-gpt`**（`package.json meta.title`、两个 locale、
      `client.js DICT`、README、错误文案与测试断言都已同步）。
- [ ] 确认 `LICENSE` 的版权行（当前是 `dsh-mm-models contributors`；要写真实姓名或组织就改）。

## 2. 仓库设置

- [x] 推送 `main`（2026-10-19，首个 push 已完成）。
- [x] 打开 Actions；确认 `offline-tests` 在 Linux / Windows × Node 22 / 24 全绿。
- [ ] Settings → Security：打开 **Private vulnerability reporting** 与 Dependabot alerts。
- [ ] 保护分支：要求 PR + 至少一次 CI 通过（单人项目可先只要求 CI）。

## 3. 发布前验证（本机可复跑）

```bash
npm ci || npm install
npm test
npm run test:docs
npm pack --dry-run      # 检查包里只有 index/client/core/tasks/tools/locale/patch + README/SECURITY/CHANGELOG
```

- [ ] 确认包内容**不含** `tests/`、`_sandbox/`、`docs/`、`.env`、账本、截图。
- [ ] 在一个**干净的 DSH profile** 里按 README 安装，确认：
      `dsh --profile <p> --dump-config` 里出现 `mm-models` 与 `llm-pi-ai` 两行 + 三个 `preset-mm-*`。
- [ ] 配一把 key，跑一次 `media_report(action=health)` 与一次 `qwen_draw`，确认成本闸门文案正确。
- [ ] 不配任何 key 启动一次：确认插件**不崩**，且 `media_report` 如实说"未配置"。

## 4. 版本与发布

- [x] `package.json` 与 `CHANGELOG.md` 的版本一致（当前 `0.3.0`；0.2.2 及以前的记录见 CHANGELOG 与下面的历史行）。
- [x] `v0.1.1` annotated tag 已创建并推送。
- [x] `v0.2.0` annotated tag（随该次发布创建）。
- [x] `v0.2.1` annotated tag 已发布 npm。
- [x] `v0.2.2` annotated tag（2026-11-01 创建并推送；CI publish run #5 成功）。
- [x] 发布 npm：CI + `NPM_TOKEN`，`dsh-mm-models@0.2.2` 已上架（带 provenance，gitHead `c0a93e9`）。

- [ ] 发布后回填 README 的状态行（是否已上 npm）。
- [ ] 本次首次 push 用了一把 **repo-scoped deploy key**（`.deploy/`，已 gitignore）。
      推完可在仓库 Settings → Deploy keys 删掉它，并删除本机 `.deploy/`；要保留以后继续推就留着。

## 5. 0.3.0 新增检查（本次发布）

- [ ] 干净 profile 里跑一次 `run_batch`：串行 / `parallel: true` / `script: "test"` 三种形态各一次。
- [ ] `blockNativeShell` 默认关；打开后主代理 `pwsh` 被拒（附指路文案），`run_batch` 与子代理 shell 不受影响。
- [ ] 配置卡能看到 `run_batch` / `blockNativeShell` / `batchMaxCommands` / `batchCommandTimeoutMs` / `batchParallelLimit`（**先刷新页面**再确认）。
- [ ] `run_batch` 子进程里看不到 `*_API_KEY` / `*_TOKEN`（密钥环境变量过滤生效）。
- [ ] `npm test` 覆盖新用例（`run-batch` 16 项、`run.mjs` 142 项、全套 13 个文件）。
- [ ] tag `v0.3.0`；Release Notes 写明批量执行与激进模式的取舍。

## 6. 已知取舍（发布时如实写进 Release Notes）

- 默认屏蔽原生读图；没有读图员 key 的用户会暂时"看不见图"。见 README 的说明。
- bundle 的 `llm-pi-ai` 行是**覆盖**语义，可能覆盖用户已有 provider。
- 单价表是估算，不是账单；填错价代码拦不住。
- 真实 harness e2e 不在 CI 跑（需要本机 DSH 与真 key）。
- 0.3.x 运行时未验证，`engines.dsh` 已显式排除。
