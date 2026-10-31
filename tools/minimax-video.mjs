/**
 * minimax_video —— MiniMax（海螺）异步文生 / 图生 / 首尾帧视频。
 *
 * 与 seedance_video / video_gen 同构：提交 → task_id → 轮询 → 取文件 → 下载 → 记账。
 * 不合并的理由与那两条一样：鉴权、端点、参数面（按条计费 vs 按秒）都不同；
 * 真正共享的是 tasks/manager.mjs 与 core/spend-guard.mjs。
 *
 * 计费：Hailuo 系列按**条**（分辨率 × 时长），所以报价单位是“条”而不是“秒”。
 * 付费纪律与另外两条完全一致：先报价、再确认、超限拒绝、未计价 fail-closed。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError, STATES, fixedMessage } from '../core/errors.mjs'
import { resolveOutDir, shortHash, slugify, stamp } from '../core/deliver.mjs'
import { resolveImageArg } from '../core/image-input.mjs'
import { keySpec } from '../core/keys.mjs'
import { pricingOf } from '../core/cost.mjs'
import { authorizeSpend, estimateSpend } from '../core/spend-guard.mjs'
import {
  accountUnretrievedSpend,
  asMediaError,
  budgetMessage,
  sessionIdOf,
  sessionSpentOrThrow,
  stateFailureToError,
} from '../core/tool-kit.mjs'
import { validateMinimaxSpec } from '../tasks/adapters/minimax-video.mjs'

const KEY = keySpec('minimax')
const ADAPTER_ID = 'minimax-video'
const PROVIDER_LABEL = 'MiniMax（海螺）'
const PROVIDER_KEY = 'minimax'

/**
 * 注册 minimax_video。
 * @param {object} deps - ctx / config / manager / keys / getLedger / getTaskRegistry / budget。
 */
export function createMinimaxVideoTool(deps) {
  const { config, manager, keys, getLedger, getTaskRegistry, budget, logger } = deps

  return defineTool({
    name: 'minimax_video',
    description: '文生/图生/首尾帧视频（MiniMax 海螺），返回本地路径；超时保留 task_id。按条计费：先报价，带 confirm_estimate 再调一次才提交。',
    parameters: {
      prompt: { type: 'string', description: '视频描述；文生视频必填，图生视频可省（≤2000 字符）' },
      image: { type: 'string', description: '首帧图 http(s) URL 或本地路径；给出即图生视频' },
      last_image: { type: 'string', description: '尾帧图（仅 Hailuo-02）；与 image 同时给出即首尾帧' },
      duration: { type: 'integer', enum: [6, 10], description: '秒：6 或 10（1080P 只支持 6）' },
      resolution: { type: 'string', enum: ['512P', '768P', '1080P'], description: '画质；512P 仅图生视频，1080P 仅 6 秒' },
      out_dir: { type: 'string', description: '产物目录，默认 gen/video' },
      confirm_estimate: { type: 'number', description: '费用确认：填上次报价（元）' },
      confirm_unpriced: { type: 'boolean', description: '未计价放行确认' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          model: { type: 'string', required: true },
          videos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                mediaType: { type: 'string', required: true },
              },
            },
          },
          spec: {
            type: 'object',
            additionalProperties: false,
            properties: {
              duration: { type: 'integer' },
              resolution: { type: 'string' },
              image: { type: 'string' },
              lastImage: { type: 'string' },
            },
          },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const lines = ['已生成视频（模型 ' + value.model + '，task_id ' + value.taskId + '，耗时 ' + Math.round(value.elapsedMs / 1000) + 's）：']
        for (const video of value.videos) {
          lines.push('- ' + video.path + '（' + video.mediaType + '，' + video.bytes + ' bytes）')
        }
        const bits = [
          value.spec.duration === undefined ? undefined : value.spec.duration + 's',
          value.spec.resolution,
        ].filter(Boolean)
        if (bits.length > 0) lines.push('参数：' + bits.join(' / '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({ taskId: value.taskId, model: value.model, paths: value.videos.map((video) => video.path) }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      /** 闸门算出的预估——catch 里“提交了但没取回”时复用同一组数字补记。 */
      let plannedEstimate
      /** 已提交任务的 id（提交一旦发生就记下来，超时/取消的补记靠它）。 */
      let plannedTaskId
      /** 本次真实规格与报价（失败补记用）。 */
      let plannedSpec
      let plannedCost
      /** 远端是否已确认成功出片（成功之后才失败，同样要补记）。 */
      let succeeded = false
      try {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        const spec = { model: config.minimaxModel, prompt }
        if (typeof args.image === 'string' && args.image.trim().length > 0) {
          spec.image = await resolveImageArg(args.image, { exec, maxBytes: config.maxInlineImageBytes, label: '首帧图' })
        }
        if (typeof args.last_image === 'string' && args.last_image.trim().length > 0) {
          spec.lastImage = await resolveImageArg(args.last_image, { exec, maxBytes: config.maxInlineImageBytes, label: '尾帧图' })
        }
        if (args.duration !== undefined) spec.duration = Number(args.duration)
        if (typeof args.resolution === 'string' && args.resolution.trim().length > 0) spec.resolution = args.resolution.trim()

        // 先做与厂商无关的规格校验：参数错不能等到“未计价”那一步才报，
        // 否则用户看到的是“去补单价”，而真正的问题是时长/分辨率不支持。
        validateMinimaxSpec(spec)

        const credential = await keys.resolve(KEY)
        if (credential === undefined || credential === null || typeof credential.value !== 'string' || credential.value.length === 0) {
          throw new MediaError(CODES.MISSING_CREDENTIAL, fixedMessage(CODES.MISSING_CREDENTIAL, { ref: KEY.ref }))
        }
        // 配额只在真正要提交时扣：参数错 / 缺 key 不占名额。
        const grant = budget.take(sessionId)
        if (!grant.ok) throw new MediaError(CODES.RATE_LIMIT, budgetMessage(grant))

        // ⛔ 付费收口：按“条”报价（分辨率 × 时长），再走确认 / 上限 / 未计价三道闸。
        const adapter = manager.get(ADAPTER_ID)
        const cost = adapter.estimateCost(spec, pricingOf(config))
        const estimate = estimateSpend({ model: spec.model, duration: cost.units, unitPrice: cost.unitPrice })
        plannedEstimate = estimate
        plannedCost = cost
        plannedSpec = spec
        const verdict = await authorizeSpend({
          estimate,
          config,
          spentInSession: () =>
            sessionSpentOrThrow({
              getLedger,
              sessionId,
              sessionIds: deps.sessionIdsForSpend?.(sessionId),
              providerLabel: PROVIDER_LABEL,
            }),
          confirmed: { confirm_estimate: args.confirm_estimate, confirm_unpriced: args.confirm_unpriced },
          providerLabel: PROVIDER_LABEL,
          unitLabel: cost.unitKind === 'call' ? '条' : '秒',
        })
        if (!verdict.ok) throw new MediaError(CODES.BAD_REQUEST, verdict.message)

        const { taskRef, state } = await manager.run({
          adapterId: ADAPTER_ID,
          spec,
          credential: credential.value,
          signal: exec.signal,
          timeoutMs: config.videoTimeoutMs,
          onSubmitted: async (ref) => {
            const registry = await getTaskRegistry()
            await registry?.record({
              provider: PROVIDER_KEY,
              taskId: ref.taskId,
              model: spec.model,
              prompt: spec.prompt,
              duration: spec.duration,
              status: 'submitted',
            })
          },
        })
        plannedTaskId = taskRef.taskId
        if (state.status === STATES.TIMEOUT) {
          throw new MediaError(
            CODES.TIMEOUT,
            fixedMessage(CODES.TIMEOUT, { provider: PROVIDER_LABEL, providerKey: PROVIDER_KEY, taskId: taskRef.taskId, timeoutMs: config.videoTimeoutMs }),
          )
        }
        if (state.status === STATES.ABORTED) {
          throw new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, { providerKey: PROVIDER_KEY, taskId: taskRef.taskId }))
        }
        if (state.status === STATES.FAILED) {
          throw stateFailureToError(state, { adapter, providerLabel: PROVIDER_LABEL, ref: KEY.ref })
        }
        // 走到这里 = 远端已经成功出片并计费。之后任何失败（取文件/下载/记账）
        // 都不能让这笔钱在账本上消失，所以先把标记立起来。
        succeeded = true
        const outDir = resolveOutDir({
          configValue: typeof args.out_dir === 'string' && args.out_dir.trim().length > 0 ? args.out_dir : config.videoOutDir,
          exec,
        })
        const files = await manager.fetchArtifacts(state, {
          outDir,
          signal: exec.signal,
          nameHint: 'minimax-' + slugify(prompt || 'video') + '-' + stamp() + '-' + shortHash(prompt || String(taskRef.taskId)),
          credential: credential.value,
        })
        if (files.length === 0) {
          throw new MediaError(
            CODES.UNKNOWN,
            fixedMessage(CODES.UNKNOWN, { provider: PROVIDER_LABEL, detail: '任务 ' + taskRef.taskId + ' 标记成功，但取不到视频文件（检查 file_id / file.download_url）' }),
          )
        }
        const ledger = await getLedger()
        await ledger.record({
          adapter: ADAPTER_ID,
          provider: PROVIDER_LABEL,
          model: spec.model,
          unitKind: cost.unitKind,
          units: cost.units,
          unitPrice: cost.unitPrice,
          currency: cost.currency,
          amount: cost.amount,
          taskId: taskRef.taskId,
          ...(spec.resolution === undefined ? {} : { resolution: spec.resolution }),
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        await ledger.noteHealth(ADAPTER_ID, true, 'task ' + taskRef.taskId)
        const specOut = { ...spec }
        delete specOut.model
        delete specOut.prompt
        if (spec.image !== undefined) specOut.image = spec.image.url ?? spec.image.display
        if (spec.lastImage !== undefined) specOut.lastImage = spec.lastImage.url ?? spec.lastImage.display
        return {
          taskId: taskRef.taskId,
          model: spec.model,
          videos: files.map((file) => ({ path: file.path, bytes: file.bytes, mediaType: file.mediaType })),
          spec: specOut,
          elapsedMs: state.elapsedMs ?? 0,
        }
      } catch (error) {
        const mediaError = asMediaError(error, { provider: PROVIDER_LABEL, ref: KEY.ref, where: 'query' })
        if (mediaError.code !== CODES.MISSING_CREDENTIAL) {
          const shouldAccount =
            (mediaError.code === CODES.TIMEOUT || mediaError.code === CODES.ABORTED || succeeded === true) &&
            typeof plannedTaskId === 'string' &&
            plannedCost !== undefined &&
            plannedSpec !== undefined &&
            plannedCost.unitPrice !== null
          if (shouldAccount) {
            await accountUnretrievedSpend({
              getLedger,
              taskId: plannedTaskId,
              logger,
              entry: {
                adapter: ADAPTER_ID,
                provider: PROVIDER_LABEL,
                model: plannedSpec.model,
                unitKind: plannedCost.unitKind,
                units: plannedCost.units,
                unitPrice: plannedCost.unitPrice,
                currency: plannedCost.currency ?? 'CNY',
                amount: plannedCost.amount,
                ...(plannedSpec.resolution === undefined ? {} : { resolution: plannedSpec.resolution }),
                ...(sessionId === undefined ? {} : { sessionId }),
              },
            })
          }
          try {
            const ledger = await getLedger()
            await ledger.noteHealth(ADAPTER_ID, false, mediaError.code + (mediaError.taskId === undefined ? '' : ' task=' + mediaError.taskId))
          } catch {
            // 忽略：健康记录失败不影响错误上抛。
          }
        }
        throw mediaError
      }
    },
    presentCall(args) {
      return { card: 'generic', title: '生成视频（MiniMax）：' + (args.prompt ?? args.image ?? ''), kind: 'generate' }
    },
  })
}
