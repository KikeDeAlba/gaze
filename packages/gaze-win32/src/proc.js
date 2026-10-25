import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const WINDOWS_EXTS = ['.exe', '.cmd', '.bat', '.com']
export const SHIM_TARGET = /"%~?dp0%?\\([^"]+)"\s+%\*/i
export const SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\-]*$/
const UNSAFE_PROGRAM = /["%!\r\n]/
const NODE_SCRIPT = ['.js', '.cjs', '.mjs']
const MAX_BUFFER = 256 * 1024 * 1024

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

export function resolveProgram(bin, { path: searchPath = envGet(process.env, 'PATH'), windows = isWindows(process.platform) } = {}) {
  if (hasSeparator(bin, windows) || !windows) return bin
  const exts = path.extname(bin) !== '' ? [''] : WINDOWS_EXTS
  const dirs = (searchPath ?? '').split(path.delimiter).filter((dir) => dir !== '')
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, `${bin}${ext}`)
      if (isFile(full)) return full
    }
  }
  return bin
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

export function commandFor(program, args, { platform = process.platform, execPath = process.execPath, comSpec = process.env.ComSpec } = {}) {
  const ext = path.extname(program).toLowerCase()
  if (!isWindows(platform) || (ext !== '.cmd' && ext !== '.bat')) return { file: program, args: [...args] }
  const target = shimTarget(program)
  if (target !== null) {
    const targetExt = path.extname(target).toLowerCase()
    if (NODE_SCRIPT.includes(targetExt)) return { file: execPath, args: [target, ...args] }
    if (targetExt === '.exe') return { file: target, args: [...args] }
  }
  const line = quoteCmdLine(program, args)
  return { file: comSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

export function prepare(bin, args, { env = process.env, platform = process.platform } = {}) {
  const windows = isWindows(platform)
  const program = resolveProgram(bin, { path: envGet(env, 'PATH', windows), windows })
  return { program, ...commandFor(program, args, { platform }) }
}

export function runSync(bin, args, { cwd, env = process.env, timeoutMs, input } = {}) {
  let command
  try {
    command = prepare(bin, args, { env })
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error }
  }
  const result = spawnSync(command.file, command.args, {
    cwd,
    env,
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

export function spawnDetached(argv, { cwd, env = process.env, logFile } = {}) {
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
    const command = prepare(argv[0], argv.slice(1), { env })
    const child = spawn(command.file, command.args, {
      cwd,
      env,
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

export function killCommand(pid, platform = process.platform) {
  return isWindows(platform) ? { file: 'taskkill', args: ['/T', '/F', '/PID', String(pid)] } : null
}

export function killTree(pid, { platform = process.platform } = {}) {
  if (pid === undefined || pid === null) return
  const command = killCommand(pid, platform)
  if (command !== null) {
    spawnSync(command.file, command.args, { stdio: 'ignore', windowsHide: true, shell: false })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {}
}
