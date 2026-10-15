/**
 * 百炼 Qwen-VL 视觉型号实跑验证（ask_qwen 的厂商路由）。
 *
 * 把一张"左红右蓝"的真实 PNG 发给 DashScope 的 OpenAI 兼容端点，
 * 要求只回答左右颜色 —— 答对 = 模型真的看到了图（不是占位符）。
 * 请求形状与 `llm-pi-ai` 的 qwen-vl 路由一致：{ type: 'image_url', image_url: { url } }。
 *
 * key 解析顺序（与插件一致，不打印 key 本身）：
 *   1. 进程环境变量 DASHSCOPE_API_KEY；
 *   2. ~/.dsh/.env （dsh 启动时会自行加载的那份）。
 *
 * 用法：node tests/vision-probe-qwen.mjs [model...]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeSplitPng } from './fixtures.mjs'

/** 极简 .env 读取：只取 KEY=VALUE 行，忽略注释与空行。 */
function loadEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const values = {}
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const name = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      values[name] = value
    }
    return values
  } catch {
    return {}
  }
}

const envFile = loadEnvFile(join(homedir(), '.dsh', '.env'))
const key = (process.env.DASHSCOPE_API_KEY ?? '').trim() || (envFile.DASHSCOPE_API_KEY ?? '').trim()
if (key.length === 0) {
  console.log('跳过：未设置 DASHSCOPE_API_KEY（环境变量与 ~/.dsh/.env 都没有）')
  process.exit(0)
}
console.log('key 来源：' + ((process.env.DASHSCOPE_API_KEY ?? '').trim().length > 0 ? '环境变量' : '~/.dsh/.env') + '，长度 ' + key.length)

const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['qwen3-vl-plus']
const png = makeSplitPng(160, 80, [220, 30, 30], [30, 60, 220])
const dataUrl = 'data:image/png;base64,' + png.toString('base64')

let anyOk = false
for (const model of models) {
  try {
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图左半部分和右半部分分别是什么颜色？只回答：左X，右Y。' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    })
    const json = await response.json().catch(() => undefined)
    const reply = json?.choices?.[0]?.message?.content
    const text = typeof reply === 'string' ? reply : Array.isArray(reply) ? reply.map((part) => part?.text ?? '').join('') : undefined
    const ok = typeof text === 'string' && /红|red/i.test(text) && /蓝|blue/i.test(text)
    if (ok) anyOk = true
    console.log(model, '=> HTTP', response.status, '|', typeof text === 'string' ? text.replace(/\s+/g, ' ').slice(0, 80) : JSON.stringify(json?.error ?? json).slice(0, 200), ok ? '✅ 看到图' : '')
  } catch (error) {
    console.log(model, '=> 连接失败', error?.message)
  }
}

if (!anyOk) {
  console.error('\nQWEN-VL PROBE FAIL：没有任何型号答对"左红右蓝"')
  process.exitCode = 1
} else {
  console.log('\nQWEN-VL PROBE OK：qwen-vl 路由可用，模型真的看到了图片。')
}
