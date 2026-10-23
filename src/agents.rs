use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::io::{Read, Write};
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

pub fn detect(flag: Option<&str>, present: &dyn Fn(&str) -> bool) -> Agent {
    if let Some(agent) = flag.and_then(Agent::parse) {
        return agent;
    }
    if present("ANTIGRAVITY_CONVERSATION_ID") {
        return Agent::Antigravity;
    }
    if present("GEMINI_SESSION_ID") || present("GEMINI_PROJECT_DIR") {
        return Agent::Gemini;
    }
    if present("CODEX_THREAD_ID") {
        return Agent::Codex;
    }
    Agent::Claude
}

pub fn detect_from_env(flag: Option<&str>) -> Agent {
    detect(flag, &|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()))
}

pub fn headless() -> bool {
    std::env::var(HEADLESS_ENV).map(|v| !v.is_empty() && v != "0").unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    pub stdin: String,
    pub env: Vec<(String, String)>,
}

pub const CLAUDE_DEFAULT_MODEL: &str = "haiku";

pub fn invocation(agent: Agent, bin: &str, prompt: &str, model: Option<&str>, cwd: &Path) -> Invocation {
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let owned = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut env = Vec::new();
    let mut stdin = prompt.to_string();
    let args = match agent {
        Agent::Claude => {
            let mut args = owned(&["-p", "--model", model.unwrap_or(CLAUDE_DEFAULT_MODEL), "--output-format", "json"]);
            args.extend(owned(&[
                "--permission-mode",
                "plan",
                "--setting-sources",
                "user",
                "--tools",
                "",
                "--strict-mcp-config",
                "--no-session-persistence",
                "--disable-slash-commands",
            ]));
            env.push(("CLAUDE_CODE_DISABLE_AUTO_MEMORY".to_string(), "1".to_string()));
            args
        }
        Agent::Codex => {
            let mut args = owned(&["exec", "--json", "-C"]);
            args.push(cwd.to_string_lossy().into_owned());
            args.extend(owned(&["--skip-git-repo-check", "--sandbox", "read-only"]));
            if let Some(model) = model {
                args.extend(owned(&["-m", model]));
            }
            args.push("-".into());
            args
        }
        Agent::Gemini => {
            let mut args = owned(&["-o", "json", "--approval-mode", "plan"]);
            if let Some(model) = model {
                args.extend(owned(&["-m", model]));
            }
            args
        }
        Agent::Antigravity => {
            let mut args = owned(&["--mode", "plan", "--input-format", "stream-json", "--output-format", "stream-json"]);
            if let Some(model) = model {
                args.extend(owned(&["--model", model]));
            }
            args.push("-p=".into());
            stdin = format!("{}\n", serde_json::json!({"event": "user", "message": {"content": prompt}}));
            args
        }
        Agent::Opencode => {
            let mut args = owned(&["run", "--format", "json", "--agent", "plan"]);
            if let Some(model) = model {
                args.extend(owned(&["-m", model]));
            }
            args
        }
    };
    env.push((HEADLESS_ENV.to_string(), "1".to_string()));
    Invocation { program: bin.to_string(), args, stdin, env }
}

pub const BASE_ENV: [&str; 30] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "TERM",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    HEADLESS_ENV,
    "SystemDrive",
    "windir",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
];
pub const BASE_PREFIXES: [&str; 3] = ["LC_", "XDG_", "NVM_"];

fn agent_allows(agent: Agent, name: &str, present: &dyn Fn(&str) -> bool) -> bool {
    let upper = name.to_ascii_uppercase();
    let has = |prefix: &str| upper.starts_with(prefix);
    match agent {
        Agent::Claude => {
            has("ANTHROPIC_")
                || has("CLAUDE_")
                || (present("CLAUDE_CODE_USE_BEDROCK") && has("AWS_"))
                || (present("CLAUDE_CODE_USE_VERTEX") && (has("GOOGLE_") || upper == "CLOUD_ML_REGION"))
        }
        Agent::Codex => has("OPENAI_") || has("CODEX_"),
        Agent::Gemini => has("GEMINI_") || (has("GOOGLE_") && (upper != "GOOGLE_APPLICATION_CREDENTIALS" || present("GOOGLE_GENAI_USE_VERTEXAI"))),
        Agent::Antigravity => has("ANTIGRAVITY_") || has("GEMINI_"),
        Agent::Opencode => has("OPENCODE_"),
    }
}

pub fn allowed_env(agent: Agent, name: &str, present: &dyn Fn(&str) -> bool) -> bool {
    BASE_ENV.iter().any(|allowed| allowed.eq_ignore_ascii_case(name))
        || BASE_PREFIXES.iter().any(|prefix| name.to_ascii_uppercase().starts_with(prefix))
        || agent_allows(agent, name, present)
}

pub fn child_env(agent: Agent, vars: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let vars: Vec<_> = vars.into_iter().collect();
    let names: Vec<String> = vars.iter().filter(|(_, v)| !v.is_empty()).filter_map(|(k, _)| k.to_str().map(str::to_ascii_uppercase)).collect();
    let present = |wanted: &str| names.iter().any(|name| name == wanted);
    vars.into_iter().filter(|(name, _)| name.to_str().is_some_and(|name| allowed_env(agent, name, &present))).collect()
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
        Agent::Gemini => lenient_json(stdout)?["response"].as_str().map(str::to_string),
        Agent::Antigravity => json_lines(stdout)
            .filter(|event| event["event"] == "result")
            .filter_map(|event| event["result"]["response"].as_str().map(str::to_string))
            .last()
            .or_else(|| lenient_json(stdout)?["response"].as_str().map(str::to_string)),
        Agent::Codex => json_lines(stdout)
            .filter(|event| event["type"] == "item.completed" && event["item"]["type"] == "agent_message")
            .filter_map(|event| event["item"]["text"].as_str().map(str::to_string))
            .last(),
        Agent::Opencode => {
            let texts: Vec<Value> = json_lines(stdout).filter(|event| event["type"] == "text").collect();
            let last = texts.last()?["part"]["messageID"].clone();
            let parts: Vec<&str> = texts.iter().filter(|event| event["part"]["messageID"] == last).filter_map(|event| event["part"]["text"].as_str()).collect();
            Some(parts.concat())
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

pub const DRAIN_GRACE: Duration = Duration::from_secs(5);

struct Drain {
    buffer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    done: std::sync::mpsc::Receiver<()>,
}

fn drain<R: Read + Send + 'static>(source: Option<R>) -> Drain {
    let buffer = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (sender, done) = std::sync::mpsc::channel();
    let sink = buffer.clone();
    std::thread::spawn(move || {
        if let Some(mut source) = source {
            let mut chunk = [0u8; 64 * 1024];
            while let Ok(read) = source.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                if let Ok(mut out) = sink.lock() {
                    out.extend_from_slice(&chunk[..read]);
                }
            }
        }
        let _ = sender.send(());
    });
    Drain { buffer, done }
}

impl Drain {
    fn finished(&self, wait: Duration) -> bool {
        !matches!(self.done.recv_timeout(wait), Err(std::sync::mpsc::RecvTimeoutError::Timeout))
    }

    fn text(&self) -> String {
        self.buffer.lock().map(|out| String::from_utf8_lossy(&out).into_owned()).unwrap_or_default()
    }
}

#[cfg(unix)]
fn own_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn own_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

fn kill_group(pid: u32) {
    let pid = pid.to_string();
    #[cfg(unix)]
    let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn kill_tree(child: &mut std::process::Child) {
    kill_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

pub fn run(agent: Agent, prompt: &str, model: Option<&str>, cwd: &Path, timeout: Duration, extra_env: &[(&str, &str)]) -> Result<Outcome> {
    let bin = bin_override(agent).unwrap_or_else(|| agent.bin().to_string());
    let path = std::env::var_os("PATH");
    let program = resolve_program(&bin, path.as_deref(), cfg!(windows));
    let spec = invocation(agent, &program.to_string_lossy(), prompt, model, cwd);
    let mut command = Command::new(&program);
    command.args(&spec.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).env_clear();
    command.envs(child_env(agent, std::env::vars_os()));
    own_group(&mut command);
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
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let input = spec.stdin.into_bytes();
    let mut pipe = child.stdin.take().context("stdin")?;
    let writer = std::thread::spawn(move || match pipe.write_all(&input) {
        Err(error) if error.kind() != std::io::ErrorKind::BrokenPipe => Err(error),
        _ => Ok(()),
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            kill_tree(&mut child);
            return Ok(Outcome::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let deadline = Instant::now() + DRAIN_GRACE;
    if !stdout.finished(DRAIN_GRACE) | !stderr.finished(deadline.saturating_duration_since(Instant::now())) {
        kill_group(child.id());
        stdout.finished(Duration::from_millis(500));
        stderr.finished(Duration::from_millis(500));
    }
    let stdout = stdout.text();
    let stderr = stderr.text();
    let written = if writer.is_finished() { writer.join().unwrap_or(Ok(())) } else { Ok(()) };
    if !status.success() {
        return Ok(Outcome::Failed(stderr));
    }
    if let Err(error) = written {
        return Ok(Outcome::Failed(format!("stdin: {error}; {stderr}")));
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

    fn detect_with(flag: Option<&str>, vars: &[&str]) -> Agent {
        detect(flag, &|name| vars.contains(&name))
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
    fn detects_the_harness_from_flag_then_exact_markers() {
        assert_eq!(detect_with(Some("codex"), &["CLAUDECODE"]), Agent::Codex);
        assert_eq!(detect_with(Some("bogus"), &["GEMINI_SESSION_ID"]), Agent::Gemini);
        assert_eq!(detect_with(None, &["ANTIGRAVITY_CONVERSATION_ID", "GEMINI_SESSION_ID", "CLAUDECODE"]), Agent::Antigravity);
        assert_eq!(detect_with(None, &["GEMINI_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "CLAUDECODE"]), Agent::Gemini);
        assert_eq!(detect_with(None, &["CODEX_THREAD_ID", "CLAUDECODE"]), Agent::Codex);
        assert_eq!(detect_with(None, &["CODEX_HOME", "GEMINI_CLI", "CLAUDECODE"]), Agent::Claude);
        assert_eq!(detect_with(None, &[]), Agent::Claude);
    }

    #[test]
    fn invocations_send_the_prompt_by_stdin_in_read_only_modes() {
        let cwd = Path::new("/tmp/w");
        let secret = "TRANSCRIPT-SECRET";
        let claude = invocation(Agent::Claude, "claude", secret, None, cwd);
        assert_eq!(&claude.args[..9], &["-p", "--model", "haiku", "--output-format", "json", "--permission-mode", "plan", "--setting-sources", "user"]);
        let codex = invocation(Agent::Codex, "codex", secret, Some("o4"), cwd);
        assert_eq!(codex.args, ["exec", "--json", "-C", "/tmp/w", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "o4", "-"]);
        let gemini = invocation(Agent::Gemini, "gemini", secret, None, cwd);
        assert_eq!(gemini.args, ["-o", "json", "--approval-mode", "plan"]);
        assert!(!gemini.env.iter().any(|(k, _)| k == "GEMINI_CLI_TRUST_WORKSPACE"));
        let agy = invocation(Agent::Antigravity, "agy", secret, Some("m"), cwd);
        assert_eq!(agy.args, ["--mode", "plan", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "m", "-p="]);
        let line: Value = serde_json::from_str(agy.stdin.trim()).unwrap();
        assert_eq!(line, json!({"event": "user", "message": {"content": secret}}));
        let opencode = invocation(Agent::Opencode, "opencode", secret, Some("a/b"), cwd);
        assert_eq!(opencode.args, ["run", "--format", "json", "--agent", "plan", "-m", "a/b"]);
        for spec in [claude, codex, gemini, agy, opencode] {
            assert!(spec.env.contains(&(HEADLESS_ENV.into(), "1".into())));
            assert!(spec.args.iter().all(|arg| !arg.contains(secret)), "{:?}", spec.args);
            assert!(spec.stdin.contains(secret));
        }
    }

    fn kept(agent: Agent, names: &[&str]) -> Vec<String> {
        let vars = names.iter().map(|name| (std::ffi::OsString::from(name), std::ffi::OsString::from("v")));
        child_env(agent, vars).into_iter().map(|(k, _)| k.into_string().unwrap()).collect()
    }

    #[test]
    fn child_env_only_carries_the_invoked_agent_credentials() {
        let common = ["PATH", "HOME", "USER", "https_proxy", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "LC_ALL", "NVM_DIR"];
        let secrets =
            ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NPM_TOKEN"];
        let all: Vec<&str> = common.iter().chain(secrets.iter()).copied().collect();
        let claude = kept(Agent::Claude, &all);
        assert_eq!(claude, [&common[..], &["ANTHROPIC_API_KEY"]].concat());
        assert!(!claude.contains(&"OPENAI_API_KEY".to_string()));
        assert_eq!(kept(Agent::Codex, &all), [&common[..], &["OPENAI_API_KEY"]].concat());
        assert_eq!(kept(Agent::Gemini, &all), [&common[..], &["GEMINI_API_KEY"]].concat());
        assert_eq!(kept(Agent::Antigravity, &all), [&common[..], &["GEMINI_API_KEY"]].concat());
        assert_eq!(kept(Agent::Opencode, &all), common);
        let bedrock = kept(Agent::Claude, &["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "GOOGLE_CLOUD_PROJECT"]);
        assert_eq!(bedrock, ["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION"]);
        let vertex = kept(Agent::Claude, &["CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION", "GOOGLE_CLOUD_PROJECT", "AWS_REGION"]);
        assert_eq!(vertex, ["CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION", "GOOGLE_CLOUD_PROJECT"]);
        let genai = kept(Agent::Gemini, &["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"]);
        assert_eq!(genai, ["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"]);
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
        let agy = [
            json!({"event": "init", "conversation_id": "c"}),
            json!({"event": "result", "result": {"conversation_id": "c", "status": "SUCCESS", "response": "a"}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        assert_eq!(parse_output(Agent::Antigravity, &agy).as_deref(), Some("a"));
        let opencode = [
            json!({"type": "text", "part": {"messageID": "m1", "text": "PONG"}}),
            json!({"type": "step_finish"}),
            json!({"type": "text", "part": {"messageID": "m2", "text": "he"}}),
            json!({"type": "text", "part": {"messageID": "m2", "text": "llo"}}),
        ]
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
    fn runs_fake_agents_without_deadlocks_or_leaked_env() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = |name: &str, body: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let guard = script("guard", "cat >/dev/null\nprintf '{\"result\":\"%s|%s\"}' \"$KIT_HEADLESS\" \"${GITHUB_TOKEN:-none}\"");
        let noisy = script("noisy", "head -c 2000000 /dev/zero | tr '\\0' x >&2\ncat >/dev/null\nprintf '{\"result\":\"ok\"}'");
        let deaf = script("deaf", "printf '{\"result\":\"early\"}'");
        let lingering = script("lingering", "cat >/dev/null\n(sleep 30) &\nprintf '{\"result\":\"done\"}'");
        let stuck = script("stuck", "sleep 30 &\nsleep 30\n");
        let failing = script("failing", "cat >/dev/null\necho boom >&2\nexit 3");
        let big = "y".repeat(4_000_000);
        unsafe { std::env::set_var("GITHUB_TOKEN", "leak") };
        let cases: [(&PathBuf, &str, &str, u64); 6] = [
            (&guard, "hola", "1|none", 20),
            (&noisy, &big, "ok", 20),
            (&deaf, &big, "early", 20),
            (&failing, "x", "FAILED:boom", 20),
            (&lingering, "x", "done", 20),
            (&stuck, "x", "TIMEOUT", 1),
        ];
        for (bin, prompt, expected, seconds) in cases {
            unsafe { std::env::set_var("GAZE_HARVEST_BIN", bin) };
            let started = Instant::now();
            let outcome = run(Agent::Claude, prompt, None, dir.path(), Duration::from_secs(seconds), &[]).unwrap();
            assert!(started.elapsed() < Duration::from_secs(15), "{} took {:?}", bin.display(), started.elapsed());
            let got = match outcome {
                Outcome::Text(text) => text,
                Outcome::Failed(stderr) => format!("FAILED:{}", stderr.trim()),
                Outcome::TimedOut => "TIMEOUT".into(),
            };
            assert_eq!(got, expected, "{}", bin.display());
        }
        unsafe { std::env::remove_var("GAZE_HARVEST_BIN") };
        unsafe { std::env::remove_var("GITHUB_TOKEN") };
    }
}
