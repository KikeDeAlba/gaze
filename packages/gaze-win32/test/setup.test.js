import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderDefault } from '../src/config.js'
import { VERSION, canonical, selfCommand } from '../src/paths.js'
import { CAPABILITIES, HOMEPAGE, INSTALL, INTEGRATIONS_NOTE, capabilities, manifest, setup, uninstall } from '../src/setup.js'

const RUST_SETUP = new URL('../../../src/setup.rs', import.meta.url)
const VARS = ['GAZE_DATA_DIR', 'GAZE_CONFIG', 'KIT_REGISTRY_DIR', 'GAZE_EMBEDDER']
const BIN = ['C:\\nvm4w\\nodejs\\node.exe', 'C:\\Users\\k\\AppData\\Roaming\\npm\\node_modules\\@kikedealba\\gaze\\npm\\gaze.js']
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-setup-')))
  process.env.GAZE_DATA_DIR = path.join(dir, 'data')
  process.env.GAZE_CONFIG = path.join(dir, 'conf', 'config.toml')
  process.env.KIT_REGISTRY_DIR = path.join(dir, 'tools.d')
  process.env.GAZE_EMBEDDER = 'fake'
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('constants are copied from setup.rs', () => {
  const rust = fs.readFileSync(RUST_SETUP, 'utf8')
  assert.equal(CAPABILITIES.length, 8)
  for (const capability of CAPABILITIES) assert.ok(rust.includes(`"${capability}"`), capability)
  assert.ok(rust.includes(`"${HOMEPAGE}"`))
  assert.ok(rust.includes(`"${INSTALL}"`))
  assert.ok(rust.includes(`"${INTEGRATIONS_NOTE}"`))
})

test('capabilities follow the kit contract', () => {
  assert.deepEqual(capabilities(), { name: 'gaze', version: VERSION, envelope: 1, capabilities: CAPABILITIES, emits: [] })
})

test('manifest treats bin as an argv', () => {
  const value = manifest(BIN)
  assert.equal(value.manifestVersion, 1)
  assert.equal(value.version, VERSION)
  assert.deepEqual(value.bin, BIN)
  assert.deepEqual(value.subscribes, [
    { tool: 'bita', events: ['stop', 'amend', 'delete'], command: [...BIN, 'bita-hook'] },
    { tool: 'inkwell', events: ['docs.changed'], command: [...BIN, 'inkwell-hook'] },
  ])
  assert.deepEqual(value.mcp, { stdio: [...BIN, 'mcp'] })
  assert.equal(value.install, INSTALL)
  assert.equal(value.homepage, HOMEPAGE)
  assert.match(value.installedAt, /^\d{4}-\d\d-\d\dT/)
})

test('setup writes the manifest atomically, creates the config once and opens the database', async () => {
  let opened = 0
  const first = await setup({ self: BIN, open: () => opened++ })
  assert.equal(opened, 1)
  assert.equal(first.manifest, path.join(dir, 'tools.d', 'gaze.json'))
  assert.equal(first.config, process.env.GAZE_CONFIG)
  assert.equal(first.configCreated, true)
  assert.equal(first.database, path.join(dir, 'data', 'gaze.db'))
  assert.equal(first.integrations, INTEGRATIONS_NOTE)
  assert.deepEqual(first.next, ['gaze daemon install', 'gaze import claude-memory --dry-run && gaze import claude-memory', 'gaze ingest'])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tools.d')), ['gaze.json'])
  const written = fs.readFileSync(first.manifest, 'utf8')
  assert.ok(written.endsWith('}\n'))
  assert.deepEqual(JSON.parse(written).bin, BIN)
  assert.equal(fs.readFileSync(process.env.GAZE_CONFIG, 'utf8'), renderDefault())
  assert.ok(fs.existsSync(process.env.GAZE_DATA_DIR))
  fs.writeFileSync(process.env.GAZE_CONFIG, '[search]\n')
  const second = await setup({ self: BIN, open: () => {} })
  assert.equal(second.configCreated, false)
  assert.equal(fs.readFileSync(process.env.GAZE_CONFIG, 'utf8'), '[search]\n')
})

test('setup falls back to selfCommand and opens the real database', async () => {
  const result = await setup()
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifest, 'utf8')).bin, selfCommand())
  assert.ok(fs.existsSync(result.database))
})

test('uninstall removes only the manifest and keeps the data', async () => {
  await setup({ self: BIN, open: () => {} })
  assert.deepEqual(uninstall(), {
    manifest: path.join(dir, 'tools.d', 'gaze.json'),
    removed: true,
    next: ['gaze daemon uninstall'],
    kept: path.join(dir, 'data', 'gaze.db'),
  })
  assert.equal(uninstall().removed, false)
  assert.ok(fs.existsSync(process.env.GAZE_CONFIG))
})
