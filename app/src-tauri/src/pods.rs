//! Pods (BlueStacks) commands: they only call `pods.ps1`; no BlueStacks logic lives here.

use crate::settings::Settings;
use crate::util::{hidden_command, is_valid_pod_name, pods_phone};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pod {
    pub name: String,
    pub instance_id: String,
    /// "running" | "stopped"
    pub state: String,
    pub serial: Option<String>,
    pub adb_port: u32,
    pub phone: Option<String>,
}

/// Parses the stdout of `pods.ps1 listar-json`, tolerating a BOM or stray text before the array.
pub fn parse_pods_json(stdout: &str) -> Result<Vec<Pod>, String> {
    let text = stdout.trim_start_matches('\u{feff}').trim();
    let start = text
        .find('[')
        .ok_or_else(|| format!("Respuesta inesperada de pods.ps1: {}", preview(text)))?;
    serde_json::from_str::<Vec<Pod>>(&text[start..])
        .map_err(|e| format!("JSON de pods.ps1 no válido ({e}): {}", preview(text)))
}

fn preview(text: &str) -> String {
    let t: String = text.chars().take(300).collect();
    if t.is_empty() { "(vacía)".into() } else { t }
}

#[derive(Debug)]
struct PsOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn script_path(settings: &Settings) -> Result<PathBuf, String> {
    let script = PathBuf::from(&settings.pods_dir).join("pods.ps1");
    if script.is_file() {
        Ok(script)
    } else {
        Err(format!("No encuentro pods.ps1 en {}. Revisa Ajustes.", script.display()))
    }
}

/// powershell -NoProfile -ExecutionPolicy Bypass -File <pods.ps1> <args...> -NoInteractivo
/// (stdin is closed and the script never asks anything; its output is UTF-8).
fn pods_command(settings: &Settings, args: &[&str]) -> Result<Command, String> {
    let script = script_path(settings)?;
    let mut cmd = hidden_command("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(args)
        .arg("-NoInteractivo")
        .env("AGENTAUTO_APK_DIR", &settings.apk_dir)
        .env("AGENTAUTO_PODS_WSP_FILE", &settings.pods_wsp_file)
        .stdin(Stdio::null());
    Ok(cmd)
}

fn run_pods(settings: &Settings, args: &[&str]) -> Result<PsOutput, String> {
    let timeout = timeout_for(args.first().copied().unwrap_or_default());
    run_bounded(&PODS_PROCS, pods_command(settings, args)?, timeout)
}

/// How long `pods.ps1 <action>` may take before the app gives up on it. Every wait is finite: a hung script (adb or
/// the Android boot never answering, a PowerShell that crashed and left something holding its pipes) must never keep
/// the pod-job lock, and with it the whole Pods section, busy forever.
pub fn timeout_for(action: &str) -> Duration {
    let minutes = |m: u64| Duration::from_secs(m * 60);
    match action {
        "listar-json" | "info-json" | "wsp" | "ver" | "abrir-wa" => Duration::from_secs(90),
        "apagar" => minutes(3),
        "prender" => minutes(8),
        // worst case 10 min install + 20 min compile + 20 min retry (+ the Android boot): leave room for all of it.
        "reinstalar-wa" => minutes(60),
        "renombrar" | "borrar" => minutes(10),
        "nuevo" => minutes(30),
        _ => minutes(5),
    }
}

/// PIDs of the child processes this app spawned for pod jobs, so a recovery can stop exactly those and nothing else
/// (never BlueStacks/HD-Player or any process found by name).
#[derive(Default)]
pub struct Tracker {
    pids: Mutex<BTreeSet<u32>>,
    /// Bumped by every `kill_all`: a call that sees it change knows it was cancelled on purpose.
    epoch: AtomicU64,
}

/// The children of every pod job of the running app.
pub static PODS_PROCS: Tracker = Tracker::new();

pub struct Tracked<'a> {
    tracker: &'a Tracker,
    pid: u32,
}

impl Drop for Tracked<'_> {
    fn drop(&mut self) {
        crate::util::lock(&self.tracker.pids).remove(&self.pid);
    }
}

impl Tracker {
    pub const fn new() -> Tracker {
        Tracker { pids: Mutex::new(BTreeSet::new()), epoch: AtomicU64::new(0) }
    }

    fn track(&self, pid: u32) -> Tracked<'_> {
        crate::util::lock(&self.pids).insert(pid);
        Tracked { tracker: self, pid }
    }

    pub fn active(&self) -> Vec<u32> {
        crate::util::lock(&self.pids).iter().copied().collect()
    }

    /// `taskkill /T` on every tracked child (its own process tree only). Returns how many were targeted.
    pub fn kill_all(&self) -> usize {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let pids = self.active();
        for pid in &pids {
            kill_tree(*pid);
        }
        pids.len()
    }

    fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
}

/// Kills one process and the children it started, by PID.
fn kill_tree(pid: u32) {
    let _ = hidden_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Collects a pipe on its own thread. What was read so far survives even when the pipe never reaches EOF.
struct PipeReader {
    buf: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

impl PipeReader {
    fn spawn(pipe: Option<impl Read + Send + 'static>) -> PipeReader {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let (tx, done) = mpsc::channel();
        let sink = buf.clone();
        std::thread::spawn(move || {
            if let Some(mut pipe) = pipe {
                let mut chunk = [0u8; 4096];
                while let Ok(n) = pipe.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    crate::util::lock(&sink).extend_from_slice(&chunk[..n]);
                }
            }
            let _ = tx.send(());
        });
        PipeReader { buf, done }
    }

    /// Waits up to `grace` for EOF, then returns whatever arrived.
    fn collect(self, grace: Duration) -> String {
        let _ = self.done.recv_timeout(grace);
        String::from_utf8_lossy(&crate::util::lock(&self.buf)).into_owned()
    }
}

/// After the child exited, a grandchild (adb daemon, HD-Player...) can keep its pipes open forever: only wait this long.
const PIPE_GRACE: Duration = Duration::from_secs(2);

fn timed_out_message(timeout: Duration) -> String {
    format!("PowerShell no respondió en {} s y se canceló.", timeout.as_secs())
}

fn cancelled_message() -> String {
    "La operación se canceló.".to_string()
}

/// Waits for the child, killing its tree at `timeout`. Returns the exit status and whether it timed out.
fn wait_bounded(child: &mut Child, timeout: Duration) -> Result<(Option<std::process::ExitStatus>, bool), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok((Some(status), false)),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                kill_tree(child.id());
                let _ = child.kill();
                return Ok((child.wait().ok(), true));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Runs `cmd` to completion with a hard time limit. Never waits on the pipes alone: a crashed script whose pipes are
/// still held by a grandchild returns as soon as the script itself is gone.
fn run_bounded(tracker: &Tracker, mut cmd: Command, timeout: Duration) -> Result<PsOutput, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar PowerShell: {e}"))?;
    let _tracked = tracker.track(child.id());
    let epoch = tracker.epoch();
    let stdout = PipeReader::spawn(child.stdout.take());
    let stderr = PipeReader::spawn(child.stderr.take());

    let (status, timed_out) = wait_bounded(&mut child, timeout)?;
    let stdout = stdout.collect(PIPE_GRACE);
    let stderr = stderr.collect(PIPE_GRACE);
    if tracker.epoch() != epoch {
        return Err(cancelled_message());
    }
    if timed_out {
        return Err(timed_out_message(timeout));
    }
    Ok(PsOutput { ok: status.is_some_and(|s| s.success()), stdout, stderr })
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

pub fn list(settings: &Settings) -> Result<Vec<Pod>, String> {
    let out = run_pods(settings, &["listar-json"])?;
    if !out.ok {
        let detail = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
        return Err(last_lines(detail, 4));
    }
    parse_pods_json(&out.stdout)
}

/// Paths BlueStacks installed (`pods.ps1 info-json`): needed to talk to a pod over adb.
#[derive(Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlueStacksInfo {
    pub adb: String,
    pub hd_player: String,
}

pub fn parse_info_json(stdout: &str) -> Result<BlueStacksInfo, String> {
    let line = stdout
        .lines()
        .rev()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .find(|l| l.starts_with('{'))
        .ok_or_else(|| format!("Respuesta inesperada de pods.ps1: {}", preview(stdout.trim())))?;
    serde_json::from_str(line).map_err(|e| format!("JSON de pods.ps1 no válido ({e}): {}", preview(line)))
}

pub fn bluestacks_info(settings: &Settings) -> Result<BlueStacksInfo, String> {
    let out = run_pods(settings, &["info-json"])?;
    if !out.ok {
        let detail = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
        return Err(last_lines(detail, 4));
    }
    parse_info_json(&out.stdout)
}

/// Actions the UI may trigger on a single pod.
pub fn is_allowed_action(action: &str) -> bool {
    matches!(action, "prender" | "apagar" | "ver" | "abrir-wa" | "reinstalar-wa")
}

/// Long actions that must hold the pod-job lock for their whole run (so nothing else touches pods meanwhile).
pub fn holds_pod_job(action: &str) -> bool {
    action == "reinstalar-wa"
}

/// Stable marker `pods.ps1` puts in the error when WhatsApp Business is missing from a pod.
pub const WA_MISSING_MARKER: &str = "[WA_FALTA]";

const WA_MISSING_MESSAGE: &str = "WhatsApp se perdió en este pod, normalmente tras un apagado brusco. Tus datos siguen ahí. Repáralo para reinstalarlo sin borrar la cuenta.";

/// Turns a failed script's output into what the user sees: the marked WhatsApp-missing line, or the last `n` lines
/// without PowerShell position/stack noise.
pub fn clean_script_error(detail: &str, n: usize) -> String {
    if detail.contains(WA_MISSING_MARKER) {
        return format!("{WA_MISSING_MARKER} {WA_MISSING_MESSAGE}");
    }
    let cleaned: Vec<String> = detail
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !is_ps_noise(l))
        .map(strip_script_prefix)
        .collect();
    if cleaned.is_empty() {
        return last_lines(detail, n);
    }
    cleaned[cleaned.len().saturating_sub(n)..].join("\n")
}

fn is_ps_noise(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    (l.starts_with("at ") && l.contains(" char:")) || l.starts_with('+') || l.starts_with("categoryinfo") || l.starts_with("fullyqualifiederrorid")
}

/// `C:\...\pods.ps1 : message` -> `message`.
fn strip_script_prefix(line: &str) -> String {
    match line.find(".ps1 : ") {
        Some(i) if line[..i].contains(['\\', '/']) => line[i + 7..].to_string(),
        _ => line.to_string(),
    }
}

/// Starting two BlueStacks instances at the same time can leave the second one stuck while it boots (a window that
/// never answers, 30 MB of memory, no adb serial). `pods.ps1 prender` only returns once Android finished booting, so
/// holding this gate for the whole call makes every start wait for the previous pod to be ready.
static START_GATE: Mutex<()> = Mutex::new(());

/// Actions that start an instance and therefore go through the gate one at a time.
pub fn serializes_starts(action: &str) -> bool {
    action == "prender"
}

pub fn run_action(settings: &Settings, action: &str, name: &str) -> Result<String, String> {
    if !is_allowed_action(action) {
        return Err(format!("Acción no permitida: {action}"));
    }
    if !is_valid_pod_name(name) {
        return Err(format!("Nombre de pod no válido: {name}"));
    }
    let _gate = serializes_starts(action).then(|| crate::util::lock(&START_GATE));
    let out = run_pods(settings, &[action, name])?;
    if out.ok {
        Ok(last_lines(&out.stdout, 3))
    } else {
        let detail = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
        Err(clean_script_error(detail, 4))
    }
}

/// `getprop sys.boot_completed` prints 1 once Android finished booting.
pub fn parse_boot_completed(stdout: &str) -> bool {
    stdout.trim() == "1"
}

/// Path of BlueStacks' adb, looked up once (it is a PowerShell round trip).
fn adb_path(settings: &Settings) -> Result<String, String> {
    static ADB: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(path) = ADB.get() {
        return Ok(path.clone());
    }
    let path = bluestacks_info(settings)?.adb;
    Ok(ADB.get_or_init(|| path).clone())
}

/// True when Android on `serial` reports `sys.boot_completed` = 1. Any failure or a slow adb counts as "not yet": it
/// never waits more than a few seconds and never touches BlueStacks itself.
pub fn boot_completed(settings: &Settings, serial: &str) -> bool {
    let Ok(adb) = adb_path(settings) else { return false };
    let Ok(mut child) = hidden_command(adb)
        .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill(); // our own short-lived adb client, never the BlueStacks process
                let _ = child.wait();
                return false;
            }
        }
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    parse_boot_completed(&out)
}

/// `[3/9] Primer arranque` -> (3, 9, "Primer arranque"). Other lines are not steps.
pub fn parse_step(line: &str) -> Option<(u32, u32, String)> {
    let rest = line.trim().strip_prefix('[')?;
    let (counts, text) = rest.split_once(']')?;
    let (n, total) = counts.split_once('/')?;
    let (n, total): (u32, u32) = (n.parse().ok()?, total.parse().ok()?);
    if n == 0 || n > total {
        return None;
    }
    Some((n, total, text.trim().to_string()))
}

#[derive(Debug)]
struct Streamed {
    ok: bool,
    stderr: String,
}

/// Runs the command and hands every stdout line to `on_line` as soon as it is printed. Bounded by `timeout` and
/// tracked like `run_bounded`.
fn stream_lines(tracker: &Tracker, mut cmd: Command, timeout: Duration, mut on_line: impl FnMut(&str)) -> Result<Streamed, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar el proceso: {e}"))?;
    let _tracked = tracker.track(child.id());
    let epoch = tracker.epoch();
    let stderr = PipeReader::spawn(child.stderr.take());

    let (tx, lines) = mpsc::channel::<String>();
    let stdout = child.stdout.take().expect("stdout is piped");
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        while let Ok(n) = reader.read_until(b'\n', &mut buf) {
            if n == 0 {
                break;
            }
            let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
            buf.clear();
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut exited_at: Option<Instant> = None;
    loop {
        match lines.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => on_line(&line),
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                if exited_at.is_none() && child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    exited_at = Some(Instant::now());
                }
                if exited_at.is_some_and(|at| at.elapsed() >= PIPE_GRACE) {
                    break; // the script is gone; something else still holds its pipe
                }
                if exited_at.is_none() && Instant::now() >= deadline {
                    timed_out = true;
                    kill_tree(child.id());
                    let _ = child.kill();
                    break;
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = stderr.collect(PIPE_GRACE);
    if tracker.epoch() != epoch {
        return Err(cancelled_message());
    }
    if timed_out {
        return Err(timed_out_message(timeout));
    }
    Ok(Streamed { ok: status.success(), stderr })
}

/// One line of `nuevo` output for the UI.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PodProgress {
    pub step: Option<u32>,
    pub total: Option<u32>,
    pub text: String,
    pub line: String,
}

/// Only one pod mutation (create, rename, delete, phone, keep-alive check...) may run at a time: they restart BlueStacks.
///
/// The slot is released by the guard's `Drop` on every exit path (return, `?`, panic unwinding). If a holder is stuck
/// anyway, `force_release` frees it: the tokens make sure the stuck holder's guard cannot release a newer job later.
#[derive(Clone, Default, Debug)]
pub struct PodJob(Arc<Mutex<JobSlot>>);

#[derive(Default, Debug)]
struct JobSlot {
    next_token: u64,
    current: Option<(u64, String)>,
}

#[derive(Debug)]
pub struct PodJobGuard {
    job: PodJob,
    token: u64,
}

impl PodJob {
    pub fn begin(&self, what: &str) -> Result<PodJobGuard, String> {
        let mut slot = crate::util::lock(&self.0);
        if let Some((_, current)) = slot.current.as_ref() {
            return Err(format!("Ya hay una operación de pods en curso ({current}). Espera a que termine."));
        }
        slot.next_token += 1;
        let token = slot.next_token;
        slot.current = Some((token, what.to_string()));
        Ok(PodJobGuard { job: self.clone(), token })
    }

    pub fn current(&self) -> Option<String> {
        crate::util::lock(&self.0).current.as_ref().map(|(_, what)| what.clone())
    }

    /// Frees the slot no matter who holds it. Returns what was running, if anything.
    pub fn force_release(&self) -> Option<String> {
        crate::util::lock(&self.0).current.take().map(|(_, what)| what)
    }
}

impl Drop for PodJobGuard {
    fn drop(&mut self) {
        let mut slot = crate::util::lock(&self.job.0);
        if slot.current.as_ref().is_some_and(|(token, _)| *token == self.token) {
            slot.current = None;
        }
    }
}

fn failure_detail(stdout_tail: &str, stderr: &str) -> String {
    let detail = if stderr.trim().is_empty() { stdout_tail } else { stderr };
    last_lines(detail, 4)
}

fn checked_name(name: &str) -> Result<(), String> {
    if is_valid_pod_name(name) {
        Ok(())
    } else {
        Err(format!("Nombre de pod no válido: «{name}». Usa letras, números, guion y guion bajo (máximo 24)."))
    }
}

/// Creates a pod (about 12-15 minutes, 9 steps, may close and reopen BlueStacks) and stores its phone afterwards.
pub fn create(settings: &Settings, name: &str, phone: &str, on_progress: &mut dyn FnMut(PodProgress)) -> Result<String, String> {
    checked_name(name)?;
    let phone = pods_phone(phone)?.ok_or("Indica el número de WhatsApp del pod.")?;
    if list(settings)?.iter().any(|p| p.name.eq_ignore_ascii_case(name)) {
        return Err(format!("Ya existe un pod llamado «{name}»."));
    }

    let mut tail: Vec<String> = Vec::new();
    let streamed = stream_lines(&PODS_PROCS, pods_command(settings, &["nuevo", name])?, timeout_for("nuevo"), |line| {
        let step = parse_step(line);
        if !line.trim().is_empty() {
            tail.push(line.to_string());
            if tail.len() > 12 {
                tail.remove(0);
            }
        }
        on_progress(PodProgress {
            step: step.as_ref().map(|s| s.0),
            total: step.as_ref().map(|s| s.1),
            text: step.map(|s| s.2).unwrap_or_default(),
            line: line.to_string(),
        });
    })?;
    if !streamed.ok {
        return Err(failure_detail(&tail.join("\n"), &streamed.stderr));
    }

    let saved = run_pods(settings, &["wsp", name, &phone])?;
    if !saved.ok {
        return Err(format!(
            "El pod «{name}» se creó, pero no se pudo guardar el número: {}",
            failure_detail(&saved.stdout, &saved.stderr)
        ));
    }
    Ok(format!("Pod «{name}» listo con el número {phone}. Registra WhatsApp a mano en su ventana de BlueStacks."))
}

pub fn rename(settings: &Settings, name: &str, new_name: &str) -> Result<String, String> {
    checked_name(name)?;
    checked_name(new_name)?;
    let out = run_pods(settings, &["renombrar", name, new_name])?;
    if out.ok { Ok(last_lines(&out.stdout, 2)) } else { Err(failure_detail(&out.stdout, &out.stderr)) }
}

/// Blank phone removes the number from the pod.
pub fn set_phone(settings: &Settings, name: &str, phone: &str) -> Result<String, String> {
    checked_name(name)?;
    let phone = pods_phone(phone)?.unwrap_or_default();
    let out = run_pods(settings, &["wsp", name, &phone])?;
    if out.ok { Ok(last_lines(&out.stdout, 2)) } else { Err(failure_detail(&out.stdout, &out.stderr)) }
}

/// Deletes the pod AND its WhatsApp account. `confirm` must be the typed pod name.
pub fn delete(settings: &Settings, name: &str, confirm: &str) -> Result<String, String> {
    checked_name(name)?;
    if confirm != name {
        return Err("Falta la confirmación: escribe el nombre exacto del pod para borrarlo.".to_string());
    }
    let out = run_pods(settings, &["borrar", name])?;
    if out.ok { Ok(last_lines(&out.stdout, 2)) } else { Err(failure_detail(&out.stdout, &out.stderr)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listing_with_bom_and_nulls() {
        let json = "\u{feff}[{\"name\":\"pod2\",\"instanceId\":\"Rvc64_1\",\"state\":\"stopped\",\"serial\":null,\"adbPort\":5565,\"phone\":\"3042339130\"}]";
        let pods = parse_pods_json(json).unwrap();
        assert_eq!(pods.len(), 1);
        assert_eq!(pods[0].adb_port, 5565);
        assert_eq!(pods[0].serial, None);
        assert_eq!(pods[0].phone.as_deref(), Some("3042339130"));
    }

    #[test]
    fn parses_bluestacks_info_with_bom_and_noise() {
        let out = "noise\n\u{feff}{\"adb\":\"C:\\\\BS\\\\HD-Adb.exe\",\"hdPlayer\":\"C:\\\\BS\\\\HD-Player.exe\"}\n";
        let info = parse_info_json(out).unwrap();
        assert!(info.adb.ends_with("HD-Adb.exe") && info.hd_player.ends_with("HD-Player.exe"));
        assert!(parse_info_json("nada").is_err());
    }

    #[test]
    fn boot_completed_is_exactly_one() {
        assert!(parse_boot_completed("1
"));
        assert!(!parse_boot_completed(""));
        assert!(!parse_boot_completed("0"));
        assert!(!parse_boot_completed("error: device offline"));
    }

    #[test]
    fn only_starting_a_pod_goes_through_the_one_at_a_time_gate() {
        assert!(serializes_starts("prender"));
        assert!(!serializes_starts("apagar") && !serializes_starts("ver") && !serializes_starts("abrir-wa"));
    }

    #[test]
    fn parses_empty_array() {
        assert!(parse_pods_json("[]").unwrap().is_empty());
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_pods_json("Error: BlueStacks no está instalado").is_err());
    }

    #[test]
    fn reinstalar_wa_is_allowed_and_holds_the_pod_job_but_stays_out_of_the_start_gate() {
        assert!(is_allowed_action("reinstalar-wa"));
        assert!(holds_pod_job("reinstalar-wa"));
        assert!(!holds_pod_job("prender") && !holds_pod_job("abrir-wa") && !holds_pod_job("ver"));
        assert!(!serializes_starts("reinstalar-wa"));
    }

    #[test]
    fn a_missing_whatsapp_error_becomes_one_marked_line() {
        let raw = [
            r"C:\x\pods.ps1 : [WA_FALTA] WhatsApp Business no está instalado en el pod 'a'.",
            r"At C:\x\pods.ps1:828 char:5",
            "+ throw",
            "    + CategoryInfo : OperationStopped",
            "    + FullyQualifiedErrorId : [WA_FALTA] x",
        ]
        .join("\n");
        let msg = clean_script_error(&raw, 4);
        assert!(msg.starts_with("[WA_FALTA] WhatsApp se perdió"), "{msg}");
        assert!(!msg.contains("At ") && !msg.contains("FullyQualifiedErrorId") && !msg.contains('\n'), "{msg}");
    }

    #[test]
    fn other_script_errors_lose_the_powershell_noise() {
        let raw = [
            r"C:\x\pods.ps1 : El pod 'a' está apagado.",
            r"At C:\x\pods.ps1:828 char:5",
            "+ throw",
            "    + CategoryInfo          : OperationStopped: (:) [], RuntimeException",
            "    + FullyQualifiedErrorId : El pod 'a' está apagado.",
        ]
        .join("\n");
        assert_eq!(clean_script_error(&raw, 4), "El pod 'a' está apagado.");
        assert_eq!(clean_script_error("uno\ndos", 4), "uno\ndos");
    }

    #[test]
    fn only_whitelisted_actions() {
        assert!(is_allowed_action("prender") && is_allowed_action("apagar") && is_allowed_action("ver") && is_allowed_action("abrir-wa"));
        assert!(!is_allowed_action("borrar") && !is_allowed_action("nuevo"));
    }

    #[test]
    fn run_action_rejects_bad_input_before_spawning() {
        let s = Settings::defaults(std::path::Path::new("C:/x"));
        assert!(run_action(&s, "borrar", "pod1").is_err());
        assert!(run_action(&s, "prender", "a; rm").is_err());
    }

    #[test]
    fn parses_step_lines_of_nuevo() {
        assert_eq!(parse_step("[3/9] Primer arranque (4 núcleos)"), Some((3, 9, "Primer arranque (4 núcleos)".to_string())));
        assert_eq!(parse_step("  [9/9] Abriendo WhatsApp Business  "), Some((9, 9, "Abriendo WhatsApp Business".to_string())));
        assert_eq!(parse_step("    Cierro BlueStacks un momento"), None);
        assert_eq!(parse_step("[x/9] no"), None);
        assert_eq!(parse_step("[0/9] cero"), None);
        assert_eq!(parse_step("[10/9] fuera de rango"), None);
    }

    #[test]
    fn streams_lines_as_they_arrive_and_reports_failure() {
        let mut cmd = hidden_command("node");
        cmd.args(["-e", "console.log('uno');console.log('[2/9] dos');console.error('boom');process.exit(3)"]);
        let mut seen = Vec::new();
        let out = stream_lines(&Tracker::new(), cmd, secs(30), |l| seen.push(l.to_string())).unwrap();
        assert!(!out.ok);
        assert_eq!(seen, vec!["uno", "[2/9] dos"]);
        assert!(out.stderr.contains("boom"));
    }

    #[test]
    fn only_one_pod_job_at_a_time() {
        let job = PodJob::default();
        let guard = job.begin("crear pod1").unwrap();
        let err = job.begin("borrar pod2").unwrap_err();
        assert!(err.contains("crear pod1"));
        assert_eq!(job.current().as_deref(), Some("crear pod1"));
        drop(guard);
        assert!(job.current().is_none());
        assert!(job.begin("borrar pod2").is_ok());
    }

    #[test]
    fn mutations_validate_before_spawning() {
        let s = Settings::defaults(std::path::Path::new("C:/x"));
        assert!(rename(&s, "pod1", "con espacio").is_err());
        assert!(rename(&s, "a;b", "ok").is_err());
        assert!(set_phone(&s, "pod1", "12").is_err());
        assert!(delete(&s, "pod1", "otro").unwrap_err().contains("confirm"));
        assert!(create(&s, "bad name", "3001234567", &mut |_| {}).is_err());
        assert!(create(&s, "pod9", "", &mut |_| {}).is_err());
    }
    // ----- job lock and bounded child processes -----

    #[test]
    fn the_job_guard_is_released_when_its_holder_panics() {
        let job = PodJob::default();
        let held = job.clone();
        let _ = std::thread::spawn(move || {
            let _guard = held.begin("revisión de pod2MX").unwrap();
            panic!("the worker died");
        })
        .join();
        assert!(job.current().is_none(), "unwinding drops the guard");
        assert!(job.begin("otra").is_ok());
    }

    #[test]
    fn a_poisoned_job_lock_does_not_wedge_the_pods_section() {
        let job = PodJob::default();
        let inner = job.0.clone();
        let _ = std::thread::spawn(move || {
            let _g = inner.lock().unwrap();
            panic!("poison it");
        })
        .join();
        let guard = job.begin("a").expect("begin tolerates a poisoned lock");
        drop(guard); // would panic inside Drop (abort during unwinding) if it used lock().unwrap()
        assert!(job.current().is_none());
    }

    #[test]
    fn force_release_frees_a_stuck_job_and_a_stale_guard_cannot_free_the_next_one() {
        let job = PodJob::default();
        let stale = job.begin("revisión de pod2MX").unwrap();
        assert_eq!(job.force_release().as_deref(), Some("revisión de pod2MX"));
        assert!(job.current().is_none());

        let fresh = job.begin("reiniciar pods").unwrap();
        drop(stale);
        assert_eq!(job.current().as_deref(), Some("reiniciar pods"), "the old holder must not release the new job");
        drop(fresh);
        assert!(job.current().is_none());
        assert!(job.force_release().is_none(), "nothing to release");
    }

    fn node(script: &str) -> Command {
        let mut cmd = hidden_command("node");
        cmd.args(["-e", script]);
        cmd
    }

    fn secs(n: u64) -> std::time::Duration {
        std::time::Duration::from_secs(n)
    }

    #[test]
    fn a_child_that_never_finishes_is_killed_at_the_timeout_and_reported() {
        let tracker = Tracker::new();
        let started = std::time::Instant::now();
        let err = run_bounded(&tracker, node("setTimeout(()=>{},60000)"), std::time::Duration::from_millis(800)).unwrap_err();
        assert!(err.contains("no respondió"), "{err}");
        assert!(started.elapsed() < secs(20), "did not wait for the child");
        assert!(tracker.active().is_empty(), "the pid is forgotten once the call returns");
    }

    #[test]
    fn a_child_that_crashes_is_a_plain_failure_not_a_hang() {
        let tracker = Tracker::new();
        let out = run_bounded(&tracker, node("console.error('boom');process.exit(3)"), secs(30)).unwrap();
        assert!(!out.ok);
        assert!(out.stderr.contains("boom"));
        assert!(tracker.active().is_empty());
    }

    #[test]
    fn a_grandchild_holding_the_pipe_open_does_not_block_after_the_child_exited() {
        let tracker = Tracker::new();
        // Like an adb daemon or HD-Player started by pods.ps1: it inherits stdout and outlives the script.
        let script = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:['ignore','inherit','inherit'],detached:true}).unref();console.log('hecho')";
        let started = std::time::Instant::now();
        let out = run_bounded(&tracker, node(script), secs(60)).unwrap();
        assert!(out.ok && out.stdout.contains("hecho"));
        assert!(started.elapsed() < secs(12), "returned without waiting for the pipe to close: {:?}", started.elapsed());
    }

    #[test]
    fn kill_all_stops_the_tracked_children_and_the_waiting_call_reports_a_cancellation() {
        let tracker = std::sync::Arc::new(Tracker::new());
        let worker = {
            let tracker = tracker.clone();
            std::thread::spawn(move || run_bounded(&tracker, node("setTimeout(()=>{},60000)"), secs(120)))
        };
        let begun = std::time::Instant::now();
        while tracker.active().is_empty() {
            assert!(begun.elapsed() < secs(20), "the child was never tracked");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(tracker.kill_all(), 1);
        let err = worker.join().unwrap().unwrap_err();
        assert!(err.contains("cancel"), "{err}");
        assert!(begun.elapsed() < secs(20));
        assert!(tracker.active().is_empty());
    }

    #[test]
    fn a_streamed_child_that_goes_silent_is_killed_at_the_timeout() {
        let tracker = Tracker::new();
        let mut seen = Vec::new();
        let started = std::time::Instant::now();
        let err = stream_lines(&tracker, node("console.log('uno');setTimeout(()=>{},60000)"), std::time::Duration::from_millis(1500), |l| seen.push(l.to_string())).unwrap_err();
        assert!(err.contains("no respondió"), "{err}");
        assert_eq!(seen, vec!["uno"]);
        assert!(started.elapsed() < secs(20));
    }

    #[test]
    fn every_pods_action_has_a_finite_timeout_and_starts_get_the_longest_short_one() {
        for action in ["listar-json", "info-json", "prender", "apagar", "ver", "abrir-wa", "wsp", "renombrar", "borrar", "nuevo", "algo-nuevo"] {
            let t = timeout_for(action);
            assert!(t >= secs(30) && t <= secs(60 * 60), "{action}: {t:?}");
        }
        assert_eq!(timeout_for("abrir-wa"), secs(90));
        // reinstalar-wa: worst case 10 min install + 20 min compile + 20 min retry, plus the Android boot and slack.
        assert_eq!(timeout_for("reinstalar-wa"), secs(60 * 60));
        assert!(timeout_for("prender") > timeout_for("apagar"));
        assert!(timeout_for("nuevo") > timeout_for("prender"));
    }
}
