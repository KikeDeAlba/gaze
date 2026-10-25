export const DIMS = 384

export function normalize(v) {
  const out = Float32Array.from(v)
  let s = 0
  for (const x of out) s = Math.fround(s + Math.fround(x * x))
  const n = Math.fround(Math.sqrt(s))
  if (n > 0) for (let i = 0; i < out.length; i++) out[i] = Math.fround(out[i] / n)
  return out
}

export function dot(a, b) {
  const len = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < len; i++) s += a[i] * b[i]
  return s
}

export function cosine(a, b) {
  const denominator = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b))
  return denominator > 0 ? dot(a, b) / denominator : 0
}

export function toBlob(v) {
  const f = v instanceof Float32Array ? v : Float32Array.from(v)
  const buf = Buffer.alloc(f.length * 4)
  for (let i = 0; i < f.length; i++) buf.writeFloatLE(f[i], i * 4)
  return buf
}

export function fromBlob(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const count = Math.floor(bytes.byteLength / 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 4)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}
