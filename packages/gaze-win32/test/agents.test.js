import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGENTS,
  HEADLESS_ENV,
  agentBin,
  binOverride,
  childEnv,
  detect,
  detectFromEnv,
  headless,
  invocation,
  parseAgent,
  parseOutput,
  projectDirVar,
  promptEvent,
  run,
} from '../src/agents.js'

const VARS = ['GAZE_HARVEST_BIN', 'GAZE_CLAUDE_BIN', 'GITHUB_TOKEN', HEADLESS_ENV, 'ANTIGRAVITY_CONVERSATION_ID', 'GEMINI_SESSION_ID', 'GEMINI_PROJECT_DIR', 'CODEX_THREAD_ID']
const SHIM = new URL('./fixtures/cmd-shims/npm11/codex.cmd', import.meta.url)
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-agents-')))
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function fakeProgram(name, source) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, `${name}.js`), source)
    const shim = fs.readFileSync(SHIM, 'utf8').replace('node_modules\\@openai\\codex\\bin\\codex.js', `${name}.js`)
    const file = path.join(dir, `${name}.cmd`)
    fs.writeFileSync(file, shim)
    return file
  }
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

const detectWith = (flag, vars) => detect(flag, (name) => vars.includes(name))

test('parses ids and aliases', () => {
  for (const agent of AGENTS) assert.equal(parseAgent(agent), agent)
  assert.equal(parseAgent('agy'), 'antigravity')
  assert.equal(parseAgent(' Claude-Code '), 'claude')
  assert.equal(parseAgent('cursor'), null)
  assert.equal(agentBin('antigravity'), 'agy')
  assert.equal(agentBin('codex'), 'codex')
  assert.equal(projectDirVar('claude'), 'CLAUDE_PROJECT_DIR')
  assert.equal(projectDirVar('gemini'), 'GEMINI_PROJECT_DIR')
  assert.equal(projectDirVar('codex'), null)
  assert.equal(promptEvent('gemini'), 'BeforeAgent')
  assert.equal(promptEvent('opencode'), 'UserPromptSubmit')
})

test('detects the harness from flag then exact markers', () => {
  assert.equal(detectWith('codex', ['CLAUDECODE']), 'codex')
  assert.equal(detectWith('bogus', ['GEMINI_SESSION_ID']), 'gemini')
  assert.equal(detectWith(null, ['ANTIGRAVITY_CONVERSATION_ID', 'GEMINI_SESSION_ID', 'CLAUDECODE']), 'antigravity')
  assert.equal(detectWith(null, ['GEMINI_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE']), 'gemini')
  assert.equal(detectWith(null, ['CODEX_THREAD_ID', 'CLAUDECODE']), 'codex')
  assert.equal(detectWith(null, ['CODEX_HOME', 'GEMINI_CLI', 'CLAUDECODE']), 'claude')
  assert.equal(detectWith(null, []), 'claude')
})

test('detect from env ignores empty markers and headless reads kit headless', () => {
  for (const name of VARS) delete process.env[name]
  process.env.CODEX_THREAD_ID = ''
  assert.equal(detectFromEnv(undefined), 'claude')
  process.env.CODEX_THREAD_ID = 't'
  assert.equal(detectFromEnv(undefined), 'codex')
  assert.equal(detectFromEnv('gemini'), 'gemini')
  assert.equal(headless(), false)
  process.env[HEADLESS_ENV] = '0'
  assert.equal(headless(), false)
  process.env[HEADLESS_ENV] = '1'
  assert.equal(headless(), true)
})

test('bin override prefers harvest bin and claude bin only for claude', () => {
  for (const name of VARS) delete process.env[name]
  assert.equal(binOverride('claude'), null)
  process.env.GAZE_CLAUDE_BIN = '/x/claude'
  assert.equal(binOverride('claude'), '/x/claude')
  assert.equal(binOverride('codex'), null)
  process.env.GAZE_HARVEST_BIN = '/x/h'
  assert.equal(binOverride('codex'), '/x/h')
  process.env.GAZE_HARVEST_BIN = ''
  assert.equal(binOverride('claude'), '/x/claude')
})

test('invocations send the prompt by stdin in read only modes', () => {
  const cwd = '/tmp/w'
  const secret = 'TRANSCRIPT-SECRET'
  const claude = invocation('claude', 'claude', secret, null, cwd)
  assert.deepEqual(claude.args.slice(0, 9), ['-p', '--model', 'haiku', '--output-format', 'json', '--permission-mode', 'plan', '--setting-sources', 'user'])
  assert.deepEqual(claude.args.slice(9), ['--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'])
  assert.deepEqual(claude.env, [['CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1'], [HEADLESS_ENV, '1']])
  assert.equal(invocation('claude', 'claude', secret, ' sonnet ', cwd).args[2], 'sonnet')
  assert.equal(invocation('claude', 'claude', secret, '  ', cwd).args[2], 'haiku')
  const codex = invocation('codex', 'codex', secret, 'o4', cwd)
  assert.deepEqual(codex.args, ['exec', '--json', '-C', '/tmp/w', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'o4', '-'])
  const gemini = invocation('gemini', 'gemini', secret, null, cwd)
  assert.deepEqual(gemini.args, ['-o', 'json', '--approval-mode', 'plan'])
  assert.ok(!gemini.env.some(([k]) => k === 'GEMINI_CLI_TRUST_WORKSPACE'))
  const agy = invocation('antigravity', 'agy', secret, 'm', cwd)
  assert.deepEqual(agy.args, ['--mode', 'plan', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'm', '-p='])
  assert.deepEqual(JSON.parse(agy.stdin.trim()), { event: 'user', message: { content: secret } })
  assert.ok(agy.stdin.endsWith('\n'))
  const opencode = invocation('opencode', 'opencode', secret, 'a/b', cwd)
  assert.deepEqual(opencode.args, ['run', '--format', 'json', '--agent', 'plan', '-m', 'a/b'])
  for (const spec of [claude, codex, gemini, agy, opencode]) {
    assert.ok(spec.env.some(([k, v]) => k === HEADLESS_ENV && v === '1'))
    assert.ok(spec.args.every((arg) => !arg.includes(secret)), JSON.stringify(spec.args))
    assert.ok(spec.stdin.includes(secret))
  }
})

const kept = (agent, names) => Object.keys(childEnv(agent, names.map((name) => [name, 'v'])))

test('child env only carries the invoked agent credentials', () => {
  const common = ['PATH', 'HOME', 'USER', 'https_proxy', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'LC_ALL', 'NVM_DIR']
  const secrets = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN']
  const all = [...common, ...secrets]
  const claude = kept('claude', all)
  assert.deepEqual(claude, [...common, 'ANTHROPIC_API_KEY'])
  assert.ok(!claude.includes('OPENAI_API_KEY'))
  assert.deepEqual(kept('codex', all), [...common, 'OPENAI_API_KEY'])
  assert.deepEqual(kept('gemini', all), [...common, 'GEMINI_API_KEY'])
  assert.deepEqual(kept('antigravity', all), [...common, 'GEMINI_API_KEY'])
  assert.deepEqual(kept('opencode', all), common)
  assert.deepEqual(kept('claude', ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'GOOGLE_CLOUD_PROJECT']), ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION'])
  assert.deepEqual(kept('claude', ['CLAUDE_CODE_USE_VERTEX', 'CLOUD_ML_REGION', 'GOOGLE_CLOUD_PROJECT', 'AWS_REGION']), ['CLAUDE_CODE_USE_VERTEX', 'CLOUD_ML_REGION', 'GOOGLE_CLOUD_PROJECT'])
  assert.deepEqual(kept('gemini', ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS']), ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'])
})

test('child env keeps windows spellings and ignores empty markers', () => {
  const env = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'cmd.exe', PathExt: '.EXE', CLAUDE_CODE_USE_BEDROCK: '', AWS_REGION: 'x', USERDOMAIN: 'd' }
  assert.deepEqual(Object.keys(childEnv('claude', env)), ['Path', 'SystemRoot', 'windir', 'ComSpec', 'PathExt', 'CLAUDE_CODE_USE_BEDROCK'])
})

test('parses each agent output', () => {
  assert.equal(parseOutput('claude', JSON.stringify({ result: '[1]' })), '[1]')
  assert.equal(parseOutput('claude', 'warn {"result":"x"} tail'), 'x')
  assert.equal(parseOutput('claude', '{"result":3}'), null)
  const codex = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { type: 'error', message: 'x' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'last' } },
  ]
    .map((v) => JSON.stringify(v))
    .join('\n')
  assert.equal(parseOutput('codex', codex), 'last')
  assert.equal(parseOutput('gemini', `Loaded cached credentials.\n${JSON.stringify({ response: 'g' })}`), 'g')
  const agy = [
    { event: 'init', conversation_id: 'c' },
    { event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'a' } },
  ]
    .map((v) => JSON.stringify(v))
    .join('\n')
  assert.equal(parseOutput('antigravity', agy), 'a')
  assert.equal(parseOutput('antigravity', JSON.stringify({ response: 'fallback' })), 'fallback')
  const opencode = [
    { type: 'text', part: { messageID: 'm1', text: 'PONG' } },
    { type: 'step_finish' },
    { type: 'text', part: { messageID: 'm2', text: 'he' } },
    { type: 'text', part: { messageID: 'm2', text: 'llo' } },
  ]
    .map((v) => JSON.stringify(v))
    .join('\n')
  assert.equal(parseOutput('opencode', opencode), 'hello')
  assert.equal(parseOutput('opencode', ''), null)
})

const READ_STDIN = "const readAll = () => new Promise((r) => { let n = 0; process.stdin.on('data', (d) => { n += d.length }); process.stdin.on('end', () => r(n)) });"

test('runs fake agents without deadlocks or leaked env', async () => {
  const guard = fakeProgram('guard', `${READ_STDIN} readAll().then(() => process.stdout.write(JSON.stringify({ result: (process.env.KIT_HEADLESS ?? '') + '|' + (process.env.GITHUB_TOKEN ?? 'none') })))`)
  const noisy = fakeProgram('noisy', `${READ_STDIN} process.stderr.write('x'.repeat(2000000)); readAll().then(() => process.stdout.write('{"result":"ok"}'))`)
  const deaf = fakeProgram('deaf', `process.stdout.write('{"result":"early"}'); process.exit(0)`)
  const lingering = fakeProgram(
    'lingering',
    `${READ_STDIN} readAll().then(() => { require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref(); process.stdout.write('{"result":"done"}'); process.exit(0) })`,
  )
  const stuck = fakeProgram('stuck', `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); setTimeout(() => {}, 30000)`)
  const failing = fakeProgram('failing', `${READ_STDIN} readAll().then(() => { process.stderr.write('boom\\n'); process.exit(3) })`)
  const big = 'y'.repeat(4000000)
  process.env.GITHUB_TOKEN = 'leak'
  const cases = [
    [guard, 'hola', '1|none', 20000],
    [noisy, big, 'ok', 20000],
    [deaf, big, 'early', 20000],
    [failing, 'x', 'FAILED:boom', 20000],
    [lingering, 'x', 'done', 20000],
    [stuck, 'x', 'TIMEOUT', 1000],
  ]
  for (const [bin, prompt, expected, timeoutMs] of cases) {
    process.env.GAZE_HARVEST_BIN = bin
    const started = Date.now()
    const outcome = await run('claude', prompt, null, dir, timeoutMs, [])
    assert.ok(Date.now() - started < 15000, `${bin} took ${Date.now() - started}ms`)
    const got = outcome.type === 'text' ? outcome.text : outcome.type === 'failed' ? `FAILED:${outcome.stderr.trim()}` : 'TIMEOUT'
    assert.equal(got, expected, bin)
  }
})

test('run passes extra env, prepends the program dir to path and rejects empty output', async () => {
  const probe = fakeProgram('probe', `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: [process.env.GAZE_HARVESTING, process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, (process.env.PATH ?? process.env.Path).split(require('node:path').delimiter)[0]].join('|') })))`)
  const silent = fakeProgram('silent', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('not json'))")
  process.env.GAZE_HARVEST_BIN = probe
  const outcome = await run('claude', 'p', null, dir, 20000, [['GAZE_HARVESTING', '1']])
  assert.deepEqual(outcome, { type: 'text', text: `1|1|${dir}` })
  process.env.GAZE_HARVEST_BIN = silent
  await assert.rejects(run('codex', 'p', null, dir, 20000), { message: 'codex devolvió una salida sin texto: not json' })
  process.env.GAZE_HARVEST_BIN = path.join(dir, 'nonexistent-agent')
  await assert.rejects(run('claude', 'p', null, dir, 20000), /spawn/)
})

test('run drops relative, empty and dot entries from the child path', async () => {
  const probe = fakeProgram('pathprobe', `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: process.env.PATH ?? process.env.Path })))`)
  const original = process.env.PATH
  const node = path.dirname(process.execPath)
  process.env.PATH = ['.', '', path.join('rel', 'dir'), node, `.${path.sep}x`].join(path.delimiter)
  process.env.GAZE_HARVEST_BIN = probe
  try {
    const outcome = await run('claude', 'p', null, dir, 20000)
    assert.deepEqual(outcome.text.split(path.delimiter), [path.dirname(probe), node])
  } finally {
    process.env.PATH = original
  }
})

test('run reports programs it cannot prepare as spawn errors', async () => {
  process.env.GAZE_HARVEST_BIN = 'gaze-missing-agent'
  await assert.rejects(run('claude', 'p', null, dir, 20000, [], { platform: 'win32' }), (error) => {
    assert.equal(error.message, 'spawn gaze-missing-agent')
    assert.equal(error.cause.code, 'ENOENT')
    return true
  })
  const odd = path.join(dir, '100%')
  fs.mkdirSync(odd, { recursive: true })
  const bat = path.join(odd, 'agent.bat')
  fs.writeFileSync(bat, '@echo off\r\n')
  process.env.GAZE_HARVEST_BIN = bat
  await assert.rejects(run('claude', 'p', null, dir, 20000, [], { platform: 'win32' }), (error) => {
    assert.equal(error.message, `spawn ${bat}`)
    assert.match(error.cause.message, /unsafe argument/)
    return true
  })
})
