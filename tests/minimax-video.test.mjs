/**
 * MiniMax 视频适配器离线验收（不联网、不需要 key、不花钱）。
 *
 * 钉住的是 2026-10-20 核对到的 v1 协议要点：
 *   - POST /v1/video_generation 的三种玩法（T2V / I2V / 首尾帧）；
 *   - HTTP 200 也可能失败：必须看 base_resp.status_code；
 *   - 查询返回 Success/Fail（大小写混用）→ 统一小写映射；
 *   - 成功只给 file_id，下载前必须再调 /v1/files/retrieve 换 download_url；
 *   - 按条计费（分辨率 × 时长），tiers 缺档必须 fail-closed。
 *
 * 运行：node tests/minimax-video.test.mjs
 */
import assert from 'node:assert/strict'
import { CODES } from '../core/errors.mjs'
import {
  MINIMAX_DEFAULT_BASE,
  MINIMAX_DEFAULT_MODEL,
  MINIMAX_MODELS,
  mapVendorCode,
  minimaxVideoAdapter,
  resolveMinimaxBase,
  resolveMinimaxModel,
  validateMinimaxSpec,
} from '../tasks/adapters/minimax-video.mjs'

let failed = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    failed += 1
    console.log('  ✗ ' + name)
    console.log('    ' + String(error?.message ?? error).split('\n').slice(0, 8).join('\n    '))
  }
}

const config = { minimaxBase: MINIMAX_DEFAULT_BASE }
const credential = 'test-key'

test('默认模型 / 基址 / 模型表', () => {
  assert.equal(MINIMAX_DEFAULT_MODEL, 'MiniMax-Hailuo-02')
  assert.equal(MINIMAX_DEFAULT_BASE, 'https://api.minimax.cn')
  assert.equal(resolveMinimaxModel('hailuo-02').id, 'MiniMax-Hailuo-02')
  assert.equal(resolveMinimaxModel('MiniMax-Hailuo-2.3-Fast').alias, 'hailuo-2.3-fast')
  assert.equal(resolveMinimaxModel('video-01'), undefined, '历史 id 不应被接受')
  assert.equal(MINIMAX_MODELS['hailuo-2.3-fast'].t2v, false, 'Fast 只支持图生视频')
})

test('基址归一化：带 /v1、带尾斜杠、不带协议都能用', () => {
  assert.equal(resolveMinimaxBase({ minimaxBase: 'https://api.minimax.io/' }), 'https://api.minimax.io')
  assert.equal(resolveMinimaxBase({ minimaxBase: 'https://api.minimax.io/v1' }), 'https://api.minimax.io')
  assert.equal(resolveMinimaxBase({ minimaxBase: 'api.minimaxi.com' }), 'https://api.minimaxi.com')
})

test('T2V 提交体：model / prompt / duration / resolution', () => {
  const request = minimaxVideoAdapter.buildSubmit(
    { model: 'MiniMax-Hailuo-02', prompt: '雨夜校园，霓虹', duration: 6, resolution: '768P' },
    { credential, config },
  )
  assert.equal(request.url, 'https://api.minimax.cn/v1/video_generation')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, {
    model: 'MiniMax-Hailuo-02',
    prompt: '雨夜校园，霓虹',
    duration: 6,
    resolution: '768P',
  })
})

test('I2V：首帧图 data URL 放进 first_frame_image；512P 只允许图生', () => {
  const request = minimaxVideoAdapter.buildSubmit(
    { model: 'MiniMax-Hailuo-02', prompt: '', image: { dataUrl: 'data:image/png;base64,AAAA' }, duration: 6, resolution: '512P' },
    { credential, config },
  )
  assert.equal(request.body.first_frame_image, 'data:image/png;base64,AAAA')
  assert.equal(request.body.prompt, undefined)
  assert.throws(
    () => minimaxVideoAdapter.buildSubmit({ model: 'MiniMax-Hailuo-02', prompt: '只有文字', duration: 6, resolution: '512P' }, { credential, config }),
    /512P 只用于图生视频/,
  )
})

test('首尾帧：只有 Hailuo-02 支持；2.3 明确拒绝', () => {
  const request = minimaxVideoAdapter.buildSubmit(
    {
      model: 'MiniMax-Hailuo-02',
      prompt: '镜头推进',
      image: { url: 'https://example.com/a.png' },
      lastImage: { url: 'https://example.com/b.png' },
      duration: 6,
      resolution: '768P',
    },
    { credential, config },
  )
  assert.equal(request.body.first_frame_image, 'https://example.com/a.png')
  assert.equal(request.body.last_frame_image, 'https://example.com/b.png')
  assert.throws(
    () =>
      minimaxVideoAdapter.buildSubmit(
        { model: 'MiniMax-Hailuo-2.3', prompt: 'x', image: { url: 'https://a' }, lastImage: { url: 'https://b' } },
        { credential, config },
      ),
    /不支持首尾帧/,
  )
})

test('规格校验：Fast 只能图生；1080P 只能 6 秒；未知模型/分辨率被拒', () => {
  assert.throws(() => validateMinimaxSpec({ model: 'MiniMax-Hailuo-2.3-Fast', prompt: '只有文字' }), /只支持图生视频/)
  assert.throws(() => validateMinimaxSpec({ model: 'MiniMax-Hailuo-02', prompt: 'x', resolution: '1080P', duration: 10 }), /只支持 6 秒/)
  assert.throws(() => validateMinimaxSpec({ model: 'video-01', prompt: 'x' }), /未知的 MiniMax 视频模型/)
  assert.throws(() => validateMinimaxSpec({ model: 'MiniMax-Hailuo-02', prompt: 'x', resolution: '2K' }), /不支持分辨率/)
})

test('base_resp：HTTP 200 + status_code=0 才算提交成功', () => {
  assert.deepEqual(minimaxVideoAdapter.parseSubmit({ task_id: 't1', base_resp: { status_code: 0, status_msg: 'success' } }), { taskId: 't1' })
  assert.throws(
    () => minimaxVideoAdapter.parseSubmit({ base_resp: { status_code: 1004, status_msg: 'login fail' } }),
    (error) => error.code === CODES.AUTH && /login fail/.test(error.message),
  )
})

test('错误码映射：限流 / 鉴权 / 余额 / 审核 / 参数', () => {
  assert.equal(mapVendorCode(1002), CODES.RATE_LIMIT)
  assert.equal(mapVendorCode(1004), CODES.AUTH)
  assert.equal(mapVendorCode(1008), CODES.QUOTA)
  assert.equal(mapVendorCode(1026), CODES.POLICY_REJECTED)
  assert.equal(mapVendorCode(2013), CODES.BAD_REQUEST)
  assert.equal(mapVendorCode(1013), CODES.UNAVAILABLE)
})

test('查询状态：Success / Processing / Fail（统一小写）', () => {
  const ok = minimaxVideoAdapter.parseQuery({ status: 'Success', file_id: '123', base_resp: { status_code: 0 } }, { taskId: 't1' })
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.fileId, '123')
  assert.deepEqual(ok.artifacts, [])

  const running = minimaxVideoAdapter.parseQuery({ status: 'Processing', base_resp: { status_code: 0 } }, { taskId: 't1' })
  assert.equal(running.status, 'running')

  const failed = minimaxVideoAdapter.parseQuery({ status: 'Fail', base_resp: { status_code: 0, status_msg: 'fail' } }, { taskId: 't1' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.detail, 'fail')

  // 查询阶段的内容审核失败用 base_resp 报错：按 POLICY_REJECTED 抛出，而不是伪装成“任务失败”。
  assert.throws(
    () => minimaxVideoAdapter.parseQuery({ status: 'Fail', base_resp: { status_code: 1027, status_msg: 'sensitive' } }, { taskId: 't1' }),
    (error) => error.code === CODES.POLICY_REJECTED,
  )
})

test('取文件：file_id → file.download_url', async () => {
  const calls = []
  const fakeFetch = async (url) => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ file: { file_id: 123, download_url: 'https://cdn.example.com/v.mp4' }, base_resp: { status_code: 0 } })
      },
    }
  }
  const urls = await minimaxVideoAdapter.resolveArtifacts({ fileId: '123' }, { credential, config, fetchImpl: fakeFetch })
  assert.deepEqual(urls, ['https://cdn.example.com/v.mp4'])
  assert.ok(calls[0].includes('/v1/files/retrieve?file_id=123'))
})

test('按条计价：768P 6s=2 / 10s=4 / 1080P 6s=3.5；缺档返回 null', () => {
  const pricing = {
    'MiniMax-Hailuo-02': {
      unit: 'call',
      unitPrice: 2,
      currency: 'CNY',
      tiers: [
        { resolution: '768P', duration: 6, unitPrice: 2 },
        { resolution: '768P', duration: 10, unitPrice: 4 },
        { resolution: '1080P', duration: 6, unitPrice: 3.5 },
      ],
    },
  }
  const a = minimaxVideoAdapter.estimateCost({ model: 'MiniMax-Hailuo-02', resolution: '768P', duration: 6 }, pricing)
  assert.equal(a.unitKind, 'call')
  assert.equal(a.units, 1)
  assert.equal(a.unitPrice, 2)
  assert.equal(a.amount, 2)
  const b = minimaxVideoAdapter.estimateCost({ model: 'MiniMax-Hailuo-02', resolution: '768P', duration: 10 }, pricing)
  assert.equal(b.unitPrice, 4)
  const c = minimaxVideoAdapter.estimateCost({ model: 'MiniMax-Hailuo-02', resolution: '1080P', duration: 6 }, pricing)
  assert.equal(c.unitPrice, 3.5)
  const missing = minimaxVideoAdapter.estimateCost({ model: 'MiniMax-Hailuo-02', resolution: '1080P', duration: 10 }, pricing)
  assert.equal(missing.unitPrice, null, 'tiers 存在但缺档必须 fail-closed')
})

test('健康探测：1004 = AUTH；文件不存在（非鉴权错误）= 端点可达', async () => {
  const auth = await minimaxVideoAdapter.probe({
    credential,
    config,
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'login fail' } }) } }),
  })
  assert.equal(auth.ok, false)
  assert.equal(auth.code, CODES.AUTH)

  const reachable = await minimaxVideoAdapter.probe({
    credential,
    config,
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ base_resp: { status_code: 2013, status_msg: 'file not found' } }) } }),
  })
  assert.equal(reachable.ok, true, '鉴权通过、文件不存在应算可达：' + JSON.stringify(reachable))
})

console.log('\n[MiniMax 适配器] 通过 ' + passed + '，失败 ' + failed)
if (failed > 0) process.exitCode = 1
