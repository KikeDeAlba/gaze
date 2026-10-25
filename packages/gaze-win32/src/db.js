import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GazeError } from './envelope.js'
import { lockHeld, releaseLock, tryLock } from './paths.js'

export const KINDS = ['rule', 'fact', 'decision', 'doc', 'entry', 'issue', 'meeting', 'memory']
export const SOURCES = ['claude', 'harvest', 'inkwell', 'recap', 'bita', 'tally', 'import', 'user']
export const EDGE_KINDS = ['link', 'same-issue', 'same-entry', 'similar']
export const NOTE_KINDS = ['rule', 'fact', 'decision', 'memory']
export const GLOBAL = 'global'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rule','fact','decision','doc','entry','issue','meeting','memory')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('claude','harvest','inkwell','recap','bita','tally','import','user')),
  source_ref TEXT UNIQUE,
  pinned INTEGER NOT NULL DEFAULT 0,
  until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nodes_project_kind ON nodes(project, kind);
CREATE INDEX IF NOT EXISTS nodes_title ON nodes(lower(title));

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link','same-issue','same-entry','similar')),
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS attrs (
  node_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (node_id, key, value)
);
CREATE INDEX IF NOT EXISTS attrs_value ON attrs(key, value);

CREATE TABLE IF NOT EXISTS pending_links (
  src TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (src, title)
);
CREATE INDEX IF NOT EXISTS pending_links_title ON pending_links(title);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_node ON chunks(node_id);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunk_vectors_project ON chunk_vectors(project);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_nodes USING fts5(
  node_id UNINDEXED,
  project UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS project_groups (
  name TEXT NOT NULL,
  project TEXT NOT NULL,
  PRIMARY KEY (name, project)
);

CREATE TABLE IF NOT EXISTS injections (
  session_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, node_id)
);

CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  hook TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  nodes INTEGER NOT NULL,
  ms INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stats_session ON stats(session_id);

CREATE TABLE IF NOT EXISTS project_cache (
  cwd TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  source TEXT NOT NULL,
  resolved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  bita_id INTEGER,
  name TEXT,
  key TEXT
);

CREATE TABLE IF NOT EXISTS ingest_files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  node_id TEXT
);

CREATE TABLE IF NOT EXISTS harvests (
  session_id TEXT PRIMARY KEY,
  lines INTEGER NOT NULL,
  at TEXT NOT NULL
);
`

const GROUPS_DDL = 'CREATE TABLE IF NOT EXISTS project_groups (name TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (name, project));'

const COPY_TABLES = ['nodes', 'edges', 'attrs', 'pending_links', 'chunks', 'project_groups', 'injections', 'stats', 'project_cache', 'projects', 'ingest_files', 'harvests']

const NATIVE_MESSAGE = 'Esta base es de gaze nativo (vec0); usa GAZE_DATA_DIR para el port JS'
const NATIVE_HINT = 'El port JS solo migra bases de gaze nativo en Windows; en macOS y Linux apunta GAZE_DATA_DIR a otro directorio o sigue usando el binario nativo'
const MIGRATE_WAIT_MS = 120000
const POLL_MS = 100
const RENAME_TRIES = 50
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const SIDE_FILES = ['', '-wal', '-shm', '-journal']

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export const migrationLock = (file) => `${file}.migrate.lock`

function tableNames(db, schema = 'main') {
  return new Set(db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all().map((row) => row.name))
}

export function isNativeVec0(db) {
  const names = tableNames(db)
  return names.has('vec_chunks') && !names.has('chunk_vectors')
}

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function columns(db, schema, table) {
  return db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all().map((row) => row.name)
}

function freePath(candidate) {
  if (!fs.existsSync(candidate)) return candidate
  return `${candidate}.${Date.now()}`
}

function renameRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (!BUSY_CODES.has(error.code) || attempt >= RENAME_TRIES) throw error
      sleepSync(POLL_MS)
    }
  }
}

function moveIfExists(from, to) {
  if (fs.existsSync(from)) renameRetry(from, to)
}

function removeStaging(staging) {
  for (const suffix of SIDE_FILES) fs.rmSync(staging + suffix, { force: true })
}

function swapIn(file, staging) {
  const backup = freePath(`${file}.vec0.bak`)
  try {
    renameRetry(file, backup)
  } catch (error) {
    removeStaging(staging)
    throw new Error(`migrate ${file}`, { cause: error })
  }
  try {
    moveIfExists(`${file}-wal`, `${backup}-wal`)
    moveIfExists(`${file}-shm`, `${backup}-shm`)
    renameRetry(staging, file)
  } catch (error) {
    try {
      if (!fs.existsSync(file)) renameRetry(backup, file)
    } catch {}
    removeStaging(staging)
    throw new Error(`migrate ${file}`, { cause: error })
  }
  return backup
}

export function migrateVec0(file) {
  const staging = `${file}.migrating.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  removeStaging(staging)
  const target = new DatabaseSync(staging)
  let nodes = 0
  try {
    target.exec(SCHEMA)
    target.exec('PRAGMA user_version = 2')
    target.prepare('ATTACH DATABASE ? AS old').run(file)
    const old = tableNames(target, 'old')
    target.exec('BEGIN')
    try {
      for (const table of COPY_TABLES) {
        if (!old.has(table)) continue
        const keep = new Set(columns(target, 'main', table))
        const shared = columns(target, 'old', table).filter((name) => keep.has(name)).map(quote)
        if (shared.length === 0) continue
        const list = shared.join(', ')
        target.exec(`INSERT INTO main.${quote(table)} (${list}) SELECT ${list} FROM old.${quote(table)}`)
      }
      let copied = false
      if (old.has('fts_nodes')) {
        try {
          target.exec('INSERT INTO main.fts_nodes (node_id, project, title, body) SELECT node_id, project, title, body FROM old.fts_nodes')
          copied = true
        } catch {
          target.exec('DELETE FROM main.fts_nodes')
        }
      }
      if (!copied) target.exec('INSERT INTO main.fts_nodes (node_id, project, title, body) SELECT id, project, title, body FROM main.nodes')
      target.exec('UPDATE main.nodes SET embedded = 0')
      nodes = target.prepare('SELECT COUNT(*) AS n FROM main.nodes').get().n
      target.exec('COMMIT')
    } catch (error) {
      target.exec('ROLLBACK')
      throw error
    }
    target.exec('DETACH DATABASE old')
  } catch (error) {
    target.close()
    removeStaging(staging)
    throw new Error(`migrate ${file}`, { cause: error })
  }
  target.close()
  return { backup: swapIn(file, staging), nodes }
}

function defaultLog(message) {
  process.stderr.write(`${message}\n`)
}

function busy(file) {
  return new GazeError('INTERNAL_ERROR', `Otro proceso está migrando ${file}`, 'Vuelve a intentarlo en un momento')
}

function vec0Backup(file) {
  const base = `${path.basename(file)}.vec0.bak`
  let names
  try {
    names = fs.readdirSync(path.dirname(file))
  } catch {
    return null
  }
  const found = names.find((name) => name.startsWith(base) && !name.endsWith('-wal') && !name.endsWith('-shm'))
  return found === undefined ? null : path.join(path.dirname(file), found)
}

function waitForMigration(file, deadline) {
  while (lockHeld(migrationLock(file))) {
    if (Date.now() >= deadline) throw busy(file)
    sleepSync(POLL_MS)
  }
}

function refuseMissing(file) {
  if (fs.existsSync(file)) return
  const backup = vec0Backup(file)
  if (backup === null) return
  throw new GazeError('INTERNAL_ERROR', `Falta ${file} pero existe la copia de gaze nativo ${backup}`, `Restaura la copia con su nombre original o bórrala para empezar con una base vacía`)
}

function connect(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 10000')
  return db
}

function migrateOnce(file, deadline) {
  const lock = migrationLock(file)
  while (!tryLock(lock)) {
    if (Date.now() >= deadline) throw busy(file)
    sleepSync(POLL_MS)
  }
  try {
    refuseMissing(file)
    const probe = connect(file)
    let native
    try {
      native = isNativeVec0(probe)
    } finally {
      probe.close()
    }
    return native ? migrateVec0(file) : null
  } finally {
    releaseLock(lock)
  }
}

export function openDb(file, { migrate = process.platform === 'win32', log = defaultLog, waitMs = MIGRATE_WAIT_MS } = {}) {
  const parent = path.dirname(file)
  if (parent !== '') fs.mkdirSync(parent, { recursive: true })
  const deadline = Date.now() + waitMs
  if (!fs.existsSync(file)) waitForMigration(file, deadline)
  refuseMissing(file)
  let db = connect(file)
  if (isNativeVec0(db)) {
    db.close()
    if (!migrate) throw new GazeError('INTERNAL_ERROR', NATIVE_MESSAGE, NATIVE_HINT)
    const migrated = migrateOnce(file, deadline)
    if (migrated !== null) {
      log(`gaze: ${file} era una base de gaze nativo (vec0); se migró al port JS y el original quedó en ${migrated.backup}. Corre \`gaze reindex\` para regenerar los vectores.`)
    }
    refuseMissing(file)
    db = connect(file)
  }
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version < 1) {
    db.exec(SCHEMA)
    db.exec('PRAGMA user_version = 2')
  } else if (version < 2) {
    db.exec(GROUPS_DDL)
    db.exec('PRAGMA user_version = 2')
  }
  return db
}

export function openMemory() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return db
}
