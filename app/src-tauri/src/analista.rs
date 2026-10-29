//! "Analista" section backend. All the rules live in the Node engine (`engines/agent/agent-cli.js`); this module only
//!  - runs its one-shot commands (sessions, messages, lessons, settings...),
//!  - starts the streaming ones (a chat turn, the quality evaluation) as a child process, forwards every JSON event
//!    line to the UI and cancels ONLY that child (Ctrl+Break, then `taskkill /T` of that pid).
//! The Node child is the one that launches the locally installed Claude Code (the user's subscription, never an API
//! key); it parses `stream-json`, checks the figures and writes `agent.db`. Keeping that in Node makes it unit-testable.

use crate::ads::{ads_dir, parse_output};
use crate::alerts::{Emit, Proc};
use crate::settings::Settings;
use crate::util::{hidden_command, hidden_group_command};
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;

/// Commands answered with one `{ ok, data }` line.
const ONE_SHOT: &[&str] = &[
    "status", "sessions", "session-new", "session-rename", "session-delete", "messages", "settings-get", "settings-set", "queries",
    "lessons", "lesson-set", "lesson-edit", "learning-get", "feedback", "recommendations", "eval-bank", "eval-runs", "eval-run-detail",
];
/// Commands that stream JSON events until they finish.
const STREAMING: &[&str] = &["turn", "eval-run"];

const MAX_TEXT: usize = 8000;

/// `engines/agent`, a sibling of `engines/ads`.
pub fn agent_dir(settings: &Settings) -> PathBuf {
    let ads = ads_dir(settings);
    ads.parent().map(|p| p.join("agent")).unwrap_or_else(|| ads.join("agent"))
}

/// Session ids are UUIDs made by the engine; anything else never reaches the command line.
pub fn valid_session_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Checks the payload of a streaming command before spawning anything.
pub fn check_stream_payload(command: &str, payload: &Value) -> Result<(), String> {
    if !STREAMING.contains(&command) {
        return Err(format!("Comando del Analista no permitido: {command}."));
    }
    if command == "turn" {
        let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
        if text.trim().is_empty() {
            return Err("Escribe una pregunta.".to_string());
        }
        if text.chars().count() > MAX_TEXT {
            return Err(format!("La pregunta es demasiado larga (máximo {MAX_TEXT} caracteres)."));
        }
        if let Some(id) = payload.get("sessionId").and_then(Value::as_str) {
            if !id.is_empty() && !valid_session_id(id) {
                return Err("El chat no es válido.".to_string());
            }
        }
    }
    if command == "eval-run" {
        if let Some(ids) = payload.get("ids") {
            let ok = ids.as_array().is_some_and(|a| a.len() <= 100 && a.iter().all(|v| v.as_str().is_some_and(|s| s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))));
            if !ok {
                return Err("La selección de preguntas no es válida.".to_string());
            }
        }
    }
    Ok(())
}

/// Node arguments for one engine command. The payload travels as a single `--json` argument (no shell involved).
pub fn build_args(command: &str, payload: Option<&Value>) -> Vec<String> {
    let mut out = vec!["--disable-warning=ExperimentalWarning".to_string(), "agent-cli.js".to_string(), command.to_string()];
    if let Some(p) = payload {
        out.push("--json".to_string());
        out.push(p.to_string());
    }
    out
}

/// Variables that would let a child fall back to a paid API: never handed down, whatever the app was started with.
const SCRUB_ENV: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK"];

fn command_for(settings: &Settings, args: &[String], grouped: bool) -> Result<std::process::Command, String> {
    let dir = agent_dir(settings);
    if !dir.join("agent-cli.js").is_file() {
        return Err(format!("No encuentro agent-cli.js en {}. Revisa Ajustes.", dir.display()));
    }
    let mut cmd = if grouped { hidden_group_command(&settings.node_path) } else { hidden_command(&settings.node_path) };
    cmd.args(args).current_dir(&dir).env("AGENTAUTO_DATA_DIR", &settings.data_dir);
    for key in SCRUB_ENV {
        cmd.env_remove(key);
    }
    Ok(cmd)
}

/// Runs a one-shot command and returns its `data`.
pub fn call(settings: &Settings, command: &str, payload: &Value) -> Result<Value, String> {
    if !ONE_SHOT.contains(&command) {
        return Err(format!("Comando del Analista no permitido: {command}."));
    }
    let mut cmd = command_for(settings, &["--disable-warning=ExperimentalWarning".to_string(), "agent-cli.js".to_string(), command.to_string(), "--stdin".to_string()], false)?;
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
        return Err(format!("El Analista no respondió: {}", stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")));
    }
    parse_output(&stdout)
}

#[derive(Clone, Default)]
pub struct Analista {
    /// The chat turn in progress (events: `analista-status`, `analista-log`, `analista-exit`).
    pub chat: Proc,
    /// The quality evaluation in progress (events: `analista-eval-status`, ...).
    pub eval: Proc,
}

impl Analista {
    pub fn start(&self, settings: &Settings, command: &str, payload: &Value, emit: Emit) -> Result<u32, String> {
        check_stream_payload(command, payload)?;
        // One Claude run at a time: they all draw from the same plan limits.
        if self.chat.is_running() || self.eval.is_running() {
            return Err("El Analista ya está trabajando. Espera a que termine o cancélalo.".to_string());
        }
        let cmd = command_for(settings, &build_args(command, Some(payload)), true)?;
        match command {
            "turn" => self.chat.spawn(cmd, "analista", emit),
            _ => self.eval.spawn(cmd, "analista-eval", emit),
        }
    }

    pub fn cancel(&self) -> Result<(), String> {
        if self.chat.is_running() {
            return self.chat.stop();
        }
        if self.eval.is_running() {
            return self.eval.stop();
        }
        Err("No hay nada en marcha.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_ids_are_uuids_only() {
        assert!(valid_session_id("9b13c30c-9175-4b53-afba-5a443659a244"));
        assert!(!valid_session_id("../../etc/passwd"));
        assert!(!valid_session_id("9b13c30c-9175-4b53-afba-5a443659a24g"));
        assert!(!valid_session_id(""));
    }

    #[test]
    fn a_turn_needs_text_and_a_valid_chat() {
        assert!(check_stream_payload("turn", &json!({ "text": "hola" })).is_ok());
        assert!(check_stream_payload("turn", &json!({ "text": "hola", "sessionId": "9b13c30c-9175-4b53-afba-5a443659a244" })).is_ok());
        assert!(check_stream_payload("turn", &json!({ "text": "   " })).is_err());
        assert!(check_stream_payload("turn", &json!({})).is_err());
        assert!(check_stream_payload("turn", &json!({ "text": "x".repeat(8001) })).is_err());
        assert!(check_stream_payload("turn", &json!({ "text": "hola", "sessionId": "x; rm -rf" })).is_err());
    }

    #[test]
    fn only_known_commands_stream() {
        assert!(check_stream_payload("settings-set", &json!({})).is_err());
        assert!(check_stream_payload("eval-run", &json!({})).is_ok());
        assert!(check_stream_payload("eval-run", &json!({ "ids": ["q-01", "q_02"] })).is_ok());
        assert!(check_stream_payload("eval-run", &json!({ "ids": ["q 01; calc"] })).is_err());
        assert!(check_stream_payload("eval-run", &json!({ "ids": "all" })).is_err());
    }

    #[test]
    fn the_payload_is_one_json_argument() {
        let args = build_args("turn", Some(&json!({ "text": "a \"b\" c" })));
        assert_eq!(args[..3], ["--disable-warning=ExperimentalWarning", "agent-cli.js", "turn"]);
        assert_eq!(args[3], "--json");
        assert_eq!(serde_json::from_str::<Value>(&args[4]).unwrap()["text"], "a \"b\" c");
        assert_eq!(build_args("status", None).len(), 3);
    }

    #[test]
    fn one_shot_commands_are_allowlisted() {
        let settings = Settings::defaults(std::path::Path::new("."));
        assert!(call(&settings, "turn", &json!({})).unwrap_err().contains("no permitido"));
        assert!(call(&settings, "rm -rf", &json!({})).unwrap_err().contains("no permitido"));
    }
}
