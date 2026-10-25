import assert from 'node:assert/strict'
import childProcess, { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { chmodSync, copyFileSync, cpSync, utimesSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { platformContext } from '@kikedealba/kit/platform'
import { acquireLock, archiveName, daemonMarker, ensureBinary, hopAllowed, jsMode, loadPort, needsRepair, olderVersion, PORT, redactUrl, refreshRegistration, registryManifest, repairLock, resolveTarget, restoreConfigs, runInstall, shimFor, snapshotConfigs, staleConfigs, staleIntegrations, startRepair } from './install.js'
import { shellCommand } from './setup.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '9.9.9'
const TARGETS = ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu']
const SUPPORTED = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' }[`${process.platform}-${process.arch}`]
const HOST = (() => {
  try {
    const target = resolveTarget(process.platform, process.arch)
    return TARGETS.includes(target) ? target : undefined
  } catch {
    return undefined
  }
})()
const SCRIPT = '#!/bin/sh\nif [ "$1 $2" = "daemon status" ]; then if [ -n "$GAZE_FAKE_INSTALLED" ]; then echo \'{"ok":true,"data":{"installed":true}}\'; fi; exit 0; fi\nif [ -n "$GAZE_FAKE_LOG" ]; then echo "$*" >> "$GAZE_FAKE_LOG"; fi\nif [ "$1" = "die" ]; then kill -TERM $$; fi\nif [ "$1" = "cat" ]; then exec cat; fi\necho "fake gaze $*"\nexit "${GAZE_FAKE_EXIT:-0}"\n'
const REGISTERING_SCRIPT = `#!/bin/sh
self="$(cd "$(dirname "$0")" && pwd -P)/gaze"
if [ "$1 $2" = "daemon status" ]; then
  installed=false
  if [ -f "$HOME/Library/LaunchAgents/com.kikedealba.gaze.plist" ] || [ -n "$GAZE_FAKE_INSTALLED" ]; then installed=true; fi
  printf '{"ok":true,"data":{"installed":%s}}\\n' "$installed"
  exit 0
fi
if [ -n "$GAZE_FAKE_LOG" ]; then echo "$*" >> "$GAZE_FAKE_LOG"; fi
case "$1" in
  setup) mkdir -p "$KIT_REGISTRY_DIR" && printf '{"version":"%s","bin":["%s"]}\\n' "\${GAZE_FAKE_VERSION:-$(cat "$(dirname "$self")/.version")}" "$self" > "$KIT_REGISTRY_DIR/gaze.json" ;;
  daemon) printf '<plist><string>%s</string><string>serve</string></plist>\\n' "$self" > "$HOME/Library/LaunchAgents/com.kikedealba.gaze.plist" ;;
  *) echo "fake gaze $*" ;;
esac
`
const NO_PROXY_ENV = { HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '', KIT_REGISTRY_DIR: '', XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', GAZE_DATA_DIR: '', GAZE_DB_PATH: '', GAZE_FORCE_JS: '' }
const quiet = () => {}
const EXE = Buffer.from('MZ fake gaze.exe for the npm installer tests\n')

const scratch = mkdtempSync(path.join(tmpdir(), 'gaze-npm-test-'))
let goodArchive
let registeringArchive
let symlinkArchive
let archive
let requests = []
let server
let base
let port
const home = mkdtempSync(path.join(scratch, 'home-'))

const FAKE_PORT = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
export async function main(argv, { self, io } = {}) {
  const out = io?.stdout ?? process.stdout
  if (process.env.GAZE_FAKE_LOG) appendFileSync(process.env.GAZE_FAKE_LOG, JSON.stringify({ argv, self, script: process.argv[1], io: Boolean(io) }) + '\\n')
  if (argv[0] === 'cat') {
    for await (const chunk of io?.stdin ?? process.stdin) out.write(String(chunk))
    return 0
  }
  if (argv[0] === 'daemon' && argv[1] === 'status') {
    out.write(JSON.stringify({ ok: true, data: { installed: Boolean(process.env.GAZE_FAKE_INSTALLED) } }) + '\\n')
    return 0
  }
  if (argv[0] === 'setup' && process.env.KIT_REGISTRY_DIR) {
    mkdirSync(process.env.KIT_REGISTRY_DIR, { recursive: true })
    writeFileSync(path.join(process.env.KIT_REGISTRY_DIR, 'gaze.json'), JSON.stringify({ version: process.env.GAZE_FAKE_VERSION || '${VERSION}', bin: self }))
  }
  out.write(argv.includes('--json') ? JSON.stringify({ ok: true, command: argv[0], data: { argv, self } }) + '\\n' : 'fake port ' + argv.join(' ') + '\\n')
  return Number(process.env.GAZE_FAKE_EXIT || 0)
}
`

function jsRoot(version = VERSION) {
  const root = realpathSync(packageRoot(null, version))
  const src = path.join(root, 'packages', 'gaze-win32', 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(path.join(src, 'index.js'), FAKE_PORT)
  return root
}

function fakePort({ installed = false, exit = 0 } = {}) {
  const calls = []
  return {
    calls,
    main: async (argv, { self, io }) => {
      calls.push({ argv, self })
      if (argv[0] === 'daemon' && argv[1] === 'status') {
        io.stdout.write(`${JSON.stringify({ ok: true, data: { installed } })}\n`)
        return 0
      }
      if (exit !== 0) io.stderr.write('port failed\n')
      return exit
    },
  }
}

function isolatedEnv() {
  const agentHome = realpathSync(mkdtempSync(path.join(scratch, 'home-')))
  mkdirSync(path.join(agentHome, 'data'))
  return { HOME: agentHome, USERPROFILE: agentHome, PATH: '', KIT_REGISTRY_DIR: path.join(agentHome, 'tools.d'), GAZE_DATA_DIR: path.join(agentHome, 'data') }
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tarball(name, populate) {
  const source = mkdtempSync(path.join(scratch, `${name}-`))
  populate(path.join(source, 'gaze'))
  const file = path.join(scratch, `${name}.tar.gz`)
  execFileSync('tar', ['-czf', file, '-C', source, 'gaze'])
  return readFileSync(file)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function busy(code, target) {
  return Object.assign(new Error(`${code}: resource busy or locked, '${target}'`), { code })
}

function asset(target = SUPPORTED) {
  return `gaze-${VERSION}-${target}.tar.gz`
}

function writeChecksums(root, { version = VERSION, targets = TARGETS, hash = sha256(archive) } = {}) {
  const assets = Object.fromEntries(targets.map((target) => [target, { file: archiveName(version, target), sha256: hash }]))
  writeFileSync(path.join(root, 'npm', 'checksums.json'), JSON.stringify({ version, assets }))
}

function packageRoot(checksums = {}, version = VERSION) {
  const root = mkdtempSync(path.join(scratch, 'pkg-'))
  mkdirSync(path.join(root, 'npm'))
  for (const file of ['install.js', 'gaze.js', 'setup.js']) copyFileSync(path.join(HERE, file), path.join(root, 'npm', file))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@kikedealba/gaze', version, type: 'module' }))
  if (checksums) writeChecksums(root, checksums)
  return root
}

function install(root, options = {}) {
  return ensureBinary({ root, platform: 'linux', arch: 'x64', warn: quiet, ...options, env: { GAZE_DOWNLOAD_BASE: base, ...options.env } })
}

function node(file, args, env = {}, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...NO_PROXY_ENV, HOME: home, GAZE_DOWNLOAD_BASE: base, GAZE_BINARY_PATH: '', ...env } })
    if (input !== undefined) child.stdin.end(input)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function run(root, args, env, input) {
  return node(path.join(root, 'npm', 'gaze.js'), args, env, input)
}

function vendorEntries(root, ...nested) {
  const vendor = path.join(root, 'vendor', ...nested)
  return existsSync(vendor) ? readdirSync(vendor).sort() : []
}

async function watchingFs(calls, action, fail = {}) {
  const originals = { renameSync: fs.renameSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, execFileSync: childProcess.execFileSync }
  fs.readFileSync = (...args) => {
    calls.push(['readFileSync', args[0]])
    const code = fail.readFileSync?.(args[0])
    if (code) throw busy(code, args[0])
    return originals.readFileSync(...args)
  }
  fs.writeFileSync = (...args) => {
    calls.push(['writeFileSync', args[0]])
    const code = fail.writeFileSync?.(args[0])
    if (code) throw busy(code, args[0])
    return originals.writeFileSync(...args)
  }
  fs.renameSync = (...args) => {
    calls.push(['renameSync', ...args])
    return originals.renameSync(...args)
  }
  fs.rmSync = (...args) => {
    calls.push(['rmSync', ...args])
    const code = fail.rmSync?.(args[0])
    if (code) throw busy(typeof code === 'string' ? code : 'EBUSY', args[0])
    return originals.rmSync(...args)
  }
  childProcess.execFileSync = (...args) => {
    calls.push(['execFileSync', ...args])
    return originals.execFileSync(...args)
  }
  syncBuiltinESMExports()
  try {
    return await action()
  } finally {
    Object.assign(fs, { renameSync: originals.renameSync, rmSync: originals.rmSync, readFileSync: originals.readFileSync, writeFileSync: originals.writeFileSync })
    childProcess.execFileSync = originals.execFileSync
    syncBuiltinESMExports()
  }
}

before(async () => {
  goodArchive = tarball('good', (file) => writeFileSync(file, SCRIPT, { mode: 0o644 }))
  registeringArchive = tarball('registering', (file) => writeFileSync(file, REGISTERING_SCRIPT, { mode: 0o644 }))
  symlinkArchive = tarball('symlink', (file) => symlinkSync('/bin/sh', file))
  server = createServer((request, response) => {
    requests.push(request.url)
    const pathname = new URL(request.url, base).pathname
    const name = path.basename(pathname)
    if (pathname.startsWith('/evil/')) {
      response.writeHead(302, { Location: `http://downloads.example.com/${name}` }).end()
    } else if (pathname.startsWith('/loop/')) {
      response.writeHead(302, { Location: pathname }).end()
    } else if (/^\/v\d+\.\d+\.\d+\//.test(pathname) && /\.(tar\.gz|exe)$/.test(name)) {
      response.writeHead(302, { Location: `/files/${name}` }).end()
    } else if (pathname.startsWith('/files/') && name.endsWith('.exe')) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(EXE)
    } else if (pathname.startsWith('/files/') && name.endsWith('.tar.gz')) {
      response.writeHead(200, { 'Content-Type': 'application/gzip' }).end(archive)
    } else {
      response.writeHead(404).end()
    }
  })
  server.on('connect', (request, client, head) => {
    requests.push(`CONNECT ${request.url}`)
    const upstream = connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
})

beforeEach(() => {
  requests = []
  archive = goodArchive
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(scratch, { recursive: true, force: true })
})

describe('resolveTarget', () => {
  test('maps the supported platforms to release targets', () => {
    assert.equal(resolveTarget('darwin', 'arm64'), 'aarch64-apple-darwin')
    assert.equal(resolveTarget('linux', 'x64'), 'x86_64-unknown-linux-gnu')
    assert.throws(() => resolveTarget('darwin', 'x64'), /no prebuilt binary for darwin-x64/)
    assert.equal(resolveTarget('linux', 'arm64'), 'aarch64-unknown-linux-gnu')
  })

  test('rejects an unsupported platform with a clear error', async () => {
    assert.throws(() => resolveTarget('win32', 'x64'), /no prebuilt binary for win32-x64 \(supported: darwin-arm64, linux-x64, linux-arm64\)/)
    const root = packageRoot()
    await assert.rejects(install(root, { platform: 'freebsd', arch: 'x64' }), /no prebuilt binary for freebsd-x64/)
    assert.equal(requests.length, 0)
    assert.deepEqual(vendorEntries(root), [])
  })
})

describe('hopAllowed', () => {
  test('only allows https GitHub hosts for the default base', () => {
    assert.equal(hopAllowed('https://github.com/KikeDeAlba/gaze/releases/download/v1/x', false), true)
    assert.equal(hopAllowed('https://objects.githubusercontent.com/x', false), true)
    assert.equal(hopAllowed('https://release-assets.githubusercontent.com/x', false), true)
    assert.equal(hopAllowed('http://github.com/x', false), false)
    assert.equal(hopAllowed('https://github.com.example.com/x', false), false)
    assert.equal(hopAllowed('https://downloads.example.com/x', false), false)
  })

  test('allows https anywhere and http only on loopback for a custom base', () => {
    assert.equal(hopAllowed('https://mirror.example.com/x', true), true)
    assert.equal(hopAllowed('http://127.0.0.1:8080/x', true), true)
    assert.equal(hopAllowed('http://localhost/x', true), true)
    assert.equal(hopAllowed('http://mirror.example.com/x', true), false)
  })
})

describe('ensureBinary', () => {
  test('downloads, verifies against checksums.json and extracts into vendor/', async () => {
    const root = packageRoot()
    const binary = await install(root, { env: { GAZE_DOWNLOAD_BASE: `${base}/` } })
    assert.equal(binary, path.join(root, 'vendor', 'gaze'))
    if (process.platform !== 'win32') assert.equal(statSync(binary).mode & 0o777, 0o755)
    assert.equal(readFileSync(binary, 'utf8'), SCRIPT)
    assert.deepEqual(vendorEntries(root), ['.version', 'gaze'])
    assert.deepEqual(requests, [`/v${VERSION}/${asset('x86_64-unknown-linux-gnu')}`, `/files/${asset('x86_64-unknown-linux-gnu')}`])
  })

  test('writes vendor/.version and reinstalls when it belongs to another version', async () => {
    const root = packageRoot()
    mkdirSync(path.join(root, 'vendor'))
    writeFileSync(path.join(root, 'vendor', 'gaze'), '#!/bin/sh\necho old\n', { mode: 0o755 })
    writeFileSync(path.join(root, 'vendor', '.version'), '9.9.8\n')
    await install(root)
    assert.equal(readFileSync(path.join(root, 'vendor', '.version'), 'utf8'), `${VERSION}\n`)
    assert.equal(readFileSync(path.join(root, 'vendor', 'gaze'), 'utf8'), SCRIPT)
    assert.equal(requests.length, 2)

    requests = []
    await install(root)
    assert.equal(requests.length, 0)
  })

  test('reinstalls a vendor binary without a version stamp', async () => {
    const root = packageRoot()
    mkdirSync(path.join(root, 'vendor'))
    writeFileSync(path.join(root, 'vendor', 'gaze'), '#!/bin/sh\necho old\n', { mode: 0o755 })
    await install(root)
    assert.equal(readFileSync(path.join(root, 'vendor', 'gaze'), 'utf8'), SCRIPT)
  })

  test('removes install directories orphaned more than 10 minutes ago', async () => {
    const root = packageRoot()
    const vendor = path.join(root, 'vendor')
    mkdirSync(path.join(vendor, '.install-old'), { recursive: true })
    writeFileSync(path.join(vendor, '.install-old', 'partial.tar.gz'), 'x')
    mkdirSync(path.join(vendor, '.install-recent'))
    const stale = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(path.join(vendor, '.install-old'), stale, stale)
    await install(root)
    assert.deepEqual(vendorEntries(root), ['.install-recent', '.version', 'gaze'])
  })

  test('offline mode never downloads', async () => {
    const root = packageRoot()
    assert.equal(await install(root, { offline: true }), null)
    mkdirSync(path.join(root, 'vendor'))
    writeFileSync(path.join(root, 'vendor', 'gaze'), SCRIPT, { mode: 0o755 })
    assert.equal(await install(root, { offline: true }), path.join(root, 'vendor', 'gaze'))
    assert.equal(requests.length, 0)
  })

  test('fails on a checksum mismatch and leaves no binary behind', async () => {
    const root = packageRoot({ hash: '0'.repeat(64) })
    await assert.rejects(install(root, { platform: 'darwin', arch: 'arm64' }), /Checksum mismatch for gaze-9\.9\.9-aarch64-apple-darwin\.tar\.gz: expected 0{64}, got [0-9a-f]{64}/)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('refuses to install without checksums.json', async () => {
    const root = packageRoot(null)
    await assert.rejects(install(root), /checksums\.json is missing, so the gaze binary cannot be verified/)
    assert.equal(requests.length, 0)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('refuses a target that checksums.json does not list', async () => {
    const root = packageRoot({ targets: ['aarch64-apple-darwin'] })
    await assert.rejects(install(root), /checksums\.json has no checksum for x86_64-unknown-linux-gnu/)
    assert.equal(requests.length, 0)
  })

  test('refuses checksums.json from another version', async () => {
    const root = packageRoot({ version: '9.9.8' })
    await assert.rejects(install(root), /checksums\.json is for version 9\.9\.8, but the package is 9\.9\.9/)
    assert.equal(requests.length, 0)
  })

  test('rejects an archive whose gaze entry is a symlink', async () => {
    archive = symlinkArchive
    const root = packageRoot()
    await assert.rejects(install(root), /has a gaze entry that is not a regular file/)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('rejects a redirect to a host that is not allowed', async () => {
    const root = packageRoot()
    await assert.rejects(install(root, { env: { GAZE_DOWNLOAD_BASE: `${base}/evil` } }), /Refusing to download from http:\/\/downloads\.example\.com\//)
    assert.equal(requests.length, 1)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('gives up after three redirects', async () => {
    const root = packageRoot()
    await assert.rejects(install(root, { env: { GAZE_DOWNLOAD_BASE: `${base}/loop` } }), /more than 3 redirects/)
    assert.equal(requests.length, 4)
  })

  test('rejects a plain http GAZE_DOWNLOAD_BASE outside loopback', async () => {
    const root = packageRoot()
    await assert.rejects(install(root, { env: { GAZE_DOWNLOAD_BASE: 'http://mirror.example.com' } }), /GAZE_DOWNLOAD_BASE must use https/)
  })

  test('never prints credentials or query strings from download URLs', async () => {
    assert.equal(redactUrl('https://user:secret@mirror.example.com/gaze/?token=abc#x'), 'https://mirror.example.com/gaze/')
    assert.equal(redactUrl('https://mirror.example.com'), 'https://mirror.example.com')
    assert.equal(redactUrl('not a url'), '<invalid URL>')
    const root = packageRoot()
    const authed = base.replace('http://', 'http://user:secret@')
    const warnings = []
    const failure = await install(root, { env: { GAZE_DOWNLOAD_BASE: `${authed}/missing?token=hunter2` }, warn: (message) => warnings.push(message) }).catch((error) => error)
    const printed = `${warnings.join('')}${failure.message}`
    assert.match(printed, /Cannot download http:\/\/127\.0\.0\.1:\d+\/missing/)
    assert.doesNotMatch(printed, /secret|hunter2|token|user/)
    const queried = await install(root, { env: { GAZE_DOWNLOAD_BASE: `${base}/missing?token=hunter2` }, warn: (message) => warnings.push(message) }).catch((error) => error)
    assert.match(queried.message, /HTTP 404/)
    assert.doesNotMatch(`${warnings.join('')}${queried.message}`, /secret|hunter2|token|user/)
    await assert.rejects(install(root, { env: { GAZE_DOWNLOAD_BASE: 'http://user:secret@mirror.example.com/?k=v' } }), (error) => /must use https/.test(error.message) && !/secret|k=v/.test(error.message))
    await assert.rejects(install(root, { env: { GAZE_DOWNLOAD_BASE: 'not a url secret' } }), (error) => error.message === 'GAZE_DOWNLOAD_BASE is not a valid URL')
  })

  test('warns when GAZE_DOWNLOAD_BASE is used', async () => {
    const root = packageRoot()
    const warnings = []
    await install(root, { warn: (message) => warnings.push(message) })
    assert.deepEqual(warnings, [`gaze: downloading from GAZE_DOWNLOAD_BASE=${base} instead of the GitHub releases\n`])
  })

  test('fails clearly when the release asset does not exist', async () => {
    const root = packageRoot()
    await assert.rejects(install(root, { env: { GAZE_DOWNLOAD_BASE: `${base}/missing` } }), /Cannot download .*: HTTP 404/)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('uses GAZE_BINARY_PATH without downloading and warns about it', async () => {
    const root = packageRoot()
    const custom = path.join(scratch, 'custom-gaze')
    writeFileSync(custom, SCRIPT, { mode: 0o755 })
    const warnings = []
    assert.equal(await install(root, { env: { GAZE_BINARY_PATH: custom }, warn: (message) => warnings.push(message) }), custom)
    assert.deepEqual(warnings, [`gaze: using GAZE_BINARY_PATH=${custom} instead of the bundled binary\n`])
    assert.equal(requests.length, 0)
    assert.equal(existsSync(path.join(root, 'vendor')), false)
  })
})

describe('ensureBinary in JS mode', () => {
  function legacyVendor(root) {
    const vendor = path.join(root, 'vendor')
    mkdirSync(path.join(vendor, '0.6.2'), { recursive: true })
    writeFileSync(path.join(vendor, '0.6.2', 'gaze.exe'), EXE)
    writeFileSync(path.join(vendor, '0.6.2', '.verified'), '{}\n')
    writeFileSync(path.join(vendor, 'gaze.exe'), EXE)
    writeFileSync(path.join(vendor, '.version'), '0.6.1\n')
    return vendor
  }

  test('turns on for win32 and GAZE_FORCE_JS=1, and GAZE_BINARY_PATH forces the native binary', () => {
    assert.equal(jsMode('win32', {}), true)
    assert.equal(jsMode('linux', {}), false)
    assert.equal(jsMode('darwin', { GAZE_FORCE_JS: '1' }), true)
    assert.equal(jsMode('darwin', { GAZE_FORCE_JS: '0' }), false)
    assert.equal(jsMode('win32', { GAZE_BINARY_PATH: 'C:\\tools\\gaze.exe' }), false)
    assert.equal(archiveName(VERSION, 'x86_64-unknown-linux-gnu'), `gaze-${VERSION}-x86_64-unknown-linux-gnu.tar.gz`)
  })

  test('on win32 returns npm/gaze.js without checksums.json or downloads and removes the 0.6.x vendor/', async () => {
    const root = packageRoot(null)
    const vendor = legacyVendor(root)
    assert.equal(await install(root, { platform: 'win32', arch: 'x64' }), path.join(root, 'npm', 'gaze.js'))
    assert.equal(existsSync(vendor), false)
    assert.equal(await install(root, { platform: 'win32', arch: 'arm64', offline: true }), shimFor(root))
    assert.equal(requests.length, 0)
  })

  test('tolerates a vendor/ that a running 0.6.x gaze.exe keeps busy and removes it later', async () => {
    const root = packageRoot(null)
    const vendor = legacyVendor(root)
    for (const code of ['EBUSY', 'EPERM']) {
      const calls = []
      assert.equal(await watchingFs(calls, () => install(root, { platform: 'win32', arch: 'x64' }), { rmSync: (target) => target === vendor && code }), shimFor(root))
      assert.ok(calls.some(([name, target]) => name === 'rmSync' && target === vendor))
      assert.ok(existsSync(path.join(vendor, '0.6.2', 'gaze.exe')))
    }
    assert.equal(await install(root, { platform: 'win32', arch: 'x64' }), shimFor(root))
    assert.equal(existsSync(vendor), false)
    assert.equal(requests.length, 0)
  })

  test('GAZE_FORCE_JS=1 returns npm/gaze.js on any platform and leaves vendor/ alone', async () => {
    const root = packageRoot()
    const vendor = legacyVendor(root)
    assert.equal(await install(root, { env: { GAZE_FORCE_JS: '1' } }), shimFor(root))
    assert.ok(existsSync(path.join(vendor, 'gaze.exe')))
    assert.equal(requests.length, 0)
  })

  test('GAZE_BINARY_PATH wins over the port on win32', async () => {
    const root = packageRoot(null)
    const vendor = legacyVendor(root)
    const custom = path.join(scratch, 'custom-win32-gaze')
    writeFileSync(custom, SCRIPT, { mode: 0o755 })
    assert.equal(await install(root, { platform: 'win32', arch: 'x64', env: { GAZE_BINARY_PATH: custom } }), custom)
    assert.ok(existsSync(vendor))
  })

  test('postinstall on win32 downloads nothing, removes vendor/ and asks the port for the daemon status', async () => {
    const root = packageRoot(null)
    const vendor = legacyVendor(root)
    const env = isolatedEnv()
    const port = fakePort()
    let stderr = ''
    const code = await runInstall('--postinstall', undefined, { root, platform: 'win32', arch: 'x64', warn: quiet, env, port, write: (text) => (stderr += text) })
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.equal(existsSync(vendor), false)
    assert.equal(requests.length, 0)
    assert.deepEqual(port.calls, [{ argv: ['daemon', 'status', '--json'], self: [process.execPath, shimFor(root)] }])
  })
})

describe('loadPort', () => {
  const missing = (specifier) => Object.assign(new Error(`Cannot find package '${specifier}' imported from ${HERE}`), { code: 'ERR_MODULE_NOT_FOUND' })

  test('imports the installed @kikedealba/gaze-win32', async () => {
    const port = { main: async () => 0 }
    const seen = []
    assert.equal(await loadPort({ root: jsRoot(), load: async (specifier) => (seen.push(specifier), port) }), port)
    assert.deepEqual(seen, [PORT])
    assert.equal(PORT, '@kikedealba/gaze-win32')
  })

  test('falls back to packages/gaze-win32 of a checkout when the package is not installed', async () => {
    const root = jsRoot()
    const seen = []
    const port = await loadPort({ root, load: async (specifier) => {
      seen.push(specifier)
      if (specifier === PORT) throw missing(specifier)
      return import(specifier)
    } })
    assert.equal(typeof port.main, 'function')
    assert.deepEqual(seen, [PORT, pathToFileURL(path.join(root, 'packages', 'gaze-win32', 'src', 'index.js')).href])
  })

  test('fails with a clear message when the optional package is missing', async () => {
    await assert.rejects(
      loadPort({ root: packageRoot(null), load: async (specifier) => { throw missing(specifier) } }),
      (error) => error.name === 'InstallError' && error.message === '@kikedealba/gaze-win32 is missing; reinstall with npm install -g @kikedealba/gaze',
    )
  })

  test('does not hide a broken install behind the checkout fallback', async () => {
    const nested = Object.assign(new Error("Cannot find package 'onnxruntime-web' imported from /pkg/src/embed.js"), { code: 'ERR_MODULE_NOT_FOUND' })
    await assert.rejects(loadPort({ root: jsRoot(), load: async () => { throw nested } }), /^InstallError: cannot load @kikedealba\/gaze-win32: Cannot find package 'onnxruntime-web'/)
    await assert.rejects(loadPort({ root: jsRoot(), load: async () => ({}) }), /does not export main/)
  })
})

describe('gaze shim in JS mode', () => {
  test('runs the port in the same process with self = [node, npm/gaze.js] and keeps its exit code', async () => {
    const root = jsRoot()
    const log = path.join(root, 'calls.log')
    const result = await run(root, ['search', 'hello world'], { GAZE_FORCE_JS: '1', GAZE_FAKE_EXIT: '7', GAZE_FAKE_LOG: log })
    assert.equal(result.code, 7, result.stderr)
    assert.equal(result.stdout, 'fake port search hello world\n')
    const shim = path.join(root, 'npm', 'gaze.js')
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), { argv: ['search', 'hello world'], self: [process.execPath, shim], script: shim, io: false })
    assert.equal(existsSync(path.join(root, 'vendor')), false)
    assert.equal(requests.length, 0)
  })

  test('forwards stdin to the port', async () => {
    const result = await run(jsRoot(), ['cat'], { GAZE_FORCE_JS: '1' }, 'from stdin')
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, 'from stdin')
  })

  test('without the port a hook exits 0, mcp exits 1 and any other command exits 1, all with a clear message', async () => {
    const root = packageRoot(null)
    const message = 'gaze: @kikedealba/gaze-win32 is missing; reinstall with npm install -g @kikedealba/gaze\n'
    const hook = await run(root, ['hook', 'prompt'], { GAZE_FORCE_JS: '1' }, '{}')
    assert.deepEqual([hook.code, hook.stderr], [0, message])
    const mcp = await run(root, ['mcp'], { GAZE_FORCE_JS: '1' }, '')
    assert.deepEqual([mcp.code, mcp.stderr], [1, message])
    const stats = await run(root, ['stats'], { GAZE_FORCE_JS: '1' })
    assert.deepEqual([stats.code, stats.stderr], [1, message])
    assert.equal(requests.length, 0)
  })

  test('setup runs the port setup in the same process and keeps its JSON envelope', async () => {
    const root = jsRoot()
    const result = await run(root, ['setup', '--agents', 'none', '--json'], { GAZE_FORCE_JS: '1' })
    assert.equal(result.code, 0, result.stderr)
    const envelope = JSON.parse(result.stdout)
    assert.deepEqual(envelope.data, { argv: ['setup', '--json'], self: [process.execPath, path.join(root, 'npm', 'gaze.js')], integrations: [] })
  })

  test('GAZE_BINARY_PATH runs the native binary even with GAZE_FORCE_JS', { skip: process.platform === 'win32' }, async () => {
    const custom = path.join(scratch, 'custom-forced-gaze')
    writeFileSync(custom, SCRIPT, { mode: 0o755 })
    const result = await run(jsRoot(), ['stats'], { GAZE_FORCE_JS: '1', GAZE_BINARY_PATH: custom })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, 'fake gaze stats\n')
  })

  test('a hook repairs a 0.6.x registration in the background through the port', { timeout: 30_000 }, async () => {
    const root = jsRoot()
    const env = { ...isolatedEnv(), GAZE_FORCE_JS: '1' }
    env.GAZE_FAKE_LOG = path.join(env.HOME, 'calls.log')
    mkdirSync(env.KIT_REGISTRY_DIR, { recursive: true })
    writeFileSync(registryManifest(env), JSON.stringify({ version: '0.6.2', bin: [path.join(root, 'vendor', '0.6.2', 'gaze.exe')] }))
    const hook = await run(root, ['hook', 'prompt'], env, '{}')
    assert.equal(hook.code, 0, hook.stderr)
    const lock = repairLock(env)
    const deadline = Date.now() + 15_000
    while (existsSync(lock)) {
      if (Date.now() > deadline) throw new Error(`repair still running: ${readFileSync(lock, 'utf8')}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const shim = path.join(root, 'npm', 'gaze.js')
    assert.deepEqual(JSON.parse(readFileSync(registryManifest(env), 'utf8')), { version: VERSION, bin: [process.execPath, shim] })
    const calls = readFileSync(env.GAZE_FAKE_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(calls.map(({ argv }) => argv), [['hook', 'prompt'], ['daemon', 'status', '--json'], ['setup']])
    assert.ok(calls.every(({ self }) => self[1] === shim))
    assert.equal(needsRepair(shim, { root, env }), false)
  })
})

describe('needsRepair in JS mode', () => {
  test('repairs a 0.6.x exe registration, a moved node and a missing shim, and leaves other installs alone', () => {
    const env = isolatedEnv()
    const root = jsRoot()
    const shim = shimFor(root)
    const register = (manifest) => writeFileSync(registryManifest(env), JSON.stringify(manifest))
    const check = (extra = {}) => needsRepair(shim, { root, env: { ...env, ...extra }, platform: 'win32' })
    mkdirSync(env.KIT_REGISTRY_DIR, { recursive: true })
    assert.equal(needsRepair(shim, { root, env: { ...env, KIT_REGISTRY_DIR: path.join(env.HOME, 'none') }, platform: 'win32' }), false)

    register({ version: VERSION, bin: [process.execPath, shim] })
    assert.equal(check(), false)
    assert.equal(check({ GAZE_BINARY_PATH: '/usr/local/bin/gaze' }), false)

    const exe = path.join(root, 'vendor', '0.6.2', 'gaze.exe')
    mkdirSync(path.dirname(exe), { recursive: true })
    writeFileSync(exe, EXE)
    register({ version: VERSION, bin: [exe] })
    assert.equal(check(), true)
    register({ version: '0.6.2', bin: [exe] })
    assert.equal(check(), true)
    rmSync(path.join(root, 'vendor'), { recursive: true, force: true })
    register({ version: VERSION, bin: [exe] })
    assert.equal(check(), true)

    const otherNode = path.join(env.HOME, 'nvm', 'v24.0.0', 'node.exe')
    mkdirSync(path.dirname(otherNode), { recursive: true })
    writeFileSync(otherNode, '')
    register({ version: VERSION, bin: [otherNode, shim] })
    assert.equal(check(), true)
    register({ version: VERSION, bin: [process.execPath, path.join(env.HOME, 'gone', 'npm', 'gaze.js')] })
    assert.equal(check(), true)

    const other = jsRoot()
    register({ version: VERSION, bin: [otherNode, shimFor(other)] })
    assert.equal(check(), false)
    const cargo = path.join(env.HOME, '.cargo', 'bin', 'gaze.exe')
    mkdirSync(path.dirname(cargo), { recursive: true })
    writeFileSync(cargo, EXE)
    register({ version: '0.0.1', bin: [cargo] })
    assert.equal(check(), false)

    register({ version: VERSION, bin: [process.execPath, shim] })
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'on-demand', bin: path.join(root, 'vendor', '0.6.2', 'gaze.exe') }))
    assert.equal(check(), true)
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'on-demand', bin: shim, command: [process.execPath, shim] }))
    assert.equal(check(), false)
  })
})

describe('gaze shim', { skip: SUPPORTED ? false : `no release target for ${process.platform}-${process.arch}` }, () => {
  test('installs on first run, forwards arguments and propagates the exit code', async () => {
    const root = packageRoot()
    const first = await run(root, ['search', 'hello world'], { GAZE_FAKE_EXIT: '7' })
    assert.equal(first.code, 7, first.stderr)
    assert.equal(first.stdout, 'fake gaze search hello world\n')
    assert.equal(statSync(path.join(root, 'vendor', 'gaze')).mode & 0o777, 0o755)

    requests = []
    const second = await run(root, ['stats'])
    assert.equal(second.code, 0, second.stderr)
    assert.equal(second.stdout, 'fake gaze stats\n')
    assert.equal(second.stderr, '')
    assert.equal(requests.length, 0)
  })

  test('forwards stdin to the binary', async () => {
    const root = packageRoot()
    const result = await run(root, ['cat'], {}, '{"session_id":"s"}\n')
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, '{"session_id":"s"}\n')
  })

  test('runs GAZE_BINARY_PATH without downloading', async () => {
    const root = packageRoot(null)
    const custom = path.join(scratch, 'custom-shim-gaze')
    writeFileSync(custom, SCRIPT, { mode: 0o755 })
    const result = await run(root, ['stats'], { GAZE_BINARY_PATH: custom, GAZE_FAKE_EXIT: '4' })
    assert.equal(result.code, 4, result.stderr)
    assert.equal(result.stdout, 'fake gaze stats\n')
    assert.match(result.stderr, /using GAZE_BINARY_PATH=/)
    assert.equal(requests.length, 0)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('a hook without a binary exits 0 quickly and does not download', async () => {
    const root = packageRoot()
    const started = Date.now()
    const result = await run(root, ['hook', 'prompt'], {}, '{}')
    assert.equal(result.code, 0)
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
    assert.match(result.stderr, /^gaze: the gaze binary is not installed yet; run `gaze setup`/)
    assert.equal(result.stdout, '')
    assert.equal(requests.length, 0)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('mcp without a binary exits 1 and does not download', async () => {
    const root = packageRoot()
    const result = await run(root, ['mcp'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not installed yet/)
    assert.equal(requests.length, 0)
  })

  test('a hook still runs a vendor binary from an older version', async () => {
    const root = packageRoot()
    mkdirSync(path.join(root, 'vendor'))
    writeFileSync(path.join(root, 'vendor', 'gaze'), SCRIPT, { mode: 0o755 })
    writeFileSync(path.join(root, 'vendor', '.version'), '9.9.8\n')
    const result = await run(root, ['hook', 'prompt'])
    assert.equal(result.stdout, 'fake gaze hook prompt\n')
    assert.equal(requests.length, 0)
  })

  test('propagates the signal that terminated the binary', async () => {
    const root = packageRoot()
    const result = await run(root, ['die'])
    assert.equal(result.signal, 'SIGTERM', result.stderr)
  })

  test('reports a failed install and exits non-zero', async () => {
    const root = packageRoot({ hash: 'f'.repeat(64) })
    const result = await run(root, ['stats'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /^gaze: Checksum mismatch for /m)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('survives concurrent first runs without corrupting vendor/', async () => {
    const root = packageRoot()
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => run(root, ['stats'])))
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, 'fake gaze stats\n')
    }
    assert.deepEqual(vendorEntries(root), ['.version', 'gaze'])
  })

  test('fails with a clear error when the package directory is not writable', { skip: process.getuid?.() === 0 }, async () => {
    const root = packageRoot()
    chmodSync(root, 0o555)
    try {
      const result = await run(root, ['stats'])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /^gaze: Cannot write .*: EACCES\. .*npm config get prefix/m)
    } finally {
      chmodSync(root, 0o755)
    }
  })

  test('relaunches the download through HTTP_PROXY with NODE_USE_ENV_PROXY', { timeout: 20_000 }, async () => {
    const root = packageRoot()
    const result = await run(root, ['stats'], { HTTP_PROXY: base, http_proxy: base, GAZE_DOWNLOAD_BASE: `http://localhost:${port}` })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, 'fake gaze stats\n')
    assert.ok(requests.includes(`CONNECT localhost:${port}`) || requests.includes(`http://localhost:${port}/v${VERSION}/${asset()}`), requests.join(', '))
  })
})

describe('install.js', () => {
  function installScript(root, args, env) {
    return node(path.join(root, 'npm', 'install.js'), args, env)
  }

  test('exits non-zero with a message when run directly and the download fails', async () => {
    const root = packageRoot()
    const result = await installScript(root, [], { GAZE_DOWNLOAD_BASE: `${base}/missing` })
    assert.equal(result.code, 1)
    assert.match(result.stderr, HOST ? /^gaze: Cannot download .*HTTP 404/m : /^gaze: gaze has no prebuilt binary/m)
  })

  test('--postinstall tolerates a network failure and defers the download', { skip: !HOST }, async () => {
    const root = packageRoot()
    const result = await installScript(root, ['--postinstall'], { GAZE_DOWNLOAD_BASE: `${base}/missing` })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /could not download the binary during install .*HTTP 404.*downloaded the first time gaze runs/)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('--postinstall fails on a checksum mismatch', { skip: !HOST }, async () => {
    const root = packageRoot({ hash: '0'.repeat(64) })
    const result = await installScript(root, ['--postinstall'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /^gaze: Checksum mismatch for /m)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('--postinstall refreshes the manifest and daemon when the launch agent exists', { skip: !SUPPORTED }, async () => {
    const root = packageRoot()
    const agentHome = mkdtempSync(path.join(scratch, 'home-'))
    mkdirSync(path.join(agentHome, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(path.join(agentHome, 'Library', 'LaunchAgents', 'com.kikedealba.gaze.plist'), '<plist/>')
    const log = path.join(scratch, `calls-${path.basename(root)}`)
    const result = await installScript(root, ['--postinstall'], { HOME: agentHome, GAZE_FAKE_LOG: log })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(readFileSync(log, 'utf8'), 'setup\ndaemon install\n')
  })

  test('--postinstall only warns when the daemon refresh fails', { skip: !SUPPORTED }, async () => {
    const root = packageRoot()
    const agentHome = mkdtempSync(path.join(scratch, 'home-'))
    mkdirSync(path.join(agentHome, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(path.join(agentHome, 'Library', 'LaunchAgents', 'com.kikedealba.gaze.plist'), '<plist/>')
    const result = await installScript(root, ['--postinstall'], { HOME: agentHome, GAZE_FAKE_EXIT: '2' })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /could not refresh the daemon with `gaze setup` \(exit 2\); run `gaze setup && gaze daemon install` by hand/)
    assert.ok(existsSync(path.join(root, 'vendor', 'gaze')))
  })

  test('--postinstall refreshes a systemd or schtasks daemon reported by gaze daemon status', { skip: !SUPPORTED }, async () => {
    const root = packageRoot()
    const log = path.join(scratch, `calls-${path.basename(root)}`)
    const result = await installScript(root, ['--postinstall'], { GAZE_FAKE_LOG: log, GAZE_FAKE_INSTALLED: '1' })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(readFileSync(log, 'utf8'), 'setup\ndaemon install\n')
  })

  test('--postinstall leaves the daemon alone without a launch agent', { skip: !SUPPORTED }, async () => {
    const root = packageRoot()
    const log = path.join(scratch, `calls-${path.basename(root)}`)
    const result = await installScript(root, ['--postinstall'], { GAZE_FAKE_LOG: log })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(existsSync(log), false)
  })

  test('--postinstall fails without checksums.json', async () => {
    const root = packageRoot(null)
    const result = await installScript(root, ['--postinstall'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, HOST ? /checksums\.json is missing/ : /no prebuilt binary/)
  })
})

describe('registration repair', { skip: SUPPORTED ? false : `no release target for ${process.platform}-${process.arch}` }, () => {
  function machine() {
    const agentHome = mkdtempSync(path.join(scratch, 'home-'))
    mkdirSync(path.join(agentHome, 'Library', 'LaunchAgents'), { recursive: true })
    return { HOME: agentHome, KIT_REGISTRY_DIR: path.join(agentHome, 'tools.d'), GAZE_FAKE_LOG: path.join(agentHome, 'calls.log') }
  }

  function registered(env) {
    return JSON.parse(readFileSync(registryManifest(env), 'utf8'))
  }

  function plist(env) {
    return readFileSync(path.join(env.HOME, 'Library', 'LaunchAgents', 'com.kikedealba.gaze.plist'), 'utf8')
  }

  async function settled(env) {
    const lock = repairLock(env)
    const deadline = Date.now() + 15_000
    while (existsSync(lock)) {
      if (Date.now() > deadline) throw new Error(`repair still running: ${readFileSync(lock, 'utf8')}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function installVersion(version, env) {
    const root = packageRoot({ version }, version)
    const setup = await run(root, ['setup', '--agents', 'none'], env)
    assert.equal(setup.code, 0, setup.stderr)
    const daemon = await run(root, ['daemon', 'install'], env)
    assert.equal(daemon.code, 0, daemon.stderr)
    return root
  }

  beforeEach(() => {
    archive = registeringArchive
  })

  test('needsRepair is false without a registration and when it matches the binary', async () => {
    const env = machine()
    const root = packageRoot()
    assert.equal(needsRepair(null, { root, env }), false)
    await installVersion(VERSION, env)
    const current = await installVersion(VERSION, env)
    assert.equal(needsRepair(path.join(current, 'vendor', 'gaze'), { root: current, env }), false)
    assert.equal(needsRepair(null, { root: current, env }), false)
    rmSync(path.join(current, 'vendor'), { recursive: true, force: true })
    assert.equal(needsRepair(null, { root: current, env }), true)
    assert.equal(needsRepair(path.join(current, 'vendor', 'gaze'), { root: current, env: { ...env, GAZE_BINARY_PATH: '/bin/sh' } }), false)
  })

  test('needsRepair follows the daemon marker when the unit points to a missing binary', async () => {
    const env = { ...machine(), GAZE_DATA_DIR: mkdtempSync(path.join(scratch, 'data-')) }
    const root = await installVersion(VERSION, env)
    const binary = path.join(root, 'vendor', 'gaze')
    rmSync(path.join(env.HOME, 'Library', 'LaunchAgents', 'com.kikedealba.gaze.plist'))
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'systemd', bin: '/gone/vendor/gaze' }))
    assert.equal(needsRepair(binary, { root, env }), true)
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'systemd', bin: realpathSync(binary) }))
    assert.equal(needsRepair(binary, { root, env }), false)
  })

  test('needsRepair checks the plist even when the daemon marker matches', async () => {
    const env = { ...machine(), GAZE_DATA_DIR: mkdtempSync(path.join(scratch, 'data-')) }
    const root = await installVersion(VERSION, env)
    const binary = path.join(root, 'vendor', 'gaze')
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'launchd', bin: realpathSync(binary) }))
    assert.equal(needsRepair(binary, { root, env }), false)
    writeFileSync(path.join(env.HOME, 'Library', 'LaunchAgents', 'com.kikedealba.gaze.plist'), '<plist><string>/old/vendor/gaze</string></plist>')
    assert.equal(needsRepair(binary, { root, env }), true)
  })

  test('needsRepair notices a plist that points elsewhere', async () => {
    const env = machine()
    const root = await installVersion(VERSION, env)
    writeFileSync(path.join(env.HOME, 'Library', 'LaunchAgents', 'com.kikedealba.gaze.plist'), '<plist><string>/old/vendor/gaze</string></plist>')
    assert.equal(needsRepair(path.join(root, 'vendor', 'gaze'), { root, env }), true)
  })

  test('a hook after upgrading repairs the registry and the daemon in the background', { timeout: 30_000 }, async () => {
    const env = machine()
    const old = await installVersion('9.9.8', env)
    assert.equal(registered(env).bin[0], path.join(realpathSync(old), 'vendor', 'gaze'))
    rmSync(old, { recursive: true, force: true })
    writeFileSync(env.GAZE_FAKE_LOG, '')

    const upgraded = packageRoot({ version: '9.9.9' }, '9.9.9')
    const started = Date.now()
    const hook = await run(upgraded, ['hook', 'prompt'], env, '{}')
    assert.equal(hook.code, 0)
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
    await settled(env)

    const binary = path.join(realpathSync(upgraded), 'vendor', 'gaze')
    assert.deepEqual(registered(env), { version: '9.9.9', bin: [binary] })
    assert.match(plist(env), new RegExp(`<string>${binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`))
    assert.equal(readFileSync(env.GAZE_FAKE_LOG, 'utf8'), 'setup\ndaemon install\n')

    const next = await run(upgraded, ['hook', 'prompt'], env, '{}')
    assert.equal(next.stdout, 'fake gaze hook prompt\n')
    assert.equal(existsSync(repairLock(env)), false)
    assert.equal(readFileSync(env.GAZE_FAKE_LOG, 'utf8'), 'setup\ndaemon install\nhook prompt\n')
  })

  test('the registered binary stays valid across two simulated versions', { timeout: 30_000 }, async () => {
    const env = machine()
    const first = await installVersion('9.9.7', env)
    const second = packageRoot({ version: '9.9.8' }, '9.9.8')
    const result = await run(second, ['stats'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /refreshing them in the background/)
    await settled(env)
    rmSync(first, { recursive: true, force: true })
    const { bin, version } = registered(env)
    assert.equal(version, '9.9.8')
    assert.ok(existsSync(bin[0]), bin[0])
    assert.ok(plist(env).includes(`<string>${bin[0]}</string>`))
    assert.equal(needsRepair(path.join(second, 'vendor', 'gaze'), { root: second, env }), false)
  })

  test('explicit setup and daemon install do not start a background repair', async () => {
    const env = machine()
    await installVersion('9.9.7', env)
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const result = await run(root, ['setup', '--agents', 'none'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /refreshing/)
    assert.equal(existsSync(repairLock(env)), false)
  })

  test('a failed repair keeps its lock so hooks do not retry it on every run', { timeout: 30_000 }, async () => {
    const env = { ...machine(), GAZE_DOWNLOAD_BASE: `${base}/missing` }
    await installVersion('9.9.7', { ...env, GAZE_DOWNLOAD_BASE: base })
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const hook = await run(root, ['hook', 'prompt'], env, '{}')
    assert.equal(hook.code, 0)
    const lock = repairLock(env)
    const deadline = Date.now() + 15_000
    while (!/HTTP 404/.test(existsSync(lock) ? readFileSync(lock, 'utf8') : '')) {
      assert.ok(Date.now() < deadline, 'the repair did not record its failure')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(startRepair({ root, env: { ...process.env, ...NO_PROXY_ENV, ...env } }), false)
    utimesSync(lock, new Date(0), new Date(0))
    assert.equal(startRepair({ root, env: { ...process.env, ...NO_PROXY_ENV, ...env, GAZE_DOWNLOAD_BASE: base } }), true)
    await settled(env)
    assert.equal(registered(env).version, '9.9.8')
  })

  test('olderVersion compares numeric versions', () => {
    assert.equal(olderVersion('0.4.0', '0.4.1'), true)
    assert.equal(olderVersion('0.10.0', '0.9.9'), false)
    assert.equal(olderVersion('0.4.1', '0.4.1'), false)
    assert.equal(olderVersion(undefined, '0.4.1'), true)
  })

  test('the repair lock lives in the data dir with mode 0600', async () => {
    const env = machine()
    await installVersion('9.9.7', env)
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const full = { ...process.env, ...NO_PROXY_ENV, ...env, GAZE_DOWNLOAD_BASE: base }
    assert.equal(startRepair({ root, env: full }), true)
    const lock = repairLock(env)
    assert.equal(lock, path.join(env.HOME, '.local', 'share', 'gaze', 'repair.lock'))
    assert.equal(statSync(lock).mode & 0o777, 0o600)
    await settled(env)
  })

  test('does not repair when the manifest was removed, even with a plist', async () => {
    const env = machine()
    const root = await installVersion('9.9.7', env)
    rmSync(registryManifest(env))
    rmSync(path.join(root, 'vendor'), { recursive: true, force: true })
    const upgraded = packageRoot({ version: '9.9.8' }, '9.9.8')
    assert.equal(needsRepair(null, { root: upgraded, env }), false)
    const result = await run(upgraded, ['stats'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /refreshing/)
    assert.equal(existsSync(registryManifest(env)), false)
  })

  test('leaves a cargo or manual registration alone', async () => {
    const env = machine()
    const cargo = path.join(env.HOME, '.cargo', 'bin', 'gaze')
    mkdirSync(path.dirname(cargo), { recursive: true })
    writeFileSync(cargo, SCRIPT, { mode: 0o755 })
    mkdirSync(env.KIT_REGISTRY_DIR, { recursive: true })
    const manifest = JSON.stringify({ version: '0.0.1', bin: [cargo] })
    writeFileSync(registryManifest(env), manifest)
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const result = await run(root, ['stats'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /refreshing/)
    assert.equal(existsSync(repairLock(env)), false)
    assert.equal(readFileSync(registryManifest(env), 'utf8'), manifest)
  })

  test('two npm installs do not take the registration back and forth', { timeout: 30_000 }, async () => {
    const env = machine()
    const first = await installVersion('9.9.8', env)
    const same = packageRoot({ version: '9.9.8' }, '9.9.8')
    const sameRun = await run(same, ['stats'], env)
    assert.equal(sameRun.code, 0, sameRun.stderr)
    assert.doesNotMatch(sameRun.stderr, /refreshing/)
    assert.equal(registered(env).bin[0], path.join(realpathSync(first), 'vendor', 'gaze'))

    const newer = packageRoot({ version: '9.9.9' }, '9.9.9')
    await run(newer, ['stats'], env)
    await settled(env)
    const winner = path.join(realpathSync(newer), 'vendor', 'gaze')
    assert.equal(registered(env).bin[0], winner)

    writeFileSync(env.GAZE_FAKE_LOG, '')
    for (const root of [first, same, first]) {
      const result = await run(root, ['stats'], env)
      assert.doesNotMatch(result.stderr, /refreshing/)
    }
    assert.equal(existsSync(repairLock(env)), false)
    assert.equal(registered(env).bin[0], winner)
    assert.equal(readFileSync(env.GAZE_FAKE_LOG, 'utf8'), 'stats\nstats\nstats\n')
  })

  test('a repair that does not converge keeps a fresh lock instead of looping', { timeout: 30_000 }, async () => {
    const env = machine()
    await installVersion('9.9.7', env)
    writeFileSync(env.GAZE_FAKE_LOG, '')
    const mismatched = { ...env, GAZE_FAKE_VERSION: '9.9.0' }
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const started = Date.now()
    const hook = await run(root, ['stats'], mismatched)
    assert.equal(hook.code, 0, hook.stderr)
    const lock = repairLock(env)
    const deadline = Date.now() + 15_000
    while (!/still does not point/.test(existsSync(lock) ? readFileSync(lock, 'utf8') : '')) {
      assert.ok(Date.now() < deadline, 'the repair did not record that it did not converge')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(statSync(lock).mtimeMs >= started - 1000)
    assert.equal(registered(env).version, '9.9.0')
    const again = await run(root, ['stats'], mismatched)
    assert.doesNotMatch(again.stderr, /refreshing/)
    assert.deepEqual(readFileSync(env.GAZE_FAKE_LOG, 'utf8').trim().split('\n').sort(), ['daemon install', 'setup', 'stats', 'stats'])
  })

  test('an old lock whose owner is still alive is not taken over', async () => {
    const env = machine()
    await installVersion('9.9.7', env)
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const lock = repairLock(env)
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, `${process.pid}\n`)
    const old = new Date(Date.now() - 30 * 60 * 1000)
    utimesSync(lock, old, old)
    assert.equal(startRepair({ root, env: { ...process.env, ...NO_PROXY_ENV, ...env } }), false)
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`)
    rmSync(lock)
  })

  test('as root, startRepair creates nothing in the data dir and spawns no repair', () => {
    const env = { ...process.env, ...NO_PROXY_ENV, GAZE_DATA_DIR: path.join(mkdtempSync(path.join(scratch, 'root-')), 'data') }
    const warnings = []
    assert.equal(startRepair({ root: packageRoot(), env, euid: 0, warn: (message) => warnings.push(message) }), false)
    assert.equal(existsSync(env.GAZE_DATA_DIR), false)
    assert.match(warnings.join(''), /running as root/)
  })

  test('a stale lock is removed in place and recreated without renaming it', async () => {
    const env = machine()
    await installVersion('9.9.7', env)
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const lock = repairLock(env)
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, '999999999\n')
    const stale = new Date(Date.now() - 20 * 60 * 1000)
    utimesSync(lock, stale, stale)
    const calls = []
    const full = { ...process.env, ...NO_PROXY_ENV, ...env, GAZE_DOWNLOAD_BASE: base }
    assert.equal(await watchingFs(calls, () => startRepair({ root, env: full })), true)
    assert.deepEqual(calls.filter(([name]) => name === 'renameSync'), [])
    assert.ok(calls.some(([name, target]) => name === 'rmSync' && target === lock))
    assert.deepEqual(readdirSync(path.dirname(lock)).filter((entry) => entry.startsWith('repair.lock.')), [])
    await settled(env)
    assert.equal(registered(env).version, '9.9.8')
  })

  test('acquireLock removes a stale lock under the reclaim guard and takes it', async () => {
    const dir = mkdtempSync(path.join(scratch, 'lock-'))
    const lock = path.join(dir, 'repair.lock')
    writeFileSync(lock, '999999999\n')
    const stale = new Date(Date.now() - 20 * 60 * 1000)
    utimesSync(lock, stale, stale)
    const calls = []
    assert.equal(await watchingFs(calls, () => acquireLock(lock)), true)
    assert.deepEqual(calls.filter(([name]) => name === 'renameSync'), [])
    assert.ok(calls.some(([name, target]) => name === 'rmSync' && target === lock))
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`)
    assert.deepEqual(readdirSync(dir), ['repair.lock'])
  })

  test('a stale lock is left alone while another repair holds the reclaim guard', async () => {
    const dir = mkdtempSync(path.join(scratch, 'lock-'))
    const lock = path.join(dir, 'repair.lock')
    writeFileSync(lock, '999999999\n')
    const stale = new Date(Date.now() - 20 * 60 * 1000)
    utimesSync(lock, stale, stale)
    mkdirSync(`${lock}.reclaim`)
    assert.equal(acquireLock(lock), false)
    assert.equal(readFileSync(lock, 'utf8'), '999999999\n')
    const abandoned = new Date(Date.now() - 5 * 60 * 1000)
    utimesSync(`${lock}.reclaim`, abandoned, abandoned)
    assert.equal(acquireLock(lock), false)
    assert.equal(existsSync(`${lock}.reclaim`), false)
    assert.equal(acquireLock(lock), true)
  })

  test('a lock with an mtime in the future is taken over', () => {
    const dir = mkdtempSync(path.join(scratch, 'lock-'))
    const lock = path.join(dir, 'repair.lock')
    writeFileSync(lock, `${process.pid}\n`)
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000)
    utimesSync(lock, future, future)
    assert.equal(acquireLock(lock), true)
    assert.ok(statSync(lock).mtimeMs <= Date.now() + 1000)
  })

  test('a reclaim guard that is not an empty directory is removed without following it', () => {
    for (const make of ['file', 'symlink', 'full']) {
      const dir = mkdtempSync(path.join(scratch, 'lock-'))
      const lock = path.join(dir, 'repair.lock')
      const guard = `${lock}.reclaim`
      const outside = mkdtempSync(path.join(scratch, 'outside-'))
      writeFileSync(path.join(outside, 'keep'), 'keep')
      writeFileSync(lock, '999999999\n')
      const stale = new Date(Date.now() - 20 * 60 * 1000)
      utimesSync(lock, stale, stale)
      if (make === 'file') writeFileSync(guard, 'x')
      if (make === 'symlink') symlinkSync(outside, guard)
      if (make === 'full') {
        mkdirSync(guard)
        writeFileSync(path.join(guard, 'x'), 'x')
      }
      assert.equal(acquireLock(lock), false, make)
      assert.equal(existsSync(guard), false, make)
      assert.deepEqual(readdirSync(outside), ['keep'], make)
      assert.equal(acquireLock(lock), true, make)
    }
  })

  test('a repair never writes through a lock that is a symlink', async () => {
    const dir = mkdtempSync(path.join(scratch, 'lock-'))
    const target = path.join(dir, 'victim')
    writeFileSync(target, 'untouched')
    const lock = path.join(dir, 'repair.lock')
    symlinkSync(target, lock)
    const root = packageRoot()
    const result = await node(path.join(root, 'npm', 'install.js'), ['--repair', lock])
    assert.equal(result.code, 1)
    assert.equal(readFileSync(target, 'utf8'), 'untouched')
  })

  for (const batch of [1, 2]) {
    test(`only one of many concurrent repairs takes a stale lock (batch ${batch})`, { timeout: 60_000 }, async () => {
      const runner = path.join(scratch, `lock-runner-${batch}.mjs`)
      writeFileSync(runner, `import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'install.js')).href)}
const [lock, start] = process.argv.slice(2)
while (Date.now() < Number(start)) {}
process.stdout.write(String(acquireLock(lock)))
`)
      for (let round = 0; round < 5; round++) {
        const dir = mkdtempSync(path.join(scratch, 'lock-'))
        const lock = path.join(dir, 'repair.lock')
        writeFileSync(lock, '999999999\n')
        const stale = new Date(Date.now() - 20 * 60 * 1000)
        utimesSync(lock, stale, stale)
        const start = Date.now() + 1500
        const results = await Promise.all(Array.from({ length: 8 }, () => node(runner, [lock, String(start)])))
        const winners = results.filter((result) => result.stdout === 'true')
        assert.equal(winners.length, 1, JSON.stringify(results.map((result) => result.stdout + result.stderr)))
        assert.deepEqual(readdirSync(dir), ['repair.lock'])
        assert.notEqual(readFileSync(lock, 'utf8'), '999999999\n')
      }
    })
  }

  test('needsRepair treats vendor/<version>/gaze.exe as npm managed', () => {
    const env = { ...machine(), GAZE_DATA_DIR: mkdtempSync(path.join(scratch, 'data-')) }
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const old = path.join(root, 'vendor', '9.9.7', 'gaze.exe')
    const current = path.join(root, 'vendor', '9.9.8', 'gaze.exe')
    for (const file of [old, current]) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, EXE)
    }
    rmSync(path.join(env.HOME, 'Library'), { recursive: true, force: true })
    mkdirSync(env.KIT_REGISTRY_DIR, { recursive: true })
    writeFileSync(registryManifest(env), JSON.stringify({ version: '9.9.7', bin: [old] }))
    assert.equal(needsRepair(current, { root, env }), true)
    writeFileSync(registryManifest(env), JSON.stringify({ version: '9.9.8', bin: [current] }))
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'schtasks', bin: old }))
    assert.equal(needsRepair(current, { root, env }), true)
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'schtasks', bin: current }))
    assert.equal(needsRepair(current, { root, env }), false)
    const foreign = path.join(env.HOME, 'tools', '9.9.7', 'gaze.exe')
    mkdirSync(path.dirname(foreign), { recursive: true })
    writeFileSync(foreign, EXE)
    writeFileSync(registryManifest(env), JSON.stringify({ version: '0.0.1', bin: [foreign] }))
    assert.equal(needsRepair(current, { root, env }), false)
  })

  test('needsRepair flags a 0.6.1 registration and a daemon.json that point to vendor/gaze.exe', () => {
    const env = { ...machine(), GAZE_DATA_DIR: mkdtempSync(path.join(scratch, 'data-')) }
    const root = packageRoot({ version: '0.6.2' }, '0.6.2')
    const legacy = path.join(root, 'vendor', 'gaze.exe')
    const current = path.join(root, 'vendor', '0.6.2', 'gaze.exe')
    mkdirSync(path.dirname(current), { recursive: true })
    for (const file of [legacy, current]) writeFileSync(file, EXE)
    rmSync(path.join(env.HOME, 'Library'), { recursive: true, force: true })
    mkdirSync(env.KIT_REGISTRY_DIR, { recursive: true })
    writeFileSync(registryManifest(env), JSON.stringify({ version: '0.6.1', bin: [legacy] }))
    assert.equal(needsRepair(current, { root, env }), true)
    rmSync(legacy)
    assert.equal(needsRepair(current, { root, env }), true)
    writeFileSync(registryManifest(env), JSON.stringify({ version: '0.6.2', bin: [current] }))
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'schtasks', bin: legacy }))
    assert.equal(needsRepair(current, { root, env }), true)
    writeFileSync(legacy, EXE)
    assert.equal(needsRepair(current, { root, env }), true)
    writeFileSync(daemonMarker(env), JSON.stringify({ manager: 'schtasks', bin: current }))
    assert.equal(needsRepair(current, { root, env }), false)
  })

  test('a lock with a fresh mtime is never taken over by a second repair', async () => {
    const env = machine()
    await installVersion('9.9.7', env)
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const lock = repairLock(env)
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, '999999999\n')
    const calls = []
    const full = { ...process.env, ...NO_PROXY_ENV, ...env, GAZE_DOWNLOAD_BASE: base }
    assert.deepEqual(await watchingFs(calls, () => [startRepair({ root, env: full }), startRepair({ root, env: full })]), [false, false])
    assert.deepEqual(calls.filter(([name, target]) => (name === 'rmSync' || name === 'renameSync') && target === lock), [])
    assert.equal(readFileSync(lock, 'utf8'), '999999999\n')
    rmSync(lock)
    assert.deepEqual([startRepair({ root, env: full }), startRepair({ root, env: full })], [true, false])
    await settled(env)
  })

  test('a lock older than an hour is taken over even if its pid is alive again', async () => {
    const env = machine()
    await installVersion('9.9.7', env)
    const root = packageRoot({ version: '9.9.8' }, '9.9.8')
    const lock = repairLock(env)
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, `${process.pid}\n`)
    const recent = new Date(Date.now() - 30 * 60 * 1000)
    utimesSync(lock, recent, recent)
    const full = { ...process.env, ...NO_PROXY_ENV, ...env, GAZE_DOWNLOAD_BASE: base }
    assert.equal(startRepair({ root, env: full }), false)
    const abandoned = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(lock, abandoned, abandoned)
    assert.equal(startRepair({ root, env: full }), true)
    await settled(env)
    assert.equal(registered(env).version, '9.9.8')
  })
})

describe('agent integrations after moving to the JS port', () => {
  const AGENTS = ['codex', 'gemini', 'opencode', 'antigravity', 'claude-desktop']

  function jsPackage(version = VERSION) {
    const root = jsRoot(version)
    symlinkSync(path.join(HERE, '..', 'node_modules'), path.join(root, 'node_modules'))
    cpSync(path.join(HERE, '..', 'skills'), path.join(root, 'skills'), { recursive: true })
    copyFileSync(path.join(HERE, 'antigravity.md'), path.join(root, 'npm', 'antigravity.md'))
    return root
  }

  function legacyExe(root) {
    const exe = path.join(root, 'vendor', '0.6.2', 'gaze.exe')
    mkdirSync(path.dirname(exe), { recursive: true })
    writeFileSync(exe, EXE)
    return exe
  }

  function agentMachine() {
    const env = isolatedEnv()
    const agentHome = env.HOME
    mkdirSync(path.join(agentHome, 'Library', 'Application Support', 'Claude'), { recursive: true })
    const install = { ctx: platformContext({ platform: 'darwin', home: agentHome, env }), locate: async () => null, exec: async () => '' }
    return { agentHome, env, install }
  }

  function homesOf(agentHome) {
    return { codex: path.join(agentHome, '.codex'), gemini: path.join(agentHome, '.gemini'), opencode: path.join(agentHome, '.config', 'opencode'), antigravity: path.join(agentHome, '.gemini', 'config'), claudeDesktop: path.join(agentHome, 'Library', 'Application Support', 'Claude') }
  }

  function configs(agentHome) {
    const files = [
      path.join(agentHome, '.codex', 'hooks.json'),
      path.join(agentHome, '.codex', 'config.toml'),
      path.join(agentHome, '.gemini', 'extensions', 'gaze', 'gemini-extension.json'),
      path.join(agentHome, '.gemini', 'extensions', 'gaze', 'hooks', 'hooks.json'),
      path.join(agentHome, '.config', 'opencode', 'opencode.json'),
      path.join(agentHome, '.gemini', 'config', 'mcp_config.json'),
      path.join(agentHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    ]
    return files.map((file) => readFileSync(file, 'utf8'))
  }

  function referenced(agentHome) {
    return configs(agentHome).flatMap((text) => (text.match(/[^"'\s]*[\\/]vendor[\\/][^"'\s]*/g) ?? []).map((ref) => ref.replaceAll('\\\\', '\\')))
  }

  function readConfig(agentHome, ...parts) {
    return JSON.parse(readFileSync(path.join(agentHome, ...parts), 'utf8'))
  }

  function hookCommands(groups) {
    return (groups ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
  }

  function assertPortCommand(agentHome, shim) {
    const mcp = { command: process.execPath, args: [shim, 'mcp'] }
    assert.match(readFileSync(path.join(agentHome, '.codex', 'config.toml'), 'utf8'), new RegExp(`command = ${escapeRe(JSON.stringify(process.execPath))}\\nargs = \\[${escapeRe(JSON.stringify(shim))}, "mcp"\\]`))
    assert.deepEqual(hookCommands(readConfig(agentHome, '.codex', 'hooks.json').hooks.UserPromptSubmit), [`${shellCommand([process.execPath, shim], 'darwin')} hook prompt --harness codex`])
    assert.deepEqual(readConfig(agentHome, '.gemini', 'extensions', 'gaze', 'gemini-extension.json').mcpServers.gaze, mcp)
    assert.deepEqual(hookCommands(readConfig(agentHome, '.gemini', 'extensions', 'gaze', 'hooks', 'hooks.json').hooks.BeforeAgent), [`${shellCommand([process.execPath, shim], 'darwin')} hook prompt --harness gemini`])
    assert.deepEqual(readConfig(agentHome, '.config', 'opencode', 'opencode.json').mcp.gaze.command, [process.execPath, shim, 'mcp'])
    for (const file of [['.gemini', 'config', 'mcp_config.json'], ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json']]) {
      const { command, args } = readConfig(agentHome, ...file).mcpServers.gaze
      assert.deepEqual({ command, args }, mcp)
    }
  }

  test('postinstall points every agent that used the 0.6.x exe at node and npm/gaze.js', async () => {
    const root = jsPackage()
    const { agentHome, env, install: options } = agentMachine()
    const old = legacyExe(root)
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    const { steps } = await installAgents(AGENTS, { binary: old }, options)
    assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
    const before = referenced(agentHome)
    assert.ok(before.length >= 7, before.join('\n'))
    assert.ok(before.every((file) => file === old))

    const binary = await install(root, { platform: 'win32', arch: 'x64', install: options })
    assert.equal(binary, shimFor(root))
    assert.equal(existsSync(path.join(root, 'vendor')), false)
    assert.deepEqual(staleIntegrations(binary, homesOf(agentHome), root), AGENTS)

    const port = fakePort()
    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, port, warn: (message) => warnings.push(message) }), true, warnings.join(''))
    assert.deepEqual(warnings, [])
    assert.deepEqual(referenced(agentHome), [])
    assertPortCommand(agentHome, binary)
    assert.deepEqual(staleIntegrations(binary, homesOf(agentHome), root), [])
    assert.deepEqual(port.calls.map(({ argv }) => argv), [['daemon', 'status', '--json']])
  })

  test('a config written with another node is stale and gets the current node', async () => {
    const root = jsPackage()
    const { agentHome, env, install: options } = agentMachine()
    const shim = shimFor(root)
    const oldNode = path.join(agentHome, 'old node', 'bin', 'node')
    mkdirSync(path.dirname(oldNode), { recursive: true })
    writeFileSync(oldNode, '')
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    await installAgents(AGENTS, { command: [oldNode, shim] }, options)
    assert.deepEqual(staleIntegrations(shim, homesOf(agentHome), root), AGENTS)
    assert.ok(staleConfigs(shim, homesOf(agentHome), root).every(({ refs }) => refs.length === 1 && refs[0] === oldNode))

    const warnings = []
    assert.equal(await refreshRegistration(shim, { env, root, install: options, port: fakePort(), warn: (message) => warnings.push(message) }), true, warnings.join(''))
    assert.deepEqual(warnings, [])
    assert.ok(configs(agentHome).every((text) => !text.includes('old node')))
    assertPortCommand(agentHome, shim)
  })

  test('refreshes the registration and the daemon through the port in the same process', async () => {
    const root = jsRoot()
    const { env } = agentMachine()
    mkdirSync(env.KIT_REGISTRY_DIR, { recursive: true })
    writeFileSync(registryManifest(env), JSON.stringify({ version: '0.6.2', bin: [path.join(root, 'vendor', '0.6.2', 'gaze.exe')] }))
    const port = fakePort({ installed: true })
    const warnings = []
    assert.equal(await refreshRegistration(shimFor(root), { env, root, port, warn: (message) => warnings.push(message) }), true, warnings.join(''))
    assert.deepEqual(port.calls, [['daemon', 'status', '--json'], ['setup'], ['daemon', 'install']].map((argv) => ({ argv, self: [process.execPath, shimFor(root)] })))

    const idle = fakePort()
    assert.equal(await refreshRegistration(shimFor(root), { env, root, port: idle, warn: quiet }), true)
    assert.deepEqual(idle.calls.map(({ argv }) => argv), [['daemon', 'status', '--json'], ['setup']])
  })

  test('only warns when the port fails during postinstall', async () => {
    const root = jsRoot()
    const { env } = agentMachine()
    const port = fakePort({ installed: true, exit: 4 })
    const warnings = []
    assert.equal(await refreshRegistration(shimFor(root), { env, root, port, warn: (message) => warnings.push(message) }), false)
    assert.deepEqual(warnings, ['gaze: could not refresh the daemon with `gaze setup` (port failed); run `gaze setup && gaze daemon install` by hand\n'])
    let stderr = ''
    assert.equal(await runInstall('--postinstall', undefined, { root, platform: 'win32', arch: 'x64', env, port, warn: quiet, write: (text) => (stderr += text) }), 0)
    assert.match(stderr, /could not refresh the daemon with `gaze setup` \(port failed\)/)
    const broken = { main: async () => { throw new Error('port exploded') } }
    stderr = ''
    assert.equal(await runInstall('--postinstall', undefined, { root, platform: 'win32', arch: 'x64', env, port: broken, warn: quiet, write: (text) => (stderr += text) }), 0)
    assert.equal(stderr, '')
  })

  test('keeps the mode of 0600 configs, their backups and the configs behind a symlink', { skip: process.platform === 'win32' }, async () => {
    const root = jsPackage()
    const { agentHome, env, install: options } = agentMachine()
    const old = legacyExe(root)
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    await installAgents(['codex', 'antigravity', 'opencode'], { binary: old }, options)
    const codex = path.join(agentHome, '.codex', 'config.toml')
    const hooks = path.join(agentHome, '.codex', 'hooks.json')
    const agy = path.join(agentHome, '.gemini', 'config', 'mcp_config.json')
    const opencode = path.join(agentHome, '.config', 'opencode', 'opencode.json')
    const dotfiles = path.join(agentHome, 'dotfiles')
    mkdirSync(dotfiles)
    const real = path.join(dotfiles, 'opencode.json')
    writeFileSync(real, readFileSync(opencode))
    rmSync(opencode)
    symlinkSync(real, opencode)
    for (const file of [codex, hooks, agy, real]) chmodSync(file, 0o600)

    const binary = await install(root, { platform: 'win32', arch: 'x64', install: options })
    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, port: fakePort(), warn: (message) => warnings.push(message) }), true, warnings.join(''))
    for (const file of [codex, hooks, agy, real]) assert.equal(statSync(file).mode & 0o777, 0o600, file)
    for (const file of [codex, hooks, agy, opencode]) {
      if (existsSync(`${file}.backup`)) assert.equal(statSync(`${file}.backup`).mode & 0o777, 0o600, `${file}.backup`)
    }
    assert.ok(fs.lstatSync(opencode).isSymbolicLink())
    assert.equal(realpathSync(opencode), realpathSync(real))
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).mcp.gaze.command, [process.execPath, binary, 'mcp'])
    assert.ok(readFileSync(codex, 'utf8').includes(binary))
  })

  test('warns about a config it cannot rewrite', async () => {
    const root = jsPackage()
    const { agentHome, env, install: options } = agentMachine()
    const old = legacyExe(root)
    const jsonc = path.join(agentHome, '.config', 'opencode', 'opencode.jsonc')
    mkdirSync(path.dirname(jsonc), { recursive: true })
    writeFileSync(jsonc, `{\n  // gaze from npm\n  "mcp": { "gaze": { "type": "local", "command": [${JSON.stringify(old)}, "mcp"] } }\n}\n`)

    const binary = await install(root, { platform: 'win32', arch: 'x64', install: options })
    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, port: fakePort(), warn: (message) => warnings.push(message) }), false)
    assert.deepEqual(warnings, [`gaze: ${jsonc} still points to ${old}; run \`gaze setup\`\n`])
  })

  function linkedConfig() {
    const dir = realpathSync(mkdtempSync(path.join(scratch, 'restore-')))
    const real = path.join(dir, 'real.json')
    const file = path.join(dir, 'config.json')
    writeFileSync(real, '{"old":true}\n', { mode: 0o600 })
    chmodSync(real, 0o600)
    symlinkSync(real, file)
    return { dir, real, file }
  }

  function kitRewrite(file, content) {
    writeFileSync(`${file}.tmp`, content, { mode: 0o644 })
    fs.renameSync(`${file}.tmp`, file)
  }

  test('restores the symlink and the mode of a config that kit replaced', { skip: process.platform === 'win32' }, () => {
    const { real, file } = linkedConfig()
    const snapshots = snapshotConfigs([file])
    kitRewrite(file, '{"new":true}\n')
    writeFileSync(`${file}.backup`, '{"old":true}\n', { mode: 0o644 })
    const warnings = []
    restoreConfigs(snapshots, { warn: (message) => warnings.push(message) })
    assert.deepEqual(warnings, [])
    assert.ok(fs.lstatSync(file).isSymbolicLink())
    assert.equal(readFileSync(real, 'utf8'), '{"new":true}\n')
    assert.equal(statSync(real).mode & 0o777, 0o600)
    assert.equal(statSync(`${file}.backup`).mode & 0o777, 0o600)
  })

  test('as root, never refreshes or rewrites the agent integrations and never calls the port', async () => {
    const root = jsPackage()
    const { agentHome, env, install: options } = agentMachine()
    const old = legacyExe(root)
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    await installAgents(AGENTS, { binary: old }, options)
    const before = configs(agentHome)
    writeFileSync(path.join(root, 'npm', 'setup.js'), `import { writeFileSync } from 'node:fs'\nexport async function installAgents() { writeFileSync(${JSON.stringify(path.join(root, 'called'))}, '') ; return { steps: [] } }\n`)
    const binary = await install(root, { platform: 'win32', arch: 'x64', install: options, euid: 0 })
    const port = fakePort({ installed: true })
    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, port, euid: 0, warn: (message) => warnings.push(message) }), false)
    assert.deepEqual(warnings, ['gaze: running as root; the kit registration, the daemon and the agent integrations were not refreshed. Run `gaze setup && gaze daemon install` as your user\n'])
    assert.equal(existsSync(path.join(root, 'called')), false)
    assert.deepEqual(configs(agentHome), before)
    assert.deepEqual(port.calls, [])
  })

  test('skips a config, a symlink target or a backup with more than one hard link', { skip: process.platform === 'win32' }, () => {
    const { dir, real, file } = linkedConfig()
    const victim = path.join(dir, 'victim')
    writeFileSync(victim, 'victim', { mode: 0o644 })
    chmodSync(victim, 0o644)
    fs.linkSync(real, path.join(dir, 'extra-link'))
    const plain = path.join(dir, 'plain.json')
    writeFileSync(plain, '{}', { mode: 0o600 })
    chmodSync(plain, 0o600)
    const snapshots = snapshotConfigs([file, plain])
    kitRewrite(file, '{"new":true}\n')
    rmSync(plain)
    fs.linkSync(victim, plain)
    fs.linkSync(victim, `${file}.backup`)
    const warnings = []
    restoreConfigs(snapshots, { warn: (message) => warnings.push(message) })
    assert.equal(warnings.length, 2, warnings.join(''))
    assert.match(warnings[0], /config\.json -> .*real\.json changed while gaze setup rewrote it/)
    assert.match(warnings[1], /plain\.json changed while gaze setup rewrote it/)
    assert.equal(readFileSync(real, 'utf8'), '{"old":true}\n')
    assert.equal(statSync(victim).mode & 0o777, 0o644)
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false)

    const again = linkedConfig()
    const snapshot = snapshotConfigs([again.file])
    kitRewrite(again.file, '{"new":true}\n')
    fs.linkSync(victim, `${again.file}.backup`)
    const backupWarnings = []
    restoreConfigs(snapshot, { warn: (message) => backupWarnings.push(message) })
    assert.equal(backupWarnings.length, 1, backupWarnings.join(''))
    assert.match(backupWarnings[0], /config\.json\.backup is not a regular file owned by the owner of .* with a single link/)
    assert.equal(readFileSync(again.real, 'utf8'), '{"new":true}\n')
    assert.equal(statSync(victim).mode & 0o777, 0o644)
  })

  test('skips a config or a symlink target owned by someone other than its snapshot owner', { skip: process.platform === 'win32' }, () => {
    const { real, file } = linkedConfig()
    const dir = path.dirname(file)
    const plain = path.join(dir, 'plain.json')
    writeFileSync(plain, '{}', { mode: 0o600 })
    chmodSync(plain, 0o600)
    const snapshots = snapshotConfigs([file, plain]).map((snapshot) => ({ ...snapshot, uid: snapshot.uid + 1 }))
    kitRewrite(file, '{"new":true}\n')
    kitRewrite(plain, '{"new":true}\n')
    const warnings = []
    restoreConfigs(snapshots, { warn: (message) => warnings.push(message) })
    assert.equal(warnings.length, 2, warnings.join(''))
    assert.equal(readFileSync(real, 'utf8'), '{"old":true}\n')
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false)
    assert.equal(statSync(plain).mode & 0o777, 0o644)
  })

  test('skips the restore when the symlink target changed inode after the snapshot', { skip: process.platform === 'win32' }, () => {
    const { dir, real, file } = linkedConfig()
    const snapshots = snapshotConfigs([file])
    kitRewrite(file, '{"new":true}\n')
    const swapped = path.join(dir, 'swapped')
    writeFileSync(swapped, 'someone else', { mode: 0o644 })
    fs.renameSync(swapped, real)
    const warnings = []
    restoreConfigs(snapshots, { warn: (message) => warnings.push(message) })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /changed while gaze setup rewrote it/)
    assert.equal(readFileSync(real, 'utf8'), 'someone else')
    assert.equal(statSync(real).mode & 0o777, 0o644)
    assert.equal(readFileSync(file, 'utf8'), '{"new":true}\n')
  })

  test('skips the restore when the symlink points somewhere else afterwards', { skip: process.platform === 'win32' }, () => {
    const { dir, file } = linkedConfig()
    const snapshots = snapshotConfigs([file])
    const other = path.join(dir, 'other')
    writeFileSync(other, 'other', { mode: 0o644 })
    rmSync(file)
    symlinkSync(other, file)
    const warnings = []
    restoreConfigs(snapshots, { warn: (message) => warnings.push(message) })
    assert.equal(warnings.length, 1)
    assert.equal(statSync(other).mode & 0o777, 0o644)
  })

  test('leaves the agent configs alone with GAZE_BINARY_PATH', async () => {
    const root = jsPackage()
    const { agentHome, env, install: options } = agentMachine()
    const old = legacyExe(root)
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    await installAgents(['codex'], { binary: old }, options)
    const config = readFileSync(path.join(agentHome, '.codex', 'config.toml'), 'utf8')
    assert.equal(await refreshRegistration(shimFor(root), { env: { ...env, GAZE_BINARY_PATH: '/usr/local/bin/gaze' }, root, install: options, port: fakePort(), warn: quiet }), true)
    assert.equal(readFileSync(path.join(agentHome, '.codex', 'config.toml'), 'utf8'), config)
  })

  test('does not touch agents that already use this node and shim or another install', async () => {
    const root = jsPackage()
    const binary = shimFor(root)
    const { agentHome, env, install: options } = agentMachine()
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    await installAgents(['codex'], { binary }, options)
    await installAgents(['opencode'], { binary: '/other/install/vendor/9.9.7/gaze.exe' }, options)
    const homes = { ...homesOf(agentHome), claudeDesktop: null }
    assert.deepEqual(staleIntegrations(binary, homes, root), [])
    const opencode = readFileSync(path.join(agentHome, '.config', 'opencode', 'opencode.json'), 'utf8')
    assert.equal(await refreshRegistration(binary, { env, root, install: options, port: fakePort(), warn: quiet }), true)
    assert.equal(readFileSync(path.join(agentHome, '.config', 'opencode', 'opencode.json'), 'utf8'), opencode)
  })

  test('finds 0.6.x exe paths and other nodes next to the current command in JSON and TOML', () => {
    const dir = realpathSync(mkdtempSync(path.join(scratch, 'escaped-')))
    const root = path.join(dir, 'pkg')
    const shim = shimFor(root)
    const codex = path.join(dir, 'codex')
    mkdirSync(codex, { recursive: true })
    const homes = { codex, gemini: path.join(dir, 'gemini'), opencode: path.join(dir, 'opencode'), antigravity: path.join(dir, 'agy'), claudeDesktop: null }
    const toml = path.join(codex, 'config.toml')
    const hooks = path.join(codex, 'hooks.json')
    const refs = () => staleConfigs(shim, homes, root).flatMap((entry) => entry.refs)
    writeFileSync(toml, `[mcp_servers.gaze]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(shim)}, "mcp"]\n`)
    writeFileSync(hooks, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: `${shellCommand([process.execPath, shim])} hook prompt --harness codex` }] }] } }))
    assert.deepEqual(staleIntegrations(shim, homes, root), [])

    writeFileSync(hooks, JSON.stringify({ command: `${path.join(root, 'vendor', '0.6.2', 'gaze.exe')} hook prompt` }))
    assert.deepEqual(refs(), [path.join(root, 'vendor', '0.6.2', 'gaze.exe')])

    const windowsNode = 'C:\\Program Files\\nodejs\\node.exe'
    writeFileSync(hooks, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: `${shellCommand([windowsNode, shim], 'win32')} hook prompt --harness codex` }] }] } }))
    assert.deepEqual(refs(), [windowsNode])

    writeFileSync(hooks, '{}')
    writeFileSync(toml, `[mcp_servers.gaze]\ncommand = "/old/nvm/v22/bin/node"\nargs = [${JSON.stringify(shim)}, "mcp"]\n\n[mcp_servers.other]\ncommand = "/usr/bin/node"\nargs = ["/srv/other.js"]\n`)
    assert.deepEqual(refs(), ['/old/nvm/v22/bin/node'])
    writeFileSync(toml, `[mcp_servers.gaze]\ncommand = "C:\\\\nvm4w\\\\nodejs\\\\node.exe"\nargs = [${JSON.stringify(shim)}, "mcp"]\n`)
    assert.deepEqual(refs(), ['C:\\nvm4w\\nodejs\\node.exe'])
  })

  test('runs the native binary from the package directory, never from vendor/<version>/', { skip: process.platform === 'win32' }, async () => {
    const root = realpathSync(packageRoot())
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    const log = path.join(root, 'cwd.log')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, `#!/bin/sh\npwd -P >> ${JSON.stringify(log)}\nif [ "$1 $2" = "daemon status" ]; then echo '{"ok":true,"data":{"installed":true}}'; fi\n`, { mode: 0o755 })
    const { env, install: options } = agentMachine()
    await refreshRegistration(binary, { env, root, install: options, warn: quiet })
    const dirs = readFileSync(log, 'utf8').trim().split('\n')
    assert.deepEqual(dirs, [root, root, root])
  })

  test('as root, never runs gaze setup or gaze daemon install even with a registration and a daemon', { skip: process.platform === 'win32' }, async () => {
    const root = realpathSync(packageRoot())
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    const log = path.join(root, 'calls.log')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nif [ "$1 $2" = "daemon status" ]; then echo '{"ok":true,"data":{"installed":true}}'; fi\n`, { mode: 0o755 })
    const { env, install: options } = agentMachine()
    mkdirSync(path.dirname(registryManifest(env)), { recursive: true })
    writeFileSync(registryManifest(env), JSON.stringify({ version: VERSION, bin: [binary] }))
    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, euid: 0, warn: (message) => warnings.push(message) }), false)
    assert.equal(existsSync(log), false)
    assert.match(warnings.join(''), /running as root/)
  })
})
