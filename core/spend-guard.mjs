/**
 * 付费调用的收口闸门（2026-10-15 加，源于一次真实事故）。
 *
 * ## 事故
 * 为探测 `duration` 的合法取值范围，调用方逐个试 `2,3,4,…,30`，用"返回 200 即通过"
 * 当判据。但 200 的真实含义是**任务已创建、已开始计费**——22 个任务、账单 ¥195.97。
 *
 * ## 根因（不是"参数算错"，而是设计缺失）
 * 付费接口的提交路径上**没有任何强制意图声明**：
 *   - 调用方无法在提交前得知"这次要花多少钱"；
 *   - 也没有任何机制要求它为"花钱"这件事表态；
 *   - 于是"探测参数"和"下单购买"在接口层面**长得一模一样**。
 *
 * ## 对策：三层，逐级升级授权
 *   1. **单次上限**：预估超 `videoCostLimitCNY` → 拒绝；
 *   2. **会话累计上限**：已花 + 本次超 `videoSessionCostLimitCNY` → 拒绝；
 *   3. **显式确认**：必须传回**精确到分的预估金额**才放行。
 *
 * 第 3 层是关键的**行为改变**：想花钱就必须先说出要花多少——
 * "无意识的循环试参"因此不可能再发生，因为它每次都得先算钱、再复述金额。
 * 这正好是事故里缺失的那一步。
 *
 * ## 同日修订（2026-10-15 第二轮）：未计价路径上的一个洞
 * 初版在"金额算不出来"（未计价模型）时，只要 `confirm_estimate` 是个数字就放行。
 * 于是"闸门"可以被一句话绕过：调用方自己报 `confirm_estimate: 1` 即可，
 * 单次/会话上限也一并跳过 —— 想让闸门放行，只要自己编个价格。
 * 现在未计价一律 **fail-closed**：默认拒绝（`allowUnpricedSpend=false`），
 * 只有用户打开该开关 + 调用方带 `confirm_unpriced=true` 才放行；数字在此不作数。
 */

/** 金额比较用的容差（元）。浮点乘法会引入 1e-15 级误差，不能让"确认 6.08"被 6.079999 卡住。 */
const MONEY_EPSILON = 0.01

/**
 * 把数值裁成"分"精度（两位小数的数字），用于让双方对同一个数达成一致。
 * @param {number} value - 原始金额。
 * @returns {number} 保留两位小数的数值。
 */
export function toCents(value) {
  return Math.round(Number(value) * 100) / 100
}

/**
 * 计算这次付费调用要花多少钱。
 *
 * ⚠ 判据是"**正价**"，不是"非 null"。2026-10-15 修：
 * 早先只判 null / 非有限数，于是 `unitPrice: 0` 会被算成"预估 ¥0.00"——
 * 一个 30 秒的出片被报价 0 元，而下面三层闸门（单次上限 / 会话上限 / 强制确认）
 * **会全部放行**：0 既不超任何上限，也能被 `confirm_estimate=0` 精确复述。
 * 等于"单价表里写一个 0，就把整道花钱闸门关掉"。
 * 0 不是"未知"（未知写 null），0 是"宣称免费"——所以必须走未计价分支。
 *
 * @param {object} args - { model, duration, unitPrice } 单价为 null 表示未计价。
 * @returns {{ estimated: number|null, unitPrice: number|null, duration: number, reason?: string }}
 */
export function estimateSpend({ model, duration, unitPrice }) {
  const seconds = Number(duration ?? 5)
  const price = unitPrice === null || unitPrice === undefined ? null : Number(unitPrice)
  if (price === null || !Number.isFinite(price) || price <= 0) {
    const reason =
      price === 0
        ? `模型 ${model} 的单价被写成 0：0 等于宣称"免费"，不是"未知"，闸门不接受 0 作为预估依据。请填真实单价；不知道就写 null（= 未计价）`
        : price !== null && Number.isFinite(price) && price < 0
          ? `模型 ${model} 的单价是负数（${price}），不可能是合法价格——请检查 插件页 → CN-gpt → 配置卡 里的单价表`
          : `模型 ${model} 未计价，无法预估——请先在配置卡里补齐单价`
    return { estimated: null, unitPrice: null, duration: seconds, reason }
  }
  return { estimated: toCents(price * seconds), unitPrice: price, duration: seconds }
}

/**
 * 付费提交前的收口检查。**任何付费路径都必须先过这里。**
 *
 * ⚠ 2026-10-16：这句话以前是**假的**——制图（tools/qwen-draw.mjs）根本没有调用它，
 * 只受了次数预算（maxCallsPerTurn）约束。实测：不传任何确认参数即可直接出图扣费。
 * 现在制图也走本函数（`noun: '出图'`、`unitLabel: '张'`，上限复用同一对配置项）。
 *
 * @param {object} input - 上下文。
 * @param {object} input.estimate - `estimateSpend` 的结果。
 * @param {object} input.config - 插件 Config（读两个上限 + allowUnpricedSpend）。
 * @param {(key: string) => Promise<number>} input.spentInSession - 读本次会话已花金额（元）。
 * @param {object} input.confirmed - 调用方传来的确认信息 `{ confirm_estimate, confirm_unpriced }`。
 * @param {string} input.providerLabel - 厂商名，用于文案。
 * @param {string} [input.noun] - 这次花钱在做什么（默认"出片"）。制图传"出图"。
 * @param {string} [input.unitLabel] - 计量单位（默认"秒"）。制图传"张"。
 * @param {string} [input.perCallKey] / [input.perSessionKey] - 两个上限的**配置字段名**（默认出片的两个）。
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function authorizeSpend({
  estimate,
  config,
  spentInSession,
  confirmed,
  providerLabel,
  noun = '出片',
  unitLabel = '秒',
  perCallKey = 'videoCostLimitCNY',
  perSessionKey = 'videoSessionCostLimitCNY',
}) {
  const { estimated, unitPrice, duration, reason } = estimate

  // ---- 未计价：默认 fail-closed，且**不接受"自报金额"作为放行凭证** ----
  //
  // 2026-10-15 的初版这里写的是"只要 confirm_estimate 是个数字就放行"。
  // 那是个真洞：金额算不出来的时候，调用方随便报一个数（`confirm_estimate: 1`）
  // 就能把闸门整个推开 —— 上限判定（单次 / 会话累计）也一并跳过，
  // 等于"想让闸门放行，只要自己编个价格"。设计意图里的"让人表态"变成了"让模型表态"。
  //
  // 现在的语义：金额算不出来时，**只有人能放行**。
  //   - `allowUnpricedSpend: false`（默认）→ 一律拒绝，调用方无法绕过；
  //   - 用户把开关打开后，调用方还须带 `confirm_unpriced: true` 明示"我知道这次金额不可知"。
  // 数字（confirm_estimate）在这里完全不作数 —— 它没法证明任何事。
  if (estimated === null) {
    if (config?.allowUnpricedSpend !== true) {
      return {
        ok: false,
        message:
          `⛔ ${reason}。**本次调用未提交、未产生任何费用。**` +
          `未计价模型默认不放行（allowUnpricedSpend=false），且**不接受调用方自报金额**——` +
          `因为"金额算不出来时自己报一个数"本身就不构成任何担保。` +
          `请二选一：① 让用户在 插件页 → CN-gpt → 配置卡 的单价表里补上该模型 id 的单价（推荐，补完就能正常${noun}）；` +
          `② 用户明确同意"按未知价格${noun}"后，把配置卡里的 allowUnpricedSpend 打开，再重试并带上 confirm_unpriced=true。`,
      }
    }
    if (confirmed?.confirm_unpriced !== true) {
      return {
        ok: false,
        message:
          `⚠ ${reason}。用户已允许未计价${noun}（allowUnpricedSpend=true），但**本次仍未确认**。` +
          `**本次未提交、未产生任何费用。**` +
          `确认要按"未知价格"${noun}，请再调一次这个工具，并带上参数 confirm_unpriced=true。`,
      }
    }
    return { ok: true }
  }

  // ⚠ 顺序很重要：**先判上限，再要确认**。
  // 反过来的话，超上限的调用会先被确认层拦住、拿不到"超限"这个更具体的错因，
  // 调用方也就不知道真正的问题在哪（是限额不够，还是没确认）。
  const perCall = capOf(config[perCallKey])
  if (perCall !== null && estimated > perCall) {
    return {
      ok: false,
      message:
        `⛔ 这次${noun}预估 ¥${estimated.toFixed(2)}（${duration} ${unitLabel} × ¥${unitPrice}/${unitLabel}）` +
        `超过 ${perCallKey}=¥${perCall} 的单次上限，**已在提交前拦下，未产生任何费用**。` +
        `要放行请让用户在 插件页 → CN-gpt → 配置卡 调大该上限（0 = 不限制）。`,
    }
  }

  const perSession = capOf(config[perSessionKey])
  const already = typeof spentInSession === 'function' ? await spentInSession() : 0
  if (perSession !== null && already + estimated > perSession) {
    return {
      ok: false,
      message:
        `⛔ 本次会话已花 ¥${already.toFixed(2)}，再加这次 ¥${estimated.toFixed(2)} 会超过 ` +
        `${perSessionKey}=¥${perSession} 的**会话累计上限**，**已在提交前拦下，未产生任何费用**。` +
        `这是专门防"反复试、每次都不贵"的烧钱模式（2026-10-15 的事故就是这样烧掉 ¥195.97 的）。` +
        `要放行请让用户在 插件页 → CN-gpt → 配置卡 调大该上限（0 = 不限制）。`,
    }
  }

  // ---- 小额免确认（2026-10-16 加）----
  //
  // ⚠ 位置很关键：必须在**两个上限判定之后**、确认层之前。
  // 放错到上限之前，它就成了"绕过上限的后门"（金额再大也直接放行）——
  // 测试里钉了这条：阈值调得很大时，超过单次上限的调用仍然必须被拦下。
  //
  // 语义：只跳过第 3 层"复述金额"。单次/会话上限照旧；未计价照旧 fail-closed
  // （未计价在函数开头就返回了，根本走不到这里）。
  // 动机：确认流程天然是两次调用，而制图单张 ¥0.18、一批最多 4 张 → 每次都多一轮往返不划算；
  // 出片 1 秒就是 ¥1.52，所以默认阈值 1 元实际上只给制图"免了这道手续"。
  // 0 / 非法值 = 关闭该机制（一律要确认）。
  const noConfirmUnder = capOf(config.noConfirmUnderCNY)
  if (noConfirmUnder !== null && estimated <= noConfirmUnder) return { ok: true }

  // ---- 第 3 层：显式确认（这次事故真正缺的那一步）----
  //
  // `requireSpendConfirm: false` 是给**测试**用的逃生口：单测要覆盖提交/轮询/记账，
  // 不该被确认层挡住。生产默认 true——**"绕过确认"必须由人显式配置**，
  // 不能是"忘了传 confirm_estimate 就悄悄放过"。
  if (config?.requireSpendConfirm === false) return { ok: true }

  const given = confirmed?.confirm_estimate
  if (typeof given !== 'number' || !Number.isFinite(given)) {
    return {
      ok: false,
      message:
        `⛔ ${noun}是**按次计费且不可撤销**：这次将花费 ¥${estimated.toFixed(2)}` +
        `（${duration} ${unitLabel} × ¥${unitPrice}/${unitLabel}，${providerLabel}）。**本次未提交、未产生任何费用。**` +
        `确认要花这笔钱，请再调一次这个工具，并带上参数 confirm_estimate=${estimated}（精确到分）。`,
    }
  }
  if (Math.abs(given - estimated) > MONEY_EPSILON) {
    return {
      ok: false,
      message:
        `⛔ confirm_estimate 对不上：你给的是 ¥${given.toFixed(2)}，实际预估是 ¥${estimated.toFixed(2)}` +
        `（${duration} ${unitLabel} × ¥${unitPrice}/${unitLabel}）。**本次未提交、未产生任何费用。**` +
        `请用准确的金额再确认一次：confirm_estimate=${estimated}。`,
    }
  }
  return { ok: true }
}

/**
 * 读上限配置。0 或非法值 = 不限制（返回 null）。
 * @param {unknown} value - 配置值。
 * @returns {number|null} 上限或 null。
 */
function capOf(value) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) && number > 0 ? number : null
}
