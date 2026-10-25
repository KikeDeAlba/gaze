#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
export const ROOT = path.dirname(path.dirname(SELF))
export const TOOL = 'gaze'
export const SKILL_DIR = path.join(ROOT, 'skills', 'gaze')
export const ANTIGRAVITY_RULES = path.join(ROOT, 'npm', 'antigravity.md')
export const SHIM = path.join(ROOT, 'npm', 'gaze.js')
export const CLAUDE_PLUGIN = { marketplace: 'KikeDeAlba/gaze', marketplaceName: 'gaze', plugin: 'gaze' }

const STATES = {
  installed: 'instalado',
  present: 'ya estaba',
  removed: 'quitado',
  skipped: 'omitido',
  unavailable: 'no disponible',
  failed: 'falló',
  warning: 'aviso',
}

const USAGE = `Uso: gaze setup [--agents <lista>] [--remove] [--json]
       gaze uninstall [--agents <lista>] [--json]

Registra gaze en kit y lo integra con los agentes de código.
  --agents <lista>  agentes separados por comas (claude, opencode, codex, gemini,
                    antigravity, claude-desktop), all o none; por omisión, los detectados
                    (al quitar, todos)
  --remove          quita el registro y las integraciones (igual que gaze uninstall)
  --json            salida JSON (sobre de kit)
`

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { remove: command === 'uninstall', json: false, help: false, agents: null }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--remove') options.remove = true
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--agents' || arg.startsWith('--agents=')) {
      const value = arg === '--agents' ? rest[(index += 1)] : arg.slice('--agents='.length)
      if (!value) throw new UsageError('--agents necesita una lista, por ejemplo --agents codex,gemini')
      options.agents = value.split(',').map((name) => name.trim()).filter(Boolean)
    } else throw new UsageError(`opción desconocida: ${arg}`)
  }
  return options
}

export function selection(names, known, fallback) {
  if (names === null) return fallback
  if (names.length === 1 && (names[0] === 'all' || names[0] === 'none')) return names[0] === 'all' ? 'all' : []
  const unknown = names.filter((name) => !known.includes(name))
  if (unknown.length > 0) throw new UsageError(`agente desconocido: ${unknown.join(', ')} (opciones: ${known.join(', ')}, all, none)`)
  return [...new Set(names)]
}

const WINDOWS_PLAIN = /^[A-Za-z0-9_@+=:./\\-]+$/

export function windowsRooted(file) {
  if (/^[A-Za-z]:[\\/]/.test(file) || /^[\\/]{2}[^\\/]/.test(file)) return true
  return process.platform !== 'win32' && path.posix.isAbsolute(file)
}

export function shellCommand(parts, platform = process.platform) {
  if (platform === 'win32') return parts.map((part) => (WINDOWS_PLAIN.test(part) ? part : `"${part}"`)).join(' ')
  return parts.map((part) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ')
}

function packageVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
}

export function pointsToShim(found, shim = SHIM) {
  return realpathOr(found) === realpathOr(shim)
}

export async function launcher(binary, { ctx, shim = SHIM } = {}) {
  const { platformContext, which } = await import('@kikedealba/kit/platform')
  const context = ctx ?? platformContext()
  const js = pointsToShim(binary, shim)
  if (context.platform === 'win32') {
    const absolute = windowsRooted(binary) ? binary : path.resolve(binary)
    return js ? [process.execPath, absolute] : [absolute]
  }
  const found = await which(TOOL, context)
  if (found && pointsToShim(found, shim)) return [TOOL]
  return js ? [process.execPath, binary] : [binary]
}

export function cmdShimTarget(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const match = /"%dp0%\\([^"]+)"\s+%\*/.exec(text)
  return match ? path.join(path.dirname(file), ...match[1].split('\\')) : null
}

function pathCmdShim(ctx) {
  const key = Object.keys(ctx.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  for (const dir of String(ctx.env[key] ?? '').split(';')) {
    const clean = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!clean || !windowsRooted(clean)) continue
    const file = path.join(clean, `${TOOL}.cmd`)
    if (existsSync(file)) return file
  }
  return null
}

export async function hookLauncher(command, { ctx, shim = SHIM } = {}) {
  const context = ctx ?? (await import('@kikedealba/kit/platform')).platformContext()
  const prefix = shellCommand(command, context.platform)
  if (context.platform !== 'win32') return { prefix }
  if (!windowsRooted(command[0] ?? '')) throw new Error(`${TOOL} hooks on Windows need an absolute launcher, not ${command[0]}`)
  if (command.every((part) => WINDOWS_PLAIN.test(part))) return { prefix }
  if (command.length === 2 && pointsToShim(command[1], shim)) {
    const cmd = pathCmdShim(context)
    const target = cmd && cmdShimTarget(cmd)
    if (target && pointsToShim(target, shim) && WINDOWS_PLAIN.test(cmd)) return { prefix: cmd }
  }
  return { prefix, warning: `la ruta de node o de gaze tiene espacios o caracteres especiales y ${TOOL}.cmd de npm no está en el PATH; los hooks quedan como ${prefix}, que cmd ejecuta pero PowerShell no. Agrega la carpeta de npm (npm config get prefix) al PATH y vuelve a correr gaze setup` }
}

export const HOOK_FILES = {
  codex: (homes) => path.join(homes.codex, 'hooks.json'),
  gemini: (homes) => path.join(homes.gemini, 'settings.json'),
}

export function ownHook(command, harness) {
  const pattern = new RegExp(`(?:^|[\\s'"/\\\\&])gaze(?:\\.exe|\\.cmd|\\.js)?['"]?\\s+hook\\s+(?:session-start|prompt|harvest)\\s+--harness\\s+${harness}\\s*$`)
  return typeof command === 'string' && pattern.test(command)
}

export function purgeHooks(existing, harness, keep = new Set()) {
  const hooks = typeof existing === 'object' && existing !== null ? { ...existing } : {}
  let removed = 0
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = groups.filter((group) => {
      const list = Array.isArray(group?.hooks) ? group.hooks.map((hook) => hook?.command) : []
      const stale = list.length > 0 && list.every((command) => ownHook(command, harness) && !keep.has(command))
      if (stale) removed += 1
      return !stale
    })
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  return { hooks, removed }
}

function hookCommands(spec, harness) {
  return new Set(Object.values(spec[harness].hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command))))
}

function purgeOldHooks(agents, harness, options, keep) {
  const file = HOOK_FILES[harness](agents.agentHomes(options.ctx, options.homes))
  if (!existsSync(file)) return null
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value.hooks === undefined) return null
  const { hooks, removed } = purgeHooks(value.hooks, harness, keep)
  if (removed === 0) return null
  writeFileSync(file, `${JSON.stringify({ ...value, hooks }, null, 2)}\n`)
  return { agent: harness, item: 'old hooks', state: 'removed', detail: `removed ${removed} gaze hooks from another install in ${file}`, path: file }
}

export function integration({ command, hookPrefix, version = packageVersion(), platform = process.platform }) {
  const prefix = hookPrefix ?? shellCommand(command, platform)
  const hook = (op, harness, timeout) => ({ type: 'command', name: `gaze-${op}`, command: `${prefix} hook ${op} --harness ${harness}`, timeout })
  const server = { name: TOOL, command: [...command, 'mcp'] }
  return {
    tool: TOOL,
    version,
    description: 'Cerebro por proyecto: busca antes de preguntar y guarda decisiones como notas atómicas',
    skills: [{ name: 'gaze', dir: SKILL_DIR }],
    mcp: [server],
    codex: {
      hooks: {
        SessionStart: [{ hooks: [hook('session-start', 'codex', 5)] }],
        UserPromptSubmit: [{ hooks: [hook('prompt', 'codex', 3)] }],
      },
    },
    gemini: {
      hooks: {
        SessionStart: [{ hooks: [hook('session-start', 'gemini', 5000)] }],
        BeforeAgent: [{ hooks: [hook('prompt', 'gemini', 3000)] }],
      },
    },
    antigravity: { rules: ANTIGRAVITY_RULES },
    claudeDesktop: { mcp: [server] },
  }
}

async function kitAgents() {
  return (await import('@kikedealba/kit/agents'))
}

async function resolveTargets(agents, wanted, options) {
  if (wanted === 'all') return [...agents.AGENTS]
  if (wanted === 'detected') {
    const { platformContext } = await import('@kikedealba/kit/platform')
    const ctx = options.ctx ?? platformContext()
    return agents.detectAgents(ctx, agents.agentHomes(ctx, options.homes), options.locate)
  }
  return [...wanted]
}

export async function installAgents(wanted, source, options = {}) {
  const agents = await kitAgents()
  const targets = await resolveTargets(agents, wanted, options)
  const steps = []
  if (targets.includes('claude')) steps.push(...(await agents.installClaudePlugin(CLAUDE_PLUGIN, options)))
  const others = targets.filter((agent) => agent !== 'claude')
  if (others.length === 0) return { targets, steps }
  const { spec, warning } = await specFor(source, options)
  for (const harness of Object.keys(HOOK_FILES).filter((agent) => others.includes(agent))) {
    if (warning) steps.push({ agent: harness, item: 'hooks', state: 'warning', detail: warning })
    const purged = purgeOldHooks(agents, harness, options, harness === 'codex' ? hookCommands(spec, harness) : new Set())
    if (purged) steps.push(purged)
  }
  steps.push(...(await agents.installIntegration(spec, { ...options, agents: others })))
  return { targets, steps }
}

async function specFor(source, options) {
  const command = source.command ?? (await launcher(source.binary, { ctx: options.ctx, shim: source.shim }))
  const { prefix, warning } = await hookLauncher(command, { ctx: options.ctx, shim: source.shim })
  return { spec: integration({ command, hookPrefix: prefix, version: source.version, platform: options.ctx?.platform }), warning }
}

export async function uninstallAgents(wanted, source, options = {}) {
  const agents = await kitAgents()
  const targets = await resolveTargets(agents, wanted, options)
  const steps = []
  if (targets.includes('claude')) steps.push(...(await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)))
  const others = targets.filter((agent) => agent !== 'claude')
  if (others.length === 0) return { targets, steps }
  const { spec } = await specFor(source, options)
  steps.push(...(await agents.uninstallIntegration(spec, { ...options, agents: others })))
  for (const harness of Object.keys(HOOK_FILES).filter((agent) => others.includes(agent))) {
    const purged = purgeOldHooks(agents, harness, options, new Set())
    if (purged) steps.push(purged)
  }
  return { targets, steps }
}

export function formatSteps(steps, removing) {
  if (steps.length === 0) return removing ? 'Integraciones: nada que quitar.\n' : 'Integraciones: no se detectó ningún agente; elige con --agents (por ejemplo --agents codex,gemini).\n'
  const width = Math.max(...steps.map((step) => step.agent.length))
  const lines = steps.map((step) => `  ${step.agent.padEnd(width)}  ${step.item}: ${STATES[step.state] ?? step.state} (${step.detail})`)
  return `Integraciones:\n${lines.join('\n')}\n`
}

async function runBinary(command, args, json) {
  if (typeof command === 'function') {
    let stdout = ''
    const capture = { write: (chunk) => ((stdout += String(chunk)), true) }
    const code = await command(json ? [...args, '--json'] : args, { stdin: Readable.from([]), stdout: json ? capture : process.stdout, stderr: process.stderr })
    return { code: Number.isInteger(code) ? code : 1, stdout }
  }
  const [binary, ...prefix] = command
  const result = spawnSync(binary, [...prefix, ...(json ? [...args, '--json'] : args)], { stdio: ['inherit', json ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8', windowsHide: true })
  if (result.error) throw new Error(`no se pudo correr ${binary}: ${result.error.message}`)
  return { code: result.status ?? 1, stdout: result.stdout ?? '' }
}

function envelope(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

export async function runSetup(argv, binary, options = {}) {
  const write = options.write ?? ((text) => process.stdout.write(text))
  const fail = options.fail ?? ((text) => process.stderr.write(text))
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    fail(`gaze: ${error.message}\n${USAGE}`)
    return 2
  }
  if (parsed.help) {
    write(USAGE)
    return 0
  }
  const removing = parsed.remove
  let wanted
  try {
    const known = parsed.agents === null || parsed.agents.some((name) => name !== 'all' && name !== 'none') ? (await kitAgents()).AGENTS : []
    wanted = selection(parsed.agents, known, removing ? 'all' : 'detected')
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    fail(`gaze: ${error.message}\n`)
    return 2
  }
  const native = await runBinary(options.native ?? [binary], [removing ? 'uninstall' : 'setup'], parsed.json)
  if (native.code !== 0) {
    if (parsed.json) write(native.stdout)
    return native.code
  }
  const source = { binary: realpathOr(binary), version: options.version }
  const { steps } = wanted.length === 0 ? { steps: [] } : await (removing ? uninstallAgents : installAgents)(wanted, source, options.install ?? {})
  const failed = steps.some((step) => step.state === 'failed')
  if (parsed.json) {
    const result = envelope(native.stdout) ?? { ok: true, data: {} }
    result.data = { ...result.data, integrations: steps }
    write(`${JSON.stringify(result)}\n`)
  } else {
    write(`\n${wanted.length === 0 ? 'Integraciones: omitidas (--agents none).\n' : formatSteps(steps, removing)}`)
  }
  return failed ? 1 : 0
}

function realpathOr(file) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(SELF)
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const { ensureBinary, jsMode, loadPort } = await import('./install.js')
  const argv = process.argv.slice(2)
  try {
    const binary = await ensureBinary()
    const port = jsMode() ? await loadPort() : null
    const options = port ? { native: (args, io) => port.main(args, { self: [process.execPath, binary], io }) } : {}
    process.exitCode = await runSetup(argv[0] === 'setup' || argv[0] === 'uninstall' ? argv : ['setup', ...argv], binary, options)
  } catch (error) {
    process.stderr.write(`gaze: ${error.message}\n`)
    process.exitCode = 1
  }
}
