//! "Anuncios" section backend. All the rules live in the Node engine (`engines/ads/ads-cli.js`); this module only
//!  - keeps the Meta token in the Windows Credential Manager (never on disk, never returned to the UI),
//!  - runs the engine one-shot commands (the token goes into the child env only),
//!  - imports the token from the standalone meta-ads-monitor project's `.env` (the value is never read back out).

use crate::settings::Settings;
use crate::util::hidden_command;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const KEY_SERVICE: &str = "agentAutoX1";
const TOKEN_ENTRY: &str = "meta-token";
/// Env var the engine reads the token from.
pub const TOKEN_ENV: &str = "AGENTAUTO_META_TOKEN";

const ALLOWED: &[&str] = &["sync", "report", "vouchers", "status", "test-token", "config-get", "config-set", "tick", "decisions", "decision-status", "alerts-config-get", "alerts-config-set", "alerts-recent", "wa-status", "tracking", "comprobante-country", "comprobante-accept", "activities-probe"];
const DECISION_STATUSES: &[&str] = &["pending", "done", "ignored"];
// "ct" is the legacy name of the campaign grouping; the engine treats it as "campaign".
const GROUPS: &[&str] = &["campaign", "ct", "ad"];

// ---------------------------------------------------------------- engine location and arguments

/// `engines/ads`, a sibling of the warm-up engine folder.
pub fn ads_dir(settings: &Settings) -> PathBuf {
    let warmup = Path::new(&settings.warmup_dir);
    warmup.parent().map(|p| p.join("ads")).unwrap_or_else(|| warmup.join("ads"))
}

/// `YYYY-MM-DD` with plausible month/day (the engine validates the calendar again).
pub fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits_ok = b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    digits_ok && (1..=12).contains(&month) && (1..=31).contains(&day)
}

#[derive(Default, Debug, Clone, PartialEq)]
pub struct AdsArgs<'a> {
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub group: Option<&'a str>,
    /// The payload is piped through stdin (`config-set`).
    pub stdin: bool,
    /// `decision-status`: decision id and new status.
    pub id: Option<u64>,
    pub status: Option<&'a str>,
    /// `tick --force`: snapshot and sync even if nothing is due.
    pub force: bool,
    /// `sync --auto`: incremental sync with the one-time history backfill (no dates needed).
    pub auto: bool,
    /// `report --country CO|all|-` and `--split` (separate campaign rows by country).
    pub country: Option<&'a str>,
    pub split: bool,
    /// `comprobante-country --key K --code MX` (an empty code removes the override).
    pub key: Option<&'a str>,
    pub code: Option<&'a str>,
    /// `comprobante-accept --key K [--undo]`: accept a payment by hand, or take the acceptance back.
    pub undo: bool,
    /// `activities-probe --since D`.
    pub since: Option<&'a str>,
}

/// Node arguments for one engine command. Everything is validated here so nothing odd reaches the shell-less spawn.
pub fn build_args(command: &str, args: &AdsArgs) -> Result<Vec<String>, String> {
    if !ALLOWED.contains(&command) {
        return Err(format!("Comando de anuncios no permitido: {command}."));
    }
    let mut out = vec!["--disable-warning=ExperimentalWarning".to_string(), "ads-cli.js".to_string(), command.to_string()];
    for (flag, value) in [("--from", args.from), ("--to", args.to)] {
        if let Some(v) = value {
            if !valid_date(v) {
                return Err("Las fechas deben tener el formato AAAA-MM-DD.".to_string());
            }
            out.push(flag.to_string());
            out.push(v.to_string());
        }
    }
    if let Some(g) = args.group {
        if !GROUPS.contains(&g) {
            return Err("La agrupación debe ser campaign o ad.".to_string());
        }
        out.push("--group".to_string());
        out.push(g.to_string());
    }
    if let Some(c) = args.country {
        if !(c == "all" || c == "-" || (c.len() == 2 && c.chars().all(|ch| ch.is_ascii_uppercase()))) {
            return Err("El país debe ser un código de 2 letras o «all».".to_string());
        }
        out.extend(["--country".to_string(), c.to_string()]);
    }
    if args.split && command == "report" {
        out.push("--split".to_string());
    }
    if command == "comprobante-country" {
        let key = args.key.unwrap_or_default();
        let code = args.code.unwrap_or_default();
        if key.len() != 20 || !key.chars().all(|c| c.is_ascii_hexdigit()) || !(code.is_empty() || (code.len() == 2 && code.chars().all(|c| c.is_ascii_uppercase()))) {
            return Err("El comprobante o el país no son válidos.".to_string());
        }
        out.extend(["--key".to_string(), key.to_string()]);
        if !code.is_empty() {
            out.extend(["--code".to_string(), code.to_string()]);
        }
    }
    if command == "comprobante-accept" {
        let key = args.key.unwrap_or_default();
        if key.len() != 20 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("El comprobante no es válido.".to_string());
        }
        out.extend(["--key".to_string(), key.to_string()]);
        if args.undo {
            out.push("--undo".to_string());
        }
    }
    if let Some(since) = args.since {
        if !valid_date(since) {
            return Err("Las fechas deben tener el formato AAAA-MM-DD.".to_string());
        }
        out.extend(["--since".to_string(), since.to_string()]);
    }
    if args.auto && command == "sync" {
        out.push("--auto".to_string());
    } else if matches!(command, "sync" | "report" | "vouchers") && (args.from.is_none() || args.to.is_none()) {
        return Err("Faltan las fechas del rango.".to_string());
    }
    if command == "decision-status" {
        let (Some(id), Some(status)) = (args.id, args.status) else { return Err("Faltan la decisión y el estado.".to_string()) };
        if id == 0 || !DECISION_STATUSES.contains(&status) {
            return Err("La decisión o el estado no son válidos.".to_string());
        }
        out.extend(["--id".to_string(), id.to_string(), "--status".to_string(), status.to_string()]);
    }
    if args.force && command == "tick" {
        out.push("--force".to_string());
    }
    if args.stdin {
        out.push("--stdin".to_string());
    }
    Ok(out)
}

/// `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }` -> Ok(data) / Err(error).
pub fn parse_output(stdout: &str) -> Result<Value, String> {
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .ok_or_else(|| "El motor de anuncios no devolvió una respuesta legible.".to_string())?;
    let value: Value = serde_json::from_str(line).map_err(|e| format!("Respuesta del motor de anuncios no válida: {e}"))?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value.get("error").and_then(Value::as_str).unwrap_or("Error desconocido del motor de anuncios.").to_string())
    }
}

// ---------------------------------------------------------------- token

fn entry(service: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, TOKEN_ENTRY).map_err(|e| format!("No se pudo abrir el almacén de credenciales de Windows: {e}"))
}

fn get_token_in(service: &str) -> Result<Option<String>, String> {
    match entry(service)?.get_password() {
        Ok(token) if !token.trim().is_empty() => Ok(Some(token)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("No se pudo leer el token guardado: {e}")),
    }
}

/// A Meta token is one long run of URL-safe characters; anything else is a paste mistake.
pub fn valid_token(token: &str) -> bool {
    let t = token.trim();
    t.len() >= 20 && t.len() <= 1024 && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '|'))
}

fn set_token_in(service: &str, token: &str) -> Result<(), String> {
    let token = token.trim();
    if !valid_token(token) {
        return Err("El token no parece válido: debe ser una sola cadena larga sin espacios.".to_string());
    }
    entry(service)?.set_password(token).map_err(|e| format!("No se pudo guardar el token: {e}"))
}

fn clear_token_in(service: &str) -> Result<(), String> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("No se pudo borrar el token: {e}")),
    }
}

/// Only presence is ever reported to the UI.
pub fn token_present() -> Result<bool, String> {
    Ok(get_token_in(KEY_SERVICE)?.is_some())
}

pub fn set_token(token: &str) -> Result<(), String> {
    set_token_in(KEY_SERVICE, token)
}

pub fn clear_token() -> Result<(), String> {
    clear_token_in(KEY_SERVICE)
}

/// `META_ACCESS_TOKEN=...` out of a dotenv file (optional `export`, quotes, trailing comment).
pub fn parse_env_token(text: &str) -> Option<String> {
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some(rest) = line.strip_prefix("META_ACCESS_TOKEN") else { continue };
        let Some(value) = rest.trim_start().strip_prefix('=') else { continue };
        let value = value.trim();
        let value = match value.chars().next() {
            Some(q @ ('"' | '\'')) => value[1..].split(q).next().unwrap_or("").to_string(),
            _ => value.split(" #").next().unwrap_or("").trim().to_string(),
        };
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// `<ventas automaticas>/meta-ads-monitor/.env`, next to the agentAutoX1 folder.
pub fn monitor_env_path(root: &Path) -> PathBuf {
    root.parent().unwrap_or(root).join("meta-ads-monitor").join(".env")
}

fn import_token_from(env_file: &Path, service: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(env_file).map_err(|_| "No encuentro el archivo .env de meta-ads-monitor.".to_string())?;
    let token = parse_env_token(&text).ok_or("El .env de meta-ads-monitor no tiene META_ACCESS_TOKEN.")?;
    set_token_in(service, &token)
}

/// Copies the monitor's token into the Credential Manager. The value never leaves this function.
pub fn import_from_monitor(root: &Path) -> Result<(), String> {
    import_token_from(&monitor_env_path(root), KEY_SERVICE)
}

// ---------------------------------------------------------------- running the engine

/// One sync at a time: the auto-refresh and the "Actualizar" button must not overlap.
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
struct SyncGuard;

impl SyncGuard {
    fn acquire() -> Result<SyncGuard, String> {
        if SYNC_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("Ya hay una actualización en curso.".to_string());
        }
        Ok(SyncGuard)
    }
}

impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, Ordering::SeqCst);
    }
}

fn run_engine(settings: &Settings, command: &str, args: &AdsArgs, payload: Option<&Value>, token: Option<&str>) -> Result<Value, String> {
    let dir = ads_dir(settings);
    if !dir.join("ads-cli.js").is_file() {
        return Err(format!("No encuentro ads-cli.js en {}. Revisa Ajustes.", dir.display()));
    }
    let mut cmd = hidden_command(&settings.node_path);
    cmd.args(build_args(command, args)?).current_dir(&dir).env("AGENTAUTO_DATA_DIR", &settings.data_dir);
    match token {
        Some(t) => cmd.env(TOKEN_ENV, t),
        None => cmd.env_remove(TOKEN_ENV),
    };
    let mut child = cmd
        .stdin(if payload.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo iniciar Node ({}): {e}", settings.node_path))?;
    if let (Some(mut stdin), Some(payload)) = (child.stdin.take(), payload) {
        let _ = stdin.write_all(payload.to_string().as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("El motor de anuncios no respondió: {}", stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")));
    }
    parse_output(&stdout)
}

pub fn stored_token() -> Result<Option<String>, String> {
    get_token_in(KEY_SERVICE)
}

pub fn sync(settings: &Settings, from: &str, to: &str) -> Result<Value, String> {
    let _guard = SyncGuard::acquire()?;
    let token = stored_token()?;
    run_engine(settings, "sync", &AdsArgs { from: Some(from), to: Some(to), ..Default::default() }, None, token.as_deref())
}

/// Incremental sync; the very first run also backfills the whole history.
pub fn sync_auto(settings: &Settings) -> Result<Value, String> {
    let _guard = SyncGuard::acquire()?;
    let token = stored_token()?;
    run_engine(settings, "sync", &AdsArgs { auto: true, ..Default::default() }, None, token.as_deref())
}

pub fn report(settings: &Settings, from: &str, to: &str, group: &str, country: Option<&str>, split: bool) -> Result<Value, String> {
    run_engine(settings, "report", &AdsArgs { from: Some(from), to: Some(to), group: Some(group), country, split, ..Default::default() }, None, None)
}

pub fn tracking(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "tracking", &AdsArgs::default(), None, None)
}

/// Payments of any range (the Comprobantes card has its own dates), optionally limited to one country.
pub fn vouchers(settings: &Settings, from: &str, to: &str, country: Option<&str>) -> Result<Value, String> {
    run_engine(settings, "vouchers", &AdsArgs { from: Some(from), to: Some(to), country, ..Default::default() }, None, None)
}

pub fn comprobante_country(settings: &Settings, key: &str, code: &str) -> Result<Value, String> {
    run_engine(settings, "comprobante-country", &AdsArgs { key: Some(key), code: Some(code), ..Default::default() }, None, None)
}

/// Accepts a payment by hand (or takes it back with `undo`). Only the local database changes; the sheet is never written.
pub fn comprobante_accept(settings: &Settings, key: &str, undo: bool) -> Result<Value, String> {
    run_engine(settings, "comprobante-accept", &AdsArgs { key: Some(key), undo, ..Default::default() }, None, None)
}

pub fn status(settings: &Settings) -> Result<Value, String> {
    let token = stored_token()?;
    run_engine(settings, "status", &AdsArgs::default(), None, token.as_deref())
}

pub fn config_get(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "config-get", &AdsArgs::default(), None, None)
}

pub fn config_set(settings: &Settings, partial: &Value) -> Result<Value, String> {
    run_engine(settings, "config-set", &AdsArgs { stdin: true, ..Default::default() }, Some(partial), None)
}

/// One scheduler step (budget snapshot + due decisions). Shares the sync lock so it never overlaps a manual sync.
pub fn tick(settings: &Settings, force: bool) -> Result<Value, String> {
    let _guard = SyncGuard::acquire()?;
    let token = stored_token()?;
    run_engine(settings, "tick", &AdsArgs { force, ..Default::default() }, None, token.as_deref())
}

pub fn decisions(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "decisions", &AdsArgs::default(), None, None)
}

pub fn decision_status(settings: &Settings, id: u64, status: &str) -> Result<Value, String> {
    run_engine(settings, "decision-status", &AdsArgs { id: Some(id), status: Some(status), ..Default::default() }, None, None)
}

// ---------------------------------------------------------------- decision scheduler
//
// Phase B runs inside the app process: a plain thread calls the one-shot `tick` command every few minutes. The
// engine decides what is due (and dedupes in SQLite), so a closed app only means the decision is issued late.

const TICK_EVERY: Duration = Duration::from_secs(5 * 60);
const FIRST_TICK_AFTER: Duration = Duration::from_secs(45);

/// Title and body of a created decision (the engine builds the Spanish text).
pub fn toast_text(decision: &Value) -> Option<(String, String)> {
    let message = decision.get("message")?;
    Some((message.get("title")?.as_str()?.to_string(), message.get("body")?.as_str()?.to_string()))
}

/// Emits the `ads-decisions` event and the desktop toast for the decisions a tick just created.
pub fn announce(app: &AppHandle, result: &Value) {
    let created = result.get("created").and_then(Value::as_array).cloned().unwrap_or_default();
    if created.is_empty() {
        return;
    }
    let _ = app.emit("ads-decisions", result);
    if result.get("notifyDesktop").and_then(Value::as_bool) == Some(true) {
        match created.as_slice() {
            [one] => {
                if let Some((title, body)) = toast_text(one) {
                    crate::notify::toast(&title, &body);
                }
            }
            many => crate::notify::toast("Nuevas decisiones de anuncios", &format!("Tienes {} decisiones por revisar en Anuncios > Decisiones.", many.len())),
        }
    }
}

fn sleep_unless_stopped(total: Duration, stop: &AtomicBool) -> bool {
    let mut left = total;
    while left > Duration::ZERO {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        let step = left.min(Duration::from_secs(1));
        std::thread::sleep(step);
        left -= step;
    }
    !stop.load(Ordering::SeqCst)
}

pub fn spawn_scheduler(app: AppHandle, settings: Arc<Mutex<Settings>>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut wait = FIRST_TICK_AFTER;
        while sleep_unless_stopped(wait, &stop) {
            wait = TICK_EVERY;
            let current = crate::util::lock(&settings).clone();
            // A panic in one step must not kill the scheduler (it is logged by the panic hook).
            let step = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tick(&current, false)));
            match step {
                Ok(Ok(result)) => announce(&app, &result),
                Ok(Err(_)) => {}
                Err(_) => crate::applog::log("scheduler", "un paso del programador falló; se reintenta en el siguiente ciclo"),
            }
        }
    });
}

pub fn alerts_config_get(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "alerts-config-get", &AdsArgs::default(), None, None)
}

pub fn alerts_config_set(settings: &Settings, partial: &Value) -> Result<Value, String> {
    run_engine(settings, "alerts-config-set", &AdsArgs { stdin: true, ..Default::default() }, Some(partial), None)
}

pub fn alerts_recent(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "alerts-recent", &AdsArgs::default(), None, None)
}

pub fn wa_status(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "wa-status", &AdsArgs::default(), None, None)
}

pub fn test_token(settings: &Settings) -> Result<Value, String> {
    let token = stored_token()?.ok_or("Falta el token de Meta. Impórtalo o pégalo en la configuración de Anuncios.")?;
    run_engine(settings, "test-token", &AdsArgs::default(), None, Some(&token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args<'a>(from: Option<&'a str>, to: Option<&'a str>, group: Option<&'a str>) -> AdsArgs<'a> {
        AdsArgs { from, to, group, ..Default::default() }
    }

    #[test]
    fn dates_are_strictly_iso() {
        assert!(valid_date("2026-10-29"));
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-10-32"));
        assert!(!valid_date("29/10/2026"));
        assert!(!valid_date("2026-10-29; calc"));
        assert!(!valid_date(""));
    }

    #[test]
    fn builds_sync_and_report_arguments() {
        let sync = build_args("sync", &args(Some("2026-10-01"), Some("2026-10-29"), None)).unwrap();
        assert_eq!(sync, ["--disable-warning=ExperimentalWarning", "ads-cli.js", "sync", "--from", "2026-10-01", "--to", "2026-10-29"]);
        let report = build_args("report", &args(Some("2026-10-01"), Some("2026-10-29"), Some("ad"))).unwrap();
        assert_eq!(&report[2..], ["report", "--from", "2026-10-01", "--to", "2026-10-29", "--group", "ad"]);
        assert_eq!(build_args("config-set", &AdsArgs { stdin: true, ..Default::default() }).unwrap().last().unwrap(), "--stdin");
        assert_eq!(build_args("status", &AdsArgs::default()).unwrap().len(), 3);
    }

    #[test]
    fn rejects_bad_commands_dates_and_groups() {
        assert!(build_args("sync; calc", &AdsArgs::default()).unwrap_err().contains("no permitido"));
        assert!(build_args("sync", &args(Some("ayer"), Some("2026-10-29"), None)).is_err());
        assert!(build_args("report", &args(Some("2026-10-01"), Some("2026-10-29"), Some("x"))).is_err());
        assert!(build_args("sync", &args(None, None, None)).unwrap_err().contains("fechas"));
    }

    #[test]
    fn builds_scheduler_and_decision_arguments() {
        assert_eq!(&build_args("tick", &AdsArgs::default()).unwrap()[2..], ["tick"]);
        assert_eq!(build_args("tick", &AdsArgs { force: true, ..Default::default() }).unwrap().last().unwrap(), "--force");
        let ok = build_args("decision-status", &AdsArgs { id: Some(7), status: Some("done"), ..Default::default() }).unwrap();
        assert_eq!(&ok[2..], ["decision-status", "--id", "7", "--status", "done"]);
        assert!(build_args("decision-status", &AdsArgs { id: Some(7), status: Some("x; calc"), ..Default::default() }).is_err());
        assert!(build_args("decision-status", &AdsArgs { id: Some(0), status: Some("done"), ..Default::default() }).is_err());
        assert!(build_args("decision-status", &AdsArgs::default()).is_err());
    }

    #[test]
    fn alerts_commands_are_allowed_and_take_no_extra_arguments() {
        for c in ["alerts-config-get", "alerts-recent", "wa-status"] {
            assert_eq!(&build_args(c, &AdsArgs::default()).unwrap()[2..], [c]);
        }
        assert_eq!(build_args("alerts-config-set", &AdsArgs { stdin: true, ..Default::default() }).unwrap().last().unwrap(), "--stdin");
    }

    #[test]
    fn builds_auto_sync_country_and_override_arguments() {
        assert_eq!(&build_args("sync", &AdsArgs { auto: true, ..Default::default() }).unwrap()[2..], ["sync", "--auto"]);
        let report = build_args("report", &AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), group: Some("ct"), country: Some("MX"), split: true, ..Default::default() }).unwrap();
        assert_eq!(&report[2..], ["report", "--from", "2026-10-01", "--to", "2026-10-29", "--group", "ct", "--country", "MX", "--split"]);
        assert!(build_args("report", &AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), country: Some("Mexico"), ..Default::default() }).is_err());
        let key = "0123456789abcdef0123";
        let vouchers = build_args("vouchers", &AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), country: Some("-"), ..Default::default() }).unwrap();
        assert_eq!(&vouchers[2..], ["vouchers", "--from", "2026-10-01", "--to", "2026-10-29", "--country", "-"]);
        assert!(build_args("vouchers", &AdsArgs::default()).is_err(), "dates are required");
        assert!(build_args("vouchers", &AdsArgs { from: Some("ayer"), to: Some("2026-10-29"), ..Default::default() }).is_err());
        assert_eq!(&build_args("comprobante-country", &AdsArgs { key: Some(key), code: Some("MX"), ..Default::default() }).unwrap()[2..], ["comprobante-country", "--key", key, "--code", "MX"]);
        assert_eq!(&build_args("comprobante-country", &AdsArgs { key: Some(key), code: Some(""), ..Default::default() }).unwrap()[2..], ["comprobante-country", "--key", key]);
        assert!(build_args("comprobante-country", &AdsArgs { key: Some("../x"), code: Some("MX"), ..Default::default() }).is_err());
        assert!(build_args("comprobante-country", &AdsArgs { key: Some(key), code: Some("mx; calc"), ..Default::default() }).is_err());
        assert_eq!(&build_args("comprobante-accept", &AdsArgs { key: Some(key), ..Default::default() }).unwrap()[2..], ["comprobante-accept", "--key", key]);
        assert_eq!(&build_args("comprobante-accept", &AdsArgs { key: Some(key), undo: true, ..Default::default() }).unwrap()[2..], ["comprobante-accept", "--key", key, "--undo"]);
        assert!(build_args("comprobante-accept", &AdsArgs { key: Some("../x"), ..Default::default() }).is_err());
        assert!(build_args("comprobante-accept", &AdsArgs::default()).is_err());
        assert!(build_args("activities-probe", &AdsArgs { since: Some("ayer"), ..Default::default() }).is_err());
    }

    #[test]
    fn toast_text_comes_from_the_engine_message() {
        let d = json!({"message": {"title": "Prueba: CT 01 · día 4", "body": "Escalar. ROAS 3,4"}});
        assert_eq!(toast_text(&d), Some(("Prueba: CT 01 · día 4".to_string(), "Escalar. ROAS 3,4".to_string())));
        assert_eq!(toast_text(&json!({})), None);
    }

    #[test]
    fn the_scheduler_sleep_stops_quickly() {
        let stop = AtomicBool::new(true);
        let start = std::time::Instant::now();
        assert!(!sleep_unless_stopped(Duration::from_secs(30), &stop));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn ads_dir_is_next_to_the_warmup_engine() {
        let mut settings = Settings::defaults(Path::new("C:/x/agentAutoX1"));
        settings.warmup_dir = "C:/x/agentAutoX1/engines/warmup".to_string();
        assert!(ads_dir(&settings).ends_with(Path::new("engines").join("ads")));
    }

    #[test]
    fn parses_engine_answers() {
        assert_eq!(parse_output("noise\n{\"ok\":true,\"data\":{\"a\":1}}\n").unwrap(), json!({"a": 1}));
        assert_eq!(parse_output("{\"ok\":false,\"error\":\"Token vencido\"}").unwrap_err(), "Token vencido");
        assert!(parse_output("garbage").is_err());
        assert!(parse_output("{broken").unwrap_err().contains("no válida"));
    }

    #[test]
    fn token_shape_is_checked_before_it_is_stored() {
        assert!(valid_token("EAAB1234567890abcdefXYZ"));
        assert!(!valid_token("short"));
        assert!(!valid_token("has spaces in the middle of it all"));
        assert!(!valid_token("EAAB1234567890abcdef\nXYZ"));
    }

    #[test]
    fn reads_the_token_line_of_a_dotenv() {
        assert_eq!(parse_env_token("A=1\nMETA_ACCESS_TOKEN=abc123\nB=2").as_deref(), Some("abc123"));
        assert_eq!(parse_env_token("META_ACCESS_TOKEN=\"abc 123\" # note").as_deref(), Some("abc 123"));
        assert_eq!(parse_env_token("export META_ACCESS_TOKEN='abc'").as_deref(), Some("abc"));
        assert_eq!(parse_env_token("META_ACCESS_TOKEN = abc # c").as_deref(), Some("abc"));
        assert_eq!(parse_env_token("\u{feff}META_ACCESS_TOKEN=abc\r\nOTHER=1\r\n").as_deref(), Some("abc"));
        assert_eq!(parse_env_token("META_ACCESS_TOKEN=\nMETA_AD_ACCOUNT_ID=act_1"), None);
        assert_eq!(parse_env_token("META_ACCESS_TOKEN_OLD=zzz"), None);
        assert_eq!(parse_env_token(""), None);
    }

    #[test]
    fn monitor_env_lives_next_to_the_project() {
        let p = monitor_env_path(Path::new("C:/ventas/agentAutoX1"));
        assert!(p.ends_with(Path::new("meta-ads-monitor").join(".env")));
        assert!(!p.starts_with("C:/ventas/agentAutoX1"));
    }

    #[test]
    fn importing_reports_failures_without_a_token_value() {
        let service = format!("agentAutoX1-test-import-{}", std::process::id());
        let dir = std::env::temp_dir().join(format!("agentautox1-ads-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = import_token_from(&dir.join("nope.env"), &service).unwrap_err();
        assert!(missing.contains("No encuentro"));
        std::fs::write(dir.join("empty.env"), "OTHER=1\n").unwrap();
        assert!(import_token_from(&dir.join("empty.env"), &service).unwrap_err().contains("META_ACCESS_TOKEN"));
        std::fs::write(dir.join("ok.env"), "META_ACCESS_TOKEN=fake-test-token-0123456789abcdef\n").unwrap();
        import_token_from(&dir.join("ok.env"), &service).unwrap();
        assert_eq!(get_token_in(&service).unwrap().as_deref(), Some("fake-test-token-0123456789abcdef"));
        clear_token_in(&service).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real Credential Manager round trip with a throw-away service name (removed at the end).
    #[test]
    fn token_round_trips_through_the_credential_manager() {
        let service = format!("agentAutoX1-test-{}", std::process::id());
        assert_eq!(get_token_in(&service).unwrap(), None);
        set_token_in(&service, "fake-test-token-0123456789abcdef").unwrap();
        assert_eq!(get_token_in(&service).unwrap().as_deref(), Some("fake-test-token-0123456789abcdef"));
        assert!(set_token_in(&service, "  ").is_err());
        clear_token_in(&service).unwrap();
        assert_eq!(get_token_in(&service).unwrap(), None);
    }

    #[test]
    fn only_one_sync_runs_at_a_time() {
        let first = SyncGuard::acquire().unwrap();
        assert!(SyncGuard::acquire().unwrap_err().contains("en curso"));
        drop(first);
        assert!(SyncGuard::acquire().is_ok());
    }

    /// Real engine, throw-away data dir: status, config round trip and a report from an empty store; no network.
    #[test]
    fn talks_to_the_real_engine_offline() {
        let dir = std::env::temp_dir().join(format!("agentautox1-ads-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut settings = Settings::defaults(Path::new("C:/x"));
        settings.warmup_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("engines").join("warmup").to_string_lossy().into_owned();
        settings.data_dir = dir.to_string_lossy().into_owned();

        let status = run_engine(&settings, "status", &AdsArgs::default(), None, None).unwrap();
        assert_eq!(status["tokenPresent"], false);
        let cfg = config_get(&settings).unwrap();
        assert_eq!(cfg["config"]["campaignPrefix"], "all");
        let saved = config_set(&settings, &json!({"flowPrefix": "Barf"})).unwrap();
        assert_eq!(saved["config"]["flowPrefix"], "Barf");
        assert!(config_set(&settings, &json!({"token": "x"})).is_err());
        let report = report(&settings, "2026-10-01", "2026-10-02", "campaign", None, false).unwrap();
        assert_eq!(report["kpis"]["gasto"], 0);
        assert_eq!(report["daily"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
