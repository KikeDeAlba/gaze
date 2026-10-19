import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const DEFAULT_BASE = 'https://github.com/KikeDeAlba/gaze/releases/download'

const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
}

const ATTEMPTS = 3
const TIMEOUT_MS = 120_000

export class InstallError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InstallError'
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

function retryable(status) {
  return status === 408 || status === 429 || status >= 500
}

async function download(url) {
  let failure
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let response
    try {
      response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'gaze-npm-installer' } })
      if (response.ok) return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      failure = new InstallError(`Cannot download ${url}: ${error.message}`)
    }
    if (response && !response.ok) {
      failure = new InstallError(`Cannot download ${url}: HTTP ${response.status}`)
      if (!retryable(response.status)) throw failure
    }
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * 3 ** (attempt - 1)))
  }
  throw failure
}

function expectedHash(text, asset) {
  const [hex, name] = text.trim().split(/\s+/)
  if (!/^[0-9a-f]{64}$/i.test(hex ?? '')) throw new InstallError(`Malformed checksum file for ${asset}`)
  if (name && path.basename(name.replace(/^\*/, '')) !== asset) throw new InstallError(`Checksum file names ${name}, expected ${asset}`)
  return hex.toLowerCase()
}

export async function ensureBinary(options = {}) {
  const env = options.env ?? process.env
  if (env.GAZE_BINARY_PATH) {
    if (!executable(env.GAZE_BINARY_PATH)) throw new InstallError(`GAZE_BINARY_PATH points to ${env.GAZE_BINARY_PATH}, which is not an executable file`)
    return env.GAZE_BINARY_PATH
  }
  const root = options.root ?? ROOT
  const binary = vendorBinary(root)
  if (executable(binary)) return binary

  const target = resolveTarget(options.platform, options.arch)
  const version = packageVersion(root)
  const asset = `gaze-${version}-${target}.tar.gz`
  const base = (env.GAZE_DOWNLOAD_BASE || DEFAULT_BASE).replace(/\/+$/, '')
  const url = `${base}/v${version}/${asset}`

  const [archive, checksum] = await Promise.all([download(url), download(`${url}.sha256`)])
  const actual = createHash('sha256').update(archive).digest('hex')
  const expected = expectedHash(checksum.toString('utf8'), asset)
  if (actual !== expected) throw new InstallError(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)

  const vendor = path.dirname(binary)
  mkdirSync(vendor, { recursive: true })
  const work = mkdtempSync(path.join(vendor, '.install-'))
  try {
    const file = path.join(work, asset)
    writeFileSync(file, archive)
    const unpacked = path.join(work, 'unpacked')
    mkdirSync(unpacked)
    try {
      execFileSync('tar', ['-xzf', file, '-C', unpacked, 'gaze'], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      throw new InstallError(`Cannot extract ${asset}: ${String(error.stderr ?? error.message).trim()}`)
    }
    const extracted = path.join(unpacked, 'gaze')
    if (!existsSync(extracted)) throw new InstallError(`${asset} does not contain a gaze binary at its root`)
    chmodSync(extracted, 0o755)
    renameSync(extracted, binary)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return binary
}

function invokedDirectly() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  try {
    await ensureBinary()
  } catch (error) {
    process.stderr.write(`gaze: ${error.message}\n`)
    process.exitCode = 1
  }
}
