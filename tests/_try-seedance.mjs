/**
 * 真实出片一次（**会花钱**）：直接驱动插件自己的 adapter + task manager。
 *
 * 为什么单独写而不是走 e2e 那套：e2e 要起嵌套 harness，慢且与"能不能出片"无关。
 * 这里只跑真实链路本身：方舟提交 → 轮询 → 下载产物 → 落盘。
 *
 * 花费：模型 doubao-seedance-1-0-pro-fast-251015，约 0.206 元/秒；
 * 默认 5 秒 ≈ 1.03 元。用 `--duration` 可改。
 *
 * 用法：
 *   node --import ./tests/register.mjs tests/_try-seedance.mjs                 # 5 秒
 *   node --import ./tests/register.mjs tests/_try-seedance.mjs --duration 2    # 2 秒（最省，¥0.41）
 *   node --import ./tests/register.mjs tests/_try-seedance.mjs --prompt "..." --out _sandbox/video
 *
 * 注意 `--import ./tests/register.mjs` 是必需的：core/keys.mjs 会导入
 * `@deepseek-ai/dsh-credentials`，只有 register 才挂得上 DSH 的包解析。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { arkVideoAdapter } from '../tasks/adapters/ark-video.mjs'
import { createTaskManager } from '../tasks/manager.mjs'
import { createKeyResolver, keySpec } from '../core/keys.mjs'
import { DEFAULT_PRICING, amountOf, unitPriceOf } from '../core/cost.mjs'
import { loadKeysFromDshEnv } from './_env.mjs'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const duration = Number(argOf('duration', '5'))
const prompt = argOf('prompt', '一只纸灯笼在夜空中缓缓升起，周围有薄雾与星光，镜头缓慢上移')
const outDir = argOf('out', join(process.cwd(), '_sandbox', 'video'))
const model = argOf('model', 'doubao-seedance-1-0-pro-fast-251015')

loadKeysFromDshEnv(['ARK_API_KEY'])
const key = process.env.ARK_API_KEY
if (key === undefined || key.trim().length === 0) {
  console.log('  ⛔ 没有 ARK_API_KEY，无法测试')
  process.exit(1)
}

const entry = DEFAULT_PRICING[model]
const unitPrice = unitPriceOf(entry)
const estimate = unitPrice === null ? null : unitPrice * duration
console.log('  模型     : ' + model)
console.log('  时长     : ' + duration + ' 秒')
console.log('  预估花费 : ' + (estimate === null ? '未计价' : '¥' + estimate.toFixed(3)))
console.log('  提示词   : ' + prompt)
console.log('')

const config = {
  arkBase: 'https://ark.cn-beijing.volces.com/api/v3',
  seedanceModel: model,
  videoOutDir: outDir,
  videoTimeoutMs: 900000,
  taskPollIntervalMs: 5000,
  taskPollMaxIntervalMs: 10000,
  httpTimeoutMs: 120000,
  queryRetries: 2,
  maxVideoBytes: 268435456,
  pricing: DEFAULT_PRICING,
}
const keys = createKeyResolver({ credentials: undefined }, config)
const ARK = keySpec('ark')
const manager = createTaskManager({ adapters: [arkVideoAdapter], config, logger: { warn: (m) => console.log('  [warn] ' + m) } })

const started = Date.now()
try {
  // ⚠ 返回形状是 `{ taskRef, state }`（不是扁平 state）—— 我第一次按扁平读，
  // 结果任务明明 45 秒就成功了，却打印出 status=undefined / 产物 0 个。
  const { taskRef, state } = await manager.run({
    adapterId: arkVideoAdapter.id,
    spec: { model, prompt, duration },
    credential: (await keys.resolve(ARK)).value,
    timeoutMs: config.videoTimeoutMs,
    intervalMs: config.taskPollIntervalMs,
    onProgress: (s) => console.log('  [' + ((Date.now() - started) / 1000).toFixed(0) + 's] ' + s.status),
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log('')
  console.log('  ✅ 任务状态: ' + state.status + '  task_id=' + taskRef.taskId + '  用时 ' + elapsed + 's')
  const urls = state.artifacts ?? []
  console.log('  产物数: ' + urls.length)
  if (Array.isArray(urls) && urls.length > 0) {
    console.log('  ' + String(urls[0]).slice(0, 120))
    // 下载落盘（真实链路里由 deliver 层做，这里直接取第一帧）
    await mkdir(outDir, { recursive: true })
    const res = await fetch(urls[0])
    const buf = Buffer.from(await res.arrayBuffer())
    const file = join(outDir, 'try-' + Date.now() + '.mp4')
    await writeFile(file, buf)
    console.log('  ✅ 已落盘: ' + file + '  (' + (buf.length / 1024 / 1024).toFixed(2) + ' MB)')
  }
  const actual = amountOf({ unitKind: 'second', units: duration, unitPrice })
  console.log('  实际记账: ' + (actual === null ? '未计价' : '¥' + actual.toFixed(3)))
} catch (error) {
  console.log('')
  console.log('  ❌ 失败: ' + (error?.code ?? '') + ' ' + String(error?.message ?? error).slice(0, 400))
  process.exitCode = 1
}
