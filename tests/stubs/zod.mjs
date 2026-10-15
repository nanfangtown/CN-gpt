/**
 * 测试替身：够用的 zod 链式桩（只要求不抛错、可链式调用）。
 *
 * 2026-10-15 增强：额外**保留 `kind` / `isNullable` / `shape`** 三点信息。
 *
 * 为什么必须保留：账本 schema 原本把 `unitPrice` / `amount` 写成 `z.number()`，
 * 而写入方写的是 `null`（未计价）——一条这样的记录就让整个 storage 领域 open()
 * 失败、静默退回空 JSON 账本，报表里历史用量凭空消失（数据其实还在磁盘上）。
 * 原来这个替身把 `z.number()` 与 `z.number().nullable()` 返回成**完全一样**的桩，
 * 于是"schema 放不放行 null"在离线套件里根本无法断言，缺陷因此溜了过去。
 * 现在替身带着这三点信息，离线用例才能真正钉住它。
 */
function makeSchema(kind, meta = {}) {
  const schema = {
    kind,
    /** 是否调过 .nullable()（属性名不能叫 nullable，否则与方法名冲突）。 */
    isNullable: meta.isNullable === true,
    /** z.object() 的字段表，供测试检查各字段的严格程度。 */
    shape: meta.shape,
    optional: () => makeSchema(kind, { ...meta, optional: true }),
    nullable: () => makeSchema(kind, { ...meta, isNullable: true }),
    default: () => makeSchema(kind, { ...meta, hasDefault: true }),
    safeParse: () => ({ success: true }),
    parse: (value) => value,
  }
  return schema
}
export const z = {
  object: (shape) => makeSchema('object', { shape }),
  string: () => makeSchema('string'),
  number: () => makeSchema('number'),
  boolean: () => makeSchema('boolean'),
  unknown: () => makeSchema('unknown'),
  any: () => makeSchema('any'),
}
export default z
