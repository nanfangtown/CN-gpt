/**
 * ocr_image 的验收：词框重排（纯函数）+ 真实 Windows OCR（集成）。
 *
 * 为什么重排要有单测：Windows 引擎对等宽代码会**把一行拆成多段且顺序错乱**
 * （`const total =` / `add(12,` / `30);`），对中文按**单字**成词并加空格
 * （`任 务 队 列`）。这两件事都必须在插件这层修掉，否则工具输出会读不通。
 *
 * 集成用例需要 Windows + Windows PowerShell 5.1；其它环境自动跳过（打印 SKIP），
 * 不让 CI 因为"没装 OCR 语言包"整片红。
 *
 * 运行：node --import ./tests/register.mjs ./tests/ocr-image.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODES } from '../core/errors.mjs'
import { buildOcrText, createOcrImageTool, formatOcrResult, reflowWords, resolveInputPath, runWindowsOcr } from '../tools/ocr-image.mjs'

const here = new URL('.', import.meta.url)
const fixture = (name) => fileURLToPath(new URL(`./fixtures/ocr/${name}`, here))

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ': ' + (error?.message ?? String(error)))
    console.log('  ✗ ' + name + '\n    ' + String(error?.stack ?? error).split('\n').slice(0, 4).join('\n    '))
  }
}

/** 这台机器能不能真的跑一次 Windows OCR（决定集成用例跑还是跳过）。 */
function ocrAvailable() {
  if (process.platform !== 'win32') return false
  // 2026-10-31：CI 的 windows-latest 有 PowerShell 5.1，但不一定有 OCR 语言包。
  // 只探 PS 版本会让集成用例在没有语言包的机器上假红；这里连引擎一起探。
  const probe = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$v = $PSVersionTable.PSVersion.Major; if ($v -lt 5) { exit 2 }; ' +
      '[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null; ' +
      'if ($null -eq [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()) { exit 3 }',
  ], { encoding: 'utf8' })
  return probe.status === 0
}

function makeExec(cwd) {
  return { agent: { session: { id: 'sess-ocr', header: { cwd } } }, signal: new AbortController().signal }
}

// ---------------------------------------------------------------- 词框重排（纯函数）

await test('重排：中文按字切分时不留空格（"任 务 队 列" → "任务队列"）', () => {
  const words = [
    { t: '任', x: 0, y: 10, w: 20, h: 20 },
    { t: '务', x: 21, y: 10, w: 20, h: 20 },
    { t: '队', x: 42, y: 10, w: 20, h: 20 },
    { t: '列', x: 63, y: 10, w: 20, h: 20 },
  ]
  const { text } = reflowWords(words)
  assert.equal(text, '任务队列')
})

await test('重排：英文单词之间按间隙补空格，标点紧贴前词', () => {
  const words = [
    { t: 'console', x: 0, y: 0, w: 60, h: 16 },
    { t: '.', x: 63, y: 0, w: 4, h: 16 },
    { t: 'log(total);', x: 68, y: 0, w: 90, h: 16 },
    { t: 'next', x: 170, y: 0, w: 40, h: 16 },
  ]
  const { text } = reflowWords(words)
  assert.equal(text, 'console.log(total); next')
})

await test('重排：同一行被引擎拆成多段、顺序错乱时，按坐标还原成一行', () => {
  // 实测原始顺序：const total = / add(12, / 30); —— 三段 y 相同、x 依次递增。
  const words = [
    { t: 'add(12,', x: 210, y: 177, w: 80, h: 20 },
    { t: 'const', x: 40, y: 179, w: 58, h: 14 },
    { t: 'total', x: 112, y: 178, w: 59, h: 15 },
    { t: '=', x: 186, y: 184, w: 9, h: 6 },
    { t: '30);', x: 300, y: 180, w: 50, h: 18 },
    { t: '}', x: 0, y: 230, w: 8, h: 16 },
  ]
  const { text } = reflowWords(words)
  assert.equal(text, 'const total = add(12, 30);\n}')
})

await test('重排：空输入 / 只有空白词 → 空文本', () => {
  assert.equal(reflowWords([]).text, '')
  assert.equal(reflowWords([{ t: '   ', x: 0, y: 0, w: 1, h: 1 }]).text, '')
  assert.equal(reflowWords(undefined).text, '')
})

await test('文本上限：超长截断并注明原长度（工具结果会永久留在会话里）', () => {
  const words = [{ t: 'a'.repeat(100), x: 0, y: 0, w: 2000, h: 20 }]
  const { text, stats } = buildOcrText({ words }, { maxChars: 40 })
  assert.ok(text.startsWith('a'.repeat(40)), '必须保留前 40 字：' + text.slice(0, 60))
  assert.ok(text.includes('已截断'), '必须显式说明被截断：' + text)
  assert.equal(stats.truncated, true)
})

await test('文本上限：空结果的行数不是 1（避免报表说"1 行空文本"）', () => {
  const { text, stats } = buildOcrText({ words: [], text: '' }, {})
  assert.equal(text, '')
  assert.equal(stats.lineCount, 0)
})

await test('弱结果（几乎没字）必须指向 ask_qwen，而不是让模型猜', () => {
  const weak = formatOcrResult({ ok: true, words: [], text: '', width: 800, height: 500, scale: 1, language: 'en-US', elapsedMs: 300 }, { imagePath: 'x.png', displayPath: 'x.png', maxChars: 1000 })
  assert.equal(weak.weak, true)
  assert.ok(weak.text.includes('ask_qwen'), '弱结果要指向读图员：' + weak.text)
  assert.ok(weak.text.includes('不要靠猜'), '弱结果要禁止猜图：' + weak.text)
})

await test('正常结果：头部必须写明"未出网"与语言/尺寸（模型据此判断可信度）', () => {
  const good = formatOcrResult(
    { ok: true, words: [{ t: 'hello world, this is OCR', x: 0, y: 0, w: 320, h: 18 }], text: 'hello world, this is OCR', width: 900, height: 200, scale: 2, language: 'en-US', elapsedMs: 420 },
    { imagePath: 'x.png', displayPath: 'x.png', maxChars: 1000 },
  )
  assert.equal(good.weak, false)
  assert.ok(good.text.includes('未出网'), '要写明图片没有外发：' + good.text)
  assert.ok(good.text.includes('放大 2×'), '要写明做过放大：' + good.text)
  assert.ok(good.text.includes('hello world, this is OCR'))
})

await test('相对路径按会话 cwd 解析；绝对路径原样保留；引号被剥掉', () => {
  const isWin = process.platform === 'win32'
  const cwd = isWin ? 'D:\\work\\proj' : '/work/proj'
  const rel = isWin ? 'shots\\a.png' : 'shots/a.png'
  const abs = isWin ? 'D:\\x\\b.png' : '/x/b.png'
  const exec = makeExec(cwd)
  assert.equal(resolveInputPath(rel, exec), join(cwd, rel))
  assert.equal(resolveInputPath(`"${abs}"`, exec), abs)
})

// ---------------------------------------------------------------- 工具行为（不依赖 OCR）

await test('ocr_image：文件不存在 → BAD_REQUEST，且文案指向路径问题', async () => {
  const tool = createOcrImageTool({ config: {}, logger: undefined })
  await assert.rejects(
    () => tool.execute({ image_path: 'nope-12345.png' }, makeExec('D:\\work')),
    (error) => error.code === CODES.BAD_REQUEST && /图片不存在/.test(error.message),
  )
})

await test('ocr_image：非位图扩展名在开跑前就拒绝（不启动 PowerShell）', async () => {
  const tool = createOcrImageTool({ config: {}, logger: undefined })
  const notImage = fileURLToPath(new URL('../package.json', here))
  await assert.rejects(
    () => tool.execute({ image_path: notImage }, makeExec(process.cwd())),
    (error) => error.code === CODES.BAD_REQUEST && /不是支持的位图格式/.test(error.message),
  )
})

await test('ocr_image：空参数 → BAD_REQUEST', async () => {
  const tool = createOcrImageTool({ config: {}, logger: undefined })
  await assert.rejects(() => tool.execute({}, makeExec(process.cwd())), (error) => error.code === CODES.BAD_REQUEST)
})

// ---------------------------------------------------------------- 真实 OCR（Windows）

if (!ocrAvailable()) {
  console.log('  - SKIP 真实 OCR 用例：本机不是 Windows、没有 Windows PowerShell 5.1，或没有可用的 OCR 语言包')
} else {
  await test('真实 OCR：中文界面截图（不再逐字带空格）', async () => {
    const raw = await runWindowsOcr({ imagePath: fixture('screenshot-zh.png'), language: '' })
    assert.equal(raw.ok, true)
    const { text } = buildOcrText(raw, { maxChars: 4000 })
    assert.ok(/任务|系统|错误|连接/.test(text), '应认出中文：' + text.slice(0, 120))
    // 逐字加空格是 Windows 中文引擎的既有行为；重排后应还原成词。注意"用户 陈成"这种
    // 原文本来就有的词间空格必须保留，所以只钉"逐字空格"的形态。
    assert.ok(text.includes('任务队列'), '中文词内的逐字空格没有被去掉：' + text.slice(0, 120))
    assert.ok(!/任 务|队 列|错 误/.test(text), '逐字空格应该已经消失：' + text.slice(0, 120))
    assert.match(raw.language, /^zh/) 
  })

  await test('真实 OCR：代码截图（ASCII 内容自动切英文引擎）', async () => {
    const raw = await runWindowsOcr({ imagePath: fixture('screenshot-code.png'), language: '' })
    assert.equal(raw.ok, true)
    const { text } = buildOcrText(raw, { maxChars: 4000 })
    assert.ok(/Traceback|ValueError|server\.py/.test(text), '应认出代码：' + text.slice(0, 200))
    assert.match(raw.language, /^en/, '中文引擎会把 ASCII 认成形近字，应切英文：' + raw.language)
  })

  await test('真实 OCR：非文字图 → 0 字（工具侧据此给出"改用读图员"）', async () => {
    const raw = await runWindowsOcr({ imagePath: fixture('chart.png'), language: '' })
    assert.equal(raw.ok, true)
    assert.equal(raw.charCount, 0, '纯色块图不该认出文字：' + raw.text)
  })

  await test('真实 OCR：工具端到端（相对路径 + 缓存 + 头部信息）', async () => {
    const tool = createOcrImageTool({ config: { ocrMaxChars: 4000 }, logger: undefined })
    const exec = makeExec(fileURLToPath(new URL('./fixtures/ocr', here)))
    const first = await tool.execute({ image_path: 'screenshot-code.png' }, exec)
    assert.ok(first.text.includes('未出网'), '头部要说明未外发：' + first.text.slice(0, 120))
    assert.ok(/Traceback|ValueError/.test(first.text))
    const second = await tool.execute({ image_path: 'screenshot-code.png' }, exec)
    assert.equal(second.text, first.text, '同一张图第二次应命中缓存、结果一致')
  })
}

console.log(`\n[ocr_image] 通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
