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
        .env("INKWELL_DOCS_DIR", dir.join("docs"))
        .env("INKWELL_DB_PATH", dir.join("inkwell.db"))
        .env("GAZE_PROJECT", "den")
        .env("GAZE_BITA_BIN", "/nonexistent/bita")
        .env_remove("GAZE_HARVEST")
        .env_remove("KIT_HEADLESS")
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
    let gemini: Value =
        serde_json::from_str(gaze(d, &["hook", "session-start", "--harness", "gemini"], Some("{\"session_id\":\"g\",\"cwd\":\"/\"}")).trim()).unwrap();
    assert!(gemini["hookSpecificOutput"]["additionalContext"].as_str().unwrap().contains("Nunca uses npm"));

    let setup = envelope(&gaze(d, &["setup", "--json"], None));
    let next = setup["data"]["next"].to_string();
    assert!(!next.contains("claude plugin"), "{next}");
    assert!(next.contains("gaze daemon install"));
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(setup["data"]["manifest"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(manifest["subscribes"][0]["tool"], "bita");
    assert_eq!(manifest["subscribes"][1]["tool"], "inkwell");
    assert_eq!(manifest["subscribes"][1]["events"][0], "docs.changed");
    assert_eq!(manifest["subscribes"][1]["command"][1], "inkwell-hook");
    assert_eq!(manifest["manifestVersion"], 1);
    assert_eq!(manifest["install"], "npm install -g @kikedealba/gaze && gaze setup");
    let native = std::fs::canonicalize(env!("CARGO_BIN_EXE_gaze")).unwrap();
    assert_eq!(manifest["bin"][0], native.to_string_lossy().as_ref());
    assert_eq!(manifest["mcp"]["stdio"][0], manifest["bin"][0]);
}

#[test]
fn inkwell_hook_ingests_docs_changed_events() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let docs = d.join("docs");
    std::fs::create_dir_all(docs.join("dp")).unwrap();
    std::fs::write(docs.join("dp/infra.md"), "---\ntitle: Infraestructura\n---\n\nCuenta AWS de producción.\n").unwrap();
    let event = serde_json::json!({
        "docsRoot": docs, "commit": null, "kind": "page",
        "changes": [{"action": "written", "relPath": "dp/infra.md"}, {"action": "written", "relPath": "../x.md"}],
        "event": "docs.changed", "source": "inkwell", "firedAt": "2026-10-18T00:00:00Z"
    });
    let out = gaze(d, &["inkwell-hook"], Some(&event.to_string()));
    let summary: Value = serde_json::from_str(out.trim().split_once(' ').unwrap().1.trim_start_matches("inkwell-hook ")).unwrap();
    assert_eq!(summary["changes"][0]["result"], "created");
    assert_eq!(summary["changes"][1]["result"], "ignored");
    let found = envelope(&gaze(d, &["search", "cuenta aws", "--project", "global", "--json"], None));
    assert_eq!(found["data"][0]["title"], "Infraestructura");
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

#[test]
fn hooks_are_silent_inside_a_kit_headless_run() {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_gaze"))
        .args(["hook", "prompt", "--harness", "codex"])
        .env("GAZE_DATA_DIR", dir.path())
        .env("GAZE_EMBEDDER", "fake")
        .env_remove("GAZE_HARVEST")
        .env("KIT_HEADLESS", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.stdout.is_empty());
    assert!(!dir.path().join("gaze.db").exists());
}

#[test]
fn inkwell_hook_survives_garbage_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    for payload in [
        "",
        "not json",
        "{",
        "[]",
        "null",
        "\"docs\"",
        "{\"event\":\"docs.changed\"}",
        "{\"event\":\"docs.changed\",\"changes\":\"x\"}",
        "{\"event\":\"docs.changed\",\"changes\":[null,1,{}]}",
    ] {
        let out = gaze(d, &["inkwell-hook"], Some(payload));
        assert!(out.contains("inkwell-hook"), "payload {payload:?} gave {out:?}");
    }
    let found = envelope(&gaze(d, &["search", "nada", "--json"], None));
    assert_eq!(found["data"].as_array().unwrap().len(), 0);
}

#[test]
fn inkwell_hook_exits_non_zero_when_a_change_fails() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let docs = d.join("docs");
    std::fs::create_dir_all(docs.join("dp")).unwrap();
    std::fs::write(docs.join("dp/bad.md"), [0xff, 0xfe, 0x00]).unwrap();
    std::fs::write(docs.join("dp/ok.md"), "# Ok\n\nBien.\n").unwrap();
    let run = |relpaths: &[&str]| {
        let changes: Vec<Value> = relpaths.iter().map(|rel| serde_json::json!({"action": "written", "relPath": rel})).collect();
        let event = serde_json::json!({"event": "docs.changed", "docsRoot": docs, "changes": changes});
        let mut child = Command::new(env!("CARGO_BIN_EXE_gaze"))
            .arg("inkwell-hook")
            .env("GAZE_DATA_DIR", d)
            .env("GAZE_CONFIG", d.join("config.toml"))
            .env("GAZE_SOCKET", d.join("s.sock"))
            .env("GAZE_EMBEDDER", "fake")
            .env("GAZE_BITA_BIN", "/nonexistent/bita")
            .env("INKWELL_DOCS_DIR", &docs)
            .env("INKWELL_DB_PATH", d.join("inkwell.db"))
            .env_remove("GAZE_HARVEST")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(event.to_string().as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    };
    let failed = run(&["dp/bad.md", "dp/ok.md"]);
    assert_eq!(failed.status.code(), Some(1));
    let out = String::from_utf8(failed.stdout).unwrap();
    let summary: Value = serde_json::from_str(out.trim().split_once(' ').unwrap().1.trim_start_matches("inkwell-hook ")).unwrap();
    assert_eq!(summary["failed"], 1);
    assert_eq!(summary["changes"][1]["result"], "created");
    assert!(run(&["dp/ok.md"]).status.success());
}

#[cfg(unix)]
#[test]
fn serve_detach_logs_to_the_file_and_stops_on_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("d.sock");
    let log = dir.path().join("logs/serve.log");
    let out = Command::new(env!("CARGO_BIN_EXE_gaze"))
        .args(["serve", "--detach", "--log"])
        .arg(&log)
        .env("GAZE_DATA_DIR", dir.path())
        .env("GAZE_SOCKET", &socket)
        .env("GAZE_EMBEDDER", "fake")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let started = std::time::Instant::now();
    while gaze::daemon::ping(&socket).is_none() {
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "daemon never answered");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(gaze::daemon::shutdown(&socket));
    let started = std::time::Instant::now();
    while gaze::daemon::ping(&socket).is_some() {
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "daemon kept running");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(std::fs::read_to_string(&log).unwrap().contains("gaze serve listening on"));
}
