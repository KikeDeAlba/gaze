use anyhow::Result;
use serde_json::{Value, json};

use crate::config::Config;
use crate::paths;

pub const CAPABILITIES: [&str; 8] =
    ["memory.search", "memory.write", "memory.graph.read", "memory.rules", "memory.ingest", "memory.import", "memory.hooks", "mcp.stdio"];

pub const HOMEPAGE: &str = "https://github.com/KikeDeAlba/gaze";
pub const INSTALL: &str = "npm install -g @kikedealba/gaze && gaze setup";

pub fn capabilities() -> Value {
    json!({
        "name": "gaze",
        "version": env!("CARGO_PKG_VERSION"),
        "envelope": crate::envelope::SCHEMA_VERSION,
        "capabilities": CAPABILITIES,
        "emits": [],
    })
}

pub fn manifest(bin: &str) -> Value {
    json!({
        "manifestVersion": 1,
        "name": "gaze",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Per-project brain: local knowledge store with hybrid vector search for coding agents",
        "bin": [bin],
        "envelope": crate::envelope::SCHEMA_VERSION,
        "capabilities": CAPABILITIES,
        "emits": [],
        "subscribes": [
            {"tool": "bita", "events": ["stop", "amend", "delete"], "command": [bin, "bita-hook"]},
            {"tool": "inkwell", "events": ["docs.changed"], "command": [bin, "inkwell-hook"]}
        ],
        "mcp": {"stdio": [bin, "mcp"]},
        "homepage": HOMEPAGE,
        "install": INSTALL,
        "installedAt": crate::text::now_iso(),
    })
}

pub const CLAUDE_STEPS: [&str; 2] = ["claude plugin marketplace add KikeDeAlba/gaze", "claude plugin install gaze@gaze"];

pub fn setup() -> Result<Value> {
    let bin = std::env::current_exe()?.canonicalize()?.to_string_lossy().to_string();
    let registry = paths::registry_dir();
    std::fs::create_dir_all(&registry)?;
    let target = registry.join("gaze.json");
    let temporary = registry.join(format!("gaze.json.{}.tmp", std::process::id()));
    std::fs::write(&temporary, format!("{}\n", serde_json::to_string_pretty(&manifest(&bin))?))?;
    std::fs::rename(&temporary, &target)?;
    std::fs::create_dir_all(paths::data_dir())?;
    let config = paths::config_path();
    let wrote_config = if config.exists() {
        false
    } else {
        if let Some(parent) = config.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&config, Config::render_default())?;
        true
    };
    crate::store::Store::open_default()?;
    Ok(json!({
        "manifest": target,
        "config": config,
        "configCreated": wrote_config,
        "database": paths::db_path(),
        "next": ["gaze daemon install", CLAUDE_STEPS[0], CLAUDE_STEPS[1], "gaze import claude-memory --dry-run", "gaze ingest"],
    }))
}

pub fn uninstall() -> Result<Value> {
    let target = paths::registry_dir().join("gaze.json");
    let existed = target.exists();
    if existed {
        std::fs::remove_file(&target)?;
    }
    Ok(json!({
        "manifest": target,
        "removed": existed,
        "next": ["gaze daemon uninstall", "claude plugin uninstall gaze@gaze"],
        "kept": paths::db_path(),
    }))
}
