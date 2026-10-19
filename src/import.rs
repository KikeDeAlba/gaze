use anyhow::Result;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::embed::Embedder;
use crate::ingest::frontmatter;
use crate::project;
use crate::store::{GLOBAL, NewNode, Store};
use crate::text;

pub fn encode(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn decode_from(dir: &Path, rest: &str, depth: usize) -> Option<PathBuf> {
    if rest.is_empty() {
        return Some(dir.to_path_buf());
    }
    if depth > 40 {
        return None;
    }
    let mut candidates: Vec<(usize, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let encoded = encode(&entry.file_name().to_string_lossy());
        if rest == encoded || rest.starts_with(&format!("{encoded}-")) {
            candidates.push((encoded.len(), entry.path()));
        }
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
    for (len, path) in candidates {
        let remaining = rest[len..].strip_prefix('-').unwrap_or(&rest[len..]);
        if let Some(found) = decode_from(&path, remaining, depth + 1) {
            return Some(found);
        }
    }
    None
}

pub fn decode_dir_name(name: &str) -> PathBuf {
    decode_dir_name_exact(name).0
}

pub fn decode_dir_name_exact(name: &str) -> (PathBuf, bool) {
    let rest = name.strip_prefix('-').unwrap_or(name);
    if let Some(found) = decode_from(Path::new("/"), rest, 0) {
        return (found, true);
    }
    (decode_prefix(rest), false)
}

pub fn guess_project(name: &str, slugs: &[String]) -> Option<String> {
    let tokens: Vec<String> = name.to_lowercase().split('-').filter(|t| !t.is_empty()).map(str::to_string).collect();
    slugs
        .iter()
        .filter(|slug| slug.as_str() != GLOBAL && !slug.is_empty())
        .filter(|slug| {
            let parts: Vec<&str> = slug.split('-').collect();
            tokens.windows(parts.len()).any(|w| w.iter().zip(&parts).all(|(a, b)| a == b))
        })
        .max_by_key(|slug| slug.len())
        .cloned()
}

fn known_slugs(store: &Store) -> Vec<String> {
    let _ = project::refresh_bita_projects(store, Path::new("/"));
    let mut slugs: Vec<String> = store
        .conn
        .prepare("SELECT slug FROM projects")
        .and_then(|mut stmt| stmt.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()))
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir(crate::paths::inkwell_docs()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_dir() && !name.starts_with(['.', '_']) {
                slugs.push(name);
            }
        }
    }
    slugs.sort();
    slugs.dedup();
    slugs
}

fn decode_prefix(rest: &str) -> PathBuf {
    let mut best = PathBuf::from("/");
    let mut current = PathBuf::from("/");
    let mut remaining = rest.to_string();
    loop {
        let Ok(entries) = std::fs::read_dir(&current) else { break };
        let mut next: Option<(usize, PathBuf)> = None;
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let encoded = encode(&entry.file_name().to_string_lossy());
            if (remaining == encoded || remaining.starts_with(&format!("{encoded}-"))) && next.as_ref().is_none_or(|(l, _)| encoded.len() > *l) {
                next = Some((encoded.len(), entry.path()));
            }
        }
        let Some((len, path)) = next else { break };
        remaining = remaining[len..].strip_prefix('-').unwrap_or(&remaining[len..]).to_string();
        current = path.clone();
        best = path;
        if remaining.is_empty() {
            break;
        }
    }
    best
}

pub fn skip_dir(name: &str) -> bool {
    name.starts_with("-private-tmp-") || name.starts_with("-tmp-") || name.contains("-Recap-") || name.ends_with("-Recap")
}

pub fn kind_for(memory_type: &str, project: &str) -> &'static str {
    match memory_type {
        "feedback" if project != GLOBAL => "rule",
        _ => "fact",
    }
}

pub struct Memory {
    pub path: PathBuf,
    pub source_ref: String,
    pub project: String,
    pub kind: &'static str,
    pub title: String,
    pub body: String,
}

pub fn collect(store: &Store, root: &Path) -> Result<Vec<Memory>> {
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(root) else { return Ok(out) };
    let mut slugs: Option<Vec<String>> = None;
    let mut dirs: Vec<_> = dirs.flatten().collect();
    dirs.sort_by_key(|d| d.file_name());
    for dir in dirs {
        let name = dir.file_name().to_string_lossy().to_string();
        if skip_dir(&name) {
            continue;
        }
        let memory_dir = dir.path().join("memory");
        let Ok(files) = std::fs::read_dir(&memory_dir) else { continue };
        let mut files: Vec<PathBuf> = files.flatten().map(|f| f.path()).filter(|p| p.extension().is_some_and(|e| e == "md")).collect();
        files.retain(|p| p.file_name().is_some_and(|n| n != "MEMORY.md"));
        if files.is_empty() {
            continue;
        }
        files.sort();
        let (decoded, exact) = decode_dir_name_exact(&name);
        let mut resolved = project::resolve(store, &decoded, false)?;
        if resolved.slug == GLOBAL && (!exact || project::git_root(&decoded).is_none()) {
            let slugs = slugs.get_or_insert_with(|| known_slugs(store));
            if let Some(guess) = guess_project(&name, slugs) {
                resolved.slug = guess;
            }
        }
        for file in files {
            let raw = std::fs::read_to_string(&file)?;
            let (meta, body) = frontmatter(&raw);
            let memory_type = meta.get("type").map(String::as_str).unwrap_or("project");
            let project = if memory_type == "user" { GLOBAL.to_string() } else { resolved.slug.clone() };
            let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let name_field = meta.get("name").cloned().unwrap_or(stem.clone());
            let description = meta.get("description").cloned().unwrap_or_default();
            let title = if description.is_empty() { name_field.clone() } else { text::truncate(&description, 90) };
            let full_body =
                if description.is_empty() || description.chars().count() <= 90 { body.trim().to_string() } else { format!("{description}\n\n{}", body.trim()) };
            out.push(Memory {
                source_ref: format!("claude-memory:{name}/{stem}.md"),
                kind: kind_for(memory_type, &project),
                path: file,
                project,
                title,
                body: if full_body.is_empty() { description } else { full_body },
            });
        }
    }
    Ok(out)
}

pub fn run(store: &Store, emb: Option<&dyn Embedder>, root: &Path, dry_run: bool) -> Result<Value> {
    let memories = collect(store, root)?;
    let mut per_project: BTreeMap<String, BTreeMap<&str, usize>> = BTreeMap::new();
    for memory in &memories {
        *per_project.entry(memory.project.clone()).or_default().entry(memory.kind).or_default() += 1;
    }
    let mut actions: BTreeMap<&str, usize> = BTreeMap::new();
    if !dry_run && let Some(emb) = emb {
        for memory in &memories {
            if memory.body.trim().is_empty() {
                continue;
            }
            let outcome = store.remember(
                emb,
                NewNode {
                    project: memory.project.clone(),
                    kind: memory.kind.into(),
                    title: Some(memory.title.clone()),
                    body: memory.body.clone(),
                    source: "import".into(),
                    source_ref: Some(memory.source_ref.clone()),
                    ..Default::default()
                },
                false,
            );
            match outcome {
                Ok(o) => *actions.entry(o.action).or_default() += 1,
                Err(error) => {
                    *actions.entry("failed").or_default() += 1;
                    eprintln!("{}: {error:#}", memory.path.display());
                }
            }
        }
    }
    Ok(json!({"dryRun": dry_run, "total": memories.len(), "projects": per_project, "actions": actions}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;

    #[test]
    fn decodes_dir_names_against_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let target = base.join("dev/github.com/my-org/repo.v2/.claude/worktrees/x");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(base.join("dev/github")).unwrap();
        let name = encode(&target.to_string_lossy());
        assert_eq!(decode_dir_name(&name), target);
        let missing = encode(&base.join("dev/github.com/my-org/gone").to_string_lossy());
        assert_eq!(decode_dir_name(&missing), base.join("dev/github.com/my-org"));
    }

    #[test]
    fn guesses_project_from_moved_dir_names() {
        let slugs: Vec<String> = ["apartados", "sso", "dportenis", "zipp", "can-doo-with-pet", "global"].iter().map(|s| s.to_string()).collect();
        assert_eq!(guess_project("-Users-x-dev-vivaaerobus-vb-solemti-apartados", &slugs).as_deref(), Some("apartados"));
        assert_eq!(guess_project("-Users-x-dev-vivaaerobus-vb-solemti-doters-sso-adm-panel", &slugs).as_deref(), Some("sso"));
        assert_eq!(guess_project("-Users-x-dev-celula-ecommerce-accrual-engine-zipp-infra", &slugs).as_deref(), Some("zipp"));
        assert_eq!(guess_project("-Users-x-dev-can-doo-pet-waste-site", &slugs), None);
    }

    #[test]
    fn imports_memories_with_links_and_kinds() {
        unsafe { std::env::set_var("GAZE_BITA_BIN", "/nonexistent/bita") };
        let store = Store::in_memory().unwrap();
        let dir = tempfile::tempdir_in("/var/tmp").unwrap();
        assert!(!skip_dir(&encode(&dir.path().canonicalize().unwrap().to_string_lossy())), "the fixture must live outside a skipped temp dir");
        let root = dir.path().join("projects");
        let work = dir.path().canonicalize().unwrap().join("work/app");
        std::fs::create_dir_all(work.join(".git")).unwrap();
        std::fs::write(work.join("gaze.toml"), "project = \"App\"\n").unwrap();
        let mem = root.join(encode(&work.to_string_lossy())).join("memory");
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::create_dir_all(root.join("-private-tmp-x/memory")).unwrap();
        std::fs::write(root.join("-private-tmp-x/memory/a.md"), "---\nname: a\n---\nignorar").unwrap();
        std::fs::write(mem.join("MEMORY.md"), "- index").unwrap();
        std::fs::write(mem.join("auth.md"), "---\nname: auth\ndescription: Cómo funciona la auth\nmetadata:\n  type: project\n---\nUsa JWT, ver [[sessions]]")
            .unwrap();
        std::fs::write(mem.join("sessions.md"), "---\nname: sessions\ndescription: Sesiones de 8 horas\nmetadata:\n  type: project\n---\nDuran 8 horas")
            .unwrap();
        std::fs::write(mem.join("style.md"), "---\nname: style\ndescription: Nada de comentarios\nmetadata:\n  type: feedback\n---\nSin comentarios en código")
            .unwrap();
        std::fs::write(mem.join("me.md"), "---\nname: me\ndescription: El usuario habla español\nmetadata:\n  type: user\n---\nPrefiere español").unwrap();
        let dry = run(&store, None, &root, true).unwrap();
        assert_eq!(dry["total"], 4);
        assert_eq!(dry["projects"]["app"]["fact"], 2);
        assert_eq!(dry["projects"]["app"]["rule"], 1);
        assert_eq!(dry["projects"]["global"]["fact"], 1);
        let e = FakeEmbedder;
        let done = run(&store, Some(&e), &root, false).unwrap();
        assert_eq!(done["actions"]["created"], 4);
        let auth = store.by_source_ref(&format!("claude-memory:{}/auth.md", encode(&work.to_string_lossy()))).unwrap().unwrap();
        assert_eq!(auth.title, "Cómo funciona la auth");
        assert!(store.neighbors(&auth.id).unwrap().iter().any(|n| n.title == "Sesiones de 8 horas" && n.edge_kind == "link"));
        assert_eq!(run(&store, Some(&e), &root, false).unwrap()["actions"]["unchanged"], 4);
    }
}
