use serde_json::{Map, Value, json};
use std::fmt;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub struct GazeError {
    pub code: &'static str,
    pub message: String,
    pub hint: Option<String>,
}

impl GazeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), hint: None }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

impl fmt::Display for GazeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GazeError {}

pub fn not_found(what: &str) -> anyhow::Error {
    GazeError::new("NOT_FOUND", format!("No existe: {what}")).into()
}

pub fn usage(message: impl Into<String>) -> anyhow::Error {
    GazeError::new("USAGE_ERROR", message).into()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn success(command: &str, data: Value, meta: Option<Value>) -> Value {
    let mut map = Map::new();
    map.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    map.insert("ok".into(), json!(true));
    map.insert("command".into(), json!(command));
    map.insert("generatedAt".into(), json!(now()));
    if let Some(meta) = meta {
        map.insert("meta".into(), meta);
    }
    map.insert("data".into(), data);
    Value::Object(map)
}

pub fn failure(command: &str, error: &anyhow::Error) -> Value {
    let (code, message, hint) = match error.downcast_ref::<GazeError>() {
        Some(e) => (e.code, e.message.clone(), e.hint.clone()),
        None => ("INTERNAL_ERROR", format!("{error:#}"), None),
    };
    let mut err = Map::new();
    err.insert("code".into(), json!(code));
    err.insert("message".into(), json!(message));
    if let Some(hint) = hint {
        err.insert("hint".into(), json!(hint));
    }
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "ok": false,
        "command": command,
        "generatedAt": now(),
        "error": Value::Object(err),
    })
}
