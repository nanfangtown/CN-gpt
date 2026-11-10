# minimax 签到修复记录（dsh-minimax-connect 0.3.0）

诊断时间：2026-11-10。插件装在 `%USERPROFILE%\.dsh\plugins\dsh-minimax-connect`（link 安装），
下面三处改动直接改在**已安装副本**里。**更新插件（重新下载覆盖）会丢，照这份记录重打即可。**

## 症状

设置 → MiniMax 卡片里的签到按钮是灰的（「今日已签到」/「暂不可签」），点了没反应。

## 根因

不是接口坏了，是**状态映射把按钮锁死**：

1. `signin/status` 返回的今天那行是 `status: 3`；插件用 `claimedToday = status === 3`、
   `claimableToday = status === 1`。于是只要不是恰好 `status 1`，按钮就永远 disabled。
2. 更关键的是：**今天的分早就被 MiniMax Code 桌面客户端自动签掉了**（实测 12:33:14 入账 400，
   有效期 30 天），插件本身没有任何自动签到逻辑。桌面客户端会在它自己启动/活跃时签到，
   所以用户打开 DSH 时经常已经是 `status 3` —— 按钮永远是灰的，看起来就像「无法签到」。
3. 重复调 `POST /signin/claim` 服务端返回 200 + `claim_result: 2`，积分 0 变化 →
   `2` = 今日已签到。

## 改动

### 1. `lib/index.js` — 状态映射容错（约 1150 行）

```js
// 之前
claimedToday: today?.status === 3,
claimableToday: today?.status === 1,
// 之后
claimedToday: today?.status === 3,
claimableToday: today === undefined ? true : today.status !== 3,
todayStatus: today?.status ?? null,
```

### 2. `lib/client.js` — 卡片按钮永远可点（`Overview`）

```js
// 之前：const canClaim = Boolean(s && s.claimableToday && !s.claimedToday && !busy);
const canClaim = !busy;

// 按钮文案
children: busy ? "签到中…" : (s && s.claimedToday ? "已签到 · 重新核对" : "立即签到"),

// note 配色：之前只认「成功」，现在「已签到」也算 ok
className: /成功|已签到/.test(note) ? "mm-ok" : "mm-err"
```

`claim()` 改成**按积分变化说实话**（不再默认「签到成功」）：

```js
const before = await getJson(STATUS).then((x) => x?.points?.remaining).catch(() => undefined);
const r = await postJson(CLAIM, {});
const s = await getJson(STATUS); setData(s);
if (r.ok !== true) { setNote(`签到失败：${r.error ?? "未知原因"}`); return; }
const gain = (数字都有时) s.points.remaining - before;   // 否则 0
const cr = r.data?.claim_result != null ? `，claim_result=${r.data.claim_result}` : "";
setNote(gain > 0.001 ? `签到成功，+${gain.toFixed(2)} 分${cr}` : `今日已签到，无新增积分${cr}`);
```

### 3. `lib/index.js` — 面板 HTML（`GET /panel`）同步

按钮不再输出 `<button disabled>`，改为永远有 `id="ck"`；点击后同样比对 before/after 积分，
显示「成功 +X」或「今日已签到，无新增（claim_result=N）」。

## 验证（2026-11-10 实测）

```
/status      → signedIn true, claimedToday true, claimableToday false, todayStatus 3, todayPoints 400
POST claim   → 200, claim_result 2, 积分 3112.56 → 3112.56（delta 0.00）
/panel       → 含「已签到 · 重新核对」，无 <button disabled>
```

点按钮的预期结果：`今日已签到，无新增积分，claim_result=2`。
明天 00:00 之后（未签时）：按钮变「立即签到」，点下去若真入账会显示 `签到成功，+400.00 分`。

## 重打补丁

三处都已在文件里；插件更新后按上面的 before/after 再改一遍，然后
`plugin_manager set_plugin include:llm-minimax false → true` 重载即可。
