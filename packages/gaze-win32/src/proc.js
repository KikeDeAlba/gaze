import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const WINDOWS_EXTS = ['.exe', '.cmd', '.bat', '.com']
export const SHIM_TARGET = /"%~?dp0%?\\([^"]+)"\s+%\*/i
export const SAFE_ARG = /^(?:[A-Za-z0-9_@+=:,./\\-]*[A-Za-z0-9_@+=:,./-])?$/
const UNSAFE_PROGRAM = /["%!\r\n]/
const NODE_SCRIPT = ['.js', '.cjs', '.mjs']
const NO_CWD_EXE = 'NoDefaultCurrentDirectoryInExePath'
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'
const MAX_BUFFER = 256 * 1024 * 1024
const KILL_TIMEOUT_MS = 10000
const SUPERVISOR_GRACE_MS = 5000
export const TREE_TIMEOUT = 124
export const SPAWN_FAILED = 125
const SUPERVISOR = [
  "const cp = require('node:child_process')",
  'const o = JSON.parse(process.argv[1])',
  "const c = cp.spawn(o.file, o.args, { stdio: 'inherit', windowsHide: true, shell: false, detached: o.kill === null, windowsVerbatimArguments: o.verbatim })",
  "const t = setTimeout(() => { if (o.kill !== null) cp.spawnSync(o.kill, ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore', windowsHide: true, shell: false, timeout: o.killMs }); else { try { process.kill(-c.pid, 'SIGKILL') } catch {} } process.exit(o.timedOut) }, o.timeoutMs)",
  "c.on('error', (e) => { clearTimeout(t); process.stderr.write(String(e.code ?? 'ESPAWN')); process.exit(o.failed) })",
  "c.on('exit', (code) => { clearTimeout(t); process.exit(code ?? 1) })",
].join('\n')

const isWindows = (platform) => platform === 'win32'

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function hasSeparator(bin, windows) {
  return windows ? /[\\/]/.test(bin) || /^[A-Za-z]:/.test(bin) : bin.includes('/')
}

export function envGet(env, name, windows = isWindows(process.platform)) {
  if (!windows) return env[name]
  const wanted = name.toUpperCase()
  const key = Object.keys(env).find((k) => k.toUpperCase() === wanted)
  return key === undefined ? undefined : env[key]
}

export function envSet(env, name, value, windows = isWindows(process.platform)) {
  if (windows) {
    const wanted = name.toUpperCase()
    for (const key of Object.keys(env)) if (key.toUpperCase() === wanted) delete env[key]
  }
  env[name] = value
  return env
}

export function systemBinary(name, env = process.env) {
  const root = envGet(env, 'SystemRoot', true)
  const base = typeof root === 'string' && path.win32.isAbsolute(root) && /^[A-Za-z]:/.test(root) ? root : DEFAULT_SYSTEM_ROOT
  return path.win32.join(base, 'System32', name)
}

export function hardenEnv(env = process.env, platform = process.platform) {
  const copy = { ...env }
  return isWindows(platform) ? envSet(copy, NO_CWD_EXE, '1', true) : copy
}

function notInPath(bin) {
  const error = new Error(`${bin} not found in PATH`)
  error.code = 'ENOENT'
  return error
}

function searchDirs(searchPath) {
  return (searchPath ?? '')
    .split(path.delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && path.isAbsolute(dir))
}

export function resolveProgram(bin, { path: searchPath = envGet(process.env, 'PATH'), windows = isWindows(process.platform) } = {}) {
  if (!windows || hasSeparator(bin, windows)) return bin
  const exts = path.extname(bin) !== '' ? [''] : WINDOWS_EXTS
  for (const dir of searchDirs(searchPath)) {
    for (const ext of exts) {
      const full = path.join(dir, `${bin}${ext}`)
      if (isFile(full)) return full
    }
  }
  throw notInPath(bin)
}

export function shimTarget(program) {
  let raw
  try {
    raw = fs.readFileSync(program, 'utf8')
  } catch {
    return null
  }
  const found = raw.match(SHIM_TARGET)
  if (!found) return null
  const parts = found[1].split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length === 0) return null
  const target = path.join(path.dirname(program), ...parts)
  return isFile(target) ? target : null
}

export function quoteCmdLine(program, args) {
  if (UNSAFE_PROGRAM.test(program) || args.some((arg) => !SAFE_ARG.test(arg))) {
    throw new Error(`no se puede ejecutar ${program} sin shell: argumento no seguro`)
  }
  return [program, ...args].map((part) => `"${part}"`).join(' ')
}

function shellFor(comSpec, env) {
  return typeof comSpec === 'string' && path.win32.isAbsolute(comSpec) && /^[A-Za-z]:/.test(comSpec) ? comSpec : systemBinary('cmd.exe', env)
}

export function commandFor(program, args, { platform = process.platform, execPath = process.execPath, env = process.env, comSpec = envGet(env, 'ComSpec', true) } = {}) {
  const ext = path.extname(program).toLowerCase()
  if (!isWindows(platform) || (ext !== '.cmd' && ext !== '.bat')) return { file: program, args: [...args] }
  const target = shimTarget(program)
  if (target !== null) {
    const targetExt = path.extname(target).toLowerCase()
    if (NODE_SCRIPT.includes(targetExt)) return { file: execPath, args: [target, ...args] }
    if (targetExt === '.exe') return { file: target, args: [...args] }
  }
  const line = quoteCmdLine(program, args)
  return { file: shellFor(comSpec, env), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

export function prepare(bin, args, { env = process.env, platform = process.platform } = {}) {
  const windows = isWindows(platform)
  const program = resolveProgram(bin, { path: envGet(env, 'PATH', windows), windows })
  return { program, ...commandFor(program, args, { platform, env }) }
}

export function runSync(bin, args, { cwd, env = process.env, timeoutMs, input, platform = process.platform } = {}) {
  let command
  try {
    command = prepare(bin, args, { env, platform })
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error }
  }
  if (isWindows(platform) && command.windowsVerbatimArguments === true && timeoutMs !== undefined) {
    return superviseSync(command, { cwd, env, timeoutMs, input, platform })
  }
  const result = spawnSync(command.file, command.args, {
    cwd,
    env: hardenEnv(env, platform),
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: command.windowsVerbatimArguments === true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null }
}

export function supervisorArgs(command, { timeoutMs, platform = process.platform, env = process.env } = {}) {
  const options = {
    file: command.file,
    args: command.args,
    verbatim: command.windowsVerbatimArguments === true,
    timeoutMs,
    kill: isWindows(platform) ? systemBinary('taskkill.exe', env) : null,
    killMs: KILL_TIMEOUT_MS,
    timedOut: TREE_TIMEOUT,
    failed: SPAWN_FAILED,
  }
  return ['-e', SUPERVISOR, JSON.stringify(options)]
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export function superviseSync(command, { cwd, env = process.env, timeoutMs, input, platform = process.platform, execPath = process.execPath } = {}) {
  const started = Date.now()
  const result = spawnSync(execPath, supervisorArgs(command, { timeoutMs, platform, env }), {
    cwd,
    env: hardenEnv(env, platform),
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs + KILL_TIMEOUT_MS + SUPERVISOR_GRACE_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    shell: false,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error) return { status: result.status, stdout, stderr, error: result.error }
  if (result.status === TREE_TIMEOUT && Date.now() - started >= timeoutMs) {
    return { status: null, stdout, stderr, error: codedError(`spawnSync ${command.file} ETIMEDOUT`, 'ETIMEDOUT') }
  }
  if (result.status === SPAWN_FAILED && /^E[A-Z]+$/.test(stderr)) {
    return { status: null, stdout, stderr: '', error: codedError(`spawnSync ${command.file} ${stderr}`, stderr) }
  }
  return { status: result.status, stdout, stderr, error: null }
}

export function lastJsonLine(stdout) {
  const all = stdout.split('\n')
  for (let i = all.length - 1; i >= 0; i--) {
    const line = all[i].trim()
    if (line === '') continue
    try {
      return JSON.parse(line)
    } catch {}
  }
  return null
}

export function spawnDetached(argv, { cwd, env = process.env, logFile, platform = process.platform } = {}) {
  let fd = null
  if (logFile !== undefined && logFile !== null) {
    try {
      fd = fs.openSync(logFile, 'a')
    } catch {
      fd = null
    }
  }
  const out = fd === null ? 'ignore' : fd
  try {
    const command = prepare(argv[0], argv.slice(1), { env, platform })
    const child = spawn(command.file, command.args, {
      cwd,
      env: hardenEnv(env, platform),
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', out, out],
      windowsVerbatimArguments: command.windowsVerbatimArguments === true,
    })
    child.on('error', () => {})
    const pid = child.pid ?? null
    child.unref()
    return pid
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export function killCommand(pid, platform = process.platform, env = process.env) {
  return isWindows(platform) ? { file: systemBinary('taskkill.exe', env), args: ['/T', '/F', '/PID', String(pid)] } : null
}

export function killTree(pid, { platform = process.platform, env = process.env } = {}) {
  if (pid === undefined || pid === null) return
  const command = killCommand(pid, platform, env)
  if (command !== null) {
    spawnSync(command.file, command.args, { stdio: 'ignore', windowsHide: true, shell: false, timeout: KILL_TIMEOUT_MS })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {}
}
