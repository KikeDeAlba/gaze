import { spawn } from 'node:child_process'
import path from 'node:path'
import { commandFor, envGet, envSet, hardenEnv, killTree, resolveProgram } from './proc.js'
import { lines, str, trim, truncate } from './text.js'

export const AGENTS = ['claude', 'codex', 'gemini', 'antigravity', 'opencode']
export const HEADLESS_ENV = 'KIT_HEADLESS'
export const CLAUDE_DEFAULT_MODEL = 'haiku'
export const DRAIN_GRACE_MS = 5000
export const BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'TERM',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  HEADLESS_ENV,
  'SystemDrive',
  'windir',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
]
export const BASE_PREFIXES = ['LC_', 'XDG_', 'NVM_']

const upperAscii = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase())
const lowerAscii = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

export function parseAgent(raw) {
  switch (lowerAscii(trim(raw ?? ''))) {
    case 'claude':
    case 'claude-code':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'gemini':
      return 'gemini'
    case 'antigravity':
    case 'agy':
      return 'antigravity'
    case 'opencode':
      return 'opencode'
    default:
      return null
  }
}

export function agentBin(agent) {
  return agent === 'antigravity' ? 'agy' : agent
}

export function projectDirVar(agent) {
  if (agent === 'claude') return 'CLAUDE_PROJECT_DIR'
  if (agent === 'gemini') return 'GEMINI_PROJECT_DIR'
  return null
}

export function promptEvent(agent) {
  return agent === 'gemini' ? 'BeforeAgent' : 'UserPromptSubmit'
}

export function detect(flag, present) {
  const parsed = flag === undefined || flag === null ? null : parseAgent(flag)
  if (parsed !== null) return parsed
  if (present('ANTIGRAVITY_CONVERSATION_ID')) return 'antigravity'
  if (present('GEMINI_SESSION_ID') || present('GEMINI_PROJECT_DIR')) return 'gemini'
  if (present('CODEX_THREAD_ID')) return 'codex'
  return 'claude'
}

const nonEmpty = (name) => {
  const value = process.env[name]
  return value !== undefined && value !== ''
}

export function detectFromEnv(flag) {
  return detect(flag, nonEmpty)
}

export function headless() {
  const value = process.env[HEADLESS_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

export function invocation(agent, bin, prompt, model, cwd) {
  const chosen = model === undefined || model === null ? null : trim(model) === '' ? null : trim(model)
  const env = []
  let stdin = prompt
  let args
  switch (agent) {
    case 'claude':
      args = ['-p', '--model', chosen ?? CLAUDE_DEFAULT_MODEL, '--output-format', 'json']
      args.push('--permission-mode', 'plan', '--setting-sources', 'user', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands')
      env.push(['CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1'])
      break
    case 'codex':
      args = ['exec', '--json', '-C', String(cwd), '--skip-git-repo-check', '--sandbox', 'read-only']
      if (chosen !== null) args.push('-m', chosen)
      args.push('-')
      break
    case 'gemini':
      args = ['-o', 'json', '--approval-mode', 'plan']
      if (chosen !== null) args.push('-m', chosen)
      break
    case 'antigravity':
      args = ['--mode', 'plan', '--input-format', 'stream-json', '--output-format', 'stream-json']
      if (chosen !== null) args.push('--model', chosen)
      args.push('-p=')
      stdin = `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`
      break
    case 'opencode':
      args = ['run', '--format', 'json', '--agent', 'plan']
      if (chosen !== null) args.push('-m', chosen)
      break
    default:
      throw new Error(`unknown agent: ${agent}`)
  }
  env.push([HEADLESS_ENV, '1'])
  return { program: bin, args, stdin, env }
}

function agentAllows(agent, name, present) {
  const upper = upperAscii(name)
  const has = (prefix) => upper.startsWith(prefix)
  switch (agent) {
    case 'claude':
      return has('ANTHROPIC_') || has('CLAUDE_') || (present('CLAUDE_CODE_USE_BEDROCK') && has('AWS_')) || (present('CLAUDE_CODE_USE_VERTEX') && (has('GOOGLE_') || upper === 'CLOUD_ML_REGION'))
    case 'codex':
      return has('OPENAI_') || has('CODEX_')
    case 'gemini':
      return has('GEMINI_') || (has('GOOGLE_') && (upper !== 'GOOGLE_APPLICATION_CREDENTIALS' || present('GOOGLE_GENAI_USE_VERTEXAI')))
    case 'antigravity':
      return has('ANTIGRAVITY_') || has('GEMINI_')
    case 'opencode':
      return has('OPENCODE_')
    default:
      return false
  }
}

export function allowedEnv(agent, name, present) {
  const upper = upperAscii(name)
  return BASE_ENV.some((allowed) => upperAscii(allowed) === upper) || BASE_PREFIXES.some((prefix) => upper.startsWith(prefix)) || agentAllows(agent, name, present)
}

export function childEnv(agent, env) {
  const entries = Array.isArray(env) ? env : Object.entries(env)
  const names = new Set(entries.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key]) => upperAscii(key)))
  const present = (wanted) => names.has(wanted)
  return Object.fromEntries(entries.filter(([name, value]) => value !== undefined && value !== null && allowedEnv(agent, name, present)))
}

function parseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

function lenientJson(stdout) {
  const whole = parseJson(trim(stdout))
  if (whole.ok) return whole.value
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  const inner = parseJson(stdout.slice(start, end + 1))
  return inner.ok ? inner.value : null
}

function jsonLines(stdout) {
  const out = []
  for (const line of lines(stdout)) {
    const parsed = parseJson(trim(line))
    if (parsed.ok) out.push(parsed.value)
  }
  return out
}

const field = (value, ...keys) => {
  let current = value
  for (const key of keys) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null
    current = current[key] ?? null
  }
  return current
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function lastString(events, pick) {
  let found = null
  for (const event of events) {
    const value = str(pick(event))
    if (value !== null) found = value
  }
  return found
}

export function parseOutput(agent, stdout) {
  switch (agent) {
    case 'claude':
      return str(field(lenientJson(stdout), 'result'))
    case 'gemini':
      return str(field(lenientJson(stdout), 'response'))
    case 'antigravity': {
      const events = jsonLines(stdout).filter((event) => field(event, 'event') === 'result')
      const found = lastString(events, (event) => field(event, 'result', 'response'))
      return found ?? str(field(lenientJson(stdout), 'response'))
    }
    case 'codex': {
      const events = jsonLines(stdout).filter((event) => field(event, 'type') === 'item.completed' && field(event, 'item', 'type') === 'agent_message')
      return lastString(events, (event) => field(event, 'item', 'text'))
    }
    case 'opencode': {
      const texts = jsonLines(stdout).filter((event) => field(event, 'type') === 'text')
      if (texts.length === 0) return null
      const last = field(texts[texts.length - 1], 'part', 'messageID')
      return texts.filter((event) => same(field(event, 'part', 'messageID'), last)).map((event) => str(field(event, 'part', 'text'))).filter((text) => text !== null).join('')
    }
    default:
      return null
  }
}

export function binOverride(agent) {
  const v = (name) => {
    const value = process.env[name]
    return value === undefined || value === '' ? null : value
  }
  return v('GAZE_HARVEST_BIN') ?? (agent === 'claude' ? v('GAZE_CLAUDE_BIN') : null)
}

function hasDir(program) {
  const dir = path.dirname(program)
  return dir !== '' && dir !== '.' && program !== path.basename(program)
}

function collector(stream) {
  const chunks = []
  let done = false
  const waiters = []
  const finish = () => {
    if (done) return
    done = true
    for (const wake of waiters.splice(0)) wake(true)
  }
  if (stream) {
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', finish)
  } else {
    done = true
  }
  return {
    finished(ms) {
      if (done) return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(done), ms)
        waiters.push((value) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    destroy: () => stream?.destroy(),
  }
}

export async function run(agent, prompt, model, cwd, timeoutMs, extraEnv = [], { platform = process.platform } = {}) {
  const windows = platform === 'win32'
  const bin = binOverride(agent) ?? agentBin(agent)
  const searchPath = envGet(process.env, 'PATH', windows)
  let program = bin
  let spec
  let env
  let command
  try {
    program = resolveProgram(bin, { path: searchPath, windows })
    spec = invocation(agent, program, prompt, model, cwd)
    env = childEnv(agent, process.env)
    const extras = Array.isArray(extraEnv) ? extraEnv : Object.entries(extraEnv ?? {})
    for (const [key, value] of [...extras, ...spec.env]) envSet(env, key, value, windows)
    if (hasDir(program)) {
      const rest = (searchPath ?? '').split(path.delimiter).filter((dir) => dir !== '')
      envSet(env, 'PATH', [path.dirname(program), ...rest].join(path.delimiter), windows)
    }
    command = commandFor(program, spec.args, { platform })
  } catch (error) {
    throw new Error(`spawn ${program}`, { cause: error })
  }
  const child = await new Promise((resolve, reject) => {
    let started
    try {
      started = spawn(command.file, command.args, {
        cwd,
        env: hardenEnv(env, platform),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: !windows,
        windowsVerbatimArguments: command.windowsVerbatimArguments === true,
      })
    } catch (error) {
      reject(new Error(`spawn ${program}`, { cause: error }))
      return
    }
    const onError = (error) => reject(new Error(`spawn ${program}`, { cause: error }))
    started.once('error', onError)
    started.once('spawn', () => {
      started.off('error', onError)
      started.on('error', () => {})
      resolve(started)
    })
  })
  const stdout = collector(child.stdout)
  const stderr = collector(child.stderr)
  let written = null
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE' && error.code !== 'EOF' && written === null) written = error
  })
  child.stdin.end(spec.stdin)
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode })
    else child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let timer
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const status = await Promise.race([exited, timedOut])
  clearTimeout(timer)
  if (status === 'timeout') {
    killTree(child.pid, { platform })
    try {
      child.kill('SIGKILL')
    } catch {}
    stdout.destroy()
    stderr.destroy()
    child.stdin.destroy()
    return { type: 'timeout' }
  }
  const deadline = Date.now() + DRAIN_GRACE_MS
  const outDone = await stdout.finished(DRAIN_GRACE_MS)
  const errDone = await stderr.finished(Math.max(deadline - Date.now(), 0))
  if (!outDone || !errDone) {
    killTree(child.pid, { platform })
    await stdout.finished(500)
    await stderr.finished(500)
    stdout.destroy()
    stderr.destroy()
  }
  const out = stdout.text()
  const err = stderr.text()
  if (status.code !== 0) return { type: 'failed', stderr: err }
  if (written !== null) return { type: 'failed', stderr: `stdin: ${written.message}; ${err}` }
  const text = parseOutput(agent, out)
  if (text !== null) return { type: 'text', text }
  throw new Error(`${agent} devolvió una salida sin texto: ${truncate(out, 300)}`)
}
