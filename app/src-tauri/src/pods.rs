//! Pods (BlueStacks) commands: they only call `pods.ps1`; no BlueStacks logic lives here.

use crate::settings::Settings;
use crate::util::{hidden_command, is_valid_pod_name};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

/// powershell -NoProfile -ExecutionPolicy Bypass -File <pods.ps1> <args...>
fn run_pods(settings: &Settings, args: &[&str]) -> Result<PsOutput, String> {
    let script = script_path(settings)?;
    let out = hidden_command("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(args)
        .env("AGENTAUTO_APK_DIR", &settings.apk_dir)
        .env("AGENTAUTO_PODS_WSP_FILE", &settings.pods_wsp_file)
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
}
