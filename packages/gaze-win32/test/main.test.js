import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { SCHEMA, isNativeVec0 } from '../src/db.js'
import { installSummary, main, parse, statusSummary } from '../src/main.js'
import { PORT_BIN, VERSION, canonical } from '../src/paths.js'
import * as index from '../src/index.js'

const VARS = [
  'GAZE_DATA_DIR',
  'GAZE_EMBEDDER',
  'GAZE_CONFIG',
  'GAZE_SOCKET',
  'KIT_REGISTRY_DIR',
  'GAZE_BITA_BIN',
  'GAZE_PROJECT',
  'GAZE_HARVEST',
  'KIT_HEADLESS',
  'INKWELL_DOCS_DIR',
  'INKWELL_DB_PATH',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_PROJECT_DIR',
  'BITA_CONFIG_PATH',
]
const SELF = [process.execPath, '/opt/gaze/npm/gaze.js']
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-main-')))
  process.env.GAZE_DATA_DIR = path.join(dir, 'data')
  process.env.GAZE_EMBEDDER = 'fake'
  process.env.GAZE_CONFIG = path.join(dir, 'config.toml')
  process.env.GAZE_SOCKET = path.join(dir, 's.sock')
  process.env.KIT_REGISTRY_DIR = path.join(dir, 'tools.d')
  process.env.GAZE_BITA_BIN = '/nonexistent/bita'
  process.env.GAZE_PROJECT = 'den'
  process.env.INKWELL_DOCS_DIR = path.join(dir, 'docs')
  process.env.INKWELL_DB_PATH = path.join(dir, 'inkwell.db')
  process.env.BITA_CONFIG_PATH = path.join(dir, 'missing-bita.json')
  for (const name of ['GAZE_HARVEST', 'KIT_HEADLESS', 'CLAUDE_PROJECT_DIR', 'GEMINI_PROJECT_DIR']) delete process.env[name]
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function sink() {
  let text = ''
  return {
    write(chunk) {
      text += chunk
      return true
    },
    get text() {
      return text
    },
  }
}

async function gaze(args, { stdin = '' } = {}) {
  const stdout = sink()
  const stderr = sink()
  const input = Readable.from(stdin === '' ? [] : [Buffer.from(stdin)])
  const code = await main(args, { self: SELF, io: { stdin: input, stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

async function envelope(args, options) {
  const result = await gaze(args, options)
  return { ...result, body: JSON.parse(result.stdout) }
}

test('index exports main, VERSION and PORT_BIN', () => {
  assert.equal(index.main, main)
  assert.equal(index.VERSION, VERSION)
  assert.equal(index.PORT_BIN, PORT_BIN)
  assert.ok(PORT_BIN.endsWith(path.join('bin', 'gaze.js')))
  assert.ok(fs.existsSync(PORT_BIN))
})

test('version and help exit with 0 on stdout', async () => {
  for (const flag of ['-V', '--version']) {
    const out = await gaze([flag])
    assert.equal(out.code, 0)
    assert.equal(out.stdout, `gaze ${VERSION}\n`)
  }
  const help = await gaze(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /^El cerebro de cada proyecto/)
  assert.match(help.stdout, /remember +Guarda una nota/)
  assert.doesNotMatch(help.stdout, /harvest-run/)
  const sub = await gaze(['search', '-h'])
  assert.equal(sub.code, 0)
  assert.match(sub.stdout, /Usage: gaze search \[OPTIONS\] <QUERY>/)
  assert.doesNotMatch(sub.stdout, /--explain/)
  const nested = await gaze(['help', 'rule', 'add'])
  assert.equal(nested.code, 0)
  assert.match(nested.stdout, /Usage: gaze rule add/)
})

test('parse errors exit with 2 on stderr and never print an envelope', async () => {
  const cases = [
    ['remember', '--bogus', 'x', '--json'],
    ['remember', '--json'],
    ['search', 'x', '--project', 'a', '--all', '--json'],
    ['search', 'x', '--limit', 'abc', '--json'],
    ['search', 'x', '--limit', '-1', '--json'],
    ['nope', '--json'],
    ['rule', '--json'],
    ['rule', 'nope'],
    ['move', 'abc', '--json'],
    ['remember', 'x', 'y'],
    ['remember', 'x', '--pin', '--pin'],
    ['show'],
    ['--bogus'],
    ['remember', '-V'],
    ['harvest-run', '--session', 's'],
  ]
  for (const args of cases) {
    const out = await gaze(args)
    assert.equal(out.code, 2, args.join(' '))
    assert.equal(out.stdout, '', args.join(' '))
    assert.ok(out.stderr.length > 0, args.join(' '))
  }
  const plain = await gaze(['search', 'x', '--limit', 'abc'])
  assert.match(plain.stderr, /^error: .+\n\nUsage: gaze <COMMAND>\n/)
  const bare = await gaze([])
  assert.equal(bare.code, 2)
  assert.match(bare.stderr, /Usage: gaze \[OPTIONS\] <COMMAND>/)
})

test('parse keeps --json global and honors the -- terminator', () => {
  assert.deepEqual(parse(['--json', 'show', 'abc']), { route: 'show', values: { id: 'abc' }, json: true })
  assert.deepEqual(parse(['rule', '--json', 'rm', 'abc']), { route: 'rule rm', values: { id: 'abc' }, json: true })
  assert.deepEqual(parse(['remember', '--', '--json']).values.body, '--json')
  assert.equal(parse(['remember', '--', '--json']).json, false)
  assert.deepEqual(parse(['search', 'q', '--limit=3', '--explain']).values, { query: 'q', project: undefined, all: false, kind: undefined, limit: 3, explain: true })
  assert.deepEqual(parse(['group', 'set', 'equipo', 'a', 'b']).values, { name: 'equipo', projects: ['a', 'b'] })
  assert.deepEqual(parse(['serve', '--idle-minutes', '5']).values, { 'idle-minutes': 5, log: undefined, detach: false })
  assert.equal(parse(['remember', '-']).values.body, '-')
})

test('remember, search and show print the envelope with --json and the human text without it', async () => {
  const saved = await envelope(['remember', '--title', 'Firma', 'den se firma con Developer ID, ver [[Release]]', '--json'])
  assert.equal(saved.code, 0)
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.command, 'remember')
  assert.deepEqual(Object.keys(saved.body.data), ['id', 'action', 'title', 'project', 'kind'])
  const id = saved.body.data.id
  const human = await gaze(['remember', '--title', 'Release', 'Los releases salen de main'])
  assert.match(human.stdout, /^Guardada: \[[0-9a-z]{10}\] Release \(fact · den\)\n$/)
  const again = await gaze(['remember', '--title', 'Release', 'Los releases salen de main'])
  assert.match(again.stdout, /^(Sin cambios|Fusionada con una nota parecida): /)

  const found = await envelope(['search', 'firma developer', '--json'])
  assert.deepEqual(found.body.meta, { scope: 'den', count: found.body.data.length })
  assert.equal(found.body.data[0].id, id)
  assert.deepEqual(Object.keys(found.body.data[0]), ['id', 'title', 'kind', 'project', 'snippet', 'score'])
  const explained = await envelope(['search', 'firma developer', '--explain', '--all', '--json'])
  assert.equal(explained.body.meta.scope, 'all')
  assert.ok('similarity' in explained.body.data[0] && 'coverage' in explained.body.data[0])
  const text = await gaze(['search', 'firma developer', '--limit', '1'])
  assert.match(text.stdout, new RegExp(`^\\[${id}\\] Firma \\(fact · den\\)\\n    `))
  assert.equal((await gaze(['search', 'zzzz qqqq', '--kind', 'issue'])).stdout, 'Sin resultados.\n')

  const shown = await envelope(['show', id, '--json'])
  assert.equal(shown.body.data.neighbors[0].edgeKind, 'link')
  const plain = await gaze(['show', id])
  assert.match(plain.stdout, new RegExp(`^\\[${id}\\] Firma\\nfact · den · user\\n\\nden se firma`))
  assert.match(plain.stdout, /\n\nVecinos:\n  \[[0-9a-z]{10}\] Release \(fact, link\)\n$/)
})

test('remember reads the body from stdin and from @file', async () => {
  const piped = await envelope(['remember', '-', '--title', 'Pipe', '--json'], { stdin: 'cuerpo desde stdin\n' })
  assert.equal(piped.body.data.title, 'Pipe')
  const file = path.join(dir, 'nota.md')
  fs.writeFileSync(file, 'Nota desde un archivo')
  const fromFile = await envelope(['remember', `@${file}`, '--json'])
  assert.equal(fromFile.body.data.title, 'Nota desde un archivo')
  const missing = await envelope(['remember', `@${path.join(dir, 'missing.md')}`, '--json'])
  assert.equal(missing.code, 1)
  assert.equal(missing.body.error.code, 'INTERNAL_ERROR')
  assert.match(missing.body.error.message, /^leer .*missing\.md: /)
})

test('failures go to stdout with --json and to stderr without it, both with exit 1', async () => {
  const json = await envelope(['show', 'nope000000', '--json'])
  assert.equal(json.code, 1)
  assert.equal(json.stderr, '')
  assert.deepEqual(json.body.error, { code: 'NOT_FOUND', message: 'No existe: nope000000' })
  const human = await gaze(['show', 'nope000000'])
  assert.equal(human.code, 1)
  assert.equal(human.stdout, '')
  assert.equal(human.stderr, 'error: No existe: nope000000\n')
  const kind = await envelope(['remember', '--kind', 'bogus', 'x', '--json'])
  assert.equal(kind.body.error.code, 'USAGE_ERROR')
  assert.equal(kind.body.error.message, 'Tipo inválido: bogus. Usa uno de: rule, fact, decision, doc, entry, issue, meeting, memory')
})

test('rule add, ls and rm keep the messages of main.rs', async () => {
  const added = await gaze(['rule', 'add', 'Nunca uses npm', '--pin', '--until', '2099-01-01'])
  assert.match(added.stdout, /^Regla agregada: \[[0-9a-z]{10}\] en den\n$/)
  const id = added.stdout.match(/\[([0-9a-z]{10})\]/)[1]
  const listed = await gaze(['rule', 'ls'])
  assert.equal(listed.stdout, `[${id}] den · fijada · hasta 2099-01-01 — Nunca uses npm\n`)
  const data = await envelope(['rule', 'ls', '--all', '--json'])
  assert.deepEqual(Object.keys(data.body.data[0]), ['id', 'project', 'text', 'pinned', 'until', 'updatedAt'])
  const fact = await envelope(['remember', 'Un hecho cualquiera', '--json'])
  const wrong = await envelope(['rule', 'rm', fact.body.data.id, '--json'])
  assert.equal(wrong.body.command, 'rule rm')
  assert.deepEqual(wrong.body.error, { code: 'USAGE_ERROR', message: `[${fact.body.data.id}] no es una regla, es fact` })
  assert.equal((await gaze(['rule', 'rm', id])).stdout, `Regla [${id}] borrada.\n`)
  assert.equal((await gaze(['rule', 'ls'])).stdout, 'Sin reglas.\n')
})

test('group, graph, link, forget and move', async () => {
  assert.equal((await gaze(['group', 'ls'])).stdout, 'Sin grupos.\n')
  const empty = await envelope(['group', 'set', 'vacio', '--json'])
  assert.equal(empty.body.error.message, 'Uso: gaze group set <nombre> <proyecto>...')
  assert.equal((await gaze(['group', 'set', 'Equipo', 'den', 'global', 'otro'])).stdout, 'Grupo equipo: den, otro\n')
  assert.equal((await gaze(['group', 'ls'])).stdout, 'equipo: den, otro\n')
  assert.equal((await gaze(['group', 'rm', 'equipo'])).stdout, 'Grupo equipo borrado.\n')
  assert.equal((await gaze(['group', 'rm', 'equipo'])).stdout, 'No existe el grupo equipo.\n')
  const a = (await envelope(['remember', '--title', 'Uno', 'Primera nota aislada', '--json'])).body.data.id
  const b = (await envelope(['remember', '--title', 'Dos', 'Segunda nota distinta del todo', '--json'])).body.data.id
  assert.equal((await gaze(['link', a, b])).stdout, `Enlazadas: [${a}] Uno → [${b}] Dos\n`)
  assert.equal((await envelope(['link', a, a, '--json'])).body.error.message, 'No se puede enlazar una nota consigo misma')
  assert.equal((await gaze(['graph'])).stdout, '2 nodos, 1 aristas\n')
  assert.equal((await gaze(['move', b, '--project', 'Otro'])).stdout, `[${b}] ahora está en otro\n`)
  assert.equal((await gaze(['forget', b])).stdout, `Borrada: [${b}] Dos\n`)
})

test('stats, capabilities, project and reindex', async () => {
  const stats = await gaze(['stats'])
  assert.equal(stats.code, 0)
  assert.equal(stats.stdout, '0 notas, 0 aristas, 0 fragmentos (0 sin embedding)\nInyectado: 0 tokens en 0 sesiones (promedio 0.0 por sesión)\nDaemon: apagado\n')
  const json = await envelope(['stats', '--json'])
  assert.equal(json.body.data.daemon.manager, 'on-demand')
  assert.equal(typeof json.body.data.daemon.installed, 'boolean')
  assert.equal(json.stdout.split('\n').length, 2)
  const caps = await gaze(['capabilities'])
  assert.equal(caps.stdout, `gaze ${VERSION}: memory.search, memory.write, memory.graph.read, memory.rules, memory.ingest, memory.import, memory.hooks, mcp.stdio\n`)
  const resolved = await gaze(['project'])
  assert.equal(resolved.stdout, 'den (fuente: env)\n')
  assert.equal((await gaze(['reindex', '--all'])).stdout, '0 notas con embeddings nuevos.\n')
})

test('ingest validates the source and reports bita as event driven', async () => {
  const bad = await envelope(['ingest', '--source', 'bogus', '--json'])
  assert.equal(bad.body.error.message, '--source debe ser inkwell, recap, bita o all')
  const bita = await gaze(['ingest', '--source', 'bita'])
  assert.equal(bita.stdout, 'bita: bita llega por eventos: gaze bita-hook (stop, amend, delete)\n')
  const json = await envelope(['ingest', '--source', 'bita', '--json'])
  assert.equal(typeof json.body.meta.ms, 'number')
})

test('import claude-memory --dry-run reports totals without writing', async () => {
  const root = path.join(dir, 'claude')
  fs.mkdirSync(root, { recursive: true })
  const out = await envelope(['import', 'claude-memory', '--dry-run', '--root', root, '--json'])
  assert.equal(out.body.command, 'import claude-memory')
  assert.deepEqual(out.body.data, { dryRun: true, total: 0, projects: {}, actions: {} })
  assert.equal((await gaze(['import', 'claude-memory', '--dry-run', '--root', root])).stdout, '0 memorias (simulación)\n')
})

test('setup and uninstall register the argv from self', async () => {
  const set = await envelope(['setup', '--json'])
  assert.equal(set.code, 0)
  const manifest = JSON.parse(fs.readFileSync(set.body.data.manifest, 'utf8'))
  assert.deepEqual(manifest.bin, SELF)
  assert.deepEqual(manifest.mcp.stdio, [...SELF, 'mcp'])
  const human = await gaze(['setup'])
  assert.match(human.stdout, /^Registrado en kit: .*gaze\.json\nConfiguración: .*\nBase: .*gaze\.db\n\nLas integraciones/)
  assert.match(human.stdout, /\n\nFalta \(no lo hago yo\):\n  gaze daemon install\n/)
  assert.match((await gaze(['uninstall'])).stdout, /^Registro de kit borrado\.\nLos datos se quedan en /)
  assert.match((await gaze(['uninstall'])).stdout, /^Registro de kit no existía\./)
})

test('daemon summaries only cover the on-demand states and results', () => {
  assert.equal(statusSummary({ state: 'running', pid: 7 }), 'Corriendo (pid 7)')
  assert.equal(statusSummary({ state: 'idle' }), 'Bajo demanda, apagado; arranca con el primer hook o búsqueda')
  for (const state of ['stopped', 'not-loaded', 'starting']) assert.equal(statusSummary({ state, manager: 'on-demand', managerPid: 3 }), 'Apagado')
  const result = { manager: 'on-demand', pid: 5, socket: '/s', log: '/l', warning: 'ignored' }
  assert.equal(installSummary({ ...result, ready: true }), 'Daemon cargado en on-demand con pid 5 y respondiendo en /s')
  assert.equal(
    installSummary({ ...result, ready: false }),
    'Daemon cargado en on-demand con pid 5, pero aún no responde en /s (puede estar descargando el modelo); revisa /l y gaze daemon status',
  )
})

test('daemon status prints the on-demand states', async () => {
  assert.equal((await gaze(['daemon', 'status'])).stdout, 'Apagado\n')
  fs.mkdirSync(process.env.GAZE_DATA_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.GAZE_DATA_DIR, 'daemon.json'), '{"bin":"x"}\n')
  assert.equal((await gaze(['daemon', 'status'])).stdout, 'Bajo demanda, apagado; arranca con el primer hook o búsqueda\n')
  const json = await envelope(['daemon', 'status', '--json'])
  assert.equal(json.body.command, 'daemon')
  assert.equal(json.body.data.installed, true)
})

test('hook stays silent and skips the database when disabled', async () => {
  process.env.KIT_HEADLESS = '1'
  const out = await gaze(['hook', 'prompt', '--harness', 'codex'], { stdin: '{"prompt":"algo largo de verdad"}' })
  assert.deepEqual(out, { code: 0, stdout: '', stderr: '' })
  assert.equal(fs.existsSync(path.join(process.env.GAZE_DATA_DIR, 'gaze.db')), false)
})

test('hook session-start prints one JSON line and unknown events print nothing', async () => {
  await gaze(['rule', 'add', 'Nunca uses npm'])
  const start = await gaze(['hook', 'session-start', '--json'], { stdin: '{"session_id":"t","cwd":"/"}' })
  assert.equal(start.code, 0)
  const lines = start.stdout.trim().split('\n')
  assert.equal(lines.length, 1)
  const value = JSON.parse(lines[0])
  assert.equal(value.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(value.hookSpecificOutput.additionalContext, /Nunca uses npm/)
  assert.equal(value.schemaVersion, undefined)
  assert.deepEqual(await gaze(['hook', 'nope'], { stdin: '{}' }), { code: 0, stdout: '', stderr: '' })
})

test('mcp answers over the given io', async () => {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ]
  const out = await gaze(['mcp'], { stdin: `${messages.map((m) => JSON.stringify(m)).join('\n')}\n` })
  assert.equal(out.code, 0)
  const replies = out.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(replies.map((r) => r.id), [1, 2])
  assert.equal(replies[0].result.serverInfo.version, VERSION)
})

test('bita-hook and inkwell-hook print a timestamped line without an envelope', async () => {
  const bita = await gaze(['bita-hook'], { stdin: 'not json' })
  assert.equal(bita.code, 0)
  assert.match(bita.stdout, /^\d{4}-\d\d-\d\dT\S+ bita-hook \{.*\}\n$/)
  fs.mkdirSync(path.join(dir, 'docs', 'dp'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'dp', 'bad.md'), Buffer.from([0xff, 0xfe, 0x00]))
  fs.writeFileSync(path.join(dir, 'docs', 'dp', 'ok.md'), '# Ok\n\nBien.\n')
  const event = (rels) => JSON.stringify({ event: 'docs.changed', docsRoot: path.join(dir, 'docs'), changes: rels.map((relPath) => ({ action: 'written', relPath })) })
  const failed = await gaze(['inkwell-hook'], { stdin: event(['dp/bad.md', 'dp/ok.md']) })
  assert.equal(failed.code, 1)
  const summary = JSON.parse(failed.stdout.trim().split(' ').slice(2).join(' '))
  assert.equal(summary.failed, 1)
  assert.equal((await gaze(['inkwell-hook'], { stdin: event(['dp/ok.md']) })).code, 0)
  assert.equal((await gaze(['inkwell-hook'], { stdin: '' })).code, 0)
})

test('harvest-run reports errors on stdout and always exits with 0', async () => {
  fs.writeFileSync(process.env.GAZE_CONFIG, '[harvest]\nenabled = true\nmin_chars = 1\n')
  const out = await gaze(['harvest-run', '--transcript', path.join(dir, 'missing.jsonl'), '--session', 's1', '--cwd', dir])
  assert.equal(out.code, 0)
  assert.match(out.stdout, /^\S+ harvest s1: /)
})

function nativeFixture(file) {
  const db = new DatabaseSync(file)
  if (typeof db.enableDefensive !== 'function') {
    db.close()
    return false
  }
  db.exec(SCHEMA)
  db.exec('DROP TABLE chunk_vectors')
  db.prepare("INSERT INTO nodes (id, project, kind, title, body, source, source_ref, pinned, until, created_at, updated_at, hits, content_hash, embedded) VALUES ('n1', 'den', 'fact', 'Postgres', 'La base usa postgres', 'user', NULL, 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 'h', 1)").run()
  db.exec("INSERT INTO fts_nodes (node_id, project, title, body) VALUES ('n1', 'den', 'Postgres', 'La base usa postgres')")
  db.exec('PRAGMA user_version = 2')
  db.enableDefensive(false)
  db.exec('PRAGMA writable_schema = ON')
  db.prepare("INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'vec_chunks', 'vec_chunks', 0, 'CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[384])')").run()
  db.exec('PRAGMA writable_schema = OFF')
  db.close()
  return true
}

test('a vec0 database is migrated and then reindexed', async (t) => {
  fs.mkdirSync(process.env.GAZE_DATA_DIR, { recursive: true })
  const file = path.join(process.env.GAZE_DATA_DIR, 'gaze.db')
  if (!nativeFixture(file)) return t.skip('enableDefensive is not available')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  let out
  try {
    out = await gaze(['rule', 'ls'])
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
  assert.equal(out.code, 0)
  assert.match(out.stderr, /se migró al port JS/)
  assert.match(out.stderr, /gaze: 1 notas con embeddings nuevos\./)
  const db = new DatabaseSync(file)
  assert.equal(isNativeVec0(db), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE embedded = 0').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors').get().n, 1)
  db.close()
})
