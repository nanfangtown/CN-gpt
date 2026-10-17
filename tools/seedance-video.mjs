/**
 * seedance_video —— 方舟 Ark 异步文生 / 图生视频（规划 [2.3]）。
 *
 * 首帧图参数 image 接受：
 *   - http(s) URL：原样传给厂商；
 *   - 本地文件路径：读取后转成 data URL（大小受 config.maxInlineImageBytes 限制）。
 * 实跑确证厂商字段后，若只接受 URL，则本地文件路径这条路径需要改为先上传到可访问位置。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError, STATES, fixedMessage } from '../core/errors.mjs'
import { resolveOutDir, shortHash, slugify, stamp } from '../core/deliver.mjs'
import { resolveImageArg } from '../core/image-input.mjs'
import { keySpec } from '../core/keys.mjs'
import { pricingOf, unitPriceOf } from '../core/cost.mjs'
import { authorizeSpend, estimateSpend } from '../core/spend-guard.mjs'
import { accountUnretrievedSpend, asMediaError, budgetMessage, sessionIdOf, sessionSpentOrThrow, stateFailureToError } from '../core/tool-kit.mjs'

const KEY = keySpec('ark')
const ADAPTER_ID = 'ark-video'

/**
 * 注册 seedance_video。
 * @param {object} deps - ctx / config / manager / keys / getLedger / budget。
 */
export function createSeedanceVideoTool(deps) {
  const { config, manager, keys, getLedger, getTaskRegistry, budget, logger } = deps

  return defineTool({
    name: 'seedance_video',
    description: '文生/图生视频（Seedance / 方舟 Ark）：生成短视频，返回本地路径；超时保留 task_id。**按次计费且不可撤销**：首次调用只报价不提交，须带 confirm_estimate 再调一次才出片。',
    parameters: {
      prompt: { type: 'string', required: true, description: '视频内容描述' },
      image: { type: 'string', description: '首帧图 URL 或本地路径；给出即图生视频' },
      duration: { type: 'integer', description: '时长（秒），默认 5' },
      resolution: { type: 'string', description: '如 720p、1080p；留空用模型默认' },
      ratio: { type: 'string', description: '如 16:9、9:16、1:1；留空用模型默认' },
      out_dir: { type: 'string', description: '产物目录，默认 gen/video' },
      confirm_estimate: {
        type: 'number',
        description: '花费确认：填上次返回的预估金额（元，精确到分）才会真正提交。',
      },
      confirm_unpriced: {
        type: 'boolean',
        description: '未计价模型（查不到单价）的放行确认；默认拒绝提交。此路径只认它，报金额不作数。',
      },
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
              ratio: { type: 'string' },
              image: { type: 'string' },
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
        if (value.spec.duration !== undefined) lines.push('参数：' + [value.spec.duration + 's', value.spec.resolution, value.spec.ratio].filter(Boolean).join(' / '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({ taskId: value.taskId, model: value.model, paths: value.videos.map((video) => video.path) }),
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
        if (prompt.length === 0) throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：prompt 不能为空；请提供视频描述后重试')
        const spec = { model: config.seedanceModel, prompt }
        if (Number.isFinite(args.duration) && args.duration > 0) spec.duration = Math.trunc(args.duration)
        if (typeof args.resolution === 'string' && args.resolution.trim().length > 0) spec.resolution = args.resolution.trim()
        if (typeof args.ratio === 'string' && args.ratio.trim().length > 0) spec.ratio = args.ratio.trim()
        if (typeof args.image === 'string' && args.image.trim().length > 0) {
          spec.image = await resolveImageArg(args.image, { exec, maxBytes: config.maxInlineImageBytes, label: '首帧图' })
        }

        const credential = await keys.resolve(KEY)
        // 只有"确实拿到非空字符串凭据"才算过：`null` 或 `{ value: undefined }` 都必须落回缺凭据，
        // 否则后面 `credential.value` 会炸成语义不明的错误（2026-10-16 加固）。
        if (credential === undefined || credential === null || typeof credential.value !== 'string' || credential.value.length === 0) {
          throw new MediaError(CODES.MISSING_CREDENTIAL, fixedMessage(CODES.MISSING_CREDENTIAL, { ref: KEY.ref }))
        }
        // 同 qwen_draw：配额只在真正要提交时扣，参数错/缺 key 不占名额。
        const grant = budget.take(sessionId)
        if (!grant.ok) throw new MediaError(CODES.RATE_LIMIT, budgetMessage(grant))

        // ⛔ 付费收口（2026-10-15 事故后重建）：提交前必须过金额闸门 + 显式确认。
        // 详见 core/spend-guard.mjs 的事故说明。这里的职责只是**组装上下文并调用**，
        // 判定逻辑集中在收口模块里，便于单测直接覆盖（不必绕整条工具链）。
        const estimate = estimateSpend({
          model: spec.model,
          duration: spec.duration,
          unitPrice: unitPriceOf(pricingOf(config)[spec.model] ?? {}),
        })
        plannedEstimate = estimate
        const verdict = await authorizeSpend({
          estimate,
          config,
          spentInSession: () =>
            sessionSpentOrThrow({
              getLedger,
              sessionId,
              // 会话累计含后代子代理会话（子代理默认允许出片）
              sessionIds: deps.sessionIdsForSpend?.(sessionId),
              providerLabel: '方舟 Ark',
            }),
          confirmed: { confirm_estimate: args.confirm_estimate, confirm_unpriced: args.confirm_unpriced },
          providerLabel: '方舟 Ark',
        })
        if (!verdict.ok) throw new MediaError(CODES.BAD_REQUEST, verdict.message)

        const { taskRef, state } = await manager.run({
          adapterId: ADAPTER_ID,
          spec,
          credential: credential.value,
          signal: exec.signal,
          timeoutMs: config.videoTimeoutMs,
          // 提交成功就登记：出片通常要几分钟，中途整轮失败的概率更高，登记尤其重要。
          onSubmitted: async (ref) => {
            const registry = await getTaskRegistry()
            await registry?.record({
              provider: 'seedance',
              taskId: ref.taskId,
              model: spec.model,
              prompt: spec.prompt,
              duration: spec.duration,
              status: 'submitted',
            })
          },
        })
        // 走到这里说明提交已经发生（taskRef 一定存在）——先把 id 记下来，
        // 后面无论超时还是取消，补记那笔钱时都要用它。
        plannedTaskId = taskRef.taskId
        if (state.status === STATES.TIMEOUT) {
          throw new MediaError(CODES.TIMEOUT, fixedMessage(CODES.TIMEOUT, { provider: '方舟 Ark', providerKey: 'seedance', taskId: taskRef.taskId, timeoutMs: config.videoTimeoutMs }))
        }
        if (state.status === STATES.ABORTED) {
          throw new MediaError(CODES.ABORTED, fixedMessage(CODES.ABORTED, { providerKey: 'seedance', taskId: taskRef.taskId }))
        }
        if (state.status === STATES.FAILED) {
          throw stateFailureToError(state, { adapter: manager.get(ADAPTER_ID), providerLabel: '方舟 Ark', ref: KEY.ref })
        }
        const outDir = resolveOutDir({
          configValue: typeof args.out_dir === 'string' && args.out_dir.trim().length > 0 ? args.out_dir : config.videoOutDir,
          exec,
        })
        const files = await manager.fetchArtifacts(state, {
          outDir,
          signal: exec.signal,
          nameHint: 'seedance-' + slugify(prompt) + '-' + stamp() + '-' + shortHash(prompt),
        })
        if (files.length === 0) {
          // 任务标记成功但没有产物字段：绝不伪装成"已完成但没内容"（规划 [6.3]）。
          throw new MediaError(
            CODES.UNKNOWN,
            fixedMessage(CODES.UNKNOWN, { provider: '方舟 Ark', detail: '任务 ' + taskRef.taskId + ' 标记成功，但响应里没有视频地址（产物字段待实跑确证）' }),
          )
        }
        const cost = manager.get(ADAPTER_ID).estimateCost(spec, pricingOf(config))
        const ledger = await getLedger()
        await ledger.record({
          adapter: ADAPTER_ID,
          provider: '方舟 Ark',
          model: spec.model,
          unitKind: 'second',
          units: spec.duration ?? 5,
          unitPrice: cost.unitPrice,
          currency: cost.currency,
          amount: cost.amount,
          taskId: taskRef.taskId,
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        await ledger.noteHealth(ADAPTER_ID, true, 'task ' + taskRef.taskId)
        const specOut = { ...spec }
        delete specOut.model
        delete specOut.prompt
        if (spec.image !== undefined) specOut.image = spec.image.display ?? 'provided'
        return { taskId: taskRef.taskId, model: spec.model, videos: files.map((file) => ({ path: file.path, bytes: file.bytes, mediaType: file.mediaType })), spec: specOut, elapsedMs: state.elapsedMs ?? 0 }
      } catch (error) {
        const mediaError = asMediaError(error, { provider: '方舟 Ark', ref: KEY.ref, where: 'query' })
        if (mediaError.code !== CODES.MISSING_CREDENTIAL) {
          // 超时/中断：任务**已经提交**、方舟在那一刻就开始计费，而成功路径的记账在产物落盘之后 ——
          // 不补这一笔，"反复提交完就放弃"永远不体现在会话累计上限与报表里。
          // 这正是 2026-10-15 事故的形态（22 个任务、¥195.97），同一个 taskId 只记一次。
          if ((mediaError.code === CODES.TIMEOUT || mediaError.code === CODES.ABORTED) && typeof plannedTaskId === 'string' && plannedEstimate !== undefined) {
            await accountUnretrievedSpend({
              getLedger,
              taskId: plannedTaskId,
              logger,
              entry: {
                adapter: ADAPTER_ID,
                provider: '方舟 Ark',
                model: config.seedanceModel,
                unitKind: 'second',
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
            // 忽略
          }
        }
        throw mediaError
      }
    },
    presentCall(args) {
      return { card: 'generic', title: '生成视频：' + args.prompt, kind: 'generate' }
    },
  })
}
