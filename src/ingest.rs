use anyhow::Result;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use crate::embed::Embedder;
use crate::paths;
use crate::project;
use crate::store::{GLOBAL, NewNode, Store};
use crate::text;

pub fn frontmatter(raw: &str) -> (BTreeMap<String, String>, String) {
    let mut map = BTreeMap::new();
    let normalized = raw.trim_start_matches('\u{feff}');
    let Some(rest) = normalized.strip_prefix("---\n").or_else(|| normalized.strip_prefix("---\r\n")) else {
        return (map, normalized.to_string());
    };
    let Some(end) = rest.find("\n---") else { return (map, normalized.to_string()) };
    for line in rest[..end].lines() {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once(':') {
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            if !value.is_empty() {
                map.entry(key.trim().to_string()).or_insert(value);
            }
        }
    }
    let body_start = end + 4;
    let body = rest[body_start..].trim_start_matches(['-']).trim_start_matches(['\r', '\n']).to_string();
    (map, body)
}

pub fn mtime(path: &Path) -> i64 {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn unchanged(store: &Store, key: &str, mtime: i64) -> bool {
    store.conn.query_row("SELECT mtime FROM ingest_files WHERE path = ?1", [key], |r| r.get::<_, i64>(0)).map(|m| m == mtime).unwrap_or(false)
        && store.by_source_ref(key).ok().flatten().is_some()
}

fn mark(store: &Store, key: &str, mtime: i64, node_id: Option<&str>) -> Result<()> {
    store.conn.execute(
        "INSERT INTO ingest_files (path, mtime, node_id) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, node_id = excluded.node_id",
        rusqlite::params![key, mtime, node_id],
    )?;
    Ok(())
}

fn walk_md(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.ends_with(".assets") {
            continue;
        }
        if path.is_dir() {
            walk_md(&path, out);
        } else if name.ends_with(".md") {
            out.push(path);
        }
    }
}

fn strip_empty_sections(body: &str) -> String {
    let meaningful = body.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with('#')
    });
    if meaningful { body.trim().to_string() } else { String::new() }
}

fn split_list(value: &str) -> Vec<String> {
    value.trim_matches(['[', ']']).split([',', ' ']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

#[derive(Debug, Default, serde::Serialize)]
pub struct IngestReport {
    pub source: String,
    pub scanned: usize,
    pub created: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub failed: usize,
}

impl IngestReport {
    fn count(&mut self, action: &str) {
        match action {
            "created" => self.created += 1,
            "updated" | "merged" => self.updated += 1,
            _ => self.unchanged += 1,
        }
    }
}

fn inkwell_spaces() -> &'static HashMap<String, i64> {
    static SPACES: OnceLock<HashMap<String, i64>> = OnceLock::new();
    SPACES.get_or_init(|| read_inkwell_spaces(&paths::inkwell_db()).unwrap_or_default())
}

pub fn read_inkwell_spaces(db: &Path) -> Option<HashMap<String, i64>> {
    let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut stmt = conn.prepare("SELECT name, external_ref FROM spaces WHERE external_ref LIKE 'bita:project:%'").ok()?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).ok()?;
    Some(
        rows.flatten()
            .filter_map(|(name, reference)| reference.strip_prefix("bita:project:")?.parse::<i64>().ok().map(|id| (text::slugify(&name), id)))
            .collect(),
    )
}

pub fn folder_project(store: &Store, spaces: &HashMap<String, i64>, folder: &str) -> String {
    spaces
        .get(folder)
        .and_then(|id| project::project_for_bita_id(store, *id))
        .unwrap_or_else(|| project::project_for_name(store, folder))
}

pub fn inkwell_note(store: &Store, emb: &dyn Embedder, root: &Path, path: &Path) -> Result<Option<(String, &'static str)>> {
    let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
    let key = format!("inkwell:{rel}");
    let raw = std::fs::read_to_string(path)?;
    let (meta, body) = frontmatter(&raw);
    let folder = rel.split('/').next().unwrap_or(GLOBAL);
    let project = folder_project(store, inkwell_spaces(), folder);
    let title = meta.get("title").cloned().unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
    let mut attrs: Vec<(String, String)> = Vec::new();
    let (kind, body) = if let Some(entry) = meta.get("entryId") {
        attrs.push(("entry".into(), entry.clone()));
        let header = [
            Some(format!("Entrada de bita #{entry}")),
            meta.get("day").cloned(),
            meta.get("duration").cloned(),
            meta.get("repo").cloned(),
            meta.get("branch").cloned(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        let content = strip_empty_sections(&body);
        ("entry", if content.is_empty() { header } else { format!("{header}\n\n{content}") })
    } else {
        let content = body.trim().to_string();
        ("doc", if content.is_empty() { title.clone() } else { content })
    };
    for field in ["issues", "jira"] {
        if let Some(value) = meta.get(field) {
            for key in split_list(value) {
                attrs.push(("issue".into(), key));
            }
        }
    }
    let outcome = store.remember(
        emb,
        NewNode { project, kind: kind.into(), title: Some(title), body, source: "inkwell".into(), source_ref: Some(key.clone()), attrs, ..Default::default() },
        false,
    )?;
    mark(store, &key, mtime(path), Some(&outcome.id))?;
    Ok(Some((outcome.id, outcome.action)))
}

pub fn ingest_inkwell(store: &Store, emb: &dyn Embedder, root: &Path, progress: bool) -> Result<IngestReport> {
    let mut report = IngestReport { source: "inkwell".into(), ..Default::default() };
    let mut files = Vec::new();
    walk_md(root, &mut files);
    files.sort();
    let mut present = HashSet::new();
    for (index, path) in files.iter().enumerate() {
        let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
        let key = format!("inkwell:{rel}");
        present.insert(key.clone());
        report.scanned += 1;
        if unchanged(store, &key, mtime(path)) {
            report.unchanged += 1;
            continue;
        }
        match inkwell_note(store, emb, root, path) {
            Ok(Some((_, action))) => report.count(action),
            Ok(None) => {}
            Err(error) => {
                report.failed += 1;
                eprintln!("inkwell {rel}: {error:#}");
            }
        }
        if progress && (index + 1) % 100 == 0 {
            eprintln!("inkwell: {}/{}", index + 1, files.len());
        }
    }
    report.removed = remove_missing(store, "inkwell:", &present)?;
    Ok(report)
}

fn remove_missing(store: &Store, prefix: &str, present: &HashSet<String>) -> Result<usize> {
    let refs: Vec<(String, String)> = {
        let mut stmt = store.conn.prepare("SELECT id, source_ref FROM nodes WHERE source_ref LIKE ?1 || '%'")?;
        stmt.query_map([prefix], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
    };
    let mut removed = 0;
    for (id, source_ref) in refs {
        if !present.contains(&source_ref) {
            store.forget(&id)?;
            store.conn.execute("DELETE FROM ingest_files WHERE path = ?1", [&source_ref])?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn run_json(program: &str, args: &[&str]) -> Option<Value> {
    let output = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).filter(|v| v["ok"] == json!(true))
}

pub fn ingest_recap(store: &Store, emb: &dyn Embedder) -> Result<IngestReport> {
    let mut report = IngestReport { source: "recap".into(), ..Default::default() };
    let recap = std::env::var("GAZE_RECAP_BIN").unwrap_or_else(|_| "recap".into());
    let Some(list) = run_json(&recap, &["list", "--limit", "10000", "--json"]) else { return Ok(report) };
    for meeting in list["data"].as_array().cloned().unwrap_or_default() {
        let Some(id) = meeting["id"].as_str() else { continue };
        if meeting["status"].as_str() != Some("processed") {
            continue;
        }
        report.scanned += 1;
        let key = format!("recap:{id}");
        let summary_path = meeting["summary"]
            .as_str()
            .map(PathBuf::from)
            .or_else(|| run_json(&recap, &["show", id, "--json"]).and_then(|v| v["data"]["summary"].as_str().map(PathBuf::from)));
        let Some(summary_path) = summary_path.filter(|p| p.exists()) else { continue };
        let modified = mtime(&summary_path);
        if unchanged(store, &key, modified) {
            report.unchanged += 1;
            continue;
        }
        let raw = std::fs::read_to_string(&summary_path)?;
        let (_, body) = frontmatter(&raw);
        let project_name = meeting["bitaEntry"]["projectName"].as_str().unwrap_or(GLOBAL);
        let mut attrs = Vec::new();
        if let Some(entry) = meeting["bitaEntryId"].as_i64() {
            attrs.push(("entry".to_string(), entry.to_string()));
        }
        let day = meeting["startedAt"].as_str().unwrap_or_default().get(..10).unwrap_or_default().to_string();
        let title = format!("{} ({day})", meeting["title"].as_str().unwrap_or(id));
        match store.remember(
            emb,
            NewNode {
                project: project::project_for_name(store, project_name),
                kind: "meeting".into(),
                title: Some(title),
                body,
                source: "recap".into(),
                source_ref: Some(key.clone()),
                attrs,
                ..Default::default()
            },
            false,
        ) {
            Ok(outcome) => {
                mark(store, &key, modified, Some(&outcome.id))?;
                report.count(outcome.action);
            }
            Err(error) => {
                report.failed += 1;
                eprintln!("recap {id}: {error:#}");
            }
        }
    }
    Ok(report)
}

fn touched_files(database: &str, entry: i64) -> Vec<String> {
    let Ok(conn) = rusqlite::Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare("SELECT path FROM entry_touches WHERE entry_id = ?1 ORDER BY first_seen_at, path LIMIT 40") else { return Vec::new() };
    stmt.query_map([entry], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

pub fn bita_event(store: &Store, emb: &dyn Embedder, event: &Value) -> Result<Value> {
    let name = event["event"].as_str().unwrap_or_default();
    let entry = &event["entry"];
    let Some(id) = entry["id"].as_i64() else { return Ok(json!({"skipped": "no entry"})) };
    let key = format!("bita:entry:{id}");
    if name == "delete" || name == "cancel" {
        let removed = match store.by_source_ref(&key)? {
            Some(node) => {
                store.forget(&node.id)?;
                true
            }
            None => false,
        };
        return Ok(json!({"event": name, "entry": id, "removed": removed}));
    }
    if !(name == "stop" || name == "amend") || entry["running"] == json!(true) {
        return Ok(json!({"event": name, "entry": id, "skipped": true}));
    }
    let project = entry["projectId"]
        .as_i64()
        .and_then(|pid| project::project_for_bita_id(store, pid))
        .or_else(|| entry["projectName"].as_str().map(|n| project::project_for_name(store, n)))
        .unwrap_or_else(|| GLOBAL.into());
    let title = entry["description"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("Entrada sin título").to_string();
    let mut lines = vec![
        [
            Some(format!("Entrada de bita #{id}")),
            entry["localDay"].as_str().map(str::to_string),
            entry["durationHuman"].as_str().map(str::to_string),
            entry["kind"].as_str().map(str::to_string),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · "),
    ];
    if let Some(database) = event["databasePath"].as_str() {
        let files = touched_files(database, id);
        if !files.is_empty() {
            lines.push(format!("Archivos tocados:\n{}", files.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n")));
        }
    }
    let outcome = store.remember(
        emb,
        NewNode {
            project,
            kind: "entry".into(),
            title: Some(title),
            body: lines.join("\n\n"),
            source: "bita".into(),
            source_ref: Some(key),
            attrs: vec![("entry".into(), id.to_string())],
            ..Default::default()
        },
        false,
    )?;
    let mut note = Value::Null;
    if let Some(doc) = event["docPath"].as_str() {
        let root = event["docsRoot"].as_str().map(PathBuf::from).unwrap_or_else(paths::inkwell_docs);
        let path = if Path::new(doc).is_absolute() { PathBuf::from(doc) } else { root.join(doc) };
        if path.exists()
            && let Ok(Some((note_id, action))) = inkwell_note(store, emb, &root, &path)
        {
            note = json!({"id": note_id, "action": action});
        }
    }
    Ok(json!({"event": name, "entry": id, "node": outcome, "note": note}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;

    #[test]
    fn inkwell_folders_follow_the_bita_project_of_their_space() {
        let store = Store::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("inkwell.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE spaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, external_ref TEXT);
             INSERT INTO spaces VALUES (1, 'Global', 'bita:project:218978619'), (2, 'Notas sueltas', NULL);",
        )
        .unwrap();
        store.conn.execute("INSERT INTO projects (slug, bita_id, name) VALUES ('vivaglobal', 218978619, 'VivaGlobal')", []).unwrap();
        let spaces = read_inkwell_spaces(&db).unwrap();
        assert_eq!(folder_project(&store, &spaces, "global"), "vivaglobal");
        assert_eq!(folder_project(&store, &spaces, "notas-sueltas"), "notas-sueltas");
        assert_eq!(folder_project(&store, &spaces, "_no-project"), GLOBAL);
    }

    #[test]
    fn frontmatter_parses_nested_and_body() {
        let raw = "---\nname: x-note\nmetadata: \n  type: feedback\n  modified: 2026\n---\n\nCuerpo [[otra]]\n";
        let (meta, body) = frontmatter(raw);
        assert_eq!(meta.get("name").unwrap(), "x-note");
        assert_eq!(meta.get("type").unwrap(), "feedback");
        assert_eq!(body.trim(), "Cuerpo [[otra]]");
        let (empty, plain) = frontmatter("sin frontmatter");
        assert!(empty.is_empty());
        assert_eq!(plain, "sin frontmatter");
    }

    #[test]
    fn inkwell_ingest_builds_entry_and_issue_edges() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("dp-personalization/2026/10")).unwrap();
        std::fs::write(
            root.join("dp-personalization/infra.md"),
            "---\nbita: 1\npageId: 27\ntitle: Infraestructura\nissues: DD-1905\n---\n\n# Infraestructura\n\nCuenta AWS de producción.\n",
        )
        .unwrap();
        std::fs::write(
            root.join("dp-personalization/2026/10/16-914-tc.md"),
            "---\nbita: 1\nentryId: 914\ntitle: TC 07\nproject: DP\nday: 2026-10-16\nduration: 1h\njira: DD-1905\n---\n\n# TC 07\n\n## Contexto\n\n## Qué se hizo\n",
        )
        .unwrap();
        let report = ingest_inkwell(&store, &e, root, false).unwrap();
        assert_eq!((report.scanned, report.created), (2, 2));
        let again = ingest_inkwell(&store, &e, root, false).unwrap();
        assert_eq!(again.unchanged, 2);
        let entry = store.by_source_ref("inkwell:dp-personalization/2026/10/16-914-tc.md").unwrap().unwrap();
        assert_eq!(entry.kind, "entry");
        assert_eq!(entry.project, "dp-personalization");
        let page = store.by_source_ref("inkwell:dp-personalization/infra.md").unwrap().unwrap();
        assert!(store.neighbors(&entry.id).unwrap().iter().any(|n| n.id == page.id && n.edge_kind == "same-issue"));
        let event = json!({"event": "stop", "entry": {"id": 914, "description": "TC 07", "projectName": "DP Personalization", "localDay": "2026-10-16", "durationHuman": "1h"}, "docPath": "dp-personalization/2026/10/16-914-tc.md", "docsRoot": root});
        let result = bita_event(&store, &e, &event).unwrap();
        let bita_node = result["node"]["id"].as_str().unwrap().to_string();
        assert!(store.neighbors(&bita_node).unwrap().iter().any(|n| n.id == entry.id && n.edge_kind == "same-entry"));
        std::fs::remove_file(root.join("dp-personalization/infra.md")).unwrap();
        assert_eq!(ingest_inkwell(&store, &e, root, false).unwrap().removed, 1);
        let deleted = bita_event(&store, &e, &json!({"event": "delete", "entry": {"id": 914}})).unwrap();
        assert_eq!(deleted["removed"], true);
    }
}
