/**
 * 试运行专用模块解析钩子：
 *   - @deepseek-ai/dsh-tools / @deepseek-ai/dsh-credentials 走测试替身；
 *   - @deepseek-ai/schemastery 优先用真实包（desktop profile 的 node_modules），
 *     否则回退到最小替身。
 * 用法：node --import ./tests/register.mjs ./tests/run.mjs
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = new URL('.', import.meta.url)
/** 包根目录（tests/ 的上一级）。CI 全新 clone 时，真 schemastery 装在这里的 node_modules。 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const map = {
  '@deepseek-ai/dsh-tools': new URL('./stubs/dsh-tools.mjs', here).href,
  '@deepseek-ai/dsh-credentials': new URL('./stubs/dsh-credentials.mjs', here).href,
  '@deepseek-ai/dsh-storage-domain': new URL('./stubs/dsh-storage-domain.mjs', here).href,
  zod: new URL('./stubs/zod.mjs', here).href,
}

const home = homedir()
const candidates = [
  process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'node_modules/@deepseek-ai/schemastery/lib/index.js'),
  // CI / 全新 clone：`npm install` 把真包装在仓库自己的 node_modules 下。
  // 早期只找 desktop profile，于是 CI 里永远走"找不到真包"分支、被
  // DSH_REQUIRE_REAL_SCHEMASTERY=1 直接判失败 —— 2026-10-19 首次真实 CI 跑出来的。
  join(packageRoot, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  join(packageRoot, 'node_modules/@deepseek-ai/schemastery/lib/index.js'),
  join(home, '.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  join(home, '.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.js'),
].filter(Boolean)
const schemastery = candidates.find((path) => existsSync(path))

/**
 * 本次运行用的是真 schemastery，还是最小替身？
 *
 * 为什么要把这件事显式化（2026-10-13 审计）：替身把 `.volatile() / .role() /
 * .step() / .min()` 全部实现成 no-op，而生产里 `.volatile()` 会让字段变成引用
 * 对象 `{ get() }`，`index.js` 必须用 liveConfig Proxy 解包。实测：强制走替身时
 * 整个套件**照样 59/59 全绿** —— 也就是说 CI（全新 clone，一定没有 desktop
 * profile）验证的是一套与生产不同的 Config 语义，而 volatile/role 类回归永远
 * 抓不到（那正是 run.mjs 注释里承认踩过的坑）。
 *
 * 因此：把选择结果导出，让测试能断言"到底跑在哪种语义上"；
 * CI 里装真包 + `DSH_REQUIRE_REAL_SCHEMASTERY=1`，缺了就直接失败而不是静默降级。
 */
export const schemaSemantics = schemastery === undefined ? 'stub' : 'real'
// 真包要在 Windows 上转成 file:// URL（裸 "D:\..." 会被 ESM loader 拒绝）。
export const schemaSemanticsSource = schemastery === undefined ? new URL('./stubs/schemastery.mjs', here).href : pathToFileURL(schemastery).href

if (schemastery === undefined && (process.env.DSH_REQUIRE_REAL_SCHEMASTERY ?? '').trim() === '1') {
  console.error(
    '[register] DSH_REQUIRE_REAL_SCHEMASTERY=1 但找不到真实的 @deepseek-ai/schemastery：\n' +
      '  期望路径之一：' + candidates.join('\n              ') + '\n' +
      '  继续跑只会拿最小替身（.volatile()/.role() 全为 no-op），测的语义与生产不一致。\n' +
      '  请先安装依赖，或显式取消该环境变量以接受替身。',
  )
  process.exit(1)
}

map['@deepseek-ai/schemastery'] = schemaSemanticsSource

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(map, specifier)) return { url: map[specifier], shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
