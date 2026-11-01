/**
 * ocr_image —— 本地 OCR（Windows 自带引擎，`Windows.Media.Ocr`）。
 *
 * ## 为什么需要它
 * 插件默认把 `read_image` 对主代理屏蔽掉，读图只能派 `ask_glm` / `ask_qwen`
 * 子代理。这对"图表、排版、照片"是合理的，但**纯文字截图**（报错、日志、代码、
 * 表格、聊天记录、文档）占了日常读图的大头：派一次子代理要两跳模型调用，
 * 而文字图恰恰是"抄字"而不是"理解画面"——OCR 更便宜、更保真（不会意译、
 * 不会漏掉一列数字），而且**截图不出网**（里面有 key、订单号、内部单据时是硬需求）。
 *
 * ## 分工（写进工具描述，模型要能自己判断）
 *   - 只是文字 → `ocr_image`
 *   - 图表读数 / 界面排版 / 画面内容 / 看不清的图 → `ask_qwen`（读图员）
 *   - 识别结果为空或明显残缺 → 说明不是纯文字图，改用读图员
 *
 * ## 实现
 * Windows 没有给 Node 的 OCR 绑定，所以调 `tools/ocr/windows-ocr.ps1`
 * （`powershell.exe` + WinRT 桥）。脚本只回结构化 JSON（词级坐标 + 引擎原始行），
 * **行重排放在这里**：Windows 引擎会把一行等宽代码拆成几段、顺序还可能乱，
 * 并给每个汉字之间插空格；按词框按（行 → 列）重排一次，两个毛病一起消掉。
 *
 * ## 有意不做
 *   - 不做图像理解 / 图表读数：那不是 OCR 的能力，硬做就是猜；
 *   - 不把图上传到任何服务：这条工具的全部价值之一就是"不出网"；
 *   - 不装任何运行时依赖：只用 Windows 已有的能力（无需 tesseract / Python / 在线模型）。
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError } from '../core/errors.mjs'

/** 随插件发布的 PowerShell 脚本。 */
const SCRIPT_PATH = fileURLToPath(new URL('./ocr/windows-ocr.ps1', import.meta.url))

/** 允许的位图扩展名（其余交给 Windows 解码器报错，文案更准确）。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff', '.webp'])

/** 嗅探文件头时读的字节数（够覆盖 ftyp 品牌）。 */
const MAGIC_BYTES = 32

/**
 * 按文件头判断位图格式。
 *
 * 为什么需要：粘贴进对话的图在 `.dsh/attachments/v1/objects/…` 下是**无扩展名**对象，
 * 按后缀判断会直接拒绝——"纯文字截图先走本地 OCR"这条策略在最常见的场景里就失效了。
 * Windows 解码器本身按内容解码（脚本用 `BitmapDecoder.CreateAsync(stream)`），
 * 所以只需要我们不再把后缀当唯一判据。
 *
 * @param {string} imagePath - 绝对路径。
 * @returns {Promise<string|undefined>} 扩展名（.png/.jpg/…）；认不出返回 undefined。
 */
export async function sniffImageExtension(imagePath) {
  let handle
  try {
    handle = await open(imagePath, 'r')
    const buffer = Buffer.alloc(MAGIC_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_BYTES, 0)
    if (bytesRead < 12) return undefined
    const head = buffer.subarray(0, bytesRead)
    const ascii = (start, end) => head.toString('latin1', start, end)
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return '.png'
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg'
    if (ascii(0, 3) === 'GIF') return '.gif'
    if (head[0] === 0x42 && head[1] === 0x4d) return '.bmp'
    if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a)) return '.tiff'
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp'
    if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) return '.ico'
    if (ascii(4, 8) === 'ftyp') {
      const brand = ascii(8, 12)
      if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return '.heic'
      if (brand === 'avif' || brand === 'avis') return '.avif'
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * 把"路径本身不可解码"的图（无扩展名的粘贴对象）准备成引擎能打开的临时文件。
 *
 * 实测（2026-11-01）：同一个文件叫 `…/921ad8…` 时 WinRT `StorageFile` 打不开，
 * 复制成 `image.png` 后同一份字节立刻能 OCR —— 所以按文件头嗅探后复制一次，
 * 而不是指望引擎忽略后缀。
 *
 * @param {string} imagePath - 原始绝对路径。
 * @returns {Promise<{ path: string, cleanup?: () => Promise<void> }>} 可解码路径与清理函数。
 */
async function ensureDecodablePath(imagePath) {
  const extension = extname(imagePath).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return { path: imagePath }
  const sniffed = await sniffImageExtension(imagePath)
  if (sniffed === undefined) return { path: imagePath }
  const dir = await mkdtemp(join(tmpdir(), 'mm-ocr-src-'))
  const copy = join(dir, 'image' + sniffed)
  await copyFile(imagePath, copy)
  return {
    path: copy,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * 一次完整 OCR：校验 → 嗅探 → 跑引擎 → 重排。
 *
 * 给 `ocr_image` 之外的调用方复用（读图员预读、回合闸门的自动 OCR），
 * 这样"本地抄字"只有一条实现，三处不会各自漂移。
 *
 * @param {object} options - 参数。
 * @param {string} options.imagePath - 绝对路径。
 * @param {string} [options.language] - '' / zh-Hans / en-US。
 * @param {number} [options.maxChars] - 文本上限。
 * @param {number} [options.timeoutMs] - 超时。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<{text: string, weak: boolean, stats: object, extension: string, elapsedMs: number}>} 结果。
 */
export async function ocrFileText({ imagePath, language = '', maxChars = 4000, timeoutMs = 20000, signal } = {}) {
  const info = await stat(imagePath)
  if (!info.isFile()) throw new MediaError(CODES.BAD_REQUEST, `不是文件：${imagePath}。image_path 需要指向一张图片。`)
  let extension = extname(imagePath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension)) {
    const sniffed = await sniffImageExtension(imagePath)
    if (sniffed === undefined) {
      throw new MediaError(
        CODES.BAD_REQUEST,
        `不是支持的位图格式：${extension || '（无扩展名）'}，且文件头不是已知位图。` +
          `支持 ${[...IMAGE_EXTENSIONS].join('/')}；其它格式请先转 PNG，或改用 ask_qwen。`,
      )
    }
    extension = sniffed
  }
  const raw = await runWindowsOcr({ imagePath, language, timeoutMs, signal })
  const { text, weak, stats } = formatOcrResult(raw, { imagePath, displayPath: imagePath, maxChars })
  return { text, weak, stats, extension, elapsedMs: Number(raw?.elapsedMs ?? 0) }
}

/** 一次 OCR 结果缓存条数（同一张图反复看很常见）。 */
const CACHE_LIMIT = 32

/** 给 PowerShell 的 stdout/stderr 上限，防止异常输出撑爆结果。 */
const OUTPUT_LIMIT = 8192

/**
 * 取中位数。
 * @param {number[]} values - 数字数组。
 * @returns {number} 中位数；空数组返回 0。
 */
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 把词级 OCR 结果重排成"正常阅读顺序"的文本。
 *
 * 为什么必须重排（2026-10-30 实测）：
 *   - Windows 引擎对等宽代码会**把一行拆成多个 OcrLine**，且顺序可能是
 *     `"const total =" / "add(12," / "30);"` —— 直接拼会得到读不通的句子；
 *   - 中文按**单字**成词，引擎在字之间加空格（"任 务 队 列"），
 *     拼起来既难读又虚增 token。
 *
 * 判据只用几何：先按 y 聚成行（容差 = 0.6 × 中位字高），行内按 x 排序，
 * 相邻词的间隙 > 0.28 × 字高才补一个空格。汉字间隙接近 0，英文单词间隙很大，
 * 所以同一套阈值对中英文都成立，**不需要猜语言**。
 *
 * @param {Array<{t: string, x: number, y: number, w: number, h: number}>} words - 词框。
 * @returns {{ text: string, lines: string[], medianHeight: number }} 重排结果。
 */
export function reflowWords(words) {
  const items = (Array.isArray(words) ? words : []).filter(
    (word) => word !== null && typeof word === 'object'
      && typeof word.t === 'string' && word.t.trim().length > 0
      && Number.isFinite(word.x) && Number.isFinite(word.y),
  )
  if (items.length === 0) return { text: '', lines: [], medianHeight: 0 }

  const medianHeight = median(items.map((word) => (Number.isFinite(word.h) && word.h > 2 ? word.h : 0)).filter((h) => h > 0)) || 12
  const rowTolerance = Math.max(4, medianHeight * 0.6)
  const spaceGap = Math.max(3, medianHeight * 0.28)

  const sorted = items
    .map((word) => ({ ...word, cy: word.y + (Number.isFinite(word.h) ? word.h : 0) / 2 }))
    .sort((a, b) => a.cy - b.cy || a.x - b.x)

  /** @type {Array<{center: number, count: number, items: object[]}>} */
  const rows = []
  for (const word of sorted) {
    const row = rows[rows.length - 1]
    if (row !== undefined && Math.abs(word.cy - row.center) <= rowTolerance) {
      row.items.push(word)
      row.center = (row.center * row.count + word.cy) / (row.count + 1)
      row.count += 1
    } else {
      rows.push({ center: word.cy, count: 1, items: [word] })
    }
  }

  const lines = []
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x)
    let line = ''
    let previous
    for (const word of row.items) {
      if (previous !== undefined) {
        const gap = word.x - (previous.x + previous.w)
        if (gap > spaceGap) line += ' '
      }
      line += word.t
      previous = word
    }
    const normalized = line.replace(/[ \t]+/g, ' ').trim()
    if (normalized.length > 0) lines.push(normalized)
  }

  return { text: lines.join('\n'), lines, medianHeight }
}

/**
 * 把 PowerShell 的 JSON 结果收敛成工具要的形状。
 * @param {object} raw - 脚本输出。
 * @param {{ maxChars: number }} options - 文本上限。
 * @returns {{ text: string, stats: object }} 重排后的文本与统计。
 */
export function buildOcrText(raw, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 12000
  const reflowed = reflowWords(raw?.words)
  // 词框缺失（引擎异常/被截断）时退回引擎自己的行文本，至少别丢内容。
  const fallback = typeof raw?.text === 'string' ? raw.text : ''
  let text = reflowed.text.length > 0 ? reflowed.text : fallback
  text = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  let truncated = false
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（已截断：全文 ${text.length} 字，只保留前 ${maxChars} 字）`
    truncated = true
  }
  return {
    text,
    stats: {
      charCount: text.length,
      lineCount: text.length === 0 ? 0 : (reflowed.lines.length > 0 ? reflowed.lines.length : String(fallback).split('\n').length),
      medianHeight: reflowed.medianHeight,
      truncated,
    },
  }
}

/**
 * 解析相对路径（与 `read` 一样：先会话 cwd，再进程 cwd）。
 * @param {string} input - 用户给的路径。
 * @param {object} exec - 工具执行上下文。
 * @returns {string} 绝对路径。
 */
export function resolveInputPath(input, exec) {
  const raw = String(input ?? '').trim().replace(/^["']|["']$/g, '')
  if (raw.length === 0) return raw
  if (isAbsolute(raw)) return raw
  const cwd = exec?.agent?.session?.header?.cwd
  const base = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd()
  return resolve(base, raw)
}

/**
 * 解析 PowerShell 可执行文件：优先系统自带的 Windows PowerShell 5.1
 * （WinRT 投影是它原生的；pwsh 7 需要额外的投影程序集）。
 */
function powershellPath() {
  return process.env.MM_OCR_POWERSHELL ?? 'powershell.exe'
}

/**
 * 跑一次 OCR。
 *
 * @param {object} input - 参数。
 * @param {string} input.imagePath - 已解析的绝对路径。
 * @param {string} [input.language] - '' / 'auto' / 'zh-Hans' / 'en-US'。
 * @param {number} [input.timeoutMs] - 超时（默认 20 s）。
 * @param {AbortSignal} [input.signal] - 取消信号。
 * @returns {Promise<object>} 脚本的 JSON 结果（ok=true）。
 * @throws {MediaError} 失败时给出可执行的人话。
 */
export async function runWindowsOcr({ imagePath, language = '', timeoutMs = 20000, signal, scriptPath = SCRIPT_PATH }) {
  // 无扩展名的粘贴图：WinRT 的 StorageFile 打不开（实测 DECODE_FAILED），
  // 所以先复制成一个带正确后缀的临时文件再交给引擎。原始路径只用于报错文案。
  const prepared = await ensureDecodablePath(imagePath)
  const dir = await mkdtemp(join(tmpdir(), 'mm-ocr-'))
  const requestPath = join(dir, 'request.json')
  const resultPath = join(dir, 'result.json')
  try {
    await writeFile(requestPath, JSON.stringify({ imagePath: prepared.path, language, scale: 0 }), 'utf8')
    const { code, stdout, stderr, timedOut, aborted } = await runPowerShell({
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RequestPath', requestPath, '-ResultPath', resultPath],
      timeoutMs,
      signal,
    })
    if (aborted) throw new MediaError(CODES.ABORTED, '已取消：本次 OCR 被中止，未产生任何外部调用。')
    if (timedOut) {
      throw new MediaError(
        CODES.TIMEOUT,
        `本地 OCR 超时（${Math.round(timeoutMs / 1000)} s）。大图（长边 > 8000 px）会明显变慢；` +
          '请先把图缩到 4000 px 以内再试，或改用 ask_qwen 读图。',
      )
    }

    let raw
    try {
      raw = JSON.parse(await readFile(resultPath, 'utf8'))
    } catch (error) {
      const detail = [stderr, stdout].map((text) => String(text ?? '').trim()).filter((text) => text.length > 0).join(' | ')
      throw new MediaError(
        CODES.UNKNOWN,
        '本地 OCR 没有返回结果：PowerShell 脚本执行失败' +
          (code === 0 ? '（没有写出结果文件）' : `（退出码 ${code}）`) +
          (detail.length > 0 ? `。原始输出：${detail.slice(0, 400)}` : '。') +
          ' 这不影响其它工具；请改用 ask_qwen 读这张图，并把这条错误告诉用户。',
        { cause: error },
      )
    }

    if (raw?.ok !== true) {
      throw mapPowerShellFailure(raw, { imagePath, stderr })
    }
    return raw
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await prepared.cleanup?.()
  }
}

/**
 * 跑子进程并限时收集输出。
 * @param {{ args: string[], timeoutMs: number, signal?: AbortSignal }} options - 参数。
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean }>} 结果。
 */
function runPowerShell({ args, timeoutMs, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let timedOut = false
    let aborted = false
    const child = spawn(powershellPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    const collect = (chunk, append) => {
      const text = String(chunk)
      if (append.length >= OUTPUT_LIMIT) return append
      return (append + text).slice(0, OUTPUT_LIMIT)
    }

    child.stdout?.on('data', (chunk) => { stdout = collect(chunk, stdout) })
    child.stderr?.on('data', (chunk) => { stderr = collect(chunk, stderr) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(
        new MediaError(
          CODES.UNAVAILABLE,
          '本地 OCR 不可用：找不到 powershell.exe（Windows PowerShell 5.1）。' +
            '本工具不需要联网，但需要系统自带的 PowerShell；请改用 ask_qwen 读图。',
          { cause: error },
        ),
      )
    })

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut, aborted })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    if (signal !== undefined) {
      const onAbort = () => {
        aborted = true
        child.kill()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      child.on('close', () => signal.removeEventListener?.('abort', onAbort))
    }

    child.on('close', (code) => finish(code))
  })
}

/**
 * 把脚本的 error.code 翻成给模型/用户看的固定文案。
 * @param {object} raw - 脚本结果（ok=false）。
 * @param {{ imagePath: string, stderr: string }} context - 上下文。
 * @returns {MediaError} 归一化错误。
 */
function mapPowerShellFailure(raw, { imagePath, stderr }) {
  const code = String(raw?.error?.code ?? 'OCR_FAILED')
  const message = String(raw?.error?.message ?? '').trim()
  const tail = message.length > 0 ? `（${message.slice(0, 300)}）` : ''
  if (code === 'FILE_NOT_FOUND') {
    return new MediaError(CODES.BAD_REQUEST, `图片不存在：${imagePath}。请先确认路径，或改用绝对路径。`)
  }
  if (code === 'NO_OCR_ENGINE') {
    return new MediaError(
      CODES.UNAVAILABLE,
      '本机没有可用的 Windows OCR 语言包。装一个即可（设置 → 时间和语言 → 语言 → 中文/英文 → 可选功能 → 光学字符识别），' +
        '装完不用重启；在那之前请改用 ask_qwen 读图。' + tail,
    )
  }
  if (code === 'IMAGE_TOO_LARGE') {
    return new MediaError(
      CODES.BAD_REQUEST,
      `图片太大，Windows OCR 拒绝处理${tail}。请把长边缩到 10000 px 以内（例如用 ffmpeg / ImageMagick）再试，或改用 ask_qwen。`,
    )
  }
  if (code === 'DECODE_FAILED') {
    return new MediaError(
      CODES.BAD_REQUEST,
      `这个图片格式本机解不了${tail}。WebP / HEIC / AVIF 需要额外的系统解码器；请先转成 PNG，或改用 ask_qwen。`,
    )
  }
  if (code === 'WINRT_BRIDGE') {
    return new MediaError(
      CODES.UNAVAILABLE,
      '本机的 Windows PowerShell 用不了 WinRT（Windows.Media.Ocr）' + tail + '。请改用 ask_qwen 读图。',
    )
  }
  return new MediaError(
    CODES.UNKNOWN,
    `本地 OCR 失败${tail || (stderr.trim().length > 0 ? `（${stderr.trim().slice(0, 300)}）` : '')}。这不影响其它工具；请改用 ask_qwen 读这张图。`,
  )
}

/**
 * 生成给人/模型看的结果块。
 * @param {object} raw - 脚本结果。
 * @param {{ imagePath: string, displayPath: string, maxChars: number }} options - 展示参数。
 * @returns {{ text: string, weak: boolean, stats: object }} 结果。
 */
export function formatOcrResult(raw, { imagePath, displayPath, maxChars }) {
  const { text, stats } = buildOcrText(raw, { maxChars })
  const meta = [
    `本地 OCR（Windows 引擎，未出网）：${displayPath}`,
    `语言 ${raw.language ?? '?'}${raw.languagePicked === 'ascii-picked-en' ? '（按内容自动切到英文引擎）' : ''}`,
    `${raw.width}×${raw.height}${raw.scale > 1 ? `（放大 ${raw.scale}×）` : ''}`,
    `${stats.charCount} 字 / ${stats.lineCount} 行`,
    `${raw.elapsedMs} ms`,
  ].join(' ｜ ')

  const weak = text.length < 12
  if (weak) {
    return {
      weak: true,
      stats,
      text: [
        meta,
        '⚠ 几乎没认出文字：这张图大概率不是纯文字图（图表 / 照片 / 艺术字 / 手写），或者文字太小、太糊。',
        '→ 改用 ask_qwen 读图（把同一路径交给它），不要靠猜。',
        text.length > 0 ? `（识别到的零碎内容：${text}）` : '',
      ].filter((line) => line.length > 0).join('\n'),
    }
  }
  return {
    weak: false,
    stats,
    text: [meta, '---', text].join('\n'),
  }
}

/**
 * 注册 ocr_image。
 * @param {object} deps - ctx / config（liveConfig Proxy）/ logger。
 * @returns {object} 工具定义。
 */
export function createOcrImageTool(deps) {
  const { config, logger } = deps
  /** @type {Map<string, string>} 简易 LRU：同一张图反复看时直接复用。 */
  const cache = new Map()

  const cacheGet = (key) => {
    if (!cache.has(key)) return undefined
    const value = cache.get(key)
    cache.delete(key)
    cache.set(key, value)
    return value
  }
  const cacheSet = (key, value) => {
    cache.set(key, value)
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  }

  const numberConfig = (key, fallback) => {
    const value = Number(config?.[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  return defineTool({
    name: 'ocr_image',
    description:
      '本地 OCR（Windows 引擎，免费、离线、图片不出网）：抄出**纯文字**截图里的文字'
      + '（代码、日志、报错、表格、文档、聊天记录），通常 1 秒内返回。**图像理解不要用**：'
      + '图表读数、界面排版、画面内容、照片、手写走 ask_qwen；返回"几乎没认出文字"即不是文字图，改用 ask_qwen。缩进可能丢失。',
    parameters: {
      image_path: {
        type: 'string',
        required: true,
        description: '图片路径（绝对路径或相对会话目录；png/jpg/bmp/gif/tif/webp）。',
      },
      language: {
        type: 'string',
        description: 'auto（默认）/ zh-Hans / en-US。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = typeof args.image_path === 'string' ? args.image_path.trim() : ''
      if (input.length === 0) {
        throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：image_path 不能为空。本次没有做任何 OCR。')
      }

      const imagePath = resolveInputPath(input, exec)
      let info
      try {
        info = await stat(imagePath)
      } catch {
        throw new MediaError(CODES.BAD_REQUEST, `图片不存在：${imagePath}。请先确认路径，或改用绝对路径。`)
      }
      if (!info.isFile()) {
        throw new MediaError(CODES.BAD_REQUEST, `不是文件：${imagePath}。image_path 需要指向一张图片。`)
      }
      const extension = extname(imagePath).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension)) {
        // 粘贴图是**无扩展名对象**：按文件头嗅探，别直接拒绝（2026-11-01 修）。
        const sniffed = await sniffImageExtension(imagePath)
        if (sniffed === undefined) {
          throw new MediaError(
            CODES.BAD_REQUEST,
            `不是支持的位图格式：${extension || '（无扩展名）'}，且文件头不是已知位图。` +
              `支持 ${[...IMAGE_EXTENSIONS].join('/')}；其它格式请先转 PNG，或改用 ask_qwen。`,
          )
        }
      }
      const maxBytes = numberConfig('ocrMaxBytes', 20 * 1024 * 1024)
      if (info.size > maxBytes) {
        throw new MediaError(
          CODES.BAD_REQUEST,
          `图片太大（${(info.size / 1024 / 1024).toFixed(1)} MiB > ${(maxBytes / 1024 / 1024).toFixed(1)} MiB）。` +
            '请先压缩或裁剪，或改用 ask_qwen。',
        )
      }

      const language = typeof args.language === 'string' && args.language.trim().length > 0
        ? args.language.trim()
        : String(config?.ocrLanguage ?? '').trim()
      const resolvedLanguage = language.toLowerCase() === 'auto' ? '' : language

      const realPath = await realpath(imagePath).catch(() => imagePath)
      const cacheKey = `${realPath}|${info.mtimeMs}|${info.size}|${resolvedLanguage}`
      const cached = cacheGet(cacheKey)
      if (cached !== undefined) {
        deps.turnGate?.noteEvidence(exec?.agent)
        return { text: cached }
      }

      const raw = await runWindowsOcr({
        imagePath,
        language: resolvedLanguage,
        timeoutMs: numberConfig('ocrTimeoutMs', 20000),
        signal: exec?.signal,
      })

      const { text, weak, stats } = formatOcrResult(raw, {
        imagePath,
        displayPath: input,
        maxChars: numberConfig('ocrMaxChars', 12000),
      })
      if (!weak) cacheSet(cacheKey, text)
      deps.turnGate?.noteEvidence(exec?.agent)
      logger?.debug?.(`[mm-models] ocr_image ${imagePath}: ${stats.charCount} chars in ${raw.elapsedMs} ms (scale ${raw.scale})`)
      return { text }
    },
  })
}
