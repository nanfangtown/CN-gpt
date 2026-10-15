/**
 * 试运行用的假 LLM：OpenAI 兼容 /v1/chat/completions + SSE 流式。
 * 第一次请求返回工具调用；收到工具结果后返回最终文本。
 * 只在沙箱 profile 的试运行里使用，不是插件的一部分。
 *
 * @param {object} [options]
 * @param {'ask_glm'|'ask_qwen'} [options.readerTool] - 读图时调用哪个读图子代理（默认 ask_glm）。
 * @param {'ask_glm'|'ask_qwen'} [options.probeMutexTool] - 拿到第一个读图结果后，再故意调一次这个
 *   读图工具，用来验证互斥 guard 会拒绝它（调用被拒后模型收到错误、随后给终答）。
 */
import { createServer } from 'node:http'
import { FIXTURE_PNG } from './_paths.mjs'

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startMockLlm(options = {}) {
  const readerTool = options.readerTool === 'ask_qwen' ? 'ask_qwen' : 'ask_glm'
  const probeMutexTool = options.probeMutexTool === 'ask_qwen' ? 'ask_qwen' : options.probeMutexTool === 'ask_glm' ? 'ask_glm' : undefined
  const readerCallArgs = (userText) => {
    // 路径必须与 e2e 写盘的位置一致；从 _paths.mjs 取，避免硬编码本机路径。
    const prompt =
      '读取这张图片并回答：左半部分和右半部分分别是什么颜色？只回答：左X，右Y。图片路径：' + FIXTURE_PNG +
      (userText.includes('[reader-fail]') ? ' [reader-fail]' : '')
    return JSON.stringify({ description: '读图', prompt })
  }
  const state = {
    requests: [],
    toolCalls: 0,
    qwenDrawCalls: 0,
    videoCalls: 0,
    askGlmCalls: 0,
    askQwenCalls: 0,
    reportCalls: 0,
    readerRuns: 0,
    readerFailures: 0,
    readerTool,
    mutexProbes: 0,
    guardRejections: 0,
  }
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !String(req.url).startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const body = JSON.parse((await readBody(req)) || '{}')
    state.requests.push(body)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const toolMessages = messages.filter((message) => message.role === 'tool')
    const systemText = messages.filter((message) => message.role === 'system').map((message) => String(message.content ?? '')).join('\n')
    const userText = messages.filter((message) => message.role === 'user').map((message) => String(message.content ?? '')).join('\n')
    // 两个读图员共用同一段 persona 开头（"你是多模态阅读员"），所以这里一次就能认出子代理。
    const isReaderChild = JSON.stringify(body).includes('多模态阅读员') || JSON.stringify(body).includes('只看图说话')
    const wantsReader = /读图|看图|阅读员|描述.*图/.test(userText)
    const wantsReport = /健康|成本|花了多少/.test(userText)
    const wantsVideo = /视频|出片/.test(userText)
    const base = {
      id: 'chatcmpl-mock-' + state.requests.length,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'mock-1',
    }
    // 可选失败场景：让子代理的模型请求 401，用于验证 degradeToText 钩子（必须在 SSE 头之前）。
    if (isReaderChild && userText.includes('[reader-fail]')) {
      state.readerFailures += 1
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock 401 for reader' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n')

    if (isReaderChild) {
      // ask_glm 子代理：直接给出"读图结论"。
      state.readerRuns += 1
      const readerText = '图中是一只鲸鱼，背景是云海；文字内容为「whale」。'
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: readerText }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    } else if (toolMessages.length === 0) {
      state.toolCalls += 1
      if (wantsReport) {
        state.reportCalls += 1
        const args = JSON.stringify({ action: 'health' })
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{ index: 0, id: 'call_report_1', type: 'function', function: { name: 'media_report', arguments: args } }],
              },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else if (wantsVideo) {
        state.videoCalls += 1
        const args = JSON.stringify({ prompt: '海浪拍打沙滩，日系动画风', duration: 5, resolution: '720p', ratio: '16:9' })
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{ index: 0, id: 'call_video_1', type: 'function', function: { name: 'seedance_video', arguments: args } }],
              },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else if (wantsReader) {
        if (readerTool === 'ask_qwen') state.askQwenCalls += 1
        else state.askGlmCalls += 1
        const args = readerCallArgs(userText)
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{ index: 0, id: 'call_reader_1', type: 'function', function: { name: readerTool, arguments: args } }],
              },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        state.qwenDrawCalls += 1
        const args = JSON.stringify({ prompt: '一只鲸鱼在云海里游，插画风格' })
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{ index: 0, id: 'call_qwen_1', type: 'function', function: { name: 'qwen_draw', arguments: args } }],
              },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      }
    } else if (wantsReport && toolMessages.length === 1) {
      // 第二次调用：成本报表（验证真实账本读取与 scope=session 过滤）。
      state.reportCalls += 1
      const args = JSON.stringify({ action: 'cost', scope: 'session' })
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [{ index: 0, id: 'call_report_2', type: 'function', function: { name: 'media_report', arguments: args } }],
            },
            finish_reason: null,
          },
        ],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else if (probeMutexTool !== undefined && !toolMessages.some((message) => String(message.content ?? '').includes('已关闭')) && toolMessages.length === 1) {
      // 第二次调用：故意碰一下互斥的另一个读图工具，验证 guard 会拒绝它。
      // 被拒后模型会收到一条错误结果，下一次请求里就能看到"已关闭"字样。
      state.mutexProbes += 1
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [{ index: 0, id: 'call_mutex_probe', type: 'function', function: { name: probeMutexTool, arguments: readerCallArgs('') } }],
            },
            finish_reason: null,
          },
        ],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      if (toolMessages.some((message) => String(message.content ?? '').includes('已关闭'))) state.guardRejections += 1
      const summary = toolMessages.map((message) => String(message.content ?? '').slice(0, 4000)).join(' | ')
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '已完成绘制，工具返回：' + summary }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
