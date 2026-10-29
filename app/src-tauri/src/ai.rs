//! "IA" section backend. Rules live in the Node engine (`ai-cli.js`); this module only
//!  - keeps API keys per provider in the Windows Credential Manager (never on disk, never in config.json),
//!  - runs the engine commands (injecting the key into the child env only when a command needs it),
//!  - streams Ollama model downloads and installs Ollama on request.

use crate::profiles::parse_output;
use crate::settings::Settings;
use crate::util::hidden_command;
use serde::Serialize;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const KEY_SERVICE: &str = "agentAutoX1";
/// Env var the engine reads the key from.
pub const KEY_ENV: &str = "AGENTAUTO_AI_KEY";

/// Engine commands the UI may call through `ai_call`.
const ALLOWED: &[&str] = &["presets", "config-get", "config-save", "ai-usage", "ai-test", "local-detect", "local-resources", "local-delete"];

// ---------------------------------------------------------------- keys

/// Provider ids are short slugs (`openrouter`, `local-openai`...); anything else never reaches the keyring.
pub fn valid_preset_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// "sk-…1234": enough to recognise the key, never enough to use it.
pub fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.trim().chars().collect();
    if chars.len() < 12 {
        return "••••••••".to_string();
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn entry(preset: &str, service: &str) -> Result<keyring::Entry, String> {
    if !valid_preset_id(preset) {
        return Err("Proveedor no válido.".to_string());
    }
    keyring::Entry::new(service, &format!("ai-key:{preset}")).map_err(|e| format!("No se pudo abrir el almacén de credenciales de Windows: {e}"))
}

fn get_key_in(service: &str, preset: &str) -> Result<Option<String>, String> {
    match entry(preset, service)?.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(Some(key)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("No se pudo leer la clave guardada: {e}")),
    }
}

fn set_key_in(service: &str, preset: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("La clave está vacía.".to_string());
    }
    entry(preset, service)?.set_password(key).map_err(|e| format!("No se pudo guardar la clave: {e}"))
}

fn clear_key_in(service: &str, preset: &str) -> Result<(), String> {
    match entry(preset, service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("No se pudo borrar la clave: {e}")),
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub present: bool,
    pub masked: String,
}

pub fn key_status(preset: &str) -> Result<KeyStatus, String> {
    Ok(match get_key_in(KEY_SERVICE, preset)? {
        Some(key) => KeyStatus { present: true, masked: mask_key(&key) },
        None => KeyStatus { present: false, masked: String::new() },
    })
}

pub fn set_key(preset: &str, key: &str) -> Result<KeyStatus, String> {
    set_key_in(KEY_SERVICE, preset, key)?;
    key_status(preset)
}

pub fn clear_key(preset: &str) -> Result<(), String> {
    clear_key_in(KEY_SERVICE, preset)
}

/// Provider whose key a run needs: the `ai.preset` of an openai-compatible config.
pub fn preset_from_config(config: &Value) -> Option<String> {
    let ai = config.get("ai")?;
    if ai.get("provider").and_then(Value::as_str) != Some("openai-compatible") {
        return None;
    }
    let preset = ai.get("preset").and_then(Value::as_str).unwrap_or("custom");
    valid_preset_id(preset).then(|| preset.to_string())
}

/// Key to inject into a profile's child env (None for local models or when no key is stored).
pub fn key_for_run(settings: &Settings) -> Option<String> {
    let text = std::fs::read_to_string(Path::new(&settings.data_dir).join("config.json")).ok()?;
    let config: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    get_key_in(KEY_SERVICE, &preset_from_config(&config)?).ok().flatten()
}

// ---------------------------------------------------------------- engine commands

fn cli_command(settings: &Settings, args: &[&str]) -> Result<std::process::Command, String> {
    let script = Path::new(&settings.warmup_dir).join("ai-cli.js");
    if !script.is_file() {
        return Err(format!("No encuentro ai-cli.js en {}. Revisa Ajustes.", settings.warmup_dir));
    }
    let mut cmd = hidden_command(&settings.node_path);
    cmd.arg("ai-cli.js").args(args).current_dir(&settings.warmup_dir).env("AGENTAUTO_DATA_DIR", &settings.data_dir);
    Ok(cmd)
}

/// Runs one engine command. `key` (when given) goes into the child env only.
pub fn call(settings: &Settings, command: &str, payload: &Value, key: Option<&str>) -> Result<Value, String> {
    if !ALLOWED.contains(&command) {
        return Err(format!("Comando de IA no permitido: {command}."));
    }
    let mut cmd = cli_command(settings, &[command, "--stdin"])?;
    if let Some(key) = key {
        cmd.env(KEY_ENV, key);
    }
    let mut child = cmd
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
        return Err(format!("El motor de IA no respondió: {}", stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")));
    }
    parse_output(&stdout)
}

/// Commands that call a paid API read the key of the provider named in the payload.
pub fn key_for_command(command: &str, payload: &Value) -> Result<Option<String>, String> {
    if command != "ai-test" {
        return Ok(None);
    }
    let preset = payload.pointer("/ai/preset").and_then(Value::as_str).unwrap_or("custom");
    if payload.pointer("/ai/provider").and_then(Value::as_str) != Some("openai-compatible") {
        return Ok(None);
    }
    get_key_in(KEY_SERVICE, preset)
}

// ---------------------------------------------------------------- model downloads

#[derive(Clone, Default)]
pub struct PullJob(Arc<Mutex<Option<Child>>>);

impl PullJob {
    /// Starts `ai-cli.js local-pull` and forwards each progress line as an `ai-pull` event.
    pub fn start(&self, app: &AppHandle, settings: &Settings, model: &str) -> Result<(), String> {
        {
            let g = self.0.lock().unwrap();
            if g.is_some() {
                return Err("Ya hay una descarga en curso.".to_string());
            }
        }
        let payload = json!({ "model": model }).to_string();
        let mut child = cli_command(settings, &["local-pull", "--json", &payload])?
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("No se pudo iniciar Node ({}): {e}", settings.node_path))?;
        let stdout = child.stdout.take();
        *self.0.lock().unwrap() = Some(child);

        let job = self.clone();
        let app = app.clone();
        let model = model.to_string();
        std::thread::spawn(move || {
            let mut finished = false;
            if let Some(out) = stdout {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    finished |= matches!(value.get("type").and_then(Value::as_str), Some("done" | "error"));
                    let _ = app.emit("ai-pull", value);
                }
            }
            let cancelled = {
                let mut g = job.0.lock().unwrap();
                let was_cancelled = g.is_none();
                if let Some(mut child) = g.take() {
                    let _ = child.wait();
                }
                was_cancelled
            };
            if !finished {
                let kind = if cancelled { "cancelled" } else { "error" };
                let _ = app.emit("ai-pull", json!({ "type": kind, "model": model, "error": "La descarga se interrumpió." }));
            }
        });
        Ok(())
    }

    /// Kills the download process; Ollama keeps the finished layers so a later pull resumes.
    pub fn cancel(&self) -> bool {
        let child = self.0.lock().unwrap().take();
        match child {
            Some(mut child) => {
                let _ = child.kill();
                true
            }
            None => false,
        }
    }
}

// ---------------------------------------------------------------- Ollama install

pub const OLLAMA_INSTALLER_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
pub const WINGET_ARGS: &[&str] =
    &["install", "--id", "Ollama.Ollama", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"];
/// Inno Setup silent flags (untested on this installer; failure falls back to the normal wizard).
pub const SILENT_ARGS: &[&str] = &["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"];

pub fn ollama_exe_candidates(local_app_data: Option<&str>) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(base) = local_app_data {
        list.push(Path::new(base).join("Programs").join("Ollama").join("ollama.exe"));
    }
    list.push(PathBuf::from(r"C:\Program Files\Ollama\ollama.exe"));
    list
}

pub fn ollama_exe() -> Option<PathBuf> {
    ollama_exe_candidates(std::env::var("LOCALAPPDATA").ok().as_deref()).into_iter().find(|p| p.is_file())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallEvent {
    stage: &'static str,
    message: String,
    done: bool,
    ok: bool,
}

fn emit(app: &AppHandle, stage: &'static str, message: impl Into<String>, done: bool, ok: bool) {
    let _ = app.emit("ai-install", InstallEvent { stage, message: message.into(), done, ok });
}

/// Splits on \r and \n: winget redraws its progress with carriage returns.
fn pump_lines(app: &AppHandle, stage: &'static str, source: impl Read) {
    let mut line = Vec::new();
    for byte in source.bytes().map_while(Result::ok) {
        if byte == b'\n' || byte == b'\r' {
            let text = String::from_utf8_lossy(&line).trim().to_string();
            if text.chars().any(|c| c.is_alphanumeric()) {
                emit(app, stage, text, false, false);
            }
            line.clear();
        } else {
            line.push(byte);
        }
    }
}

fn run_visible_output(app: &AppHandle, stage: &'static str, mut cmd: std::process::Command) -> Result<bool, String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    if let Some(out) = child.stdout.take() {
        pump_lines(app, stage, out);
    }
    Ok(child.wait().map_err(|e| e.to_string())?.success())
}

fn winget_available() -> bool {
    hidden_command("winget").arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

fn download_installer(app: &AppHandle) -> Result<PathBuf, String> {
    let target = std::env::temp_dir().join("OllamaSetup.exe");
    emit(app, "download", "Descargando el instalador de Ollama…", false, false);
    let script = format!("$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '{OLLAMA_INSTALLER_URL}' -OutFile '{}'", target.display());
    let ok = hidden_command("powershell").args(["-NoProfile", "-Command", &script]).status().is_ok_and(|s| s.success());
    if ok && target.is_file() { Ok(target) } else { Err("No se pudo descargar el instalador de Ollama.".to_string()) }
}

/// Installs Ollama in the background; progress goes out as `ai-install` events. The UI confirms first
/// and verifies afterwards through `local-detect` (`/api/version`).
pub fn install_ollama(app: AppHandle) {
    std::thread::spawn(move || {
        if ollama_exe().is_some() {
            emit(&app, "done", "Ollama ya está instalado.", true, true);
            return;
        }
        if winget_available() {
            emit(&app, "winget", "Instalando Ollama con winget…", false, false);
            let mut cmd = hidden_command("winget");
            cmd.args(WINGET_ARGS);
            if matches!(run_visible_output(&app, "winget", cmd), Ok(true)) && ollama_exe().is_some() {
                emit(&app, "done", "Ollama quedó instalado.", true, true);
                return;
            }
            emit(&app, "winget", "winget no pudo instalarlo; probando con el instalador directo…", false, false);
        }
        let installer = match download_installer(&app) {
            Ok(path) => path,
            Err(e) => return emit(&app, "done", e, true, false),
        };
        emit(&app, "install", "Instalando Ollama en silencio…", false, false);
        let silent = hidden_command(&installer).args(SILENT_ARGS).status().is_ok_and(|s| s.success());
        if silent && ollama_exe().is_some() {
            emit(&app, "done", "Ollama quedó instalado.", true, true);
            return;
        }
        // Silent flags failed: open the installer normally so the user can finish it.
        let _ = std::process::Command::new(&installer).spawn();
        emit(&app, "done", "La instalación silenciosa falló: abre el instalador de Ollama, termínalo y pulsa «Buscar de nuevo».", true, false);
    });
}

/// Starts `ollama serve` hidden when Ollama is installed but not answering.
pub fn launch_ollama() -> Result<(), String> {
    let exe = ollama_exe().ok_or("Ollama no está instalado.")?;
    hidden_command(exe).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_ids_are_slugs_only() {
        assert!(valid_preset_id("openrouter"));
        assert!(valid_preset_id("local-openai"));
        assert!(!valid_preset_id(""));
        assert!(!valid_preset_id("Open Router"));
        assert!(!valid_preset_id("a;b"));
        assert!(!valid_preset_id(&"a".repeat(33)));
    }

    #[test]
    fn masked_keys_never_reveal_the_middle() {
        assert_eq!(mask_key("sk-or-v1-abcdefghijklmnop1234"), "sk-…1234");
        assert_eq!(mask_key("short"), "••••••••");
        assert!(!mask_key("sk-or-v1-abcdefghijklmnop1234").contains("abcdef"));
    }

    #[test]
    fn only_openai_compatible_configs_need_a_key() {
        assert_eq!(preset_from_config(&json!({"ai": {"provider": "openai-compatible", "preset": "deepseek"}})), Some("deepseek".into()));
        assert_eq!(preset_from_config(&json!({"ai": {"provider": "openai-compatible"}})), Some("custom".into()));
        assert_eq!(preset_from_config(&json!({"ai": {"provider": "ollama"}})), None);
        assert_eq!(preset_from_config(&json!({"localModel": {"model": "x"}})), None);
        assert_eq!(preset_from_config(&json!({"ai": {"provider": "openai-compatible", "preset": "../x"}})), None);
    }

    #[test]
    fn ai_test_reads_the_key_only_for_external_providers() {
        assert_eq!(key_for_command("ai-usage", &json!({})).unwrap(), None);
        assert_eq!(key_for_command("ai-test", &json!({"ai": {"provider": "ollama"}})).unwrap(), None);
    }

    #[test]
    fn only_listed_engine_commands_are_callable() {
        let settings = Settings::defaults(Path::new("C:/x"));
        assert!(call(&settings, "config-save; calc", &json!({}), None).unwrap_err().contains("no permitido"));
    }

    #[test]
    fn install_commands_match_the_spec() {
        assert_eq!(WINGET_ARGS.join(" "), "install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements");
        assert_eq!(SILENT_ARGS, ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"]);
        assert_eq!(OLLAMA_INSTALLER_URL, "https://ollama.com/download/OllamaSetup.exe");
        let found = ollama_exe_candidates(Some(r"C:\Users\x\AppData\Local"));
        assert!(found[0].ends_with(Path::new("Programs").join("Ollama").join("ollama.exe")));
    }

    /// Real Credential Manager round trip with a throw-away service name (removed at the end).
    #[test]
    fn keys_round_trip_through_the_credential_manager() {
        let service = format!("agentAutoX1-test-{}", std::process::id());
        assert_eq!(get_key_in(&service, "openrouter").unwrap(), None);
        set_key_in(&service, "openrouter", "sk-or-v1-secret-value-1234").unwrap();
        assert_eq!(get_key_in(&service, "openrouter").unwrap().as_deref(), Some("sk-or-v1-secret-value-1234"));
        // Keys are per provider: another provider does not see it.
        assert_eq!(get_key_in(&service, "mistral").unwrap(), None);
        clear_key_in(&service, "openrouter").unwrap();
        assert_eq!(get_key_in(&service, "openrouter").unwrap(), None);
        assert!(set_key_in(&service, "openrouter", "   ").is_err());
    }

    /// Real engine, throw-away data dir: presets and a config round trip without any key in the file.
    #[test]
    fn talks_to_the_real_engine_without_storing_keys() {
        let dir = std::env::temp_dir().join(format!("agentautox1-ai-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"groupName":"G","testers":["tester1"]}"#).unwrap();
        let mut settings = Settings::defaults(Path::new("C:/x"));
        settings.warmup_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("engines").join("warmup").to_string_lossy().into_owned();
        settings.data_dir = dir.to_string_lossy().into_owned();

        let presets = call(&settings, "presets", &json!({}), None).unwrap();
        assert_eq!(presets["presets"][0]["id"], "openrouter");
        let ai = json!({"provider": "openai-compatible", "preset": "mistral", "model": "ministral-3b-2512", "dailyBudgetUsd": 1});
        call(&settings, "config-save", &json!({"ai": ai}), None).unwrap();
        assert_eq!(preset_from_config(&serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap()), Some("mistral".into()));
        assert!(call(&settings, "config-save", &json!({"ai": {"provider": "openai-compatible", "model": "m", "apiKey": "x"}}), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
