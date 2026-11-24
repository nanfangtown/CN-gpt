/**
 * minimax_draw —— MiniMax H3-Image 文生图 / 图片编辑（同步）。
 *
 * 与 qwen_draw 是同一层语义（提交 → 落盘 → 记账），差异在协议与计价：
 *   - H3 是**同步**接口：POST 一次就等结果，没有task_id 轮询；所以超时按官方建议给 600 s，
 *     而不是通用的 60 s（它不支持幂等：客户端放弃 ≠ 服务端不生成、不计费）。
 *   - 计价按**张**，档位 = 模式（文生 / 编辑）× 面积（1K/2K/4K）。
 *   - **部分失败仍是 200**：成功张数取 usage.generated_images，记账按它，不按请求的 n。
 *
 * 付费纪律与其它生成工具完全一致：先报价 → 单次/会话上限 → 未计价 fail-closed → 复述金额。
 * 出图缓存同样生效：同 prompt + 同参数 + 同参考图不重复计费。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError, STATES, fixedMessage } from '../core/errors.mjs'
import {
  attachImage,
  imageContentBlock,
  imageSize,
  resolveOutDir,
  shouldAttachImage,
  shortHash,
  slugify,
  stamp,
} from '../core/deliver.mjs'
import { keySpec } from '../core/keys.mjs'
import { pricingOf } from '../core/cost.mjs'
import { authorizeSpend, estimateSpend } from '../core/spend-guard.mjs'
import { cacheKeyOf } from '../core/cache.mjs'
import { resolveImageArgs } from '../core/image-input.mjs'
import { accountUnretrievedSpend, asMediaError, budgetMessage, sessionIdOf, sessionSpentOrThrow } from '../core/tool-kit.mjs'
import { MINIMAX_IMAGE_MAX_IMAGES, validateMinimaxImageSpec } from '../tasks/adapters/minimax-image.mjs'

const KEY = keySpec('minimax')
const ADAPTER_ID = 'minimax-image'
const PROVIDER_LABEL = 'MiniMax（H3-Image）'
const PROVIDER_KEY = 'minimax-image'
const MAX_IMAGES = MINIMAX_IMAGE_MAX_IMAGES

/**
 * 注册 minimax_draw。
 * @param {object} deps - ctx / config / manager / keys / getLedger / getTaskRegistry / getImageCache / budget。
 */
export function createMinimaxDrawTool(deps) {
  const { ctx, config, manager, keys, getLedger, getTaskRegistry, getImageCache, budget, logger } = deps

  return defineTool({
    name: 'minimax_draw',
    description:
      '文生图/图生图（MiniMax H3-Image）：给 image/images 即按参考图编辑。返回本地路径；'
      + '按张计费，大额需先报价、再带 confirm_estimate 重调。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述；改图时写要变成什么样' },
      image: { type: 'string', description: '单张参考图（images 简写）' },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图数组（URL/路径，≤' + MAX_IMAGES + ' 张）；给出即图生图',
      },
      n: { type: 'integer', description: '张数 1–10，默认 1' },
      area: { type: 'string', enum: ['1K', '2K', '4K'], description: '面积档位，默认 1K' },
      size: { type: 'string', description: '宽x高，与 area 互斥' },
      format: { type: 'string', enum: ['jpeg', 'png', 'webp'], description: '输出格式，默认 jpeg' },
      out_dir: { type: 'string', description: '产物目录，默认 gen' },
      confirm_estimate: { type: 'number', description: '复述预估金额才提交' },
      confirm_unpriced: { type: 'boolean', description: '未计价需 true' },
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
          failedCount: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const header =
          value.cached === true
            ? '出图缓存命中，复用已有 ' + value.images.length + ' 张图片（模型 ' + value.model + '，未产生新调用、未计费）：'
            : '已生成 ' + value.images.length + ' 张图片（模型 ' + value.model + '，request_id ' + value.taskId + '，耗时 ' + Math.round(value.elapsedMs / 1000) + 's）：'
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
        // 部分失败是 HTTP 200：不说清楚，模型会以为 n 张全拿到了。
        if ((value.failedCount ?? 0) > 0) {
          blocks.push({
            type: 'text',
            text:
              '⚠ 本次有 ' + value.failedCount + ' 张未生成（内容安全或生成失败），只对成功的 ' +
              value.images.length + ' 张计费。需要那几张就调整提示词后重试，或减少张数。',
          })
        }
        if (config?.attachResultImages !== true) {
          blocks.push({
            type: 'text',
            text: '（图片已保存在上面的路径；按当前设置未把图片内容附回上下文。需要模型自己看图时，在 插件页 → CN-gpt → 配置卡 打开 attachResultImages。）',
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
      /** 闸门算出的预估——提交后失败时补记复用同一组数字。 */
      let plannedEstimate
      /** 提交一旦发生就记下 request_id（同步接口用它当 taskId）。 */
      let plannedTaskId
      let plannedCost
      let plannedSpec
      let succeeded = false
      try {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt.length === 0) throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：prompt 不能为空；请提供画面描述后重试')

        // 参考图：`images` 数组与 `image` 单张都接受；合成一个列表后统一走安全解析
        // （本地路径必须在会话工作目录内 + 内容签名必须是图片，见 core/image-input.mjs）。
        const refs = []
        for (const item of Array.isArray(args.images) ? args.images : []) refs.push(item)
        if (typeof args.image === 'string' && args.image.trim().length > 0) refs.push(args.image)
        if (refs.length > MAX_IMAGES) {
          throw new MediaError(
            CODES.BAD_REQUEST,
            `参数不被接受：参考图最多 ${MAX_IMAGES} 张（本次 ${refs.length} 张）。**本次未提交、未产生任何费用。**`,
          )
        }
        const images = refs.length === 0
          ? []
          : await resolveImageArgs(refs, { exec, maxBytes: config.maxInlineImageBytes, label: '参考图', max: MAX_IMAGES })

        const rawSize = typeof args.size === 'string' && args.size.trim().length > 0 ? args.size.trim() : undefined
        const rawArea = typeof args.area === 'string' && args.area.trim().length > 0 ? args.area.trim() : undefined
        const spec = {
          model: config.minimaxImageModel,
          prompt,
          n: args.n,
          // 尺寸二选一：给了 size 就绝不再带 area（官方同时传直接 400）；
          // 都不给才回落到配置里的默认档位（1K）—— 服务端默认是 4K，那是"不填就按最贵档下单"。
          ...(rawSize === undefined
            ? { area: rawArea ?? config.minimaxImageArea ?? '1K' }
            : { size: rawSize }),
          ...(typeof args.format === 'string' && args.format.trim().length > 0 ? { format: args.format.trim() } : {}),
          images,
        }
        // 先做与厂商无关的规格校验：参数错不能等到"未计价"那一步才报。
        const normalized = validateMinimaxImageSpec(spec)

        const credential = await keys.resolve(KEY)
        if (credential === undefined || credential === null || typeof credential.value !== 'string' || credential.value.length === 0) {
          throw new MediaError(CODES.MISSING_CREDENTIAL, fixedMessage(CODES.MISSING_CREDENTIAL, { ref: KEY.ref }))
        }

        // 出图缓存：命中就复用已有产物（不扣配额、不再计费）。放在凭据检查之后：
        // 没配 key 的调用本就不该命中并拿到产物。
        const cache = await getImageCache()
        const cacheKey = cache === undefined ? undefined : cacheKeyOf({ ...normalized, images: normalized.images }, config)
        if (cache !== undefined && cacheKey !== undefined) {
          const hit = await cache.get(cacheKey)
          if (hit !== undefined) {
            return { taskId: 'cache:' + cacheKey.slice(0, 12), model: normalized.model, images: hit, elapsedMs: 0, cached: true }
          }
        }

        // ⛔ 付费收口：按"张 × 档位价"报价，再走上限 / 未计价 / 复述金额三道闸。
        const adapter = manager.get(ADAPTER_ID)
        const cost = adapter.estimateCost(normalized, pricingOf(config))
        plannedCost = cost
        plannedSpec = normalized
        plannedEstimate = estimateSpend({ model: normalized.model, duration: cost.units, unitPrice: cost.unitPrice })
        const verdict = await authorizeSpend({
          estimate: plannedEstimate,
          config,
          noun: '出图',
          unitLabel: '张',
          providerLabel: PROVIDER_LABEL,
          spentInSession: () =>
            sessionSpentOrThrow({
              getLedger,
              sessionId,
              sessionIds: deps.sessionIdsForSpend?.(sessionId),
              providerLabel: PROVIDER_LABEL,
            }),
          confirmed: { confirm_estimate: args.confirm_estimate, confirm_unpriced: args.confirm_unpriced },
        })
        if (!verdict.ok) throw new MediaError(CODES.BAD_REQUEST, verdict.message)

        // 配额在闸门之后才扣：一次"只报价还没确认"的调用不该吃掉 maxCallsPerTurn 名额。
        const grant = budget.take(sessionId)
        if (!grant.ok) throw new MediaError(CODES.RATE_LIMIT, budgetMessage(grant))

        const { taskRef, state } = await manager.run({
          adapterId: ADAPTER_ID,
          spec: normalized,
          credential: credential.value,
          signal: exec.signal,
          timeoutMs: config.minimaxImageTimeoutMs ?? 600000,
          // 同步接口：POST 本身要等出图，且官方建议客户端超时 ≥ 600 s
          // （不支持幂等：本地放弃不等于服务端不计费，早失败在这里只会白花钱）。
          submitTimeoutMs: config.minimaxImageTimeoutMs ?? 600000,
          onSubmitted: async (ref) => {
            const registry = await getTaskRegistry()
            await registry?.record({
              provider: PROVIDER_KEY,
              taskId: ref.taskId,
              model: normalized.model,
              prompt: normalized.prompt,
              n: normalized.n,
              area: normalized.area,
              mode: normalized.mode,
              status: 'submitted',
            })
          },
        })
        plannedTaskId = taskRef.taskId
        if (state.status === STATES.TIMEOUT) {
          throw new MediaError(
            CODES.TIMEOUT,
            fixedMessage(CODES.TIMEOUT, { provider: PROVIDER_LABEL, providerKey: PROVIDER_KEY, taskId: taskRef.taskId, timeoutMs: config.minimaxImageTimeoutMs ?? 600000 }),
          )
        }
        if (state.status === STATES.ABORTED) {
          throw new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, { providerKey: PROVIDER_KEY, taskId: taskRef.taskId }))
        }
        if (state.status === STATES.FAILED) {
          // 同步接口的失败在 state.error 里（全部图片失败时官方返回 402/422/500）。
          // 这里按内容安全 / 其它两类给文案：内容安全改尺寸无效，必须说"改提示词"。
          const detail = state.error?.detail ?? '全部图片未生成'
          const policy = state.error?.code === CODES.POLICY_REJECTED
          throw new MediaError(
            policy ? CODES.POLICY_REJECTED : CODES.UNKNOWN,
            policy
              ? '内容被平台策略拒绝：' + detail + '。请调整提示词后重试（本插件不会自动重试）。'
              : '生成失败：' + detail + '。本次未按成功计费；可调整参数后重试。',
            { detail },
          )
        }
        // 走到这里 = 至少一张成功、远端已计费。后面任何失败都要能补记账。
        succeeded = true
        const outDir = resolveOutDir({
          configValue: typeof args.out_dir === 'string' && args.out_dir.trim().length > 0 ? args.out_dir : config.outDir,
          exec,
        })
        const files = await manager.fetchArtifacts(state, {
          outDir,
          signal: exec.signal,
          nameHint: 'minimax-h3-' + slugify(normalized.prompt) + '-' + stamp() + '-' + shortHash(normalized.prompt),
          credential: credential.value,
        })
        if (files.length === 0) {
          throw new MediaError(
            CODES.UNKNOWN,
            fixedMessage(CODES.UNKNOWN, {
              provider: PROVIDER_LABEL,
              detail: '响应标记成功，但取不到图片文件（检查 data[].url 与下载通道）',
            }),
          )
        }
        const outImages = []
        for (const file of files) {
          const bytes = await readFile(file.path)
          const ref = await attachImage(ctx, { bytes, mediaType: file.mediaType, name: basename(file.path) })
          const size = imageSize(bytes)
          const width = ref?.width ?? size?.width
          const height = ref?.height ?? size?.height
          outImages.push({
            path: file.path,
            bytes: file.bytes,
            mediaType: file.mediaType,
            ...(ref?.attachmentId === undefined ? {} : { attachmentId: ref.attachmentId }),
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          })
        }
        // 计费张数取 usage.generated_images（只对成功的收费）；取不到才退回落盘张数。
        const units = Number.isFinite(state.usage?.imageCount) ? state.usage.imageCount : outImages.length
        const amount = cost.unitPrice === null ? null : Number((units * cost.unitPrice).toFixed(6))
        const ledger = await getLedger()
        await ledger.record({
          adapter: ADAPTER_ID,
          provider: PROVIDER_LABEL,
          model: normalized.model,
          unitKind: 'image',
          units,
          unitPrice: cost.unitPrice,
          currency: cost.currency,
          amount,
          taskId: taskRef.taskId,
          mode: normalized.mode,
          area: normalized.area,
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        await ledger.noteHealth(ADAPTER_ID, true, 'request ' + taskRef.taskId)
        if (cache !== undefined && cacheKey !== undefined) {
          await cache.put(cacheKey, outImages, { model: normalized.model, prompt: normalized.prompt })
        }
        return {
          taskId: taskRef.taskId,
          model: normalized.model,
          images: outImages,
          elapsedMs: state.elapsedMs ?? 0,
          ...(Array.isArray(state.partialFailures) && state.partialFailures.length > 0
            ? { failedCount: state.partialFailures.length }
            : {}),
        }
      } catch (error) {
        const mediaError = asMediaError(error, { provider: PROVIDER_LABEL, ref: KEY.ref, where: 'submit' })
        if (mediaError.code !== CODES.MISSING_CREDENTIAL) {
          // 超时/中断/已成功后失败：远端可能已经计费，而成功路径的记账在落盘之后 ——
          // 不补这一笔，"提交完就放弃"永远不会体现在会话累计上限与报表里（2026-10-15 的形态）。
          const shouldAccount =
            (mediaError.code === CODES.TIMEOUT || mediaError.code === CODES.ABORTED || succeeded === true) &&
            typeof plannedTaskId === 'string' &&
            plannedCost !== undefined &&
            plannedEstimate !== undefined &&
            plannedEstimate.unitPrice !== null
          if (shouldAccount) {
            await accountUnretrievedSpend({
              getLedger,
              taskId: plannedTaskId,
              logger,
              entry: {
                adapter: ADAPTER_ID,
                provider: PROVIDER_LABEL,
                model: plannedSpec?.model,
                unitKind: 'image',
                units: plannedEstimate.duration,
                unitPrice: plannedEstimate.unitPrice,
                currency: 'CNY',
                amount: plannedEstimate.estimated,
                mode: plannedSpec?.mode,
                area: plannedSpec?.area,
                ...(sessionId === undefined ? {} : { sessionId }),
              },
            })
          }
          try {
            const ledger = await getLedger()
            await ledger.noteHealth(ADAPTER_ID, false, mediaError.code + (mediaError.taskId === undefined ? '' : ' request=' + mediaError.taskId))
          } catch {
            // 健康记录失败不影响错误上抛。
          }
        }
        throw mediaError
      }
    },
    presentCall(args) {
      const title = args.prompt ?? (Array.isArray(args.images) ? args.images[0] : args.image)
      return { card: 'generic', title: '生成图片（MiniMax H3）：' + String(title ?? ''), kind: 'generate' }
    },
  })
}
