import { parse } from 'smol-toml'
import { configPath, readUtf8Strict } from './paths.js'

const F32 = 'f32'
const USIZE = 'usize'
const U64 = 'u64'
const BOOL = 'bool'
const STRING = 'string'
const OPTIONAL_STRING = 'optional-string'

const I64_MAX = 9223372036854775807n

const SCHEMA = {
  search: {
    dedupe_threshold: [F32, 0.94],
    replace_threshold: [F32, 0.97],
    similar_threshold: [F32, 0.91],
    similar_neighbors: [USIZE, 5],
  },
  hooks: {
    rules_tokens: [USIZE, 300],
    prompt_tokens: [USIZE, 150],
    prompt_max: [USIZE, 3],
    prompt_min_chars: [USIZE, 20],
    prompt_threshold: [F32, 0.84],
    prompt_margin: [F32, 0.03],
    prompt_lexical_threshold: [F32, 0.75],
  },
  harvest: {
    enabled: [BOOL, true],
    agent: [STRING, 'claude'],
    model: [OPTIONAL_STRING, undefined],
    max_chars: [USIZE, 40000],
    min_chars: [USIZE, 600],
    max_items: [USIZE, 8],
    timeout_seconds: [U64, 240],
  },
}

const DEFAULT_TOML = `[search]
dedupe_threshold = 0.94
replace_threshold = 0.97
similar_threshold = 0.91
similar_neighbors = 5

[hooks]
rules_tokens = 300
prompt_tokens = 150
prompt_max = 3
prompt_min_chars = 20
prompt_threshold = 0.84
prompt_margin = 0.03
prompt_lexical_threshold = 0.75

[harvest]
enabled = true
agent = "claude"
max_chars = 40000
min_chars = 600
max_items = 8
timeout_seconds = 240
`

class Mismatch extends Error {}

function coerce(type, value) {
  switch (type) {
    case F32:
      if (typeof value === 'bigint') return Math.fround(Number(value))
      if (typeof value === 'number') return Math.fround(value)
      throw new Mismatch()
    case USIZE:
    case U64:
      if (typeof value === 'bigint' && value >= 0n && value <= I64_MAX) return Number(value)
      throw new Mismatch()
    case BOOL:
      if (typeof value === 'boolean') return value
      throw new Mismatch()
    case STRING:
    case OPTIONAL_STRING:
      if (typeof value === 'string') return value
      throw new Mismatch()
    default:
      throw new Mismatch()
  }
}

function isTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

function build(raw) {
  const config = {}
  for (const [section, fields] of Object.entries(SCHEMA)) {
    const table = raw?.[section]
    if (table !== undefined && !isTable(table)) throw new Mismatch()
    const out = {}
    for (const [key, [type, fallback]] of Object.entries(fields)) {
      const has = table !== undefined && Object.hasOwn(table, key)
      if (has) out[key] = coerce(type, table[key])
      else if (fallback !== undefined) out[key] = type === F32 ? Math.fround(fallback) : fallback
    }
    config[section] = out
  }
  return config
}

export function defaultConfig() {
  return build({})
}

export function parseConfig(text) {
  try {
    return build(parse(text, { integersAsBigInt: true }))
  } catch {
    return defaultConfig()
  }
}

export function loadConfig() {
  let text
  try {
    text = readUtf8Strict(configPath())
  } catch {
    return defaultConfig()
  }
  return parseConfig(text)
}

export function renderDefault() {
  return DEFAULT_TOML
}
