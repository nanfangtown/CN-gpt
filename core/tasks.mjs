/**
 * 任务注册表（2026-10-13 加）。
 *
 * 解决什么：异步任务（qwen 制图 / seedance 出片）提交后会拿到 task_id，但
 * **整轮请求可能在那之后失败**（例如复现过的 `TRANSPORT`），于是 task_id 随上下文一起丢了，
 * 用户只能自己去产物目录里翻文件——远端可能还有一份跑完的产物没取回来。
 *
 * `media_task(provider, task_id)` 本身一直能重查/补下载，缺的只是"事后还找得到这个 id"。
 * 所以这里把提交过的任务登记到本地：
 *   - 优先宿主 storage 服务（`ctx.storageDomain`，带 schema 校验）；
 *   - 不可用时退化为自有 JSON 文件（原子替换），与账本同一套思路；
 *   - **登记失败绝不影响工具本身**（失败只记日志，调用照常返回）。
 *
 * 与账本的区别：账本记"花了多少"，注册表记"提交过什么、跑到哪了"。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DOMAIN_NAME = 'mm_media_tasks'
const REGISTRY_VERSION = 1
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}

function registryFilePath(config) {
  const configured = typeof config?.taskRegistryPath === 'string' ? config.taskRegistryPath.trim() : ''
  if (configured.length > 0) return configured
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'mm-models-tasks.json')
}

function maxEntriesOf(config) {
  const value = Number(config?.maxRegistryEntries)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_MAX_ENTRIES
}

function ttlOf(config) {
  const value = Number(config?.registryTtlMs)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS
}

async function readJsonFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      return { version: REGISTRY_VERSION, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] }
    }
  } catch {
    // 首次运行 / 文件损坏 → 空注册表（不阻塞任何工具）。
  }
  return { version: REGISTRY_VERSION, tasks: [] }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** 条目是否已过期。 */
function isExpired(task, now, ttl) {
  const at = Date.parse(task?.at ?? '')
  if (!Number.isFinite(at)) return false
  return now - at > ttl
}

/**
 * 打开任务注册表。
 *
 * @param {object} ctx - 插件上下文（可选 storageDomain / logger）。
 * @param {object} config - 插件 Config（liveConfig）。
 * @param {object} [logger] - 可选 logger。
 * @returns {Promise<object>} registry：{ record, update, list, find, backend, close }
 */
export async function openTaskRegistry(ctx, config, logger) {
  const log = (level, message) => {
    const fn = logger?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(logger, '[mm-models] ' + message)
      } catch {
        // 日志失败不影响注册表。
      }
    }
  }
  const filePath = registryFilePath(config)

  // 优先宿主 storage：可用就用它，装载失败自动退回 JSON 文件。
  //
  // ⚠ 2026-10-16 修（实机复查发现）：这里原来传的是**裸 JSON-Schema 对象**
  //   `{ tasks: { key: 'id', schema: { type: 'object', properties: {...} } } }`，
  // 而宿主 storage-domain 的契约是 `defineDomain({...})` + `domainTable(zodSchema)`
  // （账本 core/cost.mjs 一直是对的写法）。契约不对 → `open()` 直接抛错 →
  // 静默退回 JSON 文件。实机表现：`media_task(action=list)` 每次自报
  // 「注册表后端：file」，而账本同时报「storage」——同一个宿主服务，一个成一个败。
  // 更糟的是旧 schema 里 `id` 是 required，而我们**从不写 id**（表键是 provider:taskId），
  // 所以就算 open() 侥幸通过，任何一条已存记录都会在下次 open() 时校验失败。
  // 现在与账本同源：defineDomain + domainTable(zod) + invalidRecords 护栏。
  let backend = 'file'
  let domain
  let storageError
  const facility = typeof ctx?.get === 'function' ? ctx.get('storageDomain') : undefined
  if (facility !== undefined && facility !== null && typeof facility.open === 'function') {
    try {
      const [{ defineDomain, domainTable }, { z }] = await Promise.all([import('@deepseek-ai/dsh-storage-domain'), import('zod')])
      // 字段必须与 record()/update() **实际写入的形状**一致，否则下次 open() 逐条校验
      // 就是 invalid-record → 整个领域被放弃、退回文件（账本 2026-10-15 踩过同一个坑）。
      const taskSchema = z.object({
        at: z.string(),
        provider: z.string(),
        taskId: z.string(),
        model: z.string().optional(),
        prompt: z.string().optional(),
        n: z.number().optional(),
        mode: z.string().optional(),
        duration: z.number().optional(),
        status: z.string().optional(),
      })
      const spec = defineDomain({
        name: DOMAIN_NAME,
        version: REGISTRY_VERSION,
        // 与账本同一道护栏：单条记录校验不过时备份挪走、其余照常装载，
        // 而不是让整个领域 open() 失败（那会静默丢掉整段历史）。
        invalidRecords: 'backup-and-skip',
        tables: { tasks: domainTable(taskSchema) },
      })
      domain = await facility.open(spec)
      backend = 'storage'
    } catch (error) {
      storageError = error
      log('warn', '任务注册表 storage 后端不可用，退回 JSON 文件：' + String(error?.message ?? error))
    }
  } else {
    // "服务拿不到"与"服务打不开"必须是同一条**可解释**的降级原因，
    // 否则 health 报告只会说"注册表后端：file"，用户没有任何线索（账本已修过同一处）。
    storageError =
      typeof ctx?.get !== 'function'
        ? new Error('插件上下文没有 ctx.get：无法查找 storageDomain 服务，只能用文件注册表')
        : new Error(
            "宿主未提供 storageDomain 服务（ctx.get('storageDomain') 未命中）：可能是该环境本就不带 storage-domain，或服务尚未就绪、插件先于它装配。此类环境下注册表落在文件后端。",
          )
    log('debug', '[mm-models] storageDomain service unavailable; using JSON file task registry')
  }

  let writeChain = Promise.resolve()
  function enqueue(task) {
    const next = writeChain.then(task, task)
    writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async function loadFile() {
    return readJsonFile(filePath)
  }

  /** 读全部条目（已按时间倒序去重）。 */
  async function all() {
    const now = Date.now()
    const ttl = ttlOf(config)
    let tasks = []
    if (backend === 'storage') {
      try {
        // 与账本同源的读法：宿主 KvTable 只保证 entries()/keys()/get()，
        // 没有 all() —— 原来这里调 .all() 会抛错，被下面的 catch 吞成空列表。
        tasks = [...domain.table('tasks').entries()].map(([, value]) => value)
      } catch (error) {
        log('warn', '任务注册表读取失败（storage）：' + String(error?.message ?? error))
        tasks = []
      }
    } else {
      tasks = (await loadFile()).tasks
    }
    return tasks
      .filter((task) => task !== null && typeof task === 'object' && typeof task.taskId === 'string')
      .filter((task) => !isExpired(task, now, ttl))
      .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
      .slice(0, maxEntriesOf(config))
  }

  /** 登记一次提交（同 taskId+provider 覆盖）。 */
  async function record(entry) {
    const task = { at: nowIso(), ...entry }
    try {
      if (backend === 'storage') {
        await domain.table('tasks').put(`${task.provider}:${task.taskId}`, task)
      } else {
        await enqueue(async () => {
          const state = await loadFile()
          const kept = state.tasks.filter((row) => !(row?.taskId === task.taskId && row?.provider === task.provider))
          kept.push(task)
          kept.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
          const trimmed = kept.slice(0, maxEntriesOf(config))
          await writeJsonFile(filePath, { version: REGISTRY_VERSION, tasks: trimmed })
        })
      }
      return true
    } catch (error) {
      // 登记失败绝不能影响工具：只记日志，调用照常。
      log('warn', '任务登记失败（不影响本次调用）：' + String(error?.message ?? error))
      return false
    }
  }

  /** 更新已知任务（按 provider+taskId 找，找不到就当成新登记）。 */
  async function update(provider, taskId, patch) {
    try {
      if (backend === 'storage') {
        const table = domain.table('tasks')
        const existing = await table.get(`${provider}:${taskId}`)
        await table.put(`${provider}:${taskId}`, { at: nowIso(), ...(existing ?? { provider, taskId }), ...patch, provider, taskId })
        return true
      }
      await enqueue(async () => {
        const state = await loadFile()
        const index = state.tasks.findIndex((row) => row?.taskId === taskId && row?.provider === provider)
        if (index >= 0) state.tasks[index] = { ...state.tasks[index], ...patch }
        else state.tasks.unshift({ at: nowIso(), provider, taskId, ...patch })
        state.tasks.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
        await writeJsonFile(filePath, { version: REGISTRY_VERSION, tasks: state.tasks.slice(0, maxEntriesOf(config)) })
      })
      return true
    } catch (error) {
      log('warn', '任务更新失败（不影响本次调用）：' + String(error?.message ?? error))
      return false
    }
  }

  return {
    record,
    update,
    list: all,
    backend,
    /** 退回文件后端的原因（供 health 报告点名，未降级时为 undefined）。 */
    storageError: () => storageError,
    path: backend === 'file' ? filePath : undefined,
    async close() {
      try {
        if (backend === 'storage' && typeof domain?.close === 'function') await domain.close()
      } catch {
        // 忽略
      }
    },
  }
}
