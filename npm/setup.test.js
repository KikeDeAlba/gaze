import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { ANTIGRAVITY_RULES, SHIM, SKILL_DIR, formatSteps, hookLauncher, installAgents, integration, launcher, ownHook, parseArgs, pointsToShim, purgeHooks, runSetup, selection, shellCommand, uninstallAgents, UsageError, windowsRooted } from './setup.js'

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
    assert.equal(shellCommand(['C:\\Users\\ana\\gaze.exe'], 'win32'), 'C:\\Users\\ana\\gaze.exe')
    assert.equal(shellCommand(["C:\\Program Files\\o'neil\\gaze.exe"], 'win32'), `"C:\\Program Files\\o'neil\\gaze.exe"`)
  })
})

describe('integration', () => {
  test('points the MCP server and the hooks at the absolute binary with the harness flag', () => {
    const spec = integration({ command: [BINARY], version: '1.2.3', platform: 'darwin' })
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

describe('launcher and old installs', () => {
  test('uses the bare gaze command only when gaze on the PATH is this shim', { skip: process.platform === 'win32' }, async () => {
    const { home } = sandbox()
    const ours = path.join(home, 'ours')
    const other = path.join(home, 'other')
    mkdirSync(ours)
    mkdirSync(other)
    symlinkSync(SHIM, path.join(ours, 'gaze'))
    writeFileSync(path.join(other, 'gaze'), '#!/bin/sh\n')
    chmodSync(path.join(other, 'gaze'), 0o755)
    const ctx = (dir) => platformContext({ platform: 'darwin', home, env: { HOME: home, PATH: dir } })
    assert.deepEqual(await launcher(BINARY, { ctx: ctx(ours) }), ['gaze'])
    assert.deepEqual(await launcher(BINARY, { ctx: ctx(other) }), [BINARY])
    assert.deepEqual(await launcher(BINARY, { ctx: ctx('') }), [BINARY])
    const spec = integration({ command: ['gaze'], version: '1.2.3', platform: 'darwin' })
    assert.deepEqual(spec.mcp, [{ name: 'gaze', command: ['gaze', 'mcp'] }])
    assert.deepEqual(commands(spec.codex.hooks.SessionStart), ['gaze hook session-start --harness codex'])
  })

  test('always uses the absolute vendor binary on Windows', async () => {
    const { home } = sandbox()
    const ctx = platformContext({ platform: 'win32', home, env: { USERPROFILE: home, PATH: '' } })
    assert.deepEqual(await launcher('C:\\pkg\\vendor\\gaze.exe', { ctx }), ['C:\\pkg\\vendor\\gaze.exe'])
    assert.deepEqual(await launcher(path.join('vendor', 'gaze.exe'), { ctx }), [path.resolve('vendor', 'gaze.exe')])
  })

  test('every Windows hook prefix carries a path, never a bare name', async () => {
    const { home } = sandbox()
    const ctx = platformContext({ platform: 'win32', home, env: { USERPROFILE: home, PATH: '' } })
    for (const bare of [['gaze'], ['gaze.cmd'], ['node', SHIM], ['.\\gaze.exe'], ['C:gaze.exe']]) {
      await assert.rejects(hookLauncher(bare, { ctx }), /absolute launcher/)
    }
    for (const binary of [SHIM, 'C:\\pkg\\vendor\\gaze.exe', path.join('vendor', 'gaze.exe')]) {
      const { prefix } = await hookLauncher(await launcher(binary, { ctx }), { ctx })
      const first = prefix.startsWith('"') ? prefix.slice(1, prefix.indexOf('"', 1)) : prefix.split(' ')[0]
      assert.notEqual(path.win32.basename(first), first, prefix)
      assert.ok(windowsRooted(first), prefix)
    }
  })

  test('runs the port with node and npm/gaze.js on Windows', async () => {
    const { home } = sandbox()
    const ours = path.join(home, 'ours')
    mkdirSync(ours)
    if (process.platform !== 'win32') symlinkSync(SHIM, path.join(ours, 'gaze'))
    const ctx = platformContext({ platform: 'win32', home, env: { USERPROFILE: home, PATH: ours } })
    assert.deepEqual(await launcher(SHIM, { ctx }), [process.execPath, SHIM])
    assert.deepEqual(await launcher(realpathSync(SHIM), { ctx }), [process.execPath, realpathSync(SHIM)])
  })

  test('uses node and npm/gaze.js elsewhere unless gaze on the PATH is this shim', { skip: process.platform === 'win32' }, async () => {
    const { home } = sandbox()
    const ours = path.join(home, 'ours')
    mkdirSync(ours)
    symlinkSync(SHIM, path.join(ours, 'gaze'))
    const ctx = (dir) => platformContext({ platform: 'darwin', home, env: { HOME: home, PATH: dir } })
    assert.deepEqual(await launcher(SHIM, { ctx: ctx('') }), [process.execPath, SHIM])
    assert.deepEqual(await launcher(SHIM, { ctx: ctx(ours) }), ['gaze'])
  })

  test('quotes node and the shim for Windows hooks and keeps the MCP server as argv', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const shim = 'C:\\Users\\Ana Maria\\AppData\\Roaming\\npm\\node_modules\\@kikedealba\\gaze\\npm\\gaze.js'
    const spec = integration({ command: [node, shim], version: '1.2.3', platform: 'win32' })
    assert.deepEqual(spec.mcp, [{ name: 'gaze', command: [node, shim, 'mcp'] }])
    assert.deepEqual(spec.claudeDesktop.mcp, spec.mcp)
    const prompt = `"${node}" "${shim}" hook prompt --harness codex`
    assert.deepEqual(commands(spec.codex.hooks.UserPromptSubmit), [prompt])
    assert.deepEqual(commands(spec.gemini.hooks.SessionStart), [`"${node}" "${shim}" hook session-start --harness gemini`])
    assert.equal(ownHook(prompt, 'codex'), true)
    const plain = integration({ command: ['C:\\nvm4w\\nodejs\\node.exe', 'C:\\npm\\node_modules\\@kikedealba\\gaze\\npm\\gaze.js'], version: '1.2.3', platform: 'win32' })
    assert.deepEqual(commands(plain.codex.hooks.UserPromptSubmit), ['C:\\nvm4w\\nodejs\\node.exe C:\\npm\\node_modules\\@kikedealba\\gaze\\npm\\gaze.js hook prompt --harness codex'])
  })

  test('leaves plain Windows paths unquoted and quotes the ones PowerShell or cmd would split', () => {
    assert.equal(shellCommand(['C:\\nodejs\\node.exe', 'C:\\npm\\node_modules\\@kikedealba\\gaze\\npm\\gaze.js'], 'win32'), 'C:\\nodejs\\node.exe C:\\npm\\node_modules\\@kikedealba\\gaze\\npm\\gaze.js')
    assert.equal(shellCommand(['C:\\a,b\\node.exe'], 'win32'), '"C:\\a,b\\node.exe"')
    assert.equal(shellCommand(['C:\\%USER%\\node.exe'], 'win32'), '"C:\\%USER%\\node.exe"')
  })

  test('picks the hook prefix for Windows: plain paths, then the npm gaze.cmd shim, then quotes with a warning', async () => {
    const { home: tmp } = sandbox()
    const home = process.platform === 'win32' ? realpathSync.native(tmp) : tmp
    const npmDir = path.join(home, 'npm')
    const spacedNpm = path.join(home, 'npm prefix')
    for (const prefixDir of [npmDir, spacedNpm]) {
      const pkg = path.join(prefixDir, 'node_modules', '@kikedealba', 'gaze')
      mkdirSync(path.dirname(pkg), { recursive: true })
      symlinkSync(path.dirname(path.dirname(SHIM)), pkg, 'junction')
    }
    const cmdShim = (target) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`
    for (const prefixDir of [npmDir, spacedNpm]) writeFileSync(path.join(prefixDir, 'gaze.cmd'), cmdShim('node_modules\\@kikedealba\\gaze\\npm\\gaze.js'))
    const other = path.join(home, 'other')
    mkdirSync(other)
    writeFileSync(path.join(other, 'gaze.cmd'), cmdShim('node_modules\\someone-else\\gaze.js'))
    const ctx = (dirs) => platformContext({ platform: 'win32', home, env: { USERPROFILE: home, Path: dirs.join(';') } })
    const spaced = ['C:\\Program Files\\nodejs\\node.exe', SHIM]

    assert.deepEqual(await hookLauncher(['C:\\nodejs\\node.exe', 'C:\\npm\\gaze.js'], { ctx: ctx([]) }), { prefix: 'C:\\nodejs\\node.exe C:\\npm\\gaze.js' })
    const ownCmd = path.join(npmDir, 'gaze.cmd')
    assert.match(ownCmd, /^[A-Za-z0-9_@+=:./\\-]+$/)
    assert.deepEqual(await hookLauncher(spaced, { ctx: ctx([`"${npmDir}"`]) }), { prefix: ownCmd })
    const quotedCmd = await hookLauncher(spaced, { ctx: ctx([spacedNpm]) })
    assert.equal(quotedCmd.prefix, shellCommand(spaced, 'win32'))
    assert.match(quotedCmd.warning, /PowerShell no/)
    const previous = process.cwd()
    process.chdir(npmDir)
    try {
      for (const relative of ['.', path.join('..', 'npm')]) {
        const planted = await hookLauncher(spaced, { ctx: ctx([relative]) })
        assert.equal(planted.prefix, shellCommand(spaced, 'win32'))
        assert.ok(planted.warning)
      }
    } finally {
      process.chdir(previous)
    }
    assert.deepEqual(await hookLauncher(spaced, { ctx: ctx([other, npmDir]) }).then(({ prefix }) => prefix), shellCommand(spaced, 'win32'))

    for (const dirs of [[], [other]]) {
      const { prefix, warning } = await hookLauncher(spaced, { ctx: ctx(dirs) })
      assert.equal(prefix, `"C:\\Program Files\\nodejs\\node.exe" ${shellCommand([SHIM], 'win32')}`)
      assert.match(warning, /gaze\.cmd de npm no está en el PATH.*PowerShell no/)
    }
    const native = await hookLauncher(['C:\\Program Files\\gaze\\gaze.exe'], { ctx: ctx([npmDir]) })
    assert.equal(native.prefix, '"C:\\Program Files\\gaze\\gaze.exe"')
    assert.ok(native.warning)
    assert.deepEqual(await hookLauncher(['/opt/my node/node', SHIM], { ctx: platformContext({ platform: 'darwin', home, env: { HOME: home, PATH: npmDir } }) }), { prefix: shellCommand(['/opt/my node/node', SHIM], 'darwin') })
  })

  test('hooks take the gaze.cmd prefix while the MCP server keeps node and the shim as argv', () => {
    const command = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\gaze.js']
    const spec = integration({ command, hookPrefix: 'gaze.cmd', version: '1.2.3', platform: 'win32' })
    assert.deepEqual(spec.mcp, [{ name: 'gaze', command: [...command, 'mcp'] }])
    assert.deepEqual(commands(spec.codex.hooks.UserPromptSubmit), ['gaze.cmd hook prompt --harness codex'])
    assert.deepEqual(commands(spec.gemini.hooks.BeforeAgent), ['gaze.cmd hook prompt --harness gemini'])
    assert.equal(ownHook('gaze.cmd hook prompt --harness codex', 'codex'), true)
    assert.match(formatSteps([{ agent: 'codex', item: 'hooks', state: 'warning', detail: 'x' }], false), /codex {2}hooks: aviso \(x\)/)
  })

  test('installs the MCP server and the hooks as node plus npm/gaze.js and swaps the hooks of another node', async () => {
    const { home, options } = sandbox()
    const desktop = path.join(home, 'Library', 'Application Support', 'Claude')
    mkdirSync(desktop, { recursive: true })
    const hooksFile = path.join(home, '.codex', 'hooks.json')
    mkdirSync(path.dirname(hooksFile), { recursive: true })
    const stale = `'/old node/bin/node' ${SHIM} hook prompt --harness codex`
    writeFileSync(hooksFile, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: stale }] }] } }))
    const source = { binary: SHIM, version: '1.2.3' }
    const { steps } = await installAgents(['codex', 'gemini', 'opencode', 'antigravity', 'claude-desktop'], source, options)
    assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
    const mcp = { command: process.execPath, args: [SHIM, 'mcp'] }
    const hook = `${shellCommand([process.execPath, SHIM], 'darwin')} hook prompt --harness codex`
    assert.ok(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').includes(`command = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(SHIM)}, "mcp"]`))
    assert.deepEqual(commands(readJson(hooksFile).hooks.UserPromptSubmit), [hook])
    const extension = path.join(home, '.gemini', 'extensions', 'gaze')
    assert.deepEqual(readJson(path.join(extension, 'gemini-extension.json')).mcpServers.gaze, mcp)
    assert.deepEqual(commands(readJson(path.join(extension, 'hooks', 'hooks.json')).hooks.BeforeAgent), [`${shellCommand([process.execPath, SHIM], 'darwin')} hook prompt --harness gemini`])
    assert.deepEqual(readJson(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.gaze.command, [process.execPath, SHIM, 'mcp'])
    for (const file of [path.join(home, '.gemini', 'config', 'mcp_config.json'), path.join(desktop, 'claude_desktop_config.json')]) {
      const { command, args } = readJson(file).mcpServers.gaze
      assert.deepEqual({ command, args }, mcp)
    }

    await uninstallAgents('all', source, options)
    assert.equal(readJson(hooksFile).hooks.UserPromptSubmit, undefined)
    assert.equal(readJson(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.gaze, undefined)
  })

  test('tells gaze hooks apart from foreign ones regardless of the path', () => {
    assert.equal(ownHook("'/old/node/lib/node_modules/@kikedealba/gaze/vendor/gaze' hook prompt --harness codex", 'codex'), true)
    assert.equal(ownHook('/old/vendor/gaze hook session-start --harness codex', 'codex'), true)
    assert.equal(ownHook('gaze hook prompt --harness codex', 'codex'), true)
    assert.equal(ownHook("& 'C:\\old\\vendor\\gaze.exe' hook prompt --harness codex", 'codex'), true)
    assert.equal(ownHook('"C:\\Program Files\\gaze\\vendor\\gaze.exe" hook prompt --harness gemini', 'gemini'), true)
    assert.equal(ownHook('/usr/bin/node /pkg/npm/gaze.js hook prompt --harness codex', 'codex'), true)
    assert.equal(ownHook('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ana Maria\\npm\\gaze.js" hook prompt --harness gemini', 'gemini'), true)
    assert.equal(ownHook('node /pkg/notgaze.js hook prompt --harness codex', 'codex'), false)
    assert.equal(ownHook('bita hook prompt --harness codex', 'codex'), false)
    assert.equal(ownHook('notgaze hook prompt --harness codex', 'codex'), false)
    assert.equal(ownHook('gaze hook prompt --harness gemini', 'codex'), false)
    const existing = { UserPromptSubmit: [{ hooks: [{ command: 'gaze hook prompt --harness codex' }] }, { hooks: [{ command: 'other' }] }] }
    assert.deepEqual(purgeHooks(existing, 'codex', new Set(['gaze hook prompt --harness codex'])).removed, 0)
    assert.deepEqual(purgeHooks(existing, 'codex').hooks, { UserPromptSubmit: [{ hooks: [{ command: 'other' }] }] })
  })

  test('setup replaces codex hooks from an older vendor path and uninstall removes them', async () => {
    const { home, options } = sandbox()
    const file = path.join(home, '.codex', 'hooks.json')
    mkdirSync(path.dirname(file), { recursive: true })
    const old = "'/old node/vendor/gaze' hook prompt --harness codex"
    writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: old }] }, { hooks: [{ type: 'command', command: 'keep me' }] }] } }))
    const source = { binary: BINARY, version: '1.2.3' }
    const { steps } = await installAgents(['codex'], source, options)
    assert.ok(steps.some((step) => step.item === 'old hooks' && step.state === 'removed'))
    assert.deepEqual(commands(readJson(file).hooks.UserPromptSubmit), ['keep me', `'${BINARY}' hook prompt --harness codex`])
    const again = await installAgents(['codex'], source, options)
    assert.ok(again.steps.some((step) => step.item === 'hooks' && step.state === 'present'))
    assert.ok(!again.steps.some((step) => step.item === 'old hooks'))

    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/older/vendor/gaze hook session-start --harness codex' }] }], UserPromptSubmit: readJson(file).hooks.UserPromptSubmit } }))
    await uninstallAgents(['codex'], { binary: '/newer/vendor/gaze', version: '1.2.3' }, options)
    assert.deepEqual(readJson(file).hooks, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep me' }] }] })
    assert.equal(existsSync(path.join(home, '.codex', 'config.toml')) && readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').includes('mcp_servers.gaze'), false)
  })

  test('setup drops gaze hooks for gemini from another path and uninstall removes them', async () => {
    const { home, options } = sandbox()
    const settings = path.join(home, '.gemini', 'settings.json')
    mkdirSync(path.dirname(settings), { recursive: true })
    const foreign = { type: 'command', command: 'other hook' }
    writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: '/old/vendor/gaze hook prompt --harness gemini' }] }, { hooks: [foreign] }] } }))
    const { steps } = await installAgents(['gemini'], { binary: BINARY, version: '1.2.3' }, options)
    assert.ok(steps.some((step) => step.agent === 'gemini' && step.item === 'old hooks' && step.state === 'removed'))
    assert.deepEqual(readJson(settings), { theme: 'dark', hooks: { BeforeAgent: [{ hooks: [foreign] }] } })
    const extension = path.join(home, '.gemini', 'extensions', 'gaze', 'hooks', 'hooks.json')
    assert.deepEqual(commands(readJson(extension).hooks.BeforeAgent), [`'${BINARY}' hook prompt --harness gemini`])

    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "'/older/vendor/gaze' hook session-start --harness gemini" }] }], BeforeAgent: [{ hooks: [foreign] }] } }))
    const removed = await uninstallAgents(['gemini'], { binary: '/newer/vendor/gaze', version: '1.2.3' }, options)
    assert.ok(removed.steps.some((step) => step.item === 'old hooks' && step.state === 'removed'))
    assert.deepEqual(readJson(settings).hooks, { BeforeAgent: [{ hooks: [foreign] }] })
    assert.equal(existsSync(path.dirname(path.dirname(extension))), false)
  })
})

describe('runSetup', () => {
  function nativeSandbox() {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'gaze-setup-run-')))
    const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), PATH: '' }
    return { home, options: { ctx: platformContext({ home, env }), locate: async () => null, exec: async () => '' } }
  }

  function fakeBinary(exit = 0) {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gaze-setup-bin-')))
    const log = path.join(dir, 'log')
    const script = path.join(dir, 'fake.mjs')
    writeFileSync(script, `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
process.stdout.write(args[1] === '--json' ? JSON.stringify({ ok: true, command: args[0], data: { manifest: 'm' } }) + '\\n' : 'native ' + args[0] + '\\n')
process.exitCode = ${exit}
`)
    return { file: path.join(dir, process.platform === 'win32' ? 'gaze.exe' : 'gaze'), native: [process.execPath, script], log: () => readFileSync(log, 'utf8').trim().split('\n') }
  }

  function capture() {
    const out = { stdout: '', stderr: '' }
    return { out, write: (text) => (out.stdout += text), fail: (text) => (out.stderr += text) }
  }

  test('runs the native setup and adds the integration steps to the JSON envelope', async () => {
    const { home, options } = nativeSandbox()
    const bin = fakeBinary()
    const io = capture()
    const code = await runSetup(['setup', '--agents', 'codex', '--json'], bin.file, { ...io, native: bin.native, version: '1.2.3', install: options })
    assert.equal(code, 0, io.out.stderr)
    assert.deepEqual(bin.log(), ['setup --json'])
    const result = JSON.parse(io.out.stdout)
    assert.equal(result.data.manifest, 'm')
    assert.ok(result.data.integrations.some((step) => step.agent === 'codex' && step.item === 'mcp gaze' && step.state === 'installed'))
    assert.ok(existsSync(path.join(home, '.codex', 'hooks.json')))
  })

  test('--remove runs the native uninstall and removes the integrations', async () => {
    const { home, options } = nativeSandbox()
    const bin = fakeBinary()
    await runSetup(['setup', '--agents', 'codex'], bin.file, { ...capture(), native: bin.native, version: '1.2.3', install: options })
    const io = capture()
    const code = await runSetup(['setup', '--remove', '--agents', 'codex'], bin.file, { ...io, native: bin.native, version: '1.2.3', install: options })
    assert.equal(code, 0, io.out.stderr)
    assert.deepEqual(bin.log(), ['setup', 'uninstall'])
    assert.match(io.out.stdout, /codex +mcp gaze: quitado/)
    assert.equal(existsSync(path.join(home, '.agents', 'skills', 'gaze')), false)
  })

  test('stops before the integrations when the native step fails', async () => {
    const { home, options } = nativeSandbox()
    const bin = fakeBinary(4)
    const code = await runSetup(['setup', '--agents', 'codex'], bin.file, { ...capture(), native: bin.native, version: '1.2.3', install: options })
    assert.equal(code, 4)
    assert.equal(existsSync(path.join(home, '.codex')), false)
  })

  test('runs the port setup in the same process, capturing stdout only for --json', async () => {
    const { home, options } = nativeSandbox()
    const calls = []
    const native = async (argv, io) => {
      calls.push({ argv, stdout: io.stdout === process.stdout, stderr: io.stderr === process.stderr, stdin: typeof io.stdin?.on === 'function' })
      if (argv.includes('--json')) io.stdout.write(`${JSON.stringify({ ok: true, command: argv[0], data: { manifest: 'port' } })}\n`)
      return 0
    }
    const io = capture()
    assert.equal(await runSetup(['setup', '--agents', 'codex', '--json'], SHIM, { ...io, native, version: '1.2.3', install: options }), 0, io.out.stderr)
    const result = JSON.parse(io.out.stdout)
    assert.equal(result.data.manifest, 'port')
    assert.ok(result.data.integrations.some((step) => step.agent === 'codex' && step.item === 'mcp gaze' && step.state === 'installed'))
    assert.ok(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').includes(JSON.stringify(realpathSync(SHIM))))
    assert.equal(await runSetup(['uninstall', '--agents', 'codex'], SHIM, { ...capture(), native, version: '1.2.3', install: options }), 0)
    assert.deepEqual(calls, [
      { argv: ['setup', '--json'], stdout: false, stderr: true, stdin: true },
      { argv: ['uninstall'], stdout: true, stderr: true, stdin: true },
    ])
    const failing = async () => 5
    const { home: other, options: otherOptions } = nativeSandbox()
    assert.equal(await runSetup(['setup', '--agents', 'codex'], SHIM, { ...capture(), native: failing, install: otherOptions }), 5)
    assert.equal(existsSync(path.join(other, '.codex')), false)
  })

  test('rejects unknown agents before touching anything', async () => {
    const bin = fakeBinary()
    const io = capture()
    assert.equal(await runSetup(['setup', '--agents', 'cursor'], bin.file, { ...io, native: bin.native }), 2)
    assert.match(io.out.stderr, /agente desconocido: cursor/)
    assert.equal(existsSync(path.join(path.dirname(bin.file), 'log')), false)
  })
})
