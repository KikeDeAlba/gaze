use anyhow::Result;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use crate::embed::Embedder;
use crate::paths;
use crate::project;
use crate::store::{GLOBAL, NewNode, Renamed, Store};
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

fn known_project(store: &Store, slug: &str) -> bool {
    slug == GLOBAL
        || store
            .conn
            .query_row("SELECT 1 FROM projects WHERE slug = ?1 UNION ALL SELECT 1 FROM project_groups WHERE name = ?1 LIMIT 1", [slug], |_| Ok(()))
            .is_ok()
}

fn prefix_project(store: &Store, folder: &str) -> Option<String> {
    let target = project::name_tokens(folder);
    let mut stmt = store.conn.prepare("SELECT slug, COALESCE(name, slug) FROM projects WHERE slug != ?1").ok()?;
    let rows: Vec<(String, String)> = stmt.query_map([GLOBAL], |r| Ok((r.get(0)?, r.get(1)?))).ok()?.flatten().collect();
    let matches: Vec<(usize, String)> = rows
        .into_iter()
        .filter_map(|(slug, name)| {
            let tokens = project::name_tokens(&name);
            let length = project::normalize_name(&name).chars().count();
            (length >= 4 && !tokens.is_empty() && target.starts_with(&tokens)).then_some((length, slug))
        })
        .collect();
    let longest = matches.iter().map(|(length, _)| *length).max()?;
    let mut best: Vec<&String> = matches.iter().filter(|(length, _)| *length == longest).map(|(_, slug)| slug).collect();
    best.sort();
    best.dedup();
    match best.as_slice() {
        [slug] => Some((*slug).clone()),
        _ => None,
    }
}

pub fn folder_project(store: &Store, spaces: &HashMap<String, i64>, folder: &str) -> String {
    if let Some(slug) = spaces.get(folder).and_then(|id| project::project_for_bita_id(store, *id)) {
        return slug;
    }
    let named = project::project_for_name(store, folder);
    if known_project(store, &named) {
        return named;
    }
    prefix_project(store, folder).unwrap_or_else(|| GLOBAL.into())
}

fn frontmatter_project(store: &Store, meta: &BTreeMap<String, String>) -> Option<String> {
    meta.get("projectId")
        .and_then(|id| id.parse::<i64>().ok())
        .and_then(|id| project::project_for_bita_id(store, id))
        .or_else(|| meta.get("project").map(|name| project::project_for_name(store, name)).filter(|slug| slug != GLOBAL && known_project(store, slug)))
}

pub fn inkwell_note(store: &Store, emb: &dyn Embedder, root: &Path, path: &Path) -> Result<Option<(String, &'static str)>> {
    let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
    let key = format!("inkwell:{rel}");
    let modified = mtime(path);
    let raw = std::fs::read_to_string(path)?;
    let (meta, body) = frontmatter(&raw);
    let folder = rel.split('/').next().unwrap_or(GLOBAL);
    let project = match folder_project(store, inkwell_spaces(), folder) {
        slug if slug == GLOBAL => frontmatter_project(store, &meta).unwrap_or(slug),
        slug => slug,
    };
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
    mark(store, &key, modified, Some(&outcome.id))?;
    Ok(Some((outcome.id, outcome.action)))
}

pub fn ingest_inkwell(store: &Store, emb: &dyn Embedder, root: &Path, progress: bool, bita: &str) -> Result<IngestReport> {
    let _ = project::refresh_projects_with(store, root, bita);
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

pub fn bita_event(store: &Store, emb: &dyn Embedder, event: &Value, bita: &str) -> Result<Value> {
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
    if let Some(pid) = entry["projectId"].as_i64()
        && project::project_for_bita_id(store, pid).is_none()
    {
        let _ = project::refresh_projects_with(store, Path::new("/"), bita);
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

fn inkwell_rel(raw: &str) -> Option<String> {
    let path = Path::new(raw);
    if raw.is_empty() || path.is_absolute() || !raw.ends_with(".md") {
        return None;
    }
    let mut parts = Vec::new();
    for component in path.components() {
        let part = match component {
            std::path::Component::CurDir => continue,
            std::path::Component::Normal(part) => part,
            _ => return None,
        };
        let part = part.to_str()?;
        if part.starts_with('.') || part.ends_with(".assets") {
            return None;
        }
        parts.push(part);
    }
    Some(parts.join("/"))
}

fn forget_inkwell(store: &Store, rel: &str) -> Result<bool> {
    let key = format!("inkwell:{rel}");
    store.conn.execute("DELETE FROM ingest_files WHERE path = ?1", [&key])?;
    match store.by_source_ref(&key)? {
        Some(node) => {
            store.forget(&node.id)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

struct DocsBatch<'a> {
    store: &'a Store,
    emb: &'a dyn Embedder,
    root: PathBuf,
    bita: &'a str,
    refreshed: bool,
}

impl DocsBatch<'_> {
    fn refresh_projects_for(&mut self, rel: &str) {
        if self.refreshed {
            return;
        }
        let folder = rel.split('/').next().unwrap_or(GLOBAL);
        if folder != "_no-project" && folder_project(self.store, inkwell_spaces(), folder) == GLOBAL {
            self.refreshed = true;
            let _ = project::refresh_projects_with(self.store, Path::new("/"), self.bita);
        }
    }

    fn write(&mut self, rel: &str) -> Result<Value> {
        let path = self.root.join(rel);
        if !path.is_file() {
            let removed = forget_inkwell(self.store, rel)?;
            return Ok(json!({"result": if removed { "removed" } else { "absent" }}));
        }
        self.refresh_projects_for(rel);
        match inkwell_note(self.store, self.emb, &self.root, &path)? {
            Some((id, action)) => Ok(json!({"result": action, "id": id})),
            None => Ok(json!({"result": "skipped"})),
        }
    }

    fn change(&mut self, change: &Value) -> Result<Value> {
        let action = change["action"].as_str().unwrap_or_default();
        let rel = change["relPath"].as_str().and_then(inkwell_rel);
        let from = change["from"].as_str().and_then(inkwell_rel);
        match (action, rel) {
            ("written", Some(rel)) => self.write(&rel),
            ("deleted", Some(rel)) => Ok(json!({"result": if forget_inkwell(self.store, &rel)? { "removed" } else { "absent" }})),
            ("moved", Some(rel)) => {
                let renamed = match &from {
                    Some(from) if *from != rel => self.store.rename_source_ref(&format!("inkwell:{from}"), &format!("inkwell:{rel}"))?,
                    _ => None,
                };
                let mut written = self.write(&rel)?;
                written["renamed"] = json!(renamed.is_some());
                if let Some(Renamed { displaced: Some(displaced), .. }) = renamed {
                    written["displaced"] = json!(displaced);
                }
                Ok(written)
            }
            ("moved", None) => {
                let removed = match &from {
                    Some(from) => forget_inkwell(self.store, from)?,
                    None => false,
                };
                Ok(json!({"result": if removed { "removed" } else { "ignored" }, "fromRemoved": removed}))
            }
            _ => Ok(json!({"result": "ignored"})),
        }
    }
}

fn canonical_or_raw(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn inkwell_event(store: &Store, emb: &dyn Embedder, event: &Value, docs: &Path, bita: &str) -> Result<Value> {
    let name = event["event"].as_str().unwrap_or("docs.changed");
    if name != "docs.changed" {
        return Ok(json!({"event": name, "skipped": true}));
    }
    let root = event["docsRoot"].as_str().map(PathBuf::from).filter(|root| root.is_absolute()).unwrap_or_else(|| docs.to_path_buf());
    let root_mismatch = canonical_or_raw(&root) != canonical_or_raw(docs);
    let mut batch = DocsBatch { store, emb, root, bita, refreshed: false };
    let mut failed = 0;
    let results: Vec<Value> = event["changes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|change| {
            let mut summary = json!({"action": change["action"], "relPath": change["relPath"]});
            if !change["from"].is_null() {
                summary["from"] = change["from"].clone();
            }
            match batch.change(change) {
                Ok(Value::Object(fields)) => {
                    for (key, value) in fields {
                        summary[key] = value;
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    failed += 1;
                    summary["result"] = json!("error");
                    summary["error"] = json!(format!("{error:#}"));
                }
            }
            summary
        })
        .collect();
    Ok(json!({
        "event": name,
        "docsRoot": batch.root,
        "rootMismatch": root_mismatch,
        "commit": event["commit"],
        "failed": failed,
        "changes": results,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;

    fn docs_changed(store: &Store, emb: &dyn Embedder, event: &Value) -> Result<Value> {
        inkwell_event(store, emb, event, Path::new("/nonexistent/docs"), "/nonexistent/bita")
    }

    fn docs_event(root: &Path, changes: Value) -> Value {
        json!({"docsRoot": root, "commit": null, "kind": "page", "changes": changes, "event": "docs.changed", "source": "inkwell", "firedAt": "2026-10-18T00:00:00Z"})
    }

    #[test]
    fn inkwell_docs_events_write_delete_and_move_notes() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("dp")).unwrap();
        std::fs::write(root.join("dp/infra.md"), "---\ntitle: Infra\n---\n\nCuenta AWS de producción.\n").unwrap();
        let written = docs_changed(&store, &e, &docs_event(root, json!([{"action": "written", "relPath": "dp/infra.md"}]))).unwrap();
        assert_eq!(written["changes"][0]["result"], "created");
        let node = store.by_source_ref("inkwell:dp/infra.md").unwrap().unwrap();
        assert!(node.body.contains("Cuenta AWS"));
        std::fs::write(root.join("dp/infra.md"), "---\ntitle: Infra\n---\n\nCuenta AWS de staging.\n").unwrap();
        let updated = docs_changed(&store, &e, &docs_event(root, json!([{"action": "written", "relPath": "dp/infra.md"}]))).unwrap();
        assert_eq!(updated["changes"][0]["result"], "updated");
        assert!(store.by_source_ref("inkwell:dp/infra.md").unwrap().unwrap().body.contains("staging"));

        std::fs::rename(root.join("dp/infra.md"), root.join("dp/aws.md")).unwrap();
        let moved = docs_changed(&store, &e, &docs_event(root, json!([{"action": "moved", "relPath": "dp/aws.md", "from": "dp/infra.md"}]))).unwrap();
        assert_eq!(moved["changes"][0]["renamed"], true);
        assert_eq!(moved["changes"][0]["from"], "dp/infra.md");
        assert!(store.by_source_ref("inkwell:dp/infra.md").unwrap().is_none());
        let renamed = store.by_source_ref("inkwell:dp/aws.md").unwrap().unwrap();
        assert_eq!(renamed.id, node.id);
        assert!(renamed.body.contains("staging"));

        std::fs::remove_file(root.join("dp/aws.md")).unwrap();
        let deleted = docs_changed(&store, &e, &docs_event(root, json!([{"action": "deleted", "relPath": "dp/aws.md"}]))).unwrap();
        assert_eq!(deleted["changes"][0]["result"], "removed");
        assert!(store.by_source_ref("inkwell:dp/aws.md").unwrap().is_none());
        let again = docs_changed(&store, &e, &docs_event(root, json!([{"action": "deleted", "relPath": "dp/aws.md"}]))).unwrap();
        assert_eq!(again["changes"][0]["result"], "absent");
    }

    #[test]
    fn inkwell_written_events_for_missing_files_forget_the_note() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("dp")).unwrap();
        std::fs::write(root.join("dp/old.md"), "# Old\n\nTexto viejo.\n").unwrap();
        docs_changed(&store, &e, &docs_event(root, json!([{"action": "written", "relPath": "dp/old.md"}]))).unwrap();
        std::fs::remove_file(root.join("dp/old.md")).unwrap();
        let result = docs_changed(&store, &e, &docs_event(root, json!([{"action": "written", "relPath": "dp/old.md"}]))).unwrap();
        assert_eq!(result["changes"][0]["result"], "removed");
        assert!(store.by_source_ref("inkwell:dp/old.md").unwrap().is_none());
    }

    #[test]
    fn inkwell_events_ignore_invalid_paths_and_keep_going_after_errors() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("docs");
        std::fs::create_dir_all(root.join("dp/page.assets")).unwrap();
        std::fs::write(dir.path().join("secret.md"), "# Secret\n\nFuera.\n").unwrap();
        std::fs::write(root.join("dp/page.assets/a.md"), "# Asset\n").unwrap();
        std::fs::write(root.join("dp/img.png"), "png").unwrap();
        std::fs::write(root.join("dp/bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        std::fs::write(root.join("dp/ok.md"), "# Ok\n\nBien.\n").unwrap();
        let absolute = dir.path().join("secret.md").to_string_lossy().to_string();
        let changes = json!([
            {"action": "written", "relPath": "../secret.md"},
            {"action": "written", "relPath": absolute},
            {"action": "written", "relPath": "dp/../../secret.md"},
            {"action": "written", "relPath": "dp/page.assets/a.md"},
            {"action": "written", "relPath": "dp/img.png"},
            {"action": "deleted", "relPath": null},
            {"action": "renamed", "relPath": "dp/ok.md"},
            {"action": "written", "relPath": "dp/bad.md"},
            {"action": "written", "relPath": "dp/ok.md"},
        ]);
        let result = docs_changed(&store, &e, &docs_event(&root, changes)).unwrap();
        let outcomes: Vec<&str> = result["changes"].as_array().unwrap().iter().map(|c| c["result"].as_str().unwrap()).collect();
        assert_eq!(outcomes, ["ignored", "ignored", "ignored", "ignored", "ignored", "ignored", "ignored", "error", "created"]);
        let total: i64 = store.conn.query_row("SELECT COUNT(*) FROM nodes WHERE source = 'inkwell'", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1);
        assert_eq!(inkwell_rel("./dp/x.md").as_deref(), Some("dp/x.md"));
        assert_eq!(result["failed"], 1);
    }

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
        assert_eq!(folder_project(&store, &spaces, "notas-sueltas"), GLOBAL);
        assert_eq!(folder_project(&store, &spaces, "_no-project"), GLOBAL);
    }

    fn store_with_projects() -> Store {
        let store = Store::in_memory().unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO projects (slug, bita_id, name) VALUES ('apartados', 1, 'Apartados'), ('dp-personalization', 2, 'DP Personalization'), ('dp', 3, 'DP'), ('global', 4, 'Global'), ('cliente-uno', 5, 'Cliente Uno'), ('cliente-uno-bis', 6, 'Cliente-Uno');
                 INSERT INTO project_groups (name, project) VALUES ('equipo', 'dp');",
            )
            .unwrap();
        store
    }

    #[test]
    fn unlinked_folders_use_known_projects_and_never_invent_one() {
        let store = store_with_projects();
        let spaces = HashMap::new();
        assert_eq!(folder_project(&store, &spaces, "apartados-remediacion-de-seguridad-2026"), "apartados");
        assert_eq!(folder_project(&store, &spaces, "dp-personalization-notas"), "dp-personalization");
        assert_eq!(folder_project(&store, &spaces, "dp-personalization"), "dp-personalization");
        assert_eq!(folder_project(&store, &spaces, "equipo"), "equipo");
        assert_eq!(folder_project(&store, &spaces, "cliente-uno-2026"), GLOBAL);
        assert_eq!(folder_project(&store, &spaces, "dpx-otra-cosa"), GLOBAL);
        assert_eq!(folder_project(&store, &spaces, "remediacion-de-seguridad"), GLOBAL);
        assert_eq!(folder_project(&store, &spaces, "global-notas"), GLOBAL);
        assert_eq!(folder_project(&store, &spaces, "_no-project"), GLOBAL);
        let total: i64 = store.conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 6);
    }

    #[test]
    fn folder_prefixes_match_only_on_word_boundaries() {
        let store = store_with_projects();
        store.conn.execute("INSERT INTO projects (slug, bita_id, name) VALUES ('viva', 7, 'Viva')", []).unwrap();
        let spaces = HashMap::new();
        assert_eq!(folder_project(&store, &spaces, "vivalavida"), GLOBAL);
        assert_eq!(folder_project(&store, &spaces, "viva-la-vida"), "viva");
        assert_eq!(folder_project(&store, &spaces, "apartados-remediacion"), "apartados");
        assert_eq!(folder_project(&store, &spaces, "apartadosremediacion"), GLOBAL);
        assert_eq!(folder_project(&store, &spaces, "dp-personalizationx"), GLOBAL);
    }

    #[test]
    fn bita_events_refresh_projects_when_the_entry_project_is_unknown() {
        use std::os::unix::fs::PermissionsExt;
        let store = Store::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let calls = dir.path().join("calls");
        let script = dir.path().join("bita");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$@\" >> '{}'\necho '{{\"ok\":true,\"data\":[{{\"id\":77,\"name\":\"Nuevo Cliente\"}}]}}'\n", calls.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = script.to_string_lossy().to_string();
        let event = json!({"event": "stop", "entry": {"id": 5, "description": "Arranque", "projectId": 77, "projectName": "Nuevo Cliente"}});
        let result = bita_event(&store, &FakeEmbedder, &event, &bin).unwrap();
        let node = store.get(result["node"]["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(node.project, "nuevo-cliente");
        assert_eq!(project::project_for_bita_id(&store, 77).as_deref(), Some("nuevo-cliente"));
        let again = json!({"event": "stop", "entry": {"id": 6, "description": "Otra", "projectId": 77}});
        bita_event(&store, &FakeEmbedder, &again, &bin).unwrap();
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
    }

    #[test]
    fn inkwell_ingest_refreshes_bita_projects_first() {
        use std::os::unix::fs::PermissionsExt;
        let store = Store::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("bita");
        std::fs::write(&script, "#!/bin/sh\necho '{\"ok\":true,\"data\":[{\"id\":42,\"name\":\"Linked Space\",\"key\":\"LS\"}]}'\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let root = dir.path().join("docs");
        std::fs::create_dir_all(&root).unwrap();
        ingest_inkwell(&store, &FakeEmbedder, &root, false, &script.to_string_lossy()).unwrap();
        assert_eq!(project::project_for_bita_id(&store, 42).as_deref(), Some("linked-space"));
    }

    #[test]
    fn inkwell_entries_without_a_folder_project_follow_their_frontmatter() {
        let store = store_with_projects();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_no-project/2026/10")).unwrap();
        std::fs::create_dir_all(root.join("apartados/2026/10")).unwrap();
        let write = |rel: &str, project: &str| {
            std::fs::write(root.join(rel), format!("---\nentryId: 1\ntitle: T\n{project}\n---\n\n# T\n\nAlgo.\n")).unwrap();
            inkwell_note(&store, &e, root, &root.join(rel)).unwrap().unwrap();
            store.by_source_ref(&format!("inkwell:{rel}")).unwrap().unwrap().project
        };
        assert_eq!(write("_no-project/2026/10/a.md", "project: DP Personalization"), "dp-personalization");
        assert_eq!(write("_no-project/2026/10/b.md", "projectId: 1"), "apartados");
        assert_eq!(write("_no-project/2026/10/c.md", "project: Proyecto Inexistente"), GLOBAL);
        assert_eq!(write("apartados/2026/10/d.md", "project: DP Personalization"), "apartados");
        assert_eq!(write("_no-project/2026/10/e.md", ""), GLOBAL);
        let total: i64 = store.conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 6);
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
        store.conn.execute("INSERT INTO projects (slug, bita_id, name) VALUES ('dp-personalization', 2, 'DP Personalization')", []).unwrap();
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
        let report = ingest_inkwell(&store, &e, root, false, "/nonexistent/bita").unwrap();
        assert_eq!((report.scanned, report.created), (2, 2));
        let again = ingest_inkwell(&store, &e, root, false, "/nonexistent/bita").unwrap();
        assert_eq!(again.unchanged, 2);
        let entry = store.by_source_ref("inkwell:dp-personalization/2026/10/16-914-tc.md").unwrap().unwrap();
        assert_eq!(entry.kind, "entry");
        assert_eq!(entry.project, "dp-personalization");
        let page = store.by_source_ref("inkwell:dp-personalization/infra.md").unwrap().unwrap();
        assert!(store.neighbors(&entry.id).unwrap().iter().any(|n| n.id == page.id && n.edge_kind == "same-issue"));
        let event = json!({"event": "stop", "entry": {"id": 914, "description": "TC 07", "projectName": "DP Personalization", "localDay": "2026-10-16", "durationHuman": "1h"}, "docPath": "dp-personalization/2026/10/16-914-tc.md", "docsRoot": root});
        let result = bita_event(&store, &e, &event, "/nonexistent/bita").unwrap();
        let bita_node = result["node"]["id"].as_str().unwrap().to_string();
        assert!(store.neighbors(&bita_node).unwrap().iter().any(|n| n.id == entry.id && n.edge_kind == "same-entry"));
        std::fs::remove_file(root.join("dp-personalization/infra.md")).unwrap();
        assert_eq!(ingest_inkwell(&store, &e, root, false, "/nonexistent/bita").unwrap().removed, 1);
        let deleted = bita_event(&store, &e, &json!({"event": "delete", "entry": {"id": 914}}), "/nonexistent/bita").unwrap();
        assert_eq!(deleted["removed"], true);
    }

    #[test]
    fn inkwell_large_batches_with_moved_and_written_of_the_same_file_settle_on_the_final_path() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("dp")).unwrap();
        let mut changes = Vec::new();
        for index in 0..150 {
            std::fs::write(root.join(format!("dp/page-{index}.md")), format!("# Page {index}\n\nContenido numero {index}.\n")).unwrap();
            changes.push(json!({"action": "written", "relPath": format!("dp/page-{index}.md")}));
        }
        docs_changed(&store, &e, &docs_event(root, json!(changes))).unwrap();
        let total = |store: &Store| -> i64 { store.conn.query_row("SELECT COUNT(*) FROM nodes WHERE source = 'inkwell'", [], |r| r.get(0)).unwrap() };
        assert_eq!(total(&store), 150);

        let mut batch = Vec::new();
        for index in 0..150 {
            std::fs::rename(root.join(format!("dp/page-{index}.md")), root.join(format!("dp/renamed-{index}.md"))).unwrap();
            batch.push(json!({"action": "written", "relPath": format!("dp/page-{index}.md")}));
            batch.push(json!({"action": "moved", "relPath": format!("dp/renamed-{index}.md"), "from": format!("dp/page-{index}.md")}));
            batch.push(json!({"action": "written", "relPath": format!("dp/renamed-{index}.md")}));
        }
        let result = docs_changed(&store, &e, &docs_event(root, json!(batch))).unwrap();
        assert_eq!(result["failed"], 0);
        assert_eq!(result["changes"].as_array().unwrap().len(), 450);
        assert_eq!(total(&store), 150);
        for index in 0..150 {
            assert!(store.by_source_ref(&format!("inkwell:dp/page-{index}.md")).unwrap().is_none());
            assert!(store.by_source_ref(&format!("inkwell:dp/renamed-{index}.md")).unwrap().is_some());
        }
    }

    #[test]
    fn inkwell_moved_then_written_in_either_order_and_a_move_onto_itself_keep_one_note() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("dp")).unwrap();
        std::fs::write(root.join("dp/a.md"), "# A\n\nTexto.\n").unwrap();
        docs_changed(&store, &e, &docs_event(root, json!([{"action": "written", "relPath": "dp/a.md"}]))).unwrap();
        std::fs::rename(root.join("dp/a.md"), root.join("dp/b.md")).unwrap();
        docs_changed(
            &store,
            &e,
            &docs_event(root, json!([{"action": "written", "relPath": "dp/b.md"}, {"action": "moved", "relPath": "dp/b.md", "from": "dp/a.md"}])),
        )
        .unwrap();
        assert!(store.by_source_ref("inkwell:dp/a.md").unwrap().is_none());
        assert!(store.by_source_ref("inkwell:dp/b.md").unwrap().is_some());
        let own = docs_changed(&store, &e, &docs_event(root, json!([{"action": "moved", "relPath": "dp/b.md", "from": "dp/b.md"}]))).unwrap();
        assert_eq!(own["failed"], 0);
        assert!(store.by_source_ref("inkwell:dp/b.md").unwrap().is_some());
        let invalid_from = docs_changed(&store, &e, &docs_event(root, json!([{"action": "moved", "relPath": "dp/b.md", "from": "../a.md"}]))).unwrap();
        assert_eq!(invalid_from["changes"][0]["renamed"], false);
        assert!(store.by_source_ref("inkwell:dp/b.md").unwrap().is_some());
        let total: i64 = store.conn.query_row("SELECT COUNT(*) FROM nodes WHERE source = 'inkwell'", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1);
    }

    #[test]
    fn inkwell_events_without_changes_or_with_malformed_shapes_do_nothing() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for event in [
            json!({"docsRoot": root, "event": "docs.changed"}),
            json!({"docsRoot": root, "event": "docs.changed", "changes": null}),
            json!({"docsRoot": root, "event": "docs.changed", "changes": []}),
            json!({"docsRoot": root, "event": "docs.changed", "changes": "dp/a.md"}),
            json!({"docsRoot": root, "event": "docs.changed", "changes": {"action": "written"}}),
            json!({"docsRoot": root, "event": "docs.changed", "changes": [null, 7, "x", [], {}]}),
            json!({"docsRoot": 7, "event": "docs.changed", "changes": []}),
        ] {
            let result = docs_changed(&store, &e, &event).unwrap();
            assert_eq!(result["failed"], 0);
            assert!(result["changes"].as_array().unwrap().iter().all(|c| c["result"] == "ignored"));
        }
        let other =
            docs_changed(&store, &e, &json!({"event": "page.opened", "docsRoot": root, "changes": [{"action": "written", "relPath": "dp/a.md"}]})).unwrap();
        assert_eq!(other["skipped"], true);
        let total: i64 = store.conn.query_row("SELECT COUNT(*) FROM nodes WHERE source = 'inkwell'", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 0);
    }

    fn inkwell_count(store: &Store) -> i64 {
        store.conn.query_row("SELECT COUNT(*) FROM nodes WHERE source = 'inkwell'", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn inkwell_moves_to_ignored_paths_forget_the_origin() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("dp/page.assets")).unwrap();
        for name in ["a", "b", "c"] {
            std::fs::write(root.join(format!("dp/{name}.md")), format!("# {name}\n\nTexto {name}.\n")).unwrap();
            docs_changed(&store, &e, &docs_event(root, json!([{"action": "written", "relPath": format!("dp/{name}.md")}]))).unwrap();
        }
        assert_eq!(inkwell_count(&store), 3);
        std::fs::rename(root.join("dp/a.md"), root.join("dp/a.txt")).unwrap();
        std::fs::rename(root.join("dp/b.md"), root.join("dp/.b.md")).unwrap();
        std::fs::rename(root.join("dp/c.md"), root.join("dp/page.assets/c.md")).unwrap();
        let result = docs_changed(
            &store,
            &e,
            &docs_event(
                root,
                json!([
                    {"action": "moved", "relPath": "dp/a.txt", "from": "dp/a.md"},
                    {"action": "moved", "relPath": "dp/.b.md", "from": "dp/b.md"},
                    {"action": "moved", "relPath": "dp/page.assets/c.md", "from": "dp/c.md"},
                    {"action": "moved", "relPath": "dp/x.txt", "from": "../a.md"},
                ]),
            ),
        )
        .unwrap();
        let outcomes: Vec<(&str, bool)> =
            result["changes"].as_array().unwrap().iter().map(|c| (c["result"].as_str().unwrap(), c["fromRemoved"].as_bool().unwrap())).collect();
        assert_eq!(outcomes, [("removed", true), ("removed", true), ("removed", true), ("ignored", false)]);
        assert_eq!(inkwell_count(&store), 0);
        let marks: i64 = store.conn.query_row("SELECT COUNT(*) FROM ingest_files", [], |r| r.get(0)).unwrap();
        assert_eq!(marks, 0);
    }

    #[test]
    fn inkwell_moves_keep_the_node_id_edges_hits_and_injections() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("dp")).unwrap();
        std::fs::write(root.join("dp/infra.md"), "---\ntitle: Infra\n---\n\nCuenta AWS de producción.\n").unwrap();
        std::fs::write(root.join("dp/index.md"), "# Indice\n\nVer [[Infra]].\n").unwrap();
        std::fs::write(root.join("dp/later.md"), "# Luego\n\nVer [[aws]].\n").unwrap();
        std::fs::write(root.join("dp/aws.md"), "# Viejo\n\nDocumento anterior.\n").unwrap();
        let changes: Vec<Value> = ["infra", "index", "later", "aws"].iter().map(|n| json!({"action": "written", "relPath": format!("dp/{n}.md")})).collect();
        docs_changed(&store, &e, &docs_event(root, json!(changes))).unwrap();
        let infra = store.by_source_ref("inkwell:dp/infra.md").unwrap().unwrap();
        let index = store.by_source_ref("inkwell:dp/index.md").unwrap().unwrap();
        let later = store.by_source_ref("inkwell:dp/later.md").unwrap().unwrap();
        let old_aws = store.by_source_ref("inkwell:dp/aws.md").unwrap().unwrap();
        let manual = store
            .remember(
                &e,
                NewNode { project: GLOBAL.into(), kind: "fact".into(), body: "Nota manual".into(), source: "claude".into(), ..Default::default() },
                false,
            )
            .unwrap();
        store.link(&manual.id, &infra.id).unwrap();
        store.record_injection("s1", "prompt", std::slice::from_ref(&infra.id), 10, 1).unwrap();
        let hits = store.get(&infra.id).unwrap().unwrap().hits;
        assert!(hits >= 1);

        std::fs::rename(root.join("dp/infra.md"), root.join("dp/aws.md")).unwrap();
        let moved = docs_changed(&store, &e, &docs_event(root, json!([{"action": "moved", "relPath": "dp/aws.md", "from": "dp/infra.md"}]))).unwrap();
        assert_eq!(moved["failed"], 0);
        assert_eq!(moved["changes"][0]["renamed"], true);
        assert_eq!(moved["changes"][0]["displaced"], json!(old_aws.id));
        assert_eq!(moved["changes"][0]["id"], json!(infra.id));
        assert!(store.get(&old_aws.id).unwrap().is_none());
        assert!(store.by_source_ref("inkwell:dp/infra.md").unwrap().is_none());
        let node = store.by_source_ref("inkwell:dp/aws.md").unwrap().unwrap();
        assert_eq!(node.id, infra.id);
        assert_eq!(node.hits, hits);
        assert!(store.injected("s1").unwrap().contains(&infra.id));
        let neighbors: Vec<(String, String)> = store.neighbors(&infra.id).unwrap().into_iter().map(|n| (n.id, n.edge_kind)).collect();
        for other in [&index.id, &manual.id, &later.id] {
            assert!(neighbors.contains(&(other.clone(), "link".into())), "missing link from {other}: {neighbors:?}");
        }
        assert_eq!(inkwell_count(&store), 3);
        let path: String = store.conn.query_row("SELECT path FROM ingest_files WHERE node_id = ?1", [&infra.id], |r| r.get(0)).unwrap();
        assert_eq!(path, "inkwell:dp/aws.md");

        let report = ingest_inkwell(&store, &e, root, false, "/nonexistent/bita").unwrap();
        assert_eq!((report.scanned, report.unchanged, report.created, report.updated, report.removed), (3, 3, 0, 0, 0));
        assert_eq!(inkwell_count(&store), 3);
        assert_eq!(store.by_source_ref("inkwell:dp/aws.md").unwrap().unwrap().id, infra.id);

        let own = docs_changed(&store, &e, &docs_event(root, json!([{"action": "moved", "relPath": "dp/aws.md", "from": "dp/aws.md"}]))).unwrap();
        assert_eq!(own["changes"][0]["renamed"], false);
        assert_eq!(own["changes"][0]["result"], "unchanged");
        assert_eq!(store.by_source_ref("inkwell:dp/aws.md").unwrap().unwrap().id, infra.id);
    }

    #[test]
    fn inkwell_events_only_trust_absolute_docs_roots_and_flag_mismatches() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let configured = dir.path().join("docs");
        let other = dir.path().join("other");
        for root in [&configured, &other] {
            std::fs::create_dir_all(root.join("dp")).unwrap();
        }
        std::fs::write(configured.join("dp/a.md"), "# A\n\nConfigurada.\n").unwrap();
        std::fs::write(other.join("dp/b.md"), "# B\n\nOtra raiz.\n").unwrap();
        let run = |root: Value, rel: &str| {
            let event = json!({"event": "docs.changed", "docsRoot": root, "changes": [{"action": "written", "relPath": rel}]});
            inkwell_event(&store, &e, &event, &configured, "/nonexistent/bita").unwrap()
        };
        for root in [json!("docs"), json!(""), json!(null), json!(7)] {
            let result = run(root.clone(), "dp/a.md");
            assert_eq!(result["docsRoot"], json!(configured), "root {root}");
            assert_eq!(result["rootMismatch"], false);
            assert_ne!(result["changes"][0]["result"], "absent");
        }
        let same = run(json!(dir.path().join("docs/../docs")), "dp/a.md");
        assert_eq!(same["rootMismatch"], false);
        let mismatch = run(json!(other), "dp/b.md");
        assert_eq!(mismatch["rootMismatch"], true);
        assert_eq!(mismatch["changes"][0]["result"], "created");
        assert!(store.by_source_ref("inkwell:dp/b.md").unwrap().is_some());
    }

    #[test]
    fn inkwell_events_refresh_projects_once_when_a_folder_is_unknown() {
        use std::os::unix::fs::PermissionsExt;
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let dir = tempfile::tempdir().unwrap();
        let calls = dir.path().join("calls");
        let script = dir.path().join("bita");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$@\" >> '{}'\necho '{{\"ok\":true,\"data\":[{{\"id\":88,\"name\":\"Cliente Nuevo\"}}]}}'\n", calls.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = script.to_string_lossy().to_string();
        let root = dir.path().join("docs");
        std::fs::create_dir_all(root.join("cliente-nuevo")).unwrap();
        std::fs::create_dir_all(root.join("suelto")).unwrap();
        std::fs::write(root.join("cliente-nuevo/a.md"), "# A\n\nUno.\n").unwrap();
        std::fs::write(root.join("suelto/b.md"), "# B\n\nDos.\n").unwrap();
        let event = json!({"event": "docs.changed", "docsRoot": root, "changes": [
            {"action": "written", "relPath": "cliente-nuevo/a.md"},
            {"action": "written", "relPath": "suelto/b.md"},
        ]});
        let result = inkwell_event(&store, &e, &event, &root, &bin).unwrap();
        assert_eq!(result["failed"], 0);
        assert_eq!(store.by_source_ref("inkwell:cliente-nuevo/a.md").unwrap().unwrap().project, "cliente-nuevo");
        assert_eq!(store.by_source_ref("inkwell:suelto/b.md").unwrap().unwrap().project, GLOBAL);
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
        let known = json!({"event": "docs.changed", "docsRoot": root, "changes": [{"action": "written", "relPath": "cliente-nuevo/a.md"}]});
        inkwell_event(&store, &e, &known, &root, &bin).unwrap();
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
        std::fs::create_dir_all(root.join("_no-project/2026/10")).unwrap();
        std::fs::write(root.join("_no-project/2026/10/c.md"), "# C\n\nTres.\n").unwrap();
        let orphan = json!({"event": "docs.changed", "docsRoot": root, "changes": [{"action": "written", "relPath": "_no-project/2026/10/c.md"}]});
        let result = inkwell_event(&store, &e, &orphan, &root, &bin).unwrap();
        assert_eq!(result["changes"][0]["result"], "created");
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
    }
}
