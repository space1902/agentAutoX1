//! "Alertas" panel backend: the in-app alerts monitor and the WhatsApp linking by pairing code.
//! Both are long-lived Node children (`engines/ads/monitor-cli.js`) started and stopped here, following the
//! warm-up runner: output is streamed to the UI as events and a stop is graceful (Ctrl+Break so the WhatsApp
//! session is closed cleanly, `taskkill` of THAT pid only as the fallback). The monitor is OFF until the user
//! turns it on, and it refuses to start on top of the standalone meta-ads-monitor unless the user confirms.

use crate::ads::{ads_dir, TOKEN_ENV};
use crate::settings::Settings;
use crate::util::hidden_group_command;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

const MAX_LOG_LINES: usize = 500;
/// The standalone monitor counts as "running" when its log changed this recently.
pub const CONFLICT_WINDOW: Duration = Duration::from_secs(20 * 60);

/// Sends an event to the UI (`AppHandle::emit` in the app, a collector in tests).
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

// ---------------------------------------------------------------- paths and guards

/// `<ventas automaticas>/meta-ads-monitor`, next to the agentAutoX1 folder.
pub fn standalone_dir(root: &Path) -> PathBuf {
    root.parent().unwrap_or(root).join("meta-ads-monitor")
}

/// Minutes since the standalone monitor last wrote its log, when that is within `window` (it looks active).
pub fn standalone_active(log_file: &Path, now: SystemTime, window: Duration) -> Option<u64> {
    let modified = std::fs::metadata(log_file).and_then(|m| m.modified()).ok()?;
    let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
    (age <= window).then_some(age.as_secs() / 60)
}

pub fn conflict_minutes(root: &Path) -> Option<u64> {
    standalone_active(&standalone_dir(root).join("data").join("monitor.log"), SystemTime::now(), CONFLICT_WINDOW)
}

/// `<data dir>/ads/.baileys_auth/alerts`: the session of the in-app monitor.
pub fn session_dir(settings: &Settings) -> PathBuf {
    Path::new(&settings.data_dir).join("ads").join(".baileys_auth").join("alerts")
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(to)?;
    let mut copied = 0;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied += copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// COPIES (never moves) the standalone monitor's WhatsApp session into the app data dir. The source is not touched:
/// the same session must not be used by two processes at once, so the UI warns about it.
pub fn import_session(root: &Path, dest: &Path, overwrite: bool) -> Result<usize, String> {
    let source = standalone_dir(root).join(".baileys_auth").join("alerts");
    if !source.join("creds.json").is_file() {
        return Err("No encuentro una sesión vinculada en meta-ads-monitor.".to_string());
    }
    if dest.join("creds.json").is_file() && !overwrite {
        return Err("Ya hay una sesión de WhatsApp en la app. Confirma para reemplazarla.".to_string());
    }
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| format!("No se pudo reemplazar la sesión anterior: {e}"))?;
    }
    copy_dir(&source, dest).map_err(|e| format!("No se pudo copiar la sesión: {e}"))
}

// ---------------------------------------------------------------- child process with streamed output

#[derive(Default)]
struct Inner {
    pid: Option<u32>,
    logs: VecDeque<String>,
    status: Option<Value>,
}

#[derive(Clone, Default)]
pub struct Proc(Arc<Mutex<Inner>>);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub logs: Vec<String>,
    pub status: Option<Value>,
}

impl Proc {
    pub fn status(&self) -> ProcStatus {
        let g = self.0.lock().unwrap();
        ProcStatus { running: g.pid.is_some(), pid: g.pid, logs: g.logs.iter().cloned().collect(), status: g.status.clone() }
    }

    pub fn is_running(&self) -> bool {
        self.0.lock().unwrap().pid.is_some()
    }

    fn push_log(&self, emit: &Emit, event: &str, line: String) {
        {
            let mut g = self.0.lock().unwrap();
            if g.logs.len() >= MAX_LOG_LINES {
                g.logs.pop_front();
            }
            g.logs.push_back(line.clone());
        }
        emit(event, json!({ "line": line }));
    }

    /// Spawns `cmd` (stdout = one JSON per line). `on_json` handles every parsed line; events are `<prefix>-log`,
    /// `<prefix>-status`, `<prefix>-exit`.
    fn spawn(&self, mut cmd: std::process::Command, prefix: &'static str, emit: Emit) -> Result<u32, String> {
        {
            let mut g = self.0.lock().unwrap();
            if g.pid.is_some() {
                return Err("Ya está en marcha.".to_string());
            }
            g.pid = Some(0); // reserve the slot so two quick clicks cannot start two children
            g.logs.clear();
            g.status = None;
        }
        let mut child = match cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
            Ok(c) => c,
            Err(e) => {
                self.0.lock().unwrap().pid = None;
                return Err(format!("No se pudo iniciar Node: {e}"));
            }
        };
        let pid = child.id();
        self.0.lock().unwrap().pid = Some(pid);

        let log_event: Arc<str> = Arc::from(format!("{prefix}-log"));
        let mut readers = Vec::new();
        if let Some(out) = child.stdout.take() {
            let (proc, emit, log_event) = (self.clone(), emit.clone(), log_event.clone());
            readers.push(std::thread::spawn(move || {
                for line in lines(out) {
                    match serde_json::from_str::<Value>(line.trim()) {
                        Ok(value) => proc.handle_json(&emit, prefix, &log_event, value),
                        Err(_) => proc.push_log(&emit, &log_event, line),
                    }
                }
            }));
        }
        if let Some(err) = child.stderr.take() {
            let (proc, emit, log_event) = (self.clone(), emit.clone(), log_event.clone());
            readers.push(std::thread::spawn(move || {
                for line in lines(err) {
                    proc.push_log(&emit, &log_event, line);
                }
            }));
        }
        let proc = self.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            for r in readers {
                let _ = r.join();
            }
            proc.0.lock().unwrap().pid = None;
            emit(&format!("{prefix}-exit"), json!({ "code": code }));
        });
        Ok(pid)
    }

    fn handle_json(&self, emit: &Emit, prefix: &str, log_event: &str, value: Value) {
        match value.get("type").and_then(Value::as_str) {
            Some("log") => self.push_log(emit, log_event, value.get("line").and_then(Value::as_str).unwrap_or_default().to_string()),
            Some("status") => {
                self.0.lock().unwrap().status = Some(value.clone());
                emit(&format!("{prefix}-status"), value);
            }
            Some("fatal") | Some("error") => {
                self.push_log(emit, log_event, format!("Error: {}", value.get("error").and_then(Value::as_str).unwrap_or("desconocido")));
                emit(&format!("{prefix}-status"), value);
            }
            // Anything else (pairing_code, linked...) goes to the UI as it is.
            _ => emit(&format!("{prefix}-status"), value),
        }
    }

    /// Ctrl+Break so the engine closes WhatsApp cleanly, then `taskkill /T` of this pid, then `/F` as the last resort.
    /// Only the pid of THIS child is ever touched.
    pub fn stop(&self) -> Result<(), String> {
        let pid = match self.0.lock().unwrap().pid {
            Some(p) if p != 0 => p,
            _ => return Err("No hay nada en marcha.".to_string()),
        };
        if crate::warmup::send_ctrl_break(pid) && self.wait_exit(pid, Duration::from_secs(10)) {
            return Ok(());
        }
        let _ = crate::warmup::taskkill(pid, false);
        if self.wait_exit(pid, Duration::from_secs(5)) {
            return Ok(());
        }
        let _ = crate::warmup::taskkill(pid, true);
        if self.wait_exit(pid, Duration::from_secs(5)) { Ok(()) } else { Err("No se pudo detener el proceso.".to_string()) }
    }

    fn wait_exit(&self, pid: u32, limit: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if self.0.lock().unwrap().pid != Some(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        self.0.lock().unwrap().pid != Some(pid)
    }
}

fn lines(source: impl Read) -> impl Iterator<Item = String> {
    let mut reader = BufReader::new(source);
    std::iter::from_fn(move || {
        let mut buf = Vec::new();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string()),
        }
    })
}

// ---------------------------------------------------------------- the two children

fn engine_command(settings: &Settings, args: &[&str]) -> Result<std::process::Command, String> {
    let dir = ads_dir(settings);
    if !dir.join("monitor-cli.js").is_file() {
        return Err(format!("No encuentro monitor-cli.js en {}. Revisa Ajustes.", dir.display()));
    }
    let mut cmd = hidden_group_command(&settings.node_path);
    cmd.arg("--disable-warning=ExperimentalWarning").arg("monitor-cli.js").args(args).current_dir(&dir).env("AGENTAUTO_DATA_DIR", &settings.data_dir);
    Ok(cmd)
}

/// Digits only, 8 to 15 of them (the engine normalizes again).
pub fn valid_phone(phone: &str) -> bool {
    let digits = phone.chars().filter(char::is_ascii_digit).count();
    phone.chars().all(|c| c.is_ascii_digit() || matches!(c, '+' | ' ' | '-' | '(' | ')')) && (8..=15).contains(&digits)
}

#[derive(Clone, Default)]
pub struct Alerts {
    pub monitor: Proc,
    pub link: Proc,
}

impl Alerts {
    /// `confirm_conflict`: the user saw the "standalone monitor looks active" warning and wants to go on.
    pub fn start_monitor(&self, settings: &Settings, root: &Path, token: Option<String>, confirm_conflict: bool, emit: Emit) -> Result<u32, String> {
        let token = token.ok_or("Falta el token de Meta. Impórtalo o pégalo en la configuración de Anuncios.")?;
        if self.link.is_running() {
            return Err("Termina primero la vinculación de WhatsApp.".to_string());
        }
        if let Some(minutes) = conflict_minutes(root) {
            if !confirm_conflict {
                return Err(format!(
                    "CONFLICTO: parece que el monitor aparte está corriendo (escribió su registro hace {minutes} min). Detenlo antes para no recibir alertas dobles."
                ));
            }
        }
        let mut cmd = engine_command(settings, &["run"])?;
        cmd.env(TOKEN_ENV, token);
        self.monitor.spawn(cmd, "ads-monitor", emit)
    }

    pub fn start_link(&self, settings: &Settings, phone: &str, emit: Emit) -> Result<u32, String> {
        if !valid_phone(phone) {
            return Err("Escribe el número del remitente con código de país (solo dígitos).".to_string());
        }
        if self.monitor.is_running() {
            return Err("Detén el monitor antes de vincular WhatsApp: la sesión no puede usarse en dos procesos a la vez.".to_string());
        }
        let digits: String = phone.chars().filter(char::is_ascii_digit).collect();
        let cmd = engine_command(settings, &["link", "--phone", &digits])?;
        self.link.spawn(cmd, "ads-link", emit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn collector() -> (Emit, Arc<Mutex<Vec<(String, Value)>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        (Arc::new(move |name: &str, payload: Value| sink.lock().unwrap().push((name.to_string(), payload))), events)
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentautox1-alerts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_standalone_monitor_looks_active_only_when_its_log_is_fresh() {
        let dir = temp("conflict");
        let log = dir.join("monitor.log");
        assert_eq!(standalone_active(&log, SystemTime::now(), CONFLICT_WINDOW), None, "no log, no conflict");
        File::create(&log).unwrap();
        assert_eq!(standalone_active(&log, SystemTime::now(), CONFLICT_WINDOW), Some(0));
        let old = SystemTime::now() - Duration::from_secs(30 * 60);
        File::options().write(true).open(&log).unwrap().set_modified(old).unwrap();
        assert_eq!(standalone_active(&log, SystemTime::now(), CONFLICT_WINDOW), None);
        let recent = SystemTime::now() - Duration::from_secs(5 * 60);
        File::options().write(true).open(&log).unwrap().set_modified(recent).unwrap();
        assert_eq!(standalone_active(&log, SystemTime::now(), CONFLICT_WINDOW), Some(5));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn importing_the_session_copies_and_never_touches_the_source() {
        let base = temp("import");
        let root = base.join("agentAutoX1");
        let source = base.join("meta-ads-monitor").join(".baileys_auth").join("alerts");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("creds.json"), "{\"me\":1}").unwrap();
        std::fs::write(source.join("pre-key-1.json"), "k").unwrap();
        let dest = base.join("data").join("ads").join(".baileys_auth").join("alerts");

        assert_eq!(import_session(&root, &dest, false).unwrap(), 2);
        assert!(dest.join("creds.json").is_file());
        assert!(source.join("creds.json").is_file(), "the original session stays where it was");

        let again = import_session(&root, &dest, false).unwrap_err();
        assert!(again.contains("Confirma"));
        std::fs::write(source.join("pre-key-2.json"), "k2").unwrap();
        assert_eq!(import_session(&root, &dest, true).unwrap(), 3);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn importing_without_a_source_session_explains_it() {
        let base = temp("nosource");
        let err = import_session(&base.join("agentAutoX1"), &base.join("dest"), false).unwrap_err();
        assert!(err.contains("No encuentro"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn phones_need_digits_and_a_plausible_length() {
        assert!(valid_phone("573001234567"));
        assert!(valid_phone("+57 300 123 4567"));
        assert!(!valid_phone("123"));
        assert!(!valid_phone("57300123456789012345"));
        assert!(!valid_phone("5730012; calc"));
    }

    #[test]
    fn the_monitor_refuses_to_start_on_top_of_the_standalone_one_without_confirmation() {
        let base = temp("guard");
        let root = base.join("agentAutoX1");
        let data = base.join("meta-ads-monitor").join("data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        File::create(data.join("monitor.log")).unwrap();
        let mut settings = Settings::defaults(&root);
        settings.warmup_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("engines").join("warmup").to_string_lossy().into_owned();
        let (emit, _) = collector();
        let alerts = Alerts::default();

        let err = alerts.start_monitor(&settings, &root, Some("tok".into()), false, emit.clone()).unwrap_err();
        assert!(err.starts_with("CONFLICTO"));
        assert!(!alerts.monitor.is_running());
        let no_token = alerts.start_monitor(&settings, &root, None, true, emit).unwrap_err();
        assert!(no_token.contains("token"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn linking_is_refused_while_the_monitor_runs_or_with_a_bad_phone() {
        let alerts = Alerts::default();
        let settings = Settings::defaults(Path::new("C:/x"));
        let (emit, _) = collector();
        assert!(alerts.start_link(&settings, "12", emit.clone()).is_err());
        alerts.monitor.0.lock().unwrap().pid = Some(1);
        assert!(alerts.start_link(&settings, "573001234567", emit).unwrap_err().contains("Detén el monitor"));
    }

    /// A stand-in for monitor-cli.js: prints a log, a status and a pairing code, then waits for Ctrl+Break.
    #[cfg(windows)]
    #[test]
    fn streams_json_lines_and_stops_gracefully_with_ctrl_break() {
        let script = "console.log(JSON.stringify({type:'log',line:'hola'}));console.log(JSON.stringify({type:'status',monitor:{tz:'UTC'}}));console.log(JSON.stringify({type:'pairing_code',code:'ABCD-1234'}));console.log('texto suelto');process.on('SIGBREAK',()=>{console.log(JSON.stringify({type:'log',line:'cerrando'}));process.exit(0)});setInterval(()=>{},1000)";
        let mut cmd = hidden_group_command("node");
        cmd.args(["-e", script]);
        let (emit, events) = collector();
        let proc = Proc::default();
        proc.spawn(cmd, "ads-monitor", emit).unwrap();
        let start = Instant::now();
        while proc.status().logs.len() < 2 || proc.status().status.is_none() {
            assert!(start.elapsed() < Duration::from_secs(10), "no output");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(proc.is_running());
        proc.stop().unwrap();
        let start = Instant::now();
        while proc.is_running() {
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(300));
        let status = proc.status();
        assert!(status.logs.iter().any(|l| l == "hola"));
        assert!(status.logs.iter().any(|l| l == "texto suelto"));
        assert!(status.logs.iter().any(|l| l == "cerrando"), "the SIGBREAK handler ran: {:?}", status.logs);
        let events = events.lock().unwrap();
        assert!(events.iter().any(|(n, v)| n == "ads-monitor-status" && v["code"] == "ABCD-1234"));
        assert!(events.iter().any(|(n, _)| n == "ads-monitor-exit"));
        assert!(proc.stop().is_err(), "nothing left to stop");
    }
}
