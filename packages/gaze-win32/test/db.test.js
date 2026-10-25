import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EDGE_KINDS, GLOBAL, KINDS, NOTE_KINDS, SCHEMA, SOURCES, isNativeVec0, migrateVec0, migrationLock, openDb, openMemory } from '../src/db.js'
import { GazeError } from '../src/envelope.js'

const RUST_DB = new URL('../../../src/db.rs', import.meta.url)
const VEC0_DDL = 'CREATE VIRTUAL TABLE vec_chunks USING vec0(\n  chunk_id INTEGER PRIMARY KEY,\n  embedding float[384] distance_metric=cosine,\n  project TEXT partition key\n)'
const JS_VECTORS = 'CREATE TABLE IF NOT EXISTS chunk_vectors (\n  chunk_id INTEGER PRIMARY KEY,\n  project TEXT NOT NULL,\n  embedding BLOB NOT NULL\n);\nCREATE INDEX IF NOT EXISTS chunk_vectors_project ON chunk_vectors(project);'
const RUST_VECTORS = 'CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(\n  chunk_id INTEGER PRIMARY KEY,\n  embedding float[384] distance_metric=cosine,\n  project TEXT partition key\n);'

let dir
const quiet = () => {}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-db-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_nodes_%' ORDER BY name").all().map((r) => r.name)

function nativeFixture(file) {
  const db = new DatabaseSync(file)
  if (typeof db.enableDefensive !== 'function') {
    db.close()
    return false
  }
  db.exec(SCHEMA.replace(JS_VECTORS, ''))
  db.exec('CREATE TABLE vec_chunks_info (key TEXT PRIMARY KEY, value ANY)')
  db.exec('CREATE TABLE vec_chunks_rowids (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id, chunk_id INTEGER, chunk_offset INTEGER)')
  db.exec('CREATE TABLE vec_chunks_vector_chunks00 (rowid PRIMARY KEY, vectors BLOB NOT NULL)')
  const node = db.prepare("INSERT INTO nodes (id, project, kind, title, body, source, source_ref, pinned, until, created_at, updated_at, hits, content_hash, embedded) VALUES (?, ?, ?, ?, ?, 'claude', ?, 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, 'h', 1)")
  node.run('n1', 'demo', 'fact', 'Postgres', 'La base usa postgres', 'ref:1', 3)
  node.run('n2', GLOBAL, 'rule', 'Regla', 'Siempre pruebas [[Postgres]]', null, 0)
  db.exec("INSERT INTO chunks (id, node_id, ord, text) VALUES (10, 'n1', 0, 'Postgres\n\nLa base usa postgres'), (11, 'n2', 0, 'Regla')")
  db.exec("INSERT INTO fts_nodes (node_id, project, title, body) VALUES ('n1', 'demo', 'Postgres', 'La base usa postgres'), ('n2', 'global', 'Regla', 'Siempre pruebas [[Postgres]]')")
  db.exec("INSERT INTO edges (src, dst, kind, weight) VALUES ('n2', 'n1', 'link', 1)")
  db.exec("INSERT INTO attrs VALUES ('n1', 'issue', 'PP-1')")
  db.exec("INSERT INTO pending_links VALUES ('n2', 'otra')")
  db.exec("INSERT INTO project_groups VALUES ('g', 'demo')")
  db.exec("INSERT INTO injections VALUES ('s', 'n1', 'now')")
  db.exec("INSERT INTO stats (session_id, hook, tokens, nodes, ms, at) VALUES ('s', 'prompt', 12, 1, 5, 'now')")
  db.exec("INSERT INTO project_cache VALUES ('/x', 'demo', 'git', 1)")
  db.exec("INSERT INTO projects VALUES ('demo', 7, 'Demo', 'DM')")
  db.exec("INSERT INTO ingest_files VALUES ('/a.md', 5, 'n1')")
  db.exec("INSERT INTO harvests VALUES ('s', 4, 'now')")
  db.exec("INSERT INTO vec_chunks_rowids (id, chunk_id, chunk_offset) VALUES (NULL, 10, 0)")
  db.exec('PRAGMA user_version = 2')
  db.enableDefensive(false)
  db.exec('PRAGMA writable_schema = ON')
  db.prepare("INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'vec_chunks', 'vec_chunks', 0, ?)").run(VEC0_DDL)
  db.exec('PRAGMA writable_schema = OFF')
  db.close()
  return true
}

test('constants are copied from db.rs', () => {
  assert.deepEqual(KINDS, ['rule', 'fact', 'decision', 'doc', 'entry', 'issue', 'meeting', 'memory'])
  assert.deepEqual(SOURCES, ['claude', 'harvest', 'inkwell', 'recap', 'bita', 'tally', 'import', 'user'])
  assert.deepEqual(EDGE_KINDS, ['link', 'same-issue', 'same-entry', 'similar'])
  assert.deepEqual(NOTE_KINDS, ['rule', 'fact', 'decision', 'memory'])
  assert.equal(GLOBAL, 'global')
})

test('the DDL is the one in db.rs except for the vector table', { skip: !fs.existsSync(RUST_DB) && 'db.rs is not in this checkout' }, () => {
  const rust = fs.readFileSync(RUST_DB, 'utf8').replace(/\r\n/g, '\n')
  const start = rust.indexOf('const SCHEMA: &str = r#"') + 'const SCHEMA: &str = r#"'.length
  const ddl = rust.slice(start, rust.indexOf('"#;', start))
  assert.ok(ddl.includes(RUST_VECTORS))
  assert.equal(SCHEMA, ddl.replace(RUST_VECTORS, JS_VECTORS))
})

test('openDb creates the parent, applies the schema and the pragmas', () => {
  const file = path.join(dir, 'deep', 'er', 'gaze.db')
  const db = openDb(file, { log: quiet })
  assert.ok(fs.existsSync(file))
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1)
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 10000)
  assert.deepEqual(tables(db), [
    'attrs', 'attrs_value', 'chunk_vectors', 'chunk_vectors_project', 'chunks', 'chunks_node', 'edges', 'edges_dst', 'fts_nodes', 'harvests', 'ingest_files',
    'injections', 'nodes', 'nodes_project_kind', 'nodes_title', 'pending_links', 'pending_links_title', 'project_cache', 'project_groups', 'projects', 'stats', 'stats_session',
  ])
  db.close()
  const again = openDb(file, { log: quiet })
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 0)
  again.close()
})

test('version 1 databases only gain project_groups', () => {
  const file = path.join(dir, 'v1.db')
  const old = new DatabaseSync(file)
  old.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY); CREATE TABLE chunk_vectors (chunk_id INTEGER PRIMARY KEY); PRAGMA user_version = 1')
  old.close()
  const db = openDb(file, { log: quiet })
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.deepEqual(tables(db), ['chunk_vectors', 'nodes', 'project_groups'])
  db.close()
})

test('openMemory applies the schema without pragmas', () => {
  const db = openMemory()
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0)
  assert.ok(tables(db).includes('chunk_vectors'))
  db.prepare('INSERT INTO chunk_vectors (chunk_id, project, embedding) VALUES (?, ?, ?)').run(1, 'demo', Buffer.alloc(8))
  assert.equal(db.prepare("SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH 'x'").all().length, 0)
  assert.throws(() => db.prepare("INSERT INTO nodes (id, project, kind, title, body, source, created_at, updated_at) VALUES ('a', 'p', 'bogus', 't', 'b', 'claude', 'n', 'n')").run(), /CHECK constraint failed/)
  db.close()
})

test('fts uses unicode61 with diacritics removed', () => {
  const db = openMemory()
  db.exec("INSERT INTO fts_nodes (node_id, project, title, body) VALUES ('n', 'p', 'Remediación', 'canción')")
  assert.equal(db.prepare("SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH 'remediacion cancion'").all().length, 1)
  db.close()
})

test('native vec0 databases are refused outside windows', (t) => {
  const file = path.join(dir, 'gaze.db')
  if (!nativeFixture(file)) return t.skip('enableDefensive is not available')
  const before = fs.readFileSync(file)
  assert.throws(() => openDb(file, { migrate: false, log: quiet }), (error) => {
    assert.ok(error instanceof GazeError)
    assert.equal(error.code, 'INTERNAL_ERROR')
    assert.equal(error.message, 'Esta base es de gaze nativo (vec0); usa GAZE_DATA_DIR para el port JS')
    assert.equal(typeof error.hint, 'string')
    return true
  })
  assert.deepEqual(fs.readFileSync(file), before)
})

test('native vec0 databases are migrated by copying every table to a new file', (t) => {
  const file = path.join(dir, 'gaze.db')
  if (!nativeFixture(file)) return t.skip('enableDefensive is not available')
  const probe = new DatabaseSync(file)
  assert.equal(isNativeVec0(probe), true)
  probe.close()
  const messages = []
  const db = openDb(file, { migrate: true, log: (m) => messages.push(m) })
  assert.equal(messages.length, 1)
  assert.match(messages[0], /gaze reindex/)
  assert.equal(isNativeVec0(db), false)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'vec_chunks%'").get().n, 0)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  const nodes = db.prepare('SELECT id, project, kind, title, body, source_ref, hits, embedded FROM nodes ORDER BY id').all().map((r) => ({ ...r }))
  assert.deepEqual(nodes, [
    { id: 'n1', project: 'demo', kind: 'fact', title: 'Postgres', body: 'La base usa postgres', source_ref: 'ref:1', hits: 3, embedded: 0 },
    { id: 'n2', project: 'global', kind: 'rule', title: 'Regla', body: 'Siempre pruebas [[Postgres]]', source_ref: null, hits: 0, embedded: 0 },
  ])
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  assert.deepEqual(
    ['chunks', 'edges', 'attrs', 'pending_links', 'project_groups', 'injections', 'stats', 'project_cache', 'projects', 'ingest_files', 'harvests', 'chunk_vectors'].map(count),
    [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
  )
  assert.deepEqual(db.prepare("SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH 'postgres' ORDER BY node_id").all().map((r) => r.node_id), ['n1', 'n2'])
  db.close()
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('gaze.db.vec0.bak'))
  assert.deepEqual(backups.filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm')), ['gaze.db.vec0.bak'])
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.migrat')), [])
  const backup = new DatabaseSync(path.join(dir, 'gaze.db.vec0.bak'))
  assert.equal(isNativeVec0(backup), true)
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 2)
  backup.close()
  const reopened = openDb(file, { migrate: true, log: (m) => messages.push(m) })
  assert.equal(messages.length, 1)
  reopened.close()
})

test('a second migration keeps the first backup', (t) => {
  const file = path.join(dir, 'gaze.db')
  if (!nativeFixture(file)) return t.skip('enableDefensive is not available')
  fs.writeFileSync(`${file}.vec0.bak`, 'older backup')
  const { backup, nodes } = migrateVec0(file)
  assert.equal(nodes, 2)
  assert.notEqual(backup, `${file}.vec0.bak`)
  assert.equal(fs.readFileSync(`${file}.vec0.bak`, 'utf8'), 'older backup')
  assert.ok(fs.existsSync(backup))
})

test('a failed migration leaves the original untouched', () => {
  const file = path.join(dir, 'broken.db')
  fs.writeFileSync(file, 'this is not a sqlite database at all, just text that is long enough')
  const before = fs.readFileSync(file)
  assert.throws(() => migrateVec0(file), /migrate/)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.migrat')), [])
})

const DB_URL = new URL('../src/db.js', import.meta.url).href

function openInChild(file) {
  const code = `import { openDb } from ${JSON.stringify(DB_URL)}
const db = openDb(${JSON.stringify(file)}, { migrate: true, log: (m) => process.stderr.write(m + '\\n') })
const nodes = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n
const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n
db.close()
process.stdout.write(JSON.stringify({ nodes, chunks }))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })))
}

test('two concurrent openDb calls on a vec0 database migrate it once and keep the data', async (t) => {
  for (let round = 0; round < 3; round += 1) {
    const file = path.join(dir, `race${round}.db`)
    if (!nativeFixture(file)) return t.skip('enableDefensive is not available')
    const results = await Promise.all([openInChild(file), openInChild(file)])
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { nodes: 2, chunks: 2 })
    }
    assert.equal(results.filter((result) => /gaze reindex/.test(result.stderr)).length, 1)
    const names = fs.readdirSync(dir).filter((name) => name.startsWith(`race${round}.db`))
    assert.deepEqual(names.filter((name) => name.includes('.vec0.bak') && !name.endsWith('-wal') && !name.endsWith('-shm')), [`race${round}.db.vec0.bak`])
    assert.deepEqual(names.filter((name) => name.includes('.migrat')), [])
  }
})

test('openDb never creates an empty database next to a vec0 backup', () => {
  const file = path.join(dir, 'gaze.db')
  fs.writeFileSync(`${file}.vec0.bak`, 'native copy')
  assert.throws(() => openDb(file, { migrate: true, log: quiet }), (error) => {
    assert.ok(error instanceof GazeError)
    assert.equal(error.message, `Falta ${file} pero existe la copia de gaze nativo ${file}.vec0.bak`)
    return true
  })
  assert.equal(fs.existsSync(file), false)
})

test('openDb waits for a live migration lock and gives up without creating the file', () => {
  const file = path.join(dir, 'gaze.db')
  fs.writeFileSync(migrationLock(file), `${process.pid}\n`)
  const started = Date.now()
  assert.throws(() => openDb(file, { migrate: true, log: quiet, waitMs: 300 }), { message: `Otro proceso está migrando ${file}` })
  assert.ok(Date.now() - started >= 300)
  assert.equal(fs.existsSync(file), false)
})

test('a migration lock left by a dead process does not block the migration', async (t) => {
  const file = path.join(dir, 'gaze.db')
  if (!nativeFixture(file)) return t.skip('enableDefensive is not available')
  const dead = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => dead.on('exit', resolve))
  fs.writeFileSync(migrationLock(file), `${dead.pid}\n`)
  const db = openDb(file, { migrate: true, log: quiet, waitMs: 2000 })
  assert.equal(isNativeVec0(db), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 2)
  db.close()
  assert.equal(fs.existsSync(migrationLock(file)), false)
})
