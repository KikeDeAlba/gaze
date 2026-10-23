use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
    Gemini,
    Antigravity,
    Opencode,
}

pub const HEADLESS_ENV: &str = "KIT_HEADLESS";

impl Agent {
    pub const ALL: [Agent; 5] = [Agent::Claude, Agent::Codex, Agent::Gemini, Agent::Antigravity, Agent::Opencode];

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Some(Agent::Claude),
            "codex" => Some(Agent::Codex),
            "gemini" => Some(Agent::Gemini),
            "antigravity" | "agy" => Some(Agent::Antigravity),
            "opencode" => Some(Agent::Opencode),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Gemini => "gemini",
            Agent::Antigravity => "antigravity",
            Agent::Opencode => "opencode",
        }
    }

    pub fn bin(self) -> &'static str {
        match self {
            Agent::Antigravity => "agy",
            other => other.id(),
        }
    }

    pub fn project_dir_var(self) -> Option<&'static str> {
        match self {
            Agent::Claude => Some("CLAUDE_PROJECT_DIR"),
            Agent::Gemini => Some("GEMINI_PROJECT_DIR"),
            _ => None,
        }
    }

    pub fn prompt_event(self) -> &'static str {
        match self {
            Agent::Gemini => "BeforeAgent",
            _ => "UserPromptSubmit",
        }
    }
}

pub fn detect(flag: Option<&str>, present: &dyn Fn(&str) -> bool, keys: &[String]) -> Agent {
    if let Some(agent) = flag.and_then(Agent::parse) {
        return agent;
    }
    if present("ANTIGRAVITY_CONVERSATION_ID") {
        return Agent::Antigravity;
    }
    if present("GEMINI_PROJECT_DIR") || present("GEMINI_CLI") {
        return Agent::Gemini;
    }
    if keys.iter().any(|key| key.starts_with("CODEX_")) {
        return Agent::Codex;
    }
    Agent::Claude
}

pub fn detect_from_env(flag: Option<&str>) -> Agent {
    let keys: Vec<String> = std::env::vars_os().filter(|(_, v)| !v.is_empty()).filter_map(|(k, _)| k.into_string().ok()).collect();
    detect(flag, &|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()), &keys)
}

pub fn headless() -> bool {
    std::env::var(HEADLESS_ENV).map(|v| !v.is_empty() && v != "0").unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub env: Vec<(String, String)>,
}

pub const CLAUDE_DEFAULT_MODEL: &str = "haiku";

pub fn invocation(agent: Agent, bin: &str, prompt: &str, model: Option<&str>, cwd: &Path) -> Invocation {
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let owned = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut env = Vec::new();
    let (args, stdin) = match agent {
        Agent::Claude => {
            let mut args = owned(&["-p", "--model", model.unwrap_or(CLAUDE_DEFAULT_MODEL), "--output-format", "json"]);
            args.extend(owned(&["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]));
            env.push(("CLAUDE_CODE_DISABLE_AUTO_MEMORY".to_string(), "1".to_string()));
            (args, Some(prompt.to_string()))
        }
        Agent::Codex => {
            let mut args = owned(&["exec", "--json", "-C"]);
            args.push(cwd.to_string_lossy().into_owned());
            args.extend(owned(&["--skip-git-repo-check", "--sandbox", "read-only"]));
            if let Some(model) = model {
                args.extend(owned(&["-m", model]));
            }
            args.push("-".into());
            (args, Some(prompt.to_string()))
        }
        Agent::Gemini => {
            let mut args = owned(&["-o", "json", "--approval-mode", "plan"]);
            if let Some(model) = model {
                args.extend(owned(&["-m", model]));
            }
            env.push(("GEMINI_CLI_TRUST_WORKSPACE".to_string(), "true".to_string()));
            (args, Some(prompt.to_string()))
        }
        Agent::Antigravity => {
            let mut args = owned(&["-p", prompt, "--output-format", "json"]);
            if let Some(model) = model {
                args.extend(owned(&["--model", model]));
            }
            (args, None)
        }
        Agent::Opencode => {
            let mut args = owned(&["run", "--format", "json"]);
            if let Some(model) = model {
                args.extend(owned(&["-m", model]));
            }
            args.push(prompt.to_string());
            (args, None)
        }
    };
    env.push((HEADLESS_ENV.to_string(), "1".to_string()));
    Invocation { program: bin.to_string(), args, stdin, env }
}

fn lenient_json(stdout: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) {
        return Some(value);
    }
    let (start, end) = (stdout.find('{')?, stdout.rfind('}')?);
    if end < start {
        return None;
    }
    serde_json::from_str(&stdout[start..=end]).ok()
}

fn json_lines(stdout: &str) -> impl Iterator<Item = Value> + '_ {
    stdout.lines().filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

pub fn parse_output(agent: Agent, stdout: &str) -> Option<String> {
    match agent {
        Agent::Claude => lenient_json(stdout)?["result"].as_str().map(str::to_string),
        Agent::Gemini | Agent::Antigravity => lenient_json(stdout)?["response"].as_str().map(str::to_string),
        Agent::Codex => json_lines(stdout)
            .filter(|event| event["type"] == "item.completed" && event["item"]["type"] == "agent_message")
            .filter_map(|event| event["item"]["text"].as_str().map(str::to_string))
            .last(),
        Agent::Opencode => {
            let parts: Vec<String> =
                json_lines(stdout).filter(|event| event["type"] == "text").filter_map(|event| event["part"]["text"].as_str().map(str::to_string)).collect();
            if parts.is_empty() { None } else { Some(parts.join("")) }
        }
    }
}

pub fn bin_override(agent: Agent) -> Option<String> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    var("GAZE_HARVEST_BIN").or_else(|| if agent == Agent::Claude { var("GAZE_CLAUDE_BIN") } else { None })
}

pub fn resolve_program(bin: &str, path: Option<&std::ffi::OsStr>, windows: bool) -> PathBuf {
    let candidate = Path::new(bin);
    if candidate.components().count() > 1 || !windows {
        return candidate.to_path_buf();
    }
    let has_ext = candidate.extension().is_some();
    let exts: &[&str] = if has_ext { &[""] } else { &[".exe", ".cmd", ".bat", ".com"] };
    for dir in path.map(std::env::split_paths).into_iter().flatten() {
        for ext in exts {
            let full = dir.join(format!("{bin}{ext}"));
            if full.is_file() {
                return full;
            }
        }
    }
    candidate.to_path_buf()
}

pub enum Outcome {
    Text(String),
    TimedOut,
    Failed(String),
}

pub fn run(agent: Agent, prompt: &str, model: Option<&str>, cwd: &Path, timeout: Duration, extra_env: &[(&str, &str)]) -> Result<Outcome> {
    let bin = bin_override(agent).unwrap_or_else(|| agent.bin().to_string());
    let path = std::env::var_os("PATH");
    let program = resolve_program(&bin, path.as_deref(), cfg!(windows));
    let spec = invocation(agent, &program.to_string_lossy(), prompt, model, cwd);
    let mut command = Command::new(&program);
    command
        .args(&spec.args)
        .current_dir(cwd)
        .stdin(if spec.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in extra_env.iter().copied().chain(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str()))) {
        command.env(key, value);
    }
    if let Some(dir) = program.parent().filter(|d| !d.as_os_str().is_empty()) {
        let joined = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(path.as_deref().map(std::env::split_paths).into_iter().flatten()));
        if let Ok(joined) = joined {
            command.env("PATH", joined);
        }
    }
    let mut child = command.spawn().with_context(|| format!("spawn {}", program.display()))?;
    if let Some(input) = &spec.stdin {
        child.stdin.take().context("stdin")?.write_all(input.as_bytes())?;
    }
    let started = Instant::now();
    while child.try_wait()?.is_none() {
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(Outcome::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let output = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Ok(Outcome::Failed(String::from_utf8_lossy(&output.stderr).into_owned()));
    }
    match parse_output(agent, &stdout) {
        Some(text) => Ok(Outcome::Text(text)),
        None => Err(anyhow!("{} devolvió una salida sin texto: {}", agent.id(), crate::text::truncate(&stdout, 300))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn keys(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn detect_with(flag: Option<&str>, vars: &[&str]) -> Agent {
        let list = keys(vars);
        detect(flag, &|name| list.iter().any(|k| k == name), &list)
    }

    #[test]
    fn parses_ids_and_aliases() {
        for agent in Agent::ALL {
            assert_eq!(Agent::parse(agent.id()), Some(agent));
        }
        assert_eq!(Agent::parse("agy"), Some(Agent::Antigravity));
        assert_eq!(Agent::parse("cursor"), None);
        assert_eq!(Agent::Antigravity.bin(), "agy");
    }

    #[test]
    fn detects_the_harness_from_flag_then_env() {
        assert_eq!(detect_with(Some("codex"), &["CLAUDECODE"]), Agent::Codex);
        assert_eq!(detect_with(Some("bogus"), &["GEMINI_CLI"]), Agent::Gemini);
        assert_eq!(detect_with(None, &["ANTIGRAVITY_CONVERSATION_ID", "GEMINI_CLI", "CLAUDECODE"]), Agent::Antigravity);
        assert_eq!(detect_with(None, &["GEMINI_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "CLAUDECODE"]), Agent::Gemini);
        assert_eq!(detect_with(None, &["CODEX_THREAD_ID", "CLAUDECODE"]), Agent::Codex);
        assert_eq!(detect_with(None, &["CLAUDECODE"]), Agent::Claude);
        assert_eq!(detect_with(None, &[]), Agent::Claude);
    }

    #[test]
    fn invocations_mirror_the_kit_table() {
        let cwd = Path::new("/tmp/w");
        let claude = invocation(Agent::Claude, "claude", "P", None, cwd);
        assert_eq!(&claude.args[..5], &["-p", "--model", "haiku", "--output-format", "json"]);
        assert_eq!(claude.stdin.as_deref(), Some("P"));
        let codex = invocation(Agent::Codex, "codex", "P", Some("o4"), cwd);
        assert_eq!(codex.args, ["exec", "--json", "-C", "/tmp/w", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "o4", "-"]);
        assert_eq!(codex.stdin.as_deref(), Some("P"));
        let gemini = invocation(Agent::Gemini, "gemini", "P", None, cwd);
        assert_eq!(gemini.args, ["-o", "json", "--approval-mode", "plan"]);
        assert!(gemini.env.contains(&("GEMINI_CLI_TRUST_WORKSPACE".into(), "true".into())));
        let agy = invocation(Agent::Antigravity, "agy", "P", Some("m"), cwd);
        assert_eq!(agy.args, ["-p", "P", "--output-format", "json", "--model", "m"]);
        assert_eq!(agy.stdin, None);
        let opencode = invocation(Agent::Opencode, "opencode", "P", Some("a/b"), cwd);
        assert_eq!(opencode.args, ["run", "--format", "json", "-m", "a/b", "P"]);
        for spec in [claude, codex, gemini, agy, opencode] {
            assert!(spec.env.contains(&(HEADLESS_ENV.into(), "1".into())));
        }
    }

    #[test]
    fn parses_each_agent_output() {
        assert_eq!(parse_output(Agent::Claude, &json!({"result": "[1]"}).to_string()).as_deref(), Some("[1]"));
        let codex = [
            json!({"type": "thread.started", "thread_id": "t"}),
            json!({"type": "item.completed", "item": {"type": "agent_message", "text": "first"}}),
            json!({"type": "item.completed", "item": {"type": "error", "message": "x"}}),
            json!({"type": "item.completed", "item": {"type": "agent_message", "text": "last"}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        assert_eq!(parse_output(Agent::Codex, &codex).as_deref(), Some("last"));
        assert_eq!(parse_output(Agent::Gemini, &format!("Loaded cached credentials.\n{}", json!({"response": "g"}))).as_deref(), Some("g"));
        assert_eq!(parse_output(Agent::Antigravity, &json!({"response": "a", "conversation_id": "c"}).to_string()).as_deref(), Some("a"));
        let opencode = [json!({"type": "text", "part": {"text": "he"}}), json!({"type": "tool"}), json!({"type": "text", "part": {"text": "llo"}})]
            .map(|v| v.to_string())
            .join("\n");
        assert_eq!(parse_output(Agent::Opencode, &opencode).as_deref(), Some("hello"));
        assert_eq!(parse_output(Agent::Opencode, ""), None);
    }

    #[test]
    fn resolves_windows_shims_through_pathext() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("claude.cmd"), "").unwrap();
        let path = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(resolve_program("claude", Some(&path), true), dir.path().join("claude.cmd"));
        assert_eq!(resolve_program("claude", Some(&path), false), PathBuf::from("claude"));
        assert_eq!(resolve_program("codex", Some(&path), true), PathBuf::from("codex"));
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_fake_agent_with_the_headless_guard() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-claude");
        std::fs::write(&script, "#!/bin/sh\ncat >/dev/null\nprintf '{\"result\":\"%s\"}' \"$KIT_HEADLESS\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("GAZE_HARVEST_BIN", &script) };
        let outcome = run(Agent::Claude, "hola", None, dir.path(), Duration::from_secs(10), &[]).unwrap();
        unsafe { std::env::remove_var("GAZE_HARVEST_BIN") };
        match outcome {
            Outcome::Text(text) => assert_eq!(text, "1"),
            _ => panic!("expected text"),
        }
    }
}
