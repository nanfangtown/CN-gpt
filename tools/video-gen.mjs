/**
 * video_gen —— 百炼（DashScope）异步出片：可灵 v3 / 万相 wan2.5。
 *
 * 与 seedance_video 的关系：**同构但不合并**。
 *   - 同构：都是"提交 → task_id → 轮询 → 下载 → 记账"的异步任务；
 *   - 不合并的理由：鉴权（Bearer 一样）、端点（百炼 maas 域名 vs 方舟）、
 *     参数面（mode/audio/size vs content 数组）全不同，合并只会让两边都变脆。
 *     真正共享的是 tasks/manager.mjs 与 core/spend-guard.mjs。
 *
 * 计费：按秒，档位 = 模式（720P/1080P/4K）× 是否带音频，见 adapter 的 estimateCost。
 * 付费纪律与 seedance_video 完全一致：先报价、再确认、超限拒绝、未计价 fail-closed。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError, STATES, fixedMessage } from '../core/errors.mjs'
import { resolveOutDir, shortHash, slugify, stamp } from '../core/deliver.mjs'
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
import { DURATION_RANGE, VIDEO_MODELS, resolveVideoModel } from '../tasks/adapters/dashscope-video.mjs'

const KEY = keySpec('dashscope-video')
const ADAPTER_ID = 'dashscope-video'
const PROVIDER_LABEL = '百炼（可灵/万相）'
const PROVIDER_KEY = 'bailian'

/** 参数里的短名列表（给 schema 与错误文案共用，避免两处漂移）。 */
const MODEL_NAMES = Object.keys(VIDEO_MODELS)

/**
 * 解析本次调用的模型：显式参数 > 配置默认值。
 *
 * ⚠ 返回的是**真实模型 id**，不是短名 —— 单价表、账本、注册表一律按 id，
 * 这是 2026-10-15 "模型 id 与单价表脱钩 → 闸门 fail-closed 且无告警" 的直接对策。
 *
 * @param {object} args - 工具参数。
 * @param {object} config - 插件 Config（已解包）。
 * @returns {{alias: string, id: string, family: string, label: string}}
 */
function pickModel(args, config) {
  const requested = typeof args.model === 'string' && args.model.trim().length > 0 ? args.model.trim() : config.videoModel
  const resolved = resolveVideoModel(requested)
  if (resolved === undefined) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：未知的视频模型「${String(requested ?? '')}」。可选：${MODEL_NAMES.join(' / ')}` +
        `（配置卡里的 videoModel 目前是「${String(config.videoModel ?? '')}」）。**本次未提交、未产生任何费用。**`,
    )
  }
  return resolved
}

/** 时长校验：可灵 3–15 秒；万相只接受 5 / 10 秒（官方 10 秒长视频档）。 */
function normalizeDuration(value, family) {
  const fallback = DURATION_RANGE.default
  const raw = value === undefined || value === null ? fallback : Number(value)
  if (!Number.isFinite(raw)) {
    throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：duration 必须是整数秒。**本次未提交、未产生任何费用。**')
  }
  const seconds = Math.trunc(raw)
  if (family === 'wan') {
    if (seconds !== 5 && seconds !== 10) {
      throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：万相 wan2.5 只支持 5 秒 / 10 秒。**本次未提交、未产生任何费用。**')
    }
    return seconds
  }
  if (seconds < DURATION_RANGE.min || seconds > DURATION_RANGE.max) {
    throw new MediaError(
      CODES.BAD_REQUEST,
      `参数不被接受：可灵时长必须是 ${DURATION_RANGE.min}–${DURATION_RANGE.max} 秒整数。**本次未提交、未产生任何费用。**`,
    )
  }
  return seconds
}

/**
 * 注册 video_gen。
 * @param {object} deps - ctx / config / manager / keys / getLedger / getTaskRegistry / budget。
 */
export function createVideoGenTool(deps) {
  const { config, manager, keys, getLedger, getTaskRegistry, budget, logger } = deps

  return defineTool({
    name: 'video_gen',
    description: '文生/图生视频（百炼：可灵 v3 / 万相 2.5），返回本地路径；超时保留 task_id。按秒计费：先报价，带 confirm_estimate 再调一次才提交。',
    parameters: {
      prompt: { type: 'string', required: true, description: '视频描述（可灵支持"shot 1,3,文字;…"多镜头语法）' },
      model: { type: 'string', enum: MODEL_NAMES, description: '模型；留空用配置默认' },
      mode: { type: 'string', enum: ['std', 'pro', '4k'], description: '画质：std=720P / pro=1080P / 4k' },
      duration: { type: 'integer', description: '秒：可灵 3–15，万相 5/10' },
      ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: '宽高比' },
      audio: { type: 'boolean', description: '原生音频（可灵加价）' },
      image: { type: 'string', description: '首帧图 http(s) URL（仅可灵）' },
      out_dir: { type: 'string', description: '产物目录' },
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
              mode: { type: 'string' },
              ratio: { type: 'string' },
              audio: { type: 'boolean' },
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
        const bits = [
          value.spec.duration === undefined ? undefined : value.spec.duration + 's',
          value.spec.mode,
          value.spec.ratio,
          value.spec.audio === true ? '有声' : undefined,
        ].filter(Boolean)
        if (bits.length > 0) lines.push('参数：' + bits.join(' / '))
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
      /** 本次真实规格与报价（失败补记用：不能拿 config.videoModel 顶替）。 */
      let plannedSpec
      let plannedCost
      /** 远端是否已确认成功出片（成功之后才失败，同样要补记）。 */
      let succeeded = false
      try {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt.length === 0) throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：prompt 不能为空；请提供视频描述后重试')

        const model = pickModel(args, config)
        const duration = normalizeDuration(args.duration, model.family)
        const spec = { model: model.id, prompt, duration }
        if (typeof args.mode === 'string' && args.mode.length > 0) spec.mode = args.mode
        if (typeof args.ratio === 'string' && args.ratio.length > 0) spec.ratio = args.ratio
        if (args.audio === true) spec.audio = true
        if (typeof args.image === 'string' && args.image.trim().length > 0) {
          const url = args.image.trim()
          // 只收 http(s)：百炼文档只承诺 URL，本地路径要转 data URL —— 那条路未确证，
          // 在付费接口上"试一下"等于下单，所以这里直接拒绝并给出替代方案。
          if (!/^https?:\/\//i.test(url)) {
            throw new MediaError(
              CODES.BAD_REQUEST,
              '参数不被接受：image 必须是 **http(s) URL**（本地路径/相对路径不支持）。' +
                '**本次未提交、未产生任何费用。** 可先用 qwen_draw 出图再把公网地址给它，或改用文生视频。',
            )
          }
          spec.image = { url }
        }

        const credential = await keys.resolve(KEY)
        if (credential === undefined || credential === null || typeof credential.value !== 'string' || credential.value.length === 0) {
          throw new MediaError(CODES.MISSING_CREDENTIAL, fixedMessage(CODES.MISSING_CREDENTIAL, { ref: KEY.ref }))
        }
        // 配额只在真正要提交时扣：参数错 / 缺 key 不占名额。
        const grant = budget.take(sessionId)
        if (!grant.ok) throw new MediaError(CODES.RATE_LIMIT, budgetMessage(grant))

        // ⛔ 付费收口：先按"档位 × 秒"报价，再走确认/上限/未计价三道闸。
        const adapter = manager.get(ADAPTER_ID)
        const cost = adapter.estimateCost(spec, pricingOf(config))
        const estimate = estimateSpend({ model: spec.model, duration: spec.duration, unitPrice: cost.unitPrice })
        plannedEstimate = estimate
        // 供失败分支补记：一旦开工，模型/档位/单价都必须用**本次真实的 spec**，
        // 不能用配置里的 videoModel（用户可能显式传了另一个模型）。
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
        // 走到这里 = 远端**已经成功出片并计费**。之后任何失败（下载/落盘/记账）
        // 都不能让这笔钱在账本上消失，所以先把标记立起来（见 catch 的补记分支）。
        succeeded = true
        const outDir = resolveOutDir({
          configValue: typeof args.out_dir === 'string' && args.out_dir.trim().length > 0 ? args.out_dir : config.videoOutDir,
          exec,
        })
        const files = await manager.fetchArtifacts(state, {
          outDir,
          signal: exec.signal,
          nameHint: 'bailian-' + slugify(prompt) + '-' + stamp() + '-' + shortHash(prompt),
        })
        if (files.length === 0) {
          throw new MediaError(
            CODES.UNKNOWN,
            fixedMessage(CODES.UNKNOWN, { provider: PROVIDER_LABEL, detail: '任务 ' + taskRef.taskId + ' 标记成功，但响应里没有视频地址（检查 output.video_url）' }),
          )
        }
        const ledger = await getLedger()
        await ledger.record({
          adapter: ADAPTER_ID,
          provider: PROVIDER_LABEL,
          model: spec.model,
          unitKind: 'second',
          units: spec.duration ?? 5,
          unitPrice: cost.unitPrice,
          currency: cost.currency,
          amount: cost.amount,
          taskId: taskRef.taskId,
          ...(spec.mode === undefined ? {} : { mode: spec.mode }),
          ...(spec.audio === true ? { audio: true } : {}),
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        await ledger.noteHealth(ADAPTER_ID, true, 'task ' + taskRef.taskId)
        const specOut = { ...spec }
        delete specOut.model
        delete specOut.prompt
        if (spec.image !== undefined) specOut.image = spec.image.url
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
          // 三种"钱可能已经花了"的形态，全部补记（同一 taskId 只记一次）：
          //   ① TIMEOUT / ABORTED：提交已发生，远端在那一刻开始计时；
          //   ② succeeded=true 之后的任何失败：远端**已经出片成功**，只是我们没取回来
          //      （下载 5xx、磁盘写失败、账本写失败）—— 2026-10-17 复查发现这是新代码的
          //      一个漏账口：成功路径的记账在产物落盘之后，它一失败，这笔钱就从账本消失了，
          //      会话累计上限因此永远看不到它。
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
                // ⚠ 用本次真实的 spec.model，不是 config.videoModel：
                // 用户显式传了 wan2.5 而配置默认是 kling 时，记错模型会让报表归错档。
                model: plannedSpec.model,
                unitKind: 'second',
                units: plannedCost.units,
                unitPrice: plannedCost.unitPrice,
                currency: plannedCost.currency ?? 'CNY',
                amount: plannedCost.amount,
                ...(plannedSpec.mode === undefined ? {} : { mode: plannedSpec.mode }),
                ...(plannedSpec.audio === true ? { audio: true } : {}),
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
      return { card: 'generic', title: '生成视频（百炼）：' + args.prompt, kind: 'generate' }
    },
  })
}
