use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::embed::{self, Embedder, LocalModel, Mode};
use crate::paths;
use crate::project::now_secs;

pub const LABEL: &str = "com.kikedealba.gaze";
const PLIST_TEMPLATE: &str = include_str!("../contrib/launchd/com.kikedealba.gaze.plist");

fn handle(model: &dyn Embedder, request: &Value) -> Value {
    match request["op"].as_str().unwrap_or_default() {
        "ping" => json!({"ok": true, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION")}),
        "embed" => {
            let texts: Vec<String> = serde_json::from_value(request["texts"].clone()).unwrap_or_default();
            let mode = Mode::parse(request["mode"].as_str().unwrap_or("passage"));
            match model.embed(&texts, mode) {
                Ok(vectors) => json!({"ok": true, "vectors": vectors}),
                Err(error) => json!({"ok": false, "error": format!("{error:#}")}),
            }
        }
        other => json!({"ok": false, "error": format!("unknown op: {other}")}),
    }
}

fn serve_connection(model: &dyn Embedder, stream: UnixStream, last: &AtomicU64) -> Result<()> {
    let mut writer = stream.try_clone()?;
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = line?;
        last.store(now_secs() as u64, Ordering::Relaxed);
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(model, &request),
            Err(error) => json!({"ok": false, "error": format!("bad request: {error}")}),
        };
        writer.write_all(format!("{response}\n").as_bytes())?;
    }
    Ok(())
}

pub fn ping(path: &Path) -> Option<Value> {
    embed::socket_request(path, &json!({"op": "ping"}), Duration::from_secs(2)).ok()
}

pub fn serve(idle_minutes: Option<u64>) -> Result<()> {
    let socket = paths::socket_path();
    if let Some(parent) = socket.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if socket.exists() {
        if ping(&socket).is_some() {
            return Err(anyhow!("gaze serve ya corre en {}", socket.display()));
        }
        std::fs::remove_file(&socket)?;
    }
    let model: Arc<dyn Embedder> = if embed::fake_requested() { Arc::new(embed::FakeEmbedder) } else { Arc::new(LocalModel::load()?) };
    model.embed(&["warmup".to_string()], Mode::Query)?;
    let listener = UnixListener::bind(&socket).with_context(|| format!("bind {}", socket.display()))?;
    eprintln!("{} gaze serve listening on {}", crate::text::now_iso(), socket.display());
    let last = Arc::new(AtomicU64::new(now_secs() as u64));
    if let Some(minutes) = idle_minutes.filter(|m| *m > 0) {
        let last = last.clone();
        let socket = socket.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(30));
                if now_secs() as u64 - last.load(Ordering::Relaxed) > minutes * 60 {
                    let _ = std::fs::remove_file(&socket);
                    eprintln!("{} gaze serve idle, exiting", crate::text::now_iso());
                    std::process::exit(0);
                }
            }
        });
    }
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let model = model.clone();
        let last = last.clone();
        std::thread::spawn(move || {
            let _ = serve_connection(model.as_ref(), stream, &last);
        });
    }
    Ok(())
}

pub fn render_plist(bin: &str) -> String {
    PLIST_TEMPLATE.replace("{{BIN}}", bin).replace("{{HOME}}", &paths::home().to_string_lossy()).replace("{{LOG}}", &paths::serve_log().to_string_lossy())
}

fn launchctl(args: &[&str]) -> bool {
    Command::new("launchctl").args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

fn uid() -> String {
    Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|_| "501".into())
}

pub fn install() -> Result<Value> {
    let bin = std::env::current_exe()?.canonicalize()?;
    let plist = paths::launch_agent();
    std::fs::create_dir_all(plist.parent().context("plist dir")?)?;
    std::fs::create_dir_all(paths::data_dir())?;
    let domain = format!("gui/{}", uid());
    let _ = launchctl(&["bootout", &format!("{domain}/{LABEL}")]);
    std::fs::write(&plist, render_plist(&bin.to_string_lossy()))?;
    let plist_str = plist.to_string_lossy().to_string();
    let loaded = launchctl(&["bootstrap", &domain, &plist_str]) || launchctl(&["load", "-w", &plist_str]);
    if !loaded {
        return Err(anyhow!("launchctl no pudo cargar {}", plist.display()));
    }
    Ok(json!({"plist": plist, "label": LABEL, "socket": paths::socket_path()}))
}

pub fn uninstall() -> Result<Value> {
    let plist = paths::launch_agent();
    let domain = format!("gui/{}", uid());
    let _ = launchctl(&["bootout", &format!("{domain}/{LABEL}")]) || launchctl(&["unload", "-w", &plist.to_string_lossy()]);
    let existed = plist.exists();
    if existed {
        std::fs::remove_file(&plist)?;
    }
    Ok(json!({"plist": plist, "removed": existed}))
}

pub fn status() -> Value {
    let socket = paths::socket_path();
    let alive = ping(&socket);
    json!({
        "socket": socket,
        "running": alive.is_some(),
        "pid": alive.as_ref().and_then(|v| v["pid"].as_u64()),
        "launchAgent": paths::launch_agent().exists(),
    })
}
