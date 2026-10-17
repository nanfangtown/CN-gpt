/**
 * 三把 key 的解析、状态描述与优先级（规划 [4]）。
 *
 * 取值优先级（与官方 dsh-web-search-deepseek 一致）：
 *   字面值（secret 字段）  >  引用名（credential-ref → ctx.credentials → 环境变量）
 *
 * 只读状态（describe）永远不返回值本身，只回答"是否已配置 / 来自哪里 / 能否写入"。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** 三把 key 的固定引用名与归属（规划 [4.4]）。 */
export const KEY_SPECS = Object.freeze([
  Object.freeze({
    id: 'dashscope',
    ref: 'DASHSCOPE_API_KEY',
    literalField: 'dashscopeApiKey',
    envField: 'dashscopeApiKeyEnv',
    label: '阿里云百炼 DashScope API Key',
    usage: 'qwen_draw 制图；ask_qwen 读图（llm-pi-ai providers.qwen-vl 共用同一把 key）',
    settingsWhere: '插件页 → gpt-CN → 配置卡',
    capability: 'qwen_draw',
  }),
  Object.freeze({
    id: 'ark',
    ref: 'ARK_API_KEY',
    literalField: 'arkApiKey',
    envField: 'arkApiKeyEnv',
    label: '火山方舟 Volcengine Ark API Key',
    usage: '仅 seedance_video 出片使用',
    settingsWhere: '插件页 → gpt-CN → 配置卡',
    capability: 'seedance_video',
  }),
  Object.freeze({
    id: 'zhipu',
    ref: 'ZHIPU_API_KEY',
    literalField: 'zhipuApiKey',
    envField: 'zhipuApiKeyEnv',
    label: '智谱 API Key',
    usage: '仅 ask_glm 读图使用',
    settingsWhere: '设置 → 模型 → GLM 行',
    capability: 'ask_glm',
  }),
  // 百炼视频（可灵 / 万相）与 qwen_draw 共用同一把 DASHSCOPE_API_KEY：
  // 单独成行只为让健康报告能独立报出"出片"这一行。
  // ⚠ 它额外需要"业务空间 ID"（dashscopeWorkspaceId）——那是**配置**不是密钥，
  //   所以不在 KEY_SPECS 里；缺它时 video_gen 会 fail-closed 并指名去配置卡填。
  Object.freeze({
    id: 'dashscope-video',
    ref: 'DASHSCOPE_API_KEY',
    literalField: 'dashscopeApiKey',
    envField: 'dashscopeApiKeyEnv',
    label: '阿里云百炼 DashScope API Key（可灵 / 万相 出片）',
    usage: '仅 video_gen 出片使用（与 qwen_draw 共用 DASHSCOPE_API_KEY；另需业务空间 ID）',
    settingsWhere: '插件页 → gpt-CN → 配置卡',
    capability: 'dashscope_video',
  }),
  // DashScope 同一把 key 也供 ask_qwen 的 qwen-vl 路由使用：
  // 单独成行只为让健康报告能独立报出"读图子代理"这一行，不额外要求第四把 key。
  Object.freeze({
    id: 'dashscope-vl',
    ref: 'DASHSCOPE_API_KEY',
    literalField: 'dashscopeApiKey',
    envField: 'dashscopeApiKeyEnv',
    label: '阿里云百炼 DashScope API Key（Qwen-VL 读图）',
    usage: '仅 ask_qwen 读图使用（与 qwen_draw 共用 DASHSCOPE_API_KEY）',
    settingsWhere: '插件页 → gpt-CN → 配置卡',
    capability: 'ask_qwen',
  }),
])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 按 ref 取 spec。 */
export function keySpec(id) {
  const spec = KEY_SPECS.find((entry) => entry.id === id)
  if (spec === undefined) throw new Error(`unknown key spec: ${id}`)
  return spec
}

/**
 * 创建 key 解析器。凭据服务按"每次操作解析"读取，因此轮换 key 无需重启。
 * @param {object} ctx - 插件上下文（用 ctx.get('credentials') 可选取服务）。
 * @param {object} config - 插件 Config。
 */
export function createKeyResolver(ctx, config) {
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  const refNameOf = (spec) => nonEmptyString(config[spec.envField]) ?? spec.ref

  return {
    /** 解析出可用于请求的 key；返回 { value, source, ref } 或 undefined。 */
    async resolve(spec) {
      const literal = nonEmptyString(config[spec.literalField])
      const refName = refNameOf(spec)
      if (literal !== undefined) return { value: literal, source: 'literal', ref: refName }
      if (credentials !== undefined) {
        try {
          const hit = await credentials.resolve(credentialRef(refName))
          const value = nonEmptyString(hit?.value)
          if (value !== undefined) return { value, source: hit?.source ?? 'credentials', ref: refName }
        } catch {
          // 引用名非法或凭据服务故障 → 退回环境变量，稍后以"未配置"呈现。
        }
      }
      const fromEnv = nonEmptyString(process.env[refName])
      if (fromEnv !== undefined) return { value: fromEnv, source: 'environment', ref: refName }
      return undefined
    },

    /** 只读状态，绝不返回值。 */
    async describe(spec) {
      const refName = refNameOf(spec)
      const literal = nonEmptyString(config[spec.literalField])
      if (literal !== undefined) return { ref: refName, configured: true, source: 'literal', writable: true }
      if (credentials !== undefined) {
        try {
          const info = await credentials.describe(credentialRef(refName))
          return { ref: refName, configured: info?.configured === true, source: info?.source, writable: info?.writable === true }
        } catch {
          // 落到环境变量检查。
        }
      }
      return { ref: refName, configured: nonEmptyString(process.env[refName]) !== undefined, source: 'environment', writable: false }
    },

    /** 三把 key 的状态快照。 */
    async describeAll() {
      const entries = await Promise.all(
        KEY_SPECS.map(async (spec) => ({ spec, status: await this.describe(spec) })),
      )
      return entries
    },
  }
}
