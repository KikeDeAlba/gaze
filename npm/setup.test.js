import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { ANTIGRAVITY_RULES, SKILL_DIR, installAgents, integration, parseArgs, runSetup, selection, shellCommand, uninstallAgents, UsageError } from './setup.js'

const KNOWN = ['claude', 'opencode', 'codex', 'gemini', 'antigravity', 'claude-desktop']
const BINARY = '/opt/gaze pkg/vendor/gaze'

function sandbox() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'gaze-setup-test-')))
  const calls = []
  const options = {
    ctx: platformContext({ platform: 'darwin', home, env: { HOME: home, PATH: '' } }),
    locate: async () => null,
    exec: async (command, args) => {
      calls.push([command, ...args])
      return ''
    },
  }
  return { home, calls, options }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function commands(groups) {
  return (groups ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
}

describe('arguments', () => {
  test('parses --agents, --remove and --json', () => {
    assert.deepEqual(parseArgs(['setup', '--agents', 'codex,gemini', '--json']), { remove: false, json: true, help: false, agents: ['codex', 'gemini'] })
    assert.deepEqual(parseArgs(['setup', '--agents=all', '--remove']).agents, ['all'])
    assert.equal(parseArgs(['setup', '--remove']).remove, true)
    assert.equal(parseArgs(['uninstall']).remove, true)
    assert.throws(() => parseArgs(['setup', '--agents']), UsageError)
    assert.throws(() => parseArgs(['setup', '--force']), UsageError)
  })

  test('resolves the agent selection', () => {
    assert.equal(selection(null, KNOWN, 'detected'), 'detected')
    assert.equal(selection(['all'], KNOWN, 'detected'), 'all')
    assert.deepEqual(selection(['none'], KNOWN, 'detected'), [])
    assert.deepEqual(selection(['codex', 'codex', 'antigravity'], KNOWN, 'detected'), ['codex', 'antigravity'])
    assert.throws(() => selection(['cursor'], KNOWN, 'detected'), /agente desconocido: cursor/)
  })

  test('quotes the binary for posix shells and PowerShell', () => {
    assert.equal(shellCommand(['/usr/local/bin/gaze'], 'linux'), '/usr/local/bin/gaze')
    assert.equal(shellCommand(["/tmp/it's here/gaze"], 'darwin'), `'/tmp/it'\\''s here/gaze'`)
    assert.equal(shellCommand(["C:\\Users\\o'neil\\gaze.exe"], 'win32'), "& 'C:\\Users\\o''neil\\gaze.exe'")
  })
})

describe('integration', () => {
  test('points the MCP server and the hooks at the absolute binary with the harness flag', () => {
    const spec = integration({ binary: BINARY, version: '1.2.3', platform: 'darwin' })
    assert.deepEqual(spec.mcp, [{ name: 'gaze', command: [BINARY, 'mcp'] }])
    assert.deepEqual(spec.claudeDesktop.mcp, spec.mcp)
    assert.deepEqual(spec.skills, [{ name: 'gaze', dir: SKILL_DIR }])
    assert.equal(spec.antigravity.rules, ANTIGRAVITY_RULES)
    assert.deepEqual(Object.keys(spec.codex.hooks), ['SessionStart', 'UserPromptSubmit'])
    assert.deepEqual(Object.keys(spec.gemini.hooks), ['SessionStart', 'BeforeAgent'])
    assert.deepEqual(commands(spec.codex.hooks.SessionStart), [`'${BINARY}' hook session-start --harness codex`])
    assert.deepEqual(commands(spec.codex.hooks.UserPromptSubmit), [`'${BINARY}' hook prompt --harness codex`])
    assert.deepEqual(commands(spec.gemini.hooks.SessionStart), [`'${BINARY}' hook session-start --harness gemini`])
    assert.deepEqual(commands(spec.gemini.hooks.BeforeAgent), [`'${BINARY}' hook prompt --harness gemini`])
    assert.equal(spec.claude, undefined)
  })

  test('ships the skill and a short always_on rule for Antigravity', () => {
    assert.ok(existsSync(path.join(SKILL_DIR, 'SKILL.md')))
    const rules = readFileSync(ANTIGRAVITY_RULES, 'utf8').trim().split('\n')
    assert.ok(rules.length >= 2 && rules.length <= 4, rules.join('\n'))
    assert.match(rules.join(' '), /gaze_search/)
  })

  test('installs skill, MCP and hooks in the non-Claude agents and removes them again', async () => {
    const { home, calls, options } = sandbox()
    const desktop = path.join(home, 'Library', 'Application Support', 'Claude')
    mkdirSync(desktop, { recursive: true })
    const source = { binary: BINARY, version: '1.2.3' }
    const { steps } = await installAgents(['codex', 'gemini', 'opencode', 'antigravity', 'claude-desktop'], source, options)
    assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])

    assert.equal(realpathSync(path.join(home, '.agents', 'skills', 'gaze')), realpathSync(SKILL_DIR))
    assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.gaze\]\ncommand = "\/opt\/gaze pkg\/vendor\/gaze"\nargs = \["mcp"\]/)
    const codexHooks = readJson(path.join(home, '.codex', 'hooks.json')).hooks
    assert.deepEqual(commands(codexHooks.UserPromptSubmit), [`'${BINARY}' hook prompt --harness codex`])

    const extension = path.join(home, '.gemini', 'extensions', 'gaze')
    assert.deepEqual(readJson(path.join(extension, 'gemini-extension.json')).mcpServers.gaze, { command: BINARY, args: ['mcp'] })
    assert.deepEqual(commands(readJson(path.join(extension, 'hooks', 'hooks.json')).hooks.BeforeAgent), [`'${BINARY}' hook prompt --harness gemini`])
    assert.ok(existsSync(path.join(extension, 'skills', 'gaze', 'SKILL.md')))

    assert.deepEqual(readJson(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.gaze.command, [BINARY, 'mcp'])

    const plugin = path.join(home, '.local', 'share', 'kikedealba', 'agents', 'antigravity', 'gaze')
    assert.match(readFileSync(path.join(plugin, 'rules', 'gaze.md'), 'utf8'), /^---\ntrigger: always_on\n---\n/)
    assert.ok(existsSync(path.join(plugin, 'skills', 'gaze', 'SKILL.md')))
    const agyMcp = readJson(path.join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers.gaze
    assert.equal(agyMcp.command, BINARY)
    assert.deepEqual(agyMcp.args, ['mcp'])

    assert.deepEqual(readJson(path.join(desktop, 'claude_desktop_config.json')).mcpServers.gaze.args, ['mcp'])
    assert.equal(existsSync(path.join(home, '.claude', 'skills', 'gaze')), false)
    assert.deepEqual(calls, [])

    await uninstallAgents('all', source, options)
    assert.equal(existsSync(path.join(home, '.agents', 'skills', 'gaze')), false)
    assert.doesNotMatch(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.gaze/)
    assert.equal(readJson(path.join(home, '.codex', 'hooks.json')).hooks.UserPromptSubmit, undefined)
    assert.equal(existsSync(extension), false)
    assert.equal(readJson(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.gaze, undefined)
    assert.equal(readJson(path.join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers.gaze, undefined)
    assert.equal(readJson(path.join(desktop, 'claude_desktop_config.json')).mcpServers.gaze, undefined)
  })

  test('Claude only gets the plugin, never loose skills, MCP or hooks', async () => {
    const { home, calls, options } = sandbox()
    const located = { ...options, locate: async (command) => (command === 'claude' ? '/bin/claude' : null) }
    const { steps } = await installAgents(['claude'], { binary: BINARY, version: '1.2.3' }, located)
    assert.ok(steps.length > 0)
    assert.ok(calls.length > 0)
    assert.ok(calls.every(([, sub]) => sub === 'plugin'), JSON.stringify(calls))
    assert.ok(calls.some((call) => call.join(' ').includes('gaze@gaze')), JSON.stringify(calls))
    assert.equal(existsSync(path.join(home, '.claude', 'skills')), false)
    assert.equal(existsSync(path.join(home, '.claude', 'settings.json')), false)
  })
})

describe('runSetup', { skip: process.platform === 'win32' }, () => {
  function fakeBinary(exit = 0) {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gaze-setup-bin-')))
    const file = path.join(dir, 'gaze')
    writeFileSync(file, `#!/bin/sh\necho "$*" >> "${dir}/log"\nif [ "$2" = "--json" ]; then echo '{"ok":true,"command":"'$1'","data":{"manifest":"m"}}'; else echo "native $1"; fi\nexit ${exit}\n`)
    chmodSync(file, 0o755)
    return { file, log: () => readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n') }
  }

  function capture() {
    const out = { stdout: '', stderr: '' }
    return { out, write: (text) => (out.stdout += text), fail: (text) => (out.stderr += text) }
  }

  test('runs the native setup and adds the integration steps to the JSON envelope', async () => {
    const { home, options } = sandbox()
    const bin = fakeBinary()
    const io = capture()
    const code = await runSetup(['setup', '--agents', 'codex', '--json'], bin.file, { ...io, version: '1.2.3', install: options })
    assert.equal(code, 0, io.out.stderr)
    assert.deepEqual(bin.log(), ['setup --json'])
    const result = JSON.parse(io.out.stdout)
    assert.equal(result.data.manifest, 'm')
    assert.ok(result.data.integrations.some((step) => step.agent === 'codex' && step.item === 'mcp gaze' && step.state === 'installed'))
    assert.ok(existsSync(path.join(home, '.codex', 'hooks.json')))
  })

  test('--remove runs the native uninstall and removes the integrations', async () => {
    const { home, options } = sandbox()
    const bin = fakeBinary()
    await runSetup(['setup', '--agents', 'codex'], bin.file, { ...capture(), version: '1.2.3', install: options })
    const io = capture()
    const code = await runSetup(['setup', '--remove', '--agents', 'codex'], bin.file, { ...io, version: '1.2.3', install: options })
    assert.equal(code, 0, io.out.stderr)
    assert.deepEqual(bin.log(), ['setup', 'uninstall'])
    assert.match(io.out.stdout, /codex +mcp gaze: quitado/)
    assert.equal(existsSync(path.join(home, '.agents', 'skills', 'gaze')), false)
  })

  test('stops before the integrations when the native step fails', async () => {
    const { home, options } = sandbox()
    const bin = fakeBinary(4)
    const code = await runSetup(['setup', '--agents', 'codex'], bin.file, { ...capture(), version: '1.2.3', install: options })
    assert.equal(code, 4)
    assert.equal(existsSync(path.join(home, '.codex')), false)
  })

  test('rejects unknown agents before touching anything', async () => {
    const bin = fakeBinary()
    const io = capture()
    assert.equal(await runSetup(['setup', '--agents', 'cursor'], bin.file, io), 2)
    assert.match(io.out.stderr, /agente desconocido: cursor/)
    assert.equal(existsSync(path.join(path.dirname(bin.file), 'log')), false)
  })
})
