//! Warm-up profile operations. All the rules live in the Node engine (`perfil-api.js`); this module only
//! runs it with a JSON payload on stdin and returns its JSON answer, so the app and the engine never diverge.

use crate::settings::Settings;
use crate::util::hidden_command;
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

/// `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }` -> Ok(data) / Err(error).
pub fn parse_output(stdout: &str) -> Result<Value, String> {
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .ok_or_else(|| format!("Respuesta inesperada del motor de perfiles: {}", stdout.chars().take(200).collect::<String>()))?;
    let value: Value = serde_json::from_str(line).map_err(|e| format!("Respuesta del motor no válida: {e}"))?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value.get("error").and_then(Value::as_str).unwrap_or("Error desconocido del motor de perfiles.").to_string())
    }
}

/// Adds the running profile (if any) so the engine can refuse to touch it.
pub fn with_running(mut payload: Value, running: Option<&str>) -> Value {
    if let (Some(name), Some(map)) = (running, payload.as_object_mut()) {
        map.insert("running".to_string(), json!(name));
    }
    payload
}

pub fn call(settings: &Settings, command: &str, payload: &Value) -> Result<Value, String> {
    let script = Path::new(&settings.warmup_dir).join("perfil-api.js");
    if !script.is_file() {
        return Err(format!("No encuentro perfil-api.js en {}. Revisa Ajustes.", settings.warmup_dir));
    }
    let mut child = hidden_command(&settings.node_path)
        .arg("perfil-api.js")
        .arg(command)
        .arg("--stdin")
        .current_dir(&settings.warmup_dir)
        .env("AGENTAUTO_DATA_DIR", &settings.data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo iniciar Node ({}): {e}", settings.node_path))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.to_string().as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("El motor de perfiles no respondió: {}", stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")));
    }
    parse_output(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_ok_and_error_answers() {
        assert_eq!(parse_output("{\"ok\":true,\"data\":{\"a\":1}}\n").unwrap(), json!({"a": 1}));
        assert_eq!(parse_output("{\"ok\":false,\"error\":\"No existe\"}").unwrap_err(), "No existe");
        assert!(parse_output("").is_err());
        assert!(parse_output("{broken").is_err());
        // Stray warnings before the JSON line are ignored.
        assert!(parse_output("(node:1) Warning\n{\"ok\":true,\"data\":null}").is_ok());
    }

    #[test]
    fn running_profile_is_injected() {
        assert_eq!(with_running(json!({"name": "a"}), Some("a")), json!({"name": "a", "running": "a"}));
        assert_eq!(with_running(json!({"name": "a"}), None), json!({"name": "a"}));
    }

    fn engine_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("engines").join("warmup")
    }

    /// Runs the real engine against a throw-away data dir (no bots, no sessions touched).
    #[test]
    fn talks_to_the_real_engine_with_a_temp_data_dir() {
        let dir = std::env::temp_dir().join(format!("agentautox1-profiles-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.json"), r#"{"groupName":"G","botNumber":"573000000000","testers":["tester1"]}"#).unwrap();
        fs::write(dir.join("profiles.json"), "{}").unwrap();

        let mut settings = Settings::defaults(Path::new("C:/x"));
        settings.warmup_dir = engine_dir().to_string_lossy().into_owned();
        settings.data_dir = dir.to_string_lossy().into_owned();

        let created = call(&settings, "create", &json!({"name": "ñandú", "selections": [{"testerId": "tester1"}, {"phone": "3001112233"}]})).unwrap();
        assert_eq!(created["profile"]["testers"], json!(["tester1", "tester2"]));
        let listed = call(&settings, "list", &json!({"pods": []})).unwrap();
        assert_eq!(listed["profiles"][0]["name"], "ñandú");
        let blocked = call(&settings, "delete", &with_running(json!({"name": "ñandú"}), Some("ñandú"))).unwrap_err();
        assert!(blocked.contains("en curso"));
        call(&settings, "delete", &json!({"name": "ñandú"})).unwrap();
        assert!(dir.join("backups").is_dir());
        let _ = fs::remove_dir_all(&dir);
    }
}
