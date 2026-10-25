import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AutoEmbedder, BATCH, DaemonEmbedder, FakeEmbedder, LocalEmbedder, MODEL, createServeEmbedder, ensureModel, fakeRequested, hopAllowed, modeFrom, modelDir,
  ortAssets, prefixed, verifiedMarker,
} from '../src/embed.js'
import { DIMS, cosine, toBlob } from '../src/vector.js'

const ENV_KEYS = ['GAZE_EMBEDDER', 'GAZE_CACHE_DIR', 'GAZE_MODEL_BASE', 'GAZE_DATA_DIR', 'GAZE_SOCKET']
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-embed-'))
  process.env.GAZE_DATA_DIR = dir
  process.env.GAZE_CACHE_DIR = path.join(dir, 'cache')
  delete process.env.GAZE_EMBEDDER
  delete process.env.GAZE_MODEL_BASE
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const RUST_FAKE = [
  ['', '2465062c0ce740abb35c44ff2895452330a87a541f298b1440ce9927f126aefb'],
  ['la base usa postgres', '424b3d91e49983785448b4bcd446c1824eeacb6a08013c94f123326f3098510b'],
  ['Postgres PostgreSQL postgres réplica Réplica RÉPLICA', '16bf42179e2794d4dad1b7e2c60996d3a6d6fc0bed5788653a6140a96419d507'],
  ['El cliente pidió los reportes del día cinco 📅 naïve façade Straße', '1ca6a6de240ba3d707478592239d8489a6d228a6ac9d94b703996794cf781108'],
  ['a b c de la el the and for', '2465062c0ce740abb35c44ff2895452330a87a541f298b1440ce9927f126aefb'],
  ['token rotation daemon windows pipe nonce hmac sha256 gaze-ipc-v1 PROJ-123 snake_case camelCase 12345 3.14', 'c5646fcad1570bbc3ecbfa6f56c23bee0d0e4cc52dd254496745436a6cdd273d'],
  ['日本語のテキスト 中文 한국어 русский текст', '9a9d0b29d6bdd3402eef2f0ed776882b432c3995c028925e03d524be8fe555fe'],
]

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

test('fake embedder is bit-identical to the rust FakeEmbedder', async () => {
  const vectors = await new FakeEmbedder().embed(RUST_FAKE.map(([text]) => text), 'passage')
  assert.equal(vectors.length, RUST_FAKE.length)
  vectors.forEach((v, i) => {
    assert.ok(v instanceof Float32Array)
    assert.equal(v.length, DIMS)
    assert.equal(sha256(toBlob(v)), RUST_FAKE[i][1], RUST_FAKE[i][0])
  })
})

test('fake embedder ignores the mode and is normalized', async () => {
  const fake = new FakeEmbedder()
  const [query] = await fake.embed(['la base usa postgres'], 'query')
  const [passage] = await fake.embed(['la base usa postgres'], 'passage')
  assert.deepEqual(query, passage)
  assert.ok(Math.abs(cosine(query, query) - 1) < 1e-6)
  const [empty] = await fake.embed([''], 'query')
  assert.equal(empty[DIMS - 1], 1)
  assert.deepEqual(await fake.embed([], 'query'), [])
})

test('prefixed, modeFrom and fakeRequested follow embed.rs', () => {
  assert.equal(prefixed('hola', 'query'), 'query: hola')
  assert.equal(prefixed('hola', 'passage'), 'passage: hola')
  assert.equal(modeFrom('query'), 'query')
  assert.equal(modeFrom('Query'), 'passage')
  assert.equal(modeFrom(undefined), 'passage')
  assert.equal(fakeRequested(), false)
  process.env.GAZE_EMBEDDER = 'fake'
  assert.equal(fakeRequested(), true)
  process.env.GAZE_EMBEDDER = 'FAKE'
  assert.equal(fakeRequested(), false)
})

function recorder(reply = (message) => ({ ok: true, vectors: message.texts.map(() => [0.5, 0.25]) })) {
  const calls = []
  const request = async (endpoint, message, options) => {
    calls.push({ endpoint, message, options })
    return reply(message)
  }
  return { calls, request }
}

test('daemon embedder sends batches of 32', async () => {
  const { calls, request } = recorder()
  const texts = Array.from({ length: 70 }, (_, i) => `t${i}`)
  const vectors = await new DaemonEmbedder({ endpoint: 'ep', timeoutMs: 5000, request }).embed(texts, 'passage')
  assert.equal(BATCH, 32)
  assert.equal(vectors.length, 70)
  assert.ok(vectors.every((v) => v instanceof Float32Array && v[0] === 0.5 && v[1] === 0.25))
  assert.deepEqual(calls.map((c) => c.message.texts.length), [32, 32, 6])
  assert.deepEqual(calls[0].message, { op: 'embed', mode: 'passage', texts: texts.slice(0, 32) })
  assert.ok(calls.every((c) => c.endpoint === 'ep' && c.options.timeoutMs === 5000))
})

test('daemon embedder rejects a vector count mismatch and skips empty input', async () => {
  const { calls, request } = recorder(() => ({ ok: true, vectors: [[1]] }))
  const daemon = new DaemonEmbedder({ endpoint: 'ep', request })
  await assert.rejects(daemon.embed(['a', 'b'], 'query'), { message: 'daemon returned 1 vectors for 2 texts' })
  assert.deepEqual(await daemon.embed([], 'query'), [])
  assert.equal(calls.length, 1)
})

test('auto embedder uses the fake when requested', async () => {
  process.env.GAZE_EMBEDDER = 'fake'
  const { calls, request } = recorder()
  const auto = new AutoEmbedder({ request, loadLocal: () => assert.fail('local loaded') })
  const [v] = await auto.embed(['la base usa postgres'], 'query')
  assert.equal(sha256(toBlob(v)), RUST_FAKE[1][1])
  assert.equal(calls.length, 0)
  assert.ok((await createServeEmbedder()) instanceof FakeEmbedder)
})

test('auto embedder prefers the daemon', async () => {
  const { calls, request } = recorder()
  let down = 0
  const auto = new AutoEmbedder({ request, onDaemonDown: () => down++, loadLocal: () => assert.fail('local loaded') })
  assert.equal((await auto.embed(['a'], 'query')).length, 1)
  assert.equal(calls.length, 1)
  assert.equal(down, 0)
})

test('auto embedder without local rethrows the daemon error after the hook', async () => {
  const failure = new Error('connect failed')
  let down = 0
  const auto = new AutoEmbedder({ allowLocal: false, request: async () => { throw failure }, onDaemonDown: () => down++, loadLocal: () => assert.fail('local loaded') })
  await assert.rejects(auto.embed(['a'], 'query'), (error) => error === failure)
  assert.equal(down, 1)
})

test('auto embedder loads the local model once and keeps using it', async () => {
  let loads = 0
  let remote = 0
  const local = { embed: async (texts) => texts.map(() => new Float32Array(DIMS)) }
  const auto = new AutoEmbedder({
    request: async () => {
      remote++
      throw new Error('down')
    },
    onDaemonDown: () => { throw new Error('spawn failed') },
    loadLocal: async () => {
      loads++
      return local
    },
  })
  const [first, second] = await Promise.all([auto.embed(['a'], 'query'), auto.embed(['b', 'c'], 'query')])
  assert.equal(first.length, 1)
  assert.equal(second.length, 2)
  assert.equal((await auto.embed(['d'], 'passage')).length, 1)
  assert.equal(loads, 1)
  assert.equal(remote, 2)
})

test('auto embedder caches a failed local load', async () => {
  let loads = 0
  const auto = new AutoEmbedder({
    request: async () => { throw new Error('down') },
    loadLocal: async () => {
      loads++
      throw new Error('model load failed: offline')
    },
  })
  await assert.rejects(auto.embed(['a'], 'query'), { message: 'model load failed: offline' })
  await assert.rejects(auto.embed(['a'], 'query'), { message: 'model load failed: offline' })
  assert.equal(loads, 1)
})

test('only https on huggingface.co and its CDN is allowed by default', () => {
  for (const url of [
    'https://huggingface.co/x', 'https://us.aws.cdn.hf.co/x', 'https://eu.aws.cdn.hf.co/x', 'https://cas-bridge.xethub.hf.co/x', 'https://cdn-lfs.hf.co/x',
    'https://cdn-lfs-us-1.hf.co/x', 'https://cdn-lfs.huggingface.co/x',
  ]) assert.equal(hopAllowed(url, false), true, url)
  for (const url of [
    'http://huggingface.co/x', 'https://evil.com/x', 'https://huggingface.co.evil.com/x', 'https://cdn.hf.co.evil.com/x', 'https://evilcdn.hf.co/x',
    'https://cdn.hf.co/x', 'https://user:pass@huggingface.co/x', 'https://hf.co/x',
  ]) assert.equal(hopAllowed(url, false), false, url)
  assert.equal(hopAllowed('http://127.0.0.1:9/x', true), true)
  assert.equal(hopAllowed('http://localhost:9/x', true), true)
  assert.equal(hopAllowed('http://10.0.0.1/x', true), false)
  assert.equal(hopAllowed('https://mirror.example/x', true), true)
})

test('the pinned model matches the contract', () => {
  assert.equal(MODEL.repo, 'Xenova/multilingual-e5-small')
  assert.equal(MODEL.revision, '761b726dd34fb83930e26aab4e9ac3899aa1fa78')
  assert.equal(MODEL.files['onnx/model_quantized.onnx'].sha256, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193')
  assert.equal(MODEL.files['tokenizer.json'].sha256, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39')
  assert.match(MODEL.files['tokenizer_config.json'].sha256, /^[0-9a-f]{64}$/)
  assert.equal(modelDir(), path.join(dir, 'cache', 'models', 'Xenova--multilingual-e5-small', MODEL.revision))
})

function fakeModel(files) {
  return {
    repo: 'test/model',
    revision: 'abc123',
    onnx: 'onnx/model.onnx',
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { size: data.length, sha256: sha256(data) }])),
  }
}

async function hfServer(files, route) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    if (route?.(req, res)) return
    const prefix = '/test/model/resolve/abc123/'
    const name = req.url.startsWith(prefix) ? decodeURIComponent(req.url.slice(prefix.length)) : null
    if (name === null || !(name in files)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-length': files[name].length }).end(files[name])
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.GAZE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`
  return { hits, close: () => new Promise((resolve) => server.close(resolve)) }
}

const FILES = { 'onnx/model.onnx': Buffer.from('fake onnx bytes'), 'tokenizer.json': Buffer.from('{"tokenizer":true}'), 'tokenizer_config.json': Buffer.from('{}') }

test('ensureModel downloads once, verifies and marks every file', async () => {
  const model = fakeModel(FILES)
  const server = await hfServer(FILES)
  try {
    const target = await ensureModel({ model })
    assert.equal(target, path.join(dir, 'cache', 'models', 'test--model', 'abc123'))
    for (const [name, data] of Object.entries(FILES)) {
      const file = path.join(target, ...name.split('/'))
      assert.deepEqual(fs.readFileSync(file), data)
      const mark = JSON.parse(fs.readFileSync(verifiedMarker(file), 'utf8'))
      assert.equal(mark.sha256, sha256(data))
      assert.equal(mark.size, data.length)
    }
    assert.ok(fs.existsSync(path.join(target, 'onnx', '.model.onnx.verified')))
    assert.deepEqual(fs.readdirSync(target).sort(), ['.tokenizer.json.verified', '.tokenizer_config.json.verified', 'onnx', 'tokenizer.json', 'tokenizer_config.json'])
    assert.equal(server.hits.length, 3)
    await ensureModel({ model })
    assert.equal(server.hits.length, 3)
  } finally {
    await server.close()
  }
})

test('ensureModel fails on a checksum mismatch and leaves nothing behind', async () => {
  const model = fakeModel(FILES)
  const server = await hfServer({ ...FILES, 'tokenizer.json': Buffer.from('{"tampered":true}') })
  try {
    await assert.rejects(ensureModel({ model }), /Checksum mismatch for http:\/\/127\.0\.0\.1:\d+\/test\/model\/resolve\/abc123\/tokenizer\.json/)
    assert.equal(fs.existsSync(path.join(modelDir(model), 'tokenizer.json')), false)
    assert.equal(fs.existsSync(path.join(modelDir(model), '.tokenizer.json.verified')), false)
  } finally {
    await server.close()
  }
})

test('ensureModel replaces a stale corrupt file and trusts a valid unmarked one', async () => {
  const model = fakeModel(FILES)
  const target = modelDir(model)
  fs.mkdirSync(path.join(target, 'onnx'), { recursive: true })
  const onnx = path.join(target, 'onnx', 'model.onnx')
  fs.writeFileSync(onnx, 'corrupt')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(onnx, old, old)
  fs.writeFileSync(path.join(target, 'tokenizer.json'), FILES['tokenizer.json'])
  const server = await hfServer(FILES)
  try {
    await ensureModel({ model })
    assert.deepEqual(fs.readFileSync(onnx), FILES['onnx/model.onnx'])
    assert.deepEqual(server.hits.map((hit) => hit.split('/').pop()).sort(), ['model.onnx', 'tokenizer_config.json'])
    assert.ok(fs.existsSync(verifiedMarker(path.join(target, 'tokenizer.json'))))
  } finally {
    await server.close()
  }
})

test('ensureModel waits for a concurrent writer that is still writing', async () => {
  const model = fakeModel(FILES)
  const target = modelDir(model)
  fs.mkdirSync(path.join(target, 'onnx'), { recursive: true })
  const onnx = path.join(target, 'onnx', 'model.onnx')
  fs.writeFileSync(onnx, 'fake')
  const finish = setTimeout(() => fs.writeFileSync(onnx, FILES['onnx/model.onnx']), 400)
  const server = await hfServer(FILES)
  try {
    await ensureModel({ model })
    assert.deepEqual(fs.readFileSync(onnx), FILES['onnx/model.onnx'])
    assert.ok(fs.existsSync(verifiedMarker(onnx)))
  } finally {
    clearTimeout(finish)
    await server.close()
  }
})

test('parallel ensureModel calls converge on one verified copy', async () => {
  const model = fakeModel(FILES)
  const server = await hfServer(FILES)
  try {
    const dirs = await Promise.all([ensureModel({ model }), ensureModel({ model }), ensureModel({ model })])
    assert.ok(dirs.every((d) => d === modelDir(model)))
    for (const [name, data] of Object.entries(FILES)) assert.deepEqual(fs.readFileSync(path.join(modelDir(model), ...name.split('/'))), data)
  } finally {
    await server.close()
  }
})

test('ensureModel refuses redirects off the allowed hosts and long redirect chains', async () => {
  const model = fakeModel(FILES)
  const server = await hfServer(FILES, (req, res) => {
    if (req.url.endsWith('/tokenizer.json')) {
      res.writeHead(302, { location: 'http://example.invalid/tokenizer.json' }).end()
      return true
    }
    if (req.url.includes('/loop')) {
      res.writeHead(307, { location: `/loop${req.url.length}` }).end()
      return true
    }
    if (req.url.endsWith('/tokenizer_config.json')) {
      res.writeHead(307, { location: '/loop' }).end()
      return true
    }
    return false
  })
  try {
    await assert.rejects(ensureModel({ model }), /Refusing to download from http:\/\/example\.invalid\/tokenizer\.json/)
    await assert.rejects(ensureModel({ model: { ...model, files: { 'tokenizer_config.json': model.files['tokenizer_config.json'] } } }), /more than 3 redirects/)
  } finally {
    await server.close()
  }
})

test('GAZE_MODEL_BASE must be https or loopback http', async () => {
  process.env.GAZE_MODEL_BASE = 'http://mirror.example'
  await assert.rejects(ensureModel({ model: fakeModel(FILES) }), /GAZE_MODEL_BASE must use https/)
  process.env.GAZE_MODEL_BASE = 'not a url'
  await assert.rejects(ensureModel({ model: fakeModel(FILES) }), /GAZE_MODEL_BASE is not a valid URL/)
})

test('local load failures carry the rust prefix', async () => {
  const server = await hfServer({})
  try {
    await assert.rejects(LocalEmbedder.load({ model: fakeModel(FILES) }), /^Error: model load failed: Cannot download/)
  } finally {
    await server.close()
  }
})

function walk(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

test('the onnxruntime wasm ships inside node_modules and no native addon is installed', () => {
  const modules = path.join(PACKAGE, 'node_modules')
  const { wasm, mjs } = ortAssets()
  for (const file of [wasm, mjs]) {
    assert.ok(file.startsWith(path.join(modules, 'onnxruntime-web', 'dist')), file)
    assert.ok(fs.statSync(file).size > 0)
  }
  assert.deepEqual(walk(modules).filter((file) => /\.(node|dll)$/i.test(file)), [])
})

const withModel = process.env.GAZE_TEST_MODEL === '1'

test('local model matches the fastembed reference', { skip: !withModel && 'set GAZE_TEST_MODEL=1', timeout: 600_000 }, async (t) => {
  if (saved.GAZE_CACHE_DIR === undefined) delete process.env.GAZE_CACHE_DIR
  else process.env.GAZE_CACHE_DIR = saved.GAZE_CACHE_DIR
  let started = performance.now()
  await ensureModel()
  t.diagnostic(`ensureModel ${(performance.now() - started).toFixed(0)} ms in ${modelDir()}`)
  const realFetch = globalThis.fetch
  const realDlopen = process.dlopen
  globalThis.fetch = async (url) => assert.fail(`network access during model load: ${url}`)
  process.dlopen = (module, file) => assert.fail(`native addon loaded: ${file}`)
  let local
  try {
    started = performance.now()
    local = await LocalEmbedder.load()
    t.diagnostic(`load ${(performance.now() - started).toFixed(0)} ms`)
    const reference = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'test', 'fixtures', 'e5-reference.json'), 'utf8'))
    assert.equal(reference.texts.length, 5)
    for (const mode of ['query', 'passage']) {
      const vectors = await local.embed(reference.texts, mode)
      const scores = vectors.map((v, i) => cosine(v, reference[mode][i]))
      t.diagnostic(`${mode} cosine ${scores.map((s) => s.toFixed(5)).join(' ')}`)
      for (const score of scores) assert.ok(score >= 0.98, `${mode} cosine ${score}`)
      for (const v of vectors) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5)
    }
    const many = await local.embed(Array.from({ length: 40 }, (_, i) => `texto ${i}`), 'passage')
    assert.equal(many.length, 40)
    await local.embed(['calentamiento'], 'query')
    const samples = []
    for (let i = 0; i < 10; i++) {
      started = performance.now()
      await local.embed([`¿cómo se rota el token del daemon en Windows? ${i}`], 'query')
      samples.push(performance.now() - started)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)]
    t.diagnostic(`warm query latency median ${median.toFixed(1)} ms, max ${samples.at(-1).toFixed(1)} ms`)
    assert.ok(median < 150, `median ${median} ms`)
  } finally {
    globalThis.fetch = realFetch
    process.dlopen = realDlopen
  }
})
