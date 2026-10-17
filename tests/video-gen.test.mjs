/**
 * video_gen / dashscope-video 适配器验收（2026-10-17 新增链路）。
 *
 * 分两层，都不联网、不花钱：
 *   ① **适配器契约**：短名解析、端点拼装、请求体形状、二维价格档位、状态映射、探测；
 *   ② **端到端**：用本地 http 服务器冒充百炼，跑完 提交 → 轮询 → 下载 → 记账 全链路。
 *
 * 为什么必须要有 ①：百炼的请求体与 Ark 的 content 数组**完全不是一回事**
 * （input/parameters 嵌套、mode 而非 resolution、audio 布尔），照抄 ark-video
 * 会得到一个"能编译、能跑、但厂商 400"的适配器 —— 而 400 之前钱已经花了。
 *
 * 运行：node --import ./tests/register.mjs ./tests/video-gen.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = join(tmpdir(), 'mm-models-video-home')
process.env.DSH_HOME = TEST_HOME

const { makeMp4, createFakeCtx, makeExec } = await import('./fixtures.mjs')
const { Config, apply } = await import('../index.js')
const { CODES } = await import('../core/errors.mjs')
const {
  VIDEO_MODELS,
  dashscopeVideoAdapter,
  resolveBase,
  resolveVideoModel,
} = await import('../tasks/adapters/dashscope-video.mjs')
const { DEFAULT_PRICING } = await import('../core/cost.mjs')

const stats = { passed: 0, failed: 0 }
async function test(name, fn) {
  try {
    await fn()
    stats.passed += 1
    console.log('  \u2713 ' + name)
  } catch (error) {
    stats.failed += 1
    console.log('  \u2717 ' + name)
    console.log('    ' + String(error?.stack ?? error).split('\n').slice(0, 6).join('\n    '))
  }
}

/** 适配器单测用的最小配置：只给端点，不碰 keys / 任务层。 */
function adapterConfig(extra = {}) {
  return { dashscopeWorkspaceId: '1234567890', dashscopeVideoBase: '', ...extra }
}

// ------------------------------------------------------------------ ① 适配器契约

await test('短名解析：别名、真实 id 都能认；认不出来返回 undefined（不静默兜底）', () => {
  assert.equal(resolveVideoModel('kling-v3').id, 'kling/kling-v3-video-generation')
  assert.equal(resolveVideoModel('kling/kling-v3-video-generation').alias, 'kling-v3')
  assert.equal(resolveVideoModel('wan2.5').family, 'wan')
  assert.equal(resolveVideoModel('sora-3'), undefined)
  assert.equal(resolveVideoModel(''), undefined)
  assert.equal(resolveVideoModel(undefined), undefined)
})

await test('端点：WorkspaceId 拼 maas 域名；显式基址优先；缺 WorkspaceId 直接 fail-closed', () => {
  assert.equal(resolveBase(adapterConfig()), 'https://1234567890.cn-beijing.maas.aliyuncs.com/api/v1')
  // 从控制台「业务空间管理」整串粘贴 API Host（含域名）也要能认，且自动补 /api/v1。
  assert.equal(
    resolveBase(adapterConfig({ dashscopeWorkspaceId: 'llm-abc.cn-beijing.maas.aliyuncs.com', dashscopeVideoBase: '' })),
    'https://llm-abc.cn-beijing.maas.aliyuncs.com/api/v1',
  )
  assert.equal(
    resolveBase(adapterConfig({ dashscopeWorkspaceId: '', dashscopeVideoBase: 'llm-abc.cn-beijing.maas.aliyuncs.com' })),
    'https://llm-abc.cn-beijing.maas.aliyuncs.com/api/v1',
  )
  assert.equal(
    resolveBase(adapterConfig({ dashscopeVideoBase: 'https://example.test/api/v1/' })),
    'https://example.test/api/v1',
  )
  assert.throws(() => resolveBase({ dashscopeWorkspaceId: '' }), (error) => {
    assert.equal(error.code, CODES.BAD_REQUEST)
    assert.ok(error.message.includes('dashscopeWorkspaceId'), error.message)
    assert.ok(error.message.includes('未产生任何费用'), error.message)
    return true
  })
})

await test('提交体（可灵）：input/parameters 嵌套 + 异步头 + 模型真实 id', () => {
  const request = dashscopeVideoAdapter.buildSubmit(
    { model: 'kling/kling-v3-video-generation', prompt: '鲸鱼在云海', mode: 'std', duration: 5, ratio: '16:9', audio: true },
    { credential: 'sk-test', config: adapterConfig() },
  )
  assert.equal(request.method, 'POST')
  assert.equal(request.url, 'https://1234567890.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis')
  assert.equal(request.headers.Authorization, 'Bearer sk-test')
  assert.equal(request.headers['X-DashScope-Async'], 'enable')
  assert.equal(request.body.model, 'kling/kling-v3-video-generation')
  assert.equal(request.body.input.prompt, '鲸鱼在云海')
  assert.equal(request.body.parameters.mode, 'std')
  assert.equal(request.body.parameters.duration, 5)
  assert.equal(request.body.parameters.aspect_ratio, '16:9')
  assert.equal(request.body.parameters.audio, true)
  assert.equal(request.body.parameters.watermark, false)
  // 关键：绝对不能是 Ark 的 content 数组形态
  assert.equal(request.body.content, undefined)
})

await test('提交体（万相）：size 用"宽*高"，4K/图生视频被拒绝而不是发出去', () => {
  const request = dashscopeVideoAdapter.buildSubmit(
    { model: 'wan2.5-t2v-preview', prompt: '云海', mode: 'pro', duration: 5, ratio: '9:16' },
    { credential: 'sk-test', config: adapterConfig() },
  )
  assert.equal(request.body.parameters.size, '1080*1920')
  assert.equal(request.body.parameters.mode, undefined, '万相不该带可灵的 mode 字段')
  assert.throws(
    () => dashscopeVideoAdapter.buildSubmit({ model: 'wan2.5-t2v-preview', prompt: 'x', mode: '4k' }, { credential: 'k', config: adapterConfig() }),
    (error) => error.code === CODES.BAD_REQUEST && error.message.includes('4K'),
  )
  assert.throws(
    () => dashscopeVideoAdapter.buildSubmit({ model: 'wan2.5-t2v-preview', prompt: 'x', image: { url: 'https://a/b.png' } }, { credential: 'k', config: adapterConfig() }),
    (error) => error.code === CODES.BAD_REQUEST && error.message.includes('文生视频'),
  )
})

await test('首帧图只接受 http(s)：data URL 被拒（未确证的能力绝不花钱去试）', () => {
  const ok = dashscopeVideoAdapter.buildSubmit(
    { model: 'kling/kling-v3-video-generation', prompt: 'x', image: { url: 'https://cdn.test/first.png' }, mode: 'std' },
    { credential: 'k', config: adapterConfig() },
  )
  assert.deepEqual(ok.body.input.media, [{ type: 'first_frame', url: 'https://cdn.test/first.png' }])
  assert.equal(ok.body.parameters.aspect_ratio, undefined, '图生视频以首帧宽高比为准，不该传 ratio')
  assert.throws(
    () => dashscopeVideoAdapter.buildSubmit(
      { model: 'kling/kling-v3-video-generation', prompt: 'x', image: { dataUrl: 'data:image/png;base64,AAAA' } },
      { credential: 'k', config: adapterConfig() },
    ),
    (error) => error.code === CODES.BAD_REQUEST && error.message.includes('http(s)'),
  )
})

await test('二维价格档位：720P/1080P/4K × 有声/无声，4K 不许被低报成 720P', () => {
  const pricing = DEFAULT_PRICING
  const cost = (mode, audio) =>
    dashscopeVideoAdapter.estimateCost(
      { model: 'kling/kling-v3-video-generation', mode, audio, duration: 5 },
      pricing,
    )
  assert.equal(cost('std', false).unitPrice, 0.6)
  assert.equal(cost('std', false).amount, 3)
  assert.equal(cost('std', true).unitPrice, 0.9)
  assert.equal(cost('pro', true).unitPrice, 1.2)
  assert.equal(cost('4k', false).unitPrice, 3)
  assert.equal(cost('4k', false).amount, 15)
  // Turbo 固定音画同出：有声/无声同价
  assert.equal(
    dashscopeVideoAdapter.estimateCost({ model: 'kling/kling-v3-turbo-video-generation', mode: 'std', audio: true, duration: 5 }, pricing).unitPrice,
    0.8,
  )
  // 未计价模型必须返回 null（不是 0）—— 0 会被闸门当成"免费"。
  assert.equal(dashscopeVideoAdapter.estimateCost({ model: 'no/such-model', duration: 5 }, pricing).unitPrice, null)
})

await test('状态映射：PENDING→queued、SUCCEEDED→artifacts、FAILED→error（不是"成功但空"）', () => {
  const pending = dashscopeVideoAdapter.parseQuery({ output: { task_id: 't', task_status: 'PENDING' } }, { taskId: 't' })
  assert.equal(pending.status, 'queued')
  const done = dashscopeVideoAdapter.parseQuery(
    { output: { task_id: 't', task_status: 'SUCCEEDED', video_url: 'https://cdn.test/out.mp4' } },
    { taskId: 't' },
  )
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.artifacts, ['https://cdn.test/out.mp4'])
  const failed = dashscopeVideoAdapter.parseQuery(
    { output: { task_id: 't', task_status: 'FAILED', code: 'REJECTED', message: '内容审核未通过' } },
    { taskId: 't' },
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.detail, '内容审核未通过')
})

await test('成本安全：tiers 存在但缺该档位 → 返回 null（fail-closed），绝不回落成便宜档的价', () => {
  // 场景：用户嫌贵，把 4K 档位从单价表里删了，然后请求 4K。
  // 旧逻辑会回落到条目价 0.8（1080P），把 8 秒 4K 真实 ¥24 报成 ¥6.4 → 上限 ¥10 放行。
  const without4k = {
    'kling/kling-v3-video-generation': {
      unit: 'second',
      unitPrice: 0.8,
      currency: 'CNY',
      tiers: [
        { mode: 'std', audio: false, unitPrice: 0.6 },
        { mode: 'pro', audio: false, unitPrice: 0.8 },
      ],
    },
  }
  const cost = dashscopeVideoAdapter.estimateCost({ model: 'kling/kling-v3-video-generation', mode: '4k', duration: 8 }, without4k)
  assert.equal(cost.unitPrice, null, '缺档位必须 fail-closed，而不是按 1080P 低报')
  assert.equal(cost.amount, null)
  // 有声档缺失同理：只有无声档时，有声请求也不许拿无声价充数。
  const quietOnly = {
    'kling/kling-v3-video-generation': {
      unit: 'second',
      unitPrice: 0.8,
      currency: 'CNY',
      tiers: [{ mode: 'pro', audio: false, unitPrice: 0.8 }],
    },
  }
  assert.equal(
    dashscopeVideoAdapter.estimateCost({ model: 'kling/kling-v3-video-generation', mode: 'pro', audio: true, duration: 5 }, quietOnly).unitPrice,
    null,
  )
  // 而正常档位仍然要能取到价。
  const normal = dashscopeVideoAdapter.estimateCost({ model: 'kling/kling-v3-video-generation', mode: 'std', duration: 3 }, DEFAULT_PRICING)
  assert.equal(normal.unitPrice, 0.6)
})

await test('成本安全：Turbo 的 4K 在提交前被拒（不是"未计价"文案）', () => {
  assert.throws(
    () => dashscopeVideoAdapter.buildSubmit(
      { model: 'kling/kling-v3-turbo-video-generation', prompt: 'x', mode: '4k', duration: 5 },
      { credential: 'k', config: adapterConfig() },
    ),
    (error) => {
      assert.equal(error.code, CODES.BAD_REQUEST)
      assert.ok(error.message.includes('Turbo 不支持 4K'), error.message)
      assert.ok(error.message.includes('未产生任何费用'), error.message)
      return true
    },
  )
  // 未知画质档也不许静默降级成 std（那会让报价与实际请求不一致）。
  assert.throws(
    () => dashscopeVideoAdapter.buildSubmit(
      { model: 'kling/kling-v3-video-generation', prompt: 'x', mode: '8k' },
      { credential: 'k', config: adapterConfig() },
    ),
    (error) => error.code === CODES.BAD_REQUEST && error.message.includes('未知画质档'),
  )
})


await test('探测：404 视为鉴权通过；401 是 AUTH；缺 WorkspaceId 时如实报 BAD_REQUEST', async () => {
  const fakeFetch = (status) => async () => ({ ok: status < 400, status })
  assert.equal((await dashscopeVideoAdapter.probe({ credential: 'k', config: adapterConfig(), fetchImpl: fakeFetch(404) })).ok, true)
  const auth = await dashscopeVideoAdapter.probe({ credential: 'k', config: adapterConfig(), fetchImpl: fakeFetch(401) })
  assert.equal(auth.ok, false)
  assert.equal(auth.code, CODES.AUTH)
  const missing = await dashscopeVideoAdapter.probe({ credential: 'k', config: { dashscopeWorkspaceId: '' }, fetchImpl: fakeFetch(404) })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, CODES.BAD_REQUEST)
  assert.ok(missing.detail.includes('业务空间'), missing.detail)
})

// ------------------------------------------------------------------ ② 端到端（本地假百炼）

await test('端到端：报价 → 确认 → 提交 → 轮询 → 下载 → 记账（全程本地，不花钱）', async () => {
  const submissions = []
  let polls = 0
  const server = createServer((req, res) => {
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url.includes('/video-synthesis')) {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        submissions.push(JSON.parse(raw))
        send(200, { request_id: 'req-1', output: { task_id: 'task-1', task_status: 'PENDING' } })
      })
      return
    }
    if (req.url.startsWith('/api/v1/tasks/task-1')) {
      polls += 1
      if (polls === 1) return send(200, { output: { task_id: 'task-1', task_status: 'RUNNING' } })
      return send(200, {
        output: {
          task_id: 'task-1',
          task_status: 'SUCCEEDED',
          video_url: `${origin}/files/out.mp4`,
        },
      })
    }
    if (req.url === '/files/out.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      res.end(makeMp4())
      return
    }
    send(404, { code: 'NotFound', message: 'no route' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  const tmp = await mkdtemp(join(tmpdir(), 'mm-video-e2e-'))
  const config = new Config({
    dashscopeVideoBase: `${origin}/api/v1`,
    dashscopeWorkspaceId: '',
    enableVideoGen: true,
    videoModel: 'kling/kling-v3-video-generation',
    // 闸门保持**生产语义**（默认开确认），用两步调用来证明它真的拦得住。
    requireSpendConfirm: true,
    noConfirmUnderCNY: 0,
    videoCostLimitCNY: 0,
    videoSessionCostLimitCNY: 0,
    maxCallsPerTurn: 0,
    taskTimeoutMs: 5000,
    videoTimeoutMs: 5000,
    taskPollIntervalMs: 500,
    taskPollMaxIntervalMs: 500,
    httpTimeoutMs: 5000,
    queryRetries: 1,
    outDir: join(tmp, 'gen'),
    videoOutDir: join(tmp, 'gen', 'video'),
    ledgerPath: join(tmp, 'ledger.json'),
  })
  const fake = createFakeCtx({ credentials: { DASHSCOPE_API_KEY: 'sk-test' }, llmProviders: ['glm'] })
  apply(fake.ctx, config)
  const tools = Object.fromEntries(fake.tools.map((definition) => [definition.name, definition]))
  assert.ok(tools.video_gen !== undefined, 'video_gen 必须注册：' + fake.tools.map((d) => d.name).join(','))
  const exec = makeExec({ cwd: tmp, sessionId: 'sess-video' })

  try {
    // 第一次：只报价，不该发出任何提交请求
    await assert.rejects(
      tools.video_gen.execute({ prompt: '一头鲸鱼在云海里游', model: 'kling-v3', mode: 'std', duration: 5 }, exec),
      (error) => {
        assert.equal(error.code, CODES.BAD_REQUEST)
        assert.ok(error.message.includes('confirm_estimate'), error.message)
        assert.ok(error.message.includes('¥3.00'), '必须报出精确金额：' + error.message)
        return true
      },
    )
    assert.equal(submissions.length, 0, '未确认前绝不允许提交')

    // 第二次：带金额确认 → 真正提交
    const result = await tools.video_gen.execute(
      { prompt: '一头鲸鱼在云海里游', model: 'kling-v3', mode: 'std', duration: 5, confirm_estimate: 3 },
      exec,
    )
    assert.equal(result.taskId, 'task-1')
    assert.equal(result.videos.length, 1)
    assert.ok(result.videos[0].bytes > 0)
    assert.ok((await stat(result.videos[0].path)).size > 0, '产物必须真的落盘')
    assert.equal(submissions.length, 1)
    // 提交体形状（也就是百炼真正收到的东西）
    assert.equal(submissions[0].model, 'kling/kling-v3-video-generation')
    assert.equal(submissions[0].parameters.mode, 'std')
    assert.equal(submissions[0].parameters.audio, false)

    // 记账：0.6 元/秒 × 5 秒 = 3 元，模型 id 必须是真实 id
    const ledger = JSON.parse(await readFile(join(tmp, 'ledger.json'), 'utf8'))
    const rows = Array.isArray(ledger) ? ledger : ledger.records ?? []
    const row = rows.find((entry) => entry.taskId === 'task-1')
    assert.ok(row !== undefined, '必须记账：' + JSON.stringify(ledger).slice(0, 300))
    assert.equal(row.model, 'kling/kling-v3-video-generation')
    assert.equal(row.unitPrice, 0.6)
    assert.equal(row.amount, 3)
    assert.equal(row.sessionId, 'sess-video')
  } finally {
    server.close()
  }
})

await test('成本安全：远端已出片但下载失败 → 账本仍必须有这一笔（否则会话上限被绕过）', async () => {
  // 复现 2026-10-17 复查发现的漏账口：成功路径的记账在产物落盘之后，
  // 下载一失败，这笔钱就从账本上消失了 —— 会话累计上限永远看不到它。
  let polls = 0
  const server = createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url.includes('/video-synthesis')) {
      return send(200, { output: { task_id: 'task-broken', task_status: 'PENDING' } })
    }
    if (req.url.startsWith('/api/v1/tasks/task-broken')) {
      polls += 1
      if (polls === 1) return send(200, { output: { task_id: 'task-broken', task_status: 'RUNNING' } })
      return send(200, { output: { task_id: 'task-broken', task_status: 'SUCCEEDED', video_url: `${origin2}/files/broken.mp4` } })
    }
    if (req.url === '/files/broken.mp4') {
      // 产物下载失败（5xx 可重试，但三次都失败后放弃）
      return send(503, { code: 'ServiceUnavailable' })
    }
    send(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin2 = `http://127.0.0.1:${server.address().port}`

  const tmp = await mkdtemp(join(tmpdir(), 'mm-video-broken-'))
  const config = new Config({
    dashscopeVideoBase: `${origin2}/api/v1`,
    enableVideoGen: true,
    videoModel: 'kling/kling-v3-video-generation',
    requireSpendConfirm: false,
    noConfirmUnderCNY: 0,
    videoCostLimitCNY: 0,
    videoSessionCostLimitCNY: 0,
    maxCallsPerTurn: 0,
    taskTimeoutMs: 5000,
    videoTimeoutMs: 5000,
    taskPollIntervalMs: 500,
    taskPollMaxIntervalMs: 500,
    httpTimeoutMs: 5000,
    queryRetries: 1,
    outDir: join(tmp, 'gen'),
    videoOutDir: join(tmp, 'gen', 'video'),
    ledgerPath: join(tmp, 'ledger.json'),
  })
  const fake = createFakeCtx({ credentials: { DASHSCOPE_API_KEY: 'sk-test' }, llmProviders: ['glm'] })
  apply(fake.ctx, config)
  const tools = Object.fromEntries(fake.tools.map((definition) => [definition.name, definition]))
  const exec = makeExec({ cwd: tmp, sessionId: 'sess-broken' })

  try {
    await assert.rejects(
      tools.video_gen.execute({ prompt: '下载会失败的测试', model: 'kling-v3', mode: 'std', duration: 3 }, exec),
      (error) => {
        assert.ok(['UNAVAILABLE', 'UNKNOWN'].includes(error.code), '应当是下载/产物类错误：' + error.code)
        return true
      },
    )
    const ledger = JSON.parse(await readFile(join(tmp, 'ledger.json'), 'utf8'))
    const rows = Array.isArray(ledger) ? ledger : ledger.records ?? []
    const row = rows.find((entry) => entry.taskId === 'task-broken')
    assert.ok(row !== undefined, '远端已成功出片，下载失败也必须在账本里留一笔：' + JSON.stringify(ledger).slice(0, 400))
    assert.equal(row.model, 'kling/kling-v3-video-generation', '补记必须用真实模型 id')
    assert.equal(row.unitPrice, 0.6)
    assert.equal(row.amount, 1.8, '3 秒 × 0.6 = 1.8')
    assert.ok(String(row.note ?? '').includes('未取回'), '补记要标注"已提交但未取回"：' + row.note)
  } finally {
    server.close()
  }
})

console.log(`\n[video_gen 验收] 通过 ${stats.passed}，失败 ${stats.failed}`)
process.exit(stats.failed === 0 ? 0 : 1)
