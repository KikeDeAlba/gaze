import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { errorChain } from './envelope.js'
import { endpointFor, request as ipcRequest } from './ipc.js'
import { modelsDir, socketPath } from './paths.js'
import { terms } from './text.js'
import { DIMS, normalize } from './vector.js'

export const BATCH = 32
export const MAX_TOKENS = 512

export const MODEL = {
  repo: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  onnx: 'onnx/model_quantized.onnx',
  files: {
    'onnx/model_quantized.onnx': { size: 118308185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
    'tokenizer.json': { size: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
    'tokenizer_config.json': { size: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
  },
}

export const DEFAULT_MODEL_BASE = 'https://huggingface.co'
export const HF_HOSTS = new Set(['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co', 'cas-bridge.xethub.hf.co'])
const HF_HOST_SUFFIXES = ['.cdn.hf.co']
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3
const MAX_BYTES = 200 * 1024 * 1024
const ATTEMPTS = 3
const TIMEOUT_MS = 120_000
const SETTLE_MS = 2000
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES'])
const BUSY_ATTEMPTS = 5
const BUSY_DELAY_MS = 200
const FNV_OFFSET = 1469598103934665603n
const FNV_PRIME = 1099511628211n
const U64 = 0xFFFFFFFFFFFFFFFFn
const BUCKETS = BigInt(DIMS)
const BIAS = Math.fround(0.01)

export const prefixed = (text, mode) => `${mode}: ${text}`
export const fakeRequested = () => process.env.GAZE_EMBEDDER === 'fake'
export const modeFrom = (value) => (value === 'query' ? 'query' : 'passage')

function fakeVector(text) {
  const v = new Float32Array(DIMS)
  for (const term of terms(text)) {
    let h = FNV_OFFSET
    for (const b of Buffer.from(term, 'utf8')) {
      h ^= BigInt(b)
      h = (h * FNV_PRIME) & U64
    }
    v[Number(h % BUCKETS)] += 1
  }
  v[DIMS - 1] = v[DIMS - 1] + BIAS
  return normalize(v)
}

export class FakeEmbedder {
  async embed(texts) {
    return texts.map(fakeVector)
  }
}

class DownloadError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'DownloadError'
  }
}

class NetworkError extends DownloadError {
  constructor(message, options) {
    super(message, options)
    this.name = 'NetworkError'
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function redactUrl(url) {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url
    return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return '<invalid URL>'
  }
}

function redactText(text) {
  return String(text).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, (match) => redactUrl(match))
}

export function hfHost(hostname) {
  return HF_HOSTS.has(hostname) || HF_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length)
}

export function hopAllowed(url, custom) {
  const target = typeof url === 'string' ? new URL(url) : url
  if (target.username !== '' || target.password !== '') return false
  if (custom) return target.protocol === 'https:' || (target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname))
  return target.protocol === 'https:' && hfHost(target.hostname)
}

export function modelBase(env = process.env) {
  const custom = env.GAZE_MODEL_BASE
  if (!custom) return { base: DEFAULT_MODEL_BASE, custom: false }
  let url
  try {
    url = new URL(custom)
  } catch {
    throw new DownloadError('GAZE_MODEL_BASE is not a valid URL')
  }
  if (!hopAllowed(url, true)) throw new DownloadError(`GAZE_MODEL_BASE must use https (plain http is only allowed for 127.0.0.1 and localhost): ${redactUrl(url)}`)
  return { base: custom.replace(/\/+$/, ''), custom: true }
}

export function modelUrl(base, model, file) {
  return `${base}/${model.repo}/resolve/${model.revision}/${file}`
}

function retryable(status) {
  return status === 408 || status === 429 || status >= 500
}

async function readCapped(response, url, limit) {
  const declared = Number(response.headers.get('content-length'))
  if (declared > limit) throw new DownloadError(`${redactUrl(url)} is ${declared} bytes, over the ${limit} byte limit`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new DownloadError(`${redactUrl(url)} is over the ${limit} byte limit`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function fetchOnce(url, custom, limit) {
  let current = url
  for (let hop = 0; ; hop++) {
    if (!hopAllowed(current, custom)) {
      throw new DownloadError(`Refusing to download from ${redactUrl(current)}: ${custom ? 'only https, or http on 127.0.0.1 and localhost, is allowed' : 'only https on huggingface.co and its CDN is allowed'}`)
    }
    let response
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'gaze-win32' } })
    } catch (error) {
      throw new NetworkError(`Cannot download ${redactUrl(current)}: ${redactText(error.cause?.message ?? error.message)}`)
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new NetworkError(`Cannot download ${redactUrl(current)}: HTTP ${response.status} without a Location header`)
      if (hop >= MAX_REDIRECTS) throw new DownloadError(`Cannot download ${redactUrl(url)}: more than ${MAX_REDIRECTS} redirects`)
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      const error = new NetworkError(`Cannot download ${redactUrl(current)}: HTTP ${response.status}`)
      error.retryable = retryable(response.status)
      throw error
    }
    try {
      return await readCapped(response, current, limit)
    } catch (error) {
      if (error instanceof DownloadError) throw error
      throw new NetworkError(`Cannot download ${redactUrl(current)}: ${redactText(error.cause?.message ?? error.message)}`)
    }
  }
}

async function download(url, custom, limit) {
  let failure
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(url, custom, limit)
    } catch (error) {
      if (!(error instanceof NetworkError) || error.retryable === false) throw error
      failure = error
    }
    if (attempt < ATTEMPTS) await pause(500 * 3 ** (attempt - 1))
  }
  throw failure
}

const sha256Of = (data) => crypto.createHash('sha256').update(data).digest('hex')

function regularFile(file) {
  try {
    const stats = fs.lstatSync(file)
    return stats.isFile() ? stats : null
  } catch {
    return null
  }
}

function sameFile(a, b) {
  return a !== null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino
}

async function readFile(file) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.readFileSync(file)
    } catch (error) {
      if (!BUSY.has(error.code)) return null
      if (attempt >= BUSY_ATTEMPTS) throw new DownloadError(`Cannot read ${file}: ${error.code}. Another process, usually an antivirus scan, keeps it open; run gaze again in a moment`)
    }
    await pause(BUSY_DELAY_MS)
  }
}

async function matches(file, sha256) {
  const data = await readFile(file)
  return data !== null && sha256Of(data) === sha256
}

async function settled(file, sha256) {
  for (;;) {
    const stats = regularFile(file)
    if (!stats) return null
    if (await matches(file, sha256)) return stats
    if (Date.now() - stats.mtimeMs > SETTLE_MS) return null
    await pause(100)
  }
}

export function verifiedMarker(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.verified`)
}

function marked(file, sha256) {
  const marker = verifiedMarker(file)
  const stats = regularFile(file)
  if (!stats || !regularFile(marker)) return false
  try {
    const mark = JSON.parse(fs.readFileSync(marker, 'utf8'))
    return mark?.sha256 === sha256 && mark.size === stats.size && mark.mtimeMs === stats.mtimeMs
  } catch {
    return false
  }
}

function markVerified(file, sha256, verified) {
  const stats = regularFile(file)
  if (!sameFile(stats, verified)) return
  const marker = verifiedMarker(file)
  const content = `${JSON.stringify({ sha256, size: stats.size, mtimeMs: stats.mtimeMs })}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(marker, content, { flag: 'wx' })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (marked(file, sha256)) return
    fs.rmSync(marker, { recursive: true, force: true })
  }
}

function tryMarkVerified(file, sha256, verified) {
  try {
    markVerified(file, sha256, verified)
  } catch {}
}

function discard(file) {
  try {
    fs.rmSync(verifiedMarker(file), { recursive: true, force: true })
    fs.rmSync(file, { force: true })
  } catch (failure) {
    throw new DownloadError(`Cannot replace ${file}, whose sha256 does not match: ${failure.code ?? failure.message}. Another process, usually an antivirus scan or a running gaze, keeps it open; close it and run gaze again`)
  }
}

async function writeOnce(file, data, sha256) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, data, { flag: 'wx' })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const verified = await settled(file, sha256)
      if (!verified) {
        discard(file)
        continue
      }
      tryMarkVerified(file, sha256, verified)
      return
    }
    const written = regularFile(file)
    if (written?.size !== data.length || !(await matches(file, sha256))) {
      discard(file)
      throw new DownloadError(`Wrote ${data.length} bytes to ${file}, but what is on disk does not match sha256 ${sha256}`)
    }
    tryMarkVerified(file, sha256, written)
    return
  }
  throw new DownloadError(`Cannot write ${file}: another process keeps replacing it`)
}

export function modelDir(model = MODEL) {
  return path.join(modelsDir(), model.repo.replace('/', '--'), model.revision)
}

async function ensureFile(file, url, custom, spec) {
  if (marked(file, spec.sha256)) return
  const before = regularFile(file)
  if (before && (await matches(file, spec.sha256))) {
    tryMarkVerified(file, spec.sha256, before)
    return
  }
  const data = await download(url, custom, Math.min(MAX_BYTES, spec.size ?? MAX_BYTES))
  const actual = sha256Of(data)
  if (actual !== spec.sha256) throw new DownloadError(`Checksum mismatch for ${redactUrl(url)}: expected ${spec.sha256}, got ${actual}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await writeOnce(file, data, spec.sha256)
}

export async function ensureModel({ model = MODEL, env = process.env } = {}) {
  const dir = modelDir(model)
  const { base, custom } = modelBase(env)
  for (const [name, spec] of Object.entries(model.files)) {
    await ensureFile(path.join(dir, ...name.split('/')), modelUrl(base, model, name), custom, spec)
  }
  return dir
}

const require = createRequire(import.meta.url)

export function ortAssets() {
  const wasm = require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm')
  const mjs = require.resolve('onnxruntime-web/ort-wasm-simd-threaded.mjs')
  return { wasm, mjs }
}

async function loadOrt() {
  const ort = await import('onnxruntime-web')
  const { wasm, mjs } = ortAssets()
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(mjs).href, wasm: pathToFileURL(wasm).href }
  ort.env.wasm.wasmBinary = fs.readFileSync(wasm)
  return ort
}

function truncate(ids, mask) {
  if (ids.length <= MAX_TOKENS) return { ids, mask }
  return { ids: [...ids.slice(0, MAX_TOKENS - 1), ids.at(-1)], mask: [...mask.slice(0, MAX_TOKENS - 1), mask.at(-1)] }
}

export class LocalEmbedder {
  #queue = Promise.resolve()

  constructor({ ort, session, tokenizer, padId }) {
    this.ort = ort
    this.session = session
    this.tokenizer = tokenizer
    this.padId = padId
  }

  static async load({ model = MODEL } = {}) {
    try {
      const dir = await ensureModel({ model })
      const ort = await loadOrt()
      const session = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, ...model.onnx.split('/'))), { executionProviders: ['wasm'] })
      const { Tokenizer } = await import('@huggingface/tokenizers')
      const config = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8'))
      const tokenizer = new Tokenizer(JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')), config)
      const padToken = typeof config.pad_token === 'string' ? config.pad_token : config.pad_token?.content ?? '<pad>'
      return new LocalEmbedder({ ort, session, tokenizer, padId: tokenizer.token_to_id(padToken) ?? 1 })
    } catch (error) {
      throw new Error(`model load failed: ${errorChain(error)}`)
    }
  }

  embed(texts, mode) {
    const run = this.#queue.then(() => this.#embedAll(texts, mode))
    this.#queue = run.catch(() => {})
    return run
  }

  async #embedAll(texts, mode) {
    if (texts.length === 0) return []
    const out = []
    try {
      for (let i = 0; i < texts.length; i += BATCH) out.push(...(await this.#embedBatch(texts.slice(i, i + BATCH), mode)))
    } catch (error) {
      throw new Error(`embedding failed: ${errorChain(error)}`)
    }
    return out
  }

  async #embedBatch(texts, mode) {
    const encoded = texts.map((text) => {
      const encoding = this.tokenizer.encode(prefixed(text, mode))
      return truncate(encoding.ids, encoding.attention_mask)
    })
    const batch = encoded.length
    const seq = Math.max(...encoded.map((e) => e.ids.length))
    const ids = new BigInt64Array(batch * seq).fill(BigInt(this.padId))
    const mask = new BigInt64Array(batch * seq)
    encoded.forEach((e, row) => {
      for (let j = 0; j < e.ids.length; j++) {
        ids[row * seq + j] = BigInt(e.ids[j])
        mask[row * seq + j] = BigInt(e.mask[j])
      }
    })
    const dims = [batch, seq]
    const feeds = { input_ids: new this.ort.Tensor('int64', ids, dims), attention_mask: new this.ort.Tensor('int64', mask, dims) }
    if (this.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new this.ort.Tensor('int64', new BigInt64Array(batch * seq), dims)
    const outputs = await this.session.run(feeds)
    const hidden = outputs.last_hidden_state ?? outputs[this.session.outputNames[0]]
    const width = hidden.dims[2]
    const data = hidden.data
    const vectors = []
    for (let row = 0; row < batch; row++) {
      const sum = new Float64Array(width)
      let count = 0
      for (let j = 0; j < seq; j++) {
        if (mask[row * seq + j] === 0n) continue
        count++
        const offset = (row * seq + j) * width
        for (let k = 0; k < width; k++) sum[k] += data[offset + k]
      }
      const denominator = Math.max(count, 1e-9)
      let norm = 0
      for (let k = 0; k < width; k++) {
        sum[k] /= denominator
        norm += sum[k] * sum[k]
      }
      norm = Math.max(Math.sqrt(norm), 1e-12)
      vectors.push(normalize(Float32Array.from(sum, (x) => x / norm)))
    }
    return vectors
  }
}

export class DaemonEmbedder {
  constructor({ endpoint = endpointFor(socketPath()), timeoutMs = 120000, request = ipcRequest } = {}) {
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
    this.request = request
  }

  async embed(texts, mode) {
    if (texts.length === 0) return []
    const vectors = []
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH)
      const response = await this.request(this.endpoint, { op: 'embed', mode, texts: batch }, { timeoutMs: this.timeoutMs })
      const got = Array.isArray(response?.vectors) ? response.vectors : []
      if (got.length !== batch.length) throw new Error(`daemon returned ${got.length} vectors for ${batch.length} texts`)
      for (const v of got) vectors.push(Float32Array.from(v))
    }
    return vectors
  }
}

export class AutoEmbedder {
  #local = null
  #loading = null

  constructor({ allowLocal = true, timeoutMs = 120000, onDaemonDown, endpoint, request, loadLocal = () => LocalEmbedder.load() } = {}) {
    this.allowLocal = allowLocal
    this.timeoutMs = timeoutMs
    this.onDaemonDown = onDaemonDown
    this.remote = new DaemonEmbedder({ endpoint, timeoutMs, request })
    this.loadLocal = loadLocal
  }

  async embed(texts, mode) {
    if (fakeRequested()) return new FakeEmbedder().embed(texts, mode)
    if (this.#local) return this.#local.embed(texts, mode)
    try {
      return await this.remote.embed(texts, mode)
    } catch (socketError) {
      try {
        await this.onDaemonDown?.()
      } catch {}
      if (!this.allowLocal) throw socketError
      this.#loading ??= Promise.resolve().then(() => this.loadLocal())
      const local = await this.#loading
      this.#local = local
      return local.embed(texts, mode)
    }
  }
}

export async function createServeEmbedder() {
  if (fakeRequested()) return new FakeEmbedder()
  return LocalEmbedder.load()
}
