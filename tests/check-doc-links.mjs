/**
 * 文档相对链接校验：保证 README / docs / CONTRIBUTING 里的 `[文字](路径)` 不是死链。
 *
 * 只检查**仓库内的相对路径**：http(s) / mailto / 纯锚点 一律跳过（不联网、不引入依赖）。
 * 代码块（``` 围栏）里的示例链接也跳过，避免把示例当真实链接。
 *
 * 为什么放 CI：这次开源整理把 130 KB 的旧 README 迁到 docs/ 下，跨目录链接最容易漏改；
 * 一个 20 行的检查比人工点 60 个链接可靠。
 *
 * 运行：node tests/check-doc-links.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['.git', 'node_modules', '_sandbox', 'gen'])

/** 需要检查的 Markdown 文件：根目录的公开文档 + docs/ 下的全部文件。 */
function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectMarkdown(full, out)
    } else if (entry.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

const files = collectMarkdown(ROOT).filter((file) => {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  // 开发期的历史报告/试运行记录也检查，但链接可能指向已迁移的文件——这正是要抓的。
  return !rel.startsWith('_sandbox/') && !rel.startsWith('gen/')
})

/** 去掉围栏代码块，避免把代码里的 Markdown 示例当成链接。 */
function stripFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '')
}

/** `](target)`，允许目标里带尖括号与空格。 */
const LINK_RE = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g

const problems = []
let checked = 0
for (const file of files) {
  const text = stripFences(readFileSync(file, 'utf8'))
  for (const match of text.matchAll(LINK_RE)) {
    let target = match[1]
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    if (/^(https?:|mailto:|tel:|#)/i.test(target)) continue
    if (target.startsWith('data:')) continue
    const clean = target.split('#')[0].split('?')[0]
    if (clean.length === 0) continue
    checked += 1
    const absolute = resolve(dirname(file), decodeURIComponent(clean))
    if (!existsSync(absolute)) {
      problems.push(`${relative(ROOT, file)} → ${target}`)
    }
  }
}

for (const problem of problems) console.error('✗ 死链: ' + problem)
console.log(`[docs] 检查 ${files.length} 个 Markdown 文件、${checked} 个相对链接，断链 ${problems.length} 个`)
process.exit(problems.length === 0 ? 0 : 1)
