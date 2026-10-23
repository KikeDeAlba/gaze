#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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

export function shellCommand(parts, platform = process.platform) {
  if (platform === 'win32') return `& ${parts.map((part) => `'${part.replace(/['‘’‚‛]/g, (match) => match + match)}'`).join(' ')}`
  return parts.map((part) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ')
}

function packageVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
}

export function pointsToShim(found, shim = SHIM, platform = process.platform) {
  if (realpathOr(found) === realpathOr(shim)) return true
  if (platform !== 'win32') return false
  try {
    const text = readFileSync(found, 'utf8').toLowerCase()
    return text.includes(path.win32.relative(path.win32.dirname(found), shim).toLowerCase())
  } catch {
    return false
  }
}

export async function launcher(binary, { ctx, shim = SHIM } = {}) {
  const { platformContext, which } = await import('@kikedealba/kit/platform')
  const context = ctx ?? platformContext()
  const found = await which(TOOL, context)
  return found && pointsToShim(found, shim, context.platform) ? [TOOL] : [binary]
}

const OWN_HOOK = /(?:^|[\s'"/\\&])gaze(?:\.exe|\.cmd)?'?\s+hook\s+(?:session-start|prompt|harvest)\s+--harness\s+codex\s*$/

export function ownHook(command) {
  return typeof command === 'string' && OWN_HOOK.test(command)
}

export function purgeHooks(existing, keep = new Set()) {
  const hooks = typeof existing === 'object' && existing !== null ? { ...existing } : {}
  let removed = 0
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = groups.filter((group) => {
      const list = Array.isArray(group?.hooks) ? group.hooks.map((hook) => hook?.command) : []
      const stale = list.length > 0 && list.every((command) => ownHook(command) && !keep.has(command))
      if (stale) removed += 1
      return !stale
    })
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  return { hooks, removed }
}

function purgeCodexHooks(agents, options, keep) {
  const file = path.join(agents.agentHomes(options.ctx, options.homes).codex, 'hooks.json')
  if (!existsSync(file)) return null
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const { hooks, removed } = purgeHooks(value.hooks, keep)
  if (removed === 0) return null
  writeFileSync(file, `${JSON.stringify({ ...value, hooks }, null, 2)}\n`)
  return { agent: 'codex', item: 'old hooks', state: 'removed', detail: `removed ${removed} gaze hooks from another install in ${file}`, path: file }
}

export function integration({ command, version = packageVersion(), platform = process.platform }) {
  const hook = (op, harness, timeout) => ({ type: 'command', name: `gaze-${op}`, command: `${shellCommand(command, platform)} hook ${op} --harness ${harness}`, timeout })
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
  const spec = await specFor(source, options)
  if (others.includes('codex')) {
    const keep = new Set(Object.values(spec.codex.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command))))
    const purged = purgeCodexHooks(agents, options, keep)
    if (purged) steps.push(purged)
  }
  steps.push(...(await agents.installIntegration(spec, { ...options, agents: others })))
  return { targets, steps }
}

async function specFor(source, options) {
  const command = source.command ?? (await launcher(source.binary, { ctx: options.ctx, shim: source.shim }))
  return integration({ command, version: source.version, platform: options.ctx?.platform })
}

export async function uninstallAgents(wanted, source, options = {}) {
  const agents = await kitAgents()
  const targets = await resolveTargets(agents, wanted, options)
  const steps = []
  if (targets.includes('claude')) steps.push(...(await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)))
  const others = targets.filter((agent) => agent !== 'claude')
  if (others.length === 0) return { targets, steps }
  const spec = await specFor(source, options)
  steps.push(...(await agents.uninstallIntegration(spec, { ...options, agents: others })))
  if (others.includes('codex')) {
    const purged = purgeCodexHooks(agents, options, new Set())
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

function runBinary(binary, args, json) {
  const result = spawnSync(binary, json ? [...args, '--json'] : args, { stdio: ['inherit', json ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8', windowsHide: true })
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
  const native = runBinary(binary, [removing ? 'uninstall' : 'setup'], parsed.json)
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
  const { ensureBinary } = await import('./install.js')
  const argv = process.argv.slice(2)
  try {
    const binary = await ensureBinary()
    process.exitCode = await runSetup(argv[0] === 'setup' || argv[0] === 'uninstall' ? argv : ['setup', ...argv], binary)
  } catch (error) {
    process.stderr.write(`gaze: ${error.message}\n`)
    process.exitCode = 1
  }
}
