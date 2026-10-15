/**
 * qwen_draw —— DashScope 异步文生图（规划 [2.2]）。
 *
 * 失败一律转成可读的工具结果（MediaError → "Error: <人话>"），绝不中断整轮；
 * 不把 key、签名 URL、内部请求头写进结果。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError, STATES, fixedMessage } from '../core/errors.mjs'
import { attachImage, imageContentBlock, imageSize, resolveOutDir, shouldAttachImage, shortHash, slugify, stamp } from '../core/deliver.mjs'
import { keySpec } from '../core/keys.mjs'
import { pricingOf } from '../core/cost.mjs'
import { cacheKeyOf } from '../core/cache.mjs'
import { asMediaError, budgetMessage, sessionIdOf, stateFailureToError } from '../core/tool-kit.mjs'

const KEY = keySpec('dashscope')
const ADAPTER_ID = 'dashscope-image'

/** 归一化 size：接受 1024x1024 / 1024*1024 / 1024×1024。 */
function normalizeSize(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const match = /^(\d{3,5})\s*[*x×]\s*(\d{3,5})$/iu.exec(trimmed)
  return match === null ? trimmed : `${match[1]}*${match[2]}`
}

/**
 * 注册 qwen_draw。
 * @param {object} deps - ctx / config / manager / keys / getLedger / getTaskRegistry / getImageCache / budget。
 */
export function createQwenDrawTool(deps) {
  const { ctx, config, manager, keys, getLedger, getTaskRegistry, getImageCache, budget } = deps

  return defineTool({
    name: 'qwen_draw',
    description: '文生图（Qwen）：按提示词生成图片，返回本地路径与图片内容块；失败给出原因与建议。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述，越具体越好' },
      negative: { type: 'string', description: '负向提示词' },
      size: { type: 'string', description: '如 1024*1024；留空用模型默认' },
      n: { type: 'integer', description: '张数，默认 1，最大 4' },
      out_dir: { type: 'string', description: '产物目录，默认 gen' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          model: { type: 'string', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                mediaType: { type: 'string', required: true },
                width: { type: 'integer' },
                height: { type: 'integer' },
                attachmentId: { type: 'string' },
              },
            },
          },
          elapsedMs: { type: 'integer', required: true },
          cached: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const header =
          value.cached === true
            ? '出图缓存命中，复用已有 ' + value.images.length + ' 张图片（模型 ' + value.model + '，未产生新调用、未计费）：'
            : '已生成 ' + value.images.length + ' 张图片（模型 ' + value.model + '，task_id ' + value.taskId + '，耗时 ' + Math.round(value.elapsedMs / 1000) + 's）：'
        const blocks = [{ type: 'text', text: header }]
        for (const image of value.images) {
          const size = image.width === undefined || image.height === undefined ? '' : '，' + image.width + '×' + image.height
          blocks.push({ type: 'text', text: '- ' + image.path + '（' + image.mediaType + size + '，' + image.bytes + ' bytes）' })
          if (shouldAttachImage(config, image)) {
            blocks.push(
              imageContentBlock({
                attachmentId: image.attachmentId,
                mediaType: image.mediaType,
                bytes: image.bytes,
                width: image.width,
                height: image.height,
                name: basename(image.path),
              }),
            )
          }
        }
        // 默认只回路径：明确说一句，免得模型以为图丢了而重画。
        if (config?.attachResultImages !== true) {
          blocks.push({
            type: 'text',
            text: '（图片已保存在上面的路径；按当前设置未把图片内容附回上下文。需要模型自己看图时，在 插件页 → gpt-CN → 配置卡 打开 attachResultImages。）',
          })
        } else if (blocks.length === 1) {
          blocks.push({ type: 'text', text: '（未取得可展示的图片内容块，请按路径查看文件）' })
        }
        return blocks
      },
      presentationMeta: (_args, value) => ({ taskId: value.taskId, model: value.model, paths: value.images.map((image) => image.path) }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      try {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt.length === 0) throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：prompt 不能为空；请提供画面描述后重试')
        const n = Math.min(Math.max(Number.isFinite(args.n) ? Math.trunc(args.n) : 1, 1), 4)
        const spec = { model: config.qwenModel, prompt, n }
        if (typeof args.negative === 'string' && args.negative.trim().length > 0) spec.negativePrompt = args.negative.trim()
        const size = normalizeSize(args.size)
        if (size !== undefined) spec.size = size

        const credential = await keys.resolve(KEY)
        if (credential === undefined) {
          throw new MediaError(CODES.MISSING_CREDENTIAL, fixedMessage(CODES.MISSING_CREDENTIAL, { ref: KEY.ref }))
        }

        // 出图缓存：命中就直接复用上次的产物 —— 不扣配额、不再计费、也不产生新文件。
        // 放在凭据检查之后：没配 key 的调用本就不该"命中"并给出产物。
        const cache = await getImageCache()
        const cacheKey = cache === undefined ? undefined : cacheKeyOf(spec, config)
        if (cache !== undefined && cacheKey !== undefined) {
          const hit = await cache.get(cacheKey)
          if (hit !== undefined) {
            return { taskId: 'cache:' + cacheKey.slice(0, 12), model: spec.model, images: hit, elapsedMs: 0, cached: true }
          }
        }

        // 配额在**校验与凭据都通过之后**才扣：一次 prompt 写错、或 key 没配的调用
        // 不会花掉用户的 maxCallsPerTurn 名额（那些调用根本没发出去、也没计费）。
        const grant = budget.take(sessionId)
        if (!grant.ok) throw new MediaError(CODES.RATE_LIMIT, budgetMessage(grant))

        const adapter = manager.get(ADAPTER_ID)
        const mode = typeof adapter.modeFor === 'function' ? adapter.modeFor(config) : 'async'
        const { taskRef, state } = await manager.run({
          adapterId: ADAPTER_ID,
          spec,
          credential: credential.value,
          signal: exec.signal,
          timeoutMs: config.taskTimeoutMs,
          // 同步模式没有轮询，POST 本身就要等出图；异步模式提交只是拿 task_id。
          submitTimeoutMs: mode === 'sync' ? config.taskTimeoutMs : config.httpTimeoutMs,
          // 提交成功就登记：之后即便整轮请求失败，也能用 media_task(action=list) 找回来。
          onSubmitted: async (ref) => {
            const registry = await getTaskRegistry()
            await registry?.record({
              provider: 'qwen',
              taskId: ref.taskId,
              model: spec.model,
              prompt: spec.prompt,
              n: spec.n,
              mode: ref.mode,
              status: 'submitted',
            })
          },
        })
        if (state.status === STATES.TIMEOUT) {
          throw new MediaError(CODES.TIMEOUT, fixedMessage(CODES.TIMEOUT, { provider: 'DashScope', providerKey: 'qwen', taskId: taskRef.taskId, timeoutMs: config.taskTimeoutMs }))
        }
        if (state.status === STATES.ABORTED) {
          throw new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, { providerKey: 'qwen', taskId: taskRef.taskId }))
        }
        if (state.status === STATES.FAILED) {
          throw stateFailureToError(state, { adapter: manager.get(ADAPTER_ID), providerLabel: 'DashScope', ref: KEY.ref })
        }
        const outDir = resolveOutDir({
          configValue: typeof args.out_dir === 'string' && args.out_dir.trim().length > 0 ? args.out_dir : config.outDir,
          exec,
        })
        const files = await manager.fetchArtifacts(state, {
          outDir,
          signal: exec.signal,
          nameHint: 'qwen-' + slugify(prompt) + '-' + stamp() + '-' + shortHash(prompt),
        })
        if (files.length === 0) {
          // 任务标记成功但没有产物字段：绝不伪装成"已完成但没内容"（规划 [6.3]）。
          throw new MediaError(
            CODES.UNKNOWN,
            fixedMessage(CODES.UNKNOWN, { provider: 'DashScope', detail: '任务 ' + taskRef.taskId + ' 标记成功，但响应里没有图片地址（产物字段待实跑确证）' }),
          )
        }
        const images = []
        for (const file of files) {
          const bytes = await readFile(file.path)
          const ref = await attachImage(ctx, { bytes, mediaType: file.mediaType, name: basename(file.path) })
          const size = imageSize(bytes)
          const width = ref?.width ?? size?.width
          const height = ref?.height ?? size?.height
          images.push({
            path: file.path,
            bytes: file.bytes,
            mediaType: file.mediaType,
            ...(ref?.attachmentId === undefined ? {} : { attachmentId: ref.attachmentId }),
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          })
        }
        const cost = adapter.estimateCost(spec, pricingOf(config))
        // 同步响应带 usage.output_image_count 时以真实返回张数记账，否则按请求 n。
        const units = Number.isFinite(state.usage?.imageCount) ? state.usage.imageCount : spec.n
        // 金额由"张数 × 单价"重算（真实张数可能少于请求的 n）。
        // 未计价（unitPrice === null）时金额保持 null —— 不能写成 0，那会被读成"免费"。
        const amount = cost.unitPrice === null ? null : Number((units * cost.unitPrice).toFixed(6))
        const ledger = await getLedger()
        await ledger.record({
          adapter: ADAPTER_ID,
          provider: 'DashScope',
          model: spec.model,
          unitKind: 'image',
          units,
          unitPrice: cost.unitPrice,
          currency: cost.currency,
          amount,
          taskId: taskRef.taskId,
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        await ledger.noteHealth(ADAPTER_ID, true, 'task ' + taskRef.taskId)
        // 存缓存：下次同样 prompt + 参数直接复用，不再计费。
        if (cache !== undefined && cacheKey !== undefined) {
          await cache.put(cacheKey, images, { model: spec.model, prompt: spec.prompt })
        }
        return { taskId: taskRef.taskId, model: spec.model, images, elapsedMs: state.elapsedMs ?? 0 }
      } catch (error) {
        const mediaError = asMediaError(error, { provider: 'DashScope', ref: KEY.ref, where: 'query' })
        if (mediaError.code !== CODES.MISSING_CREDENTIAL) {
          try {
            const ledger = await getLedger()
            await ledger.noteHealth(ADAPTER_ID, false, mediaError.code + (mediaError.taskId === undefined ? '' : ' task=' + mediaError.taskId))
          } catch {
            // 健康记录失败不影响主流程
          }
        }
        throw mediaError
      }
    },
    presentCall(args) {
      return { card: 'generic', title: '生成图片：' + args.prompt, kind: 'generate' }
    },
  })
}
