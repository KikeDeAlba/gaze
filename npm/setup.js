#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
export const ROOT = path.dirname(path.dirname(SELF))
export const TOOL = 'gaze'
export const SKILL_DIR = path.join(ROOT, 'skills', 'gaze')
export const ANTIGRAVITY_RULES = path.join(ROOT, 'npm', 'antigravity.md')
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

export function integration({ binary, version = packageVersion(), platform = process.platform }) {
  const hook = (op, harness, timeout) => ({ type: 'command', name: `gaze-${op}`, command: `${shellCommand([binary], platform)} hook ${op} --harness ${harness}`, timeout })
  const server = { name: TOOL, command: [binary, 'mcp'] }
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
  if (others.length > 0) steps.push(...(await agents.installIntegration(integration({ ...source, platform: options.ctx?.platform }), { ...options, agents: others })))
  return { targets, steps }
}

export async function uninstallAgents(wanted, source, options = {}) {
  const agents = await kitAgents()
  const targets = await resolveTargets(agents, wanted, options)
  const steps = []
  if (targets.includes('claude')) steps.push(...(await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)))
  const others = targets.filter((agent) => agent !== 'claude')
  if (others.length > 0) steps.push(...(await agents.uninstallIntegration(integration({ ...source, platform: options.ctx?.platform }), { ...options, agents: others })))
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
