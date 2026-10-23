import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, utimesSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { archiveName, daemonMarker, ensureBinary, hopAllowed, needsRepair, olderVersion, registryManifest, repairLock, resolveTarget, startRepair, tarCommand } from './install.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '9.9.9'
const TARGETS = ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']
const SUPPORTED = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' }[`${process.platform}-${process.arch}`]
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
const BSDTAR = (() => {
  try {
    return execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('bsdtar')
  } catch {
    return false
  }
})()

const scratch = mkdtempSync(path.join(tmpdir(), 'gaze-npm-test-'))
let goodArchive
let registeringArchive
let symlinkArchive
let archive
let zipArchive
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

function vendorEntries(root) {
  const vendor = path.join(root, 'vendor')
  return existsSync(vendor) ? readdirSync(vendor).sort() : []
}

before(async () => {
  goodArchive = tarball('good', (file) => writeFileSync(file, SCRIPT, { mode: 0o644 }))
  registeringArchive = tarball('registering', (file) => writeFileSync(file, REGISTERING_SCRIPT, { mode: 0o644 }))
  symlinkArchive = tarball('symlink', (file) => symlinkSync('/bin/sh', file))
  const zipSource = mkdtempSync(path.join(scratch, 'zip-'))
  writeFileSync(path.join(zipSource, 'gaze.exe'), SCRIPT)
  const zipFile = path.join(scratch, 'good.zip')
  try {
    execFileSync('zip', ['-q', '-j', zipFile, path.join(zipSource, 'gaze.exe')])
    zipArchive = readFileSync(zipFile)
  } catch {}
  server = createServer((request, response) => {
    requests.push(request.url)
    const pathname = new URL(request.url, base).pathname
    const name = path.basename(pathname)
    if (pathname.startsWith('/evil/')) {
      response.writeHead(302, { Location: `http://downloads.example.com/${name}` }).end()
    } else if (pathname.startsWith('/loop/')) {
      response.writeHead(302, { Location: pathname }).end()
    } else if (/^\/v\d+\.\d+\.\d+\//.test(pathname) && /\.(tar\.gz|zip)$/.test(name)) {
      response.writeHead(302, { Location: `/files/${name}` }).end()
    } else if (pathname.startsWith('/files/') && name.endsWith('.zip')) {
      response.writeHead(200, { 'Content-Type': 'application/zip' }).end(zipArchive)
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
    assert.equal(resolveTarget('darwin', 'x64'), 'x86_64-apple-darwin')
    assert.equal(resolveTarget('linux', 'arm64'), 'aarch64-unknown-linux-gnu')
    assert.equal(resolveTarget('win32', 'x64'), 'x86_64-pc-windows-msvc')
  })

  test('rejects an unsupported platform with a clear error', async () => {
    assert.throws(() => resolveTarget('win32', 'arm64'), /no prebuilt binary for win32-arm64 \(supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64\)/)
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
    assert.equal(statSync(binary).mode & 0o777, 0o755)
    assert.equal(readFileSync(binary, 'utf8'), SCRIPT)
    assert.deepEqual(vendorEntries(root), ['.version', 'gaze'])
    assert.deepEqual(requests, [`/v${VERSION}/${asset('x86_64-unknown-linux-gnu')}`, `/files/${asset('x86_64-unknown-linux-gnu')}`])
  })

  test('extracts gaze.exe from the zip for win32-x64 without chmod', { skip: (zipArchive === undefined || !BSDTAR) && 'needs zip and a tar that reads zip (bsdtar)' }, async () => {
    const root = packageRoot({ targets: ['x86_64-pc-windows-msvc'], hash: sha256(zipArchive) })
    const binary = await install(root, { platform: 'win32', arch: 'x64' })
    assert.equal(binary, path.join(root, 'vendor', 'gaze.exe'))
    assert.equal(readFileSync(binary, 'utf8'), SCRIPT)
    assert.deepEqual(vendorEntries(root), ['.version', 'gaze.exe'])
    assert.deepEqual(requests, [`/v${VERSION}/gaze-${VERSION}-x86_64-pc-windows-msvc.zip`, `/files/gaze-${VERSION}-x86_64-pc-windows-msvc.zip`])
  })

  test('replaces an existing gaze.exe by setting the old one aside first', { skip: (zipArchive === undefined || !BSDTAR) && 'needs zip and a tar that reads zip (bsdtar)' }, async () => {
    const root = packageRoot({ targets: ['x86_64-pc-windows-msvc'], hash: sha256(zipArchive) })
    mkdirSync(path.join(root, 'vendor'))
    writeFileSync(path.join(root, 'vendor', 'gaze.exe'), 'old')
    writeFileSync(path.join(root, 'vendor', 'gaze.exe.old-abcdef'), 'stale')
    writeFileSync(path.join(root, 'vendor', '.version'), '9.9.8\n')
    const binary = await install(root, { platform: 'win32', arch: 'x64' })
    assert.equal(readFileSync(binary, 'utf8'), SCRIPT)
    assert.deepEqual(vendorEntries(root), ['.version', 'gaze.exe'])
  })

  test('uses the System32 tar on windows and the PATH tar elsewhere', () => {
    assert.equal(tarCommand({ SystemRoot: 'D:\\Win' }, 'win32'), 'D:\\Win\\System32\\tar.exe')
    assert.equal(tarCommand({}, 'win32'), 'C:\\Windows\\System32\\tar.exe')
    assert.equal(tarCommand({ SystemRoot: 'D:\\Win' }, 'linux'), 'tar')
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
    assert.match(result.stderr, SUPPORTED ? /^gaze: Cannot download .*HTTP 404/m : /^gaze: gaze has no prebuilt binary/m)
  })

  test('--postinstall tolerates a network failure and defers the download', { skip: !SUPPORTED }, async () => {
    const root = packageRoot()
    const result = await installScript(root, ['--postinstall'], { GAZE_DOWNLOAD_BASE: `${base}/missing` })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /could not download the binary during install .*HTTP 404.*downloaded the first time gaze runs/)
    assert.deepEqual(vendorEntries(root), [])
  })

  test('--postinstall fails on a checksum mismatch', { skip: !SUPPORTED }, async () => {
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
    assert.match(result.stderr, SUPPORTED ? /checksums\.json is missing/ : /no prebuilt binary/)
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
