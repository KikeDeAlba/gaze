use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

fn gaze(dir: &std::path::Path, args: &[&str], stdin: Option<&str>) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gaze"))
        .args(args)
        .env("GAZE_DATA_DIR", dir)
        .env("GAZE_CONFIG", dir.join("config.toml"))
        .env("GAZE_SOCKET", dir.join("s.sock"))
        .env("KIT_REGISTRY_DIR", dir.join("tools.d"))
        .env("GAZE_EMBEDDER", "fake")
        .env("GAZE_PROJECT", "den")
        .env_remove("GAZE_HARVEST")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.unwrap_or("").as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    String::from_utf8(output.stdout).unwrap()
}

fn envelope(raw: &str) -> Value {
    let value: Value = serde_json::from_str(raw.trim()).unwrap();
    for key in ["schemaVersion", "ok", "command", "generatedAt"] {
        assert!(value.get(key).is_some(), "missing {key} in {raw}");
    }
    value
}

#[test]
fn cli_contracts() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let caps = envelope(&gaze(d, &["capabilities", "--json"], None));
    let list: Vec<String> = serde_json::from_value(caps["data"]["capabilities"].clone()).unwrap();
    for needed in ["memory.search", "memory.write", "memory.graph.read"] {
        assert!(list.contains(&needed.to_string()));
    }
    assert_eq!(caps["data"]["name"], "gaze");

    let saved = envelope(&gaze(d, &["remember", "--title", "Firma", "den se firma con Developer ID, ver [[Release]]", "--json"], None));
    assert_eq!(saved["data"]["action"], "created");
    let release = envelope(&gaze(d, &["remember", "--title", "Release", "Los releases salen de main", "--json"], None));
    let id = saved["data"]["id"].as_str().unwrap();

    let found = envelope(&gaze(d, &["search", "firma developer", "--json"], None));
    let first = &found["data"][0];
    for key in ["id", "title", "kind", "project", "snippet", "score"] {
        assert!(first.get(key).is_some(), "search missing {key}");
    }
    assert_eq!(first["id"], id);

    let shown = envelope(&gaze(d, &["show", id, "--json"], None));
    assert_eq!(shown["data"]["neighbors"][0]["id"], release["data"]["id"]);
    assert_eq!(shown["data"]["neighbors"][0]["edgeKind"], "link");

    let graph = envelope(&gaze(d, &["graph", "--project", "den", "--json"], None));
    assert_eq!(graph["data"]["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(graph["data"]["edges"][0]["kind"], "link");

    let missing = envelope(&gaze(d, &["show", "nope000000", "--json"], None));
    assert_eq!(missing["ok"], false);
    assert_eq!(missing["error"]["code"], "NOT_FOUND");

    gaze(d, &["rule", "add", "Nunca uses npm", "--json"], None);
    let start: Value = serde_json::from_str(gaze(d, &["hook", "session-start"], Some("{\"session_id\":\"t\",\"cwd\":\"/\"}")).trim()).unwrap();
    let context = start["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert!(context.contains("Nunca uses npm"));
    assert_eq!(start["hookSpecificOutput"]["hookEventName"], "SessionStart");

    let setup = envelope(&gaze(d, &["setup", "--json"], None));
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(setup["data"]["manifest"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(manifest["subscribes"][0]["tool"], "bita");
    assert_eq!(manifest["manifestVersion"], 1);
}

#[test]
fn hooks_are_silent_during_harvest() {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_gaze"))
        .args(["hook", "session-start"])
        .env("GAZE_DATA_DIR", dir.path())
        .env("GAZE_HARVEST", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.stdout.is_empty());
}
