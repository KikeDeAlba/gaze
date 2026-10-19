import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureBinary, hopAllowed, resolveTarget } from './install.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '9.9.9'
const TARGETS = ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu']
const SUPPORTED = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' }[`${process.platform}-${process.arch}`]
const SCRIPT = '#!/bin/sh\nif [ "$1" = "die" ]; then kill -TERM $$; fi\necho "fake gaze $*"\nexit "${GAZE_FAKE_EXIT:-0}"\n'
const NO_PROXY_ENV = { HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '' }
const quiet = () => {}

const scratch = mkdtempSync(path.join(tmpdir(), 'gaze-npm-test-'))
let goodArchive
let symlinkArchive
let archive
let requests = []
let server
let base
let port

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
  const assets = Object.fromEntries(targets.map((target) => [target, { file: `gaze-${version}-${target}.tar.gz`, sha256: hash }]))
  writeFileSync(path.join(root, 'npm', 'checksums.json'), JSON.stringify({ version, assets }))
}

function packageRoot(checksums = {}) {
  const root = mkdtempSync(path.join(scratch, 'pkg-'))
  mkdirSync(path.join(root, 'npm'))
  for (const file of ['install.js', 'gaze.js']) copyFileSync(path.join(HERE, file), path.join(root, 'npm', file))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@kikedealba/gaze', version: VERSION, type: 'module' }))
  if (checksums) writeChecksums(root, checksums)
  return root
}

function install(root, options = {}) {
  return ensureBinary({ root, platform: 'linux', arch: 'x64', warn: quiet, ...options, env: { GAZE_DOWNLOAD_BASE: base, ...options.env } })
}

function node(file, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...NO_PROXY_ENV, GAZE_DOWNLOAD_BASE: base, GAZE_BINARY_PATH: '', ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function run(root, args, env) {
  return node(path.join(root, 'npm', 'gaze.js'), args, env)
}

function vendorEntries(root) {
  const vendor = path.join(root, 'vendor')
  return existsSync(vendor) ? readdirSync(vendor) : []
}

before(async () => {
  goodArchive = tarball('good', (file) => writeFileSync(file, SCRIPT, { mode: 0o644 }))
  symlinkArchive = tarball('symlink', (file) => symlinkSync('/bin/sh', file))
  server = createServer((request, response) => {
    requests.push(request.url)
    const pathname = new URL(request.url, base).pathname
    const name = path.basename(pathname)
    if (pathname.startsWith('/evil/')) {
      response.writeHead(302, { Location: `http://downloads.example.com/${name}` }).end()
    } else if (pathname.startsWith('/loop/')) {
      response.writeHead(302, { Location: pathname }).end()
    } else if (pathname.startsWith(`/v${VERSION}/`) && name.endsWith('.tar.gz')) {
      response.writeHead(302, { Location: `/files/${name}` }).end()
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
  })

  test('rejects an unsupported platform with a clear error', async () => {
    assert.throws(() => resolveTarget('win32', 'x64'), /no prebuilt binary for win32-x64 \(supported: darwin-arm64, linux-x64\)/)
    const root = packageRoot()
    await assert.rejects(install(root, { platform: 'darwin', arch: 'x64' }), /no prebuilt binary for darwin-x64/)
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
    assert.deepEqual(vendorEntries(root), ['gaze'])
    assert.deepEqual(requests, [`/v${VERSION}/${asset('x86_64-unknown-linux-gnu')}`, `/files/${asset('x86_64-unknown-linux-gnu')}`])
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
    assert.deepEqual(vendorEntries(root), ['gaze'])
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

  test('--postinstall fails without checksums.json', async () => {
    const root = packageRoot(null)
    const result = await installScript(root, ['--postinstall'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, SUPPORTED ? /checksums\.json is missing/ : /no prebuilt binary/)
  })
})
