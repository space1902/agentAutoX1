//! "Voces" section backend (ElevenLabs). All the rules live in the Node engine (`engines/agent/voices-cli.js`); this module only
//!  - keeps the ElevenLabs key in the Windows Credential Manager (entry `elevenlabs-key`; never on disk, never returned to the UI),
//!  - runs the engine commands, handing the key to the child through the env (`AGENTAUTO_ELEVEN_KEY`) only for the commands
//!    that call ElevenLabs,
//!  - gives the Agente creativo's chat turn the same env variable (see `agents.rs`), the way the Meta token travels.

use crate::ads::parse_output;
use crate::agents::agent_dir;
use crate::ai::{mask_key, KeyStatus};
use crate::settings::{find_project_root, Settings};
use crate::util::hidden_command;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;

const KEY_SERVICE: &str = "agentAutoX1";
const KEY_ENTRY: &str = "elevenlabs-key";
/// Env var the engine reads the key from.
pub const KEY_ENV: &str = "AGENTAUTO_ELEVEN_KEY";
/// Env var that tells the engine which folder holds the products (the parent of this project's folder).
pub const ROOT_ENV: &str = "AGENTAUTO_CREATIVO_ROOT";

/// Engine commands the UI may call through `voices_call` (`engines/agent/voices-api.js` has the same list).
const ALLOWED: &[&str] = &["key-test", "voices", "subscription", "presets-get", "presets-set", "estimate", "generate", "audio-read", "context"];
/// The subset that calls ElevenLabs: only these get the key.
const NEEDS_KEY: &[&str] = &["key-test", "voices", "subscription", "generate"];

/// ElevenLabs keys are one run of letters, digits, `_` and `-`; anything else is a paste mistake.
pub fn valid_key(key: &str) -> bool {
    let k = key.trim();
    k.len() >= 16 && k.len() <= 200 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn entry(service: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, KEY_ENTRY).map_err(|e| format!("No se pudo abrir el almacén de credenciales de Windows: {e}"))
}

fn get_key_in(service: &str) -> Result<Option<String>, String> {
    match entry(service)?.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(Some(key)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("No se pudo leer la clave guardada: {e}")),
    }
}

fn set_key_in(service: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if !valid_key(key) {
        return Err("La clave no parece válida: debe ser una sola cadena sin espacios (letras, números, _ y -).".to_string());
    }
    entry(service)?.set_password(key).map_err(|e| format!("No se pudo guardar la clave: {e}"))
}

fn clear_key_in(service: &str) -> Result<(), String> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("No se pudo borrar la clave: {e}")),
    }
}

/// The stored key, for the child env only. Never log or return it.
pub fn stored_key() -> Result<Option<String>, String> {
    get_key_in(KEY_SERVICE)
}

/// Presence plus a masked tail ("sk_…1234"): enough to recognise the key, never enough to use it.
pub fn key_status() -> Result<KeyStatus, String> {
    Ok(match get_key_in(KEY_SERVICE)? {
        Some(key) => KeyStatus { present: true, masked: mask_key(&key) },
        None => KeyStatus { present: false, masked: String::new() },
    })
}

pub fn set_key(key: &str) -> Result<KeyStatus, String> {
    set_key_in(KEY_SERVICE, key)?;
    key_status()
}

pub fn clear_key() -> Result<(), String> {
    clear_key_in(KEY_SERVICE)
}

/// The workspace with the products: the folder that contains this project (`ventas automaticas`).
pub fn workspace_root() -> Option<PathBuf> {
    find_project_root().parent().map(PathBuf::from)
}

/// Does this command call ElevenLabs (and so need the key)?
pub fn needs_key(command: &str) -> bool {
    NEEDS_KEY.contains(&command)
}

/// Node arguments for one engine command.
pub fn build_args(command: &str) -> Result<Vec<String>, String> {
    if !ALLOWED.contains(&command) {
        return Err(format!("Comando de voces no permitido: {command}."));
    }
    Ok(["--disable-warning=ExperimentalWarning", "voices-cli.js", command, "--stdin"].map(String::from).to_vec())
}

/// Runs one engine command. `key` (when given) goes into the child env only.
pub fn call(settings: &Settings, command: &str, payload: &Value, key: Option<&str>) -> Result<Value, String> {
    let args = build_args(command)?;
    let dir = agent_dir(settings);
    if !dir.join("voices-cli.js").is_file() {
        return Err(format!("No encuentro voices-cli.js en {}. Revisa Ajustes.", dir.display()));
    }
    let mut cmd = hidden_command(&settings.node_path);
    cmd.args(args).current_dir(&dir).env("AGENTAUTO_DATA_DIR", &settings.data_dir);
    if let Some(root) = workspace_root() {
        cmd.env(ROOT_ENV, root);
    }
    match key {
        Some(k) => cmd.env(KEY_ENV, k),
        None => cmd.env_remove(KEY_ENV),
    };
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
        return Err(format!("El motor de voces no respondió: {}", stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")));
    }
    parse_output(&stdout)
}

/// Runs a command, reading the key from the keyring when (and only when) the command needs it.
pub fn call_with_stored_key(settings: &Settings, command: &str, payload: &Value) -> Result<Value, String> {
    if !ALLOWED.contains(&command) {
        return Err(format!("Comando de voces no permitido: {command}."));
    }
    let key = if needs_key(command) { stored_key()? } else { None };
    call(settings, command, payload, key.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_one_run_of_url_safe_characters() {
        assert!(valid_key("sk_0123456789abcdef0123456789abcdef"));
        assert!(valid_key("  sk_0123456789abcdef  "));
        for bad in ["", "corta", "con espacio 0123456789", "sk_0123456789\nabcdef0123", "clave;rm -rf 0123456789", &"a".repeat(201)] {
            assert!(!valid_key(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn only_listed_commands_reach_the_engine_and_only_some_get_the_key() {
        assert!(build_args("rm -rf").unwrap_err().contains("no permitido"));
        assert!(build_args("").is_err());
        let args = build_args("generate").unwrap();
        assert_eq!(args, ["--disable-warning=ExperimentalWarning", "voices-cli.js", "generate", "--stdin"]);
        for c in ["key-test", "voices", "subscription", "generate"] {
            assert!(needs_key(c), "{c}");
        }
        for c in ["presets-get", "presets-set", "estimate", "audio-read", "context"] {
            assert!(!needs_key(c), "{c}");
            assert!(ALLOWED.contains(&c));
        }
        let settings = Settings::defaults(std::path::Path::new("."));
        assert!(call(&settings, "calc", &json!({}), None).unwrap_err().contains("no permitido"));
        assert!(call_with_stored_key(&settings, "calc", &json!({})).unwrap_err().contains("no permitido"));
    }

    #[test]
    fn the_workspace_is_the_folder_that_holds_this_project() {
        let root = workspace_root().expect("project root has a parent");
        assert!(find_project_root().starts_with(&root));
    }
}
