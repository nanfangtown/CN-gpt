# 安全策略

## 支持范围

| 版本 | 状态 |
| --- | --- |
| `0.4.x`（当前） | 维护中 |

本项目是**本地运行的 DSH 插件**：没有自建服务端、不收集遥测。
所有外部请求都发往你在配置里显式启用的模型厂商，且只携带该次调用所需的输入
（读图时的图片、制图/出片时的提示词与参考图）：阿里云百炼（DashScope / Qwen-VL）、
智谱（GLM）、火山方舟（Ark / Seedance）、MiniMax（海螺 / H3-Image）。
`mm-minimax` 行还会读取本机 MiniMax Code 的 OAuth 登录态并向其服务端续期 token（见下节）。
纯文字截图走 Windows 自带 OCR，完全不出网。

## 密钥怎么处理

- 密钥**只**从这三处解析（后者依次兜底）：配置卡里的字面值 → 凭据服务
  （`~/.dsh/.credentials.yaml`）→ 环境变量 / `~/.dsh/.env`。
- **仓库里永远没有密钥**：`.env`、`.credentials*` 已加入 `.gitignore`；
  测试全部用桩，不读真实 key。
- 密钥**不进日志、不进错误消息、不进健康报表**：`media_report(health)` 只回答
  "是否已配置 / 来自哪里 / 能否写入"，从不返回值本身。
- 字面值方式会把 key 明文写进 profile 配置，**不推荐**；优先用环境变量或凭据服务。
- `mm-minimax` 行**不新增密钥字面值**：它读取 MiniMax Code 的
  `auth/prod/<region>/mcode-public/auth.json` 里的 accessToken，并按其跨进程锁串行续期
  refresh_token；续期结果原子写回该凭据文件（与 MiniMax Code 自身行为一致）。
  插件不保存密码、不把 token 写进日志或健康报表。停用 `mm-minimax` 行即可完全断开这条链路。

## 花费安全（本项目的核心风险面）

所有付费调用（出图 / 出片）在提交前都要过同一道收口 `core/spend-guard.mjs`：

1. **未计价 = 拒绝**。单价表查不到、单价为 `0`、单价为负，一律 fail-closed；
   `confirm_estimate` 自报金额在这条路径上**不作数**（2026-10-15 的洞）。
2. **单次上限**（`videoCostLimitCNY`，默认 10 元）。
3. **会话累计上限**（`videoSessionCostLimitCNY`，默认 30 元），含子代理会话树。
4. **复述金额**：必须传回精确到分的预估金额才提交（小额可免，默认阈值 1 元）。
5. **提交不重试**：只有"连接未建立"才允许重发一次，避免重复下单。
6. **提交后失败仍记账**：超时 / 取消 / 下载失败都会按 taskId 补记，同一任务只记一次。

已知边界（如实说明）：

- 单价表是可编辑配置。把它改低会低报金额——**代码拦不住用户的错价**，
  只拦得住"缺档位"（缺档位时按未计价拒绝）。请按厂商官网核对后填写。
- 报表金额是**估算**，不是账单；厂商的档位、优惠与免费额度无法准确建模。
- 视频产物 URL 有时效（百炼 30 天 / 方舟较短），插件拿到终态立即下载，不做长期托管。

## 报告漏洞

请**不要**开 public issue 贴密钥、账单明细、会话日志或私人路径。优先用 GitHub 的
**Private vulnerability reporting**（
[Security → Advisories → New draft security advisory](https://github.com/nanfangtown/CN-gpt/security/advisories/new)，
发布前需在仓库设置里打开）。

如果无法使用私密报告，请只发一句"需要私下沟通的安全问题"到维护者公开的联系方式，
不要附任何复现中的敏感值。收到后会在确认影响范围后修复，并在 `CHANGELOG.md` / commit 里说明；
修复前不会公开细节。

## 依赖与供应链

- `peerDependencies` 由 DSH 运行时提供；`devDependencies` 只用于测试。
- 无 postinstall 脚本、无自动下载二进制。
- 生成物只写你配置的目录（默认 `gen/`、`gen/video/`）；本地文件读取受
  `core/deliver.mjs` 的 containment 断言约束，页面守卫另有路径检查。
