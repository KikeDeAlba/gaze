use anyhow::Result;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::PathBuf;

use crate::embed::Embedder;
use crate::project;
use crate::store::{NewNode, Scope, SearchOptions, Store};
use crate::text;

const PROTOCOL: &str = "2025-06-18";

pub fn tools() -> Value {
    json!([
        {
            "name": "gaze_search",
            "description": "Busca en el cerebro del proyecto; pasa un id para leer la nota completa.",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "project": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]}
        },
        {
            "name": "gaze_remember",
            "description": "Guarda una nota atómica durable; enlaza con [[Título]].",
            "inputSchema": {"type": "object", "properties": {"body": {"type": "string"}, "title": {"type": "string"}, "kind": {"type": "string", "enum": ["fact", "decision", "rule", "memory"]}, "project": {"type": "string"}}, "required": ["body"]}
        },
        {
            "name": "gaze_rule_add",
            "description": "Agrega una regla que se inyecta al iniciar cada sesión.",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "project": {"type": "string"}, "until": {"type": "string"}}, "required": ["text"]}
        },
        {
            "name": "gaze_link",
            "description": "Enlaza dos notas por id.",
            "inputSchema": {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}, "required": ["a", "b"]}
        }
    ])
}

pub struct Server<'a> {
    pub store: &'a Store,
    pub embedder: &'a dyn Embedder,
    pub cwd: PathBuf,
}

fn arg<'v>(args: &'v Value, key: &str) -> Option<&'v str> {
    args[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}

impl Server<'_> {
    fn project(&self, explicit: Option<&str>) -> Result<String> {
        project::explicit_or_cwd(self.store, explicit, &self.cwd)
    }

    pub fn call(&self, name: &str, args: &Value) -> Result<String> {
        match name {
            "gaze_search" => {
                let query = arg(args, "query").ok_or_else(|| crate::envelope::usage("Falta query"))?;
                if !query.contains(char::is_whitespace)
                    && let Some(node) = self.store.get(query)?
                {
                    let (node, neighbors) = self.store.show(&node.id)?;
                    let mut out = format!("[{}] {} ({} · {})\n{}", node.id, node.title, node.kind, node.project, node.body);
                    if !neighbors.is_empty() {
                        let list: Vec<String> = neighbors.iter().take(8).map(|n| format!("[{}] {} ({})", n.id, n.title, n.edge_kind)).collect();
                        out.push_str(&format!("\nRelacionadas: {}", list.join("; ")));
                    }
                    return Ok(out);
                }
                let project = self.project(arg(args, "project"))?;
                let limit = args["limit"].as_u64().unwrap_or(5).clamp(1, 20) as usize;
                let hits = self.store.search(Some(self.embedder), query, &Scope::Project(project), &SearchOptions { limit, ..Default::default() })?;
                if hits.is_empty() {
                    return Ok("Sin resultados.".into());
                }
                let ids: Vec<String> = hits.iter().map(|h| h.id.clone()).collect();
                self.store.bump_hits(&ids)?;
                Ok(hits.iter().map(|h| format!("[{}] {} ({}) — {}", h.id, h.title, h.kind, text::truncate(&h.snippet, 160))).collect::<Vec<_>>().join("\n"))
            }
            "gaze_remember" => {
                let body = arg(args, "body").ok_or_else(|| crate::envelope::usage("Falta body"))?;
                let kind = arg(args, "kind").unwrap_or("fact");
                let outcome = self.store.remember(
                    self.embedder,
                    NewNode {
                        project: self.project(arg(args, "project"))?,
                        kind: kind.into(),
                        title: arg(args, "title").map(str::to_string),
                        body: body.into(),
                        source: "claude".into(),
                        ..Default::default()
                    },
                    true,
                )?;
                Ok(format!("{} [{}] {}", outcome.action, outcome.id, outcome.title))
            }
            "gaze_rule_add" => {
                let body = arg(args, "text").ok_or_else(|| crate::envelope::usage("Falta text"))?;
                let outcome = self.store.remember(
                    self.embedder,
                    NewNode {
                        project: self.project(arg(args, "project"))?,
                        kind: "rule".into(),
                        body: body.into(),
                        source: "claude".into(),
                        until: arg(args, "until").map(str::to_string),
                        ..Default::default()
                    },
                    true,
                )?;
                Ok(format!("{} [{}] regla en {}", outcome.action, outcome.id, outcome.project))
            }
            "gaze_link" => {
                let (a, b) = (arg(args, "a").unwrap_or_default(), arg(args, "b").unwrap_or_default());
                let (first, second) = self.store.link(a, b)?;
                Ok(format!("enlazadas [{}] → [{}]", first.id, second.id))
            }
            other => Err(crate::envelope::usage(format!("Herramienta desconocida: {other}"))),
        }
    }

    pub fn handle(&self, message: &Value) -> Option<Value> {
        let id = message.get("id").cloned()?;
        let method = message["method"].as_str().unwrap_or_default();
        let result = match method {
            "initialize" => {
                let version = message["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "gaze", "version": env!("CARGO_PKG_VERSION")}
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tools()})),
            "tools/call" => {
                let name = message["params"]["name"].as_str().unwrap_or_default();
                let args = message["params"]["arguments"].clone();
                Ok(match self.call(name, &args) {
                    Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
                    Err(error) => json!({"content": [{"type": "text", "text": format!("{error:#}")}], "isError": true}),
                })
            }
            _ => Err(json!({"code": -32601, "message": format!("Method not found: {method}")})),
        };
        Some(match result {
            Ok(value) => json!({"jsonrpc": "2.0", "id": id, "result": value}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
        })
    }

    pub fn run(&self) -> Result<()> {
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        for line in stdin.lock().lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(message) => self.handle(&message),
                Err(_) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}})),
            };
            if let Some(response) = response {
                writeln!(stdout, "{response}")?;
                stdout.flush()?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;

    #[test]
    fn tools_are_minimal() {
        let tools = tools();
        let list = tools.as_array().unwrap();
        assert_eq!(list.len(), 4);
        let bytes = tools.to_string().len();
        assert!(bytes < 1400, "tool schemas too large: {bytes}");
    }

    #[test]
    fn json_rpc_round_trip() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        let server = Server { store: &store, embedder: &e, cwd: PathBuf::from("/") };
        let init = server.handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(server.handle(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none());
        let saved = server
            .handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "gaze_remember", "arguments": {"body": "El cliente paga en dólares", "project": "global"}}}))
            .unwrap();
        let text = saved["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("created ["));
        let id = &text[9..19];
        let found = server
            .handle(&json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "gaze_search", "arguments": {"query": "cliente dólares", "project": "global"}}}))
            .unwrap();
        assert!(found["result"]["content"][0]["text"].as_str().unwrap().contains(id));
        let read =
            server.handle(&json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "gaze_search", "arguments": {"query": id}}})).unwrap();
        assert!(read["result"]["content"][0]["text"].as_str().unwrap().contains("El cliente paga en dólares"));
        let missing = server.handle(&json!({"jsonrpc": "2.0", "id": 5, "method": "nope"})).unwrap();
        assert_eq!(missing["error"]["code"], -32601);
    }
}
