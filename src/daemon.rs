use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::embed::{self, Embedder, LocalModel, Mode};
use crate::ipc;
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
        "shutdown" => json!({"ok": true, "pid": std::process::id()}),
        other => json!({"ok": false, "error": format!("unknown op: {other}")}),
    }
}

fn serve_connection<S: Read + Write>(model: &dyn Embedder, stream: S, last: &AtomicU64) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        last.store(now_secs() as u64, Ordering::Relaxed);
        let response = match serde_json::from_str::<Value>(line.trim_end()) {
            Ok(request) => handle(model, &request),
            Err(error) => json!({"ok": false, "error": format!("bad request: {error}")}),
        };
        let writer = reader.get_mut();
        writer.write_all(format!("{response}\n").as_bytes())?;
        writer.flush()?;
        if is_shutdown(&line) {
            ipc::cleanup(&paths::socket_path());
            std::process::exit(0);
        }
    }
}

fn is_shutdown(line: &str) -> bool {
    serde_json::from_str::<Value>(line.trim_end()).is_ok_and(|request| request["op"] == "shutdown")
}

pub fn shutdown(path: &Path) -> bool {
    embed::socket_request(path, &json!({"op": "shutdown"}), Duration::from_secs(2)).is_ok()
}

pub struct ServeLog(Option<PathBuf>);

impl ServeLog {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self(path)
    }

    pub fn line(&self, message: &str) {
        let line = format!("{} {message}", crate::text::now_iso());
        let written = self.0.as_ref().is_some_and(|path| {
            path.parent().is_none_or(|dir| std::fs::create_dir_all(dir).is_ok())
                && std::fs::OpenOptions::new().create(true).append(true).open(path).and_then(|mut file| writeln!(file, "{line}")).is_ok()
        });
        if !written {
            eprintln!("{line}");
        }
    }
}

pub fn serve_args(idle_minutes: Option<u64>) -> Vec<String> {
    let mut args = vec!["serve".to_string()];
    if let Some(minutes) = idle_minutes {
        args.extend(["--idle-minutes".to_string(), minutes.to_string()]);
    }
    args
}

#[cfg(windows)]
fn spawn_hidden(command: &mut Command) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
    command.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
    command.spawn().or_else(|_| command.creation_flags(base).spawn())
}

#[cfg(unix)]
fn spawn_hidden(command: &mut Command) -> std::io::Result<std::process::Child> {
    crate::hooks::detach(command);
    command.spawn()
}

pub fn spawn_detached(idle_minutes: Option<u64>, log: &Path) -> Result<u32> {
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let out = std::fs::OpenOptions::new().create(true).append(true).open(log).with_context(|| format!("open {}", log.display()))?;
    let mut command = Command::new(std::env::current_exe()?);
    command.args(serve_args(idle_minutes)).stdin(std::process::Stdio::null()).stdout(out.try_clone()?).stderr(out);
    let child = spawn_hidden(&mut command).context("spawn gaze serve")?;
    Ok(child.id())
}

pub fn ping(path: &Path) -> Option<Value> {
    embed::socket_request(path, &json!({"op": "ping"}), Duration::from_secs(2)).ok()
}

pub fn serve(idle_minutes: Option<u64>, log: ServeLog) -> Result<()> {
    let socket = paths::socket_path();
    std::fs::create_dir_all(paths::data_dir())?;
    if ping(&socket).is_some() {
        return Err(anyhow!("gaze serve ya corre en {}", socket.display()));
    }
    let model: Arc<dyn Embedder> = if embed::fake_requested() { Arc::new(embed::FakeEmbedder) } else { Arc::new(LocalModel::load()?) };
    model.embed(&["warmup".to_string()], Mode::Query)?;
    let listener = ipc::bind(&socket).with_context(|| format!("bind {}", socket.display()))?;
    log.line(&format!("gaze serve listening on {}", socket.display()));
    let last = Arc::new(AtomicU64::new(now_secs() as u64));
    if let Some(minutes) = idle_minutes.filter(|m| *m > 0) {
        let last = last.clone();
        let socket = socket.clone();
        let log = ServeLog::new(log.0.clone());
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(30));
                if now_secs() as u64 - last.load(Ordering::Relaxed) > minutes * 60 {
                    ipc::cleanup(&socket);
                    log.line("gaze serve idle, exiting");
                    std::process::exit(0);
                }
            }
        });
    }
    loop {
        let Ok(stream) = listener.accept() else { continue };
        let model = model.clone();
        let last = last.clone();
        std::thread::spawn(move || {
            let _ = serve_connection(model.as_ref(), stream, &last);
        });
    }
}

pub fn render_plist(bin: &str) -> String {
    PLIST_TEMPLATE.replace("{{BIN}}", bin).replace("{{HOME}}", &paths::home().to_string_lossy()).replace("{{LOG}}", &paths::serve_log().to_string_lossy())
}

pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait Launchctl {
    fn run(&self, args: &[&str]) -> CommandOutput;

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

pub fn system_run(program: &str, args: &[&str]) -> CommandOutput {
    match Command::new(program).args(args).output() {
        Ok(output) => CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Err(error) => CommandOutput { success: false, stdout: String::new(), stderr: format!("{program}: {error}") },
    }
}

pub struct SystemLaunchctl;

impl Launchctl for SystemLaunchctl {
    fn run(&self, args: &[&str]) -> CommandOutput {
        system_run("launchctl", args)
    }
}

pub trait Exec {
    fn exec(&self, program: &str, args: &[&str]) -> CommandOutput;

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

pub struct SystemExec;

impl Exec for SystemExec {
    fn exec(&self, program: &str, args: &[&str]) -> CommandOutput {
        system_run(program, args)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Launchd,
    Systemd,
    Schtasks,
}

impl Manager {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Manager::Launchd
        } else if cfg!(windows) {
            Manager::Schtasks
        } else {
            Manager::Systemd
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Manager::Launchd => "launchd",
            Manager::Systemd => "systemd",
            Manager::Schtasks => "schtasks",
        }
    }

    pub fn unit(self) -> String {
        match self {
            Manager::Launchd => paths::launch_agent().to_string_lossy().into_owned(),
            Manager::Systemd => paths::systemd_unit().to_string_lossy().into_owned(),
            Manager::Schtasks => TASK_NAME.to_string(),
        }
    }
}

pub const SYSTEMD_UNIT: &str = "gaze.service";
pub const TASK_NAME: &str = "gaze-daemon";

fn current_bin() -> Result<String> {
    let bin = std::env::current_exe()?.canonicalize()?;
    let raw = bin.to_string_lossy().into_owned();
    Ok(raw.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(raw))
}

fn wait_ready(exec: &dyn Exec, ready: &dyn Fn() -> bool) -> bool {
    for poll in 0..READY_POLLS {
        if ready() {
            return true;
        }
        if poll + 1 < READY_POLLS {
            exec.pause(POLL);
        }
    }
    false
}

pub fn install() -> Result<Value> {
    let bin = current_bin()?;
    std::fs::create_dir_all(paths::data_dir())?;
    let socket = paths::socket_path();
    let ready = || ping(&socket).is_some();
    let mut result = match Manager::current() {
        Manager::Launchd => install_launchd(&bin, &ready)?,
        Manager::Systemd => install_systemd(&SystemExec, &paths::systemd_unit(), &bin, &ready)?,
        Manager::Schtasks => install_schtasks(&SystemExec, &bin, &ready)?,
    };
    result["socket"] = json!(socket);
    result["bin"] = json!(bin);
    result["log"] = json!(paths::serve_log());
    if result["pid"].is_null() {
        result["pid"] = json!(ping(&socket).and_then(|v| v["pid"].as_u64()));
    }
    Ok(result)
}

fn install_launchd(bin: &str, ready: &dyn Fn() -> bool) -> Result<Value> {
    let plist = paths::launch_agent();
    std::fs::create_dir_all(plist.parent().context("plist dir")?)?;
    let ctl = SystemLaunchctl;
    let domain = domain();
    unload(&ctl, &format!("{domain}/{LABEL}"))?;
    std::fs::write(&plist, render_plist(bin))?;
    let started = load(&ctl, &domain, &plist.to_string_lossy(), ready)?;
    Ok(json!({"manager": "launchd", "unit": plist, "plist": plist, "label": LABEL, "pid": started.pid, "ready": started.ready}))
}

fn systemd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn render_systemd_unit(bin: &str, log: &str) -> String {
    format!(
        "[Unit]\nDescription=gaze embedding daemon\n\n[Service]\nExecStart={} serve\nRestart=on-failure\nRestartSec=5\nStandardOutput=append:{log}\nStandardError=append:{log}\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(bin)
    )
}

pub fn missing_user_bus(output: &CommandOutput) -> bool {
    let text = format!("{}{}", output.stdout, output.stderr);
    ["Failed to connect to bus", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "No medium found", "systemctl: No such file"]
        .iter()
        .any(|needle| text.contains(needle))
}

fn systemctl(exec: &dyn Exec, args: &[&str]) -> CommandOutput {
    let mut full = vec!["--user"];
    full.extend_from_slice(args);
    exec.exec("systemctl", &full)
}

fn systemd_pid(exec: &dyn Exec) -> Option<u32> {
    let output = systemctl(exec, &["show", "-p", "MainPID", "--value", SYSTEMD_UNIT]);
    output.stdout.trim().parse().ok().filter(|pid| *pid > 0)
}

pub fn install_systemd(exec: &dyn Exec, unit: &Path, bin: &str, ready: &dyn Fn() -> bool) -> Result<Value> {
    std::fs::create_dir_all(unit.parent().context("unit dir")?)?;
    std::fs::write(unit, render_systemd_unit(bin, &paths::serve_log().to_string_lossy()))?;
    let base = json!({"manager": "systemd", "unit": unit, "label": SYSTEMD_UNIT});
    for args in [&["daemon-reload"][..], &["enable", "--now", SYSTEMD_UNIT][..]] {
        let output = systemctl(exec, args);
        if output.success {
            continue;
        }
        if missing_user_bus(&output) {
            let mut result = base;
            result["ready"] = json!(false);
            result["warning"] = json!(format!(
                "no hay bus de usuario de systemd ({}); la unidad quedó en {} pero no se activó. Actívala en una sesión con bus: systemctl --user enable --now {SYSTEMD_UNIT}",
                output.stderr.trim(),
                unit.display()
            ));
            return Ok(result);
        }
        return Err(anyhow!("systemctl --user {} falló: {}", args.join(" "), output.stderr.trim()));
    }
    let mut result = base;
    result["ready"] = json!(wait_ready(exec, ready));
    result["pid"] = json!(systemd_pid(exec));
    Ok(result)
}

pub fn uninstall_systemd(exec: &dyn Exec, unit: &Path) -> Result<bool> {
    systemctl(exec, &["disable", "--now", SYSTEMD_UNIT]);
    let existed = unit.exists();
    if existed {
        std::fs::remove_file(unit)?;
    }
    systemctl(exec, &["daemon-reload"]);
    Ok(existed)
}

pub fn schtasks_command(bin: &str) -> String {
    format!("\"{bin}\" serve --detach")
}

pub fn install_schtasks(exec: &dyn Exec, bin: &str, ready: &dyn Fn() -> bool) -> Result<Value> {
    let command = schtasks_command(bin);
    let created = exec.exec("schtasks", &["/Create", "/SC", "ONLOGON", "/TN", TASK_NAME, "/TR", &command, "/RL", "LIMITED", "/F"]);
    if !created.success {
        return Err(anyhow!("schtasks /Create falló: {}", created.stderr.trim()));
    }
    let run = exec.exec("schtasks", &["/Run", "/TN", TASK_NAME]);
    if !run.success {
        return Err(anyhow!("schtasks /Run falló: {}", run.stderr.trim()));
    }
    Ok(json!({"manager": "schtasks", "unit": TASK_NAME, "label": TASK_NAME, "ready": wait_ready(exec, ready)}))
}

pub fn uninstall_schtasks(exec: &dyn Exec, stop: &dyn Fn() -> bool) -> Result<bool> {
    if !exec.exec("schtasks", &["/Query", "/TN", TASK_NAME]).success {
        return Ok(false);
    }
    exec.exec("schtasks", &["/End", "/TN", TASK_NAME]);
    stop();
    let deleted = exec.exec("schtasks", &["/Delete", "/TN", TASK_NAME, "/F"]);
    if !deleted.success {
        return Err(anyhow!("schtasks /Delete falló: {}", deleted.stderr.trim()));
    }
    Ok(true)
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
    let manager = Manager::current();
    let removed = match manager {
        Manager::Launchd => remove(&SystemLaunchctl, &format!("{}/{LABEL}", domain()), &paths::launch_agent())?,
        Manager::Systemd => uninstall_systemd(&SystemExec, &paths::systemd_unit())?,
        Manager::Schtasks => uninstall_schtasks(&SystemExec, &|| shutdown(&paths::socket_path()))?,
    };
    let mut result = json!({"manager": manager.name(), "unit": manager.unit(), "removed": removed});
    if manager == Manager::Launchd {
        result["plist"] = json!(paths::launch_agent());
    }
    Ok(result)
}

fn service_state(manager: Manager, exec: &dyn Exec) -> (bool, JobState) {
    match manager {
        Manager::Launchd => {
            let installed = paths::launch_agent().exists();
            let job = if installed { job_state(&SystemLaunchctl, &format!("{}/{LABEL}", domain())) } else { JobState::Missing };
            (installed, job)
        }
        Manager::Systemd => {
            let installed = paths::systemd_unit().exists();
            if !installed {
                return (false, JobState::Missing);
            }
            let active = systemctl(exec, &["is-active", SYSTEMD_UNIT]);
            let state = active.stdout.trim();
            if state == "active" || state == "activating" || state == "reloading" {
                (true, JobState::Loaded { pid: systemd_pid(exec) })
            } else {
                (true, JobState::Missing)
            }
        }
        Manager::Schtasks => {
            let query = exec.exec("schtasks", &["/Query", "/TN", TASK_NAME, "/FO", "LIST"]);
            if !query.success {
                return (false, JobState::Missing);
            }
            if query.stdout.contains("Running") { (true, JobState::Loaded { pid: None }) } else { (true, JobState::Missing) }
        }
    }
}

pub fn status() -> Value {
    let socket = paths::socket_path();
    let alive = ping(&socket);
    let manager = Manager::current();
    let (installed, job) = service_state(manager, &SystemExec);
    let manager_pid = match job {
        JobState::Loaded { pid } => pid,
        JobState::Missing => None,
    };
    json!({
        "socket": socket,
        "running": alive.is_some(),
        "pid": alive.as_ref().and_then(|v| v["pid"].as_u64()),
        "manager": manager.name(),
        "unit": manager.unit(),
        "installed": installed,
        "launchAgent": installed,
        "loaded": matches!(job, JobState::Loaded { .. }),
        "managerPid": manager_pid,
        "launchdPid": manager_pid,
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

        fn ok(stdout: String) -> CommandOutput {
            CommandOutput { success: true, stdout, stderr: String::new() }
        }

        fn fail(stderr: &str) -> CommandOutput {
            CommandOutput { success: false, stdout: String::new(), stderr: stderr.into() }
        }
    }

    impl Launchctl for FakeLaunchctl {
        fn run(&self, args: &[&str]) -> CommandOutput {
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

    struct FakeExec {
        calls: RefCell<Vec<String>>,
        fail_with: Option<&'static str>,
    }

    impl FakeExec {
        fn new(fail_with: Option<&'static str>) -> Self {
            Self { calls: RefCell::new(Vec::new()), fail_with }
        }
    }

    impl Exec for FakeExec {
        fn exec(&self, program: &str, args: &[&str]) -> CommandOutput {
            self.calls.borrow_mut().push(format!("{program} {}", args.join(" ")));
            if let Some(stderr) = self.fail_with {
                return CommandOutput { success: false, stdout: String::new(), stderr: stderr.into() };
            }
            let stdout = if args.contains(&"MainPID") { "4321\n".to_string() } else { String::new() };
            CommandOutput { success: true, stdout, stderr: String::new() }
        }

        fn pause(&self, _duration: Duration) {}
    }

    #[test]
    fn systemd_unit_quotes_the_binary_and_logs_to_the_serve_log() {
        let unit = render_systemd_unit("/opt/my gaze/gaze", "/home/k/.local/share/gaze/serve.log");
        assert!(unit.contains("ExecStart=\"/opt/my gaze/gaze\" serve\n"), "{unit}");
        assert!(unit.contains("StandardOutput=append:/home/k/.local/share/gaze/serve.log"));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn systemd_install_enables_the_user_unit_and_reports_the_pid() {
        let dir = tempfile::tempdir().unwrap();
        let unit = dir.path().join("systemd/user/gaze.service");
        let exec = FakeExec::new(None);
        let result = install_systemd(&exec, &unit, "/usr/bin/gaze", &|| true).unwrap();
        assert!(unit.exists());
        assert_eq!(result["ready"], true);
        assert_eq!(result["pid"], 4321);
        let calls = exec.calls.borrow();
        assert_eq!(calls[0], "systemctl --user daemon-reload");
        assert_eq!(calls[1], "systemctl --user enable --now gaze.service");
        drop(calls);
        assert!(uninstall_systemd(&exec, &unit).unwrap());
        assert!(!unit.exists());
        assert!(exec.calls.borrow().contains(&"systemctl --user disable --now gaze.service".to_string()));
    }

    #[test]
    fn systemd_install_warns_instead_of_failing_without_a_user_bus() {
        let dir = tempfile::tempdir().unwrap();
        let unit = dir.path().join("gaze.service");
        let exec = FakeExec::new(Some("Failed to connect to bus: No medium found"));
        let result = install_systemd(&exec, &unit, "/usr/bin/gaze", &|| true).unwrap();
        assert_eq!(result["ready"], false);
        assert!(result["warning"].as_str().unwrap().contains("systemctl --user enable --now gaze.service"));
        assert!(unit.exists());
        let other = FakeExec::new(Some("Unit file is masked"));
        assert!(install_systemd(&other, &unit, "/usr/bin/gaze", &|| true).is_err());
    }

    #[test]
    fn schtasks_install_creates_a_logon_task_and_runs_it() {
        let exec = FakeExec::new(None);
        let result = install_schtasks(&exec, r"C:\Users\k\gaze.exe", &|| true).unwrap();
        assert_eq!(result["ready"], true);
        let calls = exec.calls.borrow();
        assert_eq!(calls[0], r#"schtasks /Create /SC ONLOGON /TN gaze-daemon /TR "C:\Users\k\gaze.exe" serve --detach /RL LIMITED /F"#);
        assert_eq!(calls[1], "schtasks /Run /TN gaze-daemon");
        drop(calls);
        let stopped = Cell::new(false);
        assert!(
            uninstall_schtasks(&exec, &|| {
                stopped.set(true);
                true
            })
            .unwrap()
        );
        assert!(stopped.get());
        assert!(exec.calls.borrow().contains(&"schtasks /Delete /TN gaze-daemon /F".to_string()));
        assert!(!uninstall_schtasks(&FakeExec::new(Some("ERROR: not found")), &|| panic!("nothing to stop")).unwrap());
    }

    #[test]
    fn serve_log_appends_lines_and_detects_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs/serve.log");
        let log = ServeLog::new(Some(path.clone()));
        log.line("one");
        log.line("two");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.lines().count() == 2 && text.contains(" one\n") && text.ends_with(" two\n"), "{text}");
        assert!(is_shutdown("{\"op\":\"shutdown\"}\n"));
        assert!(!is_shutdown("{\"op\":\"ping\"}"));
        assert_eq!(serve_args(Some(5)), ["serve", "--idle-minutes", "5"]);
        assert_eq!(serve_args(None), ["serve"]);
    }
}
