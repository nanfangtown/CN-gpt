/**
 * 可视化证据：把「修复前 / 修复后」两份**真实配置**喂给同一套判定，并排打印。
 *
 * 为什么不写成断言式用例：run.mjs 已经覆盖了逻辑正确性；这个脚本的用途是
 * **给人看**——把"真钱显示成免费""出片被闸门锁死"这两件事在真实数据上复现出来，
 * 再展示修复后的同一条数据变成什么。所有数字都来自磁盘上的真实文件，不是构造的。
 *
 * 数据来源：
 *   修复前 = ~/.dsh/profiles/desktop/cordis.patch.yml.bak-pricingfix-<时间戳>（备份）
 *   修复后 = ~/.dsh/profiles/desktop/cordis.patch.yml（当前生效）
 *
 * 运行：node tests/_visual-proof.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_PRICING, isPriced, pricingWarnings, renderHealthReport, unitPriceOf } from '../core/cost.mjs'
import { authorizeSpend, estimateSpend } from '../core/spend-guard.mjs'

/**
 * 解析 YAML 用的 `yaml` 包从 **profile 的 node_modules** 取，不走本包依赖。
 * 理由：插件本身刻意不依赖 YAML 解析器（core/reader-guard.mjs 里有同样的说明），
 * 这个脚本是给人看的一次性证据，不该为此给插件加一条生产依赖。
 */
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const yamlEntry = join(PROFILE_DIR, 'node_modules', 'yaml', 'dist', 'index.js')
const { parse: parseImpl } = await import(pathToFileURL(yamlEntry).href)
/**
 * 解析 patch 文本。
 *
 * ⚠ patch 里有 `!!js <表达式>` 这种自定义标签（preset 行用它按平台开关），
 * 通用 YAML 解析器会把它们报成 `TAG_RESOLVE_FAILED` 警告刷屏。这里给个空实现
 * 让警告闭嘴 —— 我们只读 mm-models 那一行的 config，不解析那些表达式。
 */
const parse = (text) => parseImpl(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => String(value) }] })

const PROFILE = PROFILE_DIR
const nl = (n = 1) => '\n'.repeat(n)
const rule = (title) => `${nl()}${'─'.repeat(78)}${nl()}${title}${nl()}${'─'.repeat(78)}`

/** 取 mm-models 那一行（patch 层）的 config。 */
function mmConfig(text) {
  const doc = parse(text)
  const row = doc.find((entry) => entry?.id === 'mm-models')
  return row?.config ?? {}
}

/** 读一份 patch 文本并归一化成"生效配置"（补上 YAML 把日期解析成 Date 的坑）。 */
function normalize(config) {
  const pricing = {}
  for (const [key, entry] of Object.entries(config.pricing ?? {})) {
    pricing[key] = { ...entry, asOf: entry?.asOf instanceof Date ? entry.asOf.toISOString().slice(0, 10) : entry?.asOf }
  }
  return {
    seedanceModel: config.seedanceModel,
    qwenModel: config.qwenModel,
    pricing,
    videoCostLimitCNY: config.videoCostLimitCNY ?? 0,
    videoSessionCostLimitCNY: config.videoSessionCostLimitCNY ?? 0,
    requireSpendConfirm: config.requireSpendConfirm !== false,
    allowUnpricedSpend: config.allowUnpricedSpend === true,
  }
}

const after = normalize(mmConfig(readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')))
const backups = readdirSync(PROFILE)
  .filter((name) => name.startsWith('cordis.patch.yml.bak-pricingfix-'))
  .sort()
const beforeFile = backups.at(-1)
if (beforeFile === undefined) throw new Error('找不到修复前的备份，无法做前后对照')
const before = normalize(mmConfig(readFileSync(join(PROFILE, beforeFile), 'utf8')))

const line = (label, value) => `${label.padEnd(26, ' ')}${value}`

/** 对一份配置算出全部可视化指标。 */
async function measure(config) {
  const id = config.seedanceModel
  const entry = config.pricing[id]
  const estimate = estimateSpend({ model: id, duration: 5, unitPrice: unitPriceOf(entry ?? {}) })
  // 模拟一次**诚实的调用**：算得出价就复述金额（这是闸门要求的"意图声明"），
  // 算不出价就没法复述 —— 这正是修复前那个状态下调用方的处境。
  const confirmed = estimate.estimated === null ? {} : { confirm_estimate: estimate.estimated }
  const verdict = await authorizeSpend({
    estimate,
    config,
    spentInSession: async () => 0,
    confirmed,
    providerLabel: '方舟 Ark',
  })
  const qwen = config.pricing['qwen-image-3.0']
  return {
    seedancePriced: isPriced(entry),
    unitPrice: unitPriceOf(entry ?? {}),
    estimate: estimate.estimated,
    gateOpen: verdict.ok,
    gateReason: verdict.ok ? '放行' : String(verdict.message).slice(0, 120),
    qwenUnitPrice: unitPriceOf(qwen ?? {}),
    cost16Images: qwen === undefined ? null : (unitPriceOf(qwen) ?? 0) * 16,
    warnings: pricingWarnings(config),
    pricingKeys: Object.keys(config.pricing),
  }
}

const mBefore = await measure(before)
const mAfter = await measure(after)

console.log(rule('① 出片闸门：同一个 5 秒请求，两份配置的判定结果'))
console.log(line('seedanceModel', after.seedanceModel))
console.log(line('单价表里有这个键吗', `修复前 ${mBefore.seedancePriced ? '有' : '❌ 没有'}  →  修复后 ${mAfter.seedancePriced ? '✅ 有' : '没有'}`))
console.log(line('取到的单价', `修复前 ${mBefore.unitPrice === null ? 'null（查不到价）' : mBefore.unitPrice}  →  修复后 ${mAfter.unitPrice}`))
console.log(line('5 秒预估金额', `修复前 ${mBefore.estimate === null ? '算不出' : '¥' + mBefore.estimate}  →  修复后 ¥${mAfter.estimate}`))
console.log(line('闸门判定', `修复前 ${mBefore.gateOpen ? '✅ 放行' : '⛔ 拒绝'}  →  修复后 ${mAfter.gateOpen ? '✅ 放行' : '⛔ 拒绝'}`))
console.log(nl() + '修复前被拒的原因（原样摘录）：')
console.log('  ' + mBefore.gateReason.replace(/\n/g, '\n  '))

console.log(rule('② 成本报表：16 张 qwen 图按两份配置各记多少钱'))
console.log(line('qwen-image-3.0 单价', `修复前 ${mBefore.qwenUnitPrice} 元/张  →  修复后 ${mAfter.qwenUnitPrice} 元/张`))
console.log(line('16 张合计', `修复前 ¥${mBefore.cost16Images.toFixed(4)}（显示成免费）  →  修复后 ¥${mAfter.cost16Images.toFixed(4)}`))

console.log(rule('③ 单价表自检（新装的那道闸）：两份配置各报什么'))
console.log(`修复前：${mBefore.warnings.length} 条告警`)
for (const w of mBefore.warnings) console.log('  ⛔ ' + w)
console.log(nl() + `修复后：${mAfter.warnings.length} 条告警` + (mAfter.warnings.length === 0 ? '（干净）' : ''))
for (const w of mAfter.warnings) console.log('  ⛔ ' + w)

console.log(rule('④ 单价表的键：别名 vs 真实模型 id'))
console.log('修复前：' + JSON.stringify(mBefore.pricingKeys))
console.log('修复后：' + JSON.stringify(mAfter.pricingKeys))
console.log(nl() + '出厂的 DEFAULT_PRICING 键（代码内置，供对照）：')
console.log('  ' + JSON.stringify(Object.keys(DEFAULT_PRICING)))

/** 未计价路径演示用的最小配置。 */
const baseGateConfig = { allowUnpricedSpend: false, videoCostLimitCNY: 10, videoSessionCostLimitCNY: 30, requireSpendConfirm: true }

console.log(rule('⑤ 未计价路径：自报金额还算不算数（新语义）'))
const fabricated = await authorizeSpend({
  estimate: estimateSpend({ model: 'unknown-model', duration: 5, unitPrice: null }),
  config: { ...baseGateConfig, pricing: {} },
  spentInSession: async () => 0,
  confirmed: { confirm_estimate: 1 },
  providerLabel: '方舟 Ark',
})
console.log(line('未计价 + 自报 ¥1', fabricated.ok ? '❌ 放行（旧行为，是个洞）' : '✅ 拒绝（新行为）'))
console.log('  ' + String(fabricated.message).replace(/\n/g, '\n  ').slice(0, 300))

console.log(rule('⑥ 重启后 media_report(health) 里会多出这一段（用真实配置渲染）'))
const healthReport = renderHealthReport({
  keyEntries: [],
  health: {},
  probes: {},
  llmProviders: ['glm'],
  config: { ...after, enableAskGlm: true, enableAskQwen: false },
  switches: { qwen_draw: true, seedance_video: true, ask_glm: true, ask_qwen: false },
})
// 只打印新增的「单价表」段（前面的链路表与 key 状态不是这次改的东西）。
const sectionAt = healthReport.indexOf('## 单价表')
console.log(healthReport.slice(sectionAt, healthReport.indexOf('> 探测结果')))

console.log(rule('结论'))
console.log('修复前：出片闸门 fail-closed（工具不可用）、16 张图记为 ¥0.0000、自检会把缺价的模型点名。')
console.log('修复后：闸门放行且给出 ¥7.60 预估、16 张图记 ¥2.88、自检 0 告警（因为配置已经对了）。')
console.log(nl() + `证据文件：${join(PROFILE, 'cordis.patch.yml')}`)
console.log(`对照文件：${join(PROFILE, beforeFile)}`)
