import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIMS, cosine, dot, fromBlob, normalize, toBlob } from '../src/vector.js'

function rustNormalize(values) {
  const v = new Float32Array(values)
  const sq = new Float32Array(1)
  for (const x of v) {
    const p = new Float32Array([x * x])[0]
    sq[0] = sq[0] + p
  }
  const n = new Float32Array([Math.sqrt(sq[0])])[0]
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i] / n
  return v
}

test('dims match the e5 small model', () => {
  assert.equal(DIMS, 384)
})

test('normalize works in f32 arithmetic and leaves zero vectors alone', () => {
  const v = new Float32Array(DIMS)
  v[3] = 2
  v[7] = 1
  v[383] = Math.fround(0.01)
  const n = normalize(v)
  assert.ok(n instanceof Float32Array)
  assert.deepEqual([...n], [...rustNormalize(v)])
  assert.equal(n[3], Math.fround(2 / Math.fround(Math.sqrt(Math.fround(Math.fround(4 + 1) + Math.fround(Math.fround(0.01) * Math.fround(0.01)))))))
  assert.deepEqual([...normalize(new Float32Array(4))], [0, 0, 0, 0])
  assert.equal(v[3], 2)
  const random = Float32Array.from({ length: DIMS }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1)
  assert.deepEqual([...normalize(random)], [...rustNormalize(random)])
  const norm = Math.sqrt(dot(normalize(random), normalize(random)))
  assert.ok(Math.abs(norm - 1) < 1e-6)
})

test('cosine is dot over the norms in double', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([2, 0], [5, 0]), 1)
  assert.ok(Math.abs(cosine([1, 2, 3], [4, 5, 6]) - 32 / (Math.sqrt(14) * Math.sqrt(77))) < 1e-15)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.equal(dot([1, 2], [3, 4]), 11)
})

test('blobs are little-endian f32 and survive unaligned buffers', () => {
  const v = Float32Array.from([1, -2.5, Math.fround(0.1), 0])
  const blob = toBlob(v)
  assert.equal(blob.length, 16)
  assert.deepEqual([...blob.subarray(0, 4)], [0x00, 0x00, 0x80, 0x3f])
  assert.deepEqual([...fromBlob(blob)], [...v])
  const shifted = Buffer.alloc(17)
  blob.copy(shifted, 1)
  const unaligned = shifted.subarray(1)
  assert.notEqual(unaligned.byteOffset % 4, 0)
  const back = fromBlob(unaligned)
  assert.ok(back instanceof Float32Array)
  assert.deepEqual([...back], [...v])
  assert.deepEqual([...fromBlob(toBlob([3, 4]))], [3, 4])
})
