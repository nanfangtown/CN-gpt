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
import { pricingOf, unitPriceOf } from '../core/cost.mjs'
import { authorizeSpend, estimateSpend } from '../core/spend-guard.mjs'
import { cacheKeyOf } from '../core/cache.mjs'
import { resolveImageArg, sizeForEdit } from '../core/image-input.mjs'
import { accountUnretrievedSpend, asMediaError, budgetMessage, sessionIdOf, sessionSpentOrThrow, stateFailureToError } from '../core/tool-kit.mjs'

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
  const { ctx, config, manager, keys, getLedger, getTaskRegistry, getImageCache, budget, logger } = deps

  return defineTool({
    name: 'qwen_draw',
    description: '文生图/图生图（Qwen）：给 image 即编辑该图。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述，越具体越好' },
      image: { type: 'string', description: '输入图 URL/路径' },
      negative: { type: 'string', description: '负向提示词' },
      size: { type: 'string', description: '如 1024*1024；留空用模型默认' },
      n: { type: 'integer', description: '张数，默认 1，最大 4' },
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
      /** 闸门算出的预估——catch 里"提交了但没取回"时复用同一组数字补记。 */
      let plannedEstimate
      /** 已提交任务的 id（提交一旦发生就记下来，超时/取消的补记靠它）。 */
      let plannedTaskId
      try {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt.length === 0) throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：prompt 不能为空；请提供画面描述后重试')
        const n = Math.min(Math.max(Number.isFinite(args.n) ? Math.trunc(args.n) : 1, 1), 4)
        const spec = { model: config.qwenModel, prompt, n }
        if (typeof args.negative === 'string' && args.negative.trim().length > 0) spec.negativePrompt = args.negative.trim()
        const size = normalizeSize(args.size)
        if (size !== undefined) spec.size = size

        // 图生图（I2I，2026-10-17 加）：给了 image 就把原图放进请求，模型以它为条件编辑。
        // 本地路径的安全约束与 seedance 的"首帧图"完全一致（工作目录内 + 内容签名验证）。
        if (typeof args.image === 'string' && args.image.trim().length > 0) {
          spec.images = [await resolveImageArg(args.image, { exec, maxBytes: config.maxInlineImageBytes, label: '输入图' })]
          // 图生图的输出尺寸：用户给了 size 就用用户的；没给就**沿用原图尺寸**
          // （按面积夹进 512×512 ~ 2048×2048）。不这么做，模型会自选推荐分辨率 ——
          // 实测 256×256 的输入被输出成 2048×2048，又慢又贵，还把图放大了 8 倍。
          if (size === undefined) {
            const editSize = sizeForEdit(spec.images[0]?.width, spec.images[0]?.height)
            if (editSize !== undefined) spec.size = editSize
          }
        }

        const adapter = manager.get(ADAPTER_ID)
        const mode = typeof adapter.modeFor === 'function' ? adapter.modeFor(config) : 'async'
        // 异步端点（text2image/image-synthesis）不接受输入图。在这里就拦下：
        // 既不浪费一次凭据读取，也不让调用方以为"图生图成功了"却拿到一张无关的新图。
        if (spec.images !== undefined && mode !== 'sync') {
          throw new MediaError(
            CODES.BAD_REQUEST,
            '参数不被接受：图生图需要**同步模式**（qwen-image 系列），当前模型 ' +
              spec.model +
              ' 走异步 text2image、不接受输入图。请在 插件页 → gpt-CN → 配置卡 把 qwenModel 设为 qwen-image-3.0（或其它 qwen-image 系列）后重试。',
          )
        }

        const credential = await keys.resolve(KEY)
        // 只有"确实拿到非空字符串凭据"才算过：`null` 或 `{ value: undefined }` 都必须落回缺凭据，
        // 否则后面 `credential.value` 会炸成语义不明的错误（2026-10-16 加固）。
        if (credential === undefined || credential === null || typeof credential.value !== 'string' || credential.value.length === 0) {
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

        // ⛔ 付费收口（2026-10-16 补）：制图与出片一样，提交前必须过金额闸门 + 显式确认。
        //
        // 这里以前是一段空白：制图只受"次数预算"（budget.take）约束，没有任何金额层面的拦截。
        // 后果有两个，2026-10-16 实测确认：
        //   ① 未计价 / 单价写成 0 的制图模型**照常提交并扣费**（出片那条路是 fail-closed）；
        //   ② 调用方不传任何确认参数就能直接出图 —— "无意识花钱"在制图这条路上没有任何阻力。
        // 现在复用出片那套三层语义（单次上限 / 会话累计 / 复述金额），
        // 上限沿用同一对配置项（videoCostLimitCNY / videoSessionCostLimitCNY），不新增配置。
        plannedEstimate = estimateSpend({
          model: spec.model,
          duration: spec.n,
          unitPrice: unitPriceOf(pricingOf(config)[spec.model] ?? {}),
        })
        const verdict = await authorizeSpend({
          estimate: plannedEstimate,
          config,
          noun: '出图',
          unitLabel: '张',
          providerLabel: 'DashScope',
          // 会话累计：把"自己 + 后代子代理会话"一起算（2026-10-16）。
          // 子代理默认**允许**出图（效率优先），代价是它的花费记在自己会话上 ——
          // 只按 sessionId 汇总就等于"把花费挪进子会话即可绕过累计上限"。
          spentInSession: () =>
            sessionSpentOrThrow({
              getLedger,
              sessionId,
              sessionIds: deps.sessionIdsForSpend?.(sessionId),
              providerLabel: 'DashScope',
            }),
          confirmed: { confirm_estimate: args.confirm_estimate, confirm_unpriced: args.confirm_unpriced },
        })
        if (!verdict.ok) throw new MediaError(CODES.BAD_REQUEST, verdict.message)

        // 配额在**校验、凭据与金额闸门都通过之后**才扣：一次 prompt 写错、key 没配、
        // 或"只报价还没确认"的调用，都不该花掉用户的 maxCallsPerTurn 名额。
        // ⚠ 顺序要求：闸门必须在 budget.take **之前**。确认流程天然是两次调用（先报价、再确认），
        // 若报价也吃配额，maxCallsPerTurn=6 就只剩 3 张图 —— 那是我修闸门时差点引入的功能退化。
        const grant = budget.take(sessionId)
        if (!grant.ok) throw new MediaError(CODES.RATE_LIMIT, budgetMessage(grant))

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
        // 走到这里说明提交已经发生（taskRef 一定存在）——先把 id 记下来，
        // 后面无论超时还是取消，补记那笔钱时都要用它。
        plannedTaskId = taskRef.taskId
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
          // 超时/中断：任务**已经提交**、远端可能已计费，而成功路径的记账在产物落盘之后 ——
          // 不补这一笔，"反复提交完就放弃"就永远不会体现在会话累计上限与报表里
          // （2026-10-15 的事故正是这个形态）。同一个 taskId 只记一次。
          if ((mediaError.code === CODES.TIMEOUT || mediaError.code === CODES.ABORTED) && typeof plannedTaskId === 'string' && plannedEstimate !== undefined) {
            await accountUnretrievedSpend({
              getLedger,
              taskId: plannedTaskId,
              logger,
              entry: {
                adapter: ADAPTER_ID,
                provider: 'DashScope',
                model: config.qwenModel,
                unitKind: 'image',
                units: plannedEstimate.duration,
                unitPrice: plannedEstimate.unitPrice,
                currency: 'CNY',
                amount: plannedEstimate.estimated,
                ...(sessionId === undefined ? {} : { sessionId }),
              },
            })
          }
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
