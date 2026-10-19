/**
 * 安全不变量测试（2026-10-16 加，随两处 🔴 修复一起进来）。
 *
 * 这个文件专门钉两类**"坏了会花钱 / 会漏数据"的不变量**，与 run.mjs 的功能用例分开：
 *
 *   ① 本地文件边界：`seedance_video` 的 `image` 只能读会话工作目录内的**真图片**。
 *      修之前它能指向任意可读文件（实测可读 `~/.dsh/.env`）并把内容 base64 发到厂商 API ——
 *      等于一条外发通道；产物落盘路径也不允许借文件名/扩展名越出目标目录。
 *
 *   ② 花钱账本 fail-closed：会话累计上限依赖"本会话已花多少"。
 *      修之前 `cost.mjs` 的 `list()` 会把"读失败"吞成"返回空数组"，
 *      于是"已花"恒为 0、上限静默失效；降级到文件后端时还会漏掉 storage 领域里的真实花销。
 *      现在：花钱路径走 `list(filter, { strict: true })`，读不到就**拒绝提交**。
 *
 * 运行：node --import ./tests/register.mjs ./tests/safety-invariants.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLedger } from '../core/cost.mjs'
import { downloadToFile, isInside, safeDownloadExt } from '../core/deliver.mjs'
import { CODES } from '../core/errors.mjs'
import { sessionSpentOrThrow } from '../core/tool-kit.mjs'
import { createSeedanceVideoTool } from '../tools/seedance-video.mjs'
import { createFakeCtx, createFakeStorageDomain, makeExec, makePng } from './fixtures.mjs'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    failed += 1
    console.log('  ✗ ' + name + '\n      ' + String(error?.message ?? error))
    // CI 里把失败用例打成 annotation：否则日志要登录才能看，公开仓库的失败只剩
    // "Process completed with exit code 1"，既不能定位也不能当贡献者的反馈。
    if (process.env.GITHUB_ACTIONS === 'true') {
      const message = String(error?.message ?? error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
      console.log('::error title=' + name.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') + '::' + message.slice(0, 1000))
    }
  }
}

/** 取抛出的错误（不抛则返回 undefined），避免每个用例都写 try/catch。 */
async function thrown(fn) {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error
  }
}

const MODEL = 'doubao-seedance-2-5-260628'

/**
 * 出片工具的最小依赖集（不联网、不落盘、不提交）。
 * `credential` 默认 **null = 没有凭据**（用例可按需给一个，才能走到花钱闸门那一层）。
 */
function makeTool({ ledger, onRun = () => {}, credential = null }) {
  const config = {
    seedanceModel: MODEL,
    maxInlineImageBytes: 10 * 1024 * 1024,
    videoCostLimitCNY: 10,
    videoSessionCostLimitCNY: 30,
    requireSpendConfirm: true,
    noConfirmUnderCNY: 1,
    allowUnpricedSpend: false,
    videoOutDir: 'gen/video',
    videoTimeoutMs: 1000,
    pricing: { [MODEL]: { unit: 'second', unitPrice: 1.519, currency: 'CNY' } },
  }
  return createSeedanceVideoTool({
    config,
    manager: {
      async run() {
        onRun()
        throw new Error('本用例不应走到提交')
      },
    },
    keys: { resolve: async () => credential ?? undefined },
    getLedger: async () => ledger,
    getTaskRegistry: async () => undefined,
    budget: { take: () => ({ ok: true }) },
  })
}

const root = await mkdtemp(join(tmpdir(), 'mm-safety-'))
try {
  const inside = join(root, 'inside')
  const outside = join(root, 'outside')
  await mkdir(inside, { recursive: true })
  await mkdir(outside, { recursive: true })

  // ---------------------------------------------------------------- ① 路径边界
  console.log('\n① 本地文件边界')

  await test('isInside：子路径算在内，同前缀的兄弟目录不算', async () => {
    // ⚠ 故意不创建 inside/a/：目标不存在时也必须按"最近存在的祖先"解析。
    // Windows CI 的 TEMP 是 8.3 短路径（RUNNER~1），字面 resolve 与 realpath 前缀不同，
    // 曾把 inside/a/b.png 误判成越界（2026-10-19 真实 CI 回归）。
    assert.equal(await isInside(join(inside, 'a', 'b.png'), inside), true)
    assert.equal(await isInside(inside + '-sibling', inside), false)
  })

  await test('safeDownloadExt：认不出媒体类型时只接受白名单扩展名，其余一律 .bin', () => {
    assert.equal(safeDownloadExt('image/png', '.evil'), '.png')
    assert.equal(safeDownloadExt(undefined, '.PNG'), '.png')
    assert.equal(safeDownloadExt(undefined, '.sh'), '.bin')
    assert.equal(safeDownloadExt(undefined, '/../..\\evil.sh'), '.bin')
  })

  await test('产物落盘：文件名带 .. 时拒绝写入（路径必须留在 outDir 内）', async () => {
    const bytes = Buffer.from('hello-not-an-image')
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      body: undefined,
      async arrayBuffer() {
        return bytes
      },
    })
    const error = await thrown(() =>
      downloadToFile('https://example.test/a.png', { outDir: inside, name: '../../escape', fetchImpl: fakeFetch }),
    )
    assert.ok(error, '越界文件名必须被拒绝')
    assert.equal(error.code, CODES.BAD_REQUEST)
    assert.equal(existsSync(join(root, 'escape.bin')), false, '不得在 outDir 之外留下文件')
  })

  await test('image 指向会话工作目录之外的真实图片 → BAD_REQUEST（不是"读不到"）', async () => {
    const png = makePng(4, 4)
    await writeFile(join(outside, 'secret.png'), png)
    const tool = makeTool({ ledger: { list: async () => [] } })
    const error = await thrown(() =>
      tool.execute({ prompt: 'x', image: join(outside, 'secret.png') }, makeExec({ cwd: inside })),
    )
    assert.ok(error, '越界路径必须被拒绝')
    assert.equal(error.code, CODES.BAD_REQUEST)
    assert.match(String(error.message), /只允许来自会话工作目录/u)
  })

  await test('image 是"只改扩展名"的文本文件 → 按内容签名拒绝', async () => {
    await writeFile(join(inside, 'fake.png'), 'DASHSCOPE_API_KEY=not-a-real-key\n')
    const tool = makeTool({ ledger: { list: async () => [] } })
    const error = await thrown(() => tool.execute({ prompt: 'x', image: 'fake.png' }, makeExec({ cwd: inside })))
    assert.ok(error, '假图片必须被拒绝')
    assert.equal(error.code, CODES.BAD_REQUEST)
    assert.match(String(error.message), /内容签名/u)
  })

  await test('image 是工作目录内的真 PNG → 通过校验（走到缺 key 才停）', async () => {
    await writeFile(join(inside, 'ok.png'), makePng(4, 4))
    // 故意不给凭据：只要图片校验通过，流程就会停在 MISSING_CREDENTIAL 而不是 BAD_REQUEST。
    const tool = makeTool({ ledger: { list: async () => [] } })
    const error = await thrown(() => tool.execute({ prompt: 'x', image: 'ok.png' }, makeExec({ cwd: inside })))
    assert.ok(error, '本用例没有真 key，应当停在缺 key')
    assert.equal(error.code, CODES.MISSING_CREDENTIAL, '图片校验必须先通过，否则会停在 BAD_REQUEST')
  })

  // ---------------------------------------------------------------- ② 账本 fail-closed
  console.log('\n② 花钱账本 fail-closed')

  await test('sessionSpentOrThrow 走 strict：账本读失败 → UNAVAILABLE，绝不折算成 0 元', async () => {
    const error = await thrown(() =>
      sessionSpentOrThrow({
        getLedger: async () => ({
          list: async (_filter, options) => {
            if (options?.strict === true) throw new Error('账本文件被写坏')
            return []
          },
        }),
        sessionId: 's1',
        providerLabel: '方舟 Ark',
      }),
    )
    assert.ok(error, 'strict 读失败必须抛错')
    assert.equal(error.code, CODES.UNAVAILABLE)
    assert.match(String(error.message), /用量账本读取失败/u)
  })

  await test('sessionSpentOrThrow 正常路径：非有限金额不计入合计', async () => {
    const sum = await sessionSpentOrThrow({
      getLedger: async () => ({ list: async () => [{ amount: 1.5 }, { amount: null }, { amount: 0.25 }] }),
      sessionId: 's1',
      providerLabel: 'X',
    })
    assert.equal(sum, 1.75)
  })

  await test('账本文件损坏：报表口径（lenient）返回空，花钱口径（strict）抛错', async () => {
    const ledgerPath = join(inside, 'ledger-broken.json')
    await writeFile(ledgerPath, '{ this is not json')
    const fake = createFakeCtx({})
    const ledger = await openLedger(fake.ctx, { ledgerPath }, fake.ctx.logger)
    assert.deepEqual(await ledger.list({ sessionId: 's1' }), [], 'lenient 必须不阻塞报表')
    const error = await thrown(() => ledger.list({ sessionId: 's1' }, { strict: true }))
    assert.ok(error, 'strict 必须抛错')
    assert.match(String(error.message), /解析失败/u)
  })

  await test('账本文件不存在 = 空账本（首次运行不该被当成故障）', async () => {
    const fake = createFakeCtx({})
    const ledger = await openLedger(fake.ctx, { ledgerPath: join(inside, 'never-written.json') }, fake.ctx.logger)
    assert.deepEqual(await ledger.list({ sessionId: 's1' }, { strict: true }), [])
  })

  await test('降级到文件后端时，把宿主 storage 文件里的花销并进来对账（否则上限失效）', async () => {
    const dshHome = join(root, 'dshhome')
    await mkdir(join(dshHome, 'storages'), { recursive: true })
    const hostRecord = {
      at: '2026-10-15T13:51:40.000Z',
      adapter: 'ark-video',
      provider: 'Ark',
      model: MODEL,
      unitKind: 'second',
      units: 5,
      unitPrice: 1.519,
      currency: 'CNY',
      amount: 7.595,
      taskId: 'cgt-test-1',
      sessionId: 's1',
    }
    await writeFile(
      join(dshHome, 'storages', 'mm_media_ledger.json'),
      JSON.stringify({ unit: { name: 'mm_media_ledger', version: 1 }, global: null, tables: { usage: { 'k-1': hostRecord } } }),
    )
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    try {
      const fake = createFakeCtx({}) // 没有 storageDomain 服务 → 降级到文件后端
      const fileLedgerPath = join(inside, 'ledger-empty.json')
      const ledger = await openLedger(fake.ctx, { ledgerPath: fileLedgerPath }, fake.ctx.logger)

      const merged = await ledger.list({ sessionId: 's1' }, { strict: true })
      assert.equal(merged.length, 1, 'storage 文件里的记录必须被读出来')
      assert.equal(merged[0].amount, 7.595)

      // 同一条记录同时出现在两个后端时，**不能算两遍钱**。
      await writeFile(fileLedgerPath, JSON.stringify({ version: 1, records: [hostRecord], health: {} }))
      const deduped = await openLedger(fake.ctx, { ledgerPath: fileLedgerPath }, fake.ctx.logger)
      assert.equal((await deduped.list({ sessionId: 's1' }, { strict: true })).length, 1)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  await test('反向对账：降级期写进文件账本的花费，在 storage 恢复后必须仍然看得见', async () => {
    // 上一个用例守的是"降级态别漏掉 storage 里的钱"；这一条守**反方向**：
    // 降级窗口里花掉的钱只落在文件里，若 storage 恢复后不再读文件，那段花费就凭空消失
    // → 会话累计上限被低估，等于留下一条"先制造一次降级、再花钱"的绕过路径（2026-10-17 修）。
    const fileLedgerPath = join(inside, 'ledger-degraded.json')
    const spentWhileDegraded = {
      at: '2026-10-15T13:51:40.000Z',
      adapter: 'ark-video',
      provider: 'Ark',
      model: MODEL,
      unitKind: 'second',
      units: 5,
      unitPrice: 1.519,
      currency: 'CNY',
      amount: 7.595,
      taskId: 'cgt-reverse-1',
      sessionId: 's1',
    }
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'dshhome-reverse')
    try {
      // ① 降级窗口：没有 storageDomain 服务 → 这一笔只落文件账本
      const degraded = createFakeCtx({})
      const fileLedger = await openLedger(degraded.ctx, { ledgerPath: fileLedgerPath }, degraded.ctx.logger)
      assert.equal(await fileLedger.record(spentWhileDegraded), true)

      // ② storage 恢复（同一台机器重新装配后拿到服务）
      const storageDomain = createFakeStorageDomain()
      const recovered = createFakeCtx({ storageDomain })
      const ledger = await openLedger(recovered.ctx, { ledgerPath: fileLedgerPath }, recovered.ctx.logger)

      const visible = await ledger.list({ sessionId: 's1' }, { strict: true })
      assert.equal(visible.length, 1, '降级期的花费不能因为 storage 恢复就消失，否则上限可被降级窗口绕过')
      assert.equal(visible[0].amount, 7.595)

      // ③ 报表口径（lenient）必须与闸门口径（strict）是同一个数：
      //    只让 strict 合并的话，降级态下"闸门看到的已花"和"报表显示的合计"会差一笔钱。
      assert.equal((await ledger.list({ sessionId: 's1' })).length, 1, 'lenient 也必须合并')

      // ④ storage 恢复后新写的花费，与文件里的旧账同时可见、且金额相加正确
      assert.equal(await ledger.record({ ...spentWhileDegraded, taskId: 'cgt-reverse-2', amount: 0.5 }), true)
      const both = await ledger.list({ sessionId: 's1' }, { strict: true })
      assert.equal(both.length, 2)
      // 只断言量级正确，不钉浮点噪声：7.595 + 0.5 在 IEEE754 下是 8.094999999999999。
      const total = both.reduce((sum, row) => sum + row.amount, 0)
      assert.ok(Math.abs(total - 8.095) < 1e-9, '两笔花费必须都在合计里：' + total)

      // ⑤ 同一条记录同时出现在两个后端时**不能算两遍钱**（去重必须跨后端生效）
      await writeFile(
        fileLedgerPath,
        JSON.stringify({ version: 1, records: [{ ...spentWhileDegraded, taskId: 'cgt-reverse-2', amount: 0.5 }], health: {} }),
      )
      const reopened = await openLedger(recovered.ctx, { ledgerPath: fileLedgerPath }, recovered.ctx.logger)
      const deduped = await reopened.list({ sessionId: 's1' }, { strict: true })
      assert.equal(deduped.length, 1, '两个后端各存一份时必须去重，不能算两遍钱')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  await test('amount: null 的 ktoken 记录落账时必须被重算（否则读图花费对会话上限隐形）', async () => {
    // `reader-usage` 写 `amount: null`，语义是"交给账本按 unitKind 计算"。
    // 2026-10-17 之前 `record()` 只认 `undefined`，于是这类记录金额恒为 null，
    // 而 `sessionSpentOrThrow` 用 `Number.isFinite(row.amount)` 汇总 → 读图花费对闸门隐形。
    const ledger = await openLedger(createFakeCtx({}).ctx, { ledgerPath: join(inside, 'ledger-ktoken.json') })
    assert.equal(
      await ledger.record({
        adapter: 'llm-reader',
        provider: 'glm',
        model: 'glm-4.6v',
        unitKind: 'ktoken',
        units: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        inputPrice: 0.001,
        outputPrice: 0.002,
        unitPrice: 0.001,
        currency: 'CNY',
        amount: null,
        sessionId: 's1',
        note: '读图子代理 token：入 1000 / 出 500',
      }),
      true,
    )
    const rows = await ledger.list({ sessionId: 's1' }, { strict: true })
    assert.equal(rows.length, 1)
    // 1000/1000 × 0.001 + 500/1000 × 0.002 = 0.002
    assert.equal(rows[0].amount, 0.002, 'null 金额必须被算出来，否则闸门会按非有限数把它过滤掉')

    // 反向护栏：放行 null 不能把"算不出来"变成 0 —— 0 会让整道闸门失效。
    const unpriced = await openLedger(createFakeCtx({}).ctx, {
      ledgerPath: join(inside, 'ledger-ktoken-unpriced.json'),
    })
    await unpriced.record({
      adapter: 'llm-reader',
      provider: 'glm',
      model: 'glm-4.6v',
      unitKind: 'ktoken',
      units: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      inputPrice: null,
      outputPrice: null,
      unitPrice: null,
      currency: 'CNY',
      amount: null,
      sessionId: 's1',
      note: '未计价',
    })
    assert.equal((await unpriced.list({ sessionId: 's1' }, { strict: true }))[0].amount, null, '未计价必须仍是 null，不能变成 0')
  })

  await test('端到端：账本坏了 → 出片在提交前被拦下，且从未调用厂商', async () => {
    let ran = 0
    const tool = makeTool({
      ledger: {
        list: async (_filter, options) => {
          if (options?.strict === true) throw new Error('账本读不动')
          return []
        },
      },
      credential: { value: 'test-key' }, // 必须有凭据，才能走到"读已花"这一步
      onRun: () => {
        ran += 1
      },
    })
    const error = await thrown(() =>
      tool.execute({ prompt: '一条测试视频', duration: 5, confirm_estimate: 7.60 }, makeExec({ cwd: inside })),
    )
    assert.ok(error, '账本不可读时必须拒绝提交')
    assert.equal(error.code, CODES.UNAVAILABLE)
    assert.equal(ran, 0, '厂商提交必须完全没有发生')
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n[安全不变量] 通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
