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

pub struct LaunchctlOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait Launchctl {
    fn run(&self, args: &[&str]) -> LaunchctlOutput;

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

pub struct SystemLaunchctl;

impl Launchctl for SystemLaunchctl {
    fn run(&self, args: &[&str]) -> LaunchctlOutput {
        match Command::new("launchctl").args(args).output() {
            Ok(output) => LaunchctlOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Err(error) => LaunchctlOutput { success: false, stdout: String::new(), stderr: format!("launchctl: {error}") },
        }
    }
}

const POLL: Duration = Duration::from_millis(200);
const UNLOAD_POLLS: u32 = 50;
const START_POLLS: u32 = 50;
const READY_POLLS: u32 = 150;
const BOOTSTRAP_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Missing,
    Loaded { pid: Option<u32> },
}

pub fn parse_pid(print: &str) -> Option<u32> {
    print.lines().find_map(|line| line.strip_prefix("\tpid = ")).and_then(|pid| pid.trim().parse().ok())
}

pub fn job_state(ctl: &dyn Launchctl, service: &str) -> JobState {
    let output = ctl.run(&["print", service]);
    if output.success { JobState::Loaded { pid: parse_pid(&output.stdout) } } else { JobState::Missing }
}

fn wait_until(ctl: &dyn Launchctl, polls: u32, mut done: impl FnMut() -> bool) -> bool {
    for poll in 0..polls {
        if done() {
            return true;
        }
        if poll + 1 < polls {
            ctl.pause(POLL);
        }
    }
    false
}

fn wait_unloaded(ctl: &dyn Launchctl, service: &str) -> bool {
    wait_until(ctl, UNLOAD_POLLS, || job_state(ctl, service) == JobState::Missing)
}

fn wait_running(ctl: &dyn Launchctl, service: &str) -> Option<u32> {
    let mut pid = None;
    wait_until(ctl, START_POLLS, || {
        if let JobState::Loaded { pid: Some(found) } = job_state(ctl, service) {
            pid = Some(found);
        }
        pid.is_some()
    });
    pid
}

fn unload(ctl: &dyn Launchctl, service: &str) -> Result<()> {
    if job_state(ctl, service) == JobState::Missing {
        return Ok(());
    }
    ctl.run(&["bootout", service]);
    if wait_unloaded(ctl, service) {
        return Ok(());
    }
    Err(anyhow!("launchd no descargó {service} tras {} s", (POLL * UNLOAD_POLLS).as_secs()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Started {
    pub pid: u32,
    pub ready: bool,
}

pub fn load(ctl: &dyn Launchctl, domain: &str, plist: &str, ready: &dyn Fn() -> bool) -> Result<Started> {
    let service = format!("{domain}/{LABEL}");
    let mut failures = Vec::new();
    for attempt in 1..=BOOTSTRAP_ATTEMPTS {
        unload(ctl, &service)?;
        ctl.run(&["enable", &service]);
        let output = ctl.run(&["bootstrap", domain, plist]);
        if !output.success {
            failures.push(format!("intento {attempt}: bootstrap falló: {}", output.stderr.trim()));
            continue;
        }
        let Some(pid) = wait_running(ctl, &service) else {
            failures.push(format!("intento {attempt}: {service} quedó sin pid tras {} s", (POLL * START_POLLS).as_secs()));
            continue;
        };
        if wait_until(ctl, READY_POLLS, ready) {
            return Ok(Started { pid, ready: true });
        }
        if let JobState::Loaded { pid: Some(pid) } = job_state(ctl, &service) {
            return Ok(Started { pid, ready: false });
        }
        failures.push(format!(
            "intento {attempt}: {service} arrancó con pid {pid} pero murió sin responder en el socket tras {} s",
            (POLL * READY_POLLS).as_secs()
        ));
    }
    Err(anyhow!("launchctl no pudo cargar {plist} en {domain}:\n{}", failures.join("\n")))
}

fn uid() -> String {
    Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|_| "501".into())
}

fn domain() -> String {
    format!("gui/{}", uid())
}

pub fn install() -> Result<Value> {
    let bin = std::env::current_exe()?.canonicalize()?;
    let plist = paths::launch_agent();
    std::fs::create_dir_all(plist.parent().context("plist dir")?)?;
    std::fs::create_dir_all(paths::data_dir())?;
    let ctl = SystemLaunchctl;
    let domain = domain();
    unload(&ctl, &format!("{domain}/{LABEL}"))?;
    std::fs::write(&plist, render_plist(&bin.to_string_lossy()))?;
    let socket = paths::socket_path();
    let started = load(&ctl, &domain, &plist.to_string_lossy(), &|| ping(&socket).is_some())?;
    Ok(json!({"plist": plist, "label": LABEL, "socket": socket, "bin": bin, "pid": started.pid, "ready": started.ready, "log": paths::serve_log()}))
}

pub fn remove(ctl: &dyn Launchctl, service: &str, plist: &Path) -> Result<bool> {
    unload(ctl, service)?;
    let existed = plist.exists();
    if existed {
        std::fs::remove_file(plist)?;
    }
    Ok(existed)
}

pub fn uninstall() -> Result<Value> {
    let plist = paths::launch_agent();
    let removed = remove(&SystemLaunchctl, &format!("{}/{LABEL}", domain()), &plist)?;
    Ok(json!({"plist": plist, "removed": removed}))
}

pub fn status() -> Value {
    let socket = paths::socket_path();
    let alive = ping(&socket);
    let plist = paths::launch_agent();
    let installed = plist.exists();
    let job = if installed { job_state(&SystemLaunchctl, &format!("{}/{LABEL}", domain())) } else { JobState::Missing };
    json!({
        "socket": socket,
        "running": alive.is_some(),
        "pid": alive.as_ref().and_then(|v| v["pid"].as_u64()),
        "launchAgent": installed,
        "loaded": matches!(job, JobState::Loaded { .. }),
        "launchdPid": match job { JobState::Loaded { pid } => pid, JobState::Missing => None },
        "state": status_state(alive.is_some(), installed, &job),
    })
}

pub fn status_state(running: bool, installed: bool, job: &JobState) -> &'static str {
    match (running, installed, job) {
        (true, _, _) => "running",
        (false, true, JobState::Missing) => "not-loaded",
        (false, true, JobState::Loaded { .. }) => "starting",
        (false, false, _) => "stopped",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const DOMAIN: &str = "gui/501";
    const PLIST: &str = "/tmp/com.kikedealba.gaze.plist";

    #[derive(Default)]
    struct FakeLaunchctl {
        loaded: Cell<bool>,
        pid: Cell<Option<u32>>,
        teardown_polls: Cell<u32>,
        lingering: Cell<u32>,
        startup_polls: Cell<u32>,
        starting: Cell<u32>,
        failing_bootstraps: Cell<u32>,
        disabled: Cell<bool>,
        never_starts: bool,
        never_unloads: bool,
        calls: RefCell<Vec<String>>,
        pauses: Cell<u32>,
    }

    impl FakeLaunchctl {
        fn running(pid: u32) -> Self {
            let fake = Self::default();
            fake.loaded.set(true);
            fake.pid.set(Some(pid));
            fake
        }

        fn verbs(&self) -> Vec<String> {
            self.calls.borrow().iter().map(|call| call.split(' ').next().unwrap_or_default().to_string()).collect()
        }

        fn ok(stdout: String) -> LaunchctlOutput {
            LaunchctlOutput { success: true, stdout, stderr: String::new() }
        }

        fn fail(stderr: &str) -> LaunchctlOutput {
            LaunchctlOutput { success: false, stdout: String::new(), stderr: stderr.into() }
        }
    }

    impl Launchctl for FakeLaunchctl {
        fn run(&self, args: &[&str]) -> LaunchctlOutput {
            self.calls.borrow_mut().push(args.join(" "));
            match args[0] {
                "print" => {
                    if self.lingering.get() > 0 {
                        self.lingering.set(self.lingering.get() - 1);
                        if self.lingering.get() == 0 && !self.never_unloads {
                            self.loaded.set(false);
                            self.pid.set(None);
                        }
                        return Self::ok("\tstate = running\n".into());
                    }
                    if !self.loaded.get() {
                        return Self::fail("Could not find service");
                    }
                    if self.starting.get() > 0 {
                        self.starting.set(self.starting.get() - 1);
                        if self.starting.get() == 0 && !self.never_starts {
                            self.pid.set(Some(4242));
                        }
                    }
                    match self.pid.get() {
                        Some(pid) => Self::ok(format!("gui/501/{LABEL} = {{\n\tstate = running\n\tpid = {pid}\n\t\tpid = 1\n}}\n")),
                        None => Self::ok("\tstate = spawn scheduled\n".into()),
                    }
                }
                "bootout" => {
                    if !self.loaded.get() {
                        return Self::fail("Boot-out failed: 3: No such process");
                    }
                    let polls = self.teardown_polls.get();
                    if polls == 0 && !self.never_unloads {
                        self.loaded.set(false);
                        self.pid.set(None);
                    } else {
                        self.lingering.set(polls.max(1));
                    }
                    Self::ok(String::new())
                }
                "enable" => {
                    self.disabled.set(false);
                    Self::ok(String::new())
                }
                "bootstrap" => {
                    if self.disabled.get() {
                        return Self::fail("Bootstrap failed: 5: Input/output error");
                    }
                    if self.loaded.get() || self.lingering.get() > 0 {
                        return Self::fail("Bootstrap failed: 5: Input/output error");
                    }
                    if self.failing_bootstraps.get() > 0 {
                        self.failing_bootstraps.set(self.failing_bootstraps.get() - 1);
                        return Self::fail("Bootstrap failed: 5: Input/output error");
                    }
                    self.loaded.set(true);
                    self.starting.set(self.startup_polls.get().max(1));
                    Self::ok(String::new())
                }
                _ => Self::fail("unexpected"),
            }
        }

        fn pause(&self, _duration: Duration) {
            self.pauses.set(self.pauses.get() + 1);
        }
    }

    #[test]
    fn parses_the_top_level_pid_only() {
        assert_eq!(parse_pid("gui/501/x = {\n\tstate = running\n\tpid = 58758\n\t\tpid = 1\n}"), Some(58758));
        assert_eq!(parse_pid("\tstate = spawn scheduled\n\t\tpid = 1\n"), None);
    }

    #[test]
    fn waits_for_the_old_job_to_unload_before_bootstrapping() {
        let fake = FakeLaunchctl::running(100);
        fake.teardown_polls.set(4);
        let pid = load(&fake, DOMAIN, PLIST, &|| true).expect("loaded").pid;
        assert_eq!(pid, 4242);
        let verbs = fake.verbs();
        let bootstrap = verbs.iter().position(|verb| verb == "bootstrap").expect("bootstrap");
        assert_eq!(verbs.iter().filter(|verb| *verb == "bootstrap").count(), 1);
        assert!(verbs[..bootstrap].contains(&"bootout".to_string()));
        assert_eq!(verbs[bootstrap - 1], "enable");
        assert!(fake.calls.borrow()[bootstrap - 2].starts_with("print"));
        assert!(fake.pauses.get() >= 3);
    }

    #[test]
    fn retries_when_bootstrap_fails_with_eio() {
        let fake = FakeLaunchctl::default();
        fake.failing_bootstraps.set(2);
        assert_eq!(load(&fake, DOMAIN, PLIST, &|| true).expect("loaded").pid, 4242);
        assert_eq!(fake.verbs().iter().filter(|verb| *verb == "bootstrap").count(), 3);
    }

    #[test]
    fn waits_until_the_job_has_a_pid() {
        let fake = FakeLaunchctl::default();
        fake.startup_polls.set(5);
        assert_eq!(load(&fake, DOMAIN, PLIST, &|| true).expect("loaded").pid, 4242);
        assert!(fake.pauses.get() >= 4);
    }

    #[test]
    fn fails_when_bootstrap_never_succeeds() {
        let fake = FakeLaunchctl::default();
        fake.failing_bootstraps.set(BOOTSTRAP_ATTEMPTS);
        let error = load(&fake, DOMAIN, PLIST, &|| true).expect_err("must fail").to_string();
        assert!(error.contains("Input/output error"), "{error}");
        assert!(error.contains(PLIST), "{error}");
    }

    #[test]
    fn fails_when_the_job_never_gets_a_pid() {
        let fake = FakeLaunchctl { never_starts: true, ..FakeLaunchctl::default() };
        let error = load(&fake, DOMAIN, PLIST, &|| true).expect_err("must fail").to_string();
        assert!(error.contains("sin pid"), "{error}");
        assert_eq!(fake.verbs().iter().filter(|verb| *verb == "bootstrap").count(), BOOTSTRAP_ATTEMPTS as usize);
    }

    #[test]
    fn fails_when_the_old_job_never_unloads() {
        let fake = FakeLaunchctl { never_unloads: true, ..FakeLaunchctl::running(100) };
        fake.teardown_polls.set(UNLOAD_POLLS * 10);
        let error = load(&fake, DOMAIN, PLIST, &|| true).expect_err("must fail").to_string();
        assert!(error.contains("no descargó"), "{error}");
        assert!(!fake.verbs().contains(&"bootstrap".to_string()));
    }

    #[test]
    fn enables_a_disabled_service_before_bootstrapping() {
        let fake = FakeLaunchctl::default();
        fake.disabled.set(true);
        assert_eq!(load(&fake, DOMAIN, PLIST, &|| true).expect("loaded"), Started { pid: 4242, ready: true });
        let verbs = fake.verbs();
        assert_eq!(verbs.iter().filter(|verb| *verb == "bootstrap").count(), 1);
        assert!(verbs.iter().position(|verb| verb == "enable") < verbs.iter().position(|verb| verb == "bootstrap"));
    }

    #[test]
    fn waits_for_the_socket_before_declaring_the_daemon_healthy() {
        let fake = FakeLaunchctl::default();
        let pings = Cell::new(0);
        let ready = || {
            pings.set(pings.get() + 1);
            pings.get() >= 4
        };
        assert_eq!(load(&fake, DOMAIN, PLIST, &ready).expect("loaded"), Started { pid: 4242, ready: true });
        assert_eq!(pings.get(), 4);
    }

    #[test]
    fn reports_a_live_job_that_never_answers_as_not_ready() {
        let fake = FakeLaunchctl::default();
        let started = load(&fake, DOMAIN, PLIST, &|| false).expect("loaded");
        assert_eq!(started, Started { pid: 4242, ready: false });
        assert_eq!(fake.verbs().iter().filter(|verb| *verb == "bootstrap").count(), 1);
    }

    #[test]
    fn uninstall_fails_clearly_when_the_job_never_unloads() {
        let fake = FakeLaunchctl { never_unloads: true, ..FakeLaunchctl::running(100) };
        fake.teardown_polls.set(UNLOAD_POLLS * 10);
        let dir = std::env::temp_dir().join(format!("gaze-uninstall-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let plist = dir.join("com.kikedealba.gaze.plist");
        std::fs::write(&plist, "<plist/>").expect("plist");
        let error = remove(&fake, &format!("{DOMAIN}/{LABEL}"), &plist).expect_err("must fail").to_string();
        assert!(error.contains("no descargó") && error.contains(LABEL), "{error}");
        assert!(plist.exists());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn uninstall_removes_the_plist_once_the_job_is_gone() {
        let fake = FakeLaunchctl::running(100);
        fake.teardown_polls.set(3);
        let dir = std::env::temp_dir().join(format!("gaze-uninstall-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let plist = dir.join("com.kikedealba.gaze.plist");
        std::fs::write(&plist, "<plist/>").expect("plist");
        assert!(remove(&fake, &format!("{DOMAIN}/{LABEL}"), &plist).expect("removed"));
        assert!(!plist.exists());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn status_tells_an_unloaded_plist_from_a_stopped_daemon() {
        assert_eq!(status_state(true, true, &JobState::Loaded { pid: Some(1) }), "running");
        assert_eq!(status_state(false, true, &JobState::Missing), "not-loaded");
        assert_eq!(status_state(false, true, &JobState::Loaded { pid: None }), "starting");
        assert_eq!(status_state(false, false, &JobState::Missing), "stopped");
    }
}
