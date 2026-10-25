import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig, loadConfig, parseConfig, renderDefault } from '../src/config.js'

const RUST_DEFAULT_TOML = '[search]\ndedupe_threshold = 0.94\nreplace_threshold = 0.97\nsimilar_threshold = 0.91\nsimilar_neighbors = 5\n\n[hooks]\nrules_tokens = 300\nprompt_tokens = 150\nprompt_max = 3\nprompt_min_chars = 20\nprompt_threshold = 0.84\nprompt_margin = 0.03\nprompt_lexical_threshold = 0.75\n\n[harvest]\nenabled = true\nagent = "claude"\nmax_chars = 40000\nmin_chars = 600\nmax_items = 8\ntimeout_seconds = 240\n'

const RUST_DEFAULT_JSON = {
  harvest: { agent: 'claude', enabled: true, max_chars: 40000, max_items: 8, min_chars: 600, timeout_seconds: 240 },
  hooks: { prompt_lexical_threshold: 0.75, prompt_margin: 0.029999999329447746, prompt_max: 3, prompt_min_chars: 20, prompt_threshold: 0.8399999737739563, prompt_tokens: 150, rules_tokens: 300 },
  search: { dedupe_threshold: 0.9399999976158142, replace_threshold: 0.9700000286102295, similar_neighbors: 5, similar_threshold: 0.9100000262260437 },
}

const withChanges = (changes) => {
  const out = structuredClone(RUST_DEFAULT_JSON)
  for (const [section, fields] of Object.entries(changes)) Object.assign(out[section], fields)
  return out
}

const RUST_CASES = [
  ['', RUST_DEFAULT_JSON],
  ['[search]\ndedupe_threshold = 0.5\n', withChanges({ search: { dedupe_threshold: 0.5 } })],
  ['[search]\ndedupe_threshold = 1\n', withChanges({ search: { dedupe_threshold: 1 } })],
  ['[search]\nsimilar_neighbors = -1\n', RUST_DEFAULT_JSON],
  ['[search]\nsimilar_neighbors = 2.5\n', RUST_DEFAULT_JSON],
  ['[hooks]\nprompt_max = 7\nprompt_threshold = 0.9\n[harvest]\nenabled = false\nagent = "codex"\nmodel = "x"\n', withChanges({ hooks: { prompt_max: 7, prompt_threshold: 0.8999999761581421 }, harvest: { enabled: false, agent: 'codex', model: 'x' } })],
  ['not toml [', RUST_DEFAULT_JSON],
  ['[harvest]\nenabled = 1\n', RUST_DEFAULT_JSON],
  ['search = 5\n', RUST_DEFAULT_JSON],
  ['[other]\nx = 1\n[search]\nunknown = 3\n', RUST_DEFAULT_JSON],
  ['[harvest]\nmodel = 3\n', RUST_DEFAULT_JSON],
  ['[harvest]\ntimeout_seconds = 9999999999\n', withChanges({ harvest: { timeout_seconds: 9999999999 } })],
  ['[hooks]\nprompt_margin = nan\n', withChanges({ hooks: { prompt_margin: null } })],
  ['[hooks]\nprompt_margin = inf\n', withChanges({ hooks: { prompt_margin: null } })],
  ['[search]\nreplace_threshold = "0.9"\n', RUST_DEFAULT_JSON],
  ['[search]\nsimilar_neighbors = 1e2\n', RUST_DEFAULT_JSON],
  ['[harvest]\nmax_items = 0\n', withChanges({ harvest: { max_items: 0 } })],
  ['[search]\n[search]\n', RUST_DEFAULT_JSON],
]

const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v
const asJson = (v) => canonical(JSON.parse(JSON.stringify(v)))

let saved
let dir

beforeEach(() => {
  saved = process.env.GAZE_CONFIG
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-config-'))
  process.env.GAZE_CONFIG = path.join(dir, 'config.toml')
})

afterEach(() => {
  if (saved === undefined) delete process.env.GAZE_CONFIG
  else process.env.GAZE_CONFIG = saved
  fs.rmSync(dir, { recursive: true, force: true })
})

test('renderDefault is byte for byte what toml::to_string_pretty writes', () => {
  assert.equal(renderDefault(), RUST_DEFAULT_TOML)
  assert.deepEqual(asJson(parseConfig(renderDefault())), RUST_DEFAULT_JSON)
})

test('defaults hold f32 values like config.rs', () => {
  const cfg = defaultConfig()
  assert.deepEqual(asJson(cfg), RUST_DEFAULT_JSON)
  assert.deepEqual(Object.keys(cfg), ['search', 'hooks', 'harvest'])
  assert.equal(cfg.search.dedupe_threshold, Math.fround(0.94))
  assert.equal('model' in cfg.harvest, false)
  assert.ok(Math.fround(0.94) >= cfg.search.dedupe_threshold)
  assert.notEqual(defaultConfig(), defaultConfig())
})

test('parsing merges per field and falls back to the whole default on any error, like serde', () => {
  for (const [toml, want] of RUST_CASES) assert.deepEqual(asJson(parseConfig(toml)), canonical(want), JSON.stringify(toml))
})

test('loadConfig reads GAZE_CONFIG and survives missing or broken files', () => {
  assert.deepEqual(asJson(loadConfig()), RUST_DEFAULT_JSON)
  fs.writeFileSync(process.env.GAZE_CONFIG, '[hooks]\nprompt_max = 9\n')
  assert.equal(loadConfig().hooks.prompt_max, 9)
  fs.writeFileSync(process.env.GAZE_CONFIG, Buffer.from([0x5b, 0xff, 0x5d]))
  assert.deepEqual(asJson(loadConfig()), RUST_DEFAULT_JSON)
  fs.writeFileSync(process.env.GAZE_CONFIG, '[[[')
  assert.deepEqual(asJson(loadConfig()), RUST_DEFAULT_JSON)
})
