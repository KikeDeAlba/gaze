import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  CONNECT_TIMEOUT_MS, IpcError, MAX_LINE, MAX_RESPONSE, SERVER_READ_TIMEOUT_MS, alive, authFor, cleanup, digest, endpointFor, helloAuth, listen, pipeName,
  readToken, replyAuth, request, requestAuth, rotateToken, verifyAuth,
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

async function open(ep) {
  const socket = net.createConnection(ep)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const lines = []
  let buffer = ''
  let closed = false
  let notify = null
  socket.on('data', (data) => {
    buffer += data
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, at)))
      buffer = buffer.slice(at + 1)
    }
    notify?.()
  })
  socket.on('close', () => {
    closed = true
    notify?.()
  })
  socket.on('error', () => {})
  const next = async () => {
    while (lines.length === 0 && !closed) await new Promise((resolve) => (notify = resolve))
    return lines.shift() ?? null
  }
  const send = (value) => socket.write(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
  const isClosed = async () => {
    while (!closed) await new Promise((resolve) => (notify = resolve))
    return true
  }
  return { socket, next, send, isClosed }
}

async function greet(conn) {
  const clientNonce = crypto.randomBytes(16).toString('hex')
  conn.send({ op: 'hello', nonce: clientNonce })
  const hello = await conn.next()
  return { clientNonce, serverNonce: hello.nonce, hello }
}

function signed(token, { clientNonce, serverNonce }, seq, message) {
  const body = JSON.stringify(message)
  return { auth: requestAuth(token, clientNonce, serverNonce, seq, body), body }
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

test('auth is HMAC-SHA256 over the role, both nonces, the sequence and the body digest', () => {
  const token = Buffer.alloc(32, 1)
  const cn = '00112233445566778899aabbccddeeff'
  const sn = 'ffeeddccbbaa99887766554433221100'
  const body = '{"op":"ping"}'
  const hmac = (text) => crypto.createHmac('sha256', token).update(text).digest('hex')
  assert.equal(digest(body), crypto.createHash('sha256').update(body).digest('hex'))
  assert.equal(helloAuth(token, cn, sn), hmac(`gaze-ipc-v2\nhello\n${cn}\n${sn}`))
  assert.equal(requestAuth(token, cn, sn, 0, body), hmac(`gaze-ipc-v2\nclient\n${cn}\n${sn}\n0\n${digest(body)}`))
  assert.equal(replyAuth(token, cn, sn, 3), hmac(`gaze-ipc-v2\nserver\n${cn}\n${sn}\n3`))
  assert.equal(verifyAuth(token, requestAuth(token, cn, sn, 0, body), 'client', cn, sn, '0', digest(body)), true)
  assert.equal(verifyAuth(token, requestAuth(token, cn, sn, 0, body), 'client', cn, sn, '1', digest(body)), false)
  assert.equal(verifyAuth(token, requestAuth(token, cn, sn, 0, body), 'client', cn, sn, '0', digest('{"op":"shutdown"}')), false)
  assert.equal(verifyAuth(token, authFor(token, 'client', cn), 'server', cn), false)
  assert.equal(verifyAuth(token, 'zz', 'client', cn), false)
  assert.equal(verifyAuth(token, undefined, 'client', cn), false)
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
  assert.deepEqual(seen, [{ op: 'ping' }, { op: 'embed', mode: 'query', texts: ['a', 'b'] }])
  for (let waited = 0; replied.length < 2 && waited < 2000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
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

test('the server proves it knows the token before it reads a payload', async () => {
  const token = rotateToken()
  const { ep } = await serve(async () => ({ ok: true }))
  const conn = await open(ep)
  const { clientNonce, serverNonce, hello } = await greet(conn)
  assert.deepEqual(Object.keys(hello).sort(), ['auth', 'nonce', 'ok'])
  assert.equal(hello.ok, true)
  assert.match(serverNonce, /^[0-9a-f]{32}$/)
  assert.equal(hello.auth, helloAuth(token, clientNonce, serverNonce))
  conn.socket.destroy()
})

test('the server rejects requests without a valid auth and closes', async () => {
  const token = rotateToken()
  let calls = 0
  const { ep } = await serve(async () => {
    calls++
    return { ok: true }
  })
  const legacy = await rawExchange(ep, `${JSON.stringify({ op: 'ping', nonce: '00112233445566778899aabbccddeeff', auth: '0'.repeat(64) })}\n`)
  assert.deepEqual(JSON.parse(legacy), { ok: false, error: 'unauthorized' })
  const badHello = await rawExchange(ep, '{"op":"hello","nonce":"short"}\n')
  assert.deepEqual(JSON.parse(badHello), { ok: false, error: 'unauthorized' })
  const cases = [
    (session) => signed(crypto.randomBytes(32), session, 0, { op: 'ping' }),
    (session) => signed(token, session, 1, { op: 'ping' }),
    (session) => ({ ...signed(token, session, 0, { op: 'ping' }), body: '{"op":"shutdown"}' }),
    (session) => ({ body: '{"op":"shutdown"}' }),
    () => ({ op: 'shutdown' }),
    (session) => signed(token, { ...session, serverNonce: crypto.randomBytes(16).toString('hex') }, 0, { op: 'ping' }),
  ]
  for (const make of cases) {
    const conn = await open(ep)
    const session = await greet(conn)
    conn.send(make(session))
    assert.deepEqual(await conn.next(), { ok: false, error: 'unauthorized' })
    assert.equal(await conn.isClosed(), true)
  }
  assert.equal(calls, 0)
})

test('a request cannot be replayed on the same connection', async () => {
  const token = rotateToken()
  let calls = 0
  const { ep } = await serve(async () => ({ ok: true, n: ++calls }))
  const conn = await open(ep)
  const session = await greet(conn)
  const first = signed(token, session, 0, { op: 'ping' })
  conn.send(first)
  assert.equal((await conn.next()).n, 1)
  conn.send(first)
  assert.deepEqual(await conn.next(), { ok: false, error: 'unauthorized' })
  assert.equal(calls, 1)
})

test('one connection serves several lines in order and reports bad json', async () => {
  const token = rotateToken()
  const { ep } = await serve(async (msg) => ({ ok: true, echo: msg.n }))
  const conn = await open(ep)
  const session = await greet(conn)
  conn.send(signed(token, session, 0, { op: 'x', n: 1 }))
  conn.send('not json\n')
  conn.send(signed(token, session, 1, { op: 'x', n: 2 }))
  const replies = [await conn.next(), await conn.next(), await conn.next()]
  assert.equal(replies[0].echo, 1)
  assert.equal(replies[0].auth, replyAuth(token, session.clientNonce, session.serverNonce, 0))
  assert.match(replies[1].error, /^bad request: /)
  assert.equal(replies[1].ok, false)
  assert.equal(replies[1].auth, undefined)
  assert.equal(replies[2].echo, 2)
  assert.equal(replies[2].auth, replyAuth(token, session.clientNonce, session.serverNonce, 1))
  conn.socket.destroy()
})

test('a server without a token yet refuses the hello', async () => {
  let token = null
  const { ep } = await serve(async () => ({ ok: true, pid: 9 }), { token: () => token })
  const refused = await rawExchange(ep, '{"op":"hello","nonce":"00112233445566778899aabbccddeeff"}\n')
  assert.deepEqual(JSON.parse(refused), { ok: false, error: 'unauthorized' })
  token = rotateToken()
  assert.deepEqual(await request(ep, { op: 'ping' }, { timeoutMs: 2000 }), { ok: true, pid: 9 })
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

test('the client never sends the payload to an impostor that does not know the token', async () => {
  rotateToken()
  const received = []
  const impostor = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', (data) => {
      received.push(data.toString('utf8'))
      const msg = JSON.parse(data.toString('utf8'))
      const serverNonce = crypto.randomBytes(16).toString('hex')
      socket.write(`${JSON.stringify({ ok: true, nonce: serverNonce, auth: helloAuth(crypto.randomBytes(32), msg.nonce, serverNonce) })}\n`)
    })
  })
  const ep = endpoint('imp.sock')
  fs.mkdirSync(path.dirname(path.join(dir, 'run', 'imp.sock')), { recursive: true })
  await new Promise((resolve) => impostor.listen(ep, resolve))
  track(impostor)
  await assert.rejects(request(ep, { op: 'embed', mode: 'query', texts: ['secret note'] }, { timeoutMs: 2000 }), { code: 'AUTH', message: 'daemon auth failed' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(received.length, 1)
  assert.deepEqual(Object.keys(JSON.parse(received[0])), ['op', 'nonce'])
  assert.equal(received.join('').includes('secret note'), false)
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
  const token = readToken()
  const flood = net.createServer((socket) => {
    socket.once('data', (data) => {
      const { nonce } = JSON.parse(data.toString('utf8'))
      const serverNonce = crypto.randomBytes(16).toString('hex')
      socket.write(`${JSON.stringify({ ok: true, nonce: serverNonce, auth: helloAuth(token, nonce, serverNonce) })}\n`)
      socket.once('data', () => flooding(socket))
    })
  })
  const flooding = (socket) => {
    {
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
    }
  }
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
