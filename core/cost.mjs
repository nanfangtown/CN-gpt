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
    source: '⚠ 估算：21,700 tokens/秒（实测）× 70 元/百万（第三方来源，未经官方页核实）',
  },
  'doubao-seedance-2-0-fast-260128': {
    unit: 'second',
    unitPrice: 0.998,
    currency: 'CNY',
    asOf: '2026-10-15',
    tiers: [],
    source: '⚠ 估算：21,700 tokens/秒（实测）× 46 元/百万（第三方来源，未经官方页核实）',
  },
  'doubao-seedance-1-0-pro-fast-251015': {
    unit: 'second',
    unitPrice: 0.206,
    currency: 'CNY',
    asOf: '2026-10-15',
    tiers: [],
    source: 'https://www.bianews.com/news/details?id=223817',
  },
  // ---- Seedance 出片：**按模型 id 计价**，别再用 'seedance-2.0' ----
  //
  // 2026-10-15 加这三个键，起因是一个**闸门锁死事故**（值得记住）：
  //   - `seedanceModel` 在 10-15 从 'seedance-2.0' 改成 'doubao-seedance-2-5-260628'；
  //   - 但单价表里只有旧键 'seedance-2.0'，新模型 id **查不到价** → unitPriceOf() 返回 null；
  //   - 于是 spend-guard 走到"未计价"分支，估算金额是 null，而确认层要求一个精确数字，
  //     调用方给不出 → **fail-closed，出片工具彻底不可用**；
  //   - 全过程没有任何告警：模型 id 与单价表是两个独立字段，代码没做外键校验。
  // 对策有两层，缺一不可：① 这里把三个真实模型 id 都配上价；② 启动自检（pricingWarnings）
  // 会在"配置的模型查不到价"时直接在日志里点名，不再让它静默锁死。
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

/** 一条单价记录是否"已计价"（null / 非有限数 = 未计价）。 */
export function isPriced(entry) {
  if (entry === null || entry === undefined) return false
  if (entry.unit === 'ktoken') return unitPriceOf(entry, 'inputPrice') !== null || unitPriceOf(entry, 'outputPrice') !== null
  return unitPriceOf(entry) !== null
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
 * 所以不能像 `isPriced` 那样把 0 当成"已计价"。
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
  const defaultKeys = new Set(Object.keys(DEFAULT_PRICING))
  for (const key of Object.keys(table ?? {})) {
    if (known.has(key) || defaultKeys.has(key)) continue
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

async function readJsonFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      return { version: REGISTRY_VERSION, records: Array.isArray(parsed.records) ? parsed.records : [], health: parsed.health ?? {} }
    }
  } catch {
    // 首次运行 / 文件损坏 → 空账本（不阻塞任何工具）。
  }
  return { version: REGISTRY_VERSION, records: [], health: {} }
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
        unitPrice: z.number(),
        currency: z.string(),
        amount: z.number(),
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
        tables: { usage: domainTable(usageSchema), health: domainTable(healthSchema) },
      })
      domain = await facility.open(spec)
      backend = 'storage'
    } catch (error) {
      storageError = error
      log('warn', `[mm-models] storageDomain ledger unavailable; falling back to JSON file: ${clip(String(error?.message ?? error))}`)
    }
  }

  const filePath = ledgerFilePath(config)
  let fileState
  let writeChain = Promise.resolve()
  let sequence = 0
  const nextKey = () => `${Date.now().toString(36)}-${(sequence += 1).toString(36)}`

  async function loadFileState() {
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
    const full = { at, ...entry, amount: entry.amount === undefined ? amountOf(entry) : entry.amount }
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

  async function list(filter = {}) {
    try {
      if (backend === 'storage') {
        const rows = [...domain.table('usage').entries()].map(([, value]) => value)
        return applyFilter(rows, filter)
      }
      const state = await loadFileState()
      return applyFilter(state.records, filter)
    } catch (error) {
      log('warn', `[mm-models] ledger read failed: ${clip(String(error?.message ?? error))}`)
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
    return rows.filter((row) => {
      if (filter.sessionId !== undefined && row.sessionId !== filter.sessionId) return false
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
 * @param {object} options - records / config / scope / sessionId / now。
 * @returns {string}
 */
export function renderCostReport({ records, config, scope = 'session', sessionId, now = Date.now() }) {
  const pricing = pricingOf(config)
  const groups = summarizeRecords(records)
  const lines = []
  lines.push(`# 成本估算（scope: ${scope}${scope === 'session' && sessionId !== undefined ? `, session: ${sessionId}` : ''}）`)
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
      const priced = unitPriceOf(group) !== null
      if (!priced) unpriced += 1
      lines.push(
        `| ${group.provider} | ${group.model} | ${group.count} | ${unitsCell(group.units, group.unitKind)} | ${priceCell(group.unitPrice, group.currency, group.unitKind)} | ${priced ? money(group.amount, group.currency) : '未计价'} |`,
      )
      totals.set(group.currency, (totals.get(group.currency) ?? 0) + group.amount)
    }
    lines.push('')
    const totalText = [...totals.entries()].map(([currency, amount]) => money(amount, currency)).join('，')
    lines.push(
      `合计：${totalText}（只含已计价部分${unpriced > 0 ? `；另有 ${unpriced} 个型号未计价，实际花费高于此数` : ''}）`,
    )
  }
  const asOf = [...new Set(Object.values(pricing).map((entry) => entry?.asOf).filter((value) => typeof value === 'string' && value.length > 0))]
  // 只点出"本次真的用到、但没价"的型号；没用到的型号列出来只会让用户困惑。
  const usedModels = new Set(groups.map((group) => group.model))
  const unpricedNames = Object.entries(pricing)
    .filter(([model, entry]) => usedModels.has(model) && !isPriced(entry))
    .map(([model]) => model)
  lines.push('')
  // 读图子代理这一格必须一直交代清楚，它是本报表**唯一的结构性缺口**：
  // ask_glm / ask_qwen 的 token 由宿主 llm 服务经 pi-ai 路由产生，
  // 而 DSH 只在工具层给插件留了钩子（ctx.tools.guard），**没有请求级钩子** ——
  // `ctx.llm.stream()` 是"进入提供方适配器的唯一受支持路径"，插件拦不到它内部的调用。
  // 所以这一格不能算，只能如实说"没算"，并告诉用户去哪儿看真实用量。
  // 2026-10-15 核对：@deepseek-ai/dsh-llm 的 README.zh.md 明确写了这一点。
  const readerRoute = config?.enableAskQwen === true ? 'qwen-vl' : config?.enableAskGlm === true ? 'glm' : '未开启'
  lines.push(`单价表：${Object.keys(pricing).join('、')}${asOf.length > 0 ? `（取价日期 ${asOf.join('、')}）` : ''}。`)
  lines.push(
    `⚠ 读图子代理（ask_glm / ask_qwen，当前路由：${readerRoute}）的 token **未计入本报表**：` +
      `它们由宿主 llm 服务经 pi-ai 路由计费，插件层面没有请求级钩子，拦不到用量。` +
      `这一格的金额请以智谱 / 百炼控制台的用量统计为准（单价表里的 glm-4.6v 与 qwen3-vl-plus 只是给你对照用的价）。`,
  )
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
 * @param {object} options - keyEntries / health / probes / llmProviders / config。
 * @returns {string}
 */
export function renderHealthReport({ keyEntries, health = {}, probes = {}, llmProviders, config, switches = {}, readerConflict = false }) {
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
      lines.push('')
      lines.push(`读图路由（${spec.capability} → ${readerRoute.where}）：` + (routeOk === undefined ? '无法确认' : routeOk ? '✅ 已注册' : `❌ 未注册（检查 ${readerRoute.where} 配置）`))
      // 两个读图子代理互斥：同时开启时只有 GLM 生效，明确说清楚，避免"我开了为什么没用"。
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
  lines.push('## 当前能力可用性')
  for (const [cap, ok] of Object.entries(capability)) {
    const switchedOn = switches[cap] !== false
    lines.push('- ' + cap + ': ' + (switchedOn === false ? '⛔ 已在设置中关闭' : ok ? '✅ 可用' : '❌ 当前不可用'))
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
  ]
  for (const [label, id] of modelRows) {
    if (typeof id !== 'string' || id.trim() === '') continue
    const entry = pricing?.[id]
    const priced = isPriced(entry)
    const unit = entry?.unit === 'ktoken' ? `in ${money(unitPriceOf(entry, 'inputPrice'))} / out ${money(unitPriceOf(entry, 'outputPrice'))} 元/千token` : entry?.unitPrice === undefined ? '—' : `${entry.unitPrice} 元/${entry.unit ?? '次'}`
    lines.push(`- ${label} → \`${id}\`：${priced ? '✅ 已计价（' + unit + '）' : '❌ **未计价**（提交会被花费闸门拒绝）'}`)
  }
  const pricingIssues = pricingWarnings(config, plainValue)
  if (pricingIssues.length === 0) {
    lines.push('- 自检：✅ 未发现问题（在用模型都有价，没有条目被 0 顶掉）')
  } else {
    lines.push('- 自检：❌ 发现 ' + pricingIssues.length + ' 个问题：')
    for (const issue of pricingIssues) lines.push('  - ' + issue)
  }
  lines.push('')
  lines.push('> 探测结果带 5 分钟缓存，只用于提示与建议，绝不据此自动改变行为。')
  return lines.join('\n')
}

function adapterOfCapability(capability) {
  if (capability === 'qwen_draw') return 'dashscope-image'
  if (capability === 'seedance_video') return 'ark-video'
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
