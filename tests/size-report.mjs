/**
 * 插件体积报告：模型每请求固定成本 = 工具 schema（name/description/parameters）+ 提示词段落。
 * 用于优化前后对比，也可作为后续防回归的度量。
 * 运行：node --import ./tests/register.mjs ./tests/size-report.mjs
 */
import { apply } from '../index.js'
import { Config } from '../index.js'
import { createFakeCtx } from './fixtures.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function makeConfig(overrides = {}) {
  return new Config({
    dashscopeBase: 'http://127.0.0.1:1/dashscope/api/v1',
    dashscopeCompatBase: 'http://127.0.0.1:1/dashscope/compatible-mode/v1',
    arkBase: 'http://127.0.0.1:1/ark/api/v3',
    ledgerPath: join(__dirname, '_sandbox', 'size-report-ledger.json'),
    ...overrides,
  })
}

function measure(config) {
  const fake = createFakeCtx({ credentials: {} })
  apply(fake.ctx, config)
  const rows = []
  for (const definition of fake.tools) {
    const projected = JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters })
    rows.push({ name: definition.name, chars: projected.length })
  }
  let promptChars = 0
  for (const section of fake.sections) {
    const text = typeof section.text === 'function' ? section.text({}) : section.text
    promptChars += String(text ?? '').length
  }
  return { rows, promptChars, toolChars: rows.reduce((sum, row) => sum + row.chars, 0) }
}

const current = measure(makeConfig())
console.log('工具 schema 固定成本（JSON 字符数）：')
for (const row of current.rows) console.log('  ' + row.name.padEnd(18) + row.chars)
console.log('工具 schema 合计: ' + current.toolChars + ' 字符')
console.log('提示词段落    : ' + current.promptChars + ' 字符')
console.log('每请求固定成本: ' + (current.toolChars + current.promptChars) + ' 字符（5 个工具 + 1 段提示词）')
