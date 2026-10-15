/**
 * 解压 DSH 的 `session.v4.jsonl.zstd`。
 *
 * 为什么不能直接用 `zlib.zstdDecompressSync(buf)`：这些文件是**多帧拼接**的，
 * 一次性解压只会得到第一帧（实测 1MB 的文件解出 0KB 或几百字节）。所以这里
 * 按魔数逐帧切开、逐帧解压、再拼起来。
 */
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 把多帧 zstd 缓冲解成一个 Buffer。
 * @param {Buffer} buf - 原始文件内容。
 * @returns {Buffer} 解压后的全部内容。
 */
export function inflateAll(buf) {
  if (buf.subarray(0, 4).equals(MAGIC) === false) {
    // 不是 zstd（可能已是明文 jsonl）→ 原样返回
    return buf
  }
  const chunks = []
  let offset = 0
  while (offset < buf.length) {
    let next = buf.indexOf(MAGIC, offset + 4)
    if (next < 0) next = buf.length
    const frame = buf.subarray(offset, next)
    try {
      // Z_SYNC_FLUSH：容忍帧尾没有正式结束标记
      chunks.push(zlib.zstdDecompressSync(frame, { finishFlush: zlib.constants.Z_SYNC_FLUSH }))
    } catch {
      try {
        chunks.push(zlib.zstdDecompressSync(frame))
      } catch {
        // 这一帧解不动就跳过（不因为一帧坏了丢掉整份日志）
      }
    }
    offset = next
  }
  return Buffer.concat(chunks)
}
