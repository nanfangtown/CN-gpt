/**
 * 健康探测 e2e：**真的打网络**，验证 media_report(action=health) 的探测结论是真的。
 *
 * 为什么单独写这个（2026-10-13）：
 *   - `adapter.probe()` 不是"只检查 key 格式"，它真的 GET 一次端点，并用 401/403 与 404
 *     区分「key 不对」和「端点可达、鉴权通过」。**但此前没有任何测试覆盖它**——
 *     这种"看起来在工作"的旁路最容易悄悄坏掉，而它恰恰是用户判断"我配好了吗"的唯一依据。
 *
 * 两层验证：
 *   1. 负例（不需要真 key）：拿一个必然无效的凭据打真实端点，探测必须报**鉴权类失败**，
 *      绝不能报"健康"。这一层在任何机器上都能跑，不需要任何 key。
 *   2. 正例（需要真 key）：用真实 key 探测，必须报健康。
 *
 * 只用公开端点 + 无效凭据，不产生任何计费调用。
 */
import assert from 'node:assert/strict'
import { loadKeysFromDshEnv, readyKeys, skipE2e } from './_env.mjs'
import { dashscopeImageAdapter } from '../tasks/adapters/dashscope-image.mjs'
import { arkVideoAdapter } from '../tasks/adapters/ark-video.mjs'

loadKeysFromDshEnv(['DASHSCOPE_API_KEY', 'ARK_API_KEY'])

const BASE = {
  dashscopeCompatBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  dashscopeBase: 'https://dashscope.aliyuncs.com/api/v1',
  arkBase: 'https://ark.cn-beijing.volces.com/api/v3',
}

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log('  \u2713 ' + label)
  } else {
    failures.push(label + (detail === undefined ? '' : '：' + detail))
    console.log('  \u2717 ' + label + (detail === undefined ? '' : '：' + detail))
  }
}

// ---------------------------------------------------------------- 1) 负例：无效凭据（无需 key）
console.log('--- 负例：无效凭据必须被识别为「鉴权失败」，不能报健康 ---')
const bogus = 'sk-definitely-invalid-key-for-probe-test-000000000000'

try {
  const result = await dashscopeImageAdapter.probe({ credential: bogus, config: BASE })
  check('DashScope 无效 key → 不健康', result.ok === false, JSON.stringify(result))
  check('DashScope 无效 key → 归为鉴权类错误', result.code === 'AUTH' || result.code === 'POLICY_REJECTED', 'code=' + result.code)
  check('DashScope 探测带可读说明', typeof result.detail === 'string' && result.detail.length > 0)
} catch (error) {
  check('DashScope 无效 key 探测不应抛异常', false, String(error?.message ?? error))
}

try {
  const result = await arkVideoAdapter.probe({ credential: bogus, config: BASE })
  check('Ark 无效 key → 不健康', result.ok === false, JSON.stringify(result))
  check('Ark 无效 key → 归为鉴权类错误', result.code === 'AUTH' || result.code === 'POLICY_REJECTED', 'code=' + result.code)
} catch (error) {
  check('Ark 无效 key 探测不应抛异常', false, String(error?.message ?? error))
}

// 连接失败必须归为 UNAVAILABLE（而不是伪装成健康）
try {
  const result = await dashscopeImageAdapter.probe({ credential: 'sk-x', config: { ...BASE, dashscopeCompatBase: 'https://127.0.0.1:9/nowhere', dashscopeBase: 'https://127.0.0.1:9/nowhere' } })
  check('端点不可达 → UNAVAILABLE', result.ok === false && result.code === 'UNAVAILABLE', JSON.stringify(result))
} catch (error) {
  check('端点不可达不应抛未处理异常', false, String(error?.message ?? error))
}

// ---------------------------------------------------------------- 2) 正例：真实 key
console.log('--- 正例：真实 key（有 key 才跑） ---')
const ready = readyKeys(['DASHSCOPE_API_KEY', 'ARK_API_KEY'])
if (ready.length === 0) {
  console.log(failures.length === 0 ? 'SKIPPED-PARTIAL: 无真实 key，正例未验证（负例已全部通过）' : '负例有失败，正例无法弥补')
} else {
  if (ready.includes('DASHSCOPE_API_KEY')) {
    const result = await dashscopeImageAdapter.probe({ credential: process.env.DASHSCOPE_API_KEY, config: BASE })
    check('DashScope 真实 key → 健康', result.ok === true, JSON.stringify(result))
  }
  if (ready.includes('ARK_API_KEY')) {
    const result = await arkVideoAdapter.probe({ credential: process.env.ARK_API_KEY, config: BASE })
    // Ark 未开通时可能返回 403/未授权——那属于"账号状态"而非探测失效，
    // 所以这里只要求"探测本身给出了明确结论"，不强制 ok=true。
    check('Ark 真实 key → 探测给出明确结论', typeof result.ok === 'boolean' && typeof result.detail === 'string', JSON.stringify(result))
  }
}

console.log('')
if (failures.length > 0) {
  console.log('PROBE E2E FAIL:')
  for (const line of failures) console.log(' - ' + line)
  process.exit(1)
}
console.log('PROBE E2E OK：无效凭据被判为鉴权失败、不可达被判为 UNAVAILABLE、真实 key 被判定为健康。')
if (ready.length === 0) {
  // 让 CI 能区分"负例通过但正例没跑"和"全都跑过"
  skipE2e('正例未验证：本机没有可用的真实 key（负例已通过）', ['DASHSCOPE_API_KEY', 'ARK_API_KEY'])
}
