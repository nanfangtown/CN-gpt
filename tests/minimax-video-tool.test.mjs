/**
 * minimax_video 工具层离线验收：配置 → 报价闸门 → 提交 → 取文件 → 记账。
 *
 * 不联网、不需要 key、不花钱；manager 与 keys 都是最小替身，
 * 真正被验证的是“工具有没有把 MiniMax 接进现有的付费安全/记账骨架”。
 *
 * 运行：node --import ./tests/register.mjs ./tests/minimax-video-tool.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODES } from '../core/errors.mjs'
import { minimaxVideoAdapter } from '../tasks/adapters/minimax-video.mjs'
import { createMinimaxVideoTool } from '../tools/minimax-video.mjs'

const PRICING = {
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
  const outDir = await mkdtemp(join(tmpdir(), 'mm-minimax-tool-'))
  const config = {
    minimaxModel: 'MiniMax-Hailuo-02',
    minimaxBase: 'https://api.minimax.cn',
    minimaxApiKeyEnv: 'MINIMAX_API_KEY',
    videoOutDir: outDir,
    videoTimeoutMs: 30000,
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
  const calls = { run: 0, fetch: 0 }
  const deps = {
    config,
    manager: {
      get: (id) => {
        assert.equal(id, 'minimax-video')
        return minimaxVideoAdapter
      },
      async run() {
        calls.run += 1
        return {
          taskRef: { taskId: 'mm-task-1', adapter: 'minimax-video' },
          state: { status: 'succeeded', taskId: 'mm-task-1', adapter: 'minimax-video', fileId: 'file-1', elapsedMs: 1200 },
        }
      },
      async fetchArtifacts(state, options) {
        calls.fetch += 1
        assert.equal(state.fileId, 'file-1')
        assert.equal(options.credential, 'test-key')
        return [{ path: join(outDir, 'out.mp4'), bytes: 1024, mediaType: 'video/mp4' }]
      },
    },
    keys: { async resolve() { return { value: 'test-key' } } },
    getLedger: async () => ({
      async list() { return recorded },
      async record(entry) { recorded.push(entry) },
      async noteHealth(adapter, ok, detail) { notes.push({ adapter, ok, detail }) },
    }),
    getTaskRegistry: async () => ({ async record() {} }),
    budget: { take: () => ({ ok: true }) },
    logger: {},
    sessionIdsForSpend: () => undefined,
  }
  const tool = createMinimaxVideoTool(deps)
  const exec = {
    agent: { session: { id: 'session-1', header: { cwd: outDir } } },
    signal: undefined,
  }
  return { tool, exec, config, recorded, notes, calls, outDir }
}

await test('成功链路：按条记账（unitKind=call / units=1 / amount=2）', async () => {
  const { tool, exec, recorded, notes, calls } = await setup()
  const value = await tool.execute({ prompt: '雨夜校园，霓虹', duration: 6, resolution: '768P' }, exec)
  assert.equal(value.taskId, 'mm-task-1')
  assert.equal(value.model, 'MiniMax-Hailuo-02')
  assert.equal(value.videos[0].path.endsWith('out.mp4'), true)
  assert.equal(calls.run, 1)
  assert.equal(calls.fetch, 1)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].adapter, 'minimax-video')
  assert.equal(recorded[0].unitKind, 'call')
  assert.equal(recorded[0].units, 1)
  assert.equal(recorded[0].unitPrice, 2)
  assert.equal(recorded[0].amount, 2)
  assert.equal(notes[0].ok, true)
})

await test('付费闸门：先报价（¥2.00/条），带 confirm_estimate=2 才提交', async () => {
  const { tool, exec, recorded, calls, config } = await setup({ requireSpendConfirm: true })
  await assert.rejects(
    () => tool.execute({ prompt: 'x', duration: 6, resolution: '768P' }, exec),
    (error) => error.code === CODES.BAD_REQUEST && /confirm_estimate=2/.test(error.message),
  )
  assert.equal(calls.run, 0, '没确认不能提交')
  assert.equal(recorded.length, 0)
  const value = await tool.execute({ prompt: 'x', duration: 6, resolution: '768P', confirm_estimate: 2 }, exec)
  assert.equal(value.taskId, 'mm-task-1')
  assert.equal(config.requireSpendConfirm, true)
})

await test('规格错误在扣配额/提交前就报：1080P 10 秒被拒', async () => {
  const { tool, exec, calls } = await setup()
  await assert.rejects(
    () => tool.execute({ prompt: 'x', duration: 10, resolution: '1080P' }, exec),
    (error) => error.code === CODES.BAD_REQUEST && /只支持 6 秒/.test(error.message),
  )
  assert.equal(calls.run, 0)
})

await test('缺 key → MISSING_CREDENTIAL，点名 MINIMAX_API_KEY', async () => {
  const { tool, exec, calls } = await setup()
  tool // keep reference
  // 重新构造一个 keys 返回 undefined 的最小工具
  const outDir = await mkdtemp(join(tmpdir(), 'mm-minimax-nokey-'))
  const noKey = createMinimaxVideoTool({
    config: { minimaxModel: 'MiniMax-Hailuo-02', minimaxBase: 'https://api.minimax.cn', videoOutDir: outDir, maxInlineImageBytes: 1, pricing: PRICING },
    manager: { get: () => minimaxVideoAdapter, async run() { throw new Error('should not run') } },
    keys: { async resolve() { return undefined } },
    getLedger: async () => ({ async list() { return [] }, async record() {}, async noteHealth() {} }),
    getTaskRegistry: async () => ({ async record() {} }),
    budget: { take: () => ({ ok: true }) },
    logger: {},
  })
  await assert.rejects(
    () => noKey.execute({ prompt: 'x' }, exec),
    (error) => error.code === CODES.MISSING_CREDENTIAL && /MINIMAX_API_KEY/.test(error.message),
  )
  assert.equal(calls.run, 0)
})

await test('未计价 fail-closed：单价表没有该模型时拒绝提交', async () => {
  const { tool, exec, calls } = await setup({ pricing: {}, requireSpendConfirm: false })
  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, exec),
    (error) => error.code === CODES.BAD_REQUEST && /未计价/.test(error.message),
  )
  assert.equal(calls.run, 0, '未计价不能提交')
})

console.log('\n[MiniMax 工具层] 通过 ' + stats.passed + '，失败 ' + stats.failed)
if (stats.failed > 0) process.exitCode = 1
