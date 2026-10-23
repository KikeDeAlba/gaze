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
import { acquireLock, archiveName, daemonMarker, ensureBinary, hopAllowed, needsRepair, olderVersion, redactUrl, refreshRegistration, registryManifest, repairLock, resolveTarget, restoreConfigs, runInstall, snapshotConfigs, staleIntegrations, startRepair } from './install.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '9.9.9'
const TARGETS = ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']
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
const NO_PROXY_ENV = { HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '', KIT_REGISTRY_DIR: '', XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', GAZE_DATA_DIR: '', GAZE_DB_PATH: '' }
const quiet = () => {}
const WINDOWS = 'x86_64-pc-windows-msvc'
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

function markFor(binary, hash = sha256(EXE)) {
  const stats = statSync(binary)
  return `${JSON.stringify({ sha256: hash, size: stats.size, mtimeMs: stats.mtimeMs })}\n`
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
    if (fail.rmSync?.(args[0])) throw busy('EBUSY', args[0])
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
    assert.equal(resolveTarget('win32', 'x64'), 'x86_64-pc-windows-msvc')
  })

  test('rejects an unsupported platform with a clear error', async () => {
    assert.throws(() => resolveTarget('win32', 'arm64'), /no prebuilt binary for win32-arm64 \(supported: darwin-arm64, linux-x64, linux-arm64, win32-x64\)/)
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

describe('ensureBinary on win32', () => {
  const exeAsset = `gaze-${VERSION}-${WINDOWS}.exe`

  function windowsRoot(options = {}) {
    return packageRoot({ targets: [WINDOWS], hash: sha256(EXE), ...options })
  }

  function installWindows(root, options = {}) {
    return install(root, { platform: 'win32', arch: 'x64', ...options })
  }

  test('names the windows asset as a raw .exe', () => {
    assert.equal(archiveName(VERSION, WINDOWS), exeAsset)
    assert.equal(archiveName(VERSION, 'x86_64-unknown-linux-gnu'), `gaze-${VERSION}-x86_64-unknown-linux-gnu.tar.gz`)
  })

  test('writes the verified .exe once into vendor/<version>/ without tar, renames or temp dirs', async () => {
    const root = windowsRoot()
    const calls = []
    const binary = await watchingFs(calls, () => installWindows(root))
    assert.equal(binary, path.join(root, 'vendor', VERSION, 'gaze.exe'))
    assert.deepEqual(readFileSync(binary), EXE)
    assert.deepEqual(vendorEntries(root), [VERSION])
    assert.deepEqual(vendorEntries(root, VERSION), ['.verified', 'gaze.exe'])
    assert.equal(readFileSync(path.join(root, 'vendor', VERSION, '.verified'), 'utf8'), markFor(binary))
    assert.deepEqual(requests, [`/v${VERSION}/${exeAsset}`, `/files/${exeAsset}`])
    assert.deepEqual(calls.filter(([name]) => name === 'renameSync' || name === 'execFileSync'), [])
    assert.deepEqual(calls.filter(([, target]) => /\.(install|old)-/.test(String(target))), [])

    requests = []
    assert.equal(await installWindows(root), binary)
    assert.equal(requests.length, 0)
  })

  test('removes older versions and the old layout, leaving no .old-* or .install-* entries', async () => {
    const root = windowsRoot()
    const vendor = path.join(root, 'vendor')
    mkdirSync(path.join(vendor, '9.9.8'), { recursive: true })
    writeFileSync(path.join(vendor, '9.9.8', 'gaze.exe'), 'old')
    writeFileSync(path.join(vendor, 'gaze.exe'), 'legacy')
    writeFileSync(path.join(vendor, 'gaze.exe.old-abcdef'), 'stale')
    writeFileSync(path.join(vendor, '.version'), '9.9.8\n')
    mkdirSync(path.join(vendor, '.install-old'))
    const binary = await installWindows(root)
    assert.deepEqual(readFileSync(binary), EXE)
    assert.deepEqual(vendorEntries(root), [VERSION])
    assert.deepEqual(vendorEntries(root, VERSION), ['.verified', 'gaze.exe'])
  })

  test('upgrades the 0.6.1 layout (vendor/gaze.exe and vendor/.version) to vendor/0.6.2/', async () => {
    const root = windowsRoot({ version: '0.6.2' })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@kikedealba/gaze', version: '0.6.2', type: 'module' }))
    const vendor = path.join(root, 'vendor')
    mkdirSync(vendor, { recursive: true })
    writeFileSync(path.join(vendor, 'gaze.exe'), 'gaze 0.6.1')
    writeFileSync(path.join(vendor, '.version'), '0.6.1\n')
    assert.equal(await installWindows(root, { offline: true }), null)
    assert.deepEqual(vendorEntries(root), ['.version', 'gaze.exe'])
    assert.equal(requests.length, 0)
    const binary = await installWindows(root)
    assert.equal(binary, path.join(vendor, '0.6.2', 'gaze.exe'))
    assert.deepEqual(readFileSync(binary), EXE)
    assert.deepEqual(vendorEntries(root), ['0.6.2'])
    assert.deepEqual(vendorEntries(root, '0.6.2'), ['.verified', 'gaze.exe'])
  })

  test('offline mode without a mark verifies once, migrates the old layout and never downloads', async () => {
    const root = windowsRoot()
    const vendor = path.join(root, 'vendor')
    mkdirSync(path.join(vendor, VERSION), { recursive: true })
    writeFileSync(path.join(vendor, VERSION, 'gaze.exe'), EXE)
    writeFileSync(path.join(vendor, 'gaze.exe'), 'legacy')
    writeFileSync(path.join(vendor, '.version'), '9.9.8\n')
    const binary = path.join(vendor, VERSION, 'gaze.exe')
    assert.equal(await installWindows(root, { offline: true }), binary)
    assert.deepEqual(vendorEntries(root), [VERSION])
    assert.equal(readFileSync(path.join(vendor, VERSION, '.verified'), 'utf8'), markFor(path.join(vendor, VERSION, 'gaze.exe')))
    assert.equal(requests.length, 0)
  })

  test('offline mode without a mark rejects a gaze.exe with another hash and leaves it in place', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, 'tampered')
    assert.equal(await installWindows(root, { offline: true }), null)
    assert.equal(readFileSync(binary, 'utf8'), 'tampered')
    assert.equal(existsSync(path.join(path.dirname(binary), '.verified')), false)
    assert.equal(requests.length, 0)
  })

  test('trusts gaze.exe without reading it when .verified holds the expected sha256', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, 'not hashed')
    writeFileSync(path.join(path.dirname(binary), '.verified'), markFor(binary))
    const calls = []
    assert.equal(await watchingFs(calls, () => installWindows(root, { offline: true })), binary)
    assert.equal(await watchingFs(calls, () => installWindows(root)), binary)
    assert.deepEqual(calls.filter(([name, target]) => name === 'readFileSync' && target === binary), [])
    assert.equal(readFileSync(binary, 'utf8'), 'not hashed')
    assert.equal(requests.length, 0)
  })

  test('verifies a gaze.exe without .verified once and then writes the mark', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    const marker = path.join(path.dirname(binary), '.verified')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, EXE)
    const first = []
    assert.equal(await watchingFs(first, () => installWindows(root, { offline: true })), binary)
    assert.ok(first.some(([name, target]) => name === 'readFileSync' && target === binary))
    assert.equal(readFileSync(marker, 'utf8'), markFor(binary))
    const second = []
    assert.equal(await watchingFs(second, () => installWindows(root, { offline: true })), binary)
    assert.deepEqual(second.filter(([name, target]) => name === 'readFileSync' && target === binary), [])
    assert.equal(requests.length, 0)
  })

  test('ignores a .verified mark for another sha256 and rewrites a bad gaze.exe', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    const marker = path.join(path.dirname(binary), '.verified')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, 'other build')
    writeFileSync(marker, `${'a'.repeat(64)}\n`)
    const stale = new Date(Date.now() - 60 * 1000)
    utimesSync(binary, stale, stale)
    assert.equal(await installWindows(root, { offline: true }), null)
    assert.equal(await installWindows(root), binary)
    assert.deepEqual(readFileSync(binary), EXE)
    assert.equal(readFileSync(marker, 'utf8'), markFor(binary))
  })

  test('ignores EBUSY while removing an older version that is still running', async () => {
    const root = windowsRoot()
    const old = path.join(root, 'vendor', '9.9.8')
    mkdirSync(old, { recursive: true })
    writeFileSync(path.join(old, 'gaze.exe'), 'running')
    const calls = []
    const binary = await watchingFs(calls, () => installWindows(root), { rmSync: (target) => target === old })
    assert.deepEqual(readFileSync(binary), EXE)
    assert.deepEqual(vendorEntries(root), ['9.9.8', VERSION])
    assert.ok(calls.some(([name, target]) => name === 'rmSync' && target === old))

    await installWindows(root)
    assert.deepEqual(vendorEntries(root), [VERSION])
  })

  test('rewrites a gaze.exe whose sha256 does not match', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, EXE.subarray(0, 10))
    const stale = new Date(Date.now() - 60 * 1000)
    utimesSync(binary, stale, stale)
    assert.equal(await installWindows(root, { offline: true }), null)
    assert.equal(await installWindows(root), binary)
    assert.deepEqual(readFileSync(binary), EXE)
    assert.deepEqual(requests, [`/v${VERSION}/${exeAsset}`, `/files/${exeAsset}`])
  })

  test('waits for a concurrent install that is still writing gaze.exe', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, EXE.subarray(0, 10))
    const finish = new Promise((resolve) => setTimeout(() => resolve(writeFileSync(binary, EXE)), 300))
    assert.equal(existsSync(path.join(path.dirname(binary), '.verified')), false)
    assert.equal(await installWindows(root), binary)
    await finish
    assert.deepEqual(readFileSync(binary), EXE)
    assert.equal(readFileSync(path.join(path.dirname(binary), '.verified'), 'utf8'), markFor(binary))
  })

  test('rehashes a truncated gaze.exe even though .verified is present', async () => {
    const root = windowsRoot()
    const binary = await installWindows(root)
    const marker = path.join(path.dirname(binary), '.verified')
    writeFileSync(binary, EXE.subarray(0, 10))
    const stale = new Date(Date.now() - 60 * 1000)
    utimesSync(binary, stale, stale)
    writeFileSync(marker, `${JSON.stringify({ sha256: sha256(EXE), size: EXE.length, mtimeMs: statSync(binary).mtimeMs })}\n`)
    requests = []
    const calls = []
    assert.equal(await watchingFs(calls, () => installWindows(root, { offline: true })), null)
    assert.ok(calls.some(([name, target]) => name === 'readFileSync' && target === binary))
    assert.equal(await installWindows(root), binary)
    assert.deepEqual(readFileSync(binary), EXE)
    assert.equal(readFileSync(marker, 'utf8'), markFor(binary))
    assert.deepEqual(requests, [`/v${VERSION}/${exeAsset}`, `/files/${exeAsset}`])
  })

  test('rehashes a gaze.exe replaced with another mtime even though .verified is present', async () => {
    const root = windowsRoot()
    const binary = await installWindows(root)
    const marker = path.join(path.dirname(binary), '.verified')
    const mark = readFileSync(marker, 'utf8')
    writeFileSync(binary, Buffer.alloc(EXE.length, 'x'))
    const later = new Date(statSync(binary).mtimeMs + 5000)
    utimesSync(binary, later, later)
    assert.equal(statSync(binary).size, EXE.length)
    assert.equal(readFileSync(marker, 'utf8'), mark)
    const calls = []
    assert.equal(await watchingFs(calls, () => installWindows(root, { offline: true })), null)
    assert.ok(calls.some(([name, target]) => name === 'readFileSync' && target === binary))
    assert.deepEqual(readFileSync(binary), Buffer.alloc(EXE.length, 'x'))
  })

  test('does not trust a .verified mark that is a symlink', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, 'not hashed')
    const elsewhere = path.join(root, 'mark')
    writeFileSync(elsewhere, markFor(binary))
    symlinkSync(elsewhere, path.join(path.dirname(binary), '.verified'))
    assert.equal(await installWindows(root, { offline: true }), null)
  })

  test('never removes or rewrites gaze.exe while an antivirus keeps it busy', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, EXE)
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const calls = []
      await assert.rejects(
        watchingFs(calls, () => installWindows(root), { readFileSync: (target) => target === binary && code }),
        (error) => error.name === 'BusyError' && error.message.includes(`Cannot read ${binary}: ${code}`) && /antivirus/.test(error.message),
      )
      assert.equal(calls.filter(([name, target]) => name === 'readFileSync' && target === binary).length, 5)
      assert.deepEqual(calls.filter(([name, target]) => (name === 'rmSync' || name === 'writeFileSync') && target === binary), [])
      assert.deepEqual(readFileSync(binary), EXE)
    }
    assert.equal(requests.length, 0)
  })

  test('retries a gaze.exe that is busy for a moment and then marks it', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, EXE)
    let failures = 2
    const calls = []
    const result = await watchingFs(calls, () => installWindows(root, { offline: true }), { readFileSync: (target) => target === binary && failures-- > 0 && 'EBUSY' })
    assert.equal(result, binary)
    assert.equal(readFileSync(path.join(path.dirname(binary), '.verified'), 'utf8'), markFor(binary))
  })

  test('installs even when the .verified mark cannot be written', async () => {
    const root = windowsRoot()
    const marker = path.join(root, 'vendor', VERSION, '.verified')
    const binary = await watchingFs([], () => installWindows(root), { writeFileSync: (target) => target === marker && 'EPERM' })
    assert.deepEqual(readFileSync(binary), EXE)
    assert.deepEqual(vendorEntries(root, VERSION), ['gaze.exe'])
    assert.equal(await installWindows(root, { offline: true }), binary)
    assert.deepEqual(vendorEntries(root, VERSION), ['.verified', 'gaze.exe'])
  })

  test('removes anything but gaze.exe and .verified from vendor/<version>/ before using it', async () => {
    const root = windowsRoot()
    const binary = await installWindows(root)
    const dir = path.dirname(binary)
    writeFileSync(path.join(dir, 'version.dll'), 'planted')
    mkdirSync(path.join(dir, 'sub'))
    writeFileSync(path.join(dir, 'sub', 'evil.dll'), 'planted')
    assert.equal(await installWindows(root, { offline: true }), binary)
    assert.deepEqual(vendorEntries(root, VERSION), ['.verified', 'gaze.exe'])

    writeFileSync(path.join(dir, 'version.dll'), 'planted')
    await assert.rejects(
      watchingFs([], () => installWindows(root, { offline: true }), { rmSync: (target) => target === path.join(dir, 'version.dll') }),
      /Cannot remove .*version\.dll, which does not belong in .*EBUSY/,
    )
  })

  test('postinstall warns and exits 0 while an antivirus keeps gaze.exe busy', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, EXE)
    let stderr = ''
    const options = { root, platform: 'win32', arch: 'x64', warn: quiet, env: { GAZE_DOWNLOAD_BASE: base }, write: (text) => (stderr += text) }
    const code = await watchingFs([], () => runInstall('--postinstall', undefined, options), { readFileSync: (target) => target === binary && 'EBUSY' })
    assert.equal(code, 0)
    assert.match(stderr, /^gaze: could not finish installing the binary \(Cannot read .*EBUSY.*\); it will be completed the first time gaze runs\n$/)
    assert.deepEqual(readFileSync(binary), EXE)

    writeFileSync(path.join(path.dirname(binary), 'version.dll'), 'planted')
    stderr = ''
    const pruned = await watchingFs([], () => runInstall('--postinstall', undefined, options), { rmSync: (target) => target.endsWith('version.dll') })
    assert.equal(pruned, 0)
    assert.match(stderr, /could not finish installing the binary \(Cannot remove .*version\.dll/)
    stderr = ''
    assert.equal(await runInstall('', undefined, options), 0)
    assert.equal(await watchingFs([], () => runInstall('', undefined, options), { rmSync: (target) => target.endsWith('version.dll') }), 0)
  })

  test('a gaze.exe that cannot be replaced gets its own error, not the npm prefix one', async () => {
    const root = windowsRoot()
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, 'other build')
    const stale = new Date(Date.now() - 60 * 1000)
    utimesSync(binary, stale, stale)
    const failure = await watchingFs([], () => installWindows(root).catch((error) => error), { rmSync: (target) => target === binary })
    assert.equal(failure.name, 'BusyError')
    assert.match(failure.message, /^Cannot replace .*gaze\.exe, whose sha256 does not match: EBUSY/)
    assert.doesNotMatch(failure.message, /npm global prefix/)
    assert.equal(readFileSync(binary, 'utf8'), 'other build')
  })

  test('offline mode uses a verified gaze.exe and never downloads', async () => {
    const root = windowsRoot()
    assert.equal(await installWindows(root, { offline: true }), null)
    const binary = path.join(root, 'vendor', VERSION, 'gaze.exe')
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, EXE)
    assert.equal(await installWindows(root, { offline: true }), binary)
    assert.equal(requests.length, 0)
  })

  test('fails on a checksum mismatch and writes nothing', async () => {
    const root = windowsRoot({ hash: '0'.repeat(64) })
    await assert.rejects(installWindows(root), /Checksum mismatch for gaze-9\.9\.9-x86_64-pc-windows-msvc\.exe: expected 0{64}/)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('refuses a checksums.json that still lists the windows zip', async () => {
    const root = windowsRoot()
    writeFileSync(path.join(root, 'npm', 'checksums.json'), JSON.stringify({ version: VERSION, assets: { [WINDOWS]: { file: `gaze-${VERSION}-${WINDOWS}.zip`, sha256: sha256(EXE) } } }))
    await assert.rejects(installWindows(root), /lists gaze-9\.9\.9-x86_64-pc-windows-msvc\.zip for x86_64-pc-windows-msvc, expected gaze-9\.9\.9-x86_64-pc-windows-msvc\.exe/)
    assert.equal(requests.length, 0)
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

describe('agent integrations after a windows upgrade', () => {
  const AGENTS = ['codex', 'gemini', 'opencode', 'antigravity', 'claude-desktop']

  function windowsPackage(version) {
    const root = packageRoot({ targets: [WINDOWS], hash: sha256(EXE), version }, version)
    symlinkSync(path.join(HERE, '..', 'node_modules'), path.join(root, 'node_modules'))
    cpSync(path.join(HERE, '..', 'skills'), path.join(root, 'skills'), { recursive: true })
    copyFileSync(path.join(HERE, 'antigravity.md'), path.join(root, 'npm', 'antigravity.md'))
    return realpathSync(root)
  }

  function upgrade(root, version) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@kikedealba/gaze', version, type: 'module' }))
    writeChecksums(root, { version, targets: [WINDOWS], hash: sha256(EXE) })
  }

  function agentMachine() {
    const agentHome = realpathSync(mkdtempSync(path.join(scratch, 'home-')))
    mkdirSync(path.join(agentHome, 'Library', 'Application Support', 'Claude'), { recursive: true })
    const env = { HOME: agentHome, PATH: '', KIT_REGISTRY_DIR: path.join(agentHome, 'tools.d'), GAZE_DATA_DIR: path.join(agentHome, 'data') }
    const install = { ctx: platformContext({ platform: 'darwin', home: agentHome, env }), locate: async () => null, exec: async () => '' }
    return { agentHome, env, install }
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

  test('postinstall and repair point every integrated agent at the exe of the new version', async () => {
    const root = windowsPackage('9.9.8')
    const { agentHome, env, install: options } = agentMachine()
    const old = await install(root, { platform: 'win32', arch: 'x64', install: options })
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    const { steps } = await installAgents(AGENTS, { binary: old }, options)
    assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
    const before = referenced(agentHome)
    assert.ok(before.length >= 7, before.join('\n'))
    assert.ok(before.every((file) => file === old))

    upgrade(root, '9.9.9')
    const binary = await install(root, { platform: 'win32', arch: 'x64', install: options })
    assert.equal(binary, path.join(root, 'vendor', '9.9.9', 'gaze.exe'))
    assert.ok(existsSync(old), 'the old exe stays while the agent configs still point to it')
    assert.deepEqual(staleIntegrations(binary, { codex: path.join(agentHome, '.codex'), gemini: path.join(agentHome, '.gemini'), opencode: path.join(agentHome, '.config', 'opencode'), antigravity: path.join(agentHome, '.gemini', 'config'), claudeDesktop: path.join(agentHome, 'Library', 'Application Support', 'Claude') }, root), AGENTS)

    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, warn: (message) => warnings.push(message) }), true, warnings.join(''))
    const after = referenced(agentHome)
    assert.equal(after.length, before.length)
    for (const file of after) {
      assert.equal(file, binary)
      assert.ok(existsSync(file), file)
    }
    assert.deepEqual(warnings, [])
    assert.equal(await install(root, { platform: 'win32', arch: 'x64', install: options }), binary)
    assert.equal(existsSync(path.dirname(old)), false)
    assert.deepEqual(vendorEntries(root), ['9.9.9'])
  })

  test('keeps the mode of 0600 configs, their backups and the configs behind a symlink', { skip: process.platform === 'win32' }, async () => {
    const root = windowsPackage('9.9.8')
    const { agentHome, env, install: options } = agentMachine()
    const old = await install(root, { platform: 'win32', arch: 'x64', install: options })
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

    upgrade(root, '9.9.9')
    const binary = await install(root, { platform: 'win32', arch: 'x64', install: options })
    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, warn: (message) => warnings.push(message) }), true, warnings.join(''))
    for (const file of [codex, hooks, agy, real]) assert.equal(statSync(file).mode & 0o777, 0o600, file)
    for (const file of [codex, hooks, agy, opencode]) {
      if (existsSync(`${file}.backup`)) assert.equal(statSync(`${file}.backup`).mode & 0o777, 0o600, `${file}.backup`)
    }
    assert.ok(fs.lstatSync(opencode).isSymbolicLink())
    assert.equal(realpathSync(opencode), realpathSync(real))
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).mcp.gaze.command, [binary, 'mcp'])
    assert.ok(readFileSync(codex, 'utf8').includes(binary))
  })

  test('warns about a config it cannot rewrite and keeps the old version it points to', async () => {
    const root = windowsPackage('9.9.8')
    const { agentHome, env, install: options } = agentMachine()
    const old = await install(root, { platform: 'win32', arch: 'x64', install: options })
    const jsonc = path.join(agentHome, '.config', 'opencode', 'opencode.jsonc')
    mkdirSync(path.dirname(jsonc), { recursive: true })
    writeFileSync(jsonc, `{\n  // gaze from npm\n  "mcp": { "gaze": { "type": "local", "command": [${JSON.stringify(old)}, "mcp"] } }\n}\n`)

    upgrade(root, '9.9.9')
    const binary = await install(root, { platform: 'win32', arch: 'x64', install: options })
    assert.ok(existsSync(old))
    const warnings = []
    assert.equal(await refreshRegistration(binary, { env, root, install: options, warn: (message) => warnings.push(message) }), false)
    assert.deepEqual(warnings, [`gaze: ${jsonc} still points to ${old}; run \`gaze setup\`\n`])
    assert.equal(await install(root, { platform: 'win32', arch: 'x64', install: options }), binary)
    assert.ok(existsSync(old), 'the version a config still uses is not removed')
    assert.deepEqual(vendorEntries(root), ['9.9.8', '9.9.9'])
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
    restoreConfigs(snapshots, { euid: 501, warn: (message) => warnings.push(message) })
    assert.deepEqual(warnings, [])
    assert.ok(fs.lstatSync(file).isSymbolicLink())
    assert.equal(readFileSync(real, 'utf8'), '{"new":true}\n')
    assert.equal(statSync(real).mode & 0o777, 0o600)
    assert.equal(statSync(`${file}.backup`).mode & 0o777, 0o600)
  })

  test('as root, never restores a config owned by another user', { skip: process.platform === 'win32' }, () => {
    const { real, file } = linkedConfig()
    const snapshots = snapshotConfigs([file]).map((snapshot) => ({ ...snapshot, uid: 501 }))
    kitRewrite(file, '{"new":true}\n')
    const warnings = []
    restoreConfigs(snapshots, { euid: 0, warn: (message) => warnings.push(message) })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /running as root, so the mode and symlink of .*config\.json were not restored/)
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false)
    assert.equal(readFileSync(real, 'utf8'), '{"old":true}\n')
  })

  test('skips the restore when the symlink target changed inode after the snapshot', { skip: process.platform === 'win32' }, () => {
    const { dir, real, file } = linkedConfig()
    const snapshots = snapshotConfigs([file])
    kitRewrite(file, '{"new":true}\n')
    const swapped = path.join(dir, 'swapped')
    writeFileSync(swapped, 'someone else', { mode: 0o644 })
    fs.renameSync(swapped, real)
    const warnings = []
    restoreConfigs(snapshots, { euid: 501, warn: (message) => warnings.push(message) })
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
    restoreConfigs(snapshots, { euid: 501, warn: (message) => warnings.push(message) })
    assert.equal(warnings.length, 1)
    assert.equal(statSync(other).mode & 0o777, 0o644)
  })

  test('does not remove old versions when the agent configs cannot be read', async () => {
    const root = windowsPackage('9.9.8')
    const { install: options } = agentMachine()
    const old = await install(root, { platform: 'win32', arch: 'x64', install: options })
    upgrade(root, '9.9.9')
    const broken = { ...options, homes: new Proxy({}, { get: () => { throw new Error('kit exploded') } }) }
    const binary = await install(root, { platform: 'win32', arch: 'x64', install: broken })
    assert.ok(existsSync(old))
    assert.deepEqual(vendorEntries(root), ['9.9.8', '9.9.9'])
    assert.equal(await install(root, { platform: 'win32', arch: 'x64', install: options }), binary)
    assert.deepEqual(vendorEntries(root), ['9.9.9'])
  })

  test('does not remove old versions when an agent config is unreadable', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const root = windowsPackage('9.9.8')
    const { agentHome, install: options } = agentMachine()
    const old = await install(root, { platform: 'win32', arch: 'x64', install: options })
    const hooks = path.join(agentHome, '.codex', 'hooks.json')
    mkdirSync(path.dirname(hooks), { recursive: true })
    writeFileSync(hooks, '{}')
    chmodSync(hooks, 0o000)
    upgrade(root, '9.9.9')
    await install(root, { platform: 'win32', arch: 'x64', install: options })
    assert.ok(existsSync(old))
    chmodSync(hooks, 0o600)
  })

  test('leaves the agent configs alone with GAZE_BINARY_PATH', async () => {
    const root = windowsPackage('9.9.8')
    const { agentHome, env, install: options } = agentMachine()
    const old = await install(root, { platform: 'win32', arch: 'x64', install: options })
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    await installAgents(['codex'], { binary: old }, options)
    const config = readFileSync(path.join(agentHome, '.codex', 'config.toml'), 'utf8')
    const binary = path.join(root, 'vendor', '9.9.9', 'gaze.exe')
    assert.equal(await refreshRegistration(binary, { env: { ...env, GAZE_BINARY_PATH: '/usr/local/bin/gaze' }, root, install: options, warn: quiet }), true)
    assert.equal(readFileSync(path.join(agentHome, '.codex', 'config.toml'), 'utf8'), config)
  })

  test('does not touch agents that already point at the current exe or at another install', async () => {
    const root = windowsPackage('9.9.9')
    const binary = await install(root, { platform: 'win32', arch: 'x64' })
    const { agentHome, env, install: options } = agentMachine()
    const { installAgents } = await import(pathToFileURL(path.join(root, 'npm', 'setup.js')).href)
    await installAgents(['codex'], { binary }, options)
    const other = '/other/install/vendor/9.9.7/gaze.exe'
    await installAgents(['opencode'], { binary: other }, options)
    const homes = { codex: path.join(agentHome, '.codex'), gemini: path.join(agentHome, '.gemini'), opencode: path.join(agentHome, '.config', 'opencode'), antigravity: path.join(agentHome, '.gemini', 'config'), claudeDesktop: null }
    assert.deepEqual(staleIntegrations(binary, homes, root), [])
    const opencode = readFileSync(path.join(agentHome, '.config', 'opencode', 'opencode.json'), 'utf8')
    assert.equal(await refreshRegistration(binary, { env, root, install: options, warn: quiet }), true)
    assert.equal(readFileSync(path.join(agentHome, '.config', 'opencode', 'opencode.json'), 'utf8'), opencode)
  })

  test('finds a stale vendor path next to the current one in JSON and TOML', () => {
    const dir = mkdtempSync(path.join(scratch, 'escaped-'))
    const root = path.join(dir, 'pkg')
    const current = path.join(root, 'vendor', '0.6.2', 'gaze.exe')
    const codex = path.join(dir, 'codex')
    mkdirSync(codex, { recursive: true })
    const homes = { codex, gemini: path.join(dir, 'gemini'), opencode: path.join(dir, 'opencode'), antigravity: path.join(dir, 'agy'), claudeDesktop: null }
    writeFileSync(path.join(codex, 'config.toml'), `[mcp_servers.gaze]\ncommand = ${JSON.stringify(current)}\n`)
    assert.deepEqual(staleIntegrations(current, homes, root), [])
    writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify({ command: `${path.join(root, 'vendor', 'gaze.exe')} hook prompt` }))
    assert.deepEqual(staleIntegrations(current, homes, root), ['codex'])
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
})
