/**
 * 只读能力探测（不产生生成费用）：
 *   - DashScope：GET /compatible-mode/v1/models 列出可用模型 id（验证 key + 找到制图型号）；
 *   - 智谱：POST /api/paas/v4/chat/completions，max_tokens=1（验证 key + 型号是否存在，token 费极小）；
 *   - 方舟 Ark：GET 一个不存在的任务（404=鉴权通过端点可达，401/403=key 问题）。
 * key 全部从环境变量读取，只打印脱敏结果。
 */
const keys = {
  dashscope: process.env.DASHSCOPE_API_KEY,
  ark: process.env.ARK_API_KEY,
  zhipu: process.env.ZHIPU_API_KEY,
}

function mask(value) {
  if (typeof value !== 'string' || value.length === 0) return '(未设置)'
  return value.slice(0, 6) + '…' + value.slice(-3)
}

function log(label, payload) {
  console.log('\n### ' + label)
  console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
}

// ---- DashScope：列模型 ----
if (keys.dashscope === undefined) log('DashScope', '跳过：未设置 DASHSCOPE_API_KEY')
else {
  try {
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/models', {
      headers: { Authorization: 'Bearer ' + keys.dashscope },
    })
    const json = await response.json().catch(() => undefined)
    const ids = Array.isArray(json?.data) ? json.data.map((row) => row?.id).filter(Boolean) : []
    const wanted = ids.filter((id) => /image|wan|qwen/i.test(String(id)))
    log('DashScope /models（key=' + mask(keys.dashscope) + '）', {
      http: response.status,
      modelCount: ids.length,
      imageLikeModels: wanted.slice(0, 40),
      error: response.ok ? undefined : json,
    })
  } catch (error) {
    log('DashScope /models', '连接失败：' + (error?.message ?? error))
  }
}

// ---- 智谱：最小 chat 验证 key 与视觉型号 ----
if (keys.zhipu === undefined) log('Zhipu', '跳过：未设置 ZHIPU_API_KEY')
else {
  for (const model of ['glm-4.6v', 'glm-4.5v', 'glm-4v-flash']) {
    try {
      const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + keys.zhipu, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      })
      const json = await response.json().catch(() => undefined)
      const message = json?.choices?.[0]?.message?.content
      log('Zhipu ' + model + '（key=' + mask(keys.zhipu) + '）', {
        http: response.status,
        ok: response.ok,
        reply: typeof message === 'string' ? message.slice(0, 40) : undefined,
        error: response.ok ? undefined : json?.error ?? json,
      })
      if (response.ok) break
    } catch (error) {
      log('Zhipu ' + model, '连接失败：' + (error?.message ?? error))
    }
  }
}

// ---- Ark：最小只读探测 ----
if (keys.ark === undefined) log('Ark', '跳过：未设置 ARK_API_KEY')
else {
  try {
    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/mm-key-probe', {
      headers: { Authorization: 'Bearer ' + keys.ark },
    })
    const json = await response.json().catch(() => undefined)
    log('Ark 只读探测（key=' + mask(keys.ark) + '）', {
      http: response.status,
      verdict: response.status === 404 ? '鉴权通过、端点可达' : response.status === 401 || response.status === 403 ? 'key 无效或被拒' : '见响应',
      body: json,
    })
  } catch (error) {
    log('Ark 只读探测', '连接失败：' + (error?.message ?? error))
  }
}
