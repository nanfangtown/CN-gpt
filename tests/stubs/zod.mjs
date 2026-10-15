/** 测试替身：够用的 zod 链式桩（只要求不抛错、可链式调用）。 */
function makeSchema() {
  const schema = {
    optional: () => makeSchema(),
    nullable: () => makeSchema(),
    default: () => makeSchema(),
    safeParse: () => ({ success: true }),
  }
  return schema
}
export const z = {
  object: () => makeSchema(),
  string: () => makeSchema(),
  number: () => makeSchema(),
  boolean: () => makeSchema(),
  unknown: () => makeSchema(),
  any: () => makeSchema(),
}
export default z
