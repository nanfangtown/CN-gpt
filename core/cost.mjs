/**
 * 成本可视化：可编辑单价表 + 用量账本 + 报表（规划 [5]）。
 *
 * 诚实边界（写进 UI 与 README）：
 *   - 只统计"本插件经手"的调用；同一把 key 在别处产生的费用不计入；
 *   - 单价来自 Config 内置表，可能过期；档位/优惠/免费额度无法准确建模；
 *   - 结果一律标注"估算"，金额不参与任何自动决策。
 *
 * 账本存储：优先宿主 storage 服务（ctx.storageDomain + schema 校验），
 * 服务缺失或装载失败时退化为插件自有 JSON 文件（原子替换）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { clip } from './errors.mjs'

/**
 * 内置单价表（2026-10-13 起带真实价格与来源）。
 *
 * 诚实原则（重要）：
 *   - **只填官方文档能查到的价**。查不到的填 `null` = **未计价**，报表会明确标"未计价"，
 *     绝不用 `0` 冒充"免费"——`0` 与 `null` 在报表里含义完全不同。
 *   - 每条都带 `asOf`（取价日期）与 `source`（取价页面），价格会变，请按官网自行核对。
 *   - ktoken 类按"每千 token"计价，报表计入的是**本插件经手**的部分；
 *     读图子代理的 token 由 pi-ai 路由产生，本插件不拦截，故未计入（报表里已注明）。
 *
 * 各条来源：
 *   - qwen-image-3.0：阿里云百炼「qwen-image-3.0」，华北2（北京）图片生成 0.18 元/张
 *     （1K 与 2K 同价）。图片**输入**另收 0.02 元/张，本插件出图时不传参考图，故只记生成价。
 *   - glm-4.6v：智谱 BigModel 视觉模型，按 token 计费。⚠ 官网定价页是前端渲染，
 *     无法取到该型号的确定数字 → **未计价**。请按 https://bigmodel.cn/pricing 填入。
 *   - qwen3-vl-plus：百炼视觉理解模型，按 token 计费。⚠ 同上，**未计价**。
 *   - Seedance 2.x（2026-10-15）：**token↔秒的换算是我实测的，单价不是。**
 *     从 19 个真实任务的 `usage` 反推出稳定换算：**约 21,700 tokens / 秒视频**
 *     （实测 4s=87,300 / 15s=324,900，每个档位严丝合缝，线性无偏差）——**这条可信**。
 *     但换算成钱要乘单价，而单价只来自第三方博客（2.0 = 46、2.5 = 70 元/百万 token），
 *     官方定价页是前端渲染抓不到。**所以下面两个 unitPrice 是估算，不是账单**：
 *       ⚠ 用户在控制台查不到对应扣费，真实值可能低 3–5 倍（或走资源包抵扣）。
 *     校正方法：去控制台「用量统计」找这两个模型的 token 数（应约为 1,889,470 / 1,800,900），
 *     用「实扣金额 ÷ token 数」反推真实单价，然后替换这里。
 *   - doubao-seedance-1-0-pro-fast-251015：1.0 世代**按秒计价**，5 秒 1080P = 1.03 元
 *     → 0.206 元/秒（媒体口径，5 秒折算零偏差；同为间接来源，量级可信）。
 */
export const DEFAULT_PRICING = {
  'qwen-image-3.0': {
    unit: 'image',
    unitPrice: 0.18,
    currency: 'CNY',
    asOf: '2026-10-13',
    source: 'https://help.aliyun.com/zh/model-studio/qwen-image-3-0',
  },
  'doubao-seedance-2-5-260628': {
    unit: 'second',
    unitPrice: 1.519,
    currency: 'CNY',
    asOf: '2026-10-15',
    tiers: [],
    source: '⚠ 估算：21,700 tokens/秒（实测）× 70 元/百万 token（第三方来源，未经官方页核实）',
  },
  'doubao-seedance-2-0-fast-260128': {
    unit: 'second',
    unitPrice: 0.998,
    currency: 'CNY',
    asOf: '2026-10-15',
    tiers: [],
    source: '⚠ 估算：21,700 tokens/秒（实测）× 46 元/百万 token（第三方来源，未经官方页核实）',
  },
  'doubao-seedance-1-0-pro-fast-251015': {
    unit: 'second',
    unitPrice: 0.206,
    currency: 'CNY',
    asOf: '2026-10-15',
    tiers: [],
    source: 'https://www.bianews.com/news/details?id=223817',
  },
  // ---- 百炼视频（2026-10-17 加）：可灵 v3 + 万相 2.5 ----
  //
  // 口径：官方页标价，按秒、按"模式（720P/1080P/4K）× 是否带音频"二维计价。
  // 为什么用 tiers 而不是一个数：4K 是 720P 的 5 倍（3.0 vs 0.6），
  // 只写一个数会让 4K 请求被低报 5 倍 —— 闸门看着"没超上限"，实际一次 ¥45。
  //
  // `unitPrice` 字段是**兜底价**（= 1080P 无声档），tiers 才是实际取价路径。
  'kling/kling-v3-video-generation': {
    unit: 'second',
    unitPrice: 0.8,
    currency: 'CNY',
    asOf: '2026-10-17',
    tiers: [
      { mode: 'std', audio: false, unitPrice: 0.6 },
      { mode: 'std', audio: true, unitPrice: 0.9 },
      { mode: 'pro', audio: false, unitPrice: 0.8 },
      { mode: 'pro', audio: true, unitPrice: 1.2 },
      { mode: '4k', audio: false, unitPrice: 3 },
      { mode: '4k', audio: true, unitPrice: 3 },
    ],
    source: 'https://help.aliyun.com/zh/model-studio/kling-v3-video-generation',
  },
  'kling/kling-v3-turbo-video-generation': {
    unit: 'second',
    unitPrice: 1,
    currency: 'CNY',
    asOf: '2026-10-17',
    // Turbo 固定音画同出（audio 字段不生效），所以两档同价。
    tiers: [
      { mode: 'std', audio: false, unitPrice: 0.8 },
      { mode: 'std', audio: true, unitPrice: 0.8 },
      { mode: 'pro', audio: false, unitPrice: 1 },
      { mode: 'pro', audio: true, unitPrice: 1 },
    ],
    source: 'https://help.aliyun.com/zh/model-studio/kling-v3-turbo-video-generation',
  },
  'kling/kling-v3-omni-video-generation': {
    unit: 'second',
    unitPrice: 0.8,
    currency: 'CNY',
    asOf: '2026-10-17',
    // 无参考视频档（本 adapter 不传 video 输入，故取这一档）。
    tiers: [
      { mode: 'std', audio: false, unitPrice: 0.6 },
      { mode: 'std', audio: true, unitPrice: 0.9 },
      { mode: 'pro', audio: false, unitPrice: 0.8 },
      { mode: 'pro', audio: true, unitPrice: 1.2 },
      { mode: '4k', audio: false, unitPrice: 3 },
      { mode: '4k', audio: true, unitPrice: 3 },
    ],
    source: 'https://help.aliyun.com/zh/model-studio/kling-v3-omni-video-generation',
  },
  'wan2.5-t2v-preview': {
    unit: 'second',
    unitPrice: 1,
    currency: 'CNY',
    asOf: '2026-10-17',
    tiers: [
      { mode: 'std', audio: false, unitPrice: 0.6 },
      { mode: 'std', audio: true, unitPrice: 0.6 },
      { mode: 'pro', audio: false, unitPrice: 1 },
      { mode: 'pro', audio: true, unitPrice: 1 },
    ],
    source: 'https://help.aliyun.com/zh/model-studio/wan2-5-t2v',
  },
  // ---- Legacy：2026-10-15 之前的模型 id，保留仅为兼容旧配置 ----
  //
  // ⚠ 上面的三个 `doubao-seedance-*` 键才是**真实模型 id**（按 id 计价，别再用 'seedance-2.0'）。
  // 这个键曾是一次**闸门锁死事故**的现场：
  //   - `seedanceModel` 在 10-15 从 'seedance-2.0' 改成 'doubao-seedance-2-5-260628'；
  //   - 但单价表里只有旧键 'seedance-2.0'，新模型 id **查不到价** → unitPriceOf() 返回 null；
  //   - 于是 spend-guard 走到"未计价"分支，估算金额是 null，而确认层要求一个精确数字，
  //     调用方给不出 → **fail-closed，出片工具彻底不可用**；
  //   - 全过程没有任何告警：模型 id 与单价表是两个独立字段，代码没做外键校验。
  // 对策有三层，缺一不可：① 出厂表把三个真实模型 id 都配上价；② 启动自检（pricingWarnings）
  // 会在"配置的模型查不到价"时直接点名；③ `tests/run.mjs` 里钉了"发布用 patch 的
  // `seedanceModel` / `qwenModel` 必须在单价表里有正价"的回归断言，防止再犯。
  'seedance-2.0': {
    unit: 'second',
    unitPrice: null,
    currency: 'CNY',
    asOf: '2026-10-13',
    tiers: [],
    source: '⚠ 停用键：这是 2026-10-15 之前的模型 id，现已不是任何默认模型 id。'
      + '保留仅为兼容旧配置；新配置请用 doubao-seedance-* 三个键。'
      + 'https://docs.volcengine.com/docs/ark/api-key',
  },
  'glm-4.6v': {
    unit: 'ktoken',
    inputPrice: null,
    outputPrice: null,
    currency: 'CNY',
    asOf: '2026-10-13',
    source: 'https://bigmodel.cn/pricing',
  },
  'qwen3-vl-plus': {
    unit: 'ktoken',
    inputPrice: null,
    outputPrice: null,
    currency: 'CNY',
    asOf: '2026-10-13',
    source: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  },
}

/**
 * 一条单价记录是否"已计价"——判据是**正数**，不是"非 null"。
 *
 * ⚠ 2026-10-15 修：早先只判 `!== null`，于是 `unitPrice: 0` 被读成"已计价"。
 * 后果有两个，都很贵：
 *   ① 真钱被报表显示成 0.0000（"免费"）；
 *   ② 花费闸门把 0 当成合法预估金额 → 单次上限 / 会话上限 / 强制确认**全部失效**
 *      （详见 core/spend-guard.mjs 的 estimateSpend）。
 * 0 不是"未知"（未知的正确写法是 null），0 是"宣称免费"，所以不算已计价。
 */
export function isPriced(entry) {
  if (entry === null || entry === undefined) return false
  if (entry.unit === 'ktoken') {
    return priceAboveZero(unitPriceOf(entry, 'inputPrice')) || priceAboveZero(unitPriceOf(entry, 'outputPrice'))
  }
  return priceAboveZero(unitPriceOf(entry))
}

/** 单价是否为"可用正价"；null / 0 / 负数 / NaN 一律不算。 */
export function priceAboveZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** 取生效单价表。 */
export function pricingOf(config) {
  return config?.pricing ?? DEFAULT_PRICING
}

/**
 * 从单价表条目取一个"单价数值"。
 *
 * ⚠ 这里**故意不用 `Number(x ?? 0)`**：`Number(null)` 是 `0`，
 * 会把"未计价"悄悄变成"免费"，报表就会报 0.0000 而用户以为不要钱。
 * 未计价一律返回 `null`，让调用方一路传到报表里显示「未计价」。
 *
 * @returns {number|null} 有限数 = 已计价；null = 未计价。
 */
export function unitPriceOf(entry, key = 'unitPrice') {
  const raw = entry?.[key]
  if (raw === null || raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** 单价写 0 时的统一提示。schema 的 description 与启动自检共用一句，避免两处文案漂移。 */
export const PRICING_ZERO_HINT =
  '单价写 0 等于宣称"免费"：真钱会被报表显示成 0.0000。不知道价格请写 null（= 未计价）。'

/**
 * 取一条记录里"能用来算钱的数"，用于和出厂价做**数值**比较。
 *
 * 与 `unitPriceOf` 的区别：这里把 `0` 当成**比不出价**（`<= 0` 一律视为没有可用价），
 * 因为 0 元单价的唯一效果就是"把真钱显示成免费"。这正是要检出的东西，
 * 判据与 `isPriced` 现在一致（都是"正数才算有价"）：两处若不一致，自检与报表就会互相打架 —— 一处说"已计价"，另一处说"没有可用价"。
 *
 * @param {object} entry - 单价记录。
 * @returns {number|null} 正数 = 可用；null = 没有可用价。
 */
function usablePrice(entry) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return null
  const raw = entry.unit === 'ktoken' ? (unitPriceOf(entry, 'inputPrice') ?? unitPriceOf(entry, 'outputPrice')) : unitPriceOf(entry)
  return raw !== null && raw > 0 ? raw : null
}

/**
 * 对"生效单价表 vs 出厂单价表"做差异比对，返回**零价覆盖**清单。
 *
 * 2026-10-15 的事故根因之一：profile 的 `pricing` 是整体替换语义，
 * 一份 2026-10-12 写的占位表（全 0）把出厂真价表整个顶掉了，且没有任何提示。
 * 这个函数就是那个缺失的提示。
 *
 * 判据刻意选"出厂算得出价、你写的算不出价"，而不是"数值不相等"：
 * 价格本就允许用户按自己的合同改（0.5 元/张、0.1 元/秒都合法），
 * 真正要抓的是**把有价的东西写成没有价**（0 或 null）——那会让报表显示"免费"或"未计价"。
 *
 * @param {object} effective - 生效单价表（config.pricing）。
 * @returns {{ key: string, message: string }[]} 被零价顶掉的条目。
 */
export function zeroPriceOverrides(effective) {
  if (effective === null || effective === undefined || typeof effective !== 'object') return []
  const found = []
  for (const [key, defaultEntry] of Object.entries(DEFAULT_PRICING)) {
    if (!Object.prototype.hasOwnProperty.call(effective, key)) continue
    const defaultPrice = usablePrice(defaultEntry)
    if (defaultPrice === null) continue // 出厂就没价，用户写什么都不是"顶掉"
    if (usablePrice(effective[key]) !== null) continue // 用户给了正价（改价是允许的）
    found.push({
      key,
      message:
        `单价表条目「${key}」被覆盖成没有可用价（0 或 null），而出厂表里是 ${defaultPrice} 元。` +
        `${PRICING_ZERO_HINT}（若确实不想计价，请直接删掉这个键，别留 0。）`,
    })
  }
  return found
}

/**
 * 启动自检：生效单价表是否够用。**只读、只告警、不修改任何配置。**
 *
 * 覆盖两类真实故障：
 *   1. **配置的模型查不到价** → 出片闸门 fail-closed，工具静默不可用（2026-10-15 实发）；
 *   2. **出厂价被 0 顶掉** → 报表把真钱显示成免费。
 *
 * @param {object} config - 插件 Config 实例（字段可能是 getter）。
 * @param {(value: unknown) => unknown} [plain] - 取值器；默认原样返回。
 * @returns {string[]} 人话告警清单；无问题时为空数组。
 */
export function pricingWarnings(config, plain = (value) => value) {
  const table = pricingOf(config)
  const read = (key) => plain(config?.[key])
  const warnings = []

  const configured = [
    ['qwenModel', '制图'],
    ['seedanceModel', '出片'],
    ['videoModel', '出片（百炼）'],
  ]
  const known = new Set()
  for (const [field, label] of configured) {
    const id = read(field)
    if (typeof id !== 'string' || id.trim() === '') continue
    known.add(id)
    if (isPriced(table[id])) continue
    const entry = table?.[id]
    const why = entry === undefined
      ? '单价表里没有这个键'
      : `单价表里该键未计价（${PRICING_ZERO_HINT}）`
    warnings.push(
      `配置项 ${field} = ${id}（${label}）没有可用单价：${why}。` +
        `后果：${label}提交会被花费闸门拦下（未计价 fail-closed），或金额按 0 计入报表。` +
        `修法：在 插件页 → gpt-CN → 配置卡 的单价表里补上该模型 id 的价，或把 ${field} 换回已计价的模型。`,
    )
  }

  // 读图子代理走 pi-ai 路由，本插件不拦 token，故不参与上面的"必须已计价"判定；
  // 但若表里为它留了键却写成 0，仍要提醒（那是把真钱写成免费）。
  for (const item of zeroPriceOverrides(table)) {
    if (known.has(item.key)) continue // 已由上面更具体的告警覆盖
    warnings.push(item.message)
  }

  // 既不在用、也非出厂键的条目 = 陈旧残留，容易让下一个人以为"这个模型按这个价计费"。
  //
  // ⚠ 2026-10-17：**ktoken 类条目不能拿 `known` 判陈旧**。`known` 只有 qwenModel /
  // seedanceModel 两个字段，读图模型根本不在里面（它由 pi-ai 路由解析，config 里没有这个字段）。
  // 于是刚给读图模型填好价，反而被报成「已不是当前使用的模型 id」——把正确配置说成错误。
  // ktoken 条目只服务读图子代理，本来就可能同时留着几个候选模型，不做陈旧判定。
  const defaultKeys = new Set(Object.keys(DEFAULT_PRICING))
  for (const key of Object.keys(table ?? {})) {
    if (known.has(key) || defaultKeys.has(key)) continue
    if (table?.[key]?.unit === 'ktoken') continue
    warnings.push(`单价表里的「${key}」已不是当前使用的模型 id（陈旧条目），建议删除以免误读。`)
  }

  return warnings
}

/** 每条记录一行：金额 = units × unitPrice（ktoken 另行处理）。未计价返回 null。 */
export function amountOf(record) {
  if (record.unitKind === 'ktoken') {
    const inputPrice = unitPriceOf(record, 'inputPrice')
    const outputPrice = unitPriceOf(record, 'outputPrice')
    if (inputPrice === null && outputPrice === null) return null
    const tokens =
      (Number(record.inputTokens ?? 0) / 1000) * (inputPrice ?? 0) +
      (Number(record.outputTokens ?? 0) / 1000) * (outputPrice ?? 0)
    return Number(tokens.toFixed(6))
  }
  const price = unitPriceOf(record)
  if (price === null) return null
  return Number((Number(record.units ?? 0) * price).toFixed(6))
}

const LEDGER_LIMIT = 5000
const DOMAIN_NAME = 'mm_media_ledger'
const REGISTRY_VERSION = 1

function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}

function ledgerFilePath(config) {
  const configured = typeof config?.ledgerPath === 'string' ? config.ledgerPath.trim() : ''
  if (configured.length > 0) return configured
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'mm-models-ledger.json')
}

/**
 * 读 JSON 账本文件。
 *
 * ⚠ `strict` 是"花钱路径"专用的读法（2026-10-16 加）：
 *   - lenient（默认，报表/健康检查用）：坏文件当空账本，永远不阻塞任何工具；
 *   - strict（闸门用）：**文件损坏/读不动必须抛错**，绝不能变成"本会话已花 0"。
 *     "读失败 = 没有记录"会让会话累计上限静默失效——那正是这个项目两次栽过的形态。
 * 只有"文件不存在"（ENOENT）在两种模式下都算空账本：首次运行本来就该是空的。
 *
 * @param {string} path - 账本文件路径。
 * @param {object} [options] - { strict }。
 * @returns {Promise<object>} { version, records, health }。
 */
async function readJsonFile(path, options = {}) {
  const strict = options.strict === true
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: REGISTRY_VERSION, records: [], health: {} }
    const message = `账本文件读取失败（${path}）：${String(error?.message ?? error)}`
    if (strict) throw new Error(message)
    return { version: REGISTRY_VERSION, records: [], health: {} }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = `账本文件解析失败（${path}，文件可能被写坏）：${String(error?.message ?? error)}`
    if (strict) throw new Error(message)
    return { version: REGISTRY_VERSION, records: [], health: {} }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const message = `账本文件不是 JSON 对象（${path}）`
    if (strict) throw new Error(message)
    return { version: REGISTRY_VERSION, records: [], health: {} }
  }
  return { version: REGISTRY_VERSION, records: Array.isArray(parsed.records) ? parsed.records : [], health: parsed.health ?? {} }
}

/**
 * 宿主 storage 后端的落盘文件（`<DSH_HOME>/storages/mm_media_ledger.json`）。
 * 只在"服务拿不到、账本降级到文件后端"时用它做兜底对账（只读）。
 */
function hostStorageLedgerPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', 'mm_media_ledger.json')
}

/**
 * 只读地把宿主 storage 文件里的 usage 记录取出来。
 *
 * 为什么需要：storageDomain 服务拿不到时（热重载/装配时序，2026-10-15 实测复现过），
 * 插件只能读文件账本，而**真实花销在 storage 领域里** → "已花"被算成 0 → 会话上限失效。
 * 这里把 storage 文件里的记录并进对账，让上限在降级态下依然守得住。
 *
 * 文件不存在 = 该环境本就没有 storage 后端，返回空数组（不算错误）；
 * 文件存在但读不动/解析不了 = 数据不可信，抛错（strict 下会因此拒绝提交）。
 */
async function readHostStorageRecords() {
  const path = hostStorageLedgerPath()
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`宿主 storage 账本读取失败（${path}）：${String(error?.message ?? error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`宿主 storage 账本解析失败（${path}）：${String(error?.message ?? error)}`)
  }
  const rows = parsed?.tables?.usage
  if (rows === null || rows === undefined || typeof rows !== 'object') return []
  return Object.values(rows).filter((row) => row !== null && typeof row === 'object')
}

/** 原子写 JSON 文件。 */
async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * 打开用量账本。
 * @param {object} ctx - 插件上下文（可选 storageDomain / logger）。
 * @param {object} config - 插件 Config。
 * @returns {object} ledger
 */
export async function openLedger(ctx, config, logger) {
  const log = (level, message, extra) => {
    const fn = logger?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(logger, message, extra)
      } catch {
        // 忽略
      }
    }
  }

  let backend = 'file'
  let domain
  let storageError
  const facility = typeof ctx?.get === 'function' ? ctx.get('storageDomain') : undefined
  if (facility !== undefined && typeof facility.open === 'function') {
    try {
      const [{ defineDomain, domainTable }, { z }] = await Promise.all([import('@deepseek-ai/dsh-storage-domain'), import('zod')])
      const usageSchema = z.object({
        at: z.string(),
        adapter: z.string(),
        provider: z.string(),
        model: z.string(),
        unitKind: z.string(),
        units: z.number(),
        // ⚠ unitPrice / amount 必须**允许 null**：未计价（单价表里写 null，或模型查不到价）
        // 是插件有意支持的记录形态，落盘时写的就是 null。
        //
        // 2026-10-15 事故：这里原本写的是 z.number()。于是只要产生一条"未计价"记录，
        // 下次 open() 逐条 zod 校验就 invalid-record → 下面这个 catch 把领域整个放弃，
        // **静默**退回 JSON 文件账本 —— 报表里所有历史用量凭空消失（数据没丢，只是读不出来）。
        // 放行 null 才是与写入方一致的语义。
        unitPrice: z.number().nullable(),
        currency: z.string(),
        amount: z.number().nullable(),
        sessionId: z.string().optional(),
        taskId: z.string().optional(),
        note: z.string().optional(),
      })
      // 必须与 mergeHealth() 实际写入的形状一致，否则下次打开领域会
      // invalid-record 而退回 JSON 账本（本轮试跑抓到过这个不一致）。
      const healthSchema = z.object({
        lastSuccess: z.string().optional(),
        lastFailure: z.string().optional(),
        detail: z.string().optional(),
      })
      const spec = defineDomain({
        name: DOMAIN_NAME,
        version: REGISTRY_VERSION,
        // 再加一道护栏：宿主 storage-domain 的官方策略 —— 某条记录校验不过时，
        // 把它备份挪走、记一条 error 日志、其余记录照常装载，
        // 而不是让整个领域 open() 失败。
        // 没有它，任何一次"写入形状漂移"都会重演 2026-10-15 的静默降级：
        // 整个账本读不出来，报表显示"没有用量记录"，而磁盘上数据完好。
        invalidRecords: 'backup-and-skip',
        tables: { usage: domainTable(usageSchema), health: domainTable(healthSchema) },
      })
      domain = await facility.open(spec)
      backend = 'storage'
    } catch (error) {
      storageError = error
      // 只写 logger.warn 是不够的：DSH 不落盘插件日志，用户根本看不见，
      // 表现就是"报表突然空了"。所以原因由 ledger.storageError() 带进 health 报告（见 tools/media-report.mjs）。
      log('warn', `[mm-models] storageDomain ledger unavailable; falling back to JSON file: ${clip(String(error?.message ?? error))}`)
    }
  } else {
    // ⚠ 这一支以前是**静默**的：服务压根拿不到时 `storageError` 保持 undefined，
    // 于是 media-report 那条"已退回 JSON 文件"的告警不会打印，报表只会说"没有用量记录"——
    // 表现是"磁盘上明明有历史用量，报表里凭空消失"，而用户没有任何线索。
    // 2026-10-15 实测复现过一次（热重载 / 装配时序导致 `ctx.get('storageDomain')` 未命中：
    // 当时 health 报「账本后端：file」、cost 报表读空，而 storages 里有 15 条真实记录）。
    // 现在把"拿不到服务"与"服务打不开"统一成同一条**可解释**的降级原因。
    //
    // 注意措辞保持中性：某些发行版/CLI 场景本来就不带 storage-domain 服务，
    // 那不是故障，只是"这类环境只能用文件账本"，所以原因要写清而不是报警。
    storageError =
      typeof ctx?.get !== 'function'
        ? new Error('插件上下文没有 ctx.get：无法查找 storageDomain 服务，只能用文件账本')
        : new Error(
            "宿主未提供 storageDomain 服务（ctx.get('storageDomain') 未命中）：可能是该环境本就不带 storage-domain，或服务尚未就绪、插件先于它装配。此类环境下账本落在文件后端，storage 领域里的历史用量读不到。",
          )
    log('debug', '[mm-models] storageDomain service unavailable; using JSON file ledger')
  }

  const filePath = ledgerFilePath(config)
  let fileState
  let writeChain = Promise.resolve()
  let sequence = 0
  const nextKey = () => `${Date.now().toString(36)}-${(sequence += 1).toString(36)}`

  async function loadFileState(options = {}) {
    // 严格读**不碰缓存**：上一次 lenient 读可能已经把"坏文件 → 空账本"缓存下来了，
    // 花钱路径必须看到文件当前的真实状态。
    if (options.strict === true) return await readJsonFile(filePath, { strict: true })
    if (fileState === undefined) fileState = await readJsonFile(filePath)
    return fileState
  }

  /** 串行化文件写入（storage 后端自身有写入链）。 */
  function enqueue(task) {
    const next = writeChain.then(task, task)
    writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async function persistFile() {
    const state = await loadFileState()
    if (state.records.length > LEDGER_LIMIT) state.records = state.records.slice(-LEDGER_LIMIT)
    await writeJsonFile(filePath, state)
  }

  async function record(entry) {
    const at = entry.at ?? nowIso()
    // `amount: null` 的语义是"交给账本按 unitKind 计算"（`reader-usage` 就是这么写的）。
    // ⚠ 2026-10-17 修：以前这里只认 `undefined`，于是这类记录的金额**永远是 null** ——
    // 而 `sessionSpentOrThrow` 用 `Number.isFinite(row.amount)` 汇总，读图 token 花费
    // 因此对会话累计上限**完全隐形**（实测：账本里记账成功，闸门看到的却是 0）。
    // 放行 null 不会把"算不出来"变成 0：`amountOf()` 对未计价本来就返回 null。
    const amountPending = entry.amount === undefined || entry.amount === null
    const full = { at, ...entry, amount: amountPending ? amountOf(entry) : entry.amount }
    try {
      if (backend === 'storage') {
        await domain.table('usage').put(nextKey(), full)
        return true
      }
      await enqueue(async () => {
        const state = await loadFileState()
        state.records.push(full)
        await persistFile()
      })
      return true
    } catch (error) {
      log('warn', `[mm-models] ledger write failed: ${clip(String(error?.message ?? error))}`)
      return false
    }
  }

  async function noteHealth(adapter, ok, detail) {
    const at = nowIso()
    try {
      if (backend === 'storage') {
        const previous = domain.table('health').get(adapter)
        await domain.table('health').put(adapter, mergeHealth(previous, { ok, at, detail }))
        return true
      }
      await enqueue(async () => {
        const state = await loadFileState()
        state.health[adapter] = mergeHealth(state.health[adapter], { ok, at, detail })
        await persistFile()
      })
      return true
    } catch (error) {
      log('warn', `[mm-models] ledger health write failed: ${clip(String(error?.message ?? error))}`)
      return false
    }
  }

  /**
   * 把"另一侧后端"的记录并进来对账。
   *
   * 同一条记录理论上不会同时落在两个后端（写入时按当时的 backend 二选一），
   * 但真出现时**不能算两遍钱**，所以按键去重。
   */
  function mergeRecords(primary, extra) {
    if (!Array.isArray(extra) || extra.length === 0) return primary
    const keyOf = (row) => `${row?.at}|${row?.taskId ?? ''}|${row?.model ?? ''}|${row?.units ?? ''}`
    const seen = new Set(primary.map(keyOf))
    const merged = [...primary]
    for (const row of extra) {
      const key = keyOf(row)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(row)
    }
    return merged
  }

  /**
   * storage 后端：读**文件账本**里"降级期"写下的记录。
   *
   * 为什么必须有（2026-10-17 修）：`backend` 在 openLedger 时定死，但"服务拿不到"
   * 是**按次**发生的（热重载 / 装配时序）。一次降级窗口里花掉的钱只落在文件里，
   * 若 storage 恢复后不再读文件，这段花费就凭空消失 → 会话累计上限被低估，
   * 等于留下一条"先制造一次降级、再花钱"的绕过路径。
   * 文件不存在（ENOENT）= 从未降级过，返回空，不算故障。
   */
  async function readFileLedgerRecords(strict) {
    try {
      return (await readJsonFile(filePath, { strict })).records
    } catch (error) {
      if (strict) throw error
      log('warn', `[mm-models] file ledger merge skipped: ${clip(String(error?.message ?? error))}`)
      return []
    }
  }

  /**
   * 文件后端：读宿主 storage 文件里的记录。
   * 语义与 `readFileLedgerRecords` 对称：不存在 = 空；损坏时 strict 抛错、lenient 只记日志。
   */
  async function readHostStorageRecordsSafe(strict) {
    try {
      return await readHostStorageRecords()
    } catch (error) {
      if (strict) throw error
      log('warn', `[mm-models] host storage ledger merge skipped: ${clip(String(error?.message ?? error))}`)
      return []
    }
  }

  /**
   * 读用量记录。
   *
   * ⚠ 对账是**双向**的（2026-10-17 修）。以前只有"降级到文件后端"这一侧会去并
   * storage 文件，反过来 storage 后端**完全不读文件账本** —— 于是降级窗口里花掉的
   * 钱在重载后消失，上限被低估。现在两侧都并、且 lenient（报表）也并：
   * 只让 strict 并会让"闸门看到的已花"和"报表显示的合计"变成两个数。
   *
   * @param {object} [filter] - { sessionId, sessionIds, since, now }。
   * @param {object} [options] - { strict }：**花钱路径必须传 strict**。
   *   - lenient（默认）：读失败返回空数组，只给报表/健康检查这类"宁可少显示、也不阻塞"的场景用；
   *   - strict：读失败**直接抛错**（`tool-kit.sessionSpentOrThrow` 会据此拒绝提交）——
   *     对账那一侧读不动时同样抛，"看不见花费"绝不能折算成"已花 0"。
   */
  async function list(filter = {}, options = {}) {
    const strict = options.strict === true
    try {
      if (backend === 'storage') {
        const rows = [...domain.table('usage').entries()].map(([, value]) => value)
        return applyFilter(mergeRecords(rows, await readFileLedgerRecords(strict)), filter)
      }
      const state = await loadFileState(options)
      return applyFilter(mergeRecords(state.records, await readHostStorageRecordsSafe(strict)), filter)
    } catch (error) {
      log('warn', `[mm-models] ledger read failed: ${clip(String(error?.message ?? error))}`)
      if (strict) throw error
      return []
    }
  }

  async function healthSnapshot() {
    try {
      if (backend === 'storage') {
        const out = {}
        for (const [key, value] of domain.table('health').entries()) out[key] = value
        return out
      }
      const state = await loadFileState()
      return { ...state.health }
    } catch {
      return {}
    }
  }

  function applyFilter(rows, filter) {
    const now = filter.now ?? Date.now()
    // `sessionIds`（2026-10-16 加）：一次取"自己 + 后代子代理会话"的记录。
    // 为什么需要：子代理的花费记在它自己的会话上，主代理只看 `sessionId` 等于
    // "看不见自己派出去的子代理花了多少"——而那正是成本黑洞的机制（看不见 = 管不住）。
    const sessionSet =
      Array.isArray(filter.sessionIds) && filter.sessionIds.length > 0 ? new Set(filter.sessionIds) : undefined
    return rows.filter((row) => {
      if (filter.sessionId !== undefined && row.sessionId !== filter.sessionId) return false
      if (sessionSet !== undefined && !sessionSet.has(row.sessionId)) return false
      if (filter.since !== undefined) {
        const at = Date.parse(row.at)
        if (!Number.isFinite(at) || at < filter.since) return false
      }
      if (filter.until !== undefined) {
        const at = Date.parse(row.at)
        if (!Number.isFinite(at) || at > filter.until) return false
      }
      return true
    })
  }

  async function close() {
    try {
      await writeChain
    } catch {
      // 忽略
    }
    if (domain !== undefined) {
      try {
        await domain.close()
      } catch {
        // 忽略
      }
    }
  }

  return {
    backend: () => backend,
    storageError: () => storageError,
    filePath: () => filePath,
    record,
    noteHealth,
    list,
    healthSnapshot,
    close,
  }
}

const PROVIDER_LABELS = Object.freeze({
  'dashscope-image': 'DashScope',
  'ark-video': '方舟 Ark',
})

/** 记录 → 按 厂商+型号 聚合。 */
export function summarizeRecords(records) {
  const groups = new Map()
  for (const row of records) {
    const key = `${row.adapter}|${row.model}`
    const group = groups.get(key) ?? {
      adapter: row.adapter,
      provider: PROVIDER_LABELS[row.adapter] ?? row.adapter,
      model: row.model,
      count: 0,
      unitKind: row.unitKind,
      units: 0,
      // 未计价保持 null（不要 Number(null)=0，那会把"不知道"变成"免费"）
      unitPrice: unitPriceOf(row),
      currency: row.currency ?? 'CNY',
      amount: 0,
    }
    group.count += 1
    group.units += Number(row.units ?? 0)
    group.amount += Number(row.amount ?? amountOf(row) ?? 0)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.adapter.localeCompare(b.adapter) || a.model.localeCompare(b.model))
}

function money(amount, currency) {
  return `${Number(amount).toFixed(4)} ${currency}`
}

/**
 * 单价单元格。未计价显式写「未计价」。
 *
 * ⚠ 判定必须走 `unitPriceOf`：`Number(null)` 是 `0`，
 * 用 `Number.isFinite(Number(x))` 会把"未计价"判成"已计价且单价 0"，报表就报成免费。
 */
function priceCell(value, currency, unitKind) {
  const price = unitPriceOf({ unitPrice: value })
  if (price === null) return '未计价'
  // ⚠ 0 / 负数同样**不是价**（0 是"宣称免费"，负数是非法值），判据必须与闸门和自检同源
  // （`priceAboveZero` / `isPriced`）。早先这里只判 `null`，于是单价被写成 0 的记录
  // 在报表里显示成 `0.0000 CNY` —— 正是 README「故障 2：真钱显示成免费」的症状，
  // 2026-10-15 那次修复只覆盖了闸门与自检，漏了这一处（同日复查时发现并修复）。
  if (!priceAboveZero(price)) return '零价（无效）'
  const suffix = typeof unitKind === 'string' && unitKind.length > 0 ? `/${unitKind}` : ''
  return `${money(price, currency)}${suffix}`
}

/** 用量单元格：单位缺失时不打出 "4 undefined"。 */
function unitsCell(units, unitKind) {
  const suffix = typeof unitKind === 'string' && unitKind.length > 0 ? ` ${unitKind}` : ''
  return `${units}${suffix}`
}

function formatTime(iso) {
  if (typeof iso !== 'string') return '—'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 渲染成本报表（media_report action=cost）。
 * @param {object} options - records / config / scope / sessionId / now / verbose / childSessionCount。
 *   `childSessionCount`（2026-10-16 加）：本次汇总里带上了几个**后代子代理会话**。
 *   子代理默认允许生成，它的花费记在自己会话上，所以标题必须写清"这份数字包含哪些会话"。
 * @returns {string}
 */
export function renderCostReport({ records, config, scope = 'session', sessionId, now = Date.now(), verbose = false, childSessionCount = 0, readerUsage = null }) {
  const pricing = pricingOf(config)
  const groups = summarizeRecords(records)
  const lines = []
  const scopeNote = scope === 'session' && childSessionCount > 0 ? `（含 ${childSessionCount} 个子代理会话）` : ''
  lines.push(`# 成本估算（scope: ${scope}${scope === 'session' && sessionId !== undefined ? `, session: ${sessionId}` : ''}${scopeNote}）`)
  /** 单价为 0 的型号数（= 金额不可信的行数）。要在表格外也能用，所以声明在这里。 */
  let zeroPriced = 0
  if (groups.length === 0) {
    lines.push('')
    lines.push('没有符合条件的用量记录（只统计本插件经手的调用）。')
  } else {
    lines.push('')
    lines.push('| 厂商 | 型号 | 次数 | 用量 | 单价 | 预估金额 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    const totals = new Map()
    let unpriced = 0
    for (const group of groups) {
      // ⚠ 判据必须与闸门 / 自检**同源**：只有正价才算"有价"。
      // 单价 0 是"宣称免费"（见 isPriced 的注释），单价列不能再打印 `0.0000` ——
      // 那正是 README「故障 2：真钱显示成免费」的症状。
      const rawPrice = unitPriceOf(group)
      const priced = priceAboveZero(rawPrice)
      const zero = rawPrice !== null && !priced
      if (rawPrice === null) unpriced += 1
      if (zero) zeroPriced += 1
      // 金额列：非正价的组**照样把记录里已有的数字打出来**，只是标注"不可信"。
      // ⚠ 刻意不在这里做任何过滤/清零：同一型号可能同时存在"占位表时代写的 0 价记录"
      // 与"修好后的正价记录"，按记录内 amount 求和是唯一不会把钱藏起来的口径。
      const amountCell = priced
        ? money(group.amount, group.currency)
        : zero
          ? `${money(group.amount, group.currency)}（不可信）`
          : '未计价'
      lines.push(
        `| ${group.provider} | ${group.model} | ${group.count} | ${unitsCell(group.units, group.unitKind)} | ${priceCell(group.unitPrice, group.currency, group.unitKind)} | ${amountCell} |`,
      )
      // 算术**保持原样**：所有组的 amount 都进合计（非正价组的 amount 必然是 0，
      // 而混合组里正价记录的金额必须留下 —— 合计绝不能因为这次修复而变小）。
      totals.set(group.currency, (totals.get(group.currency) ?? 0) + group.amount)
    }
    lines.push('')
    const totalText = [...totals.entries()].map(([currency, amount]) => money(amount, currency)).join('，')
    lines.push(
      `合计：${totalText}（只含已计价部分${unpriced > 0 ? `；另有 ${unpriced} 个型号未计价，实际花费高于此数` : ''}${zeroPriced > 0 ? `；另有 ${zeroPriced} 个型号单价为 0，其金额不可信` : ''}）`,
    )
  }
  if (zeroPriced > 0) {
    lines.push('')
    // ⚠ 措辞必须与实现一致：零价组的金额是"记录里已存的数"（通常为 0），而本次修复
    // **不改算术、只改标注** —— 所以不能说"未计入合计"（同一型号若还有正价记录，
    // 那些金额是照常计入的）。这里只声明"这一行的数字不可信"，并指出该去哪儿改。
    lines.push(
      `⚠ 有 ${zeroPriced} 个型号的记录单价是 **0**：0 不是价，是"宣称免费"，所以这一行的金额不可信。` +
        `已经发生的记录无法回溯定价，但新调用会按现行单价表记账。` +
        `请核对 插件页 → gpt-CN → 配置卡 的单价表：填真实单价，或填 null（= 未计价，报表会显式写「未计价」）。`,
    )
  }
  const asOf = [...new Set(Object.values(pricing).map((entry) => entry?.asOf).filter((value) => typeof value === 'string' && value.length > 0))]
  // 只点出"本次真的用到、但没价"的型号；没用到的型号列出来只会让用户困惑。
  const usedModels = new Set(groups.map((group) => group.model))
  const unpricedNames = Object.entries(pricing)
    .filter(([model, entry]) => usedModels.has(model) && !isPriced(entry))
    .map(([model]) => model)
  lines.push('')
  // 读图子代理的 token：**2026-10-17 起已经记账**（core/reader-usage.mjs 订阅 llm/stream
  // 的 waterfall 观察 usage 分片）。之前这里只能自曝"未计入"，根因是当时判断
  // "插件没有请求级钩子"——该结论在 0.2.0-rc.2 已不成立，见 reader-usage.mjs 顶部实测依据。
  //
  // 仍然要如实交代两件事：① 记的是 token 不是钱（单价表里 glm-4.6v / qwen3-vl-plus 若未填价，
  // 金额仍是 null）；② 报表统计的是**观测到的**用量，插件加载之前发生的调用不在内。
  const readerRoute = config?.enableAskQwen === true ? 'qwen-vl' : config?.enableAskGlm === true ? 'glm' : '未开启'
  // 单价表行：verbose 列出全部键名（排查用）；紧凑只说"几个型号 + 取价日期"（键名可以查配置卡）。
  lines.push(
    verbose
      ? `单价表：${Object.keys(pricing).join('、')}${asOf.length > 0 ? `（取价日期 ${asOf.join('、')}）` : ''}。`
      : `单价表：${Object.keys(pricing).length} 个型号${asOf.length > 0 ? `（取价 ${asOf.join('/')}）` : ''}。`,
  )
  const readerObserved = Number(readerUsage?.observed ?? 0)
  const readerRoutes = Array.isArray(readerUsage?.routes) ? readerUsage.routes : []
  if (readerObserved > 0) {
    const detail = readerRoutes
      .map((r) => `${r.provider}/${r.model} ${r.calls} 次 ${r.tokens} token`)
      .join('；')
    const unpricedReaders = readerRoutes.filter((r) => {
      const entry = pricing[r.model]
      return !isPriced(entry)
    })
    lines.push(
      `读图子代理 token：✅ **已记账** ${readerObserved} 次调用` +
        (detail.length > 0 ? `（${detail}）` : '') +
        (unpricedReaders.length > 0
          ? `；⚠ 其中 ${unpricedReaders.map((r) => '`' + r.model + '`').join('、')} 在单价表里未计价，金额仍为「未计价」——请按官网填入 ktoken 的 inputPrice/outputPrice`
          : ''),
    )
    if (verbose) {
      lines.push('> 口径：input + cacheRead + cacheWrite + output（与宿主 token-meter 的 usageTokens() 一致）；只观测读图员 provider，主代理与其它子代理由宿主自己计量。插件加载前发生的调用不在统计内。')
    }
  } else if (verbose) {
    lines.push(
      `读图子代理（ask_glm / ask_qwen，当前路由：${readerRoute}）尚未观测到调用：` +
        `本插件已订阅宿主 llm 的 \`llm/stream\` waterfall 并在 usage 分片上记账，` +
        `但统计从插件加载起算——此前发生的调用不在内。`,
    )
  } else {
    lines.push(`读图子代理（ask_glm / ask_qwen，当前路由：${readerRoute}）token：尚无观测记录（记账从插件加载起算）`)
  }
  if (unpricedNames.length > 0) {
    lines.push(
      `未计价型号：${unpricedNames.join('、')} —— 内置表里这些是「未计价」（不是 0 元）。请按各自官网价格在 Config.pricing 里填；每条单价的 source 字段就是取价页面。`,
    )
  }
  lines.push('统计时间：' + formatTime(nowIso(now)))
  lines.push('> 估算值，非账单：只统计本插件经手的调用；单价可能过期；档位、优惠与免费额度无法准确建模。请以各平台官网账单为准。')
  return lines.join('\n')
}

/**
 * 渲染健康报表（media_report action=health）。
 * @param {object} options - keyEntries / health / probes / llmProviders / config / switches / readerConflict / verbose。
 * @returns {string}
 */
export function renderHealthReport({ keyEntries, health = {}, probes = {}, llmProviders, config, switches = {}, readerConflict = false, verbose = false }) {
  const lines = []
  lines.push('# 链路健康')
  lines.push('')
  lines.push('| 能力 | 开关 | Key | 配置 | 来源 | 最近成功 | 最近失败 | 连通性 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  const capability = {}
  /**
   * 已经认领过"链路能力"的 adapter。
   * ask_qwen 与 qwen_draw 共用 DASHSCOPE_API_KEY 与同一条 dashscope-image 探测，
   * 只让第一个（qwen_draw）计入能力表，避免同一探测被算两次。
   */
  const claimedAdapters = new Set()
  const knownProviders = Array.isArray(llmProviders) ? llmProviders : undefined
  /** 紧凑模式下的读图路由摘要（收集后压成一行）。 */
  const routeNotes = []
  /** 读图子代理的厂商路由（llm-pi-ai 的 providers 行）与填写位置。 */
  const READER_ROUTES = {
    ask_glm: { provider: 'glm', where: 'llm-pi-ai providers.glm', settings: '设置 → 模型 → GLM 行' },
    ask_qwen: { provider: 'qwen-vl', where: 'llm-pi-ai providers.qwen-vl', settings: '设置 → 模型 → Qwen-VL 行' },
  }
  for (const { spec, status } of keyEntries) {
    const adapter = adapterOfCapability(spec.capability)
    const last = adapter === undefined ? undefined : health[adapter]
    const probe = adapter === undefined ? undefined : probes[adapter]
    const switchOn = switches[spec.capability] !== false
    const probeText = switchOn === false ? '—（已关闭）' : probe === undefined ? '未探测' : probe.ok === true ? `✅ ${probe.detail ?? ''}` : `❌ ${probe.code ?? ''} ${probe.detail ?? ''}`
    lines.push(
      '| ' + spec.capability + ' | ' + (switchOn ? '✅ 开' : '⛔ 关') + ' | ' + spec.ref + ' | ' + (status.configured ? '✅ 已配置' : '❌ 未配置') + ' | ' + (status.source ?? '—') + ' | ' + (last?.lastSuccess === undefined ? '—' : formatTime(last.lastSuccess)) + ' | ' + (last?.lastFailure === undefined ? '—' : formatTime(last.lastFailure)) + ' | ' + probeText + ' |',
    )
    const readerRoute = READER_ROUTES[spec.capability]
    if (readerRoute !== undefined) {
      const routeOk = knownProviders === undefined ? undefined : knownProviders.includes(readerRoute.provider)
      capability[spec.capability] = switchOn && status.configured && routeOk !== false
      // 紧凑模式把两条读图路由压成一行（每条 ~90 B 的样板）；verbose 保留逐行原文。
      if (verbose) {
        lines.push('')
        lines.push(`读图路由（${spec.capability} → ${readerRoute.where}）：` + (routeOk === undefined ? '无法确认' : routeOk ? '✅ 已注册' : `❌ 未注册（检查 ${readerRoute.where} 配置）`))
      } else {
        routeNotes.push(`${spec.capability}→${readerRoute.provider} ` + (routeOk === undefined ? '?' : routeOk ? '✅' : `❌（查 ${readerRoute.where}）`))
      }
      // 两个读图子代理互斥：同时开启时只有 GLM 生效，明确说清楚，避免"我开了为什么没用"。
      // ⚠ 这是**告警**，紧凑模式也必须出现。
      if (switchOn && routeOk !== false && status.configured && knownProviders !== undefined) {
        const other = spec.capability === 'ask_glm' ? 'ask_qwen' : 'ask_glm'
        if (switches[other] === false && readerConflict === true) lines.push(`⚠ 与 ${other} 同时处于开启状态：按互斥规则当前 ${spec.capability} 生效、${other} 被压制。请在 插件页 → gpt-CN → 配置卡 关掉其中一个。`)
      }
    } else if (adapter !== undefined && !claimedAdapters.has(adapter)) {
      claimedAdapters.add(adapter)
      capability[spec.capability] = switchOn && status.configured && probe?.ok !== false
    }
  }
  lines.push('')
  if (!verbose && routeNotes.length > 0) {
    lines.push('读图路由：' + routeNotes.join(' ｜ '))
    lines.push('')
  }
  // 「当前能力可用性」是上面那张表的口语版；紧凑模式下不重复（省 ~230 B/次），
  // 但**任何"不可用"的结论都必须在紧凑模式里也看得见** —— 所以下面只挑异常的报。
  const unavailable = Object.entries(capability).filter(([cap, ok]) => switches[cap] !== false && !ok)
  if (verbose) {
    lines.push('## 当前能力可用性')
    for (const [cap, ok] of Object.entries(capability)) {
      const switchedOn = switches[cap] !== false
      lines.push('- ' + cap + ': ' + (switchedOn === false ? '⛔ 已在设置中关闭' : ok ? '✅ 可用' : '❌ 当前不可用'))
    }
  } else if (unavailable.length > 0) {
    lines.push('⚠ 不可用：' + unavailable.map(([cap]) => cap).join('、') + '（加 verbose=true 看逐项原因）')
  }

  // ---- 单价表自检（2026-10-15 加）----
  // 为什么放在健康报表里、而不只写日志：这个插件最贵的一次故障（出片闸门 fail-closed、
  // 报表把真钱显示成 0）根因都在单价表，而**单价表的问题在对话里完全看不见**。
  // 放进 health 后，主模型和用户都能在对话中直接看到"哪个模型没价、哪条被 0 顶掉"。
  lines.push('')
  lines.push('## 单价表')
  const pricing = pricingOf(config)
  const modelRows = [
    ['qwen_draw（制图）', plainValue(config?.qwenModel)],
    ['seedance_video（出片）', plainValue(config?.seedanceModel)],
    ['video_gen（百炼出片）', plainValue(config?.videoModel)],
  ]
  /** 单价表里的单位是机器口径（image / second），给人看要说人话。 */
  const UNIT_LABEL = { image: '张', second: '秒', call: '次' }
  for (const [label, id] of modelRows) {
    if (typeof id !== 'string' || id.trim() === '') continue
    const entry = pricing?.[id]
    const priced = isPriced(entry)
    const unit =
      entry?.unit === 'ktoken'
        ? `入 ${money(unitPriceOf(entry, 'inputPrice'))} / 出 ${money(unitPriceOf(entry, 'outputPrice'))} 元/千token`
        : entry === undefined || entry.unitPrice === undefined
          ? '—'
          : `${entry.unitPrice} 元/${UNIT_LABEL[entry.unit] ?? entry.unit ?? '次'}`
    lines.push(`- ${label} → \`${id}\`：${priced ? '✅ 已计价（' + unit + '）' : '❌ **未计价**（提交会被花费闸门拒绝）'}`)
  }
  const pricingIssues = pricingWarnings(config, plainValue)
  if (pricingIssues.length === 0) {
    lines.push('- 自检：✅ 未发现问题（在用模型都有价，没有条目被 0 顶掉）')
  } else {
    lines.push('- 自检：❌ 发现 ' + pricingIssues.length + ' 个问题：')
    for (const issue of pricingIssues) lines.push('  - ' + issue)
  }
  // 探测缓存说明：纯样板，紧凑模式下省略（结论本身已经在表格里）。
  if (verbose) {
    lines.push('')
    lines.push('> 探测结果带 5 分钟缓存，只用于提示与建议，绝不据此自动改变行为。')
  }
  return lines.join('\n')
}

function adapterOfCapability(capability) {
  if (capability === 'qwen_draw') return 'dashscope-image'
  if (capability === 'seedance_video') return 'ark-video'
  if (capability === 'dashscope_video') return 'dashscope-video'
  return undefined
}

/**
 * 解包配置字段：生产里 `.volatile()` 字段是引用对象 `{ get() }`，
 * 测试里是裸值。两种都要能读，否则报表会在生产里渲染出 `[object Object]`。
 * @param {unknown} value - 配置字段值。
 * @returns {unknown} 裸值。
 */
function plainValue(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

/** 健康记录 → 最近成功/失败时间（工具在任务成功/失败时写入）。 */
export function mergeHealth(previous, { ok, at, detail }) {
  const next = { ...(previous ?? {}) }
  if (ok) next.lastSuccess = at
  else next.lastFailure = at
  if (detail !== undefined) next.detail = clip(detail, 200)
  return next
}
