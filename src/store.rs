use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::config::Config;
use crate::db::{self, KINDS, NOTE_KINDS, SOURCES};
use crate::embed::{self, Embedder, Mode};
use crate::envelope::{GazeError, not_found, usage};
use crate::text;

pub const GLOBAL: &str = "global";
const RRF_K: f64 = 60.0;
const ATTR_EDGE_LIMIT: usize = 10;

pub struct Store {
    pub conn: Connection,
    pub cfg: Config,
}

#[derive(Debug, Clone, Default)]
pub struct NewNode {
    pub project: String,
    pub kind: String,
    pub title: Option<String>,
    pub body: String,
    pub source: String,
    pub source_ref: Option<String>,
    pub pinned: bool,
    pub until: Option<String>,
    pub attrs: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Renamed {
    pub id: String,
    pub displaced: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteOutcome {
    pub id: String,
    pub action: &'static str,
    pub title: String,
    pub project: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub project: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub source: String,
    pub source_ref: Option<String>,
    pub pinned: bool,
    pub until: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub hits: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Neighbor {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub edge_kind: String,
}

#[derive(Debug, Clone)]
pub enum Scope {
    Project(String),
    All,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub project: String,
    pub snippet: String,
    pub score: f64,
    #[serde(skip)]
    pub similarity: Option<f32>,
    #[serde(skip)]
    pub coverage: f32,
    #[serde(skip)]
    pub title_coverage: f32,
    #[serde(skip)]
    pub body: String,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub kind: Option<String>,
    pub limit: usize,
    pub exclude_kinds: Vec<String>,
}

const NODE_COLUMNS: &str = "id, project, kind, title, body, source, source_ref, pinned, until, created_at, updated_at, hits";

fn row_node(r: &rusqlite::Row) -> rusqlite::Result<Node> {
    Ok(Node {
        id: r.get(0)?,
        project: r.get(1)?,
        kind: r.get(2)?,
        title: r.get(3)?,
        body: r.get(4)?,
        source: r.get(5)?,
        source_ref: r.get(6)?,
        pinned: r.get::<_, i64>(7)? != 0,
        until: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        hits: r.get(11)?,
    })
}

fn content_hash(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for part in parts {
        for b in part.bytes().chain(std::iter::once(0u8)) {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("{h:016x}")
}

fn canonical<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b { (a, b) } else { (b, a) }
}

pub fn validate_kind(kind: &str) -> Result<()> {
    if KINDS.contains(&kind) { Ok(()) } else { Err(usage(format!("Tipo inválido: {kind}. Usa uno de: {}", KINDS.join(", ")))) }
}

pub fn validate_until(until: &Option<String>) -> Result<()> {
    if let Some(value) = until
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err()
    {
        return Err(usage(format!("Fecha inválida: {value}. Usa AAAA-MM-DD")));
    }
    Ok(())
}

fn fts_query(query: &str) -> Option<String> {
    let terms = text::terms(query);
    if terms.is_empty() {
        return None;
    }
    let parts: Vec<String> = terms
        .iter()
        .map(|t| {
            let n = t.chars().count();
            if n >= 6 {
                let keep = (n * 3 / 4).max(5);
                format!("\"{}\"*", t.chars().take(keep).collect::<String>())
            } else {
                format!("\"{t}\"")
            }
        })
        .collect();
    Some(parts.join(" OR "))
}

pub fn coverage(terms: &[String], haystack: &str) -> f32 {
    if terms.is_empty() {
        return 0.0;
    }
    let folded = text::fold(haystack);
    let found = terms
        .iter()
        .filter(|t| {
            let n = t.chars().count();
            let probe: String = if n >= 6 { t.chars().take((n * 3 / 4).max(5)).collect() } else { (*t).clone() };
            folded.contains(&probe)
        })
        .count();
    found as f32 / terms.len() as f32
}

impl Store {
    pub fn open_default() -> Result<Self> {
        Ok(Self { conn: db::open(&crate::paths::db_path())?, cfg: Config::load() })
    }

    pub fn in_memory() -> Result<Self> {
        Ok(Self { conn: db::open_memory()?, cfg: Config::default() })
    }

    fn tx<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match f() {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn get(&self, id: &str) -> Result<Option<Node>> {
        let sql = format!("SELECT {NODE_COLUMNS} FROM nodes WHERE id = ?1");
        if let Some(node) = self.conn.query_row(&sql, [id], row_node).optional()? {
            return Ok(Some(node));
        }
        if id.len() < 4 {
            return Ok(None);
        }
        let sql = format!("SELECT {NODE_COLUMNS} FROM nodes WHERE id LIKE ?1 || '%' LIMIT 2");
        let mut stmt = self.conn.prepare(&sql)?;
        let found: Vec<Node> = stmt.query_map([id], row_node)?.collect::<rusqlite::Result<_>>()?;
        Ok(if found.len() == 1 { found.into_iter().next() } else { None })
    }

    pub fn require(&self, id: &str) -> Result<Node> {
        self.get(id)?.ok_or_else(|| not_found(id))
    }

    pub fn by_source_ref(&self, source_ref: &str) -> Result<Option<Node>> {
        let sql = format!("SELECT {NODE_COLUMNS} FROM nodes WHERE source_ref = ?1");
        Ok(self.conn.query_row(&sql, [source_ref], row_node).optional()?)
    }

    pub fn remember(&self, emb: &dyn Embedder, input: NewNode, dedupe: bool) -> Result<WriteOutcome> {
        validate_kind(&input.kind)?;
        validate_until(&input.until)?;
        if !SOURCES.contains(&input.source.as_str()) {
            return Err(usage(format!("Fuente inválida: {}", input.source)));
        }
        let body = input.body.trim().to_string();
        if body.is_empty() {
            return Err(usage("La nota está vacía"));
        }
        let project = if input.project.trim().is_empty() { GLOBAL.to_string() } else { input.project.trim().to_string() };
        let explicit_title = input.title.as_ref().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let title = explicit_title.clone().unwrap_or_else(|| text::derive_title(&body));
        let hash = content_hash(&[&project, &input.kind, &title, &body, if input.pinned { "1" } else { "0" }, input.until.as_deref().unwrap_or("")]);

        if let Some(source_ref) = &input.source_ref
            && let Some(existing) = self.by_source_ref(source_ref)?
        {
            let old_hash: Option<String> = self.conn.query_row("SELECT content_hash FROM nodes WHERE id = ?1", [&existing.id], |r| r.get(0))?;
            if old_hash.as_deref() == Some(hash.as_str()) {
                return Ok(WriteOutcome { id: existing.id, action: "unchanged", title, project, kind: input.kind });
            }
            let chunks = text::chunk(&title, &body);
            let vectors = emb.embed(&chunks, Mode::Passage).ok();
            let id = existing.id.clone();
            self.tx(|| {
                self.conn.execute(
                    "UPDATE nodes SET project=?2, kind=?3, title=?4, body=?5, pinned=?6, until=?7, updated_at=?8, content_hash=?9 WHERE id=?1",
                    params![id, project, input.kind, title, body, input.pinned as i64, input.until, text::now_iso(), hash],
                )?;
                self.write_content(&id, &project, &title, &body, &chunks, vectors.as_deref())?;
                self.after_write(&id, &project, &title, &body, &input.attrs, vectors.as_ref().and_then(|v| v.first()).map(|v| v.as_slice()))
            })?;
            return Ok(WriteOutcome { id, action: "updated", title, project, kind: input.kind });
        }

        let chunks = text::chunk(&title, &body);
        let vectors = emb.embed(&chunks, Mode::Passage).ok();

        if dedupe
            && NOTE_KINDS.contains(&input.kind.as_str())
            && let Some(head) = vectors.as_ref().and_then(|v| v.first())
            && let Some((existing_id, similarity)) = self.nearest_note(&project, head, None)?
            && similarity >= self.cfg.search.dedupe_threshold
        {
            let existing = self.require(&existing_id)?;
            let body = if similarity >= self.cfg.search.replace_threshold || text::fold(&body).contains(&text::fold(&existing.body)) {
                body
            } else if text::fold(&existing.body).contains(&text::fold(&body)) {
                existing.body.clone()
            } else {
                format!("{body}\n\n{}", existing.body)
            };
            let merged_title = explicit_title.unwrap_or(existing.title.clone());
            let pinned = existing.pinned || input.pinned;
            let until = input.until.clone().or(existing.until.clone());
            let merged_chunks = text::chunk(&merged_title, &body);
            let merged_vectors = if merged_title == title { vectors.clone() } else { emb.embed(&merged_chunks, Mode::Passage).ok() };
            let merged_hash = content_hash(&[&project, &existing.kind, &merged_title, &body, if pinned { "1" } else { "0" }, until.as_deref().unwrap_or("")]);
            self.tx(|| {
                self.conn.execute(
                    "UPDATE nodes SET title=?2, body=?3, pinned=?4, until=?5, updated_at=?6, content_hash=?7 WHERE id=?1",
                    params![existing_id, merged_title, body, pinned as i64, until, text::now_iso(), merged_hash],
                )?;
                self.write_content(&existing_id, &project, &merged_title, &body, &merged_chunks, merged_vectors.as_deref())?;
                self.after_write(
                    &existing_id,
                    &project,
                    &merged_title,
                    &body,
                    &input.attrs,
                    merged_vectors.as_ref().and_then(|v| v.first()).map(|v| v.as_slice()),
                )
            })?;
            return Ok(WriteOutcome { id: existing_id, action: "merged", title: merged_title, project, kind: existing.kind });
        }

        let id = self.fresh_id()?;
        let now = text::now_iso();
        self.tx(|| {
            self.conn.execute(
                "INSERT INTO nodes (id, project, kind, title, body, source, source_ref, pinned, until, created_at, updated_at, hits, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 0, ?11)",
                params![id, project, input.kind, title, body, input.source, input.source_ref, input.pinned as i64, input.until, now, hash],
            )?;
            self.write_content(&id, &project, &title, &body, &chunks, vectors.as_deref())?;
            self.after_write(&id, &project, &title, &body, &input.attrs, vectors.as_ref().and_then(|v| v.first()).map(|v| v.as_slice()))
        })?;
        Ok(WriteOutcome { id, action: "created", title, project, kind: input.kind })
    }

    fn fresh_id(&self) -> Result<String> {
        loop {
            let id = text::short_id();
            let taken: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM nodes WHERE id = ?1)", [&id], |r| r.get(0))?;
            if !taken {
                return Ok(id);
            }
        }
    }

    fn delete_content(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE node_id = ?1)", [id])?;
        self.conn.execute("DELETE FROM chunks WHERE node_id = ?1", [id])?;
        self.conn.execute("DELETE FROM fts_nodes WHERE node_id = ?1", [id])?;
        Ok(())
    }

    fn write_content(&self, id: &str, project: &str, title: &str, body: &str, chunks: &[String], vectors: Option<&[Vec<f32>]>) -> Result<()> {
        self.delete_content(id)?;
        self.conn.execute("INSERT INTO fts_nodes (node_id, project, title, body) VALUES (?1, ?2, ?3, ?4)", params![id, project, title, body])?;
        let mut insert_chunk = self.conn.prepare_cached("INSERT INTO chunks (node_id, ord, text) VALUES (?1, ?2, ?3)")?;
        let mut insert_vec = self.conn.prepare_cached("INSERT INTO vec_chunks (chunk_id, embedding, project) VALUES (?1, ?2, ?3)")?;
        for (ord, chunk) in chunks.iter().enumerate() {
            insert_chunk.execute(params![id, ord as i64, chunk])?;
            let chunk_id = self.conn.last_insert_rowid();
            if let Some(vector) = vectors.and_then(|v| v.get(ord)) {
                insert_vec.execute(params![chunk_id, embed::to_blob(vector), project])?;
            }
        }
        self.conn.execute("UPDATE nodes SET embedded = ?2 WHERE id = ?1", params![id, vectors.is_some() as i64])?;
        Ok(())
    }

    fn after_write(&self, id: &str, project: &str, title: &str, body: &str, attrs: &[(String, String)], head: Option<&[f32]>) -> Result<()> {
        for target in text::wikilinks(body) {
            match self.resolve_title(project, &target)? {
                Some(dst) if dst != id => self.add_edge(id, &dst, "link", 1.0, false)?,
                Some(_) => {}
                None => {
                    self.conn.execute("INSERT OR IGNORE INTO pending_links (src, title) VALUES (?1, ?2)", params![id, text::fold(&target)])?;
                }
            }
        }
        let source_ref: Option<String> = self.conn.query_row("SELECT source_ref FROM nodes WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
        let mut names = vec![text::fold(title)];
        if let Some(stem) = source_ref.as_deref().and_then(|r| r.rsplit('/').next()).and_then(|f| f.strip_suffix(".md")) {
            names.push(text::fold(stem));
        }
        for name in names {
            self.claim_pending(id, &name)?;
        }

        self.conn.execute("DELETE FROM attrs WHERE node_id = ?1", [id])?;
        let mut all_attrs: Vec<(String, String)> = attrs.to_vec();
        for key in text::issue_keys(&format!("{title}\n{body}")) {
            all_attrs.push(("issue".into(), key));
        }
        let mut seen = HashSet::new();
        for (key, value) in all_attrs {
            if !seen.insert((key.clone(), value.clone())) {
                continue;
            }
            self.conn.execute("INSERT OR IGNORE INTO attrs (node_id, key, value) VALUES (?1, ?2, ?3)", params![id, key, value])?;
            let edge_kind = match key.as_str() {
                "issue" => "same-issue",
                "entry" => "same-entry",
                _ => continue,
            };
            let others: Vec<String> = {
                let mut stmt = self.conn.prepare(
                    "SELECT a.node_id FROM attrs a JOIN nodes n ON n.id = a.node_id WHERE a.key = ?1 AND a.value = ?2 AND a.node_id != ?3 ORDER BY n.updated_at DESC LIMIT ?4",
                )?;
                stmt.query_map(params![key, value, id, ATTR_EDGE_LIMIT as i64], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
            };
            for other in others {
                self.add_edge(id, &other, edge_kind, 1.0, true)?;
            }
        }

        if let Some(head) = head {
            self.refresh_similar(id, project, head)?;
        }
        Ok(())
    }

    fn claim_pending(&self, id: &str, name: &str) -> Result<()> {
        let waiting: Vec<String> = {
            let mut stmt = self.conn.prepare("SELECT src FROM pending_links WHERE title = ?1 AND src != ?2")?;
            stmt.query_map(params![name, id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        for src in waiting {
            self.add_edge(&src, id, "link", 1.0, false)?;
        }
        self.conn.execute("DELETE FROM pending_links WHERE title = ?1 AND src != ?2", params![name, id])?;
        Ok(())
    }

    pub fn add_edge(&self, src: &str, dst: &str, kind: &str, weight: f64, undirected: bool) -> Result<()> {
        let (a, b) = if undirected { canonical(src, dst) } else { (src, dst) };
        self.conn.execute(
            "INSERT INTO edges (src, dst, kind, weight) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight",
            params![a, b, kind, weight],
        )?;
        Ok(())
    }

    pub fn resolve_title(&self, project: &str, title: &str) -> Result<Option<String>> {
        let folded = text::fold(title.trim());
        let candidates: Vec<(String, String, String)> = {
            let mut stmt =
                self.conn.prepare("SELECT id, project, title FROM nodes WHERE lower(title) = lower(?1) OR title = ?1 OR source_ref LIKE '%' || ?2")?;
            stmt.query_map(params![title.trim(), format!("/{}.md", title.trim())], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let matches: Vec<&(String, String, String)> = candidates.iter().filter(|(_, _, t)| text::fold(t) == folded).collect();
        let pick = |p: &str| matches.iter().find(|(_, proj, _)| proj == p).map(|(id, _, _)| id.clone());
        Ok(pick(project)
            .or_else(|| pick(GLOBAL))
            .or_else(|| candidates.iter().find(|(_, proj, _)| proj == project || proj == GLOBAL).map(|(id, _, _)| id.clone())))
    }

    fn knn(&self, vector: &[f32], project: Option<&str>, k: usize) -> Result<Vec<(String, i64, f32, String)>> {
        let blob = embed::to_blob(vector);
        let map = |r: &rusqlite::Row| -> rusqlite::Result<(String, i64, f32, String)> {
            let distance: f64 = r.get(1)?;
            Ok((r.get(2)?, r.get(3)?, (1.0 - distance) as f32, r.get(4)?))
        };
        let rows = match project {
            Some(p) => {
                let mut stmt = self.conn.prepare_cached(
                    "WITH knn AS (SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ?1 AND k = ?2 AND project = ?3)
                     SELECT knn.chunk_id, knn.distance, c.node_id, c.ord, c.text FROM knn JOIN chunks c ON c.id = knn.chunk_id ORDER BY knn.distance",
                )?;
                stmt.query_map(params![blob, k as i64, p], map)?.collect::<rusqlite::Result<Vec<_>>>()?
            }
            None => {
                let mut stmt = self.conn.prepare_cached(
                    "WITH knn AS (SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ?1 AND k = ?2)
                     SELECT knn.chunk_id, knn.distance, c.node_id, c.ord, c.text FROM knn JOIN chunks c ON c.id = knn.chunk_id ORDER BY knn.distance",
                )?;
                stmt.query_map(params![blob, k as i64], map)?.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(rows)
    }

    fn nearest_note(&self, project: &str, head: &[f32], exclude: Option<&str>) -> Result<Option<(String, f32)>> {
        for (node_id, _, similarity, _) in self.knn(head, Some(project), 20)? {
            if Some(node_id.as_str()) == exclude {
                continue;
            }
            let (kind, source_ref): (String, Option<String>) =
                self.conn.query_row("SELECT kind, source_ref FROM nodes WHERE id = ?1", [&node_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            if NOTE_KINDS.contains(&kind.as_str()) && source_ref.is_none() {
                return Ok(Some((node_id, similarity)));
            }
        }
        Ok(None)
    }

    fn refresh_similar(&self, id: &str, project: &str, head: &[f32]) -> Result<()> {
        self.conn.execute("DELETE FROM edges WHERE kind = 'similar' AND (src = ?1 OR dst = ?1)", [id])?;
        let mut best: BTreeMap<String, f32> = BTreeMap::new();
        for (node_id, _, similarity, _) in self.knn(head, Some(project), 40)? {
            if node_id == id || similarity < self.cfg.search.similar_threshold {
                continue;
            }
            let entry = best.entry(node_id).or_insert(similarity);
            if similarity > *entry {
                *entry = similarity;
            }
        }
        let mut ranked: Vec<(String, f32)> = best.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (other, similarity) in ranked.into_iter().take(self.cfg.search.similar_neighbors) {
            self.add_edge(id, &other, "similar", (similarity as f64 * 1000.0).round() / 1000.0, true)?;
        }
        Ok(())
    }

    pub fn reindex(&self, emb: &dyn Embedder, all: bool) -> Result<usize> {
        let ids: Vec<String> = {
            let sql = if all { "SELECT id FROM nodes" } else { "SELECT id FROM nodes WHERE embedded = 0" };
            let mut stmt = self.conn.prepare(sql)?;
            stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let mut done = 0;
        for id in ids {
            let node = self.require(&id)?;
            let chunks = text::chunk(&node.title, &node.body);
            let vectors = emb.embed(&chunks, Mode::Passage)?;
            self.tx(|| {
                self.write_content(&id, &node.project, &node.title, &node.body, &chunks, Some(&vectors))?;
                self.refresh_similar(&id, &node.project, &vectors[0])
            })?;
            done += 1;
        }
        Ok(done)
    }

    pub fn forget(&self, id: &str) -> Result<Node> {
        let node = self.require(id)?;
        self.tx(|| self.delete_node(&node.id))?;
        Ok(node)
    }

    fn delete_node(&self, id: &str) -> Result<()> {
        self.delete_content(id)?;
        self.conn.execute("DELETE FROM edges WHERE src = ?1 OR dst = ?1", [id])?;
        self.conn.execute("DELETE FROM attrs WHERE node_id = ?1", [id])?;
        self.conn.execute("DELETE FROM pending_links WHERE src = ?1", [id])?;
        self.conn.execute("DELETE FROM injections WHERE node_id = ?1", [id])?;
        self.conn.execute("DELETE FROM ingest_files WHERE node_id = ?1", [id])?;
        self.conn.execute("DELETE FROM nodes WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn rename_source_ref(&self, from: &str, to: &str) -> Result<Option<Renamed>> {
        let Some(node) = self.by_source_ref(from)? else {
            self.conn.execute("DELETE FROM ingest_files WHERE path = ?1", [from])?;
            return Ok(None);
        };
        if from == to {
            return Ok(Some(Renamed { id: node.id, displaced: None }));
        }
        let stem = to.rsplit('/').next().and_then(|f| f.strip_suffix(".md")).map(text::fold);
        let displaced = self.tx(|| {
            let displaced = self.by_source_ref(to)?.map(|n| n.id).filter(|other| *other != node.id);
            if let Some(other) = &displaced {
                self.conn.execute("UPDATE OR IGNORE edges SET dst = ?1 WHERE dst = ?2 AND kind = 'link' AND src != ?1", params![node.id, other])?;
                self.delete_node(other)?;
            }
            self.conn.execute("DELETE FROM ingest_files WHERE path = ?1", [to])?;
            self.conn.execute("UPDATE nodes SET source_ref = ?2, updated_at = ?3 WHERE id = ?1", params![node.id, to, text::now_iso()])?;
            self.conn.execute("UPDATE ingest_files SET path = ?2 WHERE path = ?1", params![from, to])?;
            if let Some(stem) = &stem {
                self.claim_pending(&node.id, stem)?;
            }
            Ok(displaced)
        })?;
        Ok(Some(Renamed { id: node.id, displaced }))
    }

    pub fn link(&self, a: &str, b: &str) -> Result<(Node, Node)> {
        let first = self.require(a)?;
        let second = self.require(b)?;
        if first.id == second.id {
            return Err(usage("No se puede enlazar una nota consigo misma"));
        }
        self.add_edge(&first.id, &second.id, "link", 1.0, false)?;
        Ok((first, second))
    }

    pub fn neighbors(&self, id: &str) -> Result<Vec<Neighbor>> {
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.title, n.kind, e.kind, e.weight FROM edges e JOIN nodes n ON n.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END
             WHERE e.src = ?1 OR e.dst = ?1 ORDER BY CASE e.kind WHEN 'link' THEN 0 WHEN 'same-entry' THEN 1 WHEN 'same-issue' THEN 2 ELSE 3 END, e.weight DESC LIMIT 50",
        )?;
        let rows = stmt
            .query_map([id], |r| Ok(Neighbor { id: r.get(0)?, title: r.get(1)?, kind: r.get(2)?, edge_kind: r.get(3)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn show(&self, id: &str) -> Result<(Node, Vec<Neighbor>)> {
        let node = self.require(id)?;
        self.conn.execute("UPDATE nodes SET hits = hits + 1 WHERE id = ?1", [&node.id])?;
        let neighbors = self.neighbors(&node.id)?;
        Ok((node, neighbors))
    }

    pub fn bump_hits(&self, ids: &[String]) -> Result<()> {
        for id in ids {
            self.conn.execute("UPDATE nodes SET hits = hits + 1 WHERE id = ?1", [id])?;
        }
        Ok(())
    }

    pub fn scope_projects(&self, project: &str) -> Result<Vec<String>> {
        if project == GLOBAL {
            return Ok(vec![GLOBAL.to_string()]);
        }
        let mut stmt = self.conn.prepare_cached(
            "SELECT name FROM project_groups WHERE project = ?1
             UNION SELECT g.project FROM project_groups g JOIN project_groups m ON m.name = g.name WHERE m.project = ?1",
        )?;
        let related: Vec<String> = stmt.query_map([project], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        let mut projects = vec![project.to_string(), GLOBAL.to_string()];
        for name in related {
            if !projects.contains(&name) {
                projects.push(name);
            }
        }
        Ok(projects)
    }

    fn projects_for(&self, scope: &Scope) -> Result<Vec<Option<String>>> {
        Ok(match scope {
            Scope::All => vec![None],
            Scope::Project(p) => self.scope_projects(p)?.into_iter().map(Some).collect(),
        })
    }

    pub fn groups(&self) -> Result<Vec<(String, Vec<String>)>> {
        let mut stmt = self.conn.prepare("SELECT name, project FROM project_groups ORDER BY name, project")?;
        let rows: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for (name, project) in rows {
            match groups.last_mut() {
                Some((last, members)) if *last == name => members.push(project),
                _ => groups.push((name, vec![project])),
            }
        }
        Ok(groups)
    }

    pub fn set_group(&self, name: &str, projects: &[String]) -> Result<()> {
        self.tx(|| {
            self.conn.execute("DELETE FROM project_groups WHERE name = ?1", [name])?;
            for project in projects {
                self.conn.execute("INSERT OR IGNORE INTO project_groups (name, project) VALUES (?1, ?2)", params![name, project])?;
            }
            Ok(())
        })
    }

    pub fn remove_group(&self, name: &str) -> Result<bool> {
        Ok(self.conn.execute("DELETE FROM project_groups WHERE name = ?1", [name])? > 0)
    }

    pub fn move_node(&self, emb: &dyn Embedder, id: &str, project: &str) -> Result<Node> {
        let node = self.require(id)?;
        let chunks = text::chunk(&node.title, &node.body);
        let vectors = emb.embed(&chunks, Mode::Passage)?;
        self.tx(|| {
            self.conn.execute("UPDATE nodes SET project = ?2 WHERE id = ?1", params![node.id, project])?;
            self.conn.execute("DELETE FROM edges WHERE kind = 'similar' AND (src = ?1 OR dst = ?1)", [&node.id])?;
            self.write_content(&node.id, project, &node.title, &node.body, &chunks, Some(&vectors))?;
            self.refresh_similar(&node.id, project, &vectors[0])
        })?;
        self.require(&node.id)
    }

    pub fn search(&self, emb: Option<&dyn Embedder>, query: &str, scope: &Scope, options: &SearchOptions) -> Result<Vec<Hit>> {
        let limit = options.limit.max(1);
        let pool = (limit * 8).max(40);
        let terms = text::terms(query);
        let today = text::today();

        let mut lexical: Vec<String> = Vec::new();
        if let Some(expr) = fts_query(query) {
            let (sql, scoped) = match scope {
                Scope::All => ("SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH ?1 ORDER BY bm25(fts_nodes, 0, 0, 3.0, 1.0) LIMIT ?2", None),
                Scope::Project(p) => (
                    "SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH ?1 AND project IN (SELECT value FROM json_each(?3)) ORDER BY bm25(fts_nodes, 0, 0, 3.0, 1.0) LIMIT ?2",
                    Some(serde_json::to_string(&self.scope_projects(p)?)?),
                ),
            };
            let mut stmt = self.conn.prepare_cached(sql)?;
            lexical = match scoped {
                Some(p) => stmt.query_map(params![expr, pool as i64, p], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?,
                None => stmt.query_map(params![expr, pool as i64], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?,
            };
        }

        let mut semantic: Vec<(String, f32, String)> = Vec::new();
        if let Some(emb) = emb
            && let Ok(vectors) = emb.embed(&[query.to_string()], Mode::Query)
            && let Some(vector) = vectors.first()
        {
            let mut best: HashMap<String, (f32, String)> = HashMap::new();
            for project in self.projects_for(scope)? {
                for (node_id, _, similarity, chunk) in self.knn(vector, project.as_deref(), pool)? {
                    let slot = best.entry(node_id).or_insert((similarity, chunk.clone()));
                    if similarity > slot.0 {
                        *slot = (similarity, chunk);
                    }
                }
            }
            semantic = best.into_iter().map(|(id, (s, c))| (id, s, c)).collect();
            semantic.sort_by(|a, b| b.1.total_cmp(&a.1));
        }

        let mut scores: HashMap<String, f64> = HashMap::new();
        for (rank, id) in lexical.iter().enumerate() {
            *scores.entry(id.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
        let mut sims: HashMap<String, (f32, String)> = HashMap::new();
        for (rank, (id, similarity, chunk)) in semantic.iter().enumerate() {
            *scores.entry(id.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
            sims.insert(id.clone(), (*similarity, chunk.clone()));
        }
        let mut ranked: Vec<(String, f64)> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));

        let mut hits = Vec::new();
        for (id, score) in ranked {
            let Some(node) = self.get(&id)? else { continue };
            if let Some(kind) = &options.kind
                && &node.kind != kind
            {
                continue;
            }
            if options.exclude_kinds.contains(&node.kind) {
                continue;
            }
            if node.until.as_deref().is_some_and(|u| u < today.as_str()) {
                continue;
            }
            let similarity = sims.get(&id).map(|(s, _)| *s);
            let source_text = sims.get(&id).map(|(_, c)| c.clone()).unwrap_or_else(|| node.body.clone());
            let folded_title = text::fold(node.title.trim());
            let snippet_text: String = source_text
                .strip_prefix(node.title.trim())
                .map(str::trim_start)
                .unwrap_or(&source_text)
                .lines()
                .skip_while(|l| {
                    let line = text::strip_markdown_line(l);
                    line.is_empty() || text::fold(&line) == folded_title
                })
                .collect::<Vec<_>>()
                .join("\n");
            hits.push(Hit {
                coverage: coverage(&terms, &format!("{} {}", node.title, node.body)),
                title_coverage: coverage(&terms, &node.title),
                snippet: text::snippet(&snippet_text, &terms, 200),
                id: node.id,
                title: node.title,
                kind: node.kind,
                project: node.project,
                score: (score * 10000.0).round() / 10000.0,
                similarity,
                body: node.body,
            });
            if hits.len() >= limit {
                break;
            }
        }
        Ok(hits)
    }

    pub fn active_rules(&self, project: &str) -> Result<Vec<Node>> {
        let sql = format!(
            "SELECT {NODE_COLUMNS} FROM nodes WHERE kind = 'rule' AND project IN (SELECT value FROM json_each(?3)) AND (until IS NULL OR until >= ?2)
             ORDER BY pinned DESC, (project = ?1) DESC, (project = 'global') ASC, updated_at DESC"
        );
        let scope = serde_json::to_string(&self.scope_projects(project)?)?;
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![project, text::today(), scope], row_node)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn rules(&self, project: Option<&str>, include_expired: bool) -> Result<Vec<Node>> {
        let today = text::today();
        let sql = format!("SELECT {NODE_COLUMNS} FROM nodes WHERE kind = 'rule' ORDER BY project, pinned DESC, updated_at DESC");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_node)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let scope = match project {
            Some(p) => Some(self.scope_projects(p)?),
            None => None,
        };
        Ok(rows
            .into_iter()
            .filter(|n| scope.as_ref().is_none_or(|s| s.contains(&n.project)))
            .filter(|n| include_expired || n.until.as_deref().is_none_or(|u| u >= today.as_str()))
            .collect())
    }

    pub fn graph(&self, project: Option<&str>) -> Result<Value> {
        let sql = "SELECT id, project, kind, title, pinned, updated_at FROM nodes WHERE (?1 IS NULL OR project = ?1) ORDER BY updated_at DESC";
        let mut stmt = self.conn.prepare(sql)?;
        let nodes: Vec<(String, String, String, String, bool, String)> = stmt
            .query_map([project], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0, r.get(5)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let ids: HashSet<&str> = nodes.iter().map(|n| n.0.as_str()).collect();
        let mut stmt = self.conn.prepare("SELECT src, dst, kind, weight FROM edges ORDER BY src, dst, kind")?;
        let edges: Vec<(String, String, String, f64)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, f64>(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|(s, d, _, _)| ids.contains(s.as_str()) && ids.contains(d.as_str()))
            .collect();
        let mut degree: HashMap<&str, usize> = HashMap::new();
        for (s, d, _, _) in &edges {
            *degree.entry(s.as_str()).or_default() += 1;
            *degree.entry(d.as_str()).or_default() += 1;
        }
        let nodes_json: Vec<Value> = nodes
            .iter()
            .map(|(id, project, kind, title, pinned, updated)| {
                json!({"id": id, "project": project, "kind": kind, "title": title, "degree": degree.get(id.as_str()).copied().unwrap_or(0), "pinned": pinned, "updatedAt": updated})
            })
            .collect();
        let edges_json: Vec<Value> = edges.iter().map(|(s, d, k, w)| json!({"src": s, "dst": d, "kind": k, "weight": w})).collect();
        Ok(json!({"nodes": nodes_json, "edges": edges_json}))
    }

    pub fn injected(&self, session_id: &str) -> Result<HashSet<String>> {
        let mut stmt = self.conn.prepare_cached("SELECT node_id FROM injections WHERE session_id = ?1")?;
        let rows = stmt.query_map([session_id], |r| r.get(0))?.collect::<rusqlite::Result<HashSet<String>>>()?;
        Ok(rows)
    }

    pub fn record_injection(&self, session_id: &str, hook: &str, ids: &[String], tokens: usize, ms: u128) -> Result<()> {
        let now = text::now_iso();
        for id in ids {
            self.conn.execute("INSERT OR IGNORE INTO injections (session_id, node_id, at) VALUES (?1, ?2, ?3)", params![session_id, id, now])?;
        }
        self.conn.execute(
            "INSERT INTO stats (session_id, hook, tokens, nodes, ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, hook, tokens as i64, ids.len() as i64, ms as i64, now],
        )?;
        self.bump_hits(ids)
    }

    pub fn stats(&self) -> Result<Value> {
        let count = |sql: &str| -> Result<i64> { Ok(self.conn.query_row(sql, [], |r| r.get(0))?) };
        let mut by_kind = serde_json::Map::new();
        let mut stmt = self.conn.prepare("SELECT kind, COUNT(*) FROM nodes GROUP BY kind ORDER BY kind")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (k, n) = row?;
            by_kind.insert(k, json!(n));
        }
        let mut by_project = serde_json::Map::new();
        let mut stmt = self.conn.prepare("SELECT project, COUNT(*) FROM nodes GROUP BY project ORDER BY COUNT(*) DESC")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (p, n) = row?;
            by_project.insert(p, json!(n));
        }
        let mut hooks = serde_json::Map::new();
        let mut stmt = self.conn.prepare(
            "SELECT hook, COUNT(*), COALESCE(SUM(tokens),0), COALESCE(AVG(tokens),0), COALESCE(MAX(tokens),0), COALESCE(AVG(ms),0), COUNT(DISTINCT session_id) FROM stats GROUP BY hook",
        )?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, f64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })? {
            let (hook, runs, total, avg, max, ms, sessions) = row?;
            hooks.insert(hook, json!({"runs": runs, "sessions": sessions, "tokens": total, "avgTokens": avg.round(), "maxTokens": max, "avgMs": ms.round()}));
        }
        let sessions = count("SELECT COUNT(DISTINCT session_id) FROM stats")?;
        let injected = count("SELECT COALESCE(SUM(tokens),0) FROM stats")?;
        Ok(json!({
            "nodes": count("SELECT COUNT(*) FROM nodes")?,
            "edges": count("SELECT COUNT(*) FROM edges")?,
            "chunks": count("SELECT COUNT(*) FROM chunks")?,
            "unembedded": count("SELECT COUNT(*) FROM nodes WHERE embedded = 0")?,
            "byKind": by_kind,
            "byProject": by_project,
            "injection": {
                "sessions": sessions,
                "tokens": injected,
                "avgTokensPerSession": if sessions > 0 { (injected as f64 / sessions as f64).round() } else { 0.0 },
                "hooks": hooks,
            },
        }))
    }

    pub fn known_project(&self, slug: &str) -> Result<bool> {
        let in_nodes: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM nodes WHERE project = ?1)", [slug], |r| r.get(0))?;
        let in_projects: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE slug = ?1)", [slug], |r| r.get(0))?;
        Ok(in_nodes || in_projects || slug == GLOBAL)
    }
}

pub fn ensure_found(found: bool, what: &str) -> Result<()> {
    if found { Ok(()) } else { Err(anyhow!(GazeError::new("NOT_FOUND", format!("No existe: {what}")))) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;

    fn note(project: &str, kind: &str, title: &str, body: &str) -> NewNode {
        NewNode { project: project.into(), kind: kind.into(), title: Some(title.into()), body: body.into(), source: "user".into(), ..Default::default() }
    }

    #[test]
    fn remember_and_search_hybrid() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        store.remember(&e, note("den", "fact", "Base de datos", "La base de datos de den usa sqlite con WAL"), true).unwrap();
        store.remember(&e, note("den", "decision", "Despliegue", "Desplegamos con GitHub Actions a producción"), true).unwrap();
        store.remember(&e, note("otro", "fact", "Otra base", "La base de datos de otro usa postgres"), true).unwrap();
        let hits = store.search(Some(&e), "qué base de datos usa", &Scope::Project("den".into()), &SearchOptions { limit: 5, ..Default::default() }).unwrap();
        assert_eq!(hits[0].title, "Base de datos");
        assert!(hits.iter().all(|h| h.project != "otro"));
        assert!(hits[0].snippet.chars().count() <= 200);
        let all = store.search(Some(&e), "base de datos postgres", &Scope::All, &SearchOptions { limit: 5, ..Default::default() }).unwrap();
        assert!(all.iter().any(|h| h.project == "otro"));
        let lexical_only = store.search(None, "sqlite", &Scope::Project("den".into()), &SearchOptions { limit: 5, ..Default::default() }).unwrap();
        assert_eq!(lexical_only.len(), 1);
    }

    #[test]
    fn groups_share_rules_and_search_across_their_projects() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let rule = store.remember(&e, note("dportenis", "rule", "Commits", "En DP los commits llevan la clave de Jira al inicio"), true).unwrap();
        store.remember(&e, note("dpsuites", "fact", "Pipeline", "El pipeline de dpsuites corre en GitHub Actions"), true).unwrap();
        store.remember(&e, note("apartados", "rule", "VM", "No mencionar la VM en apartados"), true).unwrap();
        assert!(store.active_rules("dpsuites").unwrap().is_empty());

        store.set_group("dp", &["dportenis".into(), "dpsuites".into()]).unwrap();
        let rules = store.active_rules("dpsuites").unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].project, "dportenis");
        let hits = store.search(None, "pipeline", &Scope::Project("dportenis".into()), &SearchOptions { limit: 5, ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);

        let moved = store.move_node(&e, &rule.id, "dp").unwrap();
        assert_eq!(moved.project, "dp");
        assert_eq!(store.active_rules("dportenis").unwrap()[0].project, "dp");
        assert!(store.active_rules("apartados").unwrap().iter().all(|r| r.project != "dp"));
        assert_eq!(store.rules(Some("dpsuites"), false).unwrap().len(), 1);
        assert!(store.remove_group("dp").unwrap());
        assert!(store.active_rules("dpsuites").unwrap().is_empty());
    }

    #[test]
    fn dedupe_merges_near_duplicates() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let first = store.remember(&e, note("den", "fact", "Puerto", "El servidor de den escucha en el puerto 8080 local"), true).unwrap();
        let second =
            store.remember(&e, NewNode { title: None, ..note("den", "fact", "", "El servidor de den escucha en el puerto 8080 local") }, true).unwrap();
        assert_eq!(second.action, "merged");
        assert_eq!(second.id, first.id);
        let third = store.remember(&e, note("den", "fact", "Otra cosa", "Las facturas se mandan los viernes al cliente"), true).unwrap();
        assert_eq!(third.action, "created");
        let other_project = store.remember(&e, note("x", "fact", "Puerto", "El servidor de den escucha en el puerto 8080 local"), true).unwrap();
        assert_eq!(other_project.action, "created");
    }

    #[test]
    fn merge_keeps_both_facts_unless_nearly_identical() {
        let mut store = Store::in_memory().unwrap();
        store.cfg.search.dedupe_threshold = 0.9;
        let e = FakeEmbedder;
        let first = store.remember(&e, note("den", "fact", "Puerto", "El servidor de den escucha en el puerto 8080 local"), true).unwrap();
        let second = store.remember(&e, note("den", "fact", "Puerto", "El servidor den escucha siempre en puerto 8080 local"), true).unwrap();
        assert_eq!((second.action, second.id.as_str()), ("merged", first.id.as_str()));
        let body = store.require(&first.id).unwrap().body;
        assert!(body.starts_with("El servidor den escucha siempre en puerto 8080 local"));
        assert!(body.ends_with("El servidor de den escucha en el puerto 8080 local"));
    }

    #[test]
    fn wikilinks_become_edges_even_when_target_arrives_later() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let a = store.remember(&e, note("den", "fact", "Auth", "Usa tokens, ver [[Sesiones]] y [[Global rule]]"), false).unwrap();
        let g = store.remember(&e, note(GLOBAL, "rule", "Global rule", "Siempre en inglés"), false).unwrap();
        let b = store.remember(&e, note("den", "fact", "Sesiones", "Duran 8 horas"), false).unwrap();
        let neighbors = store.neighbors(&a.id).unwrap();
        assert!(neighbors.iter().any(|n| n.id == b.id && n.edge_kind == "link"));
        assert!(neighbors.iter().any(|n| n.id == g.id && n.edge_kind == "link"));
    }

    #[test]
    fn source_ref_upserts_and_issue_edges() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let mut doc = note("dp", "doc", "Infra", "Cuenta AWS, ver DD-1905");
        doc.source = "inkwell".into();
        doc.source_ref = Some("inkwell:dp/infra.md".into());
        let first = store.remember(&e, doc.clone(), true).unwrap();
        assert_eq!(store.remember(&e, doc.clone(), true).unwrap().action, "unchanged");
        doc.body = "Cuenta AWS actualizada, ver DD-1905".into();
        let updated = store.remember(&e, doc, true).unwrap();
        assert_eq!((updated.action, updated.id.as_str()), ("updated", first.id.as_str()));
        let entry = store.remember(&e, note("dp", "entry", "Trabajo", "Arreglé DD-1905"), false).unwrap();
        assert!(store.neighbors(&entry.id).unwrap().iter().any(|n| n.id == first.id && n.edge_kind == "same-issue"));
    }

    #[test]
    fn rename_source_ref_keeps_the_id_and_claims_links_to_the_new_name() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let mut doc = note("dp", "doc", "Infra", "Cuenta AWS");
        doc.source = "inkwell".into();
        doc.source_ref = Some("inkwell:dp/infra.md".into());
        let moved = store.remember(&e, doc, false).unwrap();
        store.conn.execute("INSERT INTO ingest_files (path, mtime, node_id) VALUES ('inkwell:dp/infra.md', 1, ?1)", [&moved.id]).unwrap();
        let waiting = store.remember(&e, note("dp", "fact", "Pendiente", "Ver [[ops-guide]]"), false).unwrap();
        assert!(store.neighbors(&moved.id).unwrap().is_empty());
        let renamed = store.rename_source_ref("inkwell:dp/infra.md", "inkwell:dp/ops-guide.md").unwrap().unwrap();
        assert_eq!(renamed, Renamed { id: moved.id.clone(), displaced: None });
        assert_eq!(store.by_source_ref("inkwell:dp/ops-guide.md").unwrap().unwrap().id, moved.id);
        assert!(store.neighbors(&moved.id).unwrap().iter().any(|n| n.id == waiting.id && n.edge_kind == "link"));
        let path: String = store.conn.query_row("SELECT path FROM ingest_files WHERE node_id = ?1", [&moved.id], |r| r.get(0)).unwrap();
        assert_eq!(path, "inkwell:dp/ops-guide.md");
        assert!(store.rename_source_ref("inkwell:dp/missing.md", "inkwell:dp/other.md").unwrap().is_none());
    }

    #[test]
    fn graph_contract_shape() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let a = store.remember(&e, note("den", "fact", "A", "uno [[B]]"), false).unwrap();
        store.remember(&e, note("den", "fact", "B", "dos"), false).unwrap();
        store.remember(&e, note("x", "fact", "C", "tres"), false).unwrap();
        let graph = store.graph(Some("den")).unwrap();
        let nodes = graph["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
        for n in nodes {
            let keys: Vec<&String> = n.as_object().unwrap().keys().collect();
            assert_eq!(keys.len(), 7);
            for k in ["id", "project", "kind", "title", "degree", "pinned", "updatedAt"] {
                assert!(n.get(k).is_some(), "missing {k}");
            }
        }
        let edges = graph["edges"].as_array().unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0]["src"], json!(a.id));
        for k in ["src", "dst", "kind", "weight"] {
            assert!(edges[0].get(k).is_some());
        }
        assert_eq!(edges[0].as_object().unwrap().len(), 4);
    }

    #[test]
    fn forget_removes_everything() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let a = store.remember(&e, note("den", "fact", "A", "uno [[B]]"), false).unwrap();
        let b = store.remember(&e, note("den", "fact", "B", "dos"), false).unwrap();
        store.forget(&a.id).unwrap();
        assert!(store.get(&a.id).unwrap().is_none());
        assert!(store.neighbors(&b.id).unwrap().is_empty());
        let chunks: i64 = store.conn.query_row("SELECT COUNT(*) FROM chunks WHERE node_id = ?1", [&a.id], |r| r.get(0)).unwrap();
        assert_eq!(chunks, 0);
    }

    #[test]
    fn rules_order_and_expiry() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        store.remember(&e, note(GLOBAL, "rule", "g", "Regla global"), false).unwrap();
        store.remember(&e, NewNode { pinned: true, ..note(GLOBAL, "rule", "p", "Regla fijada") }, false).unwrap();
        store.remember(&e, note("den", "rule", "d", "Regla de den"), false).unwrap();
        store.remember(&e, NewNode { until: Some("2000-01-01".into()), ..note("den", "rule", "old", "Vencida") }, false).unwrap();
        store.remember(&e, note("x", "rule", "x", "Regla de x"), false).unwrap();
        let rules = store.active_rules("den").unwrap();
        let titles: Vec<&str> = rules.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["p", "d", "g"]);
    }
}
