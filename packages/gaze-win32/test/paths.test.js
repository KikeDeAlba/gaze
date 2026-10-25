import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as paths from '../src/paths.js'

const VARS = ['GAZE_DATA_DIR', 'GAZE_DB_PATH', 'GAZE_CONFIG', 'GAZE_CACHE_DIR', 'GAZE_SOCKET', 'KIT_REGISTRY_DIR', 'BITA_CONFIG_PATH', 'INKWELL_DOCS_DIR', 'INKWELL_DB_PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-paths-'))
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const dirs = (windows, env) => paths.makeDirs({ windows, env })

test('home falls back to userprofile', () => {
  assert.equal(dirs(true, { USERPROFILE: 'C:\\Users\\kike' }).home, 'C:\\Users\\kike')
  assert.equal(dirs(true, { HOME: '/c/msys', USERPROFILE: 'C:\\Users\\kike' }).home, 'C:\\Users\\kike')
  assert.equal(dirs(true, { HOME: '/c/msys' }).home, '/c/msys')
  assert.equal(dirs(false, { HOME: '/home/kike', USERPROFILE: 'x' }).home, '/home/kike')
  assert.equal(dirs(true, {}).home, 'C:\\')
  assert.equal(dirs(false, { HOME: '' }).home, '/')
})

test('windows uses appdata and localappdata', () => {
  const win = dirs(true, { USERPROFILE: 'C:\\Users\\kike', APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local', XDG_CONFIG_HOME: '/x' })
  assert.equal(win.configHome, 'C:\\Roaming')
  assert.equal(win.dataHome, 'C:\\Local')
  assert.equal(win.cacheHome, 'C:\\Local\\gaze\\cache')
  const bare = dirs(true, { USERPROFILE: 'C:\\Users\\kike' })
  assert.equal(bare.configHome, 'C:\\Users\\kike\\AppData\\Roaming')
  assert.equal(bare.dataHome, 'C:\\Users\\kike\\AppData\\Local')
  assert.equal(bare.cacheHome, 'C:\\Users\\kike\\AppData\\Local\\gaze\\cache')
})

test('unix honours xdg', () => {
  const unix = dirs(false, { HOME: '/home/kike', XDG_DATA_HOME: '/data', APPDATA: '/nope' })
  assert.equal(unix.dataHome, '/data')
  assert.equal(unix.configHome, '/home/kike/.config')
  assert.equal(unix.cacheHome, '/home/kike/.cache/gaze')
  assert.equal(dirs(false, { HOME: '/h', XDG_CACHE_HOME: '/c' }).cacheHome, '/c/gaze')
})

test('simplify drops verbatim prefixes only, like paths.rs', () => {
  const cases = [
    ['\\\\?\\C:\\Users\\k', 'C:\\Users\\k'],
    ['\\\\?\\UNC\\server\\share\\x', '\\\\server\\share\\x'],
    ['\\\\?\\Volume{abc}\\x', '\\\\?\\Volume{abc}\\x'],
    ['/home/k', '/home/k'],
    ['\\\\?\\', '\\\\?\\'],
    ['\\\\?\\C', '\\\\?\\C'],
    ['\\\\?\\C:', 'C:'],
    ['\\\\?\\UNC\\', '\\\\'],
    ['C:\\x', 'C:\\x'],
    ['\\\\.\\pipe\\x', '\\\\.\\pipe\\x'],
    ['\\\\?\\ñ:\\x', '\\\\?\\ñ:\\x'],
  ]
  for (const [input, want] of cases) assert.equal(paths.simplify(input), want, input)
})

test('pipe name is per user', () => {
  const cases = [['Kike Alba', '\\\\.\\pipe\\gaze-kikealba'], ['', '\\\\.\\pipe\\gaze'], ['José_Núñez-1', '\\\\.\\pipe\\gaze-jos_nez-1'], ['UPPER', '\\\\.\\pipe\\gaze-upper'], ['***', '\\\\.\\pipe\\gaze'], [undefined, '\\\\.\\pipe\\gaze']]
  for (const [user, want] of cases) assert.equal(paths.defaultPipe(user), want, String(user))
})

test('data dir honours GAZE_DATA_DIR, then the GAZE_DB_PATH parent', () => {
  process.env.GAZE_DATA_DIR = dir
  delete process.env.GAZE_DB_PATH
  assert.equal(paths.dataDir(), dir)
  assert.equal(paths.dbPath(), path.join(dir, 'gaze.db'))
  assert.equal(paths.tokenPath(), path.join(dir, 'daemon.token'))
  assert.equal(paths.spawnedMarker(), path.join(dir, 'serve.spawned'))
  assert.equal(paths.daemonMarker(), path.join(dir, 'daemon.json'))
  assert.equal(paths.serveLog(), path.join(dir, 'serve.log'))
  assert.equal(paths.harvestLog(), path.join(dir, 'harvest.log'))
  assert.equal(paths.harvestDir(), path.join(dir, 'harvest'))
  process.env.GAZE_DATA_DIR = ''
  process.env.GAZE_DB_PATH = path.join(dir, 'sub', 'x.db')
  assert.equal(paths.dataDir(), path.join(dir, 'sub'))
  assert.equal(paths.dbPath(), path.join(dir, 'sub', 'x.db'))
})

test('socket path uses GAZE_SOCKET or the per-platform default', () => {
  process.env.GAZE_DATA_DIR = dir
  process.env.GAZE_SOCKET = path.join(dir, 'custom.sock')
  assert.equal(paths.socketPath(), path.join(dir, 'custom.sock'))
  process.env.GAZE_SOCKET = ''
  const want = process.platform === 'win32' ? paths.defaultPipe(process.env.USERNAME) : path.join(dir, 'gaze.sock')
  assert.equal(paths.socketPath(), want)
})

test('config, cache and integration paths honour their overrides', () => {
  process.env.GAZE_CONFIG = path.join(dir, 'c.toml')
  process.env.GAZE_CACHE_DIR = path.join(dir, 'cache')
  process.env.KIT_REGISTRY_DIR = path.join(dir, 'reg')
  process.env.BITA_CONFIG_PATH = path.join(dir, 'bita.json')
  process.env.INKWELL_DOCS_DIR = path.join(dir, 'docs')
  process.env.INKWELL_DB_PATH = path.join(dir, 'ink.db')
  assert.equal(paths.configPath(), path.join(dir, 'c.toml'))
  assert.equal(paths.cacheDir(), path.join(dir, 'cache'))
  assert.equal(paths.modelsDir(), path.join(dir, 'cache', 'models'))
  assert.equal(paths.registryDir(), path.join(dir, 'reg'))
  assert.equal(paths.bitaConfig(), path.join(dir, 'bita.json'))
  assert.equal(paths.inkwellDocs(), path.join(dir, 'docs'))
  assert.equal(paths.inkwellDb(), path.join(dir, 'ink.db'))
  for (const name of ['GAZE_CONFIG', 'KIT_REGISTRY_DIR', 'BITA_CONFIG_PATH', 'INKWELL_DOCS_DIR', 'INKWELL_DB_PATH']) process.env[name] = ''
  if (process.platform !== 'win32') {
    process.env.HOME = dir
    process.env.XDG_CONFIG_HOME = ''
    assert.equal(paths.configPath(), path.join(dir, '.config', 'gaze', 'config.toml'))
    assert.equal(paths.registryDir(), path.join(dir, '.config', 'kikedealba', 'tools.d'))
    assert.equal(paths.bitaConfig(), path.join(dir, '.config', 'bita', 'config.json'))
    assert.equal(paths.inkwellDocs(), path.join(dir, '.local', 'share', 'inkwell', 'docs'))
    assert.equal(paths.inkwellDb(), path.join(dir, '.local', 'share', 'inkwell', 'inkwell.db'))
    assert.equal(paths.claudeProjects(), path.join(dir, '.claude', 'projects'))
  }
})

test('canonical resolves symlinks and falls back to the input', () => {
  const real = fs.realpathSync.native(dir)
  assert.equal(paths.canonical(dir), real)
  const missing = path.join(dir, 'missing')
  assert.equal(paths.canonical(missing), missing)
  assert.equal(paths.canonical('\\\\?\\C:\\nope-gaze-test'), 'C:\\nope-gaze-test')
})

test('readUtf8Strict rejects invalid UTF-8 and keeps the BOM', () => {
  const bad = path.join(dir, 'bad.md')
  fs.writeFileSync(bad, Buffer.from([0x61, 0xff, 0x62]))
  assert.throws(() => paths.readUtf8Strict(bad), { message: 'stream did not contain valid UTF-8' })
  const bom = path.join(dir, 'bom.md')
  fs.writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))
  assert.equal(paths.readUtf8Strict(bom), '\ufeffhi')
  assert.throws(() => paths.readUtf8Strict(path.join(dir, 'none.md')), { code: 'ENOENT' })
})

test('version and self command point at this package', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(paths.VERSION, pkg.version)
  assert.ok(path.isAbsolute(paths.PORT_BIN))
  assert.ok(paths.PORT_BIN.endsWith(path.join('bin', 'gaze.js')))
  assert.deepEqual(paths.selfCommand(), [process.execPath, paths.PORT_BIN])
})
