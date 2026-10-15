/**
 * 试运行用的本地假厂商：DashScope 文生图 + 方舟 Ark 视频 + 产物下载。
 * 不联网、不花钱，但完整走通 submit → poll → fetch / 错误映射 / 超时 / 取消。
 *
 * 场景由提示词里的标记决定：
 *   [auth] 401 · [rate] 429 · [policy] 400 审核 · [bad] 400 参数 · [quota] 400 欠费
 *   [5xx] 500 · [stall] 永不完成 · [conn] 提交后立刻断连（无法确认是否创建）
 *   [noartifact] 成功但无产物字段
 *   [model] **404** InvalidEndpointOrModel.NotFound —— 模型未开通/接入点不存在（方舟真实响应，
 *           2026-10-15 实测抓到）。专门用来钉住"404 不等于参数错误"这个分类。
 *
 * 轮询期故障注入（专为打通 manager 的退避重试层而加，2026-10-13）：
 *   [poll429] / [poll503]  第一次轮询返回 429 / 503，之后恢复 200 —— 验证 query 会退避重试
 *   [pollfail]             每次轮询都 500 —— 验证重试耗尽后抛出（且 attempts 正确）
 *
 * 产物下载故障注入（失败计数按"下载尝试次数"而非任务计）：
 *   [art404]          产物 HTTP 404 —— 确定性失败，**不该**重试
 *   [art5xx-then-ok]  第一次下载 503，之后成功 —— 瞬时失败，**应该**重试并成功
 *   [artbig-header]   声明 content-length 超限（不真发大 body）—— 走快速拒绝分支
 *   [artbig-stream]   不声明 content-length，但实际超过 maxBytes —— 走流式中止分支
 */
import { createServer } from 'node:http'
import { makeMp4, makePng } from './fixtures.mjs'

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const SCENARIOS = [
  'auth', 'rate', 'policy', 'bad', 'quota', '5xx', 'stall', 'conn', 'noartifact', 'model',
  'poll429', 'poll503', 'pollfail',
  'art404', 'art5xx-then-ok', 'artbig-header', 'artbig-stream',
]

function scenarioOf(prompt) {
  for (const name of SCENARIOS) {
    if (typeof prompt === 'string' && prompt.includes(`[${name}]`)) return name
  }
  return 'ok'
}

/**
 * 轮询第 N 次（1-based）该返回什么状态码；undefined = 正常走后续逻辑。
 * 抽成表，避免在 handler 里堆 if。
 */
function pollFault(scenario, pollNumber) {
  if (scenario === 'poll429') return pollNumber === 1 ? 429 : undefined
  if (scenario === 'poll503') return pollNumber === 1 ? 503 : undefined
  if (scenario === 'pollfail') return 500
  return undefined
}

/** 产物下载第 N 次尝试（1-based）该返回什么状态码；undefined = 正常返回字节。 */
function artFault(scenario, attempt) {
  if (scenario === 'art404') return 404
  if (scenario === 'art5xx-then-ok') return attempt === 1 ? 503 : undefined
  return undefined
}

export async function startMockProviders() {
  const png = makePng(4, 4)
  const mp4 = makeMp4(128)
  const tasks = new Map()
  const artHits = new Map()
  const state = { requests: [], probes: [], nextId: 0, logins: { dashscope: 'test-dashscope-key', ark: 'test-ark-key' } }


  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const part of req) chunks.push(part)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw.length > 0 ? safeJson(raw) : undefined
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    state.requests.push({ method: req.method, path, headers: req.headers, body })
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    const authorization = req.headers.authorization ?? ''

    // ---- 产物下载 ----
    // 用请求串携带场景（adapter 会把 submit 时的 spec 场景拼进产物 URL），
    // 并记录"这是第几次尝试"，以便注入 [art5xx-then-ok] 这类第一次失败、之后成功的场景。
    if (path.startsWith('/art/')) {
      const name = decodeURIComponent(path.slice('/art/'.length))
      const query = url.searchParams
      const scenario = query.get('scenario') ?? 'ok'
      const hitKey = name
      const attempt = (artHits.get(hitKey) ?? 0) + 1
      artHits.set(hitKey, attempt)

      const fault = artFault(scenario, attempt)
      if (fault !== undefined) {
        json(fault, { code: fault === 404 ? 'NotFound' : 'InternalError', message: 'artifact fault injected' })
        return
      }
      // 声明的 content-length 就超限：插件应快速拒绝，**不读 body**。
      if (scenario === 'artbig-header') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) })
        // 只写一点点就结束：插件若正确实现，会在读之前就拒绝。
        res.end(png.subarray(0, 64))
        return
      }
      // 不声明 content-length 但实际超限：必须靠流式计数中止。
      if (scenario === 'artbig-stream') {
        const chunk = Buffer.alloc(256 * 1024, 7)
        res.writeHead(200, { 'content-type': 'image/png' })
        for (let sent = 0; sent < 64; sent += 1) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
        }
        res.end()
        return
      }
      if (name.endsWith('.png')) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
        res.end(png)
        return
      }
      if (name.endsWith('.mp4')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4.length })
        res.end(mp4)
        return
      }
      json(404, { code: 'NotFound', message: 'artifact not found' })
      return
    }

    // ---- DashScope 兼容 /models（健康探测）----
    if (path === '/dashscope/compatible-mode/v1/models') {
      state.probes.push({ path, authorization })
      if (authorization !== `Bearer ${state.logins.dashscope}`) {
        json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
        return
      }
      json(200, { data: [{ id: 'qwen-image-3.0' }] })
      return
    }

    // ---- DashScope qwen-image 同步提交（实跑确证的真实路径）----
    if (req.method === 'POST' && path === '/dashscope/api/v1/services/aigc/multimodal-generation/generation') {
      if (authorization !== 'Bearer ' + state.logins.dashscope) {
        json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
        return
      }
      const prompt = body?.input?.messages?.[0]?.content?.[0]?.text ?? ''
      const scenario = scenarioOf(prompt)
      if (scenario === 'auth') return json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
      if (scenario === 'rate') return json(429, { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' })
      if (scenario === 'policy') return json(400, { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' })
      if (scenario === 'bad') return json(400, { code: 'InvalidParameter', message: 'size is invalid' })
      if (scenario === 'quota') return json(400, { code: 'InsufficientBalance', message: 'Account balance is insufficient' })
      if (scenario === '5xx') return json(500, { code: 'InternalError', message: 'internal error' })
      if (scenario === 'conn') {
        req.socket.destroy()
        return
      }
      state.nextId += 1
      const id = 'sync-' + state.nextId
      const count = Number(body?.parameters?.n ?? 1)
      // ?scenario= 让产物下载端知道该注入哪种故障（与提交时的场景一致）。
      const results = scenario === 'noartifact' ? [] : Array.from({ length: count }, (_, index) => ({ image: baseUrl() + '/art/' + id + '-' + (index + 1) + '.png?scenario=' + encodeURIComponent(scenario), type: 'image' }))
      json(200, {
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: results } }], rewrite_status: 'not_use' },
        usage: { output_image_count: results.length, output_width: 1024, output_height: 1024 },
        request_id: id,
      })
      return
    }

    // ---- DashScope 提交（异步 wanx 路径）----
    if (req.method === 'POST' && path === '/dashscope/api/v1/services/aigc/text2image/image-synthesis') {
      if (authorization !== `Bearer ${state.logins.dashscope}`) {
        json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
        return
      }
      const prompt = body?.input?.prompt ?? ''
      const scenario = scenarioOf(prompt)
      if (scenario === 'auth') return json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
      if (scenario === 'rate') return json(429, { code: 'Throttling', message: 'Requests rate limit exceeded' })
      if (scenario === 'policy') return json(400, { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' })
      if (scenario === 'bad') return json(400, { code: 'InvalidParameter', message: 'size is invalid' })
      if (scenario === 'quota') return json(400, { code: 'InsufficientBalance', message: 'Account balance is insufficient' })
      if (scenario === '5xx') return json(500, { code: 'InternalError', message: 'internal error' })
      if (scenario === 'conn') {
        req.socket.destroy()
        return
      }
      state.nextId += 1
      const id = `ds-${state.nextId}`
      tasks.set(id, { kind: 'image', polls: 0, scenario, count: Number(body?.parameters?.n ?? 1), prompt })
      json(200, { output: { task_id: id, task_status: 'PENDING' }, request_id: `req-${state.nextId}` })
      return
    }

    // ---- DashScope 查询（含健康探测使用的假 id）----
    if (req.method === 'GET' && path.startsWith('/dashscope/api/v1/tasks/')) {
      if (authorization !== `Bearer ${state.logins.dashscope}`) {
        json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
        return
      }
      const id = decodeURIComponent(path.slice('/dashscope/api/v1/tasks/'.length))
      const task = tasks.get(id)
      if (task === undefined) {
        json(404, { code: 'InvalidTaskId', message: 'task not found' })
        return
      }
      task.polls += 1
      // 轮询期故障注入：让 manager 的退避重试层真正被执行到。
      const fault = pollFault(task.scenario, task.polls)
      if (fault === 429) {
        json(429, { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' })
        return
      }
      if (fault !== undefined) {
        json(fault, { code: 'InternalError', message: 'poll fault injected' })
        return
      }
      if (task.scenario === 'stall' || task.polls <= 1) {
        json(200, { output: { task_id: id, task_status: 'RUNNING', progress: task.polls * 10 }, usage: { image_count: 0 } })
        return
      }
      if (task.scenario === 'noartifact') {
        // "成功但没有产物字段"：验证插件不会把失败伪装成成功。
        json(200, { output: { task_id: id, task_status: 'SUCCEEDED', results: [] }, usage: { image_count: task.count } })
        return
      }
      json(200, {
        output: {
          task_id: id,
          task_status: 'SUCCEEDED',
          // ?scenario= 让产物下载端知道该注入哪种故障（与 submit 的场景一致）。
          results: Array.from({ length: task.count }, (_, index) => ({ url: `${baseUrl()}/art/${id}-${index + 1}.png?scenario=${encodeURIComponent(task.scenario)}` })),
        },
        usage: { image_count: task.count },
      })
      return
    }

    // ---- Ark 提交 ----
    if (req.method === 'POST' && path === '/ark/api/v3/contents/generations/tasks') {
      if (authorization !== `Bearer ${state.logins.ark}`) {
        json(401, { code: 'AuthenticationError', message: 'invalid api key' })
        return
      }
      const text = Array.isArray(body?.content) ? body.content.find((entry) => entry?.type === 'text')?.text ?? '' : ''
      // 记录"最后一次真正到达厂商的提交"。花费闸门的测试靠它证明**请求根本没发出去**
      // ——"提交前拦下"和"提交后报错"是两件完全不同的事，账单差一个数量级。
      state.lastSubmit = { model: body?.model, duration: body?.duration, prompt: text, at: Date.now() }
      const scenario = scenarioOf(text)
      if (scenario === 'auth') return json(401, { code: 'AuthenticationError', message: 'invalid api key' })
      if (scenario === 'rate') return json(429, { code: 'RateLimitExceeded', message: 'rate limit exceeded' })
      if (scenario === 'policy') return json(400, { code: 'SensitiveContentDetected', message: 'content may be sensitive' })
      if (scenario === 'bad') return json(400, { code: 'InvalidParameter', message: 'duration is invalid' })
      if (scenario === 'quota') return json(400, { code: 'InsufficientBalance', message: 'balance not enough' })
      if (scenario === '5xx') return json(500, { code: 'InternalError', message: 'internal error' })
      // [model] 复现方舟真实响应（2026-10-15 实测抓到）：模型未开通 / 接入点不存在时返回 **404**。
      // 若按 404 的通用映射会误报成"参数不被接受"，把一个"去控制台开通"的问题说成"改参数"。
      // 这条场景就是用来钉住这个分类的。
      if (scenario === 'model') {
        return json(404, {
          error: {
            code: 'InvalidEndpointOrModel.NotFound',
            message: 'The model or endpoint seedance-2.0 does not exist or you do not have access to it.',
            type: 'Not Found',
          },
        })
      }
      if (scenario === 'conn') {
        req.socket.destroy()
        return
      }
      state.nextId += 1
      const id = `ark-${state.nextId}`
      tasks.set(id, { kind: 'video', polls: 0, scenario, body })
      json(200, { id, status: 'queued' })
      return
    }

    // ---- Ark 查询 ----
    if (req.method === 'GET' && path.startsWith('/ark/api/v3/contents/generations/tasks/')) {
      if (authorization !== `Bearer ${state.logins.ark}`) {
        json(401, { code: 'AuthenticationError', message: 'invalid api key' })
        return
      }
      const id = decodeURIComponent(path.slice('/ark/api/v3/contents/generations/tasks/'.length))
      if (id === 'mm-health-probe') state.probes.push({ path, authorization })
      const task = tasks.get(id)
      if (task === undefined) {
        json(404, { code: 'NotFound', message: 'task not found' })
        return
      }
      task.polls += 1
      const arkFault = pollFault(task.scenario, task.polls)
      if (arkFault === 429) {
        json(429, { code: 'RateLimitExceeded', message: 'rate limit exceeded' })
        return
      }
      if (arkFault !== undefined) {
        json(arkFault, { code: 'InternalError', message: 'poll fault injected' })
        return
      }
      if (task.scenario === 'stall' || task.polls <= 1) {
        json(200, { id, status: 'running', progress: task.polls * 10 })
        return
      }
      json(200, { id, status: 'succeeded', content: { video_url: `${baseUrl()}/art/${id}.mp4?scenario=${encodeURIComponent(task.scenario)}` }, usage: { completion_tokens: 12 } })
      return
    }

    json(404, { code: 'NotFound', message: `no mock route for ${req.method} ${path}` })
  })

  let listening = false
  const baseUrl = () => `http://127.0.0.1:${server.address().port}`
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  listening = true

  return {
    base: baseUrl(),
    state,
    tasks,
    submitCount(kind) {
      const paths =
        kind === 'ark'
          ? ['/ark/api/v3/contents/generations/tasks']
          : ['/dashscope/api/v1/services/aigc/text2image/image-synthesis', '/dashscope/api/v1/services/aigc/multimodal-generation/generation']
      return state.requests.filter((entry) => entry.method === 'POST' && paths.includes(entry.path)).length
    },
    close() {
      if (!listening) return Promise.resolve()
      listening = false
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
