/**
 * 统一异步任务层：submit → poll → fetch（规划 [3]）。
 *
 * 公共层固定策略：
 *   - 轮询 5s 起、轻微退避（默认 ×1.6，10s 封顶）；
 *   - 轮询总时长由 timeoutMs 控制；TIMEOUT 停止本地轮询、保留 taskRef、远端不取消；
 *   - 取消（exec.signal）立刻停止轮询、同样保留 taskRef；
 *   - 只对幂等查询（GET）自动退避重试；提交（POST）绝不自动重发，
 *     唯一例外是"连接根本没建立"（可确证请求未发出）时重试一次；
 *   - 下载产物可能带时效签名，拿到终态立即下载；下载失败按可重试处理；
 *   - 记账在任务成功且产物落盘后由工具层完成（本层只回传用量）。
 */
import {
  CODES,
  STATES,
  TERMINAL_STATES,
  MediaError,
  clip,
  fixedMessage,
  isAbortError,
  isPreSendError,
} from '../core/errors.mjs'
import { downloadToFile, ensureDir } from '../core/deliver.mjs'

/** 拼 URL（base 末尾斜杠与 path 开头斜杠归一化）。 */
export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}

/** 可取消的 sleep。 */
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED)))
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED)))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 创建任务管理器。
 * @param {object} options - adapters（adapter 数组）/ config（插件 Config）/ logger。
 */
export function createTaskManager({ adapters, config, logger }) {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]))
  const log = (level, message, extra) => {
    const fn = logger?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(logger, message, extra)
      } catch {
        // 日志失败绝不能影响任务流水线。
      }
    }
  }

  const get = (adapterId) => {
    const adapter = byId.get(adapterId)
    if (adapter === undefined) throw new MediaError(CODES.UNKNOWN, `内部错误：未知 adapter "${adapterId}"`)
    return adapter
  }

  /**
   * 发一次 JSON 请求。
   * @returns {Promise<unknown>} 已解析的 JSON（解析失败时为 undefined）。
   */
  async function httpJson(adapter, request, options = {}) {
    const where = options.where ?? 'query'
    const provider = adapter.providerLabel ?? adapter.label
    const signal = options.signal
    const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs ?? 60000
    const fetchImpl = options.fetchImpl ?? fetch
    const baseInfo = {
      provider,
      ref: adapter.credentialRef,
      providerKey: adapter.providerKey,
      where,
    }

    if (signal?.aborted) {
      throw new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, { ...baseInfo, taskId: options.taskId }))
    }

    const controller = new AbortController()
    const onCallerAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(new DOMException(`HTTP timeout after ${timeoutMs}ms`, 'TimeoutError')), timeoutMs)
        : undefined

    let response
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) {
        throw new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, { ...baseInfo, taskId: options.taskId }))
      }
      if (isAbortError(error)) {
        throw new MediaError(CODES.UNAVAILABLE, fixedMessage(CODES.UNAVAILABLE, { ...baseInfo, detail: `单次 HTTP 请求超过 ${timeoutMs}ms` }), {
          detail: `HTTP timeout ${timeoutMs}ms`,
        })
      }
      const error_ = new MediaError(CODES.UNAVAILABLE, fixedMessage(CODES.UNAVAILABLE, { ...baseInfo, detail: clip(error?.message) }), {
        detail: clip(error?.message),
      })
      // 只有可确证"请求未发出"的网络错误才允许提交重试。
      error_.preSend = isPreSendError(error)
      throw error_
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }

    const text = await response.text().catch(() => '')
    let json
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }

    if (!response.ok) {
      const mapped = adapter.mapHttpError(response.status, json ?? text)
      const mediaError = new MediaError(mapped.code, fixedMessage(mapped.code, { ...baseInfo, detail: mapped.detail }), {
        status: response.status,
        vendorCode: mapped.vendorCode,
        detail: mapped.detail,
      })
      mediaError.where = where
      mediaError.providerKey = adapter.providerKey
      mediaError.taskId = options.taskId
      throw mediaError
    }
    return json
  }

  /**
   * 提交（POST）。返回 taskRef；失败抛 MediaError。
   * sync adapter（如 DashScope qwen-image 同步模式）在提交响应里直接带回 state，不进入轮询。
   */
  async function submit({ adapterId, spec, credential, signal, fetchImpl, submitTimeoutMs }) {
    const adapter = get(adapterId)
    const mode = typeof adapter.modeFor === 'function' ? adapter.modeFor(config) : 'async'
    const request = adapter.buildSubmit(spec, { credential, config, mode })
    let retriedPreSend = false
    for (;;) {
      try {
        const json = await httpJson(adapter, request, { where: 'submit', signal, fetchImpl, timeoutMs: submitTimeoutMs })
        const parsed = adapter.parseSubmit(json, { mode })
        const taskId = parsed?.taskId
        if (typeof taskId !== 'string' || taskId.length === 0) {
          throw new MediaError(CODES.UNKNOWN, fixedMessage(CODES.UNKNOWN, { provider: adapter.providerLabel, detail: '提交成功但响应里没有任务 id（字段待实跑确证）' }))
        }
        return {
          adapter: adapter.id,
          taskId,
          submittedAt: Date.now(),
          rawStatus: parsed?.rawStatus,
          mode,
          spec,
          ...(parsed?.state === undefined ? {} : { state: parsed.state }),
        }
      } catch (error) {
        if (error?.preSend === true && retriedPreSend === false) {
          retriedPreSend = true
          log('warn', '[mm-models] submit request never left the process; retrying once', { adapter: adapter.id })
          continue
        }
        throw error
      }
    }
  }

  /** 一次性查询（GET，可退避重试）。返回归一化 State。 */
  async function query(taskRef, options = {}) {
    const adapter = get(taskRef.adapter)
    const request = adapter.buildQuery(taskRef.taskId, { credential: options.credential, config })
    const attempts = Math.max(1, (config.queryRetries ?? 2) + 1)
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const json = await httpJson(adapter, request, { where: 'query', signal: options.signal, fetchImpl: options.fetchImpl, taskId: taskRef.taskId })
        const state = adapter.parseQuery(json, { taskId: taskRef.taskId })
        return { ...state, taskId: taskRef.taskId, adapter: adapter.id }
      } catch (error) {
        lastError = error
        const retriable = error.code === CODES.RATE_LIMIT || error.code === CODES.UNAVAILABLE
        if (!retriable || attempt === attempts - 1) {
          error.attempts = attempt + 1
          throw error
        }
        log('warn', '[mm-models] query failed; backing off', { adapter: adapter.id, attempt: attempt + 1, code: error.code })
        await sleep(Math.min(1000 * 2 ** attempt, 8000), options.signal)
      }
    }
    throw lastError
  }

  /** 轮询到终态 / 超时 / 取消。 */
  async function wait(taskRef, options = {}) {
    const adapter = get(taskRef.adapter)
    const timeoutMs = options.timeoutMs ?? config.taskTimeoutMs ?? 600000
    const intervalStart = options.intervalMs ?? config.taskPollIntervalMs ?? 5000
    const intervalMax = config.taskPollMaxIntervalMs ?? 10000
    const startedAt = Date.now()
    let interval = intervalStart
    let lastState = { status: STATES.QUEUED, taskId: taskRef.taskId, adapter: adapter.id, artifacts: [] }

    for (;;) {
      if (options.signal?.aborted) return { ...lastState, status: STATES.ABORTED, elapsedMs: Date.now() - startedAt }
      let state
      try {
        state = await query(taskRef, options)
      } catch (error) {
        if (error.code === CODES.ABORTED) return { ...lastState, status: STATES.ABORTED, elapsedMs: Date.now() - startedAt }
        throw error
      }
      lastState = state
      if (typeof options.onProgress === 'function') {
        try {
          options.onProgress(state)
        } catch {
          // 进度回调失败不影响轮询。
        }
      }
      if (TERMINAL_STATES.has(state.status)) return { ...state, elapsedMs: Date.now() - startedAt }
      const elapsed = Date.now() - startedAt
      if (elapsed >= timeoutMs) return { ...state, status: STATES.TIMEOUT, elapsedMs: elapsed }
      const remaining = timeoutMs - elapsed
      try {
        await sleep(Math.min(interval, remaining), options.signal)
      } catch (error) {
        // 轮询间隔里被取消：同样保留 taskRef（由调用方按 ABORTED 状态呈现）。
        if (error?.code === CODES.ABORTED) return { ...lastState, status: STATES.ABORTED, elapsedMs: Date.now() - startedAt }
        throw error
      }
      interval = Math.min(Math.round(interval * 1.6), intervalMax)
    }
  }

  /**
   * 下载全部产物到 outDir。
   *
   * 重试策略：**只重试可重试的失败**（网络抖动 / HTTP 5xx / 429）。
   * `downloadToFile` 对"体积超限""HTTP 4xx"这类确定性失败标了
   * `retriable: false`，这里直接放弃 —— 2026-07 之前是无差别重试 3 次，
   * 一个超限视频会被完整重下三遍（字节全白流）。
   */
  async function fetchArtifacts(state, options = {}) {
    const adapter = get(state.adapter)
    const urls = Array.isArray(state.artifacts) ? state.artifacts : []
    if (urls.length === 0) return []
    const outDir = options.outDir
    await ensureDir(outDir)
    const results = []
    for (const [index, url] of urls.entries()) {
      const baseName =
        options.nameHint === undefined
          ? `artifact-${index + 1}-${Date.now().toString(36)}`
          : `${options.nameHint}-${String(index + 1).padStart(2, '0')}`
      const maxAttempts = 3
      let lastError
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const file = await downloadToFile(url, {
            outDir,
            name: baseName,
            signal: options.signal,
            maxBytes: config.maxDownloadBytes,
            fetchImpl: options.fetchImpl,
          })
          results.push(file)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          if (options.signal?.aborted || error?.code === CODES.ABORTED) {
            throw new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, { taskId: state.taskId }), { cause: error })
          }
          // 确定性失败（体积超限 / 4xx）：重试不会改变结果，立刻放弃。
          if (error?.retriable === false) break
          log('warn', '[mm-models] artifact download failed; retrying', { adapter: adapter.id, attempt: attempt + 1 })
          if (attempt < maxAttempts - 1) await sleep(1000 * (attempt + 1), options.signal)
        }
      }
      if (lastError !== undefined) {
        // 保留既有 MediaError 的分类（体积超限是 BAD_REQUEST，不是"厂商不可用"）。
        if (lastError instanceof MediaError) {
          if (lastError.taskId === undefined) lastError.taskId = state.taskId
          throw lastError
        }
        throw new MediaError(
          CODES.UNAVAILABLE,
          fixedMessage(CODES.UNAVAILABLE, { provider: adapter.providerLabel, detail: clip(lastError.message) }),
          { detail: clip(lastError.message) },
        )
      }
    }
    return results
  }

  return {
    get,
    list: () => [...byId.values()],
    submit,
    query,
    wait,
    fetchArtifacts,
    /**
     * submit +（异步时）wait 的便捷组合。同步模式（如 qwen-image）直接返回提交响应里的 state。
     * 不足：提交失败时 taskRef 不保留，交由工具层处理错误文案。
     */
    async run({ adapterId, spec, credential, signal, timeoutMs, intervalMs, onProgress, fetchImpl, submitTimeoutMs, onSubmitted }) {
      const taskRef = await submit({ adapterId, spec, credential, signal, fetchImpl, submitTimeoutMs })
      // 提交成功、还没开始等待：这是**登记任务的唯一时机** ——
      // 之后无论超时、取消还是整轮请求失败，task_id 都已经落到注册表里了。
      // 回调失败绝不能影响任务本身（登记是尽力而为的旁路）。
      if (typeof onSubmitted === 'function') {
        try {
          await onSubmitted(taskRef)
        } catch (error) {
          log('warn', 'onSubmitted 回调失败（不影响任务）：' + String(error?.message ?? error))
        }
      }
      // 同步模式的 state 直接来自提交响应：补齐 adapter/taskId，保持与异步 State 同形状。
      if (taskRef.state !== undefined) return { taskRef, state: { ...taskRef.state, adapter: taskRef.adapter, taskId: taskRef.taskId } }
      try {
        const state = await wait(taskRef, { credential, signal, timeoutMs, intervalMs, onProgress, fetchImpl })
        return { taskRef, state }
      } catch (error) {
        error.taskRef = taskRef
        throw error
      }
    },
  }
}
