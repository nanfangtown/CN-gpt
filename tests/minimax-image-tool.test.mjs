/**
 * minimax_draw 工具层离线验收：配置 → 报价闸门 → 同步提交 → 落盘 → 记账 → 缓存。
 *
 * 不联网、不需要 key、不花钱；manager / keys / cache 都是最小替身。
 * 真正被验证的是：这条**同步**链路有没有接进现有的付费安全与记账骨架，
 * 以及图生图（edits）与部分失败（200 + data[].error）有没有按设计走。
 *
 * 运行：node --import ./tests/register.mjs ./tests/minimax-image-tool.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODES } from '../core/errors.mjs'
import { minimaxImageAdapter } from '../tasks/adapters/minimax-image.mjs'
import { createMinimaxDrawTool } from '../tools/minimax-draw.mjs'

/** 1×1 PNG（真实字节：工具会读文件并用内容签名算尺寸）。 */
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001' +
    '0e2a0b5e0000000049454e44ae426082',
  'hex',
)

const PRICING = {
  'MiniMax-H3-Image': {
    unit: 'image',
    unitPrice: 0.1531,
    currency: 'CNY',
    tiers: [
      { mode: 'text', area: '1K', unitPrice: 0.143 },
      { mode: 'text', area: '2K', unitPrice: 0.1531 },
      { mode: 'text', area: '4K', unitPrice: 0.4522 },
      { mode: 'edit', area: '1K', unitPrice: 0.2346 },
      { mode: 'edit', area: '2K', unitPrice: 0.2746 },
      { mode: 'edit', area: '4K', unitPrice: 0.5211 },
    ],
  },
}

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

async function setup(overrides = {}) {
  const outDir = await mkdtemp(join(tmpdir(), 'mm-minimax-draw-'))
  const config = {
    minimaxImageModel: 'MiniMax-H3-Image',
    minimaxBase: 'https://api.minimax.cn',
    minimaxImageArea: '1K',
    minimaxImageTimeoutMs: 600000,
    minimaxApiKeyEnv: 'MINIMAX_API_KEY',
    outDir,
    maxInlineImageBytes: 10485760,
    requireSpendConfirm: false,
    videoCostLimitCNY: 0,
    videoSessionCostLimitCNY: 0,
    noConfirmUnderCNY: 0,
    pricing: PRICING,
    ...overrides,
  }
  const recorded = []
  const notes = []
  const runs = []
  const state = {
    status: 'succeeded',
    taskId: 'req-1',
    adapter: 'minimax-image',
    artifacts: ['https://example.com/0.jpg'],
    usage: { imageCount: 1 },
    elapsedMs: 1200,
  }
  const deps = {
    config,
    manager: {
      get: (id) => {
        assert.equal(id, 'minimax-image')
        return minimaxImageAdapter
      },
      async run(options) {
        runs.push(options)
        return { taskRef: { taskId: 'req-1', adapter: 'minimax-image' }, state: { ...state, ...(options.stateOverride ?? {}) } }
      },
      async fetchArtifacts(_state, options) {
        const path = join(options.outDir, 'h3-01.png')
        await writeFile(path, PNG_1PX)
        return [{ path, bytes: PNG_1PX.length, mediaType: 'image/png' }]
      },
    },
    keys: { async resolve() { return { value: 'test-key' } } },
    getLedger: async () => ({
      async list() { return recorded },
      async record(entry) { recorded.push(entry) },
      async noteHealth(adapter, ok, detail) { notes.push({ adapter, ok, detail }) },
    }),
    getTaskRegistry: async () => ({ async record() {} }),
    // 默认不启用缓存；需要缓存命中的用例单独传 cache。
    getImageCache: overrides.cache === undefined ? async () => undefined : async () => overrides.cache,
    budget: { take: () => ({ ok: true }) },
    logger: {},
    sessionIdsForSpend: () => undefined,
    ctx: { get: () => undefined },
  }
  const exec = {
    agent: { session: { id: 'session-1', header: { cwd: outDir } } },
    signal: undefined,
  }
  const tool = createMinimaxDrawTool(deps)
  return { tool, exec, config, recorded, notes, runs, outDir, state }
}

await test('成功链路：同步提交 → 落盘 → 按成功张数记账（unitKind=image / units=1 / amount=0.143）', async () => {
  const { tool, exec, recorded, notes, runs } = await setup()
  const value = await tool.execute({ prompt: '一只橘猫趴在窗台上', n: 1 }, exec)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].submitTimeoutMs, 600000, '同步链路必须用官方建议的 600s 超时')
  assert.equal(runs[0].spec.mode, 'text')
  assert.equal(runs[0].spec.area, '1K')
  assert.equal(value.taskId, 'req-1')
  assert.equal(value.model, 'MiniMax-H3-Image')
  assert.ok(value.images[0].path.endsWith('h3-01.png'))
  assert.equal(value.failedCount, undefined)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].unitKind, 'image')
  assert.equal(recorded[0].units, 1)
  assert.equal(recorded[0].unitPrice, 0.143)
  assert.equal(recorded[0].amount, 0.143)
  assert.equal(recorded[0].area, '1K')
  assert.equal(notes[0].ok, true)
})

await test('部分失败（200 + data[].error）：只按成功张数记账，结果里点名 failedCount', async () => {
  const { tool, exec, recorded, state } = await setup()
  state.usage = { imageCount: 1 }
  state.partialFailures = [{ code: '1027', message: 'content safety' }]
  try {
    const value = await tool.execute({ prompt: 'x', n: 2 }, exec)
    assert.equal(value.failedCount, 1)
    assert.equal(recorded[0].units, 1, '记账必须按 usage.generated_images，不能按请求的 n')
    assert.equal(recorded[0].amount, 0.143)
  } finally {
    state.partialFailures = undefined
  }
})

await test('付费闸门：单张 1K = 0.143 → 需复述 0.14 才提交', async () => {
  const { tool, exec, runs, recorded } = await setup({ requireSpendConfirm: true })
  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, exec),
    (error) => error.code === CODES.BAD_REQUEST && /confirm_estimate=0\.14/.test(error.message),
  )
  assert.equal(runs.length, 0, '没确认不能提交')
  assert.equal(recorded.length, 0)
  const value = await tool.execute({ prompt: 'x', confirm_estimate: 0.14 }, exec)
  assert.equal(value.taskId, 'req-1')
  assert.equal(runs.length, 1)
})

await test('未计价 fail-closed：单价表没有该模型时拒绝提交', async () => {
  const { tool, exec, runs } = await setup({ pricing: {} })
  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, exec),
    (error) => error.code === CODES.BAD_REQUEST && /未计价/.test(error.message),
  )
  assert.equal(runs.length, 0)
})

await test('档位缺失也 fail-closed：配了模型但没配 4K 档 → 拒绝，不退回兜底价', async () => {
  const pricing = { 'MiniMax-H3-Image': { unit: 'image', unitPrice: 0.1531, currency: 'CNY', tiers: [{ mode: 'text', area: '1K', unitPrice: 0.143 }] } }
  const { tool, exec, runs } = await setup({ pricing })
  await assert.rejects(
    () => tool.execute({ prompt: 'x', area: '4K' }, exec),
    (error) => error.code === CODES.BAD_REQUEST && /未计价/.test(error.message),
  )
  assert.equal(runs.length, 0)
})

await test('缺 key → MISSING_CREDENTIAL，点名 MINIMAX_API_KEY', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'mm-minimax-draw-nokey-'))
  const tool = createMinimaxDrawTool({
    config: { minimaxImageModel: 'MiniMax-H3-Image', minimaxBase: 'https://api.minimax.cn', outDir, pricing: PRICING },
    manager: { get: () => minimaxImageAdapter, async run() { throw new Error('should not run') } },
    keys: { async resolve() { return undefined } },
    getLedger: async () => ({ async list() { return [] }, async record() {}, async noteHealth() {} }),
    getTaskRegistry: async () => ({ async record() {} }),
    getImageCache: async () => undefined,
    budget: { take: () => ({ ok: true }) },
    logger: {},
  })
  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, { agent: { session: { id: 's', header: { cwd: outDir } } } }),
    (error) => error.code === CODES.MISSING_CREDENTIAL && /MINIMAX_API_KEY/.test(error.message),
  )
})

await test('图生图：给工作目录内的参考图 → 走 edits（spec.mode=edit，images 被解析成 data URL）', async () => {
  const { tool, exec, runs, outDir } = await setup()
  const refPath = join(outDir, 'ref.png')
  await writeFile(refPath, PNG_1PX)
  await tool.execute({ prompt: '把它改成水彩风格', image: refPath }, exec)
  assert.equal(runs[0].spec.mode, 'edit')
  assert.equal(runs[0].spec.images.length, 1)
  assert.ok(runs[0].spec.images[0].dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(runs[0].spec.area, '1K', '参考图维度不可用于 1px 图时仍要显式带 area（不许落到厂商默认 4K）')
})

await test('参考图越界（工作目录之外）→ 提前拒绝，不提交', async () => {
  const { tool, exec, runs } = await setup()
  await assert.rejects(
    () => tool.execute({ prompt: 'x', images: ['C:/Windows/notepad.exe'] }, exec),
    (error) => error.code === CODES.BAD_REQUEST && /只允许来自会话工作目录/.test(error.message),
  )
  assert.equal(runs.length, 0, '越界图绝不能发出去，也绝不能提交计费')
})

await test('全部失败（内容安全）→ POLICY_REJECTED，不写账本、不缓存', async () => {
  const { tool, exec, recorded, state } = await setup()
  state.status = 'failed'
  state.artifacts = []
  state.error = { code: CODES.POLICY_REJECTED, detail: 'output image failed content safety check (1027)' }
  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, exec),
    (error) => error.code === CODES.POLICY_REJECTED && /调整提示词/.test(error.message),
  )
  assert.equal(recorded.length, 0, '全部失败不计费（官方只对成功张数收费）')
})

await test('出图缓存命中：不再提交、不再计费，结果标注 cached', async () => {
  const cachedImages = [{ path: 'C:/cache/0.png', bytes: 10, mediaType: 'image/png' }]
  const cache = {
    async get() { return cachedImages },
    async put() { throw new Error('命中后不该写缓存') },
  }
  const { tool, exec, runs } = await setup({ cache })
  const value = await tool.execute({ prompt: 'x' }, exec)
  assert.equal(runs.length, 0, '命中缓存不许再提交')
  assert.equal(value.cached, true)
  assert.equal(value.images, cachedImages)
  assert.equal(value.taskId.startsWith('cache:'), true)
})

console.log('\n[MiniMax H3-Image 工具层] 通过 ' + stats.passed + '，失败 ' + stats.failed)
if (stats.failed > 0) process.exitCode = 1
