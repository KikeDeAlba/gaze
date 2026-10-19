import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
export const ROOT = path.dirname(path.dirname(SELF))
export const DEFAULT_BASE = 'https://github.com/KikeDeAlba/gaze/releases/download'

const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
}

const GITHUB_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3
const MAX_BYTES = 200 * 1024 * 1024
const ATTEMPTS = 3
const TIMEOUT_MS = 120_000
const NETWORK_EXIT = 3
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS'])

export class InstallError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InstallError'
  }
}

export class NetworkError extends InstallError {
  constructor(message) {
    super(message)
    this.name = 'NetworkError'
  }
}

export function resolveTarget(platform = process.platform, arch = process.arch) {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) {
    const supported = Object.keys(TARGETS).join(', ')
    throw new InstallError(`gaze has no prebuilt binary for ${platform}-${arch} (supported: ${supported}). Build it with: cargo install --locked --git https://github.com/KikeDeAlba/gaze`)
  }
  return target
}

export function vendorBinary(root = ROOT) {
  return path.join(root, 'vendor', 'gaze')
}

function executable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function packageVersion(root) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
}

export function readChecksum(root, version, target) {
  const file = path.join(root, 'npm', 'checksums.json')
  const asset = `gaze-${version}-${target}.tar.gz`
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new InstallError(`${file} is missing, so the gaze binary cannot be verified. Reinstall @kikedealba/gaze from the npm registry or set GAZE_BINARY_PATH`)
    throw new InstallError(`${file} is not valid JSON: ${error.message}`)
  }
  if (data?.version !== version) throw new InstallError(`${file} is for version ${data?.version}, but the package is ${version}`)
  const entry = data.assets?.[target]
  if (!entry) throw new InstallError(`${file} has no checksum for ${target}`)
  if (entry.file !== asset) throw new InstallError(`${file} lists ${entry.file} for ${target}, expected ${asset}`)
  if (!/^[0-9a-f]{64}$/i.test(entry.sha256 ?? '')) throw new InstallError(`${file} has a malformed sha256 for ${target}`)
  return { asset, sha256: entry.sha256.toLowerCase() }
}

export function downloadBase(env, warn) {
  const custom = env.GAZE_DOWNLOAD_BASE
  if (!custom) return { base: DEFAULT_BASE, custom: false }
  let url
  try {
    url = new URL(custom)
  } catch {
    throw new InstallError(`GAZE_DOWNLOAD_BASE is not a valid URL: ${custom}`)
  }
  if (!hopAllowed(url, true)) throw new InstallError(`GAZE_DOWNLOAD_BASE must use https (plain http is only allowed for 127.0.0.1 and localhost): ${custom}`)
  warn(`gaze: downloading from GAZE_DOWNLOAD_BASE=${custom} instead of the GitHub releases\n`)
  return { base: custom.replace(/\/+$/, ''), custom: true }
}

export function hopAllowed(url, custom) {
  const target = typeof url === 'string' ? new URL(url) : url
  if (custom) return target.protocol === 'https:' || (target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname))
  return target.protocol === 'https:' && GITHUB_HOSTS.has(target.hostname)
}

function retryable(status) {
  return status === 408 || status === 429 || status >= 500
}

async function readCapped(response, url) {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_BYTES) throw new InstallError(`${url} is ${declared} bytes, over the ${MAX_BYTES} byte limit`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_BYTES) throw new InstallError(`${url} is over the ${MAX_BYTES} byte limit`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function fetchOnce(url, custom) {
  let current = url
  for (let hop = 0; ; hop++) {
    if (!hopAllowed(current, custom)) throw new InstallError(`Refusing to download from ${current}: ${custom ? 'only https, or http on 127.0.0.1 and localhost, is allowed' : `only https on ${[...GITHUB_HOSTS].join(', ')} is allowed`}`)
    let response
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'gaze-npm-installer' } })
    } catch (error) {
      throw new NetworkError(`Cannot download ${current}: ${error.cause?.message ?? error.message}`)
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new NetworkError(`Cannot download ${current}: HTTP ${response.status} without a Location header`)
      if (hop >= MAX_REDIRECTS) throw new InstallError(`Cannot download ${url}: more than ${MAX_REDIRECTS} redirects`)
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      const error = new NetworkError(`Cannot download ${current}: HTTP ${response.status}`)
      error.retryable = retryable(response.status)
      throw error
    }
    try {
      return await readCapped(response, current)
    } catch (error) {
      if (error instanceof InstallError) throw error
      throw new NetworkError(`Cannot download ${current}: ${error.cause?.message ?? error.message}`)
    }
  }
}

async function download(url, custom) {
  let failure
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(url, custom)
    } catch (error) {
      if (!(error instanceof NetworkError) || error.retryable === false) throw error
      failure = error
    }
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * 3 ** (attempt - 1)))
  }
  throw failure
}

function unwritable(error, vendor) {
  if (!UNWRITABLE.has(error.code)) return error
  return new InstallError(`Cannot write ${vendor}: ${error.code}. The npm global prefix is not writable by this user; check it with \`npm config get prefix\` and reinstall with a user prefix (npm config set prefix ~/.npm-global, then npm install -g @kikedealba/gaze)`)
}

function proxied(env) {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) && !env.NODE_USE_ENV_PROXY && !process.env.NODE_USE_ENV_PROXY
}

function downloadThroughProxy(root, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, '--proxy-child', root], { env: { ...env, NODE_USE_ENV_PROXY: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => reject(new InstallError(`Cannot start the proxied download: ${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) return resolve(vendorBinary(root))
      const lines = stderr.trim().split('\n')
      const message = (lines.at(-1) || `the proxied download exited with code ${code}`).replace(/^gaze: /, '')
      for (const line of lines.slice(0, -1)) if (line) process.stderr.write(`${line}\n`)
      reject(code === NETWORK_EXIT ? new NetworkError(message) : new InstallError(message))
    })
  })
}

export async function ensureBinary(options = {}) {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((message) => process.stderr.write(message))
  if (env.GAZE_BINARY_PATH) {
    if (!executable(env.GAZE_BINARY_PATH)) throw new InstallError(`GAZE_BINARY_PATH points to ${env.GAZE_BINARY_PATH}, which is not an executable file`)
    warn(`gaze: using GAZE_BINARY_PATH=${env.GAZE_BINARY_PATH} instead of the bundled binary\n`)
    return env.GAZE_BINARY_PATH
  }
  const root = options.root ?? ROOT
  const binary = vendorBinary(root)
  if (executable(binary)) return binary

  const target = resolveTarget(options.platform, options.arch)
  const version = packageVersion(root)
  const { asset, sha256 } = readChecksum(root, version, target)
  if (proxied(env)) return downloadThroughProxy(root, env)
  const { base, custom } = downloadBase(env, warn)

  const archive = await download(`${base}/v${version}/${asset}`, custom)
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== sha256) throw new InstallError(`Checksum mismatch for ${asset}: expected ${sha256}, got ${actual}`)

  const vendor = path.dirname(binary)
  let work
  try {
    mkdirSync(vendor, { recursive: true })
    work = mkdtempSync(path.join(vendor, '.install-'))
  } catch (error) {
    throw unwritable(error, vendor)
  }
  try {
    const file = path.join(work, asset)
    writeFileSync(file, archive)
    const unpacked = path.join(work, 'unpacked')
    mkdirSync(unpacked)
    try {
      execFileSync('tar', ['-xzf', file, '--no-same-owner', '--no-same-permissions', '-C', unpacked, 'gaze'], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      throw new InstallError(`Cannot extract ${asset}: ${String(error.stderr ?? error.message).trim()}`)
    }
    const extracted = path.join(unpacked, 'gaze')
    let stats
    try {
      stats = lstatSync(extracted)
    } catch {
      throw new InstallError(`${asset} does not contain a gaze binary at its root`)
    }
    if (!stats.isFile()) throw new InstallError(`${asset} has a gaze entry that is not a regular file`)
    chmodSync(extracted, 0o755)
    renameSync(extracted, binary)
  } catch (error) {
    throw unwritable(error, vendor)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return binary
}

function invokedDirectly() {
  try {
    return realpathSync(SELF) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const [mode, root] = process.argv.slice(2)
  try {
    await ensureBinary(mode === '--proxy-child' ? { root } : {})
  } catch (error) {
    if (mode === '--postinstall' && error instanceof NetworkError) {
      process.stderr.write(`gaze: could not download the binary during install (${error.message}); it will be downloaded the first time gaze runs\n`)
    } else {
      process.stderr.write(`gaze: ${error.message}\n`)
      process.exitCode = mode === '--proxy-child' && error instanceof NetworkError ? NETWORK_EXIT : 1
    }
  }
}
