# 发布清单（维护者）

代码侧的开源准备已经做完；下面这些是**只有维护者能决定/执行**的事项。逐项勾掉即可发布。

## 1. 身份与仓库地址

- [ ] 决定 GitHub 账号 / 组织与仓库名（建议 `dsh-mm-models`）。
- [ ] 在 `package.json` 补三个字段（当前刻意留空，避免写入假地址）：

      "repository": { "type": "git", "url": "git+https://github.com/<owner>/dsh-mm-models.git" },
      "homepage": "https://github.com/<owner>/dsh-mm-models#readme",
      "bugs": { "url": "https://github.com/<owner>/dsh-mm-models/issues" }

- [ ] README 里的 `<repo-url>` 换成真地址；如需 CI 徽章，再把 `offline-tests.yml` 的徽章加回 README 顶部。
- [ ] `.github/ISSUE_TEMPLATE/config.yml` 里两处 `OWNER` 换成真地址（issue 选择页的两个入口）。
- [ ] `SECURITY.md` / `CODE_OF_CONDUCT.md` 里的"私下联系维护者"补上真实联系方式
      （或启用 GitHub 的 Private vulnerability reporting，把链接写进去）。
- [ ] 确认公开显示名：当前代码与文档统一用 **`gpt-CN`**。若决定改成 `CN-gpt`，
      需同步 `package.json` 的 `meta.title`、`locale/zh.json`、`locale/en.json`、
      `client.js` 的 `DICT`、README 与相关测试断言（不只是改 README）。
- [ ] 确认 `LICENSE` 的版权行（当前是 `dsh-mm-models contributors`；要写真实姓名或组织就改）。

## 2. 仓库设置

- [ ] 创建仓库并推 `master`（当前无 remote）。
- [ ] 打开 Actions；确认 `offline-tests` 在 Linux / Windows × Node 20 / 22 全绿。
- [ ] Settings → Security：打开 **Private vulnerability reporting** 与 Dependabot alerts。
- [ ] 保护分支：要求 PR + 至少一次 CI 通过（单人项目可先只要求 CI）。

## 3. 发布前验证（本机可复跑）

```bash
npm ci || npm install
npm test
npm run test:docs
npm pack --dry-run      # 检查包里只有 index/client/core/tasks/tools/locale/patch/README
```

- [ ] 确认包内容**不含** `tests/`、`_sandbox/`、`docs/`、`.env`、账本、截图。
- [ ] 在一个**干净的 DSH profile** 里按 README 安装，确认：
      `dsh --profile <p> --dump-config` 里出现 `mm-models` 与 `llm-pi-ai` 两行 + 三个 `preset-mm-*`。
- [ ] 配一把 key，跑一次 `media_report(action=health)` 与一次 `qwen_draw`，确认成本闸门文案正确。
- [ ] 不配任何 key 启动一次：确认插件**不崩**，且 `media_report` 如实说"未配置"。

## 4. 版本与发布

- [ ] `package.json` 与 `CHANGELOG.md` 的版本一致（当前 `0.1.1`）。
- [ ] `git tag v0.1.1 && git push origin master --tags`。
- [ ] 可选：发布 npm（已移除 `private`，`publishConfig.access = public`）：

      npm publish --access public

- [ ] 发布后回填 README 的状态行（是否已上 npm）。

## 5. 已知取舍（发布时如实写进 Release Notes）

- 默认屏蔽原生读图；没有读图员 key 的用户会暂时"看不见图"。见 README 的说明。
- bundle 的 `llm-pi-ai` 行是**覆盖**语义，可能覆盖用户已有 provider。
- 单价表是估算，不是账单；填错价代码拦不住。
- 真实 harness e2e 不在 CI 跑（需要本机 DSH 与真 key）。
- 0.3.x 运行时未验证，`engines.dsh` 已显式排除。
