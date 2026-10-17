use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;
use std::sync::Once;

static VEC_INIT: Once = Once::new();

pub const KINDS: [&str; 8] = ["rule", "fact", "decision", "doc", "entry", "issue", "meeting", "memory"];
pub const SOURCES: [&str; 8] = ["claude", "harvest", "inkwell", "recap", "bita", "tally", "import", "user"];
pub const EDGE_KINDS: [&str; 4] = ["link", "same-issue", "same-entry", "similar"];
pub const NOTE_KINDS: [&str; 4] = ["rule", "fact", "decision", "memory"];

const SCHEMA: &str = r#"
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

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[384] distance_metric=cosine,
  project TEXT partition key
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_nodes USING fts5(
  node_id UNINDEXED,
  project UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
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
"#;

pub fn register_vec() {
    VEC_INIT.call_once(|| unsafe {
        #[allow(clippy::missing_transmute_annotations)]
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ())));
    });
}

pub fn open(path: &Path) -> Result<Connection> {
    register_vec();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    Ok(conn)
}

pub fn open_memory() -> Result<Connection> {
    register_vec();
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}
