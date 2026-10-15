/**
 * media_task —— 异步任务重查 / 补下载（规划 [2.4]）。
 *
 * 用途：同步轮询 TIMEOUT / ABORTED 之后的人工闭环；一次性查询，不轮询不缓存。
 * action=download 时若是终态成功则直接补下载并落盘，返回本地路径。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODES, MediaError, STATES, fixedMessage } from '../core/errors.mjs'
import { resolveOutDir, stamp } from '../core/deliver.mjs'
import { keySpec } from '../core/keys.mjs'
import { asMediaError } from '../core/tool-kit.mjs'

const PROVIDERS = Object.freeze({
  qwen: { adapterId: 'dashscope-image', key: keySpec('dashscope'), label: 'DashScope', outDirKey: 'outDir' },
  seedance: { adapterId: 'ark-video', key: keySpec('ark'), label: '方舟 Ark', outDirKey: 'videoOutDir' },
})

/**
 * 注册 media_task。
 * @param {object} deps - config / manager / keys / getLedger / getTaskRegistry。
 */
export function createMediaTaskTool(deps) {
  const { config, manager, keys, getLedger, getTaskRegistry } = deps

  return defineTool({
    name: 'media_task',
    description: '重查/补下载异步媒体任务，或列出最近提交过的任务。用于超时/取消/整轮失败之后；一次性查询。',
    parameters: {
      action: { type: 'string', enum: ['status', 'download', 'list'], description: '默认 status；download 补下载；list 列出最近任务（找回 task_id）' },
      provider: { type: 'string', enum: ['qwen', 'seedance'], description: 'qwen=制图；seedance=出片（list 时可省略作筛选）' },
      task_id: { type: 'string', description: '任务 id（status/download 必填）' },
      out_dir: { type: 'string', description: '补下载目录；默认配置值' },
      limit: { type: 'integer', description: 'list 返回条数上限（默认 10）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          provider: { type: 'string' },
          taskId: { type: 'string' },
          status: { type: 'string' },
          rawStatus: { type: 'string' },
          progress: { type: 'string' },
          artifactCount: { type: 'integer' },
          files: {
            type: 'array',
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
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                taskId: { type: 'string', required: true },
                at: { type: 'string', required: true },
                status: { type: 'string' },
                model: { type: 'string' },
                prompt: { type: 'string' },
              },
            },
          },
          registryBackend: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.action === 'list') {
          const tasks = value.tasks ?? []
          const lines = ['最近提交过的媒体任务' + (value.registryBackend === undefined ? '' : '（注册表后端：' + value.registryBackend + '）') + '：']
          if (tasks.length === 0) {
            lines.push('（注册表里没有任务。任务在提交成功时登记；若你刚提交过却没看到，说明 persistTasks 关着或注册表写入失败。）')
          }
          for (const task of tasks) {
            lines.push(
              '- ' + task.provider + ' ' + task.taskId + '｜' + (task.status ?? '未知') + '｜' + task.at + (task.model === undefined ? '' : '｜' + task.model) +
                (task.prompt === undefined ? '' : '｜' + String(task.prompt).slice(0, 40)),
            )
          }
          if (tasks.length > 0) lines.push('用 media_task(provider, task_id, action=status) 查最新状态，action=download 补下载产物。')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [value.provider + ' 任务 ' + value.taskId + '：' + value.status + (value.rawStatus === undefined ? '' : '（厂商状态 ' + value.rawStatus + '）')]
        if (value.progress !== undefined) lines.push('进度：' + value.progress)
        lines.push('产物数量：' + value.artifactCount)
        for (const file of value.files ?? []) lines.push('- ' + file.path + '（' + file.mediaType + '，' + file.bytes + ' bytes）')
        if (value.detail !== undefined) lines.push(value.detail)
        if (value.status === 'succeeded' && (value.files === undefined || value.files.length === 0)) {
          lines.push('提示：用 media_task(action=download) 可把产物补下载到本地。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = args.action ?? 'status'
      // list：列出注册表里最近的提交。整轮失败/超时后靠它把 task_id 找回来。
      if (action === 'list') {
        const registry = await getTaskRegistry()
        const all = (await registry?.list()) ?? []
        const filtered = typeof args.provider === 'string' ? all.filter((task) => task.provider === args.provider) : all
        const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.trunc(args.limit) : 10
        return {
          action: 'list',
          tasks: filtered.slice(0, limit).map((task) => ({
            provider: task.provider,
            taskId: task.taskId,
            at: task.at,
            ...(task.status === undefined ? {} : { status: task.status }),
            ...(task.model === undefined ? {} : { model: task.model }),
            ...(task.prompt === undefined ? {} : { prompt: task.prompt }),
          })),
          registryBackend: registry?.backend ?? 'disabled',
        }
      }
      const provider = PROVIDERS[args.provider]
      if (provider === undefined) throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：provider 必须是 qwen 或 seedance')
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
      if (taskId.length === 0) throw new MediaError(CODES.BAD_REQUEST, '参数不被接受：task_id 不能为空')
      try {
        const adapter = manager.get(provider.adapterId)
        // 同步模式没有远端任务可查（如 qwen-image）；直接给出可读说明，避免误报 404。
        if (typeof adapter.modeFor === 'function' && adapter.modeFor(config) === 'sync') {
          return {
            provider: args.provider,
            taskId,
            status: 'unsupported',
            artifactCount: 0,
            detail: '该 provider 当前为同步模式：没有可重查的远端任务；产物在 qwen_draw / seedance_video 调用时已落盘。',
          }
        }
        const credential = await keys.resolve(provider.key)
        if (credential === undefined) throw new MediaError(CODES.MISSING_CREDENTIAL, fixedMessage(CODES.MISSING_CREDENTIAL, { ref: provider.key.ref }))
        const state = await manager.query({ adapter: provider.adapterId, taskId }, { credential: credential.value, signal: exec.signal })
        const action = args.action ?? 'status'
        if (action === 'download' && state.status === STATES.SUCCEEDED) {
          const outDir = resolveOutDir({
            configValue: typeof args.out_dir === 'string' && args.out_dir.trim().length > 0 ? args.out_dir : config[provider.outDirKey],
            exec,
          })
          const files = await manager.fetchArtifacts(state, { outDir, signal: exec.signal, nameHint: args.provider + '-recover-' + stamp() })
          return {
            provider: args.provider,
            taskId,
            status: state.status,
            rawStatus: state.rawStatus,
            ...(state.progress === undefined ? {} : { progress: String(state.progress) }),
            artifactCount: state.artifacts.length,
            files: files.map((file) => ({ path: file.path, bytes: file.bytes, mediaType: file.mediaType })),
          }
        }
        return {
          provider: args.provider,
          taskId,
          status: state.status,
          ...(state.rawStatus === undefined ? {} : { rawStatus: state.rawStatus }),
          ...(state.progress === undefined ? {} : { progress: String(state.progress) }),
          artifactCount: state.artifacts.length,
          ...(state.error === undefined ? {} : { detail: '厂商失败原因：' + state.error.code + ' ' + state.error.detail }),
        }
      } catch (error) {
        throw asMediaError(error, { provider: provider.label, ref: provider.key.ref, where: 'query' })
      }
    },
    presentCall(args) {
      return { card: 'generic', title: '重查任务 ' + args.task_id, kind: 'query' }
    },
  })
}
