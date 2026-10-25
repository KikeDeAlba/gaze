import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { errorChain } from './envelope.js'
import { cleanup, endpointFor, listen, request, rotateToken } from './ipc.js'
import { VERSION, daemonMarker, dataDir, selfCommand, serveLog, socketPath, spawnedMarker } from './paths.js'
import { nowIso } from './text.js'

export const MANAGER = 'on-demand'
export const LEGACY_TASK = 'gaze-daemon'
export const SPAWN_WINDOW_MS = 120000
export const ON_DEMAND_IDLE_MINUTES = 120

const POLL_MS = 200
const READY_POLLS = 150
const CONTROL_TIMEOUT_MS = 2000
const IDLE_CHECK_MS = 30000
const MINUTE_MS = 60000
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class ServeLog {
  constructor(file) {
    this.file = file ?? null
  }

  line(message) {
    const line = `${nowIso()} ${message}`
    if (this.file !== null) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.appendFileSync(this.file, `${line}\n`)
        return
      } catch {}
    }
    process.stderr.write(`${line}\n`)
  }
}

function embedTexts(value) {
  return Array.isArray(value) && value.every((text) => typeof text === 'string') ? value : []
}

export async function handle(embedder, msg) {
  const op = typeof msg?.op === 'string' ? msg.op : ''
  switch (op) {
    case 'ping':
      return { ok: true, pid: process.pid, version: VERSION }
    case 'embed': {
      const mode = msg.mode === 'query' ? 'query' : 'passage'
      try {
        const vectors = await embedder.embed(embedTexts(msg.texts), mode)
        return { ok: true, vectors: vectors.map((vector) => Array.from(vector)) }
      } catch (error) {
        return { ok: false, error: errorChain(error) }
      }
    }
    case 'shutdown':
      return { ok: true, pid: process.pid }
    default:
      return { ok: false, error: `unknown op: ${op}` }
  }
}

export function serveArgs(idleMinutes) {
  const args = ['serve']
  if (idleMinutes !== undefined && idleMinutes !== null) args.push('--idle-minutes', String(idleMinutes))
  return args
}

export async function ping(endpoint = socketPath()) {
  try {
    return await request(endpointFor(endpoint), { op: 'ping' }, { timeoutMs: CONTROL_TIMEOUT_MS })
  } catch {
    return null
  }
}

export async function shutdown(endpoint = socketPath()) {
  try {
    await request(endpointFor(endpoint), { op: 'shutdown' }, { timeoutMs: CONTROL_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

async function serveEmbedder() {
  const { createServeEmbedder } = await import('./embed.js')
  return createServeEmbedder()
}

export async function serve({ idleMinutes, log = new ServeLog(), embedder, idleCheckMs = IDLE_CHECK_MS, minuteMs = MINUTE_MS } = {}) {
  const socket = socketPath()
  const endpoint = endpointFor(socket)
  fs.mkdirSync(dataDir(), { recursive: true })
  if ((await ping(socket)) !== null) throw new Error(`gaze serve ya corre en ${socket}`)
  const model = embedder ?? (await serveEmbedder())
  await model.embed(['warmup'], 'query')
  const token = rotateToken()
  let last = Date.now()
  try {
    await listen(endpoint, (msg) => handle(model, msg), {
      token,
      onLine: () => {
        last = Date.now()
      },
      afterReply: (msg) => {
        if (msg?.op !== 'shutdown') return
        cleanup(endpoint)
        process.exit(0)
      },
    })
  } catch (error) {
    throw new Error(`bind ${socket}`, { cause: error })
  }
  log.line(`gaze serve listening on ${socket}`)
  const minutes = Number(idleMinutes)
  if (Number.isFinite(minutes) && minutes > 0) {
    setInterval(() => {
      if (Date.now() - last > minutes * minuteMs) {
        cleanup(endpoint)
        log.line('gaze serve idle, exiting')
        process.exit(0)
      }
    }, idleCheckMs)
  }
  return new Promise(() => {})
}

function childEnv(env = process.env) {
  const proxy = PROXY_VARS.some((name) => typeof env[name] === 'string' && env[name] !== '')
  return proxy ? { ...env, NODE_USE_ENV_PROXY: '1' } : { ...env }
}

function openLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    return fs.openSync(file, 'a')
  } catch {
    return null
  }
}

function launch(command, args, { logFile, required = false } = {}) {
  const [program, ...prefix] = command
  const fd = logFile === undefined ? null : openLog(logFile)
  if (fd === null && required) throw new Error(`open ${logFile}`)
  try {
    const child = spawn(program, [...prefix, ...args], {
      detached: true,
      windowsHide: true,
      stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
      env: childEnv(),
    })
    child.on('error', () => {})
    child.unref()
    return child
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export async function spawnDetached({ idleMinutes, log = serveLog(), command = selfCommand() } = {}) {
  let child
  try {
    child = launch(command, serveArgs(idleMinutes), { logFile: log, required: true })
  } catch (error) {
    throw new Error('spawn gaze serve', { cause: error })
  }
  if (child.pid === undefined) {
    const failure = await new Promise((resolve) => {
      child.once('error', resolve)
      setImmediate(() => resolve(new Error('no pid')))
    })
    throw new Error('spawn gaze serve', { cause: failure })
  }
  return child.pid
}

function recentlySpawned(marker, now = Date.now()) {
  try {
    return now - fs.statSync(marker).mtimeMs < SPAWN_WINDOW_MS
  } catch {
    return false
  }
}

function launchOnDemand(command) {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(spawnedMarker(), '')
  return launch(command, serveArgs(ON_DEMAND_IDLE_MINUTES), { logFile: serveLog() })
}

export function spawnOnDemand({ command = selfCommand() } = {}) {
  try {
    if (recentlySpawned(spawnedMarker())) return false
    launchOnDemand(command)
    return true
  } catch {
    return false
  }
}

export function schtasksPath(env = process.env) {
  return path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'schtasks.exe')
}

function systemExec(program, args) {
  const result = spawnSync(program, args, { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000 })
  return { success: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error ? result.error.message : '') }
}

export async function removeLegacyTask({ platform = process.platform, exec = systemExec, stop = () => shutdown(), env = process.env } = {}) {
  if (platform !== 'win32') return false
  const schtasks = schtasksPath(env)
  if (!exec(schtasks, ['/Query', '/TN', LEGACY_TASK]).success) return false
  exec(schtasks, ['/End', '/TN', LEGACY_TASK])
  await stop()
  const deleted = exec(schtasks, ['/Delete', '/TN', LEGACY_TASK, '/F'])
  if (!deleted.success) throw new Error(`schtasks /Delete falló: ${deleted.stderr.trim()}`)
  return true
}

async function waitReady(socket) {
  for (let poll = 0; poll < READY_POLLS; poll += 1) {
    const reply = await ping(socket)
    if (reply !== null) return reply
    if (poll + 1 < READY_POLLS) await sleep(POLL_MS)
  }
  return null
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(daemonMarker(), 'utf8'))
  } catch {
    return null
  }
}

export async function install({ self = selfCommand(), legacy = {} } = {}) {
  fs.mkdirSync(dataDir(), { recursive: true })
  const socket = socketPath()
  await removeLegacyTask(legacy)
  let reply = await ping(socket)
  if (reply === null) {
    launchOnDemand(self)
    reply = await waitReady(socket)
  }
  const bin = self[self.length - 1]
  fs.writeFileSync(daemonMarker(), `${JSON.stringify({ mode: MANAGER, manager: MANAGER, unit: null, bin, command: self })}\n`)
  return {
    manager: MANAGER,
    mode: MANAGER,
    unit: null,
    label: null,
    ready: reply !== null,
    pid: typeof reply?.pid === 'number' ? reply.pid : null,
    socket,
    bin,
    log: serveLog(),
  }
}

export async function uninstall({ legacy = {} } = {}) {
  await shutdown(socketPath())
  await removeLegacyTask(legacy)
  const removed = fs.existsSync(daemonMarker())
  fs.rmSync(daemonMarker(), { force: true })
  fs.rmSync(spawnedMarker(), { force: true })
  return { manager: MANAGER, unit: null, removed }
}

export function statusState(running, installed) {
  if (running) return 'running'
  return installed ? 'idle' : 'stopped'
}

export async function status() {
  const socket = socketPath()
  const reply = await ping(socket)
  const running = reply !== null
  const installed = fs.existsSync(daemonMarker())
  const bin = installed ? readMarker()?.bin : undefined
  return {
    socket,
    running,
    pid: typeof reply?.pid === 'number' ? reply.pid : null,
    manager: MANAGER,
    mode: MANAGER,
    unit: null,
    installed,
    unitBin: typeof bin === 'string' ? bin : null,
    launchAgent: installed,
    loaded: running,
    managerPid: null,
    launchdPid: null,
    state: statusState(running, installed),
  }
}
