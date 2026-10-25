import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LEGACY_TASK, ServeLog, handle, install, ping, removeLegacyTask, schtasksPath, serveArgs, shutdown, spawnDetached, spawnOnDemand, status,
  statusState, uninstall,
} from '../src/daemon.js'
import { endpointFor, readToken, request, requestAuth, rotateToken } from '../src/ipc.js'
import { VERSION, daemonMarker, serveLock, serveLog, socketPath, spawnedMarker, tokenPath } from '../src/paths.js'

const unix = process.platform !== 'win32'
const DAEMON_URL = pathToFileURL(path.resolve(import.meta.dirname, '../src/daemon.js')).href
const ENVELOPE_URL = pathToFileURL(path.resolve(import.meta.dirname, '../src/envelope.js')).href
const ENV_KEYS = ['GAZE_DATA_DIR', 'GAZE_SOCKET', 'GAZE_EMBEDDER', 'TEST_MINUTE_MS', 'TEST_IDLE_CHECK_MS', 'TEST_LOG']

let saved
let dir
let script
let children

const CHILD = `
import { serve, ServeLog } from ${JSON.stringify(DAEMON_URL)}
import { errorChain } from ${JSON.stringify(ENVELOPE_URL)}
const args = process.argv.slice(2)
const at = args.indexOf('--idle-minutes')
const idleMinutes = at === -1 ? undefined : Number(args[at + 1])
const embedder = {
  async embed(texts, mode) {
    if (texts.includes('boom')) throw new Error('embed failed', { cause: new Error('model exploded') })
    return texts.map((t) => Float32Array.from([t.length, mode === 'query' ? 1 : 0, 0.5]))
  },
}
try {
  await serve({
    idleMinutes,
    log: new ServeLog(process.env.TEST_LOG),
    embedder,
    idleCheckMs: Number(process.env.TEST_IDLE_CHECK_MS ?? 30000),
    minuteMs: Number(process.env.TEST_MINUTE_MS ?? 60000),
  })
} catch (error) {
  process.stderr.write('gaze serve: ' + errorChain(error) + '\\n')
  process.exit(1)
}
`

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gzd-'))
  script = path.join(dir, 'child.mjs')
  fs.writeFileSync(script, CHILD)
  process.env.GAZE_DATA_DIR = path.join(dir, 'data')
  process.env.GAZE_EMBEDDER = 'fake'
  process.env.TEST_LOG = path.join(dir, 'serve.log')
  delete process.env.GAZE_SOCKET
  delete process.env.TEST_MINUTE_MS
  delete process.env.TEST_IDLE_CHECK_MS
  children = []
})

afterEach(async () => {
  await shutdown()
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startChild(args = ['serve'], env = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', (d) => (out.stdout += d))
  child.stderr.on('data', (d) => (out.stderr += d))
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  children.push(child)
  return { child, out, exited }
}

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(50)
  }
  throw new Error('condition not met in time')
}

function rawExchange(ep, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ep)
    const chunks = []
    socket.on('data', (d) => chunks.push(d))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(payload))
  })
}

async function withTimeout(promise, ms) {
  let timer
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

test('serveArgs mirrors serve_args', () => {
  assert.deepEqual(serveArgs(), ['serve'])
  assert.deepEqual(serveArgs(null), ['serve'])
  assert.deepEqual(serveArgs(0), ['serve', '--idle-minutes', '0'])
  assert.deepEqual(serveArgs(120), ['serve', '--idle-minutes', '120'])
})

test('handle answers each op like daemon.rs', async () => {
  const seen = []
  const embedder = {
    async embed(texts, mode) {
      seen.push([texts, mode])
      if (texts[0] === 'boom') throw new Error('outer', { cause: new Error('inner') })
      return texts.map(() => Float32Array.from([0.25, 0.5]))
    },
  }
  assert.deepEqual(await handle(embedder, { op: 'ping' }), { ok: true, pid: process.pid, version: VERSION })
  assert.deepEqual(await handle(embedder, { op: 'shutdown' }), { ok: true, pid: process.pid })
  assert.deepEqual(await handle(embedder, { op: 'nope' }), { ok: false, error: 'unknown op: nope' })
  assert.deepEqual(await handle(embedder, {}), { ok: false, error: 'unknown op: ' })
  assert.deepEqual(await handle(embedder, { op: 7 }), { ok: false, error: 'unknown op: ' })
  assert.deepEqual(await handle(embedder, { op: 'embed', mode: 'query', texts: ['a', 'b'] }), { ok: true, vectors: [[0.25, 0.5], [0.25, 0.5]] })
  assert.deepEqual(await handle(embedder, { op: 'embed', mode: 'QUERY', texts: ['a', 3] }), { ok: true, vectors: [] })
  assert.deepEqual(await handle(embedder, { op: 'embed', texts: 'a' }), { ok: true, vectors: [] })
  assert.deepEqual(await handle(embedder, { op: 'embed', texts: ['boom'] }), { ok: false, error: 'outer: inner' })
  assert.deepEqual(seen.map(([, mode]) => mode), ['query', 'passage', 'passage', 'passage'])
  assert.deepEqual(seen[1][0], [])
})

test('ServeLog appends timestamped lines', () => {
  const file = path.join(dir, 'nested', 'log.txt')
  const log = new ServeLog(file)
  log.line('first')
  log.line('second')
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z first$/)
  assert.match(lines[1], / second$/)
})

test('ping and shutdown report nothing when no daemon runs', async () => {
  assert.equal(await ping(), null)
  assert.equal(await shutdown(), false)
})

test('serve answers ping, embed and shutdown over the authenticated socket', { skip: !unix }, async () => {
  const { child, exited } = startChild()
  const pong = await waitFor(() => ping())
  assert.equal(pong.ok, true)
  assert.equal(pong.pid, child.pid)
  assert.equal(pong.version, VERSION)
  assert.ok(fs.existsSync(socketPath()))
  assert.equal(fs.statSync(socketPath()).mode & 0o777, 0o600)
  assert.match(fs.readFileSync(process.env.TEST_LOG, 'utf8'), new RegExp(`gaze serve listening on ${socketPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`))

  const ep = endpointFor(socketPath())
  const embedded = await request(ep, { op: 'embed', mode: 'query', texts: ['hola', 'abc'] }, { timeoutMs: 5000 })
  assert.deepEqual(embedded, { ok: true, vectors: [[4, 1, 0.5], [3, 1, 0.5]] })
  await assert.rejects(request(ep, { op: 'embed', texts: ['boom'] }, { timeoutMs: 5000 }), {
    code: 'DAEMON',
    message: 'daemon error: embed failed: model exploded',
  })
  await assert.rejects(request(ep, { op: 'what' }, { timeoutMs: 5000 }), { code: 'DAEMON', message: 'daemon error: unknown op: what' })

  assert.equal(await shutdown(), true)
  assert.equal(await withTimeout(exited, 5000), 0)
  assert.equal(fs.existsSync(socketPath()), false)
  assert.equal(await ping(), null)
})

test('serve rejects a request with a wrong hmac and keeps running', { skip: !unix }, async () => {
  startChild()
  await waitFor(() => ping())
  const nonce = crypto.randomBytes(16).toString('hex')
  const serverNonce = crypto.randomBytes(16).toString('hex')
  const body = JSON.stringify({ op: 'shutdown' })
  const forged = requestAuth(crypto.randomBytes(32), nonce, serverNonce, 0, body)
  const hello = `${JSON.stringify({ op: 'hello', nonce })}\n`
  const reply = await rawExchange(socketPath(), `${hello}${JSON.stringify({ auth: forged, body })}\n`)
  const [greeting, refused] = reply.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(greeting.ok, true)
  assert.deepEqual(refused, { ok: false, error: 'unauthorized' })
  const missing = await rawExchange(socketPath(), `${JSON.stringify({ op: 'shutdown' })}\n`)
  assert.deepEqual(JSON.parse(missing), { ok: false, error: 'unauthorized' })
  assert.notEqual(await ping(), null)
})

test('a second serve refuses to start while one is running', { skip: !unix }, async () => {
  const first = startChild()
  const pong = await waitFor(() => ping())
  const second = startChild()
  assert.equal(await withTimeout(second.exited, 10000), 1)
  assert.equal(second.out.stderr, `gaze serve: gaze serve ya corre en ${socketPath()}\n`)
  const again = await ping()
  assert.equal(again.pid, pong.pid)
  assert.equal(first.child.exitCode, null)
})

test('two serves started together leave one daemon whose token the clients hold', { skip: !unix }, async () => {
  for (let round = 0; round < 3; round += 1) {
    const a = startChild()
    const b = startChild()
    const pong = await waitFor(() => ping())
    const first = await withTimeout(Promise.race([a.exited.then((code) => [a, code]), b.exited.then((code) => [b, code])]), 5000)
    assert.notEqual(first, 'timeout', `round ${round}: neither serve gave up`)
    const [loser, code] = first
    const winner = loser === a ? b : a
    assert.equal(code, 1)
    await sleep(200)
    assert.equal(winner.child.exitCode, null, `round ${round}: ${winner.out.stderr}`)
    assert.equal(pong.pid, winner.child.pid)
    assert.equal(loser.out.stderr, `gaze serve: gaze serve ya corre en ${socketPath()}\n`)
    const embedded = await request(endpointFor(socketPath()), { op: 'embed', mode: 'query', texts: ['ab'] }, { timeoutMs: 5000 })
    assert.deepEqual(embedded, { ok: true, vectors: [[2, 1, 0.5]] })
    assert.equal(fs.existsSync(serveLock()), false)
    assert.equal(await shutdown(), true)
    assert.equal(await withTimeout(winner.exited, 5000), 0)
  }
})

test('a serve lock left by a dead process does not block the next serve', { skip: !unix }, async () => {
  const dead = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => dead.on('exit', resolve))
  fs.mkdirSync(path.dirname(serveLock()), { recursive: true })
  fs.writeFileSync(serveLock(), `${dead.pid}\n`)
  startChild()
  assert.notEqual(await waitFor(() => ping()), null)
  assert.equal(fs.existsSync(serveLock()), false)
})

test('a serve that cannot bind leaves the running token alone', { skip: !unix }, async () => {
  const token = rotateToken()
  const held = new Set()
  const squatter = net.createServer((socket) => {
    held.add(socket)
    socket.on('error', () => {})
  })
  fs.mkdirSync(path.dirname(socketPath()), { recursive: true })
  await new Promise((resolve) => squatter.listen(socketPath(), resolve))
  try {
    const { exited, out } = startChild()
    assert.equal(await withTimeout(exited, 15000), 1)
    assert.match(out.stderr, /^gaze serve: bind /)
    assert.deepEqual(readToken(), token)
    assert.equal(fs.readFileSync(tokenPath(), 'utf8'), `${token.toString('hex')}\n`)
  } finally {
    const closed = new Promise((resolve) => squatter.close(resolve))
    for (const socket of held) socket.destroy()
    await closed
  }
})

test('install waits for a serve that is already starting instead of launching another', { skip: !unix }, async () => {
  fs.mkdirSync(path.dirname(serveLock()), { recursive: true })
  fs.writeFileSync(serveLock(), `${process.pid}\n`)
  const launched = path.join(dir, 'launched')
  const probe = path.join(dir, 'probe.mjs')
  fs.writeFileSync(probe, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(launched)}, 'x')\n`)
  const installing = install({ self: [process.execPath, probe] })
  await sleep(300)
  fs.rmSync(serveLock())
  startChild()
  const result = await installing
  assert.equal(result.ready, true)
  assert.equal(fs.existsSync(launched), false)
})

test('serve exits after the idle timeout and removes the socket', { skip: !unix }, async () => {
  const { exited } = startChild(['serve', '--idle-minutes', '1'], { TEST_MINUTE_MS: '400', TEST_IDLE_CHECK_MS: '50' })
  await waitFor(() => ping())
  for (let i = 0; i < 4; i += 1) {
    await sleep(150)
    assert.notEqual(await ping(), null)
  }
  assert.equal(await withTimeout(exited, 5000), 0)
  assert.equal(fs.existsSync(socketPath()), false)
  assert.match(fs.readFileSync(process.env.TEST_LOG, 'utf8'), /gaze serve idle, exiting\n$/)
})

test('serve without idle minutes ignores the idle check', { skip: !unix }, async () => {
  const { exited } = startChild(['serve', '--idle-minutes', '0'], { TEST_MINUTE_MS: '1', TEST_IDLE_CHECK_MS: '20' })
  await waitFor(() => ping())
  assert.equal(await withTimeout(exited, 500), 'timeout')
})

test('spawnOnDemand launches a detached daemon once per window', { skip: !unix }, async () => {
  const command = [process.execPath, script]
  assert.equal(spawnOnDemand({ command }), true)
  assert.ok(fs.existsSync(spawnedMarker()))
  assert.equal(fs.statSync(spawnedMarker()).size, 0)
  const pong = await waitFor(() => ping())
  assert.equal(typeof pong.pid, 'number')
  assert.equal(spawnOnDemand({ command }), false)
  const old = new Date(Date.now() - 121000)
  fs.utimesSync(spawnedMarker(), old, old)
  assert.equal(spawnOnDemand({ command: [path.join(dir, 'missing-node')] }), true)
  assert.ok(Date.now() - fs.statSync(spawnedMarker()).mtimeMs < 5000)
  assert.equal(await shutdown(), true)
})

test('spawnOnDemand never throws', () => {
  process.env.GAZE_DATA_DIR = path.join(script, 'not-a-dir')
  assert.equal(spawnOnDemand({ command: [process.execPath, script] }), false)
})

test('spawnDetached sends serve output to the log and returns the pid', { skip: !unix }, async () => {
  const log = path.join(dir, 'detached', 'serve.log')
  const pid = await spawnDetached({ idleMinutes: 5, log, command: [process.execPath, script] })
  const pong = await waitFor(() => ping())
  assert.equal(pong.pid, pid)
  assert.equal(await shutdown(), true)
  await assert.rejects(spawnDetached({ log: path.join(script, 'x', 'log'), command: [process.execPath, script] }), /spawn gaze serve/)
})

test('install, status and uninstall work in on-demand mode', { skip: !unix }, async () => {
  const before = await status()
  assert.deepEqual(before, {
    socket: socketPath(),
    running: false,
    pid: null,
    manager: 'on-demand',
    mode: 'on-demand',
    unit: null,
    installed: false,
    unitBin: null,
    launchAgent: false,
    loaded: false,
    managerPid: null,
    launchdPid: null,
    state: 'stopped',
  })

  const self = [process.execPath, script]
  const installed = await install({ self })
  assert.equal(installed.ready, true)
  assert.equal(typeof installed.pid, 'number')
  assert.deepEqual({ ...installed, pid: 0 }, {
    manager: 'on-demand',
    mode: 'on-demand',
    unit: null,
    label: null,
    ready: true,
    pid: 0,
    socket: socketPath(),
    bin: script,
    log: serveLog(),
  })
  assert.deepEqual(JSON.parse(fs.readFileSync(daemonMarker(), 'utf8')), { mode: 'on-demand', manager: 'on-demand', unit: null, bin: script, command: self })
  assert.ok(fs.existsSync(spawnedMarker()))

  const running = await status()
  assert.equal(running.running, true)
  assert.equal(running.loaded, true)
  assert.equal(running.installed, true)
  assert.equal(running.launchAgent, true)
  assert.equal(running.unitBin, script)
  assert.equal(running.pid, installed.pid)
  assert.equal(running.state, 'running')
  assert.equal(JSON.stringify({ ok: true, data: running }).includes('\n'), false)

  const again = await install({ self: [process.execPath, path.join(dir, 'other.mjs')] })
  assert.equal(again.pid, installed.pid)
  assert.equal(again.bin, path.join(dir, 'other.mjs'))

  assert.equal(await shutdown(), true)
  await waitFor(async () => (await ping()) === null)
  const idle = await status()
  assert.equal(idle.state, 'idle')
  assert.equal(idle.installed, true)
  assert.equal(idle.running, false)

  await install({ self })
  assert.deepEqual(await uninstall(), { manager: 'on-demand', unit: null, removed: true })
  assert.equal(fs.existsSync(daemonMarker()), false)
  assert.equal(fs.existsSync(spawnedMarker()), false)
  await waitFor(async () => (await ping()) === null)
  assert.deepEqual(await uninstall(), { manager: 'on-demand', unit: null, removed: false })
  assert.equal((await status()).state, 'stopped')
})

test('statusState covers the on-demand states', () => {
  assert.equal(statusState(true, false), 'running')
  assert.equal(statusState(true, true), 'running')
  assert.equal(statusState(false, true), 'idle')
  assert.equal(statusState(false, false), 'stopped')
})

test('schtasksPath is absolute under SystemRoot', () => {
  assert.equal(schtasksPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\schtasks.exe')
  assert.equal(schtasksPath({}), 'C:\\Windows\\System32\\schtasks.exe')
})

function fakeExec(results = {}) {
  const calls = []
  const exec = (program, args) => {
    calls.push([program, ...args])
    return results[args[0]] ?? { success: true, stdout: '', stderr: '' }
  }
  return { calls, exec }
}

test('removeLegacyTask deletes the 0.6.x task through schtasks.exe', async () => {
  const { calls, exec } = fakeExec()
  let stopped = 0
  const env = { SystemRoot: 'C:\\Windows' }
  assert.equal(await removeLegacyTask({ platform: 'win32', exec, env, stop: async () => (stopped += 1) }), true)
  const bin = 'C:\\Windows\\System32\\schtasks.exe'
  assert.deepEqual(calls, [
    [bin, '/Query', '/TN', LEGACY_TASK],
    [bin, '/End', '/TN', LEGACY_TASK],
    [bin, '/Delete', '/TN', LEGACY_TASK, '/F'],
  ])
  assert.equal(stopped, 1)
})

test('removeLegacyTask does nothing without the task or off Windows', async () => {
  const missing = fakeExec({ '/Query': { success: false, stdout: '', stderr: 'not found' } })
  assert.equal(await removeLegacyTask({ platform: 'win32', exec: missing.exec, env: {}, stop: async () => assert.fail('stop') }), false)
  assert.equal(missing.calls.length, 1)
  const other = fakeExec()
  assert.equal(await removeLegacyTask({ platform: 'darwin', exec: other.exec }), false)
  assert.equal(other.calls.length, 0)
})

test('removeLegacyTask reports a failed delete', async () => {
  const { exec } = fakeExec({ '/Delete': { success: false, stdout: '', stderr: ' Access denied \n' } })
  await assert.rejects(removeLegacyTask({ platform: 'win32', exec, env: {}, stop: async () => {} }), { message: 'schtasks /Delete falló: Access denied' })
})
