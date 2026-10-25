import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  CONNECT_TIMEOUT_MS, IpcError, MAX_LINE, MAX_RESPONSE, SERVER_READ_TIMEOUT_MS, alive, authFor, cleanup, endpointFor, listen, pipeName, readToken, request,
  rotateToken, verifyAuth,
} from '../src/ipc.js'
import { tokenPath } from '../src/paths.js'

const unix = process.platform !== 'win32'
let saved
let dir
let servers

beforeEach(() => {
  saved = process.env.GAZE_DATA_DIR
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-'))
  process.env.GAZE_DATA_DIR = dir
  servers = []
})

afterEach(async () => {
  for (const server of servers) {
    const closed = new Promise((resolve) => server.close(() => resolve()))
    for (const socket of server.sockets ?? []) socket.destroy()
    await closed
  }
  if (saved === undefined) delete process.env.GAZE_DATA_DIR
  else process.env.GAZE_DATA_DIR = saved
  fs.rmSync(dir, { recursive: true, force: true })
})

const endpoint = (name = 'g.sock') => endpointFor(path.join(dir, 'run', name))

function track(server) {
  server.sockets = new Set()
  server.on('connection', (socket) => {
    server.sockets.add(socket)
    socket.on('close', () => server.sockets.delete(socket))
  })
  servers.push(server)
  return server
}

async function serve(onMessage, options) {
  const ep = options?.endpoint ?? endpoint()
  const server = track(await listen(ep, onMessage, options))
  return { server, ep }
}

function rawExchange(ep, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ep)
    const chunks = []
    socket.on('data', (d) => chunks.push(d))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
    socket.write(payload)
    socket.end()
  })
}

function signed(token, message) {
  const nonce = crypto.randomBytes(16).toString('hex')
  return `${JSON.stringify({ ...message, nonce, auth: authFor(token, 'client', nonce) })}\n`
}

test('limits are the ones in ipc.rs', () => {
  assert.equal(CONNECT_TIMEOUT_MS, 1500)
  assert.equal(SERVER_READ_TIMEOUT_MS, 60000)
  assert.equal(MAX_LINE, 1024 * 1024)
  assert.equal(MAX_RESPONSE, 64 * 1024 * 1024)
})

test('pipe names are stable and prefixed, like ipc.rs', () => {
  const cases = [
    ['\\\\.\\pipe\\gaze-kike', '\\\\.\\pipe\\gaze-kike'],
    ['C:\\Users\\Kike\\gaze.sock', '\\\\.\\pipe\\gaze-c--users-kike-gaze-sock'],
    ['/tmp/x.sock', '\\\\.\\pipe\\gaze-tmp-x-sock'],
    ['--a--', '\\\\.\\pipe\\gaze-a'],
    ['ÁÉ/x', '\\\\.\\pipe\\gaze-x'],
    ['', '\\\\.\\pipe\\gaze-'],
    ['\\\\.\\PIPE\\x', '\\\\.\\pipe\\gaze-pipe-x'],
    ['\\\\.\\pipe\\', '\\\\.\\pipe\\'],
  ]
  for (const [input, want] of cases) assert.equal(pipeName(input), want, input)
  assert.equal(endpointFor('/tmp/x.sock'), unix ? '/tmp/x.sock' : '\\\\.\\pipe\\gaze-tmp-x-sock')
})

test('auth is HMAC-SHA256 over the role and the nonce', () => {
  const token = Buffer.alloc(32, 1)
  const nonce = '00112233445566778899aabbccddeeff'
  assert.equal(authFor(token, 'client', nonce), '1d8427276194a4bd0ca3077009f28c0aa396fa947c974d14ed774500d4443e0d')
  assert.equal(authFor(token, 'server', nonce), 'd5da0c42cca240fbc5b471de15c0ea1eb01b975bad707d06efaa7cf05ed0ec06')
  assert.equal(verifyAuth(token, 'client', nonce, authFor(token, 'client', nonce)), true)
  assert.equal(verifyAuth(token, 'server', nonce, authFor(token, 'client', nonce)), false)
  assert.equal(verifyAuth(token, 'client', 'short', authFor(token, 'client', 'short')), false)
  assert.equal(verifyAuth(token, 'client', nonce, 'zz'), false)
  assert.equal(verifyAuth(token, 'client', nonce, undefined), false)
})

test('tokens rotate into a private file and bad files read as missing', () => {
  assert.equal(readToken(), null)
  const first = rotateToken()
  assert.equal(first.length, 32)
  assert.deepEqual(readToken(), first)
  assert.equal(fs.readFileSync(tokenPath(), 'utf8'), `${first.toString('hex')}\n`)
  if (unix) assert.equal(fs.statSync(tokenPath()).mode & 0o777, 0o600)
  const second = rotateToken()
  assert.notDeepEqual(second, first)
  assert.deepEqual(readToken(), second)
  assert.deepEqual(fs.readdirSync(dir), ['daemon.token'])
  fs.writeFileSync(tokenPath(), 'nothex\n')
  assert.equal(readToken(), null)
  fs.writeFileSync(tokenPath(), 'ab'.repeat(31))
  assert.equal(readToken(), null)
})

test('request and listen round trip with mutual auth', async () => {
  rotateToken()
  const seen = []
  const replied = []
  const { ep } = await serve(async (msg) => {
    seen.push(msg)
    return msg.op === 'ping' ? { ok: true, pid: process.pid, version: '0.7.0' } : { ok: true, vectors: msg.texts.map(() => [0.5]) }
  }, { afterReply: (msg, reply) => replied.push([msg.op, reply.ok]) })
  assert.equal(await alive(ep), true)
  assert.deepEqual(await request(ep, { op: 'ping' }, { timeoutMs: 2000 }), { ok: true, pid: process.pid, version: '0.7.0' })
  assert.deepEqual(await request(ep, { op: 'embed', mode: 'query', texts: ['a', 'b'] }, { timeoutMs: 2000 }), { ok: true, vectors: [[0.5], [0.5]] })
  assert.equal(seen[0].op, 'ping')
  assert.match(seen[0].nonce, /^[0-9a-f]{32}$/)
  assert.match(seen[0].auth, /^[0-9a-f]{64}$/)
  assert.deepEqual(replied, [['ping', true], ['embed', true]])
})

test('daemon failures surface as DAEMON errors with the daemon text', async () => {
  rotateToken()
  const { ep } = await serve(async (msg) => {
    if (msg.op === 'boom') throw new Error('model', { cause: new Error('exploded') })
    return { ok: false, error: `unknown op: ${msg.op}` }
  })
  await assert.rejects(request(ep, { op: 'nope' }, { timeoutMs: 2000 }), (e) => e instanceof IpcError && e.code === 'DAEMON' && e.message === 'daemon error: unknown op: nope')
  await assert.rejects(request(ep, { op: 'boom' }, { timeoutMs: 2000 }), { code: 'DAEMON', message: 'daemon error: model: exploded' })
})

test('the server rejects requests without a valid auth and closes', async () => {
  const token = rotateToken()
  let calls = 0
  const { ep } = await serve(async () => {
    calls++
    return { ok: true }
  })
  const unsigned = await rawExchange(ep, `${JSON.stringify({ op: 'ping', nonce: '00112233445566778899aabbccddeeff', auth: '0'.repeat(64) })}\n`)
  assert.deepEqual(JSON.parse(unsigned), { ok: false, error: 'unauthorized' })
  const missing = await rawExchange(ep, '{"op":"shutdown"}\n')
  assert.deepEqual(JSON.parse(missing), { ok: false, error: 'unauthorized' })
  const wrong = await rawExchange(ep, signed(crypto.randomBytes(32), { op: 'ping' }) + signed(token, { op: 'ping' }))
  assert.deepEqual(wrong.trim().split('\n').map((l) => JSON.parse(l)), [{ ok: false, error: 'unauthorized' }])
  assert.equal(calls, 0)
})

test('one connection serves several lines in order and reports bad json', async () => {
  const token = rotateToken()
  const { ep } = await serve(async (msg) => ({ ok: true, echo: msg.n }))
  const raw = await rawExchange(ep, signed(token, { op: 'x', n: 1 }) + 'not json\n' + signed(token, { op: 'x', n: 2 }))
  const replies = raw.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(replies.length, 3)
  assert.equal(replies[0].echo, 1)
  assert.match(replies[1].error, /^bad request: /)
  assert.equal(replies[1].ok, false)
  assert.equal(replies[1].auth, undefined)
  assert.equal(replies[2].echo, 2)
})

test('lines over the cap are rejected and the connection closes', async () => {
  rotateToken()
  let calls = 0
  const { ep } = await serve(async () => {
    calls++
    return { ok: true }
  })
  const raw = await rawExchange(ep, `${'a'.repeat(MAX_LINE + 10)}\n`)
  assert.deepEqual(JSON.parse(raw), { ok: false, error: 'line over 1048576 bytes' })
  assert.equal(calls, 0)
})

test('the client refuses an impostor server that does not know the token', async () => {
  rotateToken()
  const impostor = net.createServer((socket) => {
    socket.on('data', (data) => {
      const msg = JSON.parse(data.toString('utf8'))
      socket.end(`${JSON.stringify({ ok: true, pid: 1, auth: authFor(crypto.randomBytes(32), 'server', msg.nonce) })}\n`)
    })
  })
  const ep = endpoint('imp.sock')
  fs.mkdirSync(path.dirname(path.join(dir, 'run', 'imp.sock')), { recursive: true })
  await new Promise((resolve) => impostor.listen(ep, resolve))
  track(impostor)
  await assert.rejects(request(ep, { op: 'ping' }, { timeoutMs: 2000 }), { code: 'AUTH', message: 'daemon auth failed' })
})

test('client errors: no token, nothing listening, timeout and oversized replies', async () => {
  await assert.rejects(request(endpoint(), { op: 'ping' }, { timeoutMs: 500 }), { code: 'NO_TOKEN' })
  rotateToken()
  await assert.rejects(request(endpoint('none.sock'), { op: 'ping' }, { timeoutMs: 500 }), { code: 'CONNECT' })
  assert.equal(await alive(endpoint('none.sock')), false)
  const silent = net.createServer(() => {})
  const silentEp = endpoint('silent.sock')
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true })
  await new Promise((resolve) => silent.listen(silentEp, resolve))
  track(silent)
  const started = Date.now()
  await assert.rejects(request(silentEp, { op: 'ping' }, { timeoutMs: 300 }), { code: 'TIMEOUT' })
  assert.ok(Date.now() - started < 2000)
  const flood = net.createServer((socket) => {
    socket.on('data', () => {
      const block = Buffer.alloc(1024 * 1024, 0x61)
      let left = 65
      const pump = () => {
        while (left > 0) {
          left--
          if (!socket.write(block)) return socket.once('drain', pump)
        }
      }
      socket.on('error', () => {})
      pump()
    })
  })
  const floodEp = endpoint('flood.sock')
  await new Promise((resolve) => flood.listen(floodEp, resolve))
  track(flood)
  await assert.rejects(request(floodEp, { op: 'ping' }, { timeoutMs: 10000 }), { code: 'TOO_LARGE' })
})

test('listen needs a token', async () => {
  await assert.rejects(listen(endpoint(), async () => ({ ok: true })), { code: 'NO_TOKEN' })
})

test('unix sockets are private, replace stale files and never steal a live one', { skip: !unix && 'unix only' }, async () => {
  rotateToken()
  const ep = path.join(dir, 'run', 'g.sock')
  fs.mkdirSync(path.dirname(ep), { recursive: true })
  fs.writeFileSync(ep, 'stale')
  const { server } = await serve(async () => ({ ok: true, pid: 1 }), { endpoint: ep })
  assert.equal(fs.statSync(ep).mode & 0o777, 0o600)
  assert.ok(fs.statSync(ep).isSocket())
  assert.deepEqual(fs.readdirSync(path.dirname(ep)), ['g.sock'])
  const fresh = path.join(dir, 'newdir', 'x.sock')
  await serve(async () => ({ ok: true }), { endpoint: fresh })
  assert.equal(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700)
  await serve(async () => ({ ok: true }), { endpoint: path.join(dir, 'd.sock') })
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  await assert.rejects(listen(ep, async () => ({ ok: true })), (e) => e.code === 'EADDRINUSE' && e.message === `${ep} already exists and belongs to another process; stop it or set GAZE_SOCKET to another pipe name`)
  assert.deepEqual(await request(ep, { op: 'ping' }, { timeoutMs: 2000 }), { ok: true, pid: 1 })
  const closed = new Promise((resolve) => server.close(resolve))
  for (const socket of server.sockets) socket.destroy()
  await closed
  servers = servers.filter((s) => s !== server)
  assert.ok(fs.existsSync(ep))
  cleanup(ep)
  assert.equal(fs.existsSync(ep), false)
  cleanup(ep)
})

test('long unix socket paths fall back to binding in place', { skip: !unix && 'unix only' }, async () => {
  rotateToken()
  const deep = path.join(dir, 'x'.repeat(Math.max(1, 100 - dir.length - 12)))
  const ep = path.join(deep, 's.sock')
  assert.ok(Buffer.byteLength(ep) < 104)
  await serve(async () => ({ ok: true, pid: 2 }), { endpoint: ep })
  assert.equal(fs.statSync(ep).mode & 0o777, 0o600)
  assert.deepEqual(await request(ep, { op: 'ping' }, { timeoutMs: 2000 }), { ok: true, pid: 2 })
})

test('named pipes report a pipe owned by someone else', { skip: unix && 'windows only' }, async () => {
  rotateToken()
  const ep = pipeName(path.join(dir, 'busy'))
  await serve(async () => ({ ok: true }), { endpoint: ep })
  await assert.rejects(listen(ep, async () => ({ ok: true })), (e) => e.code === 'EADDRINUSE' && e.message === `${ep} already exists and belongs to another process; stop it or set GAZE_SOCKET to another pipe name`)
  cleanup(ep)
})
