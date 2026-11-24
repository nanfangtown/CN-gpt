/**
 * 智谱 GLM 探针离线验收（2026-11-21 修 P2：ask_glm 之前一直"未探测"）。
 *
 * 断言四件事：
 *   ① 200 + 清单里含 readerGlmModel → ok（一次 GET，不花钱）；
 *   ② 200 但清单里没有该模型 → 报 MODEL_UNAVAILABLE（否则读图员 spawn 才会失败）；
 *   ③ 401/403 → AUTH（点名 key 与基址），不误报成"端点不可用"；
 *   ④ 404 → 如实说"没有可用探测端点"，不当成鉴权失败。
 *
 * 运行：node --import ./tests/register.mjs ./tests/zhipu-probe.test.mjs
 */
import assert from 'node:assert/strict'
import { CODES } from '../core/errors.mjs'
import { ZHIPU_DEFAULT_BASE, modelIdsOf, resolveZhipuBase, zhipuVisionAdapter } from '../tasks/adapters/zhipu-vision.mjs'

const stats = { passed: 0, failed: 0 }
async function test(name, fn) {
  try {
    await fn()
    stats.passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    stats.failed += 1
    console.log('  ✗ ' + name)
    console.log('    ' + String(error?.stack ?? error).split('\n').slice(0, 8).join('\n    '))
  }
}

const CONFIG = { zhipuBase: ZHIPU_DEFAULT_BASE, readerGlmModel: 'glm-5.3-flash' }
const respond = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

await test('基址归一化：留空 / 缺协议 / 末尾斜杠 / 带 401 的默认值', () => {
  assert.equal(resolveZhipuBase({}), ZHIPU_DEFAULT_BASE)
  assert.equal(resolveZhipuBase({ zhipuBase: 'open.bigmodel.cn/api/paas/v4/' }), 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(resolveZhipuBase({ zhipuBase: '  ' }), ZHIPU_DEFAULT_BASE)
})

await test('模型清单兼容 data[].id 与 models[].slug 两种形态', () => {
  assert.deepEqual(modelIdsOf({ data: [{ id: 'glm-5.3-flash' }] }), ['glm-5.3-flash'])
  assert.deepEqual(modelIdsOf({ models: [{ slug: 'glm-5' }] }), ['glm-5'])
  assert.equal(modelIdsOf({ nothing: true }), undefined)
  assert.equal(modelIdsOf('nope'), undefined)
})

await test('200 且清单含配置模型 → ok（只发一次 GET）', async () => {
  const calls = []
  const result = await zhipuVisionAdapter.probe({
    credential: 'k',
    config: CONFIG,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method })
      return new Response(JSON.stringify({ data: [{ id: 'glm-4.6v' }, { id: 'glm-5.3-flash' }] }), { status: 200 })
    },
  })
  assert.equal(result.ok, true)
  assert.ok(result.detail.includes('glm-5.3-flash'), result.detail)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET', '探针只能用 GET：POST 一次就是一次计费')
  assert.ok(calls[0].url.endsWith('/models'))
})

await test('200 但清单里没有 readerGlmModel → MODEL_UNAVAILABLE（提示去核对白名单）', async () => {
  const result = await zhipuVisionAdapter.probe({
    credential: 'k',
    config: CONFIG,
    fetchImpl: respond(200, { data: [{ id: 'glm-4.6v' }] }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.MODEL_UNAVAILABLE)
  assert.ok(result.detail.includes('readerGlmModel'), result.detail)
  assert.ok(result.detail.includes('白名单'), result.detail)
})

await test('401 / 403 → AUTH，并点名 key 与基址', async () => {
  for (const status of [401, 403]) {
    const result = await zhipuVisionAdapter.probe({ credential: 'k', config: CONFIG, fetchImpl: respond(status, { error: { message: 'invalid key' } }) })
    assert.equal(result.ok, false, 'HTTP ' + status + ' 不该判成 ok')
    assert.equal(result.code, CODES.AUTH)
    assert.ok(result.detail.includes('ZHIPU_API_KEY'), result.detail)
    assert.ok(result.detail.includes(ZHIPU_DEFAULT_BASE), result.detail)
  }
})

await test('404 → UNAVAILABLE，并说清"探针不可用 ≠ key 无效"', async () => {
  const result = await zhipuVisionAdapter.probe({ credential: 'k', config: CONFIG, fetchImpl: respond(404, { error: { message: 'not found' } }) })
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.UNAVAILABLE)
  assert.ok(result.detail.includes('不代表 key 无效'), result.detail)
})

await test('429 → RATE_LIMIT；5xx → UNAVAILABLE；网络异常 → UNAVAILABLE 且不抛', async () => {
  assert.equal((await zhipuVisionAdapter.probe({ credential: 'k', config: CONFIG, fetchImpl: respond(429, {}) })).code, CODES.RATE_LIMIT)
  assert.equal((await zhipuVisionAdapter.probe({ credential: 'k', config: CONFIG, fetchImpl: respond(502, {}) })).code, CODES.UNAVAILABLE)
  const thrown = await zhipuVisionAdapter.probe({
    credential: 'k',
    config: CONFIG,
    fetchImpl: async () => { throw new Error('fetch failed: ECONNREFUSED') },
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.code, CODES.UNAVAILABLE)
  assert.ok(thrown.detail.includes('ECONNREFUSED'), thrown.detail)
})

console.log('\n[智谱 GLM 探针] 通过 ' + stats.passed + '，失败 ' + stats.failed)
if (stats.failed > 0) process.exitCode = 1
