/**
 * 智谱视觉型号实跑验证：把一张"左红右蓝"的真实 PNG 发给模型，
 * 要求只回答左右颜色 —— 答对 = 模型真的看到了图（不是占位符）。
 * 用法：ZHIPU_API_KEY=... node tests/vision-probe.mjs [model...]
 */
import { makeSplitPng } from './fixtures.mjs'

const key = process.env.ZHIPU_API_KEY
if (key === undefined || key.trim().length === 0) {
  console.log('跳过：未设置 ZHIPU_API_KEY')
  process.exit(0)
}
const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['glm-4.6v', 'glm-4.5v', 'glm-4v-flash']
const png = makeSplitPng(160, 80, [220, 30, 30], [30, 60, 220])
const dataUrl = 'data:image/png;base64,' + png.toString('base64')

for (const model of models) {
  try {
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 32,
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
    const ok = typeof reply === 'string' && /红|red/i.test(reply) && /蓝|blue/i.test(reply)
    console.log(model, '=> HTTP', response.status, '|', typeof reply === 'string' ? reply.replace(/\s+/g, ' ').slice(0, 80) : JSON.stringify(json?.error ?? json).slice(0, 160), ok ? '✅ 看到图' : '')
    if (response.ok && ok) break
  } catch (error) {
    console.log(model, '=> 连接失败', error?.message)
  }
}
