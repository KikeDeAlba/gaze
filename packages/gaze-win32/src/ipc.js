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

const AUTH_CONTEXT = 'gaze-ipc-v1'
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

export function authFor(token, role, nonce) {
  return crypto.createHmac('sha256', token).update(`${AUTH_CONTEXT}\n${role}\n${nonce}`).digest('hex')
}

export function verifyAuth(token, role, nonce, auth) {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return false
  if (typeof auth !== 'string' || !HEX64.test(auth)) return false
  return crypto.timingSafeEqual(Buffer.from(authFor(token, role, nonce), 'hex'), Buffer.from(auth, 'hex'))
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

function readLine(socket, cap, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('end', onEnd)
      socket.removeListener('error', onError)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (data) => {
      const newline = data.indexOf(10)
      const take = newline === -1 ? data : data.subarray(0, newline + 1)
      size += take.length
      parts.push(take)
      if (size > cap) return finish(new IpcError('TOO_LARGE', `line over ${cap} bytes`))
      if (newline !== -1) finish(null, Buffer.concat(parts).toString('utf8'))
    }
    const onEnd = () => finish(null, Buffer.concat(parts).toString('utf8'))
    const onError = (error) => finish(new IpcError('CONNECT', `read from daemon: ${error.message}`, { cause: error }))
    const timer = setTimeout(() => finish(new IpcError('TIMEOUT', 'daemon request timed out')), Math.max(1, timeoutMs))
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.on('error', onError)
  })
}

export async function request(endpoint, message, { timeoutMs = 120000 } = {}) {
  const token = readToken()
  if (token === null) throw new IpcError('NO_TOKEN', `no daemon token at ${tokenPath()}`)
  const started = Date.now()
  const nonce = crypto.randomBytes(16).toString('hex')
  const line = `${JSON.stringify({ ...message, nonce, auth: authFor(token, 'client', nonce) })}\n`
  const socket = await connect(endpoint, Math.min(timeoutMs, CONNECT_TIMEOUT_MS))
  const reading = readLine(socket, MAX_RESPONSE, Math.max(1, timeoutMs - (Date.now() - started)))
  socket.write(line)
  const raw = await reading
  let response
  try {
    response = JSON.parse(raw)
  } catch (error) {
    throw new IpcError('DAEMON', `daemon sent an invalid response: ${error.message}`, { cause: error })
  }
  if (response === null || typeof response !== 'object' || !verifyAuth(token, 'server', nonce, response.auth)) {
    throw new IpcError('AUTH', 'daemon auth failed')
  }
  if (response.ok !== true) throw new IpcError('DAEMON', `daemon error: ${response.error}`)
  const { auth, ...rest } = response
  return rest
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

async function respond(token, onMessage, raw) {
  let message
  try {
    message = JSON.parse(raw.replace(/\s+$/u, ''))
  } catch (error) {
    return { reply: { ok: false, error: `bad request: ${error.message}` }, close: false }
  }
  const nonce = message !== null && typeof message === 'object' ? message.nonce : undefined
  if (!verifyAuth(token, 'client', nonce, message?.auth)) return { reply: { ok: false, error: 'unauthorized' }, close: true }
  let result
  try {
    result = await onMessage(message)
  } catch (error) {
    result = { ok: false, error: errorChain(error) }
  }
  const body = result !== null && typeof result === 'object' ? result : { ok: false, error: 'empty response' }
  return { reply: { ...body, auth: authFor(token, 'server', nonce) }, close: false, message }
}

function write(socket, value) {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(false)
    socket.write(`${JSON.stringify(value)}\n`, (error) => resolve(!error))
  })
}

function serveConnection(socket, token, onMessage, { onLine, afterReply }) {
  socket.setTimeout(SERVER_READ_TIMEOUT_MS, () => socket.destroy())
  socket.on('error', () => socket.destroy())
  let pending = []
  let size = 0
  let chain = Promise.resolve()
  let closed = false
  const handle = (raw) => {
    chain = chain.then(async () => {
      if (closed) return
      onLine?.()
      const { reply, close, message } = await respond(token, onMessage, raw)
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
  if (token === null || token === undefined) throw new IpcError('NO_TOKEN', `no daemon token at ${tokenPath()}`)
  const secret = Buffer.from(token)
  const server = net.createServer((socket) => serveConnection(socket, secret, onMessage, { onLine, afterReply }))
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
