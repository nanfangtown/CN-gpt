# 读图路由：让子代理用得上识图工具（B）与"通用子代理不许自己读图"（C）

- 日期：2026-10-16
- 起点：用户在繁重任务（主代理派多个子代理）里观察到"原生子代理仍会自己读图"，要求确认并实现 B、C。
- 基线：`run.mjs` 110 通过；本轮结束 **115 通过 / 0 失败**，变异 **20 个注入 / 20 个抓到**。

---

## 一、先确认事实（实测，不是读代码猜）

用两个真实探测子代理拿到原始证据：

| 探测 | 结果 |
| --- | --- |
| 原生子代理的工具清单 | 32 项，**含 `read_image`、`ask_glm`、`subagent`、`subagent_fork`**（不含 `ask_qwen`，因为 `enableAskQwen: false`） |
| 让它真的读一张图 | 返回**真实图像内容块**（`image/png 1395x771`、sha256、归一化副本路径），不是占位符 |
| 让它调 `ask_glm` | `Error: subagent depth 2 exceeds maxDepth 1`（工具在、能发起，但被深度上限拒死） |

代码侧一致：三条守卫**全都只针对主代理**（`read_image` 掩码只对非子代理下、
`read` 拦图只对主代理、委派审计只对主代理），所以"子代理自己读图"不是漏网，
而是当时配置下**唯一可用**的看图途径。

---

## 二、B：让子代理调得动读图员（`maxDepth: 1 → 2`）

宿主语义是"**子 agent 深度 ≤ maxDepth**"（数值型 `maxDepth` 要求提供方具备 `depthLimit` 能力，
`spawn` 有；宿主另有 `subagent.maxDepth` 设置、初始值 1）。原值 1 的后果：
主代理调读图员（深度 1 ✅）、**已委派的子代理调读图员（深度 2 ❌）**。

改动：两行读图员（`tool-subagent-glm` / `tool-subagent-qwen`）都改成 `maxDepth: 2`。
回归断言钉在 `tests/run.mjs`：**自带 patch 里的每个读图行都必须 `maxDepth ≥ 2`**。

**实测确认已生效**：同一台机器上，探测子代理调 `ask_glm` 现在返回 `1+1=2`
（此前是 `subagent depth 2 exceeds maxDepth 1`）。

---

## 三、C：屏蔽"通用子代理"的原生读图（新开关，默认关）

新增 `blockSubagentNativeVision`（默认 `false` = 完全保持旧行为，不偷偷改语义）：

| 值 | 行为 |
|---|---|
| `false` | 通用子代理保留 `read_image` |
| `true` | 除**读图员**外，子代理不再有 `read_image`，看图必须走 `ask_glm` / `ask_qwen` |

**读图员怎么被认出来（本开关最危险的地方：判错就把读图员一起弄瞎）**
豁免名单**不硬编码**，而是从契约文件里读（`core/reader-guard.mjs` 的 `inspectReaderRoutes()`）：
任何"`toolFilter.allow` 里放了 `read_image`"的 `dsh-tool-subagent` 行都算读图行，
取它的 `agentOptions.provider` / `model` 进白名单；命中 provider **或** model 任一个即豁免。
一处契约行都扫不到时，插件**放弃对子代理的屏蔽**（fail-open）并告警 —— 宁可少屏蔽一次，
也不赌"读图员是不是被我弄瞎了"。

**判定可见**：`media_report(action=health)` 现在报出屏蔽状态、豁免名单、契约声明处数、
当前挂掩码 agent 数，以及**最近 5 次判定快照**（主/子、是否读图员、provider、model、结果）。

**测试过程中修掉的两个自身缺陷**（都由测试/变异抓到，已加回归）：
1. 只认写死的两个 row id → 自定义/改名的读图行认不出来（会把读图员一起屏蔽）；
2. 抠配置值时不排除注释 → 注释里那句"规划原文写 `maxDepth: 0`"被当成真实配置读出，
   启动自检误报"读图员 maxDepth < 2"。

---

## 四、顺带发现的真问题：重新装配会丢掩码（行为层必须有 guard 兜底）

**现场**：profile 写着 `blockMainAgentNativeVision: true`、装配产物 `cordis.yml` 里也是 `true`，
但**主代理仍然成功调用了 `read_image`**（实测读到了图，2026-10-16 18:2x）。

**根因**：`read_image` 的屏蔽是"按 agent 贴掩码"（`agent.ctx.tools.restrict`），
而掩码表只由 `agent/created` 填充、插件卸载时会被 `dispose`。于是**任何一次重新装配/热重载之后**，
早已存在的 agent 不会再触发 `agent/created`，掩码**永久丢失**；每秒对账也救不回来
（它只遍历表里已有的 agent）。同一个原因会让关闭的工具开关在既有会话的工具表里重新出现
（那六个有 guard 兜底，调用仍被拒，只是 schema 可见性失真）。

**对策**：新增一条**行为层兜底守卫**，在每次调用前判定 `read_image`（读实时配置、
与 agent 何时创建无关 → 重载后依然生效），文案直接指向可用的读图员。
判据与掩码同源，避免两处打架。掩码保留：让新会话**看不见**；guard 保证**调不动**。

---

## 五、验证

```text
node --import ./tests/register.mjs ./tests/run.mjs                     → 115 通过 / 0 失败（原 110 + 新增 5）
node --import ./tests/register.mjs ./tests/safety-invariants.test.mjs  → 12 通过 / 0 失败
node tests/client-card.test.mjs                                        → 全通过（含 15 开关 / zh-en 键闭合自检）
node tests/_card-mutex.test.mjs                                        → 8 / 0
node --import ./tests/register.mjs ./tests/verify-functionality.mjs    → 6 / 0（已扩到五条 guard）
node tests/_mutation-check.mjs                                         → 注入 20、抓到 20、漏网 0
```

新增变异（5 条，全部被抓）正好对应本轮 5 处修复：连读图员一起屏蔽 / 去掉兜底守卫 /
豁免名单只认 id / 抠值时不过滤注释 / 读图行 maxDepth 退回 1。

**运行时实测状态**：

- **B 已生效**：子代理调 `ask_glm` 成功（此前报 `depth 2 exceeds maxDepth 1`）。
- **C 尚未生效**：子代理仍能调用 `read_image` —— 运行中的插件实例是**改前的模块**
  （配置层的 `blockSubagentNativeVision: true` 已经进了 `cordis.yml`，但新逻辑要**代码重载**
  才装载）。重启 DSH 后即生效；生效后 `media_report(action=health)` 会打印判定快照，
  **先确认读图员显示为「读图员」再依赖它**。

---

## 六、重载后的运行时复验（用户要求"验证一下"）

插件已在 19:04 重新装配（`cordis.yml` 重建），以下全部是**实测**，不是推断：

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| C 生效 | ✅ | 探测子代理汇报：**`read_image` 不在它的工具清单**（对比：修复前"在"，且能真读到图） |
| B 生效 | ✅ | 同一子代理调 `ask_glm(prompt="1+1=?")` 返回 **`1+1=2`**（对比：修复前 `Error: subagent depth 2 exceeds maxDepth 1`） |
| 主代理仍被屏蔽 | ✅ | 主代理调 `read_image` 被拒，文案是**本插件的守卫文案**：`原生读图（read_image）已被 gpt-CN 屏蔽（对象：主代理）…` —— 证明**行为层兜底守卫在跑**（不是"工具不存在"） |
| 掩码健康 | ✅ | `media_report(health)`：`当前挂掩码 agent：2/2`（上次观察到的"重载丢掩码"这次没复现） |
| 读图员豁免名单 | ✅ | `glm, qwen-vl`（来自 4 处契约声明，即两份文件 × 两行） |
| 判定过程可查 | ✅ | health 报告里出现"最近的原生读图判定"快照（当前两条都是主代理 → 已屏蔽） |
| 真实识图链路 | ✅ | 委派出去的子代理用 `ask_glm` 真的读出了图（并自行交叉核验、指出读图员一处品牌误判） |

### 复验中发现的**生产级缺陷**：两条守卫读错了入参字段名

- harness 契约：`ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`，
  而 `ToolExecutionInput` 的入参字段是 **`arguments`**（**没有 `args`**）；
- 插件从 2026-10-13 起读的是 **`exec.args`** → **第三条守卫（`read` 读图片指路）与
  第四条守卫（委派读图审计）在生产里永远拿到 `undefined`，等于从未生效**；
- 现场双重证据：
  1. 主代理 `read` 一张真实 `.jpg` 得到的是 harness 原生的 `cannot read "…jpg": binary file`，
     而不是插件的指路文案；
  2. 主代理发起一次明显的读图委派（含 `.png` 路径 + "看看这张图"）**没有被拦**，子代理照常执行；
- 根因：fixtures 手搓的执行对象是 `{ name, args, agent }` —— **测试契约与真实契约不一致**，
  所以 4 天里所有套件全绿。

**修复**：`argsOf(exec) = exec?.arguments ?? exec?.args`，两处调用点统一走它。
**回归**：新用例只用 harness 形状 `{ name, arguments, agent }` 构造执行对象
（同时覆盖"旧形态仍可用"与"入参缺失不炸"）；变异测试新增一条（改回只读 `args` 必须被抓住）。
**进程内对照**（修复后）：

```text
图片路径守卫 · harness 真实字段 arguments → ⛔ 拦下（指向读图子代理）
图片路径守卫 · 旧字段 args              → ⛔ 拦下
视觉委派守卫 · harness 真实字段 arguments → ⛔ 拦下（"已拦截…"）
视觉委派守卫 · 旧字段 args              → ⛔ 拦下
```

**当前状态**：`argsOf` 修复**尚未在当前进程生效**（复测仍拿到原生 `binary file`），
需要**再一次重载/重启**；C 与 B 已生效。

### 本轮测试基线

```text
run.mjs 116 / 0（新增"arguments 字段名"用例）｜safety-invariants 12 / 0
client-card 全通过｜card-mutex 8 / 0｜verify-functionality 6 / 0
变异测试：注入 21、抓到 21、漏网 0（新增"守卫改回只读 args"）
```

---

## 七、重启后的最终复验（19:2x，全部实测）

用户在装载 `argsOf` 修复后重启，逐项复验：

| 验收项 | 结果 | 原始证据 |
| --- | --- | --- |
| C 生效（子代理） | ✅ | 探测子代理：**`read_image` 不在工具清单**，第 2 步"无法调用" |
| B 生效（子代理调读图员） | ✅ | 同一子代理 `ask_glm` 返回**真实画面描述**：*"这张位图的主色调是浅色/白色…右侧的深色侧边栏虽然对比明显但面积较小…"* |
| 主代理屏蔽 | ✅ | 主代理 `read_image` → `原生读图（read_image）已被 gpt-CN 屏蔽（对象：主代理）…` |
| **`argsOf` 修复（第三条守卫）** | ✅ | 主代理 `read` 一张真实 `.jpg` → 从"原生 `binary file`"变成 **`这是图片文件，通用 read 工具读不了二进制内容…看图请改用读图子代理：ask_glm…`** |
| **`argsOf` 修复（第四条守卫）** | ✅ | 主代理发起读图委派 → **被拦**：`已拦截：不要为"读图/看图"去委派 subagent…请直接调用 ask_glm…`（且**未真的创建子代理**，零额外开销） |
| **C 最危险的一环：读图员豁免** | ✅ | health 判定快照：`子代理（读图员） provider=glm model=glm-4.6v → 保留 read_image`，同时 `子代理 provider=deepseek-account model=deepseek-flash → 已屏蔽` |
| 掩码健康 | ✅ | `当前挂掩码 agent：1/1`（重启后新 agent 立刻贴掩码） |

> 最后一行尤其关键：它证明"从契约文件读路由 → 用 `agent.options.provider`/`model` 认读图员"
> 这条最危险的假设**在真实 harness 上成立**（此前只有单测覆盖）。C 可以放心开着。

**新暴露的代价（未改，供决策）**：第四条守卫现在真的生效，而它是**按措辞**审计的 ——
任何委派文本里出现"读图 / 看图"就会被拦，**哪怕意图与识图无关**
（实测：本次探测的提示词因为写了"读图员"三个字，被连拦两次）。
可选的窄化改法是"匹配前先剥掉插件自己的词表（`读图员` / `读图子代理`）"，
但那需要再重启一次才生效，故未在本轮动手。

---

## 八、效率：委派审计在 C 打开时让位（实测误伤 6/10 → 0/10）

用户的追问很准："任何委派文本里出现'读图/看图'都会被拦，会不会导致效率变低？"
先量化，再决定。

**量化误伤**（10 条真实的、与识图无关的委派文本）：

| 委派文本 | C 关 | C 开 |
| --- | --- | --- |
| 帮我写一段关于**读图**路由的设计文档 | ⛔ | ✅ |
| 把 README 里所有"**读图员**"改成"识图子代理" | ⛔ | ✅ |
| 把 `assets/logo.png` 转成 webp | ⛔ | ✅ |
| 把 `D:\shots\old.png` 从 git 里删掉 | ⛔ | ✅ |
| 把 `D:\shots\a.png` 分辨率改成 512x512 | ⛔ | ✅ |
| 这段报错里的**图中**路径怎么拼出来的 | ⛔ | ✅ |
| 普通重构 / 排查 / 查文档 / 分析 README | ✅ | ✅ |
| **误伤率** | **6/10** | **0/10** |

**代价不对称**：真·视觉委派被放过 → 子代理自己调读图员（多一跳，结果正确且仍受契约约束）；
误伤 → 一次废调用 + 一段**永久进上下文、每轮重发**的错误文案 + 可能打断多步计划。
（误伤不产生 API 费用：被拦时子代理根本没创建。）

**根因是功能重叠，不是词表太宽**：C 打开后通用子代理**没有 `read_image`**，
想看懂图只能调 `ask_glm`/`ask_qwen` —— 正是审计想促成的路由。**绕不过去了，拦措辞就是纯开销。**

**改动**：guard 里一行 `if (subagentVisionBlocked()) return undefined`。
C 关时行为**完全不变**（那时它是唯一防线，误伤是必要代价）。
**回归**：`tests/run.mjs` 新增用例（C 开：6 条误伤文本全部放行、视觉委派也放行；C 关：仍拦）
+ 一条变异（删掉这一行必须被抓住）。

**基线**：`run.mjs` **117 / 0**、safety 12 / 0、client-card 全通过、card-mutex 8 / 0、
verify 6 / 0、变异 **22 注入 / 22 抓到**。

**重启后复验（已生效，全部实测）**：

| 验收项 | 结果 | 原始证据 |
| --- | --- | --- |
| 审计让位生效 | ✅ | 一条**含"读图路由"字样、但与识图无关**的委派**正常启动**（改动前同样的措辞被连拦两次） |
| C 仍生效 | ✅ | 该子代理自报：`read_image` **不在**工具清单，"若需看图只能走 ask_glm / ask_qwen" |
| 主代理仍屏蔽 | ✅ | 主代理 `read_image` → `原生读图（read_image）已被 gpt-CN 屏蔽（对象：主代理）…` |
| `argsOf` 修复仍在 | ✅ | 主代理 `read` 一张真实 `.jpg` → 仍返回插件指路文案（不是 harness 原生 `binary file`） |
| 屏蔽/豁免状态 | ✅ | health：`主代理 ⛔ / 通用子代理 ⛔ / 豁免名单 glm, qwen-vl（4 处契约声明）/ 挂掩码 2/2`；判定快照里主代理与通用子代理都是"已屏蔽 read_image" |
| 提示词段落 | ✅（附带） | 子代理能准确复述路由策略（"把所有看图/图像识别类任务统一路由给专用模型，而不是猜图或绕道"） |

---

## 九、prompt 开销实测 + 五项整改（2026-10-16 第二轮）

### 实测方法
解开会话日志（`session.v4.jsonl.zstd`，**多 zstd 帧拼接**，Node 内置 `zstdDecompressSync` 逐帧解），
取 `system/message`（系统提示原文）与 `request/header.tools`（**该 agent 真实的工具表**）与
`assistant/message.usage`。样本：本工作区 147 个会话。

### 实测结果（每请求固定前缀）

| 类型 | 系统提示 | 工具数 | 工具定义 | 插件占其中 |
| --- | --- | --- | --- | --- |
| 主代理 | 8565 B（均值） | 25–35 | 23–32 KB | 段落 + 1.0–2.6 KB 工具 |
| 通用子代理 | 7680 B | 32–35 | ~30–32 KB | 段落 + 1.9–2.7 KB 工具 |
| 读图员 | 6297 B | **3** | 2.2 KB | 段落 710 B（**占其 prompt 11.9%**） |

另外：一条会话的 `usage` 显示固定前缀几乎全走 cache-read（`cacheReadTokens 514816` vs
`inputTokens 170`）⇒ 边际**金钱**成本低，但每请求重发、占窗口、加延迟；
**每个新子代理的首个请求是冷前缀（全价）**。

### 五项整改（全部已实现 + 测试）

| # | 事项 | 改动 | 验证 |
| --- | --- | --- | --- |
| 1 | **读图员契约运行时兜底** | 新增第六条 guard：读图员只能调 `read_image`；配置侧给两行读图员补 `deny`（27 项） | 新用例 2 条（含"读图员调 ops_bash/subagent 必须被拒"）+ 3 条变异 |
| 2 | **提示词段落瘦身** | 去掉身份声明（"你是主创兼工程师…"），只留 3 条策略；710 B → **约 555 B（206 字符）** | 字节预算断言 ≤ 560 B + "不得再出现身份声明"断言 |
| 3 | **报告紧凑化** | `media_report` 新增 `verbose`；health **2667 → 2092 B**、cost **895 → 584 B**、样板 **274 → 92 B**；**告警一个不省** | 体积预算用例（含"verbose 必须更长""掩码说明只在 verbose""告警仍在"） |
| 4 | **窄工具面委派行** | 新增 `subagent_code`（6 个工具）/ `subagent_research`（3 个），段落里点名它们 | patch 用例：allow ≤ 6 个、不含 `read_image`、必含关键工具 |
| 5 | **toolFilter 语义定位** | 判别实验已布好：读图员行同时给 `allow` + `deny` ⇒ 重启后量"工具数是 1 还是 3"就能判定 allow 语义 | 待重启后实测（脚本已就绪） |

**基线**：`run.mjs` **120 / 0**、safety 12 / 0、client-card 全通过、card-mutex 8 / 0、
verify 6 / 0、**变异 26 注入 / 26 抓到 / 0 漏网**。
（变异里 4 条专门盯本轮：去掉读图员守卫、删 deny、放宽窄委派、把报告改回 verbose。）

### 重启后复验（已完成，含一次真实的翻车与修复）

**⚠ 翻车**：第一次重启后，我写的 `toolFilter` 让**读图链路整个打挂**——`ask_glm` 每次 spawn 抛错：

```
Error: tools.restrict() cannot name reserved PTC mode presentation transport "run_code"
Error: tools.restrict() names unknown global tool "ops_bash"; known global tools: ask_glm, ask_qwen, …, write
```

原因是 **`toolFilter` 只能引用「全局工具」**，而我写了 `run_code`（保留名）与 `ops_bash`
（按 scope 注入、不在全局表）。修法：把这两个名字从 allow/deny 删掉，加一条**测试不变量**
（allow/deny 不得出现 `ops_bash` / `subagent` / `run_code` / `bash`）。
写一行注释到 profile patch 触发自动重装配（实测 **4 秒**后 `cordis.yml` 重建），读图链路随即恢复。

**复验结果（全部实测）**：

| 验收项 | 结果 | 原始证据 |
| --- | --- | --- |
| 读图链路恢复 | ✅ | `ask_glm` 读鲸鱼图标 → "主色调是蓝色…蓝色鲸鱼图标，背景为白色" |
| **读图员契约守卫生效** | ✅ | 读图员自述工具表 `ops_bash, read_image, subagent`；调 `ops_bash` 得到 **`读图员只被允许 read_image：ops_bash 不在契约里，已拒绝。`** |
| 读图员工具表 = 3 个 | ✅（符合修正后的理解） | `allow` 是**全局白名单 ∪ {ops_bash, subagent}**，后两个过滤不掉 |
| 窄委派行可用 | ✅ | `subagent_code` 报 7 个工具；`subagent_research` 报 5 个 |
| 段落瘦身生效 | ✅ | 主代理与新建子代理的 prompt 均含`【媒体分工】/【读图路由】/【窄委派】`，**不再含**`你是主创兼工程师` |
| 报告紧凑模式生效 | ✅ | health 输出 `读图路由：ask_glm→glm ✅ ｜ ask_qwen→qwen-vl ✅`、`账本/注册表后端：storage、storage`、原生读图一行结论；能力清单已移入 verbose |

**实测收益（会话日志里的工具定义字节）**：

| agent | 工具数 | 工具定义 |
| --- | --- | --- |
| 主代理 | 35 | 32354 B |
| 通用子代理 | 35 | 32507 B |
| **subagent_code** | 7 | **5716 B**（−82%） |
| **subagent_research** | 5 | **2950 B**（−91%） |
| 读图员 | 3 | 2332 B |

**修正后的结论（回答第 5 项）**：`toolFilter.allow` = **全局工具白名单 ∪ {`ops_bash`, `subagent`}**；
`deny` 同约束（只能写全局名）。**非全局的 `ops_bash` 与 `subagent` 无法用配置过滤**，
所以"读图员只能看图"这条契约**最终只能靠运行时 guard 保证** —— 这正是本轮加上第六条守卫的
直接原因，也再次印证：**配置能说的和运行时能保证的，是两件事**。

---

## 十一、子代理能不能自己生成？——能，且**默认允许**（2026-10-16 第三轮）

**问题**：子代理（含读图员、原生子代理）能不能自己生图？会不会变成成本黑洞？

**实测回答**：

| 类型 | 手里有 `qwen_draw` 的会话比例 |
| --- | --- |
| 读图员 | **0 / 59**（`allow: [read_image]` 白名单挡住了） |
| 通用/原生子代理 | **19 / 28**（**能**，而且默认配置下制图**免确认**：`noConfirmUnderCNY=1` > 一批最多 ¥0.72） |

**策略决定（用户明确）**：**不禁止** —— 繁重任务里"只让主代理发指令制图"效率太低；
普通任务基本用不到子代理出图。

**改为补"可见性 + 上限"**（不牺牲效率）：

1. **会话树汇总**：`agent/created` 时按 `session.header.parentSession` 记边
   （实测子会话确实带 `parentSession` / `origin: subagent` / `delegationDepth: 1`），
   `cost(session)` 汇总自己 + 全部后代会话，标题写"含 N 个子代理会话"；
2. **会话累计上限覆盖会话树**：`sessionSpentOrThrow({ sessionIds })`，
   `qwen_draw` / `seedance_video` 传入会话树 ⇒ 把花费挪进子会话**绕不过**上限；
3. **刹车开关** `blockSubagentSpend`（默认 `false` = 允许；`true` = 只允许主代理）。

**待办（需要一次重启生效）**：本轮 6 个文件是插件侧代码，重启后才生效；
生效后要复验：① `cost(session)` 出现"含 N 个子代理会话"；② 子代理仍能直接出图（默认允许）。

**基线**：`run.mjs` **123 / 0**、变异 **30 注入 / 30 抓到 / 0 漏网**。

---

## 十二、回滚

- C：把 profile 用户层 `cordis.patch.yml` 的 `blockSubagentNativeVision` 改回 `false`（一行）。
- B：两行读图员 `maxDepth` 改回 `1`（会让子代理再次调不动读图员）。
- `argsOf`：改回 `exec?.args`（会让两条守卫重新变成死代码——不要这么做，只作为回滚说明）。
- 「审计让位」：删掉 guard 里那行 `if (subagentVisionBlocked()) return undefined`
  （会恢复 6/10 误伤，但 C 关时本来就是这个行为）。
- 「读图员契约守卫」：删掉第六条 guard（会恢复"读图员能跑 shell"的实测漏洞——不要这么做）。
- 「窄委派行」：删掉 `tool-subagent-code` / `tool-subagent-research` 两行（段落里的【窄委派】那行也要一起删）。
- 「子代理生成」：要禁止就把 `blockSubagentSpend` 设为 `true`（一行配置，重启生效）；
  要退回"看不见子代理花费"的状态则删掉 `sessionIdsForSpend` 的注入（不建议）。
- 本轮未提交（与 10-16 另一轮未提交改动共存于工作区）。
