import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const PORT_BIN = fileURLToPath(new URL('../bin/gaze.js', import.meta.url))

const isWindows = () => process.platform === 'win32'

function envValue(env, name) {
  const value = env[name]
  return value === undefined || value === null || value === '' ? undefined : value
}

function envPath(name) {
  return envValue(process.env, name)
}

export function makeDirs({ windows = isWindows(), env = process.env } = {}) {
  const join = windows ? path.win32.join : path.posix.join
  const v = (name) => envValue(env, name)
  const home = () => {
    const [first, second] = windows ? ['USERPROFILE', 'HOME'] : ['HOME', 'USERPROFILE']
    return v(first) ?? v(second) ?? (windows ? 'C:\\' : '/')
  }
  const configHome = () => windows
    ? v('APPDATA') ?? join(home(), 'AppData', 'Roaming')
    : v('XDG_CONFIG_HOME') ?? join(home(), '.config')
  const dataHome = () => windows
    ? v('LOCALAPPDATA') ?? join(home(), 'AppData', 'Local')
    : v('XDG_DATA_HOME') ?? join(home(), '.local', 'share')
  const cacheHome = () => windows
    ? join(dataHome(), 'gaze', 'cache')
    : join(v('XDG_CACHE_HOME') ?? join(home(), '.cache'), 'gaze')
  return { home: home(), configHome: configHome(), dataHome: dataHome(), cacheHome: cacheHome() }
}

const dirs = () => makeDirs()

export function simplify(p) {
  const raw = String(p)
  if (raw.startsWith('\\\\?\\UNC\\')) return `\\\\${raw.slice(8)}`
  if (raw.startsWith('\\\\?\\')) {
    const rest = raw.slice(4)
    if (Buffer.from(rest, 'utf8')[1] === 0x3a) return rest
  }
  return raw
}

export function canonical(p) {
  try {
    return simplify(fs.realpathSync.native(p))
  } catch {
    return simplify(p)
  }
}

export function readUtf8Strict(file) {
  const bytes = fs.readFileSync(file)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('stream did not contain valid UTF-8')
  }
}

export function home() {
  return dirs().home
}

export function dataDir() {
  const dir = envPath('GAZE_DATA_DIR')
  if (dir !== undefined) return dir
  const db = envPath('GAZE_DB_PATH')
  if (db !== undefined) {
    const parent = path.dirname(db)
    if (parent !== db) return parent
  }
  return path.join(dirs().dataHome, 'gaze')
}

export function dbPath() {
  return envPath('GAZE_DB_PATH') ?? path.join(dataDir(), 'gaze.db')
}

export function defaultPipe(user) {
  const kept = [...(user ?? '')].filter((c) => /^[A-Za-z0-9_-]$/.test(c)).join('')
  return kept === '' ? '\\\\.\\pipe\\gaze' : `\\\\.\\pipe\\gaze-${kept.toLowerCase()}`
}

export function socketPath() {
  const socket = envPath('GAZE_SOCKET')
  if (socket !== undefined) return socket
  if (isWindows()) return defaultPipe(process.env.USERNAME)
  return path.join(dataDir(), 'gaze.sock')
}

export function configDir() {
  return dirs().configHome
}

export function configPath() {
  return envPath('GAZE_CONFIG') ?? path.join(configDir(), 'gaze', 'config.toml')
}

export function cacheDir() {
  return envPath('GAZE_CACHE_DIR') ?? dirs().cacheHome
}

export function modelsDir() {
  return path.join(cacheDir(), 'models')
}

export function harvestLog() {
  return path.join(dataDir(), 'harvest.log')
}

export function harvestDir() {
  return path.join(dataDir(), 'harvest')
}

export function serveLog() {
  return path.join(dataDir(), 'serve.log')
}

export function daemonMarker() {
  return path.join(dataDir(), 'daemon.json')
}

export function tokenPath() {
  return path.join(dataDir(), 'daemon.token')
}

export function spawnedMarker() {
  return path.join(dataDir(), 'serve.spawned')
}

export function serveLock() {
  return path.join(dataDir(), 'serve.lock')
}

const EMPTY_LOCK_GRACE_MS = 10000

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function lockOwner(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { missing: true, pid: null }
  }
  const pid = Number.parseInt(raw.trim(), 10)
  return { missing: false, pid: Number.isInteger(pid) ? pid : null }
}

function stale(file, owner) {
  if (owner.pid !== null) return !pidAlive(owner.pid)
  try {
    return Date.now() - fs.statSync(file).mtimeMs > EMPTY_LOCK_GRACE_MS
  } catch {
    return false
  }
}

export function lockHeld(file) {
  const owner = lockOwner(file)
  return !owner.missing && !stale(file, owner)
}

export function tryLock(file) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const owner = lockOwner(file)
    if (owner.missing) continue
    if (!stale(file, owner)) return false
    const aside = `${file}.${process.pid}.${Date.now()}.stale`
    try {
      fs.renameSync(file, aside)
      fs.rmSync(aside, { force: true })
    } catch {}
  }
  return false
}

export function releaseLock(file) {
  if (lockOwner(file).pid === process.pid) fs.rmSync(file, { force: true })
}

export function registryDir() {
  return envPath('KIT_REGISTRY_DIR') ?? path.join(configDir(), 'kikedealba', 'tools.d')
}

export function bitaConfig() {
  return envPath('BITA_CONFIG_PATH') ?? path.join(configDir(), 'bita', 'config.json')
}

function inkwellDir() {
  return isWindows() ? path.join(dirs().dataHome, 'inkwell') : path.join(home(), '.local', 'share', 'inkwell')
}

export function inkwellDocs() {
  return envPath('INKWELL_DOCS_DIR') ?? path.join(inkwellDir(), 'docs')
}

export function inkwellDb() {
  return envPath('INKWELL_DB_PATH') ?? path.join(inkwellDir(), 'inkwell.db')
}

export function claudeProjects() {
  return path.join(home(), '.claude', 'projects')
}

export function selfCommand() {
  return [process.execPath, PORT_BIN]
}
