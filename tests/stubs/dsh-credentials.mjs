/** 测试替身：credentialRef 只做 POSIX 标识符校验并加前缀。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export function credentialRef(value) {
  if (!REF_PATTERN.test(value)) throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  return `ref:${value}`
}
export function isCredentialRefName(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}
