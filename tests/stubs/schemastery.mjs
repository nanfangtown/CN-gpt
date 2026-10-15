/**
 * 最小 schemastery 替身（仅当本机找不到真实包时使用）。
 * 支持 Config 需要的最小链式面：role/volatile/description/comment/step/min/max/default。
 * new Config(values) 会合并传入值与各字段 default。
 */
function field() {
  const meta = {}
  const api = {
    role: () => api,
    volatile: () => api,
    description: () => api,
    comment: () => api,
    step: () => api,
    min: () => api,
    max: () => api,
    default: (value) => {
      meta.default = value
      return api
    },
    __default: () => meta.default,
  }
  return api
}

function object(shape) {
  return class Schema {
    constructor(values = {}) {
      for (const [key, schema] of Object.entries(shape)) {
        const provided = values[key]
        if (provided !== undefined && provided !== null) this[key] = provided
        else if (typeof schema.__default === 'function' && schema.__default() !== undefined) this[key] = schema.__default()
      }
      for (const [key, value] of Object.entries(values)) if (this[key] === undefined) this[key] = value
    }
  }
}

const z = { object, string: field, number: field, boolean: field, any: field, dict: field, array: field, unknown: field }
export { z, object }
export default z
