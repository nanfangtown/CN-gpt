import { makeSplitPng } from './fixtures.mjs'
const key = process.env.QWEN_KEY
const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
const list = await (await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/models', { headers })).json()
const vl = (list.data ?? []).map((row) => row.id).filter((id) => /vl|vision|omni/i.test(id))
console.log('VL 相关型号:', vl)
const png = makeSplitPng(160, 80, [220, 30, 30], [30, 60, 220])
const dataUrl = 'data:image/png;base64,' + png.toString('base64')
const candidates = ['qwen3-vl-plus', 'qwen-vl-max', 'qwen-vl-plus', 'qwen-vl-max-latest', 'qwen3-vl-235b-a22b-instruct']
for (const model of candidates) {
  if (!vl.includes(model)) continue
  try {
    const started = Date.now()
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model, max_tokens: 64, stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: '这张图左半部分和右半部分分别是什么颜色？只回答：左X，右Y。' }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      }),
    })
    const json = await response.json().catch(() => undefined)
    const reply = json?.choices?.[0]?.message?.content
    console.log(model, '=> HTTP', response.status, Date.now() - started + 'ms', '|', typeof reply === 'string' ? reply.replace(/\s+/g, ' ').slice(0, 60) : JSON.stringify(json).slice(0, 160))
  } catch (error) {
    console.log(model, '=> 失败', error?.message)
  }
}
