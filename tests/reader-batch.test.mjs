/**
 * 读图员批量模式的最小桩测试（不派子代理，只验形状与守卫）。
 *   - 批量模式：schema 只有 image_paths；超过上限点名拒绝；单张也要用数组。
 *   - 单图模式：schema 回到 image_path。
 */
import assert from 'node:assert/strict'
import { createReaderTools } from '../tools/reader.mjs'

const ctx = { get: () => undefined }
const logger = { debug: () => {}, info: () => {}, warn: () => {} }

const config = {
  readerBatchMode: true,
  readerBatchMax: 3,
  readerGlmProvider: 'glm',
  readerGlmModel: 'glm-5.3-flash',
  readerQwenProvider: 'qwen-vl',
  readerQwenModel: 'qwen3.8-max',
  readerAgentPreset: 'mm-reader',
  readerMaxDepth: 2,
  autoOcrOnImage: false,
}

const batchTools = createReaderTools({ ctx, config, logger })
const glm = batchTools.find((tool) => tool.name === 'ask_glm')
assert.ok(glm, 'ask_glm 应被注册')
assert.ok(glm.parameters.image_paths, '批量模式必须暴露 image_paths')
assert.equal(glm.parameters.image_path, undefined, '批量模式不应再暴露 image_path')
assert.equal(glm.parameters.image_paths.type, 'array', 'image_paths 必须是数组')
assert.match(glm.description, /一次读一批图/, '描述必须写清批量定位：' + glm.description)
console.log('A ok: 批量模式 schema 只有 image_paths')

await assert.rejects(
  () => glm.execute({ image_paths: ['a.png', 'b.png', 'c.png', 'd.png'] }, { agent: { id: 'p' } }),
  (error) => /最多读 3 张/.test(error.message) && /未派出子代理/.test(error.message),
  '超过上限必须点名拒绝',
)
console.log('B ok: 超过 batchMax → 点名拒绝')

await assert.rejects(
  () => glm.execute({}, { agent: { id: 'p' } }),
  (error) => /image_paths 不能为空/.test(error.message),
)
console.log('C ok: 空入参 → 点名 image_paths')

// 单图模式回滚
const single = createReaderTools({
  ctx,
  config: { ...config, readerBatchMode: false },
  logger,
}).find((tool) => tool.name === 'ask_glm')
assert.ok(single.parameters.image_path, '关掉批量模式后应回到 image_path')
assert.equal(single.parameters.image_paths, undefined, '关掉后不应再暴露 image_paths')
console.log('D ok: readerBatchMode=false → 回到单图 schema')

console.log('\nALL PASS')
