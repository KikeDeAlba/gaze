import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SHIM_TARGET, commandFor, hardenEnv, superviseSync, supervisorArgs, killCommand, lastJsonLine, resolveProgram, runSync, shimTarget, spawnDetached, systemBinary } from '../src/proc.js'

const SHIMS = new URL('./fixtures/cmd-shims/', import.meta.url)
const TARGETS = {
  bita: '@kikedealba/bita/dist/bin/bita.js',
  recap: '@kikedealba/recap/dist/bin/recap.js',
  claude: '@anthropic-ai/claude-code/bin/claude.exe',
  codex: '@openai/codex/bin/codex.js',
  gemini: '@google/gemini-cli/bundle/gemini.js',
  opencode: 'opencode-ai/bin/opencode.exe',
}
const WIN = { platform: 'win32', execPath: 'C:\\node\\node.exe', comSpec: 'C:\\Windows\\system32\\cmd.exe' }

let dir

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-proc-')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function install(version, name) {
  const shim = path.join(dir, `${name}.cmd`)
  fs.copyFileSync(new URL(`${version}/${name}.cmd`, SHIMS), shim)
  const target = path.join(dir, 'node_modules', ...TARGETS[name].split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '')
  return { shim, target }
}

test('resolves windows shims through pathext', () => {
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '')
  assert.equal(resolveProgram('claude', { path: dir, windows: true }), path.join(dir, 'claude.cmd'))
  assert.equal(resolveProgram('claude', { path: dir, windows: false }), 'claude')
  assert.throws(() => resolveProgram('codex', { path: dir, windows: true }), { code: 'ENOENT' })
})

test('resolve program prefers exe and keeps explicit paths and extensions', () => {
  const other = path.join(dir, 'other')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(dir, 'bita.cmd'), '')
  fs.writeFileSync(path.join(other, 'bita.exe'), '')
  fs.writeFileSync(path.join(dir, 'git.exe'), '')
  fs.writeFileSync(path.join(dir, 'git.cmd'), '')
  fs.mkdirSync(path.join(dir, 'recap.exe'))
  const search = [dir, other].join(path.delimiter)
  assert.equal(resolveProgram('git', { path: search, windows: true }), path.join(dir, 'git.exe'))
  assert.equal(resolveProgram('bita', { path: search, windows: true }), path.join(dir, 'bita.cmd'))
  assert.equal(resolveProgram('bita.exe', { path: search, windows: true }), path.join(other, 'bita.exe'))
  assert.throws(() => resolveProgram('recap', { path: search, windows: true }), { code: 'ENOENT' })
  assert.equal(resolveProgram('C:\\tools\\bita', { path: search, windows: true }), 'C:\\tools\\bita')
  assert.equal(resolveProgram('./bita', { path: search, windows: true }), './bita')
  assert.throws(() => resolveProgram('bita', { path: undefined, windows: true }), { code: 'ENOENT' })
})

test('npm 10 and npm 11 shims carry the target the regex extracts', () => {
  for (const version of ['npm10', 'npm11']) {
    for (const [name, target] of Object.entries(TARGETS)) {
      const raw = fs.readFileSync(new URL(`${version}/${name}.cmd`, SHIMS), 'utf8')
      assert.ok(raw.includes('\r\n'), `${version}/${name} keeps CRLF`)
      const found = raw.match(SHIM_TARGET)
      assert.ok(found, `${version}/${name}`)
      assert.equal(found[1], `node_modules\\${target.replaceAll('/', '\\')}`)
    }
  }
})

test('command for runs node scripts behind npm shims with node directly', () => {
  for (const version of ['npm10', 'npm11']) {
    for (const name of ['bita', 'recap', 'codex', 'gemini']) {
      const { shim, target } = install(version, name)
      assert.equal(shimTarget(shim), target)
      assert.deepEqual(commandFor(shim, ['-p', '', 'a b'], WIN), { file: WIN.execPath, args: [target, '-p', '', 'a b'] })
    }
  }
})

test('command for runs exe targets behind npm shims directly', () => {
  for (const version of ['npm10', 'npm11']) {
    for (const name of ['claude', 'opencode']) {
      const { shim, target } = install(version, name)
      assert.deepEqual(commandFor(shim, ['--tools', '', 'x&y'], WIN), { file: target, args: ['--tools', '', 'x&y'] })
    }
  }
})

test('command for is a passthrough outside windows or for non batch files', () => {
  const { shim } = install('npm11', 'codex')
  assert.deepEqual(commandFor(shim, ['a'], { ...WIN, platform: 'darwin' }), { file: shim, args: ['a'] })
  assert.deepEqual(commandFor('C:\\git\\git.exe', ['-C', 'x'], WIN), { file: 'C:\\git\\git.exe', args: ['-C', 'x'] })
  assert.deepEqual(commandFor('bita', ['x'], WIN), { file: 'bita', args: ['x'] })
})

test('command for falls back to cmd with strict quoting', () => {
  const custom = path.join(dir, 'tool.bat')
  fs.writeFileSync(custom, '@echo off\r\necho hi %*\r\n')
  assert.deepEqual(commandFor(custom, ['projects', '--all', '', 'C:\\x/y', 'a=b,c@d+e:f_g-h.i'], WIN), {
    file: WIN.comSpec,
    args: ['/d', '/s', '/c', `""${custom}" "projects" "--all" "" "C:\\x/y" "a=b,c@d+e:f_g-h.i""`],
    windowsVerbatimArguments: true,
  })
  assert.equal(commandFor(custom, [], { ...WIN, comSpec: '', env: { SystemRoot: 'D:\\Win' } }).file, 'D:\\Win\\System32\\cmd.exe')
  assert.equal(commandFor(custom, [], { ...WIN, comSpec: 'cmd.exe', env: {} }).file, 'C:\\Windows\\System32\\cmd.exe')
  const { shim } = install('npm11', 'codex')
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
  assert.equal(commandFor(shim, ['exec'], WIN).file, WIN.comSpec)
})

test('command for refuses unsafe arguments for cmd', () => {
  const custom = path.join(dir, 'tool.cmd')
  fs.writeFileSync(custom, '@echo off\r\n')
  for (const bad of ['a b', 'a&b', 'x|y', '%PATH%', '"q"', '^', '!v!', 'a\nb', '(x)', 'ñ', 'C:\\dir\\', '\\', 'x\\\\']) {
    assert.throws(() => commandFor(custom, ['ok', bad], WIN), { message: `cannot run ${custom} without a shell: unsafe argument` })
  }
  assert.throws(() => commandFor(path.join(dir, '100%', 'tool.cmd'), [], WIN), /unsafe argument/)
  assert.match(commandFor(custom, ['C:\\dir\\x', 'a\\b'], WIN).args[3], /"C:\\dir\\x" "a\\b""$/)
})

test('programs planted in the cwd or in relative path entries never run on windows', () => {
  const repo = path.join(dir, 'repo')
  const empty = path.join(dir, 'empty')
  fs.mkdirSync(repo)
  fs.mkdirSync(empty)
  const marker = path.join(dir, 'ran')
  for (const name of ['bita.exe', 'bita.cmd', 'bita.bat', 'git.exe']) fs.writeFileSync(path.join(repo, name), `@echo off\r\necho x > "${marker}"\r\n`)
  const relative = path.relative(process.cwd(), repo)
  assert.throws(() => resolveProgram('bita', { path: ['.', relative, empty].join(path.delimiter), windows: true }), { code: 'ENOENT', message: 'bita not found in PATH' })
  const done = runSync('bita', ['projects'], { cwd: repo, env: { PATH: empty }, platform: 'win32' })
  assert.equal(done.error.code, 'ENOENT')
  assert.equal(spawnDetached(['git', 'status'], { cwd: repo, env: { PATH: empty }, platform: 'win32' }), null)
  assert.equal(fs.existsSync(marker), false)
  assert.equal(resolveProgram('bita', { path: `"${repo}"`, windows: true }), path.join(repo, 'bita.exe'))
})

test('system binaries live under an absolute SystemRoot', () => {
  assert.equal(systemBinary('cmd.exe', { SystemRoot: 'E:\\Windows' }), 'E:\\Windows\\System32\\cmd.exe')
  assert.equal(systemBinary('cmd.exe', { SYSTEMROOT: 'E:\\W' }), 'E:\\W\\System32\\cmd.exe')
  assert.equal(systemBinary('cmd.exe', { SystemRoot: 'Windows' }), 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(systemBinary('cmd.exe', {}), 'C:\\Windows\\System32\\cmd.exe')
})

test('children on windows never search the current directory for programs', () => {
  assert.equal(hardenEnv({ PATH: 'x' }, 'win32').NoDefaultCurrentDirectoryInExePath, '1')
  assert.equal(hardenEnv({ nodefaultcurrentdirectoryinexepath: '0' }, 'win32').nodefaultcurrentdirectoryinexepath, undefined)
  assert.equal(hardenEnv({ PATH: 'x' }, 'linux').NoDefaultCurrentDirectoryInExePath, undefined)
  const script = path.join(dir, 'env.mjs')
  fs.writeFileSync(script, 'console.log(JSON.stringify({ v: process.env.NoDefaultCurrentDirectoryInExePath ?? null }))')
  const done = runSync(process.execPath, [script], { env: { PATH: process.env.PATH }, platform: 'win32', timeoutMs: 20000 })
  assert.equal(done.error, null)
  assert.deepEqual(lastJsonLine(done.stdout), { v: '1' })
})

test('last json line returns the last parseable line', () => {
  assert.deepEqual(lastJsonLine('noise\n{"ok":true}\n{"ok":false,"n":1}\ntrailing text\n\n'), { ok: false, n: 1 })
  assert.deepEqual(lastJsonLine('  {"a":1}  \r\n'), { a: 1 })
  assert.equal(lastJsonLine('nothing here'), null)
  assert.equal(lastJsonLine(''), null)
})

test('run sync captures output, input and reports errors without throwing', () => {
  const script = path.join(dir, 'echo.mjs')
  fs.writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('log\\n'+JSON.stringify({got:s,arg:process.argv[2],env:process.env.BITA_NO_HOOKS})+'\\n');process.stderr.write('warn')})")
  const done = runSync(process.execPath, [script, 'x'], { cwd: dir, env: { ...process.env, BITA_NO_HOOKS: '1' }, input: 'hola', timeoutMs: 20000 })
  assert.equal(done.error, null)
  assert.equal(done.status, 0)
  assert.equal(done.stderr, 'warn')
  assert.deepEqual(lastJsonLine(done.stdout), { got: 'hola', arg: 'x', env: '1' })
  const missing = runSync(path.join(dir, 'nonexistent', 'bita'), ['projects'], { timeoutMs: 1000 })
  assert.equal(missing.error.code, 'ENOENT')
  const slow = path.join(dir, 'slow.mjs')
  fs.writeFileSync(slow, 'setTimeout(() => {}, 30000)')
  const started = Date.now()
  const timed = runSync(process.execPath, [slow], { timeoutMs: 300 })
  assert.ok(timed.error)
  assert.ok(Date.now() - started < 10000)
})

test('run sync executes npm shims without a shell on windows', { skip: process.platform !== 'win32' }, () => {
  const { shim, target } = install('npm11', 'bita')
  fs.writeFileSync(target, "console.log(JSON.stringify({ok:true,args:process.argv.slice(2)}))")
  const done = runSync('bita', ['projects', '--all', '--json', 'a&b', ''], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')), PATH: dir } })
  assert.equal(done.error, null)
  assert.equal(shim, resolveProgram('bita', { path: dir, windows: true }))
  assert.deepEqual(lastJsonLine(done.stdout), { ok: true, args: ['projects', '--all', '--json', 'a&b', ''] })
})

test('kill tree uses taskkill on windows', () => {
  assert.deepEqual(killCommand(1234, 'win32', { SystemRoot: 'D:\\Win' }), { file: 'D:\\Win\\System32\\taskkill.exe', args: ['/T', '/F', '/PID', '1234'] })
  assert.equal(killCommand(1, 'win32', {}).file, 'C:\\Windows\\System32\\taskkill.exe')
  assert.equal(killCommand(1234, 'linux'), null)
})

test('run sync under cmd goes through a supervisor that kills the whole tree with taskkill', () => {
  const command = { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '""x" "y""'], windowsVerbatimArguments: true }
  const args = supervisorArgs(command, { timeoutMs: 5000, platform: 'win32', env: { SystemRoot: 'D:\\Win' } })
  assert.equal(args[0], '-e')
  assert.deepEqual(JSON.parse(args[2]), {
    file: command.file,
    args: command.args,
    verbatim: true,
    timeoutMs: 5000,
    kill: 'D:\\Win\\System32\\taskkill.exe',
    killMs: 10000,
    timedOut: 124,
    failed: 125,
  })
  assert.equal(JSON.parse(supervisorArgs(command, { timeoutMs: 1, platform: 'linux' })[2]).kill, null)
})

test('the supervisor relays output and kills grandchildren on timeout', { skip: process.platform === 'win32' && 'uses process groups' }, async () => {
  const echo = path.join(dir, 'echo.mjs')
  fs.writeFileSync(echo, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.stringify({got:s,arg:process.argv[2]}));process.exit(3)})")
  const done = superviseSync({ file: process.execPath, args: [echo, 'x'] }, { timeoutMs: 20000, input: 'hola', platform: 'linux' })
  assert.equal(done.error, null)
  assert.equal(done.status, 3)
  assert.deepEqual(lastJsonLine(done.stdout), { got: 'hola', arg: 'x' })
  const missing = superviseSync({ file: path.join(dir, 'nope'), args: [] }, { timeoutMs: 20000, platform: 'linux' })
  assert.equal(missing.error.code, 'ENOENT')
  const pidFile = path.join(dir, 'grandchild.pid')
  const parent = path.join(dir, 'parent.mjs')
  fs.writeFileSync(parent, `import { spawn } from 'node:child_process'\nimport fs from 'node:fs'\nconst g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))\nsetTimeout(() => {}, 60000)\n`)
  const started = Date.now()
  const timed = superviseSync({ file: process.execPath, args: [parent] }, { timeoutMs: 1500, platform: 'linux' })
  assert.equal(timed.error.code, 'ETIMEDOUT')
  assert.ok(Date.now() - started < 15000)
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
  const deadline = Date.now() + 5000
  let gone = false
  while (!gone && Date.now() < deadline) {
    try {
      process.kill(grandchild, 0)
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      gone = true
    }
  }
  assert.equal(gone, true)
})

test('spawn detached writes to the log file and returns the pid', async () => {
  const log = path.join(dir, 'serve.log')
  const pid = spawnDetached([process.execPath, '-e', "console.log('gaze serve listening on test')"], { cwd: dir, logFile: log })
  assert.equal(typeof pid, 'number')
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('listening'))) await new Promise((r) => setTimeout(r, 50))
  assert.match(fs.readFileSync(log, 'utf8'), /gaze serve listening on test/)
  assert.equal(typeof spawnDetached([process.execPath, '-e', ''], { logFile: path.join(dir, 'missing', 'x.log') }), 'number')
})
