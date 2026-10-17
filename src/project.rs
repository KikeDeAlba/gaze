use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::paths;
use crate::store::{GLOBAL, Store};
use crate::text;

const CACHE_SECONDS: i64 = 24 * 3600;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub slug: String,
    pub name: Option<String>,
    pub bita_id: Option<i64>,
    pub key: Option<String>,
    pub source: String,
    pub repo: Option<String>,
}

impl Project {
    pub fn global(source: &str) -> Self {
        Self { slug: GLOBAL.into(), name: None, bita_id: None, key: None, source: source.into(), repo: None }
    }
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn git_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

pub fn origin_url(root: &Path) -> Option<String> {
    let output = Command::new("git").arg("-C").arg(root).args(["remote", "get-url", "origin"]).stderr(Stdio::null()).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

pub fn remote_slug(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = if let Some((_, after)) = url.split_once("://") {
        let after = after.split_once('@').map(|(_, h)| h).unwrap_or(after);
        let (host, path) = after.split_once('/')?;
        let host = host.split(':').next().unwrap_or(host);
        format!("{host}/{path}")
    } else if let Some((user_host, path)) = url.split_once(':') {
        let host = user_host.split_once('@').map(|(_, h)| h).unwrap_or(user_host);
        format!("{host}/{path}")
    } else {
        return None;
    };
    let trimmed = rest.trim_end_matches('/').trim_end_matches(".git").to_lowercase();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub fn match_scope<'a>(slug: &str, mapping: &'a serde_json::Map<String, Value>) -> Option<&'a Value> {
    let slug = slug.to_lowercase();
    mapping
        .iter()
        .filter(|(key, _)| {
            let key = key.to_lowercase().trim_end_matches('/').to_string();
            slug == key || slug.starts_with(&format!("{key}/"))
        })
        .max_by_key(|(key, _)| key.len())
        .map(|(_, value)| value)
}

fn run_json(program: &str, args: &[&str], cwd: &Path, timeout: Duration) -> Option<Value> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("BITA_NO_HOOKS", "1")
        .spawn()
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().rev().find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

fn bita_bin() -> String {
    std::env::var("GAZE_BITA_BIN").unwrap_or_else(|_| "bita".into())
}

fn from_bita_which(cwd: &Path) -> Option<(i64, String)> {
    let value = run_json(&bita_bin(), &["repo", "which", "--json"], cwd, Duration::from_secs(5))?;
    if value["ok"] != Value::Bool(true) {
        return None;
    }
    let data = &value["data"];
    let id = data["projectId"].as_i64().or_else(|| data["project"]["id"].as_i64())?;
    let name = data["projectName"].as_str().or_else(|| data["project"]["name"].as_str())?;
    Some((id, name.to_string()))
}

fn from_scope_mapping(slug: &str) -> Option<(i64, String)> {
    let raw = std::fs::read_to_string(paths::bita_config()).ok()?;
    let config: Value = serde_json::from_str(&raw).ok()?;
    let mapping = config["scopeMapping"].as_object()?;
    let entry = match_scope(slug, mapping)?;
    Some((entry["projectId"].as_i64()?, entry["projectName"].as_str()?.to_string()))
}

pub fn refresh_bita_projects(store: &Store, cwd: &Path) -> Option<Vec<Value>> {
    let value = run_json(&bita_bin(), &["projects", "--all", "--json"], cwd, Duration::from_secs(5))?;
    let list = value["data"].as_array()?.clone();
    for project in &list {
        if let (Some(pid), Some(name)) = (project["id"].as_i64(), project["name"].as_str())
            && text::slugify(name) != GLOBAL
        {
            let key = project["key"].as_str().map(str::to_string);
            let _ = store.conn.execute(
                "INSERT INTO projects (slug, bita_id, name, key) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(slug) DO UPDATE SET bita_id = excluded.bita_id, name = excluded.name, key = COALESCE(excluded.key, projects.key)",
                params![text::slugify(name), pid, name, key],
            );
        }
    }
    Some(list)
}

fn bita_key(store: &Store, id: i64, cwd: &Path) -> Option<String> {
    if let Ok(Some(key)) = store.conn.query_row("SELECT key FROM projects WHERE bita_id = ?1 AND key IS NOT NULL", [id], |r| r.get::<_, String>(0)).optional() {
        return Some(key);
    }
    let list = refresh_bita_projects(store, cwd)?;
    list.iter().find(|p| p["id"].as_i64() == Some(id)).and_then(|p| p["key"].as_str()).map(str::to_string)
}

fn from_gaze_toml(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join("gaze.toml")).ok()?;
    let value: toml::Value = toml::from_str(&raw).ok()?;
    value.get("project")?.as_str().map(text::slugify).filter(|s| !s.is_empty())
}

pub fn remember_project(store: &Store, project: &Project) {
    if project.slug == GLOBAL {
        return;
    }
    let _ = store.conn.execute(
        "INSERT INTO projects (slug, bita_id, name, key) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(slug) DO UPDATE SET bita_id = COALESCE(excluded.bita_id, projects.bita_id), name = COALESCE(excluded.name, projects.name), key = COALESCE(excluded.key, projects.key)",
        params![project.slug, project.bita_id, project.name, project.key],
    );
}

pub fn resolve_uncached(store: &Store, cwd: &Path) -> Project {
    let Some(root) = git_root(cwd) else { return Project::global("default") };
    let slug = origin_url(&root).and_then(|u| remote_slug(&u));
    let found = from_bita_which(cwd).map(|f| (f, "bita")).or_else(|| slug.as_deref().and_then(from_scope_mapping).map(|f| (f, "scope-mapping")));
    if let Some(((id, name), source)) = found {
        let key = bita_key(store, id, cwd);
        return Project { slug: text::slugify(&name), name: Some(name), bita_id: Some(id), key, source: source.into(), repo: slug };
    }
    if let Some(project) = from_gaze_toml(&root) {
        return Project { slug: project, name: None, bita_id: None, key: None, source: "gaze.toml".into(), repo: slug };
    }
    Project { repo: slug, ..Project::global("default") }
}

pub fn resolve(store: &Store, cwd: &Path, refresh: bool) -> Result<Project> {
    if let Ok(forced) = std::env::var("GAZE_PROJECT")
        && !forced.trim().is_empty()
    {
        let slug = if forced == GLOBAL { forced } else { text::slugify(&forced) };
        return Ok(Project { slug, name: None, bita_id: None, key: None, source: "env".into(), repo: None });
    }
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let key = cwd.to_string_lossy().to_string();
    if !refresh {
        let cached: Option<(String, String, i64)> = store
            .conn
            .query_row("SELECT project, source, resolved_at FROM project_cache WHERE cwd = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        if let Some((slug, source, at)) = cached
            && now_secs() - at < CACHE_SECONDS
        {
            let meta: Option<(Option<i64>, Option<String>, Option<String>)> = store
                .conn
                .query_row("SELECT bita_id, name, key FROM projects WHERE slug = ?1", [&slug], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?;
            let (bita_id, name, project_key) = meta.unwrap_or((None, None, None));
            return Ok(Project { slug, name, bita_id, key: project_key, source: format!("cache:{source}"), repo: None });
        }
    }
    let project = resolve_uncached(store, &cwd);
    remember_project(store, &project);
    store.conn.execute(
        "INSERT INTO project_cache (cwd, project, source, resolved_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(cwd) DO UPDATE SET project = excluded.project, source = excluded.source, resolved_at = excluded.resolved_at",
        params![key, project.slug, project.source, now_secs()],
    )?;
    Ok(project)
}

pub fn project_for_name(store: &Store, name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == GLOBAL || trimmed == "_no-project" {
        return GLOBAL.into();
    }
    let group = text::slugify(trimmed);
    if store.conn.query_row("SELECT 1 FROM project_groups WHERE name = ?1 LIMIT 1", [&group], |_| Ok(())).optional().ok().flatten().is_some() {
        return group;
    }
    let by_key: Option<String> = store
        .conn
        .query_row("SELECT slug FROM projects WHERE upper(key) = upper(?1) OR lower(name) = lower(?1)", [trimmed], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    by_key.unwrap_or_else(|| text::slugify(trimmed))
}

pub fn project_for_bita_id(store: &Store, id: i64) -> Option<String> {
    store.conn.query_row("SELECT slug FROM projects WHERE bita_id = ?1", [id], |r| r.get(0)).optional().ok().flatten()
}

pub fn explicit_or_cwd(store: &Store, explicit: Option<&str>, cwd: &Path) -> Result<String> {
    match explicit.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Ok(project_for_name(store, p)),
        None => Ok(resolve(store, cwd, false)?.slug),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_group_name_wins_over_a_project_key() {
        let store = Store::in_memory().unwrap();
        store.conn.execute("INSERT INTO projects (slug, bita_id, name, key) VALUES ('app-dp-v2', 1, 'App DP v2', 'DP')", []).unwrap();
        assert_eq!(project_for_name(&store, "dp"), "app-dp-v2");
        store.set_group("dp", &["app-dp-v2".into(), "dportenis".into()]).unwrap();
        assert_eq!(project_for_name(&store, "dp"), "dp");
        assert_eq!(project_for_name(&store, "App DP v2"), "app-dp-v2");
    }

    #[test]
    fn remote_slugs_normalize() {
        assert_eq!(remote_slug("git@github.com:KikeDeAlba/bita-cli.git").as_deref(), Some("github.com/kikedealba/bita-cli"));
        assert_eq!(
            remote_slug("https://user@gitlab.com/vivaaerobus/vb_solemti/doters-sso.git").as_deref(),
            Some("gitlab.com/vivaaerobus/vb_solemti/doters-sso")
        );
        assert_eq!(remote_slug("ssh://git@git.solemti.net:2222/dportenis/recommendation").as_deref(), Some("git.solemti.net/dportenis/recommendation"));
    }

    #[test]
    fn scope_mapping_matches_longest_prefix_on_segments() {
        let mapping = json!({
            "gitlab.com/vivaaerobus": {"projectId": 1, "projectName": "Viva"},
            "gitlab.com/vivaaerobus/vb_solemti/doters-sso": {"projectId": 2, "projectName": "SSO"},
            "github.com/kike": {"projectId": 3, "projectName": "Nope"}
        });
        let map = mapping.as_object().unwrap();
        assert_eq!(match_scope("gitlab.com/vivaaerobus/vb_solemti/doters-sso", map).unwrap()["projectId"], 2);
        assert_eq!(match_scope("gitlab.com/vivaaerobus/other", map).unwrap()["projectId"], 1);
        assert!(match_scope("github.com/kikedealba/gaze", map).is_none());
    }

    #[test]
    fn resolver_uses_gaze_toml_then_global_and_caches() {
        let store = Store::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        unsafe { std::env::set_var("GAZE_BITA_BIN", "/nonexistent/bita") };
        let plain = resolve_uncached(&store, &repo.join("sub"));
        assert_eq!(plain.slug, GLOBAL);
        std::fs::write(repo.join("gaze.toml"), "project = \"Mi Proyecto\"\n").unwrap();
        let resolved = resolve(&store, &repo.join("sub"), true).unwrap();
        assert_eq!(resolved.slug, "mi-proyecto");
        assert_eq!(resolved.source, "gaze.toml");
        let cached = resolve(&store, &repo.join("sub"), false).unwrap();
        assert_eq!(cached.slug, "mi-proyecto");
        assert!(cached.source.starts_with("cache:"));
        let outside = resolve_uncached(&store, dir.path());
        assert_eq!(outside.slug, GLOBAL);
    }
}
