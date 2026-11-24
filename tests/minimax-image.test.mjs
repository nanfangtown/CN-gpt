/**
 * MiniMax H3-Image adapter 离线验收：规格校验 / 请求形状 / 部分失败 / 错误归因 / 计费档位 / 探活。
 *
 * 不联网、不需要 key、不花钱。断言的重点是那三条与其它厂商不同的硬约束：
 *   ① 部分失败也是 200（data[].error）；② 同步（没有 task_id）；③ size 与 area 互斥。
 *
 * 运行：node --import ./tests/register.mjs ./tests/minimax-image.test.mjs
 */
import assert from 'node:assert/strict'
import { CODES } from '../core/errors.mjs'
import {
  MINIMAX_IMAGE_DEFAULT_MODEL,
  areaOfSize,
  minimaxImageAdapter,
  sizeForH3Edit,
  validateMinimaxImageSpec,
} from '../tasks/adapters/minimax-image.mjs'

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

const CONFIG = { minimaxBase: 'https://api.minimax.cn' }
const CRED = 'test-key'

const baseSpec = (overrides = {}) => ({ model: MINIMAX_IMAGE_DEFAULT_MODEL, prompt: '一只橘猫趴在窗台上', ...overrides })

await test('规格：未知模型 / 空 prompt / n 越界 都在提交前拒绝', () => {
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ model: 'MiniMax-Nope' })), (error) => error.code === CODES.BAD_REQUEST)
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ prompt: '   ' })), (error) => error.code === CODES.BAD_REQUEST)
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ n: 0 })), (error) => error.code === CODES.BAD_REQUEST)
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ n: 11 })), (error) => error.code === CODES.BAD_REQUEST)
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ prompt: 'x'.repeat(32001) })), (error) => error.code === CODES.BAD_REQUEST)
})

await test('规格：默认 area=1K（不接受"不填就按 4K 下单"），format 归一化', () => {
  const text = validateMinimaxImageSpec(baseSpec())
  assert.equal(text.mode, 'text')
  assert.equal(text.area, '1K')
  assert.equal(text.format, 'jpeg')
  assert.deepEqual(text.images, [])
  assert.equal(validateMinimaxImageSpec(baseSpec({ format: 'jpg' })).format, 'jpeg')
  assert.equal(validateMinimaxImageSpec(baseSpec({ format: 'png' })).format, 'png')
  assert.equal(validateMinimaxImageSpec(baseSpec({ format: 'webp' })).format, 'webp')
})

await test('规格：size 与 area 互斥（官方同时传 400，这里提前拦并说清怎么选）', () => {
  assert.throws(
    () => validateMinimaxImageSpec(baseSpec({ size: '1360x768', area: '2K' })),
    (error) => error.code === CODES.BAD_REQUEST && /互斥/.test(error.message),
  )
  const ok = validateMinimaxImageSpec(baseSpec({ size: '1360x768' }))
  assert.equal(ok.size, '1360x768')
  // 未给 area：取价档位必须按像素反推（1360×768 < 1024² → 1K）
  assert.equal(ok.area, '1K')
})

await test('规格：size 的面积 / 比例边界（官方 655,360–20,000,000 px、≤3:1）', () => {
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ size: '100x100' })), (error) => /面积/.test(error.message))
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ size: '8000x8000' })), (error) => /面积/.test(error.message))
  assert.throws(() => validateMinimaxImageSpec(baseSpec({ size: '3000x600' })), (error) => /宽高比|3:1/.test(error.message))
  // 正好在边界上：1024x1024 与 3:1 都应通过
  assert.equal(validateMinimaxImageSpec(baseSpec({ size: '1024x1024' })).size, '1024x1024')
  assert.equal(validateMinimaxImageSpec(baseSpec({ size: '1773x591' })).size, '1773x591')
})

await test('规格：参考图 1–16 张；超过点名拒绝', () => {
  const imgs = (count) => Array.from({ length: count }, (_, index) => ({ url: `https://example.com/${index}.png` }))
  assert.equal(validateMinimaxImageSpec(baseSpec({ images: imgs(1) })).mode, 'edit')
  assert.equal(validateMinimaxImageSpec(baseSpec({ images: imgs(16) })).mode, 'edit')
  assert.throws(
    () => validateMinimaxImageSpec(baseSpec({ images: imgs(17) })),
    (error) => error.code === CODES.BAD_REQUEST && /最多 16 张/.test(error.message),
  )
})

await test('请求：文生图走 /v1/images/generations，body 带 size=auto + area', () => {
  const request = minimaxImageAdapter.buildSubmit(baseSpec({ area: '2K', n: 2 }), { credential: CRED, config: CONFIG })
  assert.ok(request.url.endsWith('/v1/images/generations'), request.url)
  assert.equal(request.method, 'POST')
  assert.equal(request.body.model, MINIMAX_IMAGE_DEFAULT_MODEL)
  assert.equal(request.body.n, 2)
  assert.equal(request.body.response_format, 'url')
  assert.equal(request.body.output_format, 'jpeg')
  assert.equal(request.body.size, 'auto')
  assert.equal(request.body.area, '2K')
  assert.equal(request.body.images, undefined)
  assert.equal(request.headers.Authorization, 'Bearer ' + CRED)
})

await test('请求：图生图走 /v1/images/edits，images[] 顺序即图1/图2；没给 size 时沿用参考图尺寸', () => {
  const images = [
    { dataUrl: 'data:image/png;base64,AAAA', display: 'a.png', width: 1024, height: 768 },
    { url: 'https://example.com/b.png' },
  ]
  const request = minimaxImageAdapter.buildSubmit(baseSpec({ prompt: '把图1的猫换成图2的柴犬', images }), {
    credential: CRED,
    config: CONFIG,
  })
  assert.ok(request.url.endsWith('/v1/images/edits'), request.url)
  assert.deepEqual(request.body.images, [{ image_url: images[0].dataUrl }, { image_url: images[1].url }])
  // 参考图 1024×768：在官方区间内，直接沿用（避免服务端默认 4K）
  assert.equal(request.body.size, '1024x768')
  assert.equal(request.body.area, undefined)
})

await test('请求：参考图尺寸不可用时退回 size=auto + area（而不是静默用 4K）', () => {
  const request = minimaxImageAdapter.buildSubmit(baseSpec({ images: [{ url: 'https://example.com/x.png' }], area: '2K' }), {
    credential: CRED,
    config: CONFIG,
  })
  assert.equal(request.body.size, 'auto')
  assert.equal(request.body.area, '2K')
})

await test('响应：部分成功（200 + data[] 里混着 error）→ 成功项进产物，成功张数取 usage', () => {
  const parsed = minimaxImageAdapter.parseSubmit({
    request_id: 'req-1',
    data: [
      { url: 'https://example.com/0.jpg', size: '1024x1024', revised_prompt: '猫' },
      { error: { code: '1027', message: 'output image failed content safety check' } },
    ],
    output_format: 'jpeg',
    usage: { generated_images: 1, total_tokens: 7254 },
  })
  assert.equal(parsed.taskId, 'req-1')
  assert.equal(parsed.state.status, 'succeeded')
  assert.deepEqual(parsed.state.artifacts, ['https://example.com/0.jpg'])
  assert.equal(parsed.state.usage.imageCount, 1)
  assert.equal(parsed.state.partialFailures.length, 1)
  assert.equal(parsed.state.partialFailures[0].code, '1027')
})

await test('响应：全部失败 → 状态失败，且内容安全归到 POLICY_REJECTED（不是"参数不对"）', () => {
  const parsed = minimaxImageAdapter.parseSubmit({
    request_id: 'req-2',
    data: [{ error: { code: '1027', message: 'output image failed content safety check' } }],
    usage: { generated_images: 0 },
  })
  assert.equal(parsed.state.status, 'failed')
  assert.equal(parsed.state.error.code, CODES.POLICY_REJECTED)
  assert.equal(parsed.state.usage.imageCount, 0)
})

await test('计费：按 模式×面积 取档位价；无档位 → null（fail-closed），不是兜底价', () => {
  const pricing = {
    'MiniMax-H3-Image': {
      unit: 'image',
      unitPrice: 0.1531,
      currency: 'CNY',
      tiers: [
        { mode: 'text', area: '1K', unitPrice: 0.143 },
        { mode: 'text', area: '2K', unitPrice: 0.1531 },
        { mode: 'edit', area: '1K', unitPrice: 0.2346 },
      ],
    },
  }
  const text = minimaxImageAdapter.estimateCost(baseSpec({ area: '1K', n: 2 }), pricing)
  assert.equal(text.unitKind, 'image')
  assert.equal(text.unitPrice, 0.143)
  assert.equal(text.amount, 0.286)
  const edit = minimaxImageAdapter.estimateCost(
    baseSpec({ area: '1K', images: [{ url: 'https://example.com/x.png' }] }),
    pricing,
  )
  assert.equal(edit.mode, 'edit')
  assert.equal(edit.unitPrice, 0.2346)
  // 档位缺失（4K 没配）→ null；绝不能退回 entry.unitPrice 悄悄放行
  assert.equal(minimaxImageAdapter.estimateCost(baseSpec({ area: '4K' }), pricing).unitPrice, null)
  // 模型不在表里 → null
  assert.equal(minimaxImageAdapter.estimateCost(baseSpec({ model: 'unknown' }), pricing).unitPrice, null)
})

await test('HTTP 错误归因：422/内容安全 → POLICY_REJECTED；402 → QUOTA；401 → AUTH；429 → RATE_LIMIT；500 → UNAVAILABLE', () => {
  const body422 = { error: { message: 'no image generated: all 2 images failed content safety check (1027)' } }
  assert.equal(minimaxImageAdapter.mapHttpError(422, body422).code, CODES.POLICY_REJECTED)
  assert.equal(minimaxImageAdapter.mapHttpError(402, { error: { message: 'insufficient balance (1008)' } }).code, CODES.QUOTA)
  assert.equal(minimaxImageAdapter.mapHttpError(401, { error: { message: 'login fail (1004)' } }).code, CODES.AUTH)
  assert.equal(minimaxImageAdapter.mapHttpError(429, { error: { message: 'rate limit exceeded(IPM) (1002)' } }).code, CODES.RATE_LIMIT)
  assert.equal(minimaxImageAdapter.mapHttpError(500, { error: { message: 'internal error (1000)' } }).code, CODES.UNAVAILABLE)
  assert.equal(minimaxImageAdapter.mapHttpError(400, { error: { message: 'invalid params (2013)' } }).code, CODES.BAD_REQUEST)
})

await test('面积档位反推与编辑尺寸夹取（防止"给 4K 尺寸按 1K 报价"）', () => {
  assert.equal(areaOfSize('1024x1024'), '1K')
  assert.equal(areaOfSize('1360x768'), '1K')
  assert.equal(areaOfSize('2048x2048'), '2K')
  assert.equal(areaOfSize('2720x1536'), '2K')
  assert.equal(areaOfSize('4096x4096'), '4K')
  assert.equal(areaOfSize('nope'), undefined)

  // 8×8 的小图要被放大到官方最小面积以上，且保持比例
  const small = sizeForH3Edit(8, 8)
  assert.ok(small !== undefined)
  const [sw, sh] = small.split('x').map(Number)
  assert.ok(sw * sh >= 655360, '小图输出面积必须 ≥ 官方下限：' + small)

  // 10000×1000（10:1）先夹比例再夹面积，结果比例 ≤3:1
  const wide = sizeForH3Edit(10000, 1000)
  const [ww, wh] = wide.split('x').map(Number)
  assert.ok(Math.max(ww / wh, wh / ww) <= 3 + 1e-6, '比例必须 ≤3:1：' + wide)
  assert.ok(ww * wh >= 655360 && ww * wh <= 20_000_000, '面积必须在官方区间：' + wide)
})

await test('探活：复用只读 /v1/files/retrieve；401/1004 → AUTH，不花一分钱', async () => {
  const authFail = await minimaxImageAdapter.probe({
    credential: CRED,
    config: CONFIG,
    fetchImpl: async () => new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }), { status: 200 }),
  })
  assert.equal(authFail.ok, false)
  assert.equal(authFail.code, CODES.AUTH)

  const ok = await minimaxImageAdapter.probe({
    credential: CRED,
    config: CONFIG,
    fetchImpl: async () => new Response(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' } }), { status: 200 }),
  })
  assert.equal(ok.ok, true)
})

console.log('\n[MiniMax H3-Image adapter] 通过 ' + stats.passed + '，失败 ' + stats.failed)
if (stats.failed > 0) process.exitCode = 1
