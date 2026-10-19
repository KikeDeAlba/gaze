import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureBinary, resolveTarget } from './install.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '9.9.9'
const SUPPORTED = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' }[`${process.platform}-${process.arch}`]
const SCRIPT = '#!/bin/sh\nif [ "$1" = "die" ]; then kill -TERM $$; fi\necho "fake gaze $*"\nexit "${GAZE_FAKE_EXIT:-0}"\n'

const scratch = mkdtempSync(path.join(tmpdir(), 'gaze-npm-test-'))
let archive
let checksum
let requests = []
let server
let base

function packageRoot() {
  const root = mkdtempSync(path.join(scratch, 'pkg-'))
  mkdirSync(path.join(root, 'npm'))
  for (const file of ['install.js', 'gaze.js']) copyFileSync(path.join(HERE, file), path.join(root, 'npm', file))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@kikedealba/gaze', version: VERSION, type: 'module' }))
  return root
}

function asset(target = SUPPORTED) {
  return `gaze-${VERSION}-${target}.tar.gz`
}

function run(root, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'npm', 'gaze.js'), ...args], { env: { ...process.env, GAZE_DOWNLOAD_BASE: base, GAZE_BINARY_PATH: '', ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

before(async () => {
  const source = path.join(scratch, 'source')
  mkdirSync(source)
  writeFileSync(path.join(source, 'gaze'), SCRIPT, { mode: 0o644 })
  const tarball = path.join(scratch, 'fake.tar.gz')
  execFileSync('tar', ['-czf', tarball, '-C', source, 'gaze'])
  archive = readFileSync(tarball)
  server = createServer((request, response) => {
    requests.push(request.url)
    const name = path.basename(request.url)
    if (request.url.startsWith(`/v${VERSION}/`) && name.endsWith('.tar.gz')) {
      response.writeHead(302, { Location: `/files/${name}` }).end()
    } else if (request.url.startsWith('/files/') && name.endsWith('.tar.gz')) {
      response.writeHead(200, { 'Content-Type': 'application/gzip' }).end(archive)
    } else if (name.endsWith('.tar.gz.sha256')) {
      response.writeHead(200).end(checksum(name.replace(/\.sha256$/, '')))
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
  requests = []
  checksum = (name) => `${createHash('sha256').update(archive).digest('hex')}  ${name}\n`
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
    await assert.rejects(ensureBinary({ root, platform: 'darwin', arch: 'x64', env: { GAZE_DOWNLOAD_BASE: base } }), /no prebuilt binary for darwin-x64/)
    assert.equal(requests.length, 0)
    assert.equal(existsSync(path.join(root, 'vendor', 'gaze')), false)
  })
})

describe('ensureBinary', () => {
  test('downloads, verifies and extracts the release asset into vendor/', async () => {
    const root = packageRoot()
    const binary = await ensureBinary({ root, platform: 'linux', arch: 'x64', env: { GAZE_DOWNLOAD_BASE: `${base}/` } })
    assert.equal(binary, path.join(root, 'vendor', 'gaze'))
    assert.equal(statSync(binary).mode & 0o777, 0o755)
    assert.equal(readFileSync(binary, 'utf8'), SCRIPT)
    assert.deepEqual(readdirSync(path.join(root, 'vendor')), ['gaze'])
    assert.deepEqual(requests.sort(), [`/files/${asset('x86_64-unknown-linux-gnu')}`, `/v${VERSION}/${asset('x86_64-unknown-linux-gnu')}`, `/v${VERSION}/${asset('x86_64-unknown-linux-gnu')}.sha256`].sort())
  })

  test('fails on a checksum mismatch and leaves no binary behind', async () => {
    checksum = (name) => `${'0'.repeat(64)}  ${name}\n`
    const root = packageRoot()
    await assert.rejects(ensureBinary({ root, platform: 'darwin', arch: 'arm64', env: { GAZE_DOWNLOAD_BASE: base } }), /Checksum mismatch for gaze-9\.9\.9-aarch64-apple-darwin\.tar\.gz: expected 0{64}, got [0-9a-f]{64}/)
    assert.equal(existsSync(path.join(root, 'vendor', 'gaze')), false)
    assert.deepEqual(existsSync(path.join(root, 'vendor')) ? readdirSync(path.join(root, 'vendor')) : [], [])
  })

  test('fails clearly when the release asset does not exist', async () => {
    const root = packageRoot()
    await assert.rejects(ensureBinary({ root, platform: 'linux', arch: 'x64', env: { GAZE_DOWNLOAD_BASE: `${base}/missing` } }), /Cannot download .*: HTTP 404/)
    assert.equal(existsSync(path.join(root, 'vendor', 'gaze')), false)
  })

  test('uses GAZE_BINARY_PATH without downloading', async () => {
    const root = packageRoot()
    const custom = path.join(scratch, 'custom-gaze')
    writeFileSync(custom, SCRIPT, { mode: 0o755 })
    assert.equal(await ensureBinary({ root, env: { GAZE_BINARY_PATH: custom, GAZE_DOWNLOAD_BASE: base } }), custom)
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
    assert.equal(requests.length, 0)
  })

  test('propagates the signal that terminated the binary', async () => {
    const root = packageRoot()
    const result = await run(root, ['die'])
    assert.equal(result.signal, 'SIGTERM', result.stderr)
  })

  test('reports a failed install and exits non-zero', async () => {
    checksum = (name) => `${'f'.repeat(64)}  ${name}\n`
    const root = packageRoot()
    const result = await run(root, ['stats'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /^gaze: Checksum mismatch for /)
    assert.equal(existsSync(path.join(root, 'vendor', 'gaze')), false)
  })
})

describe('install.js', () => {
  test('exits non-zero with a message when run directly and the download fails', async () => {
    const root = packageRoot()
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'npm', 'install.js')], { env: { ...process.env, GAZE_BINARY_PATH: '', GAZE_DOWNLOAD_BASE: `${base}/missing` } })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('exit', (code) => resolve({ code, stderr }))
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, SUPPORTED ? /^gaze: Cannot download .*HTTP 404/ : /^gaze: gaze has no prebuilt binary/)
  })
})
