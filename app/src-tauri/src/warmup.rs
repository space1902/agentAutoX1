//! Warm-up profile runner: spawns `node perfil.js usar "<profile>"`, streams its output to the UI
//! and stops the whole process tree cleanly so Baileys sessions are closed (not killed mid-write).

use crate::pairing::{PairingCard, PairingTracker};
use crate::settings::Settings;
use crate::util::{hidden_command, hidden_group_command};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MAX_LOG_LINES: usize = 2000;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// "stdout" | "stderr" | "system"
    pub stream: String,
    pub line: String,
}

#[derive(Default)]
struct Inner {
    profile: Option<String>,
    pid: Option<u32>,
    logs: VecDeque<LogLine>,
    pairing: PairingTracker,
}

/// Shared runner state (cheap to clone; all clones see the same data).
#[derive(Clone, Default)]
pub struct Runner(Arc<Mutex<Inner>>);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub profile: Option<String>,
    pub pid: Option<u32>,
    pub logs: Vec<LogLine>,
    pub pairing: Vec<PairingCard>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    code: Option<i32>,
}

impl Runner {
    pub fn status(&self) -> Status {
        let g = self.0.lock().unwrap();
        Status { running: g.pid.is_some(), profile: g.profile.clone(), pid: g.pid, logs: g.logs.iter().cloned().collect(), pairing: g.pairing.cards() }
    }

    fn push(&self, app: &AppHandle, stream: &str, line: String) {
        let entry = LogLine { stream: stream.to_string(), line };
        let mut pairing_changed = None;
        {
            let mut g = self.0.lock().unwrap();
            if stream == "stdout" && g.pairing.feed(&entry.line) {
                pairing_changed = Some(g.pairing.cards());
            }
            if g.logs.len() >= MAX_LOG_LINES {
                g.logs.pop_front();
            }
            g.logs.push_back(entry.clone());
        }
        let _ = app.emit("warmup-log", entry);
        if let Some(cards) = pairing_changed {
            let _ = app.emit("warmup-pairing", cards);
        }
    }

    fn is_running(&self, pid: u32) -> bool {
        self.0.lock().unwrap().pid == Some(pid)
    }

    pub fn start(&self, app: &AppHandle, settings: &Settings, profile: &str) -> Result<Status, String> {
        let script = Path::new(&settings.warmup_dir).join("perfil.js");
        if !script.is_file() {
            return Err(format!("No encuentro perfil.js en {}. Revisa Ajustes.", settings.warmup_dir));
        }
        if !crate::data::profile_exists(settings, profile)? {
            return Err(format!("El perfil «{profile}» no existe en {}.", settings.data_dir));
        }
        // Reserve the slot first so two quick clicks cannot start two profiles.
        {
            let mut g = self.0.lock().unwrap();
            if g.pid.is_some() {
                return Err(format!("Ya hay un perfil en curso: {}.", g.profile.clone().unwrap_or_default()));
            }
            g.pid = Some(0);
            g.profile = Some(profile.to_string());
            g.logs.clear();
            g.pairing.clear();
        }
        let mut command = hidden_group_command(&settings.node_path);
        command
            .arg("perfil.js")
            .arg("usar")
            .arg(profile)
            .current_dir(&settings.warmup_dir)
            .env("AGENTAUTO_DATA_DIR", &settings.data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // External AI: the provider's key goes into the child env only (never to disk or to the logs).
        if let Some(key) = crate::ai::key_for_run(settings) {
            command.env(crate::ai::KEY_ENV, key);
        }
        let spawned = command.spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let mut g = self.0.lock().unwrap();
                g.pid = None;
                g.profile = None;
                return Err(format!("No se pudo iniciar Node ({}): {e}", settings.node_path));
            }
        };
        let pid = child.id();
        self.0.lock().unwrap().pid = Some(pid);
        self.push(app, "system", format!("Perfil «{profile}» iniciado (PID {pid})."));

        let mut readers = Vec::new();
        if let Some(out) = child.stdout.take() {
            readers.push(self.pump(app.clone(), "stdout", out));
        }
        if let Some(err) = child.stderr.take() {
            readers.push(self.pump(app.clone(), "stderr", err));
        }
        let runner = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            for r in readers {
                let _ = r.join();
            }
            runner.push(&app, "system", format!("El proceso terminó (código {}).", code.map_or("?".into(), |c| c.to_string())));
            {
                let mut g = runner.0.lock().unwrap();
                g.pid = None;
                g.profile = None;
                g.pairing.clear();
            }
            let _ = app.emit("warmup-pairing", Vec::<PairingCard>::new());
            let _ = app.emit("warmup-exit", ExitEvent { code });
        });
        Ok(self.status())
    }

    fn pump(&self, app: AppHandle, stream: &'static str, source: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
        let runner = self.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(source);
            let mut buf = Vec::new();
            while let Ok(n) = reader.read_until(b'\n', &mut buf) {
                if n == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                buf.clear();
                runner.push(&app, stream, line);
            }
        })
    }

    /// Stops the running profile. Order: Ctrl+Break on its hidden console (the engine closes the sessions
    /// on SIGBREAK), `taskkill /T` without /F, then `taskkill /T /F` as the last resort.
    pub fn stop(&self, app: &AppHandle) -> Result<(), String> {
        let pid = match self.0.lock().unwrap().pid {
            Some(p) if p != 0 => p,
            _ => return Err("No hay ningún perfil en curso.".into()),
        };
        self.push(app, "system", "Deteniendo el perfil: cerrando las sesiones de WhatsApp...".into());

        if send_ctrl_break(pid) && self.wait_exit(pid, Duration::from_secs(10)) {
            return Ok(());
        }
        let _ = taskkill(pid, false);
        if self.wait_exit(pid, Duration::from_secs(5)) {
            return Ok(());
        }
        self.push(app, "system", "No respondió; se fuerza el cierre del árbol de procesos.".into());
        let _ = taskkill(pid, true);
        if self.wait_exit(pid, Duration::from_secs(5)) {
            Ok(())
        } else {
            Err("No se pudo terminar el proceso del perfil.".into())
        }
    }

    fn wait_exit(&self, pid: u32, limit: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if !self.is_running(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        !self.is_running(pid)
    }
}

/// `taskkill /PID <pid> /T [/F]`: terminates the process and its children.
pub(crate) fn taskkill(pid: u32, force: bool) -> bool {
    let mut cmd = hidden_command("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        cmd.arg("/F");
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(windows)]
mod console {
    pub type Handler = Option<unsafe extern "system" fn(u32) -> i32>;
    unsafe extern "system" {
        pub fn AttachConsole(process_id: u32) -> i32;
        pub fn FreeConsole() -> i32;
        pub fn SetConsoleCtrlHandler(handler: Handler, add: i32) -> i32;
        pub fn GenerateConsoleCtrlEvent(event: u32, group: u32) -> i32;
    }
}

/// Delivers CTRL_BREAK_EVENT to the child's process group (the child is its own group leader, so its
/// pid is the group id). The GUI process has no console of its own, so it attaches to the child's,
/// ignores the event for itself, fires it and detaches. Ctrl+Break is used instead of Ctrl+C because it
/// still works for processes started with Ctrl+C disabled. Serialized because console attachment is
/// process-global.
#[cfg(windows)]
pub fn send_ctrl_break(pid: u32) -> bool {
    static GUARD: Mutex<()> = Mutex::new(());
    let _lock = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        console::FreeConsole();
        if console::AttachConsole(pid) == 0 {
            return false;
        }
        console::SetConsoleCtrlHandler(None, 1); // this process ignores Ctrl+C
        let sent = console::GenerateConsoleCtrlEvent(1, pid) != 0;
        std::thread::sleep(Duration::from_millis(150));
        console::FreeConsole();
        console::SetConsoleCtrlHandler(None, 0);
        sent
    }
}

#[cfg(not(windows))]
pub fn send_ctrl_break(_pid: u32) -> bool {
    false
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A harmless Node script that exits cleanly on SIGBREAK (stands in for the real engine; no bots involved).
    #[test]
    fn ctrl_break_reaches_a_hidden_console_child() {
        let script = "process.on('SIGBREAK',()=>{console.log('closing');process.exit(0)});console.log('ready');setInterval(()=>{},1000)";
        let mut child = hidden_group_command("node")
            .args(["-e", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("node must be on PATH");
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut first = String::new();
        out.read_line(&mut first).unwrap();
        assert!(first.starts_with("ready"));
        assert!(send_ctrl_break(child.id()), "ctrl+break delivery failed");
        let start = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().unwrap() {
                break s;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "child did not exit after Ctrl+Break");
            std::thread::sleep(Duration::from_millis(100));
        };
        let mut rest = String::new();
        let _ = out.read_line(&mut rest);
        assert_eq!(status.code(), Some(0));
        assert!(rest.starts_with("closing"), "handler did not run: {rest:?}");
    }

    #[test]
    fn taskkill_terminates_a_tree() {
        let mut child = hidden_command("node").args(["-e", "setInterval(()=>{},1000)"]).spawn().unwrap();
        assert!(taskkill(child.id(), true));
        assert!(child.wait().is_ok());
    }
}
