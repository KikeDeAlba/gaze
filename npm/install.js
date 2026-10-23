import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
export const ROOT = path.dirname(path.dirname(SELF))
export const DEFAULT_BASE = 'https://github.com/KikeDeAlba/gaze/releases/download'

const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
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
const ORPHAN_AGE_MS = 10 * 60 * 1000
const REFRESH_TIMEOUT_MS = 180_000
const REPAIR_RETRY_MS = 10 * 60 * 1000
const ABANDONED_LOCK_MS = 60 * 60 * 1000
const SETTLE_MS = 2000

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

export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'gaze.exe' : 'gaze'
}

export function archiveName(version, target) {
  return `gaze-${version}-${target}.${target.endsWith('-windows-msvc') ? 'exe' : 'tar.gz'}`
}

export function vendorBinary(root = ROOT, platform = process.platform, version = packageVersion(root)) {
  if (platform === 'win32') return path.join(root, 'vendor', version, binaryName(platform))
  return path.join(root, 'vendor', binaryName(platform))
}

function executable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function vendorVersion(root) {
  try {
    return readFileSync(path.join(root, 'vendor', '.version'), 'utf8').trim()
  } catch {
    return null
  }
}

function removeOrphans(vendor, now = Date.now()) {
  let entries
  try {
    entries = readdirSync(vendor)
  } catch {
    return
  }
  for (const entry of entries) {
    const file = path.join(vendor, entry)
    if (!entry.startsWith('.install-')) continue
    try {
      if (now - statSync(file).mtimeMs > ORPHAN_AGE_MS) rmSync(file, { recursive: true, force: true })
    } catch {}
  }
}

function removeOtherVersions(vendor, version) {
  let entries
  try {
    entries = readdirSync(vendor)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === version) continue
    try {
      rmSync(path.join(vendor, entry), { recursive: true, force: true })
    } catch {}
  }
}

function matches(file, sha256) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex') === sha256
  } catch {
    return false
  }
}

async function settled(file, sha256) {
  for (;;) {
    if (matches(file, sha256)) return true
    let stats
    try {
      stats = statSync(file)
    } catch {
      return false
    }
    if (Date.now() - stats.mtimeMs > SETTLE_MS) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function writeOnce(binary, data, sha256) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(binary, data, { flag: 'wx' })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (await settled(binary, sha256)) return
    rmSync(binary, { force: true })
  }
  throw new InstallError(`Cannot write ${binary}: another install keeps replacing it`)
}

function packageVersion(root) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
}

export function readChecksum(root, version, target) {
  const file = path.join(root, 'npm', 'checksums.json')
  const asset = archiveName(version, target)
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
  const platform = options.platform ?? process.platform
  const version = packageVersion(root)
  const binary = vendorBinary(root, platform, version)
  if (platform === 'win32') return ensureVersionedBinary(binary, version, root, env, warn, options)
  const name = binaryName(platform)
  if (executable(binary) && vendorVersion(root) === version) return binary
  if (options.offline) return executable(binary) ? binary : null

  const target = resolveTarget(options.platform, options.arch)
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
    removeOrphans(vendor)
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
      execFileSync('tar', ['-xzf', file, '--no-same-owner', '--no-same-permissions', '-C', unpacked, name], { cwd: work, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      throw new InstallError(`Cannot extract ${asset}: ${String(error.stderr ?? error.message).trim()}`)
    }
    const extracted = path.join(unpacked, name)
    let stats
    try {
      stats = lstatSync(extracted)
    } catch {
      throw new InstallError(`${asset} does not contain ${name} at its root`)
    }
    if (!stats.isFile()) throw new InstallError(`${asset} has a ${name} entry that is not a regular file`)
    chmodSync(extracted, 0o755)
    const stamp = path.join(work, '.version')
    writeFileSync(stamp, `${version}\n`)
    renameSync(extracted, binary)
    renameSync(stamp, path.join(vendor, '.version'))
  } catch (error) {
    throw unwritable(error, vendor)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return binary
}

async function ensureVersionedBinary(binary, version, root, env, warn, options) {
  const vendor = path.dirname(path.dirname(binary))
  const target = resolveTarget(options.platform, options.arch)
  const { asset, sha256 } = readChecksum(root, version, target)
  if (matches(binary, sha256)) {
    removeOtherVersions(vendor, version)
    return binary
  }
  if (options.offline) return null
  if (proxied(env)) return downloadThroughProxy(root, env)
  const { base, custom } = downloadBase(env, warn)

  const data = await download(`${base}/v${version}/${asset}`, custom)
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== sha256) throw new InstallError(`Checksum mismatch for ${asset}: expected ${sha256}, got ${actual}`)

  try {
    mkdirSync(path.dirname(binary), { recursive: true })
    removeOtherVersions(vendor, version)
    await writeOnce(binary, data, sha256)
  } catch (error) {
    throw unwritable(error, vendor)
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

function home(env) {
  return env.HOME || env.USERPROFILE || homedir()
}

export function launchAgent(env = process.env, platform = process.platform) {
  if (platform === 'win32') return null
  return path.join(home(env), 'Library', 'LaunchAgents', 'com.kikedealba.gaze.plist')
}

export function registryManifest(env = process.env) {
  const config = process.platform === 'win32' ? env.APPDATA || path.join(home(env), 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || path.join(home(env), '.config')
  return path.join(env.KIT_REGISTRY_DIR || path.join(config, 'kikedealba', 'tools.d'), 'gaze.json')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function vendorRoot(bin) {
  const dir = path.dirname(bin)
  if (path.basename(dir) === 'vendor') return path.dirname(dir)
  const vendor = path.dirname(dir)
  if (path.basename(vendor) === 'vendor' && versionParts(path.basename(dir))) return path.dirname(vendor)
  return null
}

function npmManaged(bin) {
  const root = vendorRoot(bin)
  return root !== null && readJson(path.join(root, 'package.json'))?.name === '@kikedealba/gaze'
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''))
  return match ? match.slice(1).map(Number) : null
}

export function olderVersion(candidate, reference) {
  const a = versionParts(candidate)
  const b = versionParts(reference)
  if (!a || !b) return a === null && b !== null
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index]
  return false
}

function realpathOr(file) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

export function daemonMarker(env = process.env) {
  return path.join(dataDir(env), 'daemon.json')
}

export function daemonStatus(binary, env = process.env) {
  const result = spawnSync(binary, ['daemon', 'status', '--json'], { env, cwd: path.dirname(binary), stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, encoding: 'utf8' })
  try {
    const envelope = JSON.parse(String(result.stdout ?? '').trim())
    if (envelope?.ok === true && typeof envelope.data?.installed === 'boolean') return envelope.data
  } catch {}
  return null
}

function daemonInstalled(binary, env) {
  const status = daemonStatus(binary, env)
  if (status) return status.installed
  const agent = launchAgent(env)
  return (Boolean(agent) && existsSync(agent)) || existsSync(daemonMarker(env))
}

export function needsRepair(binary, { root = ROOT, env = process.env } = {}) {
  if (env.GAZE_BINARY_PATH) return false
  const registered = readJson(registryManifest(env))
  if (!registered) return false
  const bin = registered.bin?.[0]
  const present = typeof bin === 'string' && existsSync(bin)
  if (present && !npmManaged(bin)) return false
  if (!present || olderVersion(registered.version, packageVersion(root))) return true
  if (!binary || realpathOr(bin) !== realpathOr(binary)) return false
  const marker = readJson(daemonMarker(env))
  if (typeof marker?.bin === 'string' && (!existsSync(marker.bin) || realpathOr(marker.bin) !== realpathOr(bin))) return true
  return plistMismatch(launchAgent(env), bin)
}

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function plistMismatch(plist, bin) {
  if (!plist || !existsSync(plist)) return false
  try {
    const text = readFileSync(plist, 'utf8')
    return !text.includes(`<string>${xmlEscape(bin)}</string>`) && !text.includes(`<string>${bin}</string>`)
  } catch {
    return true
  }
}

export function dataDir(env = process.env) {
  if (env.GAZE_DATA_DIR) return env.GAZE_DATA_DIR
  if (env.GAZE_DB_PATH) return path.dirname(env.GAZE_DB_PATH)
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home(env), 'AppData', 'Local'), 'gaze')
  return path.join(env.XDG_DATA_HOME || path.join(home(env), '.local', 'share'), 'gaze')
}

export function repairLock(env = process.env) {
  return path.join(dataDir(env), 'repair.lock')
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function lockOwner(file) {
  try {
    return Number.parseInt(readFileSync(file, 'utf8').split('\n', 1)[0], 10)
  } catch {
    return null
  }
}

function reclaim(file, now) {
  let stats
  try {
    stats = statSync(file)
  } catch {
    return true
  }
  const age = now - stats.mtimeMs
  if (age < REPAIR_RETRY_MS || (age < ABANDONED_LOCK_MS && alive(lockOwner(file)))) return false
  try {
    rmSync(file, { force: true })
  } catch {
    return false
  }
  return true
}

function acquireLock(file, now = Date.now()) {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  } catch {
    return false
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') return false
    }
    if (!reclaim(file, now)) return false
  }
  return false
}

export function startRepair({ root = ROOT, env = process.env, warn } = {}) {
  const lock = repairLock(env)
  if (!acquireLock(lock)) return false
  try {
    const child = spawn(process.execPath, [path.join(root, 'npm', 'install.js'), '--repair', lock], { env, cwd: root, detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => rmSync(lock, { force: true }))
    child.unref()
  } catch {
    rmSync(lock, { force: true })
    return false
  }
  warn?.(`gaze: the kit registration or the daemon points to an older or missing gaze install; refreshing them in the background (gaze setup, gaze daemon install)\n`)
  return true
}

export function refreshRegistration(binary, { env = process.env, warn = (message) => process.stderr.write(message) } = {}) {
  const daemon = daemonInstalled(binary, env)
  const steps = []
  if (daemon || existsSync(registryManifest(env))) steps.push(['setup'])
  if (daemon) steps.push(['daemon', 'install'])
  for (const args of steps) {
    const result = spawnSync(binary, args, { env, cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'], timeout: REFRESH_TIMEOUT_MS, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) {
      const detail = (result.error?.message ?? result.stderr?.trim()) || `exit ${result.status ?? result.signal}`
      warn(`gaze: could not refresh the daemon with \`gaze ${args.join(' ')}\` (${detail}); run \`gaze setup && gaze daemon install\` by hand\n`)
      return false
    }
  }
  return true
}

async function repair(lock) {
  const problems = []
  try {
    writeFileSync(lock, `${process.pid}\n`)
    const binary = await ensureBinary({ warn: (message) => problems.push(message.trim()) })
    if (refreshRegistration(binary, { warn: (message) => problems.push(message.trim()) })) {
      if (!needsRepair(binary)) {
        rmSync(lock, { force: true })
        return
      }
      problems.push(`gaze setup and gaze daemon install finished, but ${[registryManifest(), daemonMarker(), launchAgent()].filter(Boolean).join(' or ')} still does not point to ${binary}`)
    }
  } catch (error) {
    problems.push(error.message)
  }
  writeFileSync(lock, `${process.pid}\n${new Date().toISOString()} ${problems.join('\n')}\n`)
  process.exitCode = 1
}

async function main(mode, argument) {
  if (mode === '--repair') return repair(argument)
  try {
    const binary = await ensureBinary(mode === '--proxy-child' ? { root: argument } : {})
    if (mode === '--postinstall') refreshRegistration(binary)
  } catch (error) {
    if (mode === '--postinstall' && error instanceof NetworkError) {
      process.stderr.write(`gaze: could not download the binary during install (${error.message}); it will be downloaded the first time gaze runs\n`)
    } else {
      process.stderr.write(`gaze: ${error.message}\n`)
      process.exitCode = mode === '--proxy-child' && error instanceof NetworkError ? NETWORK_EXIT : 1
    }
  }
}

if (invokedDirectly()) await main(...process.argv.slice(2))
