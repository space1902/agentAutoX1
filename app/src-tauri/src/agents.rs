//! "Agentes" section backend. All the rules live in the Node engine (`engines/agent/agent-cli.js`); this module only
//!  - runs its one-shot commands (sessions, messages, lessons, settings...),
//!  - starts the streaming ones (a chat turn, the quality evaluation) as a child process, forwards every JSON event
//!    line to the UI and cancels ONLY that child (Ctrl+Break, then `taskkill /T` of that pid).
//! The Node child is the one that launches the locally installed Claude Code (the user's subscription, never an API
//! key); it parses `stream-json`, checks the figures and writes `agent.db`. Keeping that in Node makes it unit-testable.
//!
//! Every command carries an `agent_id` validated against [`AGENTS`] (the engine's registry has the same list).
//! Each agent has its own chat/eval process slots, but only ONE Claude run can be active across all agents: they draw
//! from the same plan limits, so a second agent is refused with a clear message while another one works.

use crate::ads::{ads_dir, parse_output};
use crate::alerts::{Emit, Proc};
use crate::settings::Settings;
use crate::util::{hidden_command, hidden_group_command};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

/// Agents the engine knows (`engines/agent/registry.js`). Anything else is rejected before building arguments.
/// Each entry: (id, short label used in messages).
pub const AGENTS: &[(&str, &str)] = &[("analista", "Analista"), ("creativo", "Agente creativo")];
/// The agent the legacy `analista_*` commands act on.
pub const LEGACY_AGENT: &str = "analista";

/// Returns the canonical id when `id` is a registered agent.
pub fn valid_agent_id(id: &str) -> Result<&'static str, String> {
    AGENTS
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(known, _)| *known)
        .ok_or_else(|| format!("Agente desconocido: {}.", id.chars().take(40).collect::<String>()))
}

fn label_of(id: &str) -> &'static str {
    AGENTS.iter().find(|(known, _)| *known == id).map(|(_, label)| *label).unwrap_or("agente")
}

/// Commands answered with one `{ ok, data }` line.
const ONE_SHOT: &[&str] = &[
    "agents-list", "status", "sessions", "session-new", "session-rename", "session-delete", "messages", "settings-get", "settings-set", "queries",
    "lessons", "lesson-set", "lesson-edit", "learning-get", "learning-run", "feedback", "recommendations", "eval-bank", "eval-runs", "eval-run-detail",
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
pub fn check_stream_payload(agent_id: &str, command: &str, payload: &Value) -> Result<(), String> {
    valid_agent_id(agent_id)?;
    if !STREAMING.contains(&command) {
        return Err(format!("Comando del Analista no permitido: {command}."));
    }
    // Quality evaluations exist only for the Analista (they judge answers about ads).
    if command == "eval-run" && agent_id != LEGACY_AGENT {
        return Err("Las evaluaciones solo existen para el Analista.".to_string());
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

/// Node arguments for one engine command. The agent travels as `--agent <id>`; the payload as a single `--json`
/// argument (no shell involved).
pub fn build_args(agent_id: &str, command: &str, payload: Option<&Value>) -> Vec<String> {
    let mut out = vec![
        "--disable-warning=ExperimentalWarning".to_string(),
        "agent-cli.js".to_string(),
        command.to_string(),
        "--agent".to_string(),
        agent_id.to_string(),
    ];
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

/// Runs a one-shot command of one agent and returns its `data`.
pub fn call(settings: &Settings, agent_id: &str, command: &str, payload: &Value) -> Result<Value, String> {
    let agent_id = valid_agent_id(agent_id)?;
    if !ONE_SHOT.contains(&command) {
        return Err(format!("Comando del Analista no permitido: {command}."));
    }
    let args = ["--disable-warning=ExperimentalWarning", "agent-cli.js", command, "--agent", agent_id, "--stdin"].map(String::from);
    let mut cmd = command_for(settings, &args, false)?;
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
        return Err(format!("El agente no respondió: {}", stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")));
    }
    parse_output(&stdout)
}

/// The two process slots of one agent.
#[derive(Clone, Default)]
pub struct AgentProcs {
    /// The chat turn in progress.
    pub chat: Proc,
    /// The quality evaluation in progress.
    pub eval: Proc,
}

impl AgentProcs {
    fn running(&self) -> bool {
        self.chat.is_running() || self.eval.is_running()
    }
}

/// Process events use these two prefixes for every agent (`agent-status`, `agent-log`, `agent-exit` and the
/// `agent-eval-*` ones); the agent travels inside the payload as `agentId`.
const CHAT_PREFIX: &str = "agent";
const EVAL_PREFIX: &str = "agent-eval";

/// Turns one process event into what the UI receives: the same event with `agentId` inside the payload and, for the
/// legacy Analista, also the old `analista-*` name with the original payload (kept for one phase).
pub fn tag_event(agent_id: &str, name: &str, payload: &Value) -> Vec<(String, Value)> {
    let mut tagged = payload.clone();
    match tagged.as_object_mut() {
        Some(obj) => {
            obj.insert("agentId".to_string(), json!(agent_id));
        }
        None => tagged = json!({ "agentId": agent_id, "value": payload }),
    }
    let mut out = vec![(name.to_string(), tagged)];
    if agent_id == LEGACY_AGENT {
        if let Some(rest) = name.strip_prefix("agent") {
            out.push((format!("analista{rest}"), payload.clone()));
        }
    }
    out
}

fn tagging_emit(agent_id: &'static str, emit: Emit) -> Emit {
    Arc::new(move |name: &str, payload: Value| {
        for (event, value) in tag_event(agent_id, name, &payload) {
            emit(&event, value);
        }
    })
}

/// What the UI shows when `requested` cannot start because `busy` already holds the single Claude slot.
pub fn busy_message(requested: &str, busy: &str) -> String {
    if requested == busy {
        format!("El {} ya está trabajando. Espera a que termine o cancélalo.", label_of(busy))
    } else {
        format!("El {} ya está trabajando. Solo puede haber un agente activo a la vez; espera a que termine o cancélalo.", label_of(busy))
    }
}

#[derive(Clone, Default)]
pub struct Agents {
    procs: Arc<Mutex<HashMap<String, AgentProcs>>>,
    /// Serializes "check that nobody runs, then spawn" so two agents cannot both pass the check.
    start_gate: Arc<Mutex<()>>,
}

impl Agents {
    /// Process slots of one (already validated) agent.
    pub fn procs(&self, agent_id: &str) -> AgentProcs {
        crate::util::lock(&self.procs).entry(agent_id.to_string()).or_default().clone()
    }

    /// Every process slot of every agent (used to stop everything when the app closes).
    pub fn all_procs(&self) -> Vec<Proc> {
        crate::util::lock(&self.procs).values().flat_map(|p| [p.chat.clone(), p.eval.clone()]).collect()
    }

    /// The agent currently running Claude, if any.
    pub fn busy_agent(&self) -> Option<String> {
        crate::util::lock(&self.procs).iter().find(|(_, p)| p.running()).map(|(id, _)| id.clone())
    }

    pub fn start(&self, settings: &Settings, agent_id: &str, command: &str, payload: &Value, emit: Emit) -> Result<u32, String> {
        let agent_id = valid_agent_id(agent_id)?;
        check_stream_payload(agent_id, command, payload)?;
        let _gate = crate::util::lock(&self.start_gate);
        // One Claude run at a time across ALL agents: they all draw from the same plan limits.
        if let Some(busy) = self.busy_agent() {
            return Err(busy_message(agent_id, &busy));
        }
        let cmd = command_for(settings, &build_args(agent_id, command, Some(payload)), true)?;
        let procs = self.procs(agent_id);
        let emit = tagging_emit(agent_id, emit);
        match command {
            "turn" => procs.chat.spawn(cmd, CHAT_PREFIX, emit),
            _ => procs.eval.spawn(cmd, EVAL_PREFIX, emit),
        }
    }

    pub fn cancel(&self, agent_id: &str) -> Result<(), String> {
        let procs = self.procs(valid_agent_id(agent_id)?);
        if procs.chat.is_running() {
            return procs.chat.stop();
        }
        if procs.eval.is_running() {
            return procs.eval.stop();
        }
        Err("No hay nada en marcha.".to_string())
    }

    /// Status of one agent plus which agent (if any) holds the single Claude slot.
    pub fn status(&self, agent_id: &str) -> Result<Value, String> {
        let agent_id = valid_agent_id(agent_id)?;
        let procs = self.procs(agent_id);
        Ok(json!({ "agentId": agent_id, "chat": procs.chat.status(), "eval": procs.eval.status(), "busyAgent": self.busy_agent() }))
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
    fn agent_ids_come_from_the_fixed_list() {
        assert_eq!(valid_agent_id("analista"), Ok("analista"));
        assert_eq!(valid_agent_id("creativo"), Ok("creativo"));
        for bad in ["", "Creativo", "creativo ", "creativo; calc", "../creativo", "Analista", "analista ", "../analista", "analista; calc", "constructor"] {
            assert!(valid_agent_id(bad).is_err(), "{bad:?} must be rejected");
        }
        assert!(valid_agent_id(&"x".repeat(500)).unwrap_err().len() < 80);
        assert!(AGENTS.iter().any(|(id, _)| *id == LEGACY_AGENT));
    }

    #[test]
    fn a_turn_needs_text_and_a_valid_chat() {
        let turn = |p: Value| check_stream_payload("analista", "turn", &p);
        assert!(turn(json!({ "text": "hola" })).is_ok());
        assert!(turn(json!({ "text": "hola", "sessionId": "9b13c30c-9175-4b53-afba-5a443659a244" })).is_ok());
        assert!(turn(json!({ "text": "   " })).is_err());
        assert!(turn(json!({})).is_err());
        assert!(turn(json!({ "text": "x".repeat(8001) })).is_err());
        assert!(turn(json!({ "text": "hola", "sessionId": "x; rm -rf" })).is_err());
        assert!(check_stream_payload("nadie", "turn", &json!({ "text": "hola" })).is_err());
    }

    #[test]
    fn only_known_commands_stream() {
        let run = |c: &str, p: Value| check_stream_payload("analista", c, &p);
        assert!(run("settings-set", json!({})).is_err());
        assert!(run("eval-run", json!({})).is_ok());
        assert!(run("eval-run", json!({ "ids": ["q-01", "q_02"] })).is_ok());
        assert!(run("eval-run", json!({ "ids": ["q 01; calc"] })).is_err());
        assert!(run("eval-run", json!({ "ids": "all" })).is_err());
    }

    #[test]
    fn the_payload_is_one_json_argument_and_the_agent_a_flag() {
        let args = build_args("analista", "turn", Some(&json!({ "text": "a \"b\" c" })));
        assert_eq!(args[..5], ["--disable-warning=ExperimentalWarning", "agent-cli.js", "turn", "--agent", "analista"]);
        assert_eq!(args[5], "--json");
        assert_eq!(serde_json::from_str::<Value>(&args[6]).unwrap()["text"], "a \"b\" c");
        assert_eq!(build_args("analista", "status", None).len(), 5);
    }

    #[test]
    fn one_shot_commands_are_allowlisted() {
        let settings = Settings::defaults(std::path::Path::new("."));
        assert!(call(&settings, "analista", "turn", &json!({})).unwrap_err().contains("no permitido"));
        assert!(call(&settings, "analista", "rm -rf", &json!({})).unwrap_err().contains("no permitido"));
        assert!(call(&settings, "nadie", "sessions", &json!({})).unwrap_err().contains("desconocido"));
    }

    #[test]
    fn events_carry_the_agent_and_the_analista_keeps_its_legacy_names() {
        let ev = tag_event("analista", "agent-status", &json!({ "type": "done" }));
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0], ("agent-status".to_string(), json!({ "type": "done", "agentId": "analista" })));
        assert_eq!(ev[1], ("analista-status".to_string(), json!({ "type": "done" })));
        let ev = tag_event("analista", "agent-eval-exit", &json!({ "code": 0 }));
        assert_eq!(ev[1].0, "analista-eval-exit");
        // Another agent never produces the legacy aliases.
        let ev = tag_event("creativo", "agent-log", &json!({ "line": "x" }));
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].1["agentId"], "creativo");
        // A non-object payload is wrapped instead of dropped.
        assert_eq!(tag_event("creativo", "agent-status", &json!("x"))[0].1, json!({ "agentId": "creativo", "value": "x" }));
    }

    #[test]
    fn the_busy_message_names_the_agent_that_holds_the_slot() {
        assert_eq!(busy_message("analista", "analista"), "El Analista ya está trabajando. Espera a que termine o cancélalo.");
        let other = busy_message("creativo", "analista");
        assert!(other.starts_with("El Analista ya está trabajando.") && other.contains("un agente activo a la vez"));
        let creative = busy_message("analista", "creativo");
        assert!(creative.starts_with("El Agente creativo ya está trabajando.") && creative.contains("un agente activo a la vez"));
    }

    #[test]
    fn eval_runs_belong_to_the_analista_only() {
        assert!(check_stream_payload("analista", "eval-run", &json!({})).is_ok());
        assert!(check_stream_payload("creativo", "eval-run", &json!({})).is_err());
    }

    #[test]
    fn slots_are_per_agent_and_nothing_is_busy_at_first() {
        let agents = Agents::default();
        assert!(agents.busy_agent().is_none());
        let a = agents.procs("analista");
        assert!(!a.chat.is_running() && !a.eval.is_running());
        assert_eq!(agents.all_procs().len(), 2);
        assert!(agents.cancel("analista").unwrap_err().contains("nada en marcha"));
        assert!(agents.cancel("creativo").is_err());
        let status = agents.status("analista").unwrap();
        assert_eq!(status["agentId"], "analista");
        assert!(status["busyAgent"].is_null());
        assert!(agents.status("zzz").is_err());
    }
}
