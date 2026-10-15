/**
 * 两家生成网关的字段映射常量 —— 单一事实源（规划 [8.1] core\fields.mjs）。
 *
 * ⚠ 这些字段名是"预期形态"，只有一次真实提交+查询的实跑才能冻结（规划 [13] S1–S3）。
 *   实跑确证后只改本文件与 README，工具与 Config 的对外形状不变。
 *   确证清单：
 *     A. DashScope：提交路径 / 异步开关头 / input.prompt / parameters.size / task_id 路径 /
 *        状态取值集合 / results[].url / 计价单位。
 *     B. Ark：提交路径 / content 数组形状 / 首帧图字段 / duration·resolution·ratio 字段名 /
 *        任务 id 字段 / status 取值 / video_url 路径 / 计价单位。
 *     C. 通用：错误体结构、限流与并发上限、响应里的用量字段、幂等键。
 */

/**
 * 按 "a.b.c" 路径取值；任一段缺失返回 undefined。
 * @param {unknown} root - 已解析的 JSON。
 * @param {string} path - 点分路径，例如 "output.task_id"。
 * @returns {unknown}
 */
export function getPath(root, path) {
  let current = root
  for (const segment of path.split('.')) {
    if (current === undefined || current === null || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/** 第一个取到非空值的路径。 */
export function firstPath(root, paths) {
  for (const path of paths) {
    const value = getPath(root, path)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** DashScope（阿里云百炼）文生图。 */
export const DASHSCOPE_FIELDS = Object.freeze({
  /** 提交：POST {base}/services/aigc/text2image/image-synthesis */
  submitPath: '/services/aigc/text2image/image-synthesis',
  /** 查询：GET {base}/tasks/{task_id} */
  queryPath: (taskId) => `/tasks/${encodeURIComponent(taskId)}`,
  /** 异步开关头（待实跑确证是否需要）。 */
  asyncHeader: 'X-DashScope-Async',
  /** 请求体字段。 */
  bodyModel: 'model',
  bodyPrompt: 'input.prompt',
  bodyNegative: 'input.negative_prompt',
  bodySize: 'parameters.size',
  bodyN: 'parameters.n',
  /** 响应里的任务 id / 状态 / 进度。 */
  taskIdPaths: ['output.task_id', 'task_id', 'data.task_id'],
  statusPaths: ['output.task_status', 'task_status', 'status'],
  progressPaths: ['output.progress', 'progress'],
  /** 成功后的产物 URL 列表。 */
  resultPaths: ['output.results', 'results', 'data.results'],
  resultUrlPaths: ['url', 'image_url', 'output_url'],
  /** 失败原因。 */
  errorCodePaths: ['code', 'output.code', 'error.code'],
  errorMessagePaths: ['message', 'output.message', 'error.message'],
  /** 用量（用于"按返回用量"记账；实跑确证后启用）。 */
  usageImageCountPaths: ['usage.image_count', 'output.usage.image_count'],
  /** 状态取值集合（厂商差异收口于此；未列出的一律按 running 处理并记录 rawStatus）。 */
  statusValues: Object.freeze({
    queued: ['PENDING', 'QUEUED', 'SUSPENDED'],
    running: ['RUNNING', 'PROCESSING'],
    succeeded: ['SUCCEEDED', 'SUCCESS', 'SUCCEED'],
    failed: ['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN', 'REJECTED'],
  }),
})

/** 方舟 Ark（火山引擎）视频生成。 */
export const ARK_FIELDS = Object.freeze({
  /** 提交：POST {base}/contents/generations/tasks */
  submitPath: '/contents/generations/tasks',
  /** 查询：GET {base}/contents/generations/tasks/{id} */
  queryPath: (taskId) => `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
  /** 请求体字段。 */
  bodyModel: 'model',
  bodyContent: 'content',
  bodyText: 'text',
  bodyImageUrl: 'image_url.url',
  bodyDuration: 'duration',
  bodyResolution: 'resolution',
  bodyRatio: 'ratio',
  bodyFps: 'fps',
  /** 响应里的任务 id / 状态 / 进度。 */
  taskIdPaths: ['id', 'task_id', 'data.id', 'output.task_id'],
  statusPaths: ['status', 'task_status', 'output.task_status', 'data.status'],
  progressPaths: ['progress', 'output.progress'],
  /** 成功后的视频 URL（可能带时效签名，绝不进工具结果）。 */
  videoUrlPaths: ['content.video_url', 'video_url', 'data.video_url', 'output.video_url', 'content.url'],
  /** 失败原因。 */
  errorCodePaths: ['error.code', 'code', 'output.code', 'data.error.code'],
  errorMessagePaths: ['error.message', 'message', 'output.message', 'data.error.message'],
  /** 用量。 */
  usageSecondsPaths: ['usage.duration', 'usage.video_duration', 'duration', 'output.usage.duration'],
  /** 状态取值集合。 */
  statusValues: Object.freeze({
    queued: ['queued', 'pending', 'Queued', 'Pending', 'QUEUED', 'PENDING'],
    running: ['running', 'processing', 'Running', 'Processing', 'RUNNING', 'PROCESSING'],
    succeeded: ['succeeded', 'success', 'Succeeded', 'Success', 'SUCCEEDED', 'SUCCESS'],
    failed: ['failed', 'cancelled', 'canceled', 'expired', 'Failed', 'FAILED', 'CANCELED', 'CANCELLED'],
  }),
})

/**
 * 把厂商 rawStatus 映射到归一化状态。
 * @param {object} spec - DASHSCOPE_FIELDS 或 ARK_FIELDS。
 * @param {unknown} rawStatus - 厂商状态字符串。
 * @returns {'queued'|'running'|'succeeded'|'failed'|'unknown'}
 */
export function mapRawStatus(spec, rawStatus) {
  const text = typeof rawStatus === 'string' ? rawStatus : String(rawStatus ?? '')
  for (const state of ['queued', 'running', 'succeeded', 'failed']) {
    if (spec.statusValues[state].includes(text)) return state
  }
  return 'unknown'
}

/**
 * 按 "a.b.c" 路径写值（中间对象不存在时创建）。
 * @param {object} root - 目标对象。
 * @param {string} path - 点分路径。
 * @param {unknown} value - 要写入的值。
 */
export function setPath(root, path, value) {
  const segments = path.split('.')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    if (current[segment] === undefined || current[segment] === null || typeof current[segment] !== 'object') current[segment] = {}
    current = current[segment]
  }
  current[segments.at(-1)] = value
  return root
}

/**
 * * DashScope qwen-image 同步模式（2026-10-12 实跑确证并冻结；本账号不支持异步调用）：
 *   POST {base}/services/aigc/multimodal-generation/generation
 *   body: { model, input:{ messages:[{role:'user',content:[{text: prompt}]}] },
 *           parameters:{ size, n, prompt_extend, watermark, negative_prompt? } }
 *   响应：output.choices[].message.content[].image（带签名、即取即下）
 *         usage.output_image_count / output_width / output_height
 */
export const DASHSCOPE_SYNC_FIELDS = Object.freeze({
  submitPath: '/services/aigc/multimodal-generation/generation',
  bodyMessages: 'input.messages',
  bodyRole: 'role',
  roleUser: 'user',
  bodyContent: 'content',
  bodyText: 'text',
  bodyParameters: 'parameters',
  bodySize: 'size',
  bodyN: 'n',
  bodyPromptExtend: 'prompt_extend',
  bodyWatermark: 'watermark',
  bodyNegative: 'negative_prompt',
  /** 响应：产物与用量。 */
  requestIdPaths: ['request_id'],
  choicesPaths: ['output.choices', 'choices'],
  contentPaths: ['message.content', 'content'],
  imagePaths: ['image', 'image_url.url', 'url'],
  usageImageCountPaths: ['usage.output_image_count', 'output.usage.output_image_count'],
  usageWidthPaths: ['usage.output_width'],
  usageHeightPaths: ['usage.output_height'],
})
