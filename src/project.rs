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
const GLOBAL_CACHE_SECONDS: i64 = 3600;

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

struct Resolver {
    home: PathBuf,
    bita: String,
    bita_config: PathBuf,
}

impl Resolver {
    fn from_env() -> Self {
        Self { home: paths::home(), bita: bita_bin(), bita_config: paths::bita_config() }
    }
}

pub fn path_slug(dir: &Path, home: &Path) -> Option<String> {
    let rest = dir.strip_prefix(home.join("dev")).ok()?;
    let segments: Vec<String> = rest.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    (!segments.is_empty()).then(|| segments.join("/"))
}

pub(crate) fn normalize_name(value: &str) -> String {
    text::fold(value).chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '_').collect()
}

pub fn suggest_scope(slug: &str, projects: &[(i64, String)]) -> Option<(String, i64, String)> {
    let segments: Vec<&str> = slug.split('/').collect();
    let normalized: Vec<(i64, &str, String)> = projects.iter().map(|(id, name)| (*id, name.as_str(), normalize_name(name))).collect();
    for depth in (1..segments.len()).rev() {
        let segment = normalize_name(segments[depth]);
        if segment.is_empty() {
            continue;
        }
        let pick = |matches: &dyn Fn(&str) -> bool| {
            let mut found: Vec<(i64, &str)> = normalized.iter().filter(|(_, _, n)| matches(n)).map(|(id, name, _)| (*id, *name)).collect();
            found.sort_by_key(|(id, _)| *id);
            found.dedup_by_key(|(id, _)| *id);
            found
        };
        let exact = pick(&|n| n == segment);
        let candidates = if exact.is_empty() && segment.chars().count() >= 4 { pick(&|n| n.starts_with(&segment)) } else { exact };
        match candidates.as_slice() {
            [] => continue,
            [(id, name)] => return Some((segments[..=depth].join("/"), *id, name.to_string())),
            _ => return None,
        }
    }
    None
}

fn from_bita_which(bin: &str, cwd: &Path) -> Option<(i64, String)> {
    let value = run_json(bin, &["repo", "which", "--json"], cwd, Duration::from_secs(5))?;
    if value["ok"] != Value::Bool(true) {
        return None;
    }
    let data = &value["data"];
    let id = data["projectId"].as_i64().or_else(|| data["project"]["id"].as_i64())?;
    let name = data["projectName"].as_str().or_else(|| data["project"]["name"].as_str())?;
    Some((id, name.to_string()))
}

fn from_scope_mapping(config: &Path, slug: &str) -> Option<(i64, String)> {
    let raw = std::fs::read_to_string(config).ok()?;
    let config: Value = serde_json::from_str(&raw).ok()?;
    let mapping = config["scopeMapping"].as_object()?;
    let entry = match_scope(slug, mapping)?;
    Some((entry["projectId"].as_i64()?, entry["projectName"].as_str()?.to_string()))
}

pub fn refresh_bita_projects(store: &Store, cwd: &Path) -> Option<Vec<Value>> {
    refresh_projects_with(store, cwd, &bita_bin())
}

fn refresh_projects_with(store: &Store, cwd: &Path, bin: &str) -> Option<Vec<Value>> {
    let value = run_json(bin, &["projects", "--all", "--json"], cwd, Duration::from_secs(5))?;
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

fn bita_key(store: &Store, id: i64, cwd: &Path, bin: &str) -> Option<String> {
    if let Ok(Some(key)) = store.conn.query_row("SELECT key FROM projects WHERE bita_id = ?1 AND key IS NOT NULL", [id], |r| r.get::<_, String>(0)).optional() {
        return Some(key);
    }
    let list = refresh_projects_with(store, cwd, bin)?;
    list.iter().find(|p| p["id"].as_i64() == Some(id)).and_then(|p| p["key"].as_str()).map(str::to_string)
}

fn from_gaze_toml(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join("gaze.toml")).ok()?;
    let value: toml::Value = toml::from_str(&raw).ok()?;
    value.get("project")?.as_str().map(text::slugify).filter(|s| !s.is_empty())
}

fn known_projects(store: &Store) -> Vec<(i64, String)> {
    let Ok(mut stmt) = store.conn.prepare("SELECT bita_id, name FROM projects WHERE bita_id IS NOT NULL AND name IS NOT NULL ORDER BY bita_id") else {
        return Vec::new();
    };
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

fn auto_scope(store: &Store, cwd: &Path, slug: &str, bin: &str) -> Option<((i64, String), &'static str)> {
    let (prefix, id, name) = suggest_scope(slug, &known_projects(store)).or_else(|| {
        refresh_projects_with(store, cwd, bin)?;
        suggest_scope(slug, &known_projects(store))
    })?;
    let id_arg = id.to_string();
    let saved = run_json(bin, &["scope", "set", &prefix, &id_arg, "--json"], cwd, Duration::from_secs(5)).is_some_and(|v| v["ok"] == Value::Bool(true));
    let source = if saved { "auto-scope" } else { "suggestion" };
    eprintln!("{source} {prefix} -> {name} ({id})");
    Some(((id, name), source))
}

fn gaze_toml_upward(cwd: &Path, home: &Path) -> Option<String> {
    let dev = home.join("dev");
    if !cwd.starts_with(&dev) {
        return from_gaze_toml(cwd);
    }
    cwd.ancestors().take_while(|dir| dir.starts_with(&dev)).find_map(from_gaze_toml)
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
    resolve_with(store, cwd, &Resolver::from_env())
}

fn resolve_with(store: &Store, cwd: &Path, env: &Resolver) -> Project {
    let root = git_root(cwd);
    let slug = match &root {
        Some(root) => origin_url(root).and_then(|u| remote_slug(&u)).or_else(|| path_slug(root, &env.home)),
        None => path_slug(cwd, &env.home),
    };
    let found = root
        .as_ref()
        .and_then(|_| from_bita_which(&env.bita, cwd))
        .map(|f| (f, "bita"))
        .or_else(|| slug.as_deref().and_then(|s| from_scope_mapping(&env.bita_config, s)).map(|f| (f, "scope-mapping")))
        .or_else(|| slug.as_deref().and_then(|s| auto_scope(store, cwd, s, &env.bita)));
    if let Some(((id, name), source)) = found {
        let key = bita_key(store, id, cwd, &env.bita);
        return Project { slug: text::slugify(&name), name: Some(name), bita_id: Some(id), key, source: source.into(), repo: slug };
    }
    let toml = match &root {
        Some(root) => from_gaze_toml(root),
        None => gaze_toml_upward(cwd, &env.home),
    };
    if let Some(project) = toml {
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
            && now_secs() - at < if slug == GLOBAL { GLOBAL_CACHE_SECONDS } else { CACHE_SECONDS }
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

    fn projects(list: &[(i64, &str)]) -> Vec<(i64, String)> {
        list.iter().map(|(id, name)| (*id, name.to_string())).collect()
    }

    fn fake_home() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap().join("home");
        let folder = home.join("dev/github.com/KikeDeAlba");
        std::fs::create_dir_all(folder.join("gaze/.git")).unwrap();
        (dir, home, folder)
    }

    #[test]
    fn path_slugs_are_relative_to_dev_and_lowercased() {
        let home = Path::new("/Users/me");
        assert_eq!(path_slug(Path::new("/Users/me/dev/github.com/KikeDeAlba"), home).as_deref(), Some("github.com/kikedealba"));
        assert_eq!(path_slug(Path::new("/Users/me/dev/GitLab.com/Viva/SSO"), home).as_deref(), Some("gitlab.com/viva/sso"));
        assert_eq!(path_slug(Path::new("/Users/me/dev"), home), None);
        assert_eq!(path_slug(Path::new("/Users/me/Documents/x"), home), None);
        assert_eq!(path_slug(Path::new("/Users/me/devtools/x"), home), None);
    }

    #[test]
    fn suggest_scope_matches_exact_and_long_prefixes() {
        let list = projects(&[(7, "KikeDeAlba Modules"), (8, "Gaze"), (9, "Doters SSO")]);
        assert_eq!(suggest_scope("github.com/kikedealba", &list), Some(("github.com/kikedealba".into(), 7, "KikeDeAlba Modules".into())));
        assert_eq!(suggest_scope("github.com/kikedealba/gaze", &list), Some(("github.com/kikedealba/gaze".into(), 8, "Gaze".into())));
        assert_eq!(suggest_scope("gitlab.com/viva/doters_sso", &list), Some(("gitlab.com/viva/doters_sso".into(), 9, "Doters SSO".into())));
        assert_eq!(suggest_scope("github.com/kikedealba/other", &list).map(|s| s.1), Some(7));
        assert_eq!(suggest_scope("gaze", &list), None);
    }

    #[test]
    fn suggest_scope_folds_accents_and_rejects_short_or_ambiguous() {
        let list = projects(&[(1, "Logística Norte"), (2, "App One"), (3, "App Two"), (4, "Zip")]);
        assert_eq!(suggest_scope("gitlab.com/acme/logistica-norte", &list).map(|s| s.1), Some(1));
        assert_eq!(suggest_scope("gitlab.com/acme/appone", &list).map(|s| s.1), Some(2));
        assert_eq!(suggest_scope("gitlab.com/acme/app", &list), None);
        assert_eq!(suggest_scope("gitlab.com/zip/x", &list).map(|s| (s.0, s.1)), Some(("gitlab.com/zip".into(), 4)));
        assert_eq!(suggest_scope("gitlab.com/log/x", &list), None);
        let twins = projects(&[(5, "Apartados Web"), (6, "Apartados Api")]);
        assert_eq!(suggest_scope("gitlab.com/zip/apartados", &[twins.clone(), list.clone()].concat()), None);
    }

    #[test]
    fn suggest_scope_never_matches_the_host_segment() {
        let list = projects(&[(1, "Github Com"), (2, "Github")]);
        assert_eq!(suggest_scope("github.com/zzzz", &list), None);
        assert_eq!(suggest_scope("github/zzzz", &list), None);
    }

    #[test]
    fn repo_without_remote_resolves_from_nested_directories() {
        let store = Store::in_memory().unwrap();
        let (dir, home, folder) = fake_home();
        let nested = folder.join("gaze/src/deep/er");
        std::fs::create_dir_all(&nested).unwrap();
        let config = dir.path().join("config.json");
        std::fs::write(&config, json!({"scopeMapping": {"github.com/kikedealba/gaze": {"projectId": 8, "projectName": "Gaze"}}}).to_string()).unwrap();
        let env = Resolver { home, bita: "/nonexistent/bita".into(), bita_config: config };
        let resolved = resolve_with(&store, &nested, &env);
        assert_eq!(resolved.slug, "gaze");
        assert_eq!(resolved.source, "scope-mapping");
        assert_eq!(resolved.repo.as_deref(), Some("github.com/kikedealba/gaze"));
    }

    #[test]
    fn folder_outside_a_repo_uses_the_scope_mapping() {
        let store = Store::in_memory().unwrap();
        let (dir, home, folder) = fake_home();
        let config = dir.path().join("config.json");
        std::fs::write(&config, json!({"scopeMapping": {"github.com/kikedealba": {"projectId": 7, "projectName": "KikeDeAlba Modules"}}}).to_string()).unwrap();
        let env = Resolver { home, bita: "/nonexistent/bita".into(), bita_config: config };
        let resolved = resolve_with(&store, &folder, &env);
        assert_eq!(resolved.slug, "kikedealba-modules");
        assert_eq!(resolved.source, "scope-mapping");
        assert_eq!(resolved.bita_id, Some(7));
        assert_eq!(resolved.repo.as_deref(), Some("github.com/kikedealba"));
    }

    #[test]
    fn folder_outside_a_repo_creates_the_scope_automatically() {
        use std::os::unix::fs::PermissionsExt;
        let store = Store::in_memory().unwrap();
        let (dir, home, folder) = fake_home();
        let calls = dir.path().join("calls");
        let script = dir.path().join("bita");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ncase \"$1\" in\nprojects) echo '{{\"ok\":true,\"data\":[{{\"id\":7,\"name\":\"KikeDeAlba Modules\",\"key\":\"KM\"}}]}}' ;;\nscope) echo \"$@\" > '{}'; echo '{{\"ok\":true}}' ;;\nesac\n",
                calls.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = Resolver { home, bita: script.to_string_lossy().into(), bita_config: dir.path().join("missing.json") };
        let resolved = resolve_with(&store, &folder, &env);
        assert_eq!(resolved.slug, "kikedealba-modules");
        assert_eq!(resolved.source, "auto-scope");
        assert_eq!(resolved.key.as_deref(), Some("KM"));
        assert_eq!(std::fs::read_to_string(&calls).unwrap().trim(), "scope set github.com/kikedealba 7 --json");
    }

    #[test]
    fn folder_outside_a_repo_finds_gaze_toml_upward_within_dev() {
        let store = Store::in_memory().unwrap();
        let (dir, home, folder) = fake_home();
        std::fs::create_dir_all(folder.join("notes")).unwrap();
        std::fs::write(home.join("dev/gaze.toml"), "project = \"Dev Wide\"\n").unwrap();
        let env = Resolver { home: home.clone(), bita: "/nonexistent/bita".into(), bita_config: dir.path().join("missing.json") };
        let resolved = resolve_with(&store, &folder.join("notes"), &env);
        assert_eq!(resolved.slug, "dev-wide");
        assert_eq!(resolved.source, "gaze.toml");
        std::fs::write(home.join("gaze.toml"), "project = \"Too High\"\n").unwrap();
        std::fs::remove_file(home.join("dev/gaze.toml")).unwrap();
        assert_eq!(resolve_with(&store, &folder, &env).slug, GLOBAL);
    }

    #[test]
    fn global_cache_entries_expire_after_an_hour() {
        let store = Store::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let key = cwd.to_string_lossy().to_string();
        let insert = |project: &str, age: i64| {
            store
                .conn
                .execute(
                    "INSERT INTO project_cache (cwd, project, source, resolved_at) VALUES (?1, ?2, 'test', ?3)
                     ON CONFLICT(cwd) DO UPDATE SET project = excluded.project, source = excluded.source, resolved_at = excluded.resolved_at",
                    params![key, project, now_secs() - age],
                )
                .unwrap();
        };
        insert(GLOBAL, 2 * 3600);
        assert!(!resolve(&store, &cwd, false).unwrap().source.starts_with("cache:"));
        insert("den", 2 * 3600);
        assert_eq!(resolve(&store, &cwd, false).unwrap().source, "cache:test");
        insert(GLOBAL, 60);
        assert_eq!(resolve(&store, &cwd, false).unwrap().source, "cache:test");
    }
}
