use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::embed::{self, Embedder, SocketEmbedder};
use crate::paths;
use crate::project;
use crate::store::{GLOBAL, Hit, NewNode, Node, Scope, SearchOptions, Store};
use crate::text::{self, estimate_tokens};

pub const HARVEST_ENV: &str = "GAZE_HARVEST";

pub const BRAIN_LINE: &str = "gaze: este proyecto tiene cerebro. Antes de preguntarle al usuario datos del proyecto, búscalos con gaze_search; guarda con gaze_remember decisiones, correcciones, convenciones y datos del cliente o de infra como notas atómicas con [[enlaces]].";

const TRIVIAL: [&str; 24] = [
    "ok",
    "okay",
    "sí",
    "si",
    "no",
    "gracias",
    "dale",
    "va",
    "listo",
    "continua",
    "continúa",
    "sigue",
    "perfecto",
    "excelente",
    "yes",
    "thanks",
    "continue",
    "go",
    "go ahead",
    "hazlo",
    "adelante",
    "commit",
    "push",
    "y",
];

const FILLER: [&str; 22] = [
    "continua",
    "sigue",
    "favor",
    "porfa",
    "gracias",
    "perfecto",
    "dale",
    "listo",
    "okay",
    "bien",
    "hazlo",
    "adelante",
    "procede",
    "thanks",
    "continue",
    "please",
    "great",
    "good",
    "vale",
    "va",
    "excelente",
    "sale",
];

pub fn disabled() -> bool {
    std::env::var(HARVEST_ENV).map(|v| !v.is_empty() && v != "0").unwrap_or(false)
}

pub fn read_input() -> Value {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

fn input_cwd(input: &Value) -> PathBuf {
    input["cwd"]
        .as_str()
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")))
}

fn session_id(input: &Value) -> String {
    input["session_id"].as_str().unwrap_or("unknown").to_string()
}

pub fn hook_output(event: &str, context: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}})
}

pub fn rule_line(rule: &Node) -> String {
    let body = text::one_line(&rule.body);
    let text = if text::fold(&body).starts_with(&text::fold(rule.title.trim_end_matches('…'))) || rule.title.is_empty() {
        body
    } else {
        format!("{}: {}", rule.title, body)
    };
    format!("- {}", text::truncate(&text, 220))
}

pub fn session_context(rules: &[Node], budget: usize) -> String {
    let mut out = String::from(BRAIN_LINE);
    if rules.is_empty() {
        return out;
    }
    out.push_str("\nReglas activas:");
    let mut used = 0;
    let mut shown = 0;
    for rule in rules {
        let line = rule_line(rule);
        let cost = estimate_tokens(&line) + 1;
        if used + cost > budget {
            break;
        }
        out.push('\n');
        out.push_str(&line);
        used += cost;
        shown += 1;
    }
    let rest = rules.len() - shown;
    if rest > 0 {
        out.push_str(&format!("\n{rest} reglas más: gaze rule ls"));
    }
    out
}

pub fn session_start(store: &Store, input: &Value) -> Result<Option<Value>> {
    let started = Instant::now();
    let cwd = input_cwd(input);
    let project = project::resolve(store, &cwd, false)?;
    let rules = store.active_rules(&project.slug)?;
    let context = session_context(&rules, store.cfg.hooks.rules_tokens);
    let ids: Vec<String> = rules.iter().map(|r| r.id.clone()).collect();
    let _ = store.record_injection(&session_id(input), "session-start", &ids, estimate_tokens(&context), started.elapsed().as_millis());
    Ok(Some(hook_output("SessionStart", &context)))
}

pub fn trivial_prompt(prompt: &str, min_chars: usize) -> bool {
    let trimmed = prompt.trim();
    if trimmed.chars().count() < min_chars || trimmed.starts_with('/') || trimmed.starts_with('!') {
        return true;
    }
    let folded = text::fold(trimmed.trim_end_matches(['.', '!', '?']));
    if TRIVIAL.iter().any(|t| text::fold(t) == folded) {
        return true;
    }
    let terms = text::terms(trimmed);
    terms.len() < 2 || terms.iter().all(|t| FILLER.contains(&t.as_str()))
}

pub fn pointer_line(hit: &Hit) -> String {
    let summary = text::first_line_summary(&hit.body, &hit.title, 90);
    let title = text::truncate(&hit.title, 70);
    if summary.is_empty() { format!("[{}] {}", hit.id, title) } else { format!("[{}] {} — {}", hit.id, title, summary) }
}

#[derive(Debug, Clone, Copy)]
pub struct Gate {
    pub semantic: bool,
    pub threshold: f32,
    pub margin: f32,
    pub lexical_threshold: f32,
    pub floor: f32,
}

impl Gate {
    pub fn floor_of(hits: &[Hit]) -> f32 {
        let mut sims: Vec<f32> = hits.iter().filter_map(|h| h.similarity).collect();
        if sims.len() < 3 {
            return 0.0;
        }
        sims.sort_by(|a, b| b.total_cmp(a));
        sims.truncate(10);
        sims[sims.len() / 2]
    }

    pub fn passes(&self, hit: &Hit) -> bool {
        if self.semantic {
            let similarity = hit.similarity.unwrap_or(0.0);
            similarity >= self.threshold && similarity - self.floor >= self.margin && hit.coverage >= 0.25
        } else {
            hit.coverage >= self.lexical_threshold && hit.title_coverage >= 0.2
        }
    }
}

pub fn select_pointers(hits: &[Hit], gate: Gate, max: usize, budget: usize) -> (String, Vec<String>) {
    let header = "gaze: notas quizá útiles (léelas con gaze_search \"<id>\"):";
    let mut used = estimate_tokens(header);
    let mut lines = Vec::new();
    let mut ids = Vec::new();
    for hit in hits {
        if !gate.passes(hit) {
            continue;
        }
        let line = pointer_line(hit);
        let cost = estimate_tokens(&line) + 1;
        if used + cost > budget {
            break;
        }
        used += cost;
        lines.push(line);
        ids.push(hit.id.clone());
        if lines.len() >= max {
            break;
        }
    }
    if lines.is_empty() {
        return (String::new(), ids);
    }
    (format!("{header}\n{}", lines.join("\n")), ids)
}

fn spawn_daemon() {
    let marker = paths::data_dir().join("serve.spawned");
    let recent = std::fs::metadata(&marker).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e < Duration::from_secs(120));
    if recent {
        return;
    }
    let _ = std::fs::create_dir_all(paths::data_dir());
    let _ = std::fs::write(&marker, b"");
    if let Ok(exe) = std::env::current_exe() {
        let log = std::fs::OpenOptions::new().create(true).append(true).open(paths::serve_log()).ok();
        let mut command = Command::new(exe);
        command.args(["serve", "--idle-minutes", "120"]).stdin(Stdio::null());
        match log.and_then(|l| l.try_clone().ok().map(|c| (l, c))) {
            Some((out, err)) => command.stdout(out).stderr(err),
            None => command.stdout(Stdio::null()).stderr(Stdio::null()),
        };
        detach(&mut command);
        let _ = command.spawn();
    }
}

pub fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

pub fn prompt(store: &Store, input: &Value) -> Result<Option<Value>> {
    let started = Instant::now();
    let prompt = input["prompt"].as_str().unwrap_or_default();
    let cfg = &store.cfg.hooks;
    if trivial_prompt(prompt, cfg.prompt_min_chars) {
        return Ok(None);
    }
    let cwd = input_cwd(input);
    let project = project::resolve(store, &cwd, false)?;
    let session = session_id(input);
    let already = store.injected(&session)?;

    let socket = paths::socket_path();
    let semantic = embed::fake_requested() || embed::socket_alive(&socket);
    let remote = SocketEmbedder { path: socket, timeout: Duration::from_millis(1500) };
    let fake = embed::FakeEmbedder;
    let embedder: Option<&dyn Embedder> = if embed::fake_requested() {
        Some(&fake)
    } else if semantic {
        Some(&remote)
    } else {
        spawn_daemon();
        None
    };
    let query = text::truncate(prompt, 1500);
    let options = SearchOptions { limit: 10, exclude_kinds: vec!["rule".into()], ..Default::default() };
    let found = store.search(embedder, &query, &Scope::Project(project.slug.clone()), &options)?;
    let gate = Gate {
        semantic,
        threshold: cfg.prompt_threshold,
        margin: cfg.prompt_margin,
        lexical_threshold: cfg.prompt_lexical_threshold,
        floor: Gate::floor_of(&found),
    };
    let mut hits: Vec<Hit> = found.into_iter().filter(|h| !already.contains(&h.id)).collect();
    if semantic {
        hits.sort_by(|a, b| b.similarity.unwrap_or(0.0).total_cmp(&a.similarity.unwrap_or(0.0)));
    }
    let (context, ids) = select_pointers(&hits, gate, cfg.prompt_max, cfg.prompt_tokens);
    if ids.is_empty() {
        let _ = store.record_injection(&session, "prompt", &[], 0, started.elapsed().as_millis());
        return Ok(None);
    }
    store.record_injection(&session, "prompt", &ids, estimate_tokens(&context), started.elapsed().as_millis())?;
    Ok(Some(hook_output("UserPromptSubmit", &context)))
}

pub fn harvest(input: &Value) -> Result<()> {
    let Some(transcript) = input["transcript_path"].as_str() else { return Ok(()) };
    let exe = std::env::current_exe()?;
    let _ = std::fs::create_dir_all(paths::data_dir());
    let log = std::fs::OpenOptions::new().create(true).append(true).open(paths::harvest_log())?;
    let mut command = Command::new(exe);
    command
        .args(["harvest-run", "--transcript", transcript, "--session", &session_id(input), "--cwd"])
        .arg(input_cwd(input))
        .env(HARVEST_ENV, "1")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    detach(&mut command);
    command.spawn()?;
    Ok(())
}

fn strip_tags(text: &str) -> String {
    let mut out = text.to_string();
    for tag in ["system-reminder", "local-command-stdout", "local-command-stderr", "command-message", "command-args", "task-notification"] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        while let Some(start) = out.find(&open) {
            match out[start..].find(&close) {
                Some(end) => out.replace_range(start..start + end + close.len(), ""),
                None => {
                    out.truncate(start);
                    break;
                }
            }
        }
    }
    out.trim().to_string()
}

pub fn transcript_text(path: &Path, skip_lines: usize) -> Result<(String, usize)> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut out = String::new();
    let mut count = 0;
    for line in BufReader::new(file).lines() {
        let line = line?;
        count += 1;
        if count <= skip_lines {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
        let role = entry["type"].as_str().unwrap_or_default();
        if !(role == "user" || role == "assistant") || entry["isSidechain"] == json!(true) || entry["isMeta"] == json!(true) {
            continue;
        }
        let content = &entry["message"]["content"];
        let mut parts: Vec<String> = Vec::new();
        if let Some(s) = content.as_str() {
            parts.push(s.to_string());
        } else if let Some(items) = content.as_array() {
            for item in items {
                if item["type"] == json!("text")
                    && let Some(t) = item["text"].as_str()
                {
                    parts.push(t.to_string());
                }
            }
        }
        let joined = strip_tags(&parts.join("\n"));
        if joined.is_empty() {
            continue;
        }
        let label = if role == "user" { "USER" } else { "ASSISTANT" };
        out.push_str(&format!("{label}: {joined}\n\n"));
    }
    Ok((out, count))
}

pub fn harvest_prompt(project: &str, transcript: &str) -> String {
    format!(
        "Extrae aprendizajes DURADEROS de esta conversación de trabajo (proyecto: {project}). \
Solo: decisiones tomadas, correcciones del usuario, convenciones del proyecto, datos del cliente o de infraestructura. \
Nada efímero (estado de la tarea, pasos ya hechos, errores resueltos sin lección, saludos). \
Cada nota atómica: un solo hecho, autocontenida, en el idioma de la conversación, título corto, cuerpo de 1 a 3 frases; usa [[Título]] para enlazar notas relacionadas. \
kind: decision | fact | rule (rule solo si el usuario dio una instrucción permanente). \
project: omítelo salvo que el hecho sea general del usuario (usa \"global\"). \
Responde SOLO un arreglo JSON: [{{\"kind\":\"...\",\"title\":\"...\",\"body\":\"...\",\"project\":\"...\"}}]. Si no hay nada durable, responde [].\n\n\
<conversation>\n{transcript}\n</conversation>"
    )
}

pub fn parse_learnings(raw: &str) -> Vec<Value> {
    let text = serde_json::from_str::<Value>(raw).ok().and_then(|v| v["result"].as_str().map(str::to_string)).unwrap_or_else(|| raw.to_string());
    let (Some(start), Some(end)) = (text.find('['), text.rfind(']')) else { return Vec::new() };
    if end < start {
        return Vec::new();
    }
    serde_json::from_str::<Vec<Value>>(&text[start..=end]).unwrap_or_default()
}

fn log(message: &str) {
    println!("{} {message}", text::now_iso());
}

pub fn harvest_run(store: &Store, emb: &dyn Embedder, transcript: &Path, session: &str, cwd: &Path) -> Result<()> {
    let cfg = store.cfg.harvest.clone();
    if !cfg.enabled {
        return Ok(());
    }
    let done: usize =
        store.conn.query_row("SELECT lines FROM harvests WHERE session_id = ?1", [session], |r| r.get::<_, i64>(0)).map(|n| n as usize).unwrap_or(0);
    let (conversation, total) = transcript_text(transcript, done)?;
    if conversation.chars().count() < cfg.min_chars {
        log(&format!("harvest {session}: nothing new ({} chars)", conversation.chars().count()));
        return Ok(());
    }
    let chars: Vec<char> = conversation.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(cfg.max_chars)..].iter().collect();
    let project = project::resolve(store, cwd, false)?;
    let prompt = harvest_prompt(&project.slug, &tail);
    let claude = std::env::var("GAZE_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    let mut child = Command::new(&claude)
        .args([
            "-p",
            "--model",
            &cfg.model,
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--disable-slash-commands",
        ])
        .env(HARVEST_ENV, "1")
        .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")
        .env("BITA_NO_HOOKS", "1")
        .env("KIT_NO_EVENTS", "1")
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn {claude}"))?;
    child.stdin.take().context("stdin")?.write_all(prompt.as_bytes())?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(cfg.timeout_seconds) {
            let _ = child.kill();
            log(&format!("harvest {session}: claude timed out"));
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let output = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        log(&format!("harvest {session}: claude failed: {}", text::truncate(&String::from_utf8_lossy(&output.stderr), 300)));
        return Ok(());
    }
    let learnings = parse_learnings(&stdout);
    let mut saved = Vec::new();
    for item in learnings.into_iter().take(cfg.max_items) {
        let kind = item["kind"].as_str().unwrap_or("fact");
        let kind = if ["decision", "fact", "rule"].contains(&kind) { kind } else { "fact" };
        let Some(body) = item["body"].as_str().filter(|b| b.trim().len() > 10) else { continue };
        let target = match item["project"].as_str().map(str::trim).filter(|p| !p.is_empty()) {
            Some(GLOBAL) => GLOBAL.to_string(),
            _ => project.slug.clone(),
        };
        let outcome = store.remember(
            emb,
            NewNode {
                project: target,
                kind: kind.into(),
                title: item["title"].as_str().map(str::to_string),
                body: body.to_string(),
                source: "harvest".into(),
                ..Default::default()
            },
            true,
        )?;
        saved.push(format!("{}:{}", outcome.action, outcome.id));
    }
    store.conn.execute(
        "INSERT INTO harvests (session_id, lines, at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET lines = excluded.lines, at = excluded.at",
        rusqlite::params![session, total as i64, text::now_iso()],
    )?;
    log(&format!(
        "harvest {session} [{}] {} chars -> {}",
        project.slug,
        tail.chars().count(),
        if saved.is_empty() { "nothing".into() } else { saved.join(", ") }
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;

    fn rule(project: &str, title: &str, body: &str, pinned: bool) -> NewNode {
        NewNode {
            project: project.into(),
            kind: "rule".into(),
            title: Some(title.into()),
            body: body.into(),
            source: "user".into(),
            pinned,
            ..Default::default()
        }
    }

    #[test]
    fn session_context_is_capped() {
        let store = Store::in_memory().unwrap();
        let e = FakeEmbedder;
        for i in 0..40 {
            store
                .remember(
                    &e,
                    rule(GLOBAL, &format!("Regla {i}"), &format!("Regla {i}: siempre hacer la cosa número {i} con mucho cuidado y detalle"), false),
                    false,
                )
                .unwrap();
        }
        let rules = store.active_rules("den").unwrap();
        let context = session_context(&rules, 300);
        assert!(estimate_tokens(&context) <= 300 + estimate_tokens(BRAIN_LINE) + 15, "{}", estimate_tokens(&context));
        assert!(context.contains("reglas más: gaze rule ls"));
        assert!(context.starts_with(BRAIN_LINE));
        assert_eq!(session_context(&[], 300), BRAIN_LINE);
    }

    #[test]
    fn hook_output_shape() {
        let out = hook_output("SessionStart", "x");
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(out["hookSpecificOutput"]["additionalContext"], "x");
        assert_eq!(out.as_object().unwrap().len(), 1);
    }

    #[test]
    fn trivial_prompts_are_skipped() {
        assert!(trivial_prompt("ok", 20));
        assert!(trivial_prompt("/compact algo largo de verdad aquí", 20));
        assert!(trivial_prompt("continúa por favor....", 20));
        assert!(!trivial_prompt("¿cómo desplegamos la api de pagos a producción?", 20));
    }

    #[test]
    fn prompt_hook_respects_budget_threshold_and_session() {
        let mut store = Store::in_memory().unwrap();
        store.cfg.hooks.prompt_threshold = 0.3;
        store.cfg.hooks.prompt_margin = 0.0;
        let e = FakeEmbedder;
        unsafe { std::env::set_var("GAZE_EMBEDDER", "fake") };
        store.conn.execute("INSERT INTO project_cache (cwd, project, source, resolved_at) VALUES ('/', 'den', 'test', ?1)", [project::now_secs()]).unwrap();
        for i in 0..6 {
            store
                .remember(
                    &e,
                    NewNode {
                        project: "den".into(),
                        kind: "fact".into(),
                        title: Some(format!("Despliegue api pagos {i}")),
                        body: format!("El despliegue de la api de pagos usa github actions y aws lambda variante {i} con detalles adicionales largos para ocupar espacio en el contexto"),
                        source: "user".into(),
                        ..Default::default()
                    },
                    false,
                )
                .unwrap();
        }
        store
            .remember(
                &e,
                NewNode {
                    project: "den".into(),
                    kind: "fact".into(),
                    body: "Las facturas se mandan los viernes".into(),
                    source: "user".into(),
                    ..Default::default()
                },
                false,
            )
            .unwrap();
        let input = json!({"session_id": "s1", "prompt": "¿cómo es el despliegue de la api de pagos en aws lambda?", "cwd": "/"});
        let out = prompt(&store, &input).unwrap().expect("should inject");
        let context = out["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert!(estimate_tokens(context) <= 150, "{}", estimate_tokens(context));
        let lines = context.lines().count() - 1;
        assert!((1..=3).contains(&lines));
        assert!(!context.contains("facturas"));
        let again = prompt(&store, &input).unwrap();
        if let Some(v) = again {
            let second = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_string();
            for line in context.lines().skip(1) {
                assert!(!second.contains(line));
            }
        }
        let unrelated = json!({"session_id": "s2", "prompt": "escribe un poema sobre gatos y la luna llena", "cwd": "/"});
        assert!(prompt(&store, &unrelated).unwrap().is_none());
    }

    #[test]
    fn transcript_filter_keeps_only_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let lines = [
            json!({"type": "user", "message": {"role": "user", "content": "Usa pnpm, nunca npm <system-reminder>secreto</system-reminder>"}}),
            json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Entendido"}, {"type": "tool_use", "name": "Bash", "input": {}}]}}),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "salida enorme"}]}}),
            json!({"type": "summary", "summary": "x"}),
        ];
        std::fs::write(&path, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        let (text, count) = transcript_text(&path, 0).unwrap();
        assert_eq!(count, 4);
        assert!(text.contains("USER: Usa pnpm, nunca npm"));
        assert!(text.contains("ASSISTANT: Entendido"));
        assert!(!text.contains("secreto"));
        assert!(!text.contains("salida enorme"));
        let (rest, _) = transcript_text(&path, 2).unwrap();
        assert!(rest.is_empty());
    }

    #[test]
    fn learnings_parse_from_claude_json() {
        let raw = json!({"type": "result", "result": "Aquí:\n```json\n[{\"kind\":\"decision\",\"title\":\"T\",\"body\":\"B\"}]\n```"}).to_string();
        let items = parse_learnings(&raw);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "decision");
        assert!(parse_learnings("{\"result\":\"nada\"}").is_empty());
    }
}
