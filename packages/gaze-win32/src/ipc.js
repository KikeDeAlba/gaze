import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { errorChain } from './envelope.js'
import { dataDir, tokenPath } from './paths.js'

export const CONNECT_TIMEOUT_MS = 1500
export const SERVER_READ_TIMEOUT_MS = 60000
export const MAX_LINE = 1048576
export const MAX_RESPONSE = 67108864

const AUTH_CONTEXT = 'gaze-ipc-v2'
const HEX64 = /^[0-9a-f]{64}$/
const NONCE = /^[0-9a-f]{32}$/
const PIPE_PREFIX = '\\\\.\\pipe\\'

const isWindows = () => process.platform === 'win32'

export class IpcError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'IpcError'
    this.code = code
  }
}

export function pipeName(endpoint) {
  const raw = String(endpoint)
  if (raw.startsWith(PIPE_PREFIX)) return raw
  const slug = [...raw].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c.toLowerCase() : '-')).join('')
  return `${PIPE_PREFIX}gaze-${slug.replace(/^-+|-+$/g, '')}`
}

export function endpointFor(p) {
  return isWindows() ? pipeName(p) : String(p)
}

function addressOf(endpoint) {
  return isWindows() ? pipeName(endpoint) : String(endpoint)
}

export function readToken() {
  let raw
  try {
    raw = fs.readFileSync(tokenPath(), 'utf8')
  } catch {
    return null
  }
  const hex = raw.trim()
  return HEX64.test(hex) ? Buffer.from(hex, 'hex') : null
}

export function rotateToken() {
  const token = crypto.randomBytes(32)
  const file = tokenPath()
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const staging = path.join(dir, `.daemon.token.${process.pid}.${crypto.randomBytes(4).toString('hex')}`)
  try {
    fs.writeFileSync(staging, `${token.toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
    if (!isWindows()) fs.chmodSync(staging, 0o600)
    fs.renameSync(staging, file)
  } catch (error) {
    fs.rmSync(staging, { force: true })
    throw error
  }
  return token
}

export const isNonce = (value) => typeof value === 'string' && NONCE.test(value)

export const newNonce = () => crypto.randomBytes(16).toString('hex')

export function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function authFor(token, role, ...parts) {
  return crypto.createHmac('sha256', token).update([AUTH_CONTEXT, role, ...parts].join('\n')).digest('hex')
}

export function verifyAuth(token, auth, role, ...parts) {
  if (typeof auth !== 'string' || !HEX64.test(auth)) return false
  return crypto.timingSafeEqual(Buffer.from(authFor(token, role, ...parts), 'hex'), Buffer.from(auth, 'hex'))
}

export function helloAuth(token, clientNonce, serverNonce) {
  return authFor(token, 'hello', clientNonce, serverNonce)
}

export function requestAuth(token, clientNonce, serverNonce, seq, body) {
  return authFor(token, 'client', clientNonce, serverNonce, String(seq), digest(body))
}

export function replyAuth(token, clientNonce, serverNonce, seq) {
  return authFor(token, 'server', clientNonce, serverNonce, String(seq))
}

function connect(endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(addressOf(endpoint))
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new IpcError('TIMEOUT', `connect to ${endpoint} timed out`))
    }, Math.max(1, timeoutMs))
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new IpcError('CONNECT', `connect to ${endpoint}: ${error.message}`, { cause: error }))
    })
  })
}

export async function alive(endpoint, timeoutMs = 200) {
  try {
    const socket = await connect(endpoint, timeoutMs)
    socket.destroy()
    return true
  } catch (error) {
    return isWindows() && error instanceof IpcError && error.code === 'TIMEOUT'
  }
}

function lineReader(socket) {
  let parts = []
  let size = 0
  const lines = []
  let ended = false
  let failure = null
  let wake = null
  const notify = () => {
    const waiting = wake
    wake = null
    waiting?.()
  }
  socket.on('data', (data) => {
    let rest = data
    while (rest.length > 0) {
      const newline = rest.indexOf(10)
      if (newline === -1) {
        parts.push(rest)
        size += rest.length
        break
      }
      parts.push(rest.subarray(0, newline + 1))
      lines.push(Buffer.concat(parts))
      parts = []
      size = 0
      rest = rest.subarray(newline + 1)
    }
    notify()
  })
  socket.on('end', () => {
    ended = true
    notify()
  })
  socket.on('error', (error) => {
    failure = error
    notify()
  })
  return (cap, timeoutMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wake = null
        reject(new IpcError('TIMEOUT', 'daemon request timed out'))
      }, Math.max(1, timeoutMs))
      const done = (error, value) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const check = () => {
        if (lines.length > 0) {
          const line = lines.shift()
          return line.length > cap ? done(new IpcError('TOO_LARGE', `line over ${cap} bytes`)) : done(null, line.toString('utf8'))
        }
        if (size > cap) return done(new IpcError('TOO_LARGE', `line over ${cap} bytes`))
        if (failure !== null) return done(new IpcError('CONNECT', `read from daemon: ${failure.message}`, { cause: failure }))
        if (ended) {
          const rest = Buffer.concat(parts).toString('utf8')
          parts = []
          size = 0
          return done(null, rest)
        }
        wake = check
      }
      check()
    })
}

function parseReply(raw) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new IpcError('DAEMON', `daemon sent an invalid response: ${error.message}`, { cause: error })
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export async function request(endpoint, message, { timeoutMs = 120000 } = {}) {
  const token = readToken()
  if (token === null) throw new IpcError('NO_TOKEN', `no daemon token at ${tokenPath()}`)
  const started = Date.now()
  const left = () => Math.max(1, timeoutMs - (Date.now() - started))
  const socket = await connect(endpoint, Math.min(timeoutMs, CONNECT_TIMEOUT_MS))
  try {
    const next = lineReader(socket)
    const clientNonce = newNonce()
    socket.write(`${JSON.stringify({ op: 'hello', nonce: clientNonce })}\n`)
    const hello = parseReply(await next(MAX_LINE, left()))
    if (!isObject(hello) || hello.ok !== true || !isNonce(hello.nonce) || !verifyAuth(token, hello.auth, 'hello', clientNonce, hello.nonce)) {
      throw new IpcError('AUTH', 'daemon auth failed')
    }
    const serverNonce = hello.nonce
    const body = JSON.stringify(message)
    socket.write(`${JSON.stringify({ auth: requestAuth(token, clientNonce, serverNonce, 0, body), body })}\n`)
    const response = parseReply(await next(MAX_RESPONSE, left()))
    if (!isObject(response) || !verifyAuth(token, response.auth, 'server', clientNonce, serverNonce, '0')) {
      throw new IpcError('AUTH', 'daemon auth failed')
    }
    if (response.ok !== true) throw new IpcError('DAEMON', `daemon error: ${response.error}`)
    const { auth, ...rest } = response
    return rest
  } finally {
    socket.destroy()
  }
}

function inUse(endpoint) {
  const error = new Error(`${addressOf(endpoint)} already exists and belongs to another process; stop it or set GAZE_SOCKET to another pipe name`)
  error.code = 'EADDRINUSE'
  return error
}

function startListening(server, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(address)
  })
}

function prepareUnixParent(endpoint) {
  const parent = path.dirname(endpoint) || '.'
  const fresh = !fs.existsSync(parent)
  fs.mkdirSync(parent, { recursive: true })
  if (fresh || path.resolve(parent) === path.resolve(dataDir())) fs.chmodSync(parent, 0o700)
  return parent
}

async function bindUnix(server, endpoint) {
  const parent = prepareUnixParent(endpoint)
  if (fs.existsSync(endpoint) && (await alive(endpoint, 200))) throw inUse(endpoint)
  const staging = path.join(parent, `.g${((process.pid << 12) ^ crypto.randomBytes(3).readUIntBE(0, 3)).toString(16)}`)
  fs.mkdirSync(staging, { mode: 0o700 })
  const staged = path.join(staging, 's')
  try {
    await startListening(server, staged)
    fs.chmodSync(staged, 0o600)
    fs.rmSync(endpoint, { force: true })
    fs.renameSync(staged, endpoint)
  } catch (error) {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(staging, { recursive: true, force: true })
    if (error.code === 'EINVAL' || error.code === 'ENAMETOOLONG') return bindInPlace(server, endpoint)
    throw error
  }
  fs.rmSync(staging, { recursive: true, force: true })
}

async function bindInPlace(server, endpoint) {
  fs.rmSync(endpoint, { force: true })
  await startListening(server, endpoint)
  fs.chmodSync(endpoint, 0o600)
}

async function bindPipe(server, endpoint) {
  try {
    await startListening(server, pipeName(endpoint))
  } catch (error) {
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') throw inUse(endpoint)
    throw error
  }
}

const UNAUTHORIZED = { reply: { ok: false, error: 'unauthorized' }, close: true }

function greet(state, message, tokenOf) {
  if (!isObject(message) || message.op !== 'hello' || !isNonce(message.nonce)) return UNAUTHORIZED
  const token = tokenOf()
  if (token === null || token === undefined) return UNAUTHORIZED
  state.token = Buffer.from(token)
  state.clientNonce = message.nonce
  state.serverNonce = newNonce()
  return { reply: { ok: true, nonce: state.serverNonce, auth: helloAuth(state.token, state.clientNonce, state.serverNonce) }, close: false }
}

async function respond(state, tokenOf, onMessage, raw) {
  let envelope
  try {
    envelope = JSON.parse(raw.replace(/\s+$/u, ''))
  } catch (error) {
    return { reply: { ok: false, error: `bad request: ${error.message}` }, close: false }
  }
  if (state.token === null) return greet(state, envelope, tokenOf)
  const seq = state.seq
  if (!isObject(envelope) || typeof envelope.body !== 'string') return UNAUTHORIZED
  if (!verifyAuth(state.token, envelope.auth, 'client', state.clientNonce, state.serverNonce, String(seq), digest(envelope.body))) return UNAUTHORIZED
  state.seq += 1
  let message
  try {
    message = JSON.parse(envelope.body)
  } catch (error) {
    return { reply: { ok: false, error: `bad request: ${error.message}` }, close: false }
  }
  let result
  try {
    result = await onMessage(message)
  } catch (error) {
    result = { ok: false, error: errorChain(error) }
  }
  const body = isObject(result) ? result : { ok: false, error: 'empty response' }
  return { reply: { ...body, auth: replyAuth(state.token, state.clientNonce, state.serverNonce, seq) }, close: false, message }
}

function write(socket, value) {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(false)
    socket.write(`${JSON.stringify(value)}\n`, (error) => resolve(!error))
  })
}

function serveConnection(socket, tokenOf, onMessage, { onLine, afterReply }) {
  socket.setTimeout(SERVER_READ_TIMEOUT_MS, () => socket.destroy())
  socket.on('error', () => socket.destroy())
  const state = { token: null, clientNonce: null, serverNonce: null, seq: 0 }
  let pending = []
  let size = 0
  let chain = Promise.resolve()
  let closed = false
  const handle = (raw) => {
    chain = chain.then(async () => {
      if (closed) return
      onLine?.()
      const { reply, close, message } = await respond(state, tokenOf, onMessage, raw)
      const written = await write(socket, reply)
      if (close) {
        closed = true
        socket.end()
        return
      }
      if (written && message !== undefined) await afterReply?.(message, reply)
    })
  }
  socket.on('data', (data) => {
    if (closed) return
    let rest = data
    while (rest.length > 0 && !closed) {
      const newline = rest.indexOf(10)
      const take = newline === -1 ? rest : rest.subarray(0, newline + 1)
      rest = newline === -1 ? Buffer.alloc(0) : rest.subarray(newline + 1)
      size += take.length
      pending.push(take)
      if (size > MAX_LINE) {
        closed = true
        chain = chain.then(async () => {
          await write(socket, { ok: false, error: `line over ${MAX_LINE} bytes` })
          socket.end()
        })
        return
      }
      if (newline !== -1) {
        const raw = Buffer.concat(pending).toString('utf8')
        pending = []
        size = 0
        handle(raw)
      }
    }
  })
  socket.on('end', () => {
    if (!closed && size > 0) {
      const raw = Buffer.concat(pending).toString('utf8')
      pending = []
      size = 0
      handle(raw)
    }
    chain = chain.then(() => socket.end())
  })
}

export async function listen(endpoint, onMessage, { token = readToken(), onLine, afterReply } = {}) {
  let tokenOf
  if (typeof token === 'function') tokenOf = token
  else {
    if (token === null || token === undefined) throw new IpcError('NO_TOKEN', `no daemon token at ${tokenPath()}`)
    const secret = Buffer.from(token)
    tokenOf = () => secret
  }
  const server = net.createServer((socket) => serveConnection(socket, tokenOf, onMessage, { onLine, afterReply }))
  if (isWindows()) await bindPipe(server, endpoint)
  else await bindUnix(server, String(endpoint))
  return server
}

export function cleanup(endpoint) {
  if (isWindows()) return
  try {
    fs.rmSync(String(endpoint), { force: true })
  } catch {}
}
