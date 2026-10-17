# 试运行环境（不安装、不联网、不花钱）

这些文件**不是插件的一部分**，只在开发/验收时用。`.gitignore` 已排除
`_sandbox/`、`tests/_sandbox/` 与生成产物 —— 试运行痕迹不进仓库。

## 0. 路径与前置（开源友好：没有任何硬编码本机路径）

沙箱目录一律**相对本包**解析（`<包根>/_sandbox`），换台机器 clone 下来即可用。
只有"真跑 harness"的脚本需要知道 DSH 装在哪，按以下顺序自动探测：

1. 环境变量 `DSH_CLI`（CLI 的 `bin.js`）/ `DSH_APP`（Electron 应用可执行文件）；
2. 运行中的应用自身（若由 DSH 拉起）；
3. 常见安装位置（Windows `%LOCALAPPDATA%\Programs\DeepSeek Harness`、`%PROGRAMFILES%`、
   用户目录；macOS `/Applications`）；
4. **Windows 注册表**卸载项的 `InstallLocation`（装在非标准目录时靠这个找到）。

探测失败时脚本会**明确告诉你该设哪个环境变量**，而不是抛一个看不懂的 ENOENT：

```bat
set DSH_CLI=D:\path\to\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js
set DSH_APP=D:\path\to\DeepSeek Harness.exe
```

路径逻辑集中在 [`_paths.mjs`](_paths.mjs)，**不要在别处再写绝对路径**。

## 1. 单测 + 本地假厂商（不需要 dsh、不需要 key）

```bat
cd /d "D:\path\to\dsh-mm-models"
node --import ./tests/register.mjs ./tests/run.mjs
```

- `register.mjs` 用 Node `module.registerHooks` 把 `@deepseek-ai/dsh-tools` /
  `dsh-credentials` / `dsh-storage-domain` / `zod` 映射到 `tests/stubs/`，
  `@deepseek-ai/schemastery` 优先用本机 profile 里的真实包；
- `mock-providers.mjs` 是本地假 DashScope / Ark：完整实现 submit → poll → 产物下载，
  用提示词标记模拟 `[auth] [rate] [policy] [bad] [quota] [5xx] [stall] [conn]` 场景，
  另有**轮询期故障注入**（`[poll429] [poll503] [pollfail]`）与**产物下载故障注入**
  （`[art404] [art5xx-then-ok] [artbig-header] [artbig-stream]`）——后者专为打通
  `manager.mjs` 的退避重试与体积上限而加，此前那一层在测试里完全不可达；
- `fixtures.mjs` 生成真实可解码的 PNG / 近似 MP4，并提供假 `ctx`（credentials / attachments /
  storageDomain / tools / systemPrompt / effect / on）；
- `run.mjs` 共 110 项：配置默认值、注册面、成功链路、失败映射、提交重试策略、
  **轮询退避重试（429/503 退避后成功、持续 5xx 耗尽重试）**、
  **产物下载重试与体积上限（404/超限不重试、503 重试一次、声明超限快速拒绝、流式超限中途中止）**、
  超时/取消保留 task_id、media_task、seedance 文生/图生、两种账本后端、成本报表、
  健康探测（含 ask_qwen 的 qwen-vl 路由与冲突标注）、预算保护（含 60 秒重置与过期会话清扫）、
  附件退化、degradeToText、
  **工具开关（guard 拒绝 / restrict 名单 / 健康报表 ⛔ / 提示词段落联动）**、
  **读图子代理互斥（ask_glm / ask_qwen 二选一 + normalizeSettingsOps）**、
  **读图子代理"只看图"契约（reader-guard 判定 + 扫描配置 + apply() 告警）**、
  **主代理原生读图开关（主 agent deny read_image / 子代理不受影响 / 默认关）**、
  **Config 语义来源断言（CI 必须跑在真实 schemastery 上，不是 no-op 替身）**。

## 1.6 侦察脚本（只读，用来回答"现在到底装了什么"）

```bat
:: 主代理在某 profile 下实际拿到哪些工具（起假 LLM 跑一次 headless，打印 tools 名单）
node tests/_recon-tools.mjs
:: 极简模式是否还看得见读图子代理、有没有压缩工具（在沙箱里复刻 desktop 的 preset 组成）
node tests/_recon-minimal.mjs
node tests/_recon-tools.mjs --desktop   :: desktop profile 会被 CLI 拒绝（Electron 独占），属预期
```

> **已知局限**：沙箱 harness（`dsh --profile mmtest`）**不按 preset 组装 agent**——实测把 preset 的
> persona 设成哨兵也传不进系统提示词，`persistent-shell` 组的 pty 工具也不出现。所以凡是
> "preset 级"的行为（例如极简模式的压缩）都**无法在沙箱验证**，只能在 desktop app 里实测。
> `_recon-minimal.mjs` 里两个预设结果相同就是这个原因，不要据此下结论。

`_env.mjs` 是共用小件：把 `~/.dsh/.env` 里缺的 key 补进 `process.env`（不打印值）。

## 1.5 设置卡离线测试（不需要浏览器）

```bat
node tests/client-card.test.mjs      :: 卡片骨架：注册、编辑/保存/放弃、非法数字、保存失败
node tests/_card-mutex.test.mjs      :: 读图开关互斥：点开一个自动关掉另一个
```

`client-card.test.mjs` 用 `node:vm` 加载 `client.js`，假 React / 假 ctx / 假 `configForms`
验证：注册进 `plugins.bundle.config`（key = 包名）、开关与文本字段的编辑/保存/放弃、
非法数字拦截、保存失败反馈、页面渲染（9 个布尔开关，其中 6 个是工具开关）。

`_card-mutex.test.mjs` 同样在 `node:vm` 里跑 `client.js`，直接从
`slots.register` 取回卡片的 `inject()` 驱动表单模型，验证：

- 点开 `ask_glm` 时 `ask_qwen` 在 UI 上立即变关，保存时**先关旧、再开新**
  （配置写入末次生效，顺序反了会两个都开着）；
- 反向同理；关闭开关不牵连另一个；反复切换不留脏状态；放弃修改会一并复原；
- 无关开关（如 `qwen_draw`）不受影响。

## 2. 沙箱真实 harness 端到端（需要 dsh Desktop，仍然不联网、不花钱）

```bat
node --import ./tests/register.mjs ./tests/e2e-sandbox.mjs
```

脚本会自动：

1. 起假厂商 + 假 LLM（OpenAI 兼容 SSE）；
2. 写覆盖层 `_sandbox/overlay-mock-llm.yml`（把端点与默认模型指向假服务）；
3. 用 `dsh --profile mmtest --patch <overlay> ...` 跑三次 headless：
   - 场景 A / A2：agent → `qwen_draw` → 假 DashScope → 产物落盘；
     两次运行之间校验沙箱 `storages/mm_media_ledger.json` 的记录数必须增长，
     以证明宿主 storageDomain 账本可写入、可重新打开（而不是退回 JSON 回退）；
   - 场景 B：agent → `ask_glm`（spawn 子代理）→ 读图结论回传。

前置（一次性）：用 dsh 自带 CLI 建沙箱 profile 并装入本包（**只动 `_sandbox/dshhome`**）。
路径请按自己的安装位置替换（脚本会自动探测，这里只是手工步骤的示例）：

```bat
:: 先把 DSH_APP / DSH_CLI 设成你的实际路径（见第 0 节）
set DSH_HOME=%CD%\_sandbox\dshhome
set PATH=%CD%\_sandbox\bin;%PATH%
set ELECTRON_RUN_AS_NODE=1

"%DSH_APP%" "%DSH_CLI%" mmtest --from-default-profile headless --dump-config
"%DSH_APP%" "%DSH_CLI%" plugin --profile mmtest add "%CD%"
```

`_sandbox/bin/pnpm.cmd` 是给 `dsh plugin` 找 pnpm 用的 shim（指向 DSH 自带的
`resources/runtime/pnpm/bin/pnpm.cjs`）；`_sandbox/dshhome/profiles/mmtest/` 是本次
试运行的沙箱 profile，可整目录删除。

## 2.5 健康探测 e2e（打真网络，不产生计费调用）

```bat
node tests/e2e-health-probe.mjs
```

验证 `media_report(action=health)` 的探测结论是**真的**（而不是只检查 key 格式）：

- **负例（任何机器都能跑，不需要 key）**：拿一个必然无效的凭据打真实端点，
  探测必须报「鉴权失败」（`AUTH`），**绝不能报健康**；端点不可达必须归为 `UNAVAILABLE`；
- **正例（有 key 才跑）**：真实 key 必须被判为健康。

只用公开端点 + 无效凭据，**不产生任何计费调用**。没有 key 时正例走 `SKIPPED` 语义
（与其它 e2e 一致，`DSH_E2E_STRICT=1` 可把它变成硬失败）。

> 为什么单独写这个：`adapter.probe()` 是用户判断"我配好了吗"的唯一依据，
> 而这类"看起来在工作"的旁路最容易悄悄坏掉——此前它**没有任何测试覆盖**。

## 3. 真 key 实跑确证（会产生真实费用）

```bat
set DASHSCOPE_API_KEY=...
set ARK_API_KEY=...
node tests/confirm-fields.mjs          :: 只跑 1 张图
node tests/confirm-fields.mjs --ark    :: 追加 1 个 5 秒视频（真实计费）
```

输出 `tests/field-report-<时间戳>.md`：真实请求/响应字段对照、命中清单、落盘验证。
key 已打码、URL 已去掉签名参数；拿着报告修改 `core/fields.mjs`（唯一事实源）即可。

## 4. 只读探测与真实 GLM 链路（2026-10-12 实跑用）

```bat
:: 只读：三把 key / 型号 / 端点可用性，不产生生成费用
node tests/probe-apis.mjs
:: 只读：把"左红右蓝"测试图发给 GLM，验证真的看到图
node tests/vision-probe.mjs
:: 只读：把同一张图发给百炼 Qwen-VL（ask_qwen 的路由），验证真的看到图
node tests/vision-probe-qwen.mjs [模型...]
:: 真实 harness：假 brain + 真实 ask_glm 子代理（spawn → GLM）
node tests/e2e-real-glm.mjs
:: 真实 harness：两个读图子代理各跑一次 + 互斥验证（阶段 A 开 ask_glm 试探 ask_qwen，
::   阶段 B 开 ask_qwen 试探 ask_glm，两次试探都应被 guard 拒绝）
node tests/e2e-readers.mjs
:: 真实错误映射 + 工具开关（不创建任务、不花钱）：
::   A 无效 DashScope key → AUTH；B 开关打开 + Ark 无模型权限 → BAD_REQUEST；
::   C seedance 默认关闭 → 清单/提示词都没有它，幻觉调用被 guard 拒绝；
::   D ask_glm 关闭（官方 tool-subagent 注册的工具）→ 同样清单隐藏 + 幻觉调用被拒
node tests/e2e-real-errors.mjs
```

> key 解析：这些脚本按 `DASHSCOPE_API_KEY` 等名字读环境变量，进程里没有时会自动补读
> `~/.dsh/.env`（与 dsh 启动时加载的是同一份），不会打印 key 本身。
> `e2e-readers.mjs` 需要 `dsh` CLI：默认找安装目录里的 `app.asar` 入口，找不到可用
> `DSH_CLI=<...>/lib/bin.js` 指定。

实跑结论（2026-10-12）：
- 智谱 `glm-4.6v-flash` 持续 429；`glm-4.6v` / `glm-4.5v` / `glm-4v-flash` 可用且读图正确，
  插件已钉 `glm-4.6v`；
- DashScope：有效 key（国内站）**不支持异步调用**（403），但 `qwen-image-3.0` 同步接口完全可用：
  `POST /api/v1/services/aigc/multimodal-generation/generation`，3~4s 返回
  `output.choices[].message.content[].image`（签名 URL，即取即下），字段已全部确证；
  插件实现 `dashscopeImageMode: auto`（qwen-image → sync，其余 → async）；
- Ark：key 鉴权通过，但 `seedance-2.0` 与常见豆包模型/接入点全部 `InvalidEndpointOrModel.NotFound`
  （账号未开通或需要 `ep-...` 接入点 ID），仍未确证；
- 新增真跑脚本：`e2e-real-qwen.mjs`（真实同步制图全链路）、`e2e-real-glm.mjs`（真实读图）、
  `e2e-real-errors.mjs`（真实 401/404 映射 + 工具开关 A/B/C）；
- 工具开关：默认关闭 `seedance_video` 时，模型工具清单里没有它、调用被 guard 拒绝；
  打开后出现在清单里并真实请求 Ark（404 映射）——真实 harness 验证通过。

## 5. 体积报告（每请求固定成本）

```bat
:: 本地投影：工具 schema + 提示词段落的字符数（不需要 dsh）
node --import ./tests/register.mjs ./tests/size-report.mjs
:: 真实 harness：跑一次 headless（假 LLM），读模型实际收到的 tools/system prompt 体积，收到请求即杀进程
node tests/size-report-real.mjs [--no-bg]
```

2026-10-12 优化结果：固定成本 2447 → **1771 字符（−27.6%）**；
`ask_glm`（真实 harness）937 → **788 字符**（关闭 `run_in_background`）。
2026-10-13 加环境红线后：提示词段落 108 → 270 字符，固定成本随之 **1934 字符**
（`size-report.mjs` 实测输出，勿手写）。

## e2e 的"跳过"语义（2026-10-13 改）

以前缺 key / 缺沙箱 profile 时，e2e 打印一行"跳过：…"再 `process.exit(0)`——
**对 CI 而言与通过完全一样**，于是 4/5 个 e2e 在无 key 机器上静默空转。
现在统一走 `_env.mjs` 的 `skipE2e()`：

- 默认打印 `SKIPPED: <原因>` 并以 0 退出（保留本地手工跑的便利）；
- 设 `DSH_E2E_STRICT=1` 则以 **78** 退出，任何"我必须确认这些真的跑过"的场合都该用它；
- `e2e-readers.mjs` 另分阶段统计：只要有阶段被跳过就报 `PARTIAL` 而不是 `OK`。

## 清理

`_sandbox/`、`tests/field-report-*.md`、`tests/_*.mjs`（排障脚本）都可直接删。
