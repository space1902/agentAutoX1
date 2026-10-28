//! Pods (BlueStacks) commands: they only call `pods.ps1`; no BlueStacks logic lives here.

use crate::settings::Settings;
use crate::util::{hidden_command, is_valid_pod_name, pods_phone};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

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
    let out = pods_command(settings, args)?
        .output()
        .map_err(|e| format!("No se pudo ejecutar PowerShell: {e}"))?;
    Ok(PsOutput {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
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
    matches!(action, "prender" | "apagar" | "ver")
}

pub fn run_action(settings: &Settings, action: &str, name: &str) -> Result<String, String> {
    if !is_allowed_action(action) {
        return Err(format!("Acción no permitida: {action}"));
    }
    if !is_valid_pod_name(name) {
        return Err(format!("Nombre de pod no válido: {name}"));
    }
    let out = run_pods(settings, &[action, name])?;
    if out.ok {
        Ok(last_lines(&out.stdout, 3))
    } else {
        let detail = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
        Err(last_lines(detail, 4))
    }
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

struct Streamed {
    ok: bool,
    stderr: String,
}

/// Runs the command and hands every stdout line to `on_line` as soon as it is printed.
fn stream_lines(mut cmd: Command, mut on_line: impl FnMut(&str)) -> Result<Streamed, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar el proceso: {e}"))?;
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let mut reader = BufReader::new(child.stdout.take().expect("stdout is piped"));
    let mut buf = Vec::new();
    while let Ok(n) = reader.read_until(b'\n', &mut buf) {
        if n == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
        buf.clear();
        on_line(&line);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok(Streamed { ok: status.success(), stderr: stderr_reader.join().unwrap_or_default() })
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

/// Only one pod mutation (create, rename, delete, phone) may run at a time: they restart BlueStacks.
#[derive(Clone, Default, Debug)]
pub struct PodJob(Arc<Mutex<Option<String>>>);

#[derive(Debug)]
pub struct PodJobGuard(PodJob);

impl PodJob {
    pub fn begin(&self, what: &str) -> Result<PodJobGuard, String> {
        let mut slot = self.0.lock().unwrap();
        if let Some(current) = slot.as_ref() {
            return Err(format!("Ya hay una operación de pods en curso ({current}). Espera a que termine."));
        }
        *slot = Some(what.to_string());
        Ok(PodJobGuard(self.clone()))
    }

    pub fn current(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

impl Drop for PodJobGuard {
    fn drop(&mut self) {
        *(self.0).0.lock().unwrap() = None;
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
    let streamed = stream_lines(pods_command(settings, &["nuevo", name])?, |line| {
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
    fn parses_empty_array() {
        assert!(parse_pods_json("[]").unwrap().is_empty());
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_pods_json("Error: BlueStacks no está instalado").is_err());
    }

    #[test]
    fn only_whitelisted_actions() {
        assert!(is_allowed_action("prender") && is_allowed_action("apagar") && is_allowed_action("ver"));
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
        let out = stream_lines(cmd, |l| seen.push(l.to_string())).unwrap();
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
}
