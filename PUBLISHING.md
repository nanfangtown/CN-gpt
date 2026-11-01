# 发布到 npm（维护者）

包名 `dsh-mm-models`。安装侧是 `dsh plugin --profile <p> add dsh-mm-models` —— DSH 把这句
转发给 profile 内的 pnpm，所以用户装到的是**预构建代码**，不需要给任何构建脚本授权。

## 0. 前置

- Node.js **22.15+**（带 npm 11+）；或干脆不装，直接用第 3 节的 CI 发布
- npm 账号已开 2FA
- 首次发布前确认包名没被占：

```bash
npm view dsh-mm-models version    # 应报 404（= 名字可用）
```

> 本机现状：这台开发机上**没有 npm**，只有 DSH 自带的 node 运行时。
> 所以本地 `npm publish` 这条路暂时走不通 —— 装一次 Node LTS，或者直接用 CI。

## 1. 版本与标签

1. `CHANGELOG.md` 写版本段，`package.json` 的 `version` 同步（两者必须一致）。
2. 提交后打 annotated tag：`git tag -a v0.2.2 -m "v0.2.2"`，然后 `git push origin v0.2.2`。
3. **标签必须等于 `v` + `package.json` 版本** —— `publish.yml` 会硬校验，不等就停。

## 2. 本地发布（有 npm 时）

```bash
npm install
npm test              # 离线套件：不联网、不花钱
npm run test:docs
npm pack --dry-run    # 包内容：index/client/core/tasks/tools/locale/patch + README/SECURITY/CHANGELOG
npm publish --access public --provenance
```

`prepublishOnly` 已经钉住 `npm test && npm run test:docs`，漏跑会被拦（应急可加
`--ignore-scripts`，不建议）。

## 3. CI 发布（推荐）

`.github/workflows/publish.yml`：推 `v*` 标签 → 校验标签/版本 → 跑离线套件 → `npm publish --provenance`。

鉴权二选一：

**A. Granular token（最快，先这样发首版）**

1. npmjs.com → Access Tokens → Generate New Token → **Granular**，权限 "Read and write"。
   Packages 勾 `dsh-mm-models`；包还不存在时先勾 "All packages"，发完再收窄。
2. 仓库 Settings → Secrets and variables → Actions → 新建 `NPM_TOKEN`。
3. 推标签。

**B. Trusted Publisher（不用长期 token，长期用这个）**

1. npmjs.com → 包的 Settings → Trusted Publisher → GitHub Actions，
   owner `nanfangtown`、repo `CN-gpt`、workflow `publish.yml`。
2. 删掉 workflow 里 `NODE_AUTH_TOKEN` 那行（走 OIDC）。
3. 首次发布前包里还没有这个设置，所以先用 A 发一版，再切到 B。

## 4. 发布后验证

```bash
npm view dsh-mm-models version dist.tarball
npm view dsh-mm-models peerDependencies
npm view dsh-mm-models engines
```

在一个**干净的 profile** 里真装一次：

```bat
dsh plugin --profile npmtest add dsh-mm-models
dsh --profile npmtest --dump-config | findstr mm-models
```

确认 `--dump-config` 里有 `mm-models` 与 `llm-pi-ai` 两行 + 三个 `preset-mm-*`，
再启动一次打开插件页的配置卡。装不上时先看 `engines.dsh` 和 peer 范围是否被宿主满足。

## 5. 发错了怎么办

- **版本号发错**：72 小时内可 `npm unpublish dsh-mm-models@<v>`；超过 72 小时只能
  `npm deprecate`，然后发新版本修正。
- **内容有问题但不致命**：`npm deprecate dsh-mm-models@<v> "原因，请升级到 x.y.z"`。
  **别删包** —— 删了会让已安装的用户下次 install 直接失败。
- **`engines.dsh` 范围别为了"看起来兼容"放宽**：它是 DSH 拒绝加载的唯一闸门，
  0.3.x 没验证过就保持排除。
- **provenance 失败**（私有仓库 / 缺 `id-token: write`）：公开仓库 + 上面 workflow 的权限已够；
  实在不行去掉 `--provenance` 再发，但要在 Release Notes 里说明。

## 6. 仓库 About 与 Topics（GitHub 侧，唯一事实源在 README 标题）

仓库首页右侧 About 面板与 README 标题必须一致，否则新访客会看到两套定位。定稿文本：

```
DSH plugin for text-only agents: GLM/Qwen-VL vision, Qwen-Image generation, Seedance/Kling/MiniMax video — with a fail-closed spend gate (per-call cap, session cap, exact-amount confirmation), task recovery and cost reporting.
```

Topics（GitHub 搜索的主要入口）：

```
deepseek-harness  dsh-plugin  multimodal  vision  image-generation  video-generation
llm-agent  cost-control  qwen-vl  glm  seedance  minimax  agent-tools
```

两种改法：

- 网页：仓库首页 About 旁的齿轮 → Description / Topics；
- API（需要 `Administration: write` + `Contents: write` 的细粒度 token）：

```bash
curl -X PATCH -H "Authorization: Bearer $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/nanfangtown/CN-gpt \
     -d '{"description":"<上面那段>"}'
curl -X PUT -H "Authorization: Bearer $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/nanfangtown/CN-gpt/topics \
     -d '{"names":["deepseek-harness","dsh-plugin","multimodal","vision","image-generation","video-generation","llm-agent","cost-control","qwen-vl","glm","seedance","minimax","agent-tools"]}'
```
