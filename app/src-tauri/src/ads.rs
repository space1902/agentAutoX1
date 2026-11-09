//! "Anuncios" section backend. All the rules live in the Node engine (`engines/ads/ads-cli.js`); this module only
//!  - keeps one Meta token per portfolio (Business Manager) in the Windows Credential Manager (never on disk, never returned to the UI),
//!  - runs the engine one-shot commands (the token goes into the child env only),
//!  - imports the token from the standalone meta-ads-monitor project's `.env` (the value is never read back out).

use crate::settings::Settings;
use crate::util::hidden_command;
use serde_json::Value;
use std::collections::BTreeMap;
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

/// The portfolio whose token keeps the original keyring entry `meta-token` (the migrated single account lives there).
pub const PRINCIPAL: &str = "principal";

const ALLOWED: &[&str] = &["portfolio-add", "account-add", "sync", "report", "vouchers", "status", "test-token", "config-get", "config-set", "tick", "decisions", "decision-status", "alerts-config-get", "alerts-config-set", "alerts-recent", "wa-status", "tracking", "comprobante-country", "comprobante-accept", "comprobante-reject", "comprobante-value", "comprobante-ad", "budget-plan", "activities-probe", "fx-refresh"];
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
    /// `comprobante-accept|comprobante-reject --key K [--undo]`: accept / discard a payment by hand, or take it back.
    pub undo: bool,
    /// `activities-probe --since D`.
    pub since: Option<&'a str>,
    /// `sync|report|vouchers --accounts all|act_1,act_2`: the ad accounts in scope (absent = all).
    pub accounts: Option<&'a str>,
    /// `report|vouchers --name ct,pzz`: search terms matched anywhere in the ad, ad set or campaign name (case and accent insensitive, OR-ed).
    pub name: Option<&'a str>,
    /// `comprobante-value --key K --valor N`: corrected amount of a payment; `Some("")` (flag without a value) removes the correction.
    pub valor: Option<&'a str>,
    /// `comprobante-ad --key K --ad ID`: ad assigned by hand to a payment; `Some("")` (flag without a value) removes it.
    pub ad: Option<&'a str>,
    /// `report --hours 8-14`: only sales registered, and spend delivered, in that hour window count (start inclusive, end exclusive, may wrap midnight).
    pub hours: Option<&'a str>,
    /// `test-token --portfolio slug`.
    pub portfolio: Option<&'a str>,
}

/// Portfolio ids are short slugs; anything else never reaches the keyring, the environment or the engine.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty() && slug.len() <= 40 && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `all` or a comma list of `act_<5-25 digits>` (at most 100).
pub fn valid_accounts_arg(value: &str) -> bool {
    if value == "all" {
        return true;
    }
    let items: Vec<&str> = value.split(',').collect();
    items.len() <= 100
        && items.iter().all(|a| {
            a.strip_prefix("act_").map(|d| (5..=25).contains(&d.len()) && d.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
        })
}

/// Largest corrected payment amount accepted (the engine checks the same bound).
pub const MAX_VALUE_OVERRIDE: u64 = 100_000_000;

/// `H-H` with start 0..=23 and end 0..=24, different from each other.
pub fn valid_hours_arg(value: &str) -> bool {
    let Some((a, b)) = value.split_once('-') else { return false };
    let ok = |s: &str| !s.is_empty() && s.len() <= 2 && s.chars().all(|c| c.is_ascii_digit());
    if !ok(a) || !ok(b) {
        return false;
    }
    let (start, end): (u32, u32) = (a.parse().unwrap_or(99), b.parse().unwrap_or(99));
    start <= 23 && end <= 24 && start != end
}

/// Search terms: letters, digits, spaces and a little punctuation; never a leading `--` (it would read as a flag).
pub fn valid_name_filter(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 400
        && !value.starts_with("--")
        && value.chars().all(|c| c.is_alphanumeric() || " _-.·#+&()[]/|:,".contains(c))
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
    if command == "comprobante-accept" || command == "comprobante-reject" {
        let key = args.key.unwrap_or_default();
        if key.len() != 20 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("El comprobante no es válido.".to_string());
        }
        out.extend(["--key".to_string(), key.to_string()]);
        if args.undo {
            out.push("--undo".to_string());
        }
    }
    if command == "comprobante-value" {
        let key = args.key.unwrap_or_default();
        if key.len() != 20 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("El comprobante no es válido.".to_string());
        }
        out.extend(["--key".to_string(), key.to_string()]);
        match args.valor {
            None | Some("") => out.push("--valor".to_string()),
            Some(v) => {
                let n: u64 = if v.len() <= 9 && v.chars().all(|c| c.is_ascii_digit()) { v.parse().unwrap_or(0) } else { 0 };
                if n == 0 || n > MAX_VALUE_OVERRIDE {
                    return Err("El monto debe ser un número entero positivo de hasta 100.000.000.".to_string());
                }
                out.extend(["--valor".to_string(), n.to_string()]);
            }
        }
    }
    if command == "comprobante-ad" {
        let key = args.key.unwrap_or_default();
        let ad = args.ad.unwrap_or_default();
        if key.len() != 20 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("El comprobante no es válido.".to_string());
        }
        if !(ad.is_empty() || ((5..=25).contains(&ad.len()) && ad.chars().all(|c| c.is_ascii_digit()))) {
            return Err("El anuncio no es válido.".to_string());
        }
        out.extend(["--key".to_string(), key.to_string()]);
        if !ad.is_empty() {
            out.extend(["--ad".to_string(), ad.to_string()]);
        }
    }
    if let Some(hours) = args.hours {
        if command != "report" {
            return Err("El horario solo aplica al reporte.".to_string());
        }
        if !valid_hours_arg(hours) {
            return Err("El horario no es válido: usa horas de 0 a 24 y que el inicio sea distinto del fin.".to_string());
        }
        out.extend(["--hours".to_string(), hours.to_string()]);
    }
    if let Some(accounts) = args.accounts {
        if !matches!(command, "sync" | "report" | "vouchers" | "budget-plan") {
            return Err("Las cuentas solo se pueden elegir al actualizar o consultar.".to_string());
        }
        if !valid_accounts_arg(accounts) {
            return Err("Las cuentas publicitarias deben verse como act_1234567890.".to_string());
        }
        out.extend(["--accounts".to_string(), accounts.to_string()]);
    }
    if let Some(name) = args.name.filter(|n| !n.trim().is_empty()) {
        if !matches!(command, "report" | "vouchers" | "budget-plan") {
            return Err("El filtro de nombre solo aplica a los reportes.".to_string());
        }
        if !valid_name_filter(name) {
            return Err("El filtro de nombre tiene caracteres no válidos.".to_string());
        }
        out.extend(["--name".to_string(), name.to_string()]);
    }
    if let Some(portfolio) = args.portfolio {
        if command != "test-token" || !valid_slug(portfolio) {
            return Err("Portafolio no válido.".to_string());
        }
        out.extend(["--portfolio".to_string(), portfolio.to_string()]);
    }
    if let Some(since) = args.since {
        if !valid_date(since) {
            return Err("Las fechas deben tener el formato AAAA-MM-DD.".to_string());
        }
        out.extend(["--since".to_string(), since.to_string()]);
    }
    if args.auto && command == "sync" {
        out.push("--auto".to_string());
    } else if matches!(command, "sync" | "report" | "vouchers" | "budget-plan") && (args.from.is_none() || args.to.is_none()) {
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

// ---------------------------------------------------------------- tokens (one per portfolio)

/// Keyring entry of a portfolio: the principal one keeps the original `meta-token`; the others use `meta-token:<slug>`.
pub fn token_entry_name(slug: &str) -> String {
    if slug == PRINCIPAL {
        TOKEN_ENTRY.to_string()
    } else {
        format!("{TOKEN_ENTRY}:{slug}")
    }
}

/// Env var the engine reads a portfolio's token from: `AGENTAUTO_META_TOKEN__OTRO_BM` for `otro-bm`.
pub fn token_env_name(slug: &str) -> String {
    format!("{TOKEN_ENV}__{}", slug.to_ascii_uppercase().replace('-', "_"))
}

fn entry(service: &str, slug: &str) -> Result<keyring::Entry, String> {
    if !valid_slug(slug) {
        return Err("Portafolio no válido.".to_string());
    }
    keyring::Entry::new(service, &token_entry_name(slug)).map_err(|e| format!("No se pudo abrir el almacén de credenciales de Windows: {e}"))
}

fn get_token_in(service: &str, slug: &str) -> Result<Option<String>, String> {
    match entry(service, slug)?.get_password() {
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

fn set_token_in(service: &str, slug: &str, token: &str) -> Result<(), String> {
    let token = token.trim();
    if !valid_token(token) {
        return Err("El token no parece válido: debe ser una sola cadena larga sin espacios.".to_string());
    }
    entry(service, slug)?.set_password(token).map_err(|e| format!("No se pudo guardar el token: {e}"))
}

fn clear_token_in(service: &str, slug: &str) -> Result<(), String> {
    match entry(service, slug)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("No se pudo borrar el token: {e}")),
    }
}

/// Only presence is ever reported to the UI.
pub fn token_present(slug: &str) -> Result<bool, String> {
    Ok(get_token_in(KEY_SERVICE, slug)?.is_some())
}

/// Presence of each requested portfolio's token, by slug.
pub fn token_statuses(slugs: &[String]) -> Result<BTreeMap<String, bool>, String> {
    slugs.iter().map(|slug| Ok((slug.clone(), token_present(slug)?))).collect()
}

pub fn set_token(slug: &str, token: &str) -> Result<(), String> {
    set_token_in(KEY_SERVICE, slug, token)
}

pub fn clear_token(slug: &str) -> Result<(), String> {
    clear_token_in(KEY_SERVICE, slug)
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

fn import_token_from(env_file: &Path, service: &str, slug: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(env_file).map_err(|_| "No encuentro el archivo .env de meta-ads-monitor.".to_string())?;
    let token = parse_env_token(&text).ok_or("El .env de meta-ads-monitor no tiene META_ACCESS_TOKEN.")?;
    set_token_in(service, slug, &token)
}

/// Copies the monitor's token into the Credential Manager, for the principal portfolio. The value never leaves this function.
pub fn import_from_monitor(root: &Path) -> Result<(), String> {
    import_token_from(&monitor_env_path(root), KEY_SERVICE, PRINCIPAL)
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

/// (portfolio slug, token) pairs for the child environment.
pub type Tokens = Vec<(String, String)>;

fn run_engine(settings: &Settings, command: &str, args: &AdsArgs, payload: Option<&Value>, tokens: &[(String, String)]) -> Result<Value, String> {
    let dir = ads_dir(settings);
    if !dir.join("ads-cli.js").is_file() {
        return Err(format!("No encuentro ads-cli.js en {}. Revisa Ajustes.", dir.display()));
    }
    let mut cmd = hidden_command(&settings.node_path);
    cmd.args(build_args(command, args)?).current_dir(&dir).env("AGENTAUTO_DATA_DIR", &settings.data_dir);
    // Whatever token variables the parent happens to carry are dropped; only the ones we pass reach the engine.
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with(TOKEN_ENV) {
            cmd.env_remove(&name);
        }
    }
    for (slug, token) in tokens {
        if !valid_slug(slug) {
            continue;
        }
        cmd.env(token_env_name(slug), token);
        if slug == PRINCIPAL {
            cmd.env(TOKEN_ENV, token);
        }
    }
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

/// Principal portfolio's token (the alerts monitor and the importer use it).
pub fn stored_token() -> Result<Option<String>, String> {
    get_token_in(KEY_SERVICE, PRINCIPAL)
}

/// Portfolio ids in `<data dir>/ads/config.json`. A pre-portfolio config (or none) only has the principal one.
pub fn portfolio_slugs(settings: &Settings) -> Vec<String> {
    let file = Path::new(&settings.data_dir).join("ads").join("config.json");
    let parsed: Option<Value> = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok());
    let mut slugs: Vec<String> = parsed
        .as_ref()
        .and_then(|c| c.get("portfolios"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|p| p.get("id").and_then(Value::as_str)).filter(|id| valid_slug(id)).map(str::to_string).collect())
        .unwrap_or_default();
    if !slugs.iter().any(|s| s == PRINCIPAL) && parsed.as_ref().map(|c| c.get("portfolios").is_none()).unwrap_or(true) {
        slugs.insert(0, PRINCIPAL.to_string());
    }
    slugs
}

/// Reads every slug's token with `get`; one unreadable entry is skipped and reported, never fatal for the others.
fn collect_tokens(slugs: &[String], get: impl Fn(&str) -> Result<Option<String>, String>) -> (Tokens, Vec<String>) {
    let mut tokens = Vec::new();
    let mut warnings = Vec::new();
    for slug in slugs {
        match get(slug) {
            Ok(Some(token)) => tokens.push((slug.clone(), token)),
            Ok(None) => {}
            Err(_) => warnings.push(format!("No pude leer el token del portafolio «{slug}» en el Administrador de credenciales: se omitió y sus cuentas no se actualizaron.")),
        }
    }
    (tokens, warnings)
}

/// Every stored portfolio token, ready for the child environment, plus a warning per unreadable entry.
pub fn stored_tokens(settings: &Settings) -> (Tokens, Vec<String>) {
    collect_tokens(&portfolio_slugs(settings), |slug| get_token_in(KEY_SERVICE, slug))
}

/// Adds `portfolioWarnings` to an engine answer (only when there is something to say).
fn with_warnings(mut value: Value, warnings: Vec<String>) -> Value {
    if !warnings.is_empty() {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("portfolioWarnings".to_string(), serde_json::json!(warnings));
        }
    }
    value
}

/// Portfolio that owns the primary account (the one the alerts monitor watches): the principal one when it has accounts,
/// else the first with accounts. A pre-portfolio config belongs to the principal one.
pub fn primary_portfolio_slug(settings: &Settings) -> String {
    let file = Path::new(&settings.data_dir).join("ads").join("config.json");
    let parsed: Option<Value> = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok());
    let Some(list) = parsed.as_ref().and_then(|c| c.get("portfolios")).and_then(Value::as_array) else {
        return PRINCIPAL.to_string();
    };
    let with_accounts: Vec<&str> = list
        .iter()
        .filter(|p| p.get("accounts").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false))
        .filter_map(|p| p.get("id").and_then(Value::as_str))
        .filter(|id| valid_slug(id))
        .collect();
    if with_accounts.contains(&PRINCIPAL) {
        PRINCIPAL.to_string()
    } else {
        with_accounts.first().map(|s| s.to_string()).unwrap_or_else(|| PRINCIPAL.to_string())
    }
}

/// Token for the alerts monitor: the one of the portfolio that owns the primary account, so a token is never paired with
/// another portfolio's account.
pub fn monitor_token(settings: &Settings) -> Result<Option<String>, String> {
    get_token_in(KEY_SERVICE, &primary_portfolio_slug(settings))
}

pub fn sync(settings: &Settings, from: &str, to: &str, accounts: Option<&str>) -> Result<Value, String> {
    let _guard = SyncGuard::acquire()?;
    let (tokens, warnings) = stored_tokens(settings);
    run_engine(settings, "sync", &AdsArgs { from: Some(from), to: Some(to), accounts, ..Default::default() }, None, &tokens).map(|v| with_warnings(v, warnings))
}

/// Incremental sync; the very first run of each account also backfills its whole history.
pub fn sync_auto(settings: &Settings, accounts: Option<&str>) -> Result<Value, String> {
    let _guard = SyncGuard::acquire()?;
    let (tokens, warnings) = stored_tokens(settings);
    run_engine(settings, "sync", &AdsArgs { auto: true, accounts, ..Default::default() }, None, &tokens).map(|v| with_warnings(v, warnings))
}

#[allow(clippy::too_many_arguments)]
pub fn report(settings: &Settings, from: &str, to: &str, group: &str, country: Option<&str>, split: bool, accounts: Option<&str>, name: Option<&str>, hours: Option<&str>) -> Result<Value, String> {
    run_engine(settings, "report", &AdsArgs { from: Some(from), to: Some(to), group: Some(group), country, split, accounts, name, hours, ..Default::default() }, None, &[])
}

/// Live exchange rates to COP (free public sources, no key). Called on each data refresh; the engine saves one rate per day.
pub fn fx_refresh(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "fx-refresh", &AdsArgs::default(), None, &[])
}

pub fn tracking(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "tracking", &AdsArgs::default(), None, &[])
}

/// Payments of any range (the Comprobantes card has its own dates), optionally limited to a country, accounts and ad names.
pub fn vouchers(settings: &Settings, from: &str, to: &str, country: Option<&str>, accounts: Option<&str>, name: Option<&str>) -> Result<Value, String> {
    run_engine(settings, "vouchers", &AdsArgs { from: Some(from), to: Some(to), country, accounts, name, ..Default::default() }, None, &[])
}

pub fn comprobante_country(settings: &Settings, key: &str, code: &str) -> Result<Value, String> {
    run_engine(settings, "comprobante-country", &AdsArgs { key: Some(key), code: Some(code), ..Default::default() }, None, &[])
}

/// Accepts a payment by hand (or takes it back with `undo`). Only the local database changes; the sheet is never written.
pub fn comprobante_accept(settings: &Settings, key: &str, undo: bool) -> Result<Value, String> {
    run_engine(settings, "comprobante-accept", &AdsArgs { key: Some(key), undo, ..Default::default() }, None, &[])
}

/// Discards a payment by hand (or restores it with `undo`). Only the local database changes; the sheet is never written.
pub fn comprobante_reject(settings: &Settings, key: &str, undo: bool) -> Result<Value, String> {
    run_engine(settings, "comprobante-reject", &AdsArgs { key: Some(key), undo, ..Default::default() }, None, &[])
}

/// Corrects the amount of a payment (`None` removes the correction). Only the local database changes; the sheet is never written.
pub fn comprobante_value(settings: &Settings, key: &str, valor: Option<u64>) -> Result<Value, String> {
    let text = valor.map(|v| v.to_string());
    run_engine(settings, "comprobante-value", &AdsArgs { key: Some(key), valor: Some(text.as_deref().unwrap_or("")), ..Default::default() }, None, &[])
}

/// Assigns an ad to a payment whose sheet row did not capture it (`None` removes the assignment). Only the local database changes.
pub fn comprobante_ad(settings: &Settings, key: &str, ad: Option<&str>) -> Result<Value, String> {
    run_engine(settings, "comprobante-ad", &AdsArgs { key: Some(key), ad: Some(ad.unwrap_or("")), ..Default::default() }, None, &[])
}

/// Budget timeline and suggested next budget per campaign. Reads stored data only: no Meta request, nothing is changed.
pub fn budget_plan(settings: &Settings, from: &str, to: &str, country: Option<&str>, accounts: Option<&str>, name: Option<&str>) -> Result<Value, String> {
    run_engine(settings, "budget-plan", &AdsArgs { from: Some(from), to: Some(to), country, accounts, name, ..Default::default() }, None, &[])
}

pub fn status(settings: &Settings) -> Result<Value, String> {
    let (tokens, warnings) = stored_tokens(settings);
    run_engine(settings, "status", &AdsArgs::default(), None, &tokens).map(|v| with_warnings(v, warnings))
}

pub fn config_get(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "config-get", &AdsArgs::default(), None, &[])
}

pub fn config_set(settings: &Settings, partial: &Value) -> Result<Value, String> {
    run_engine(settings, "config-set", &AdsArgs { stdin: true, ..Default::default() }, Some(partial), &[])
}

/// One scheduler step (budget snapshot + due decisions). Shares the sync lock so it never overlaps a manual sync.
pub fn tick(settings: &Settings, force: bool) -> Result<Value, String> {
    let _guard = SyncGuard::acquire()?;
    let (tokens, warnings) = stored_tokens(settings);
    run_engine(settings, "tick", &AdsArgs { force, ..Default::default() }, None, &tokens).map(|v| with_warnings(v, warnings))
}

pub fn decisions(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "decisions", &AdsArgs::default(), None, &[])
}

pub fn decision_status(settings: &Settings, id: u64, status: &str) -> Result<Value, String> {
    run_engine(settings, "decision-status", &AdsArgs { id: Some(id), status: Some(status), ..Default::default() }, None, &[])
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
    run_engine(settings, "alerts-config-get", &AdsArgs::default(), None, &[])
}

pub fn alerts_config_set(settings: &Settings, partial: &Value) -> Result<Value, String> {
    run_engine(settings, "alerts-config-set", &AdsArgs { stdin: true, ..Default::default() }, Some(partial), &[])
}

pub fn alerts_recent(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "alerts-recent", &AdsArgs::default(), None, &[])
}

pub fn wa_status(settings: &Settings) -> Result<Value, String> {
    run_engine(settings, "wa-status", &AdsArgs::default(), None, &[])
}

/// Checks one portfolio's token with Meta (who it is and which ad accounts it can see).
pub fn test_token(settings: &Settings, slug: &str) -> Result<Value, String> {
    let token = get_token_in(KEY_SERVICE, slug)?.ok_or("Falta el token de Meta de este portafolio. Pégalo en la configuración de Anuncios.")?;
    run_engine(settings, "test-token", &AdsArgs { portfolio: Some(slug), ..Default::default() }, None, &[(slug.to_string(), token)])
}

/// Creates a portfolio and stores its token. The token shape is checked first; if saving it fails the portfolio is rolled back.
pub fn portfolio_add(settings: &Settings, name: &str, token: &str) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("El portafolio necesita un nombre (hasta 80 caracteres).".to_string());
    }
    if !valid_token(token) {
        return Err("El token no parece válido: debe ser una sola cadena larga sin espacios.".to_string());
    }
    let created = run_engine(settings, "portfolio-add", &AdsArgs { stdin: true, ..Default::default() }, Some(&serde_json::json!({ "name": name })), &[])?;
    let slug = created.pointer("/portfolio/id").and_then(Value::as_str).filter(|s| valid_slug(s)).ok_or("El motor no devolvió el identificador del portafolio.")?.to_string();
    if let Err(e) = set_token(&slug, token) {
        let _ = remove_from_config(settings, &slug);
        return Err(e);
    }
    Ok(created)
}

/// Adds an ad account to a portfolio. The engine asks Meta first (with that portfolio's token) and saves nothing on failure.
pub fn account_add(settings: &Settings, portfolio: &str, account: &str, name: &str) -> Result<Value, String> {
    if !valid_slug(portfolio) {
        return Err("Portafolio no válido.".to_string());
    }
    let (tokens, _warnings) = stored_tokens(settings);
    let payload = serde_json::json!({ "portfolio": portfolio, "account": account.trim(), "name": name.trim() });
    run_engine(settings, "account-add", &AdsArgs { stdin: true, ..Default::default() }, Some(&payload), &tokens)
}

fn remove_from_config(settings: &Settings, slug: &str) -> Result<Value, String> {
    let current = config_get(settings)?;
    let kept: Vec<Value> = current
        .pointer("/config/portfolios")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter(|p| p.get("id").and_then(Value::as_str) != Some(slug)).cloned().collect())
        .unwrap_or_default();
    config_set(settings, &serde_json::json!({ "portfolios": kept }))
}

const PRINCIPAL_WARNING: &str = "El portafolio principal lo usan el monitor de alertas y la cuenta principal: confirma explícitamente que quieres";

/// The principal portfolio only goes away (or loses its token) with an explicit confirmation from the UI.
fn guard_principal(slug: &str, confirmed: bool, action: &str) -> Result<(), String> {
    if slug == PRINCIPAL && !confirmed {
        return Err(format!("{PRINCIPAL_WARNING} {action} este portafolio."));
    }
    Ok(())
}

/// Deletes a portfolio's token. The principal one needs `confirm_principal`.
pub fn clear_portfolio_token(slug: &str, confirm_principal: bool) -> Result<(), String> {
    guard_principal(slug, confirm_principal, "quitar el token de")?;
    clear_token(slug)
}

/// Removes a portfolio (and with it its accounts) from the configuration and deletes its token. The stored history in
/// ads.db is NOT touched: it only stops syncing and drops out of the selectors.
pub fn portfolio_remove(settings: &Settings, slug: &str, confirm_principal: bool) -> Result<Value, String> {
    if !valid_slug(slug) {
        return Err("Portafolio no válido.".to_string());
    }
    guard_principal(slug, confirm_principal, "eliminar")?;
    let saved = remove_from_config(settings, slug)?;
    clear_token(slug)?;
    Ok(saved)
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
    fn builds_fx_refresh_arguments() {
        assert_eq!(&build_args("fx-refresh", &AdsArgs::default()).unwrap()[2..], ["fx-refresh"]);
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
        assert_eq!(&build_args("comprobante-reject", &AdsArgs { key: Some(key), ..Default::default() }).unwrap()[2..], ["comprobante-reject", "--key", key]);
        assert_eq!(&build_args("comprobante-reject", &AdsArgs { key: Some(key), undo: true, ..Default::default() }).unwrap()[2..], ["comprobante-reject", "--key", key, "--undo"]);
        assert!(build_args("comprobante-reject", &AdsArgs { key: Some("../x"), ..Default::default() }).is_err());
        assert!(build_args("comprobante-reject", &AdsArgs::default()).is_err());
        let value = |valor: Option<&'static str>| build_args("comprobante-value", &AdsArgs { key: Some(key), valor, ..Default::default() });
        assert_eq!(&value(Some("45000")).unwrap()[2..], ["comprobante-value", "--key", key, "--valor", "45000"]);
        assert_eq!(&value(Some("100000000")).unwrap()[2..], ["comprobante-value", "--key", key, "--valor", "100000000"]);
        assert_eq!(&value(Some("")).unwrap()[2..], ["comprobante-value", "--key", key, "--valor"], "empty removes the correction");
        assert_eq!(&value(None).unwrap()[2..], ["comprobante-value", "--key", key, "--valor"]);
        for bad in ["0", "-5", "1.5", "abc", "100000001", "1e5", "1234567890", "5; calc"] {
            assert!(value(Some(bad)).is_err(), "{bad}");
        }
        assert!(build_args("comprobante-value", &AdsArgs { key: Some("../x"), valor: Some("5"), ..Default::default() }).is_err());
        assert!(build_args("comprobante-value", &AdsArgs::default()).is_err());
        let hours = |h: &'static str| build_args("report", &AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), hours: Some(h), ..Default::default() });
        assert_eq!(&hours("8-14").unwrap()[2..], ["report", "--from", "2026-10-01", "--to", "2026-10-29", "--hours", "8-14"]);
        assert!(hours("22-6").is_ok());
        assert!(hours("0-24").is_ok());
        for bad in ["8", "8-8", "24-5", "5-25", "a-b", "8-14; calc", "-1-5", ""] {
            assert!(hours(bad).is_err(), "{bad}");
        }
        assert!(build_args("vouchers", &AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), hours: Some("8-14"), ..Default::default() }).is_err(), "hours only apply to the report");
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
        let missing = import_token_from(&dir.join("nope.env"), &service, PRINCIPAL).unwrap_err();
        assert!(missing.contains("No encuentro"));
        std::fs::write(dir.join("empty.env"), "OTHER=1\n").unwrap();
        assert!(import_token_from(&dir.join("empty.env"), &service, PRINCIPAL).unwrap_err().contains("META_ACCESS_TOKEN"));
        std::fs::write(dir.join("ok.env"), "META_ACCESS_TOKEN=fake-test-token-0123456789abcdef\n").unwrap();
        import_token_from(&dir.join("ok.env"), &service, PRINCIPAL).unwrap();
        assert_eq!(get_token_in(&service, PRINCIPAL).unwrap().as_deref(), Some("fake-test-token-0123456789abcdef"));
        clear_token_in(&service, PRINCIPAL).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real Credential Manager round trip with a throw-away service name (removed at the end): one entry per portfolio.
    #[test]
    fn token_round_trips_through_the_credential_manager_per_portfolio() {
        let service = format!("agentAutoX1-test-{}", std::process::id());
        for slug in [PRINCIPAL, "otro-bm"] {
            assert_eq!(get_token_in(&service, slug).unwrap(), None);
        }
        set_token_in(&service, PRINCIPAL, "fake-test-token-0123456789abcdef").unwrap();
        set_token_in(&service, "otro-bm", "fake-test-token-second-9876543210").unwrap();
        assert_eq!(get_token_in(&service, PRINCIPAL).unwrap().as_deref(), Some("fake-test-token-0123456789abcdef"));
        assert_eq!(get_token_in(&service, "otro-bm").unwrap().as_deref(), Some("fake-test-token-second-9876543210"));
        assert!(set_token_in(&service, PRINCIPAL, "  ").is_err());
        assert!(set_token_in(&service, "../x", "fake-test-token-0123456789abcdef").is_err());
        clear_token_in(&service, "otro-bm").unwrap();
        assert_eq!(get_token_in(&service, "otro-bm").unwrap(), None);
        assert!(get_token_in(&service, PRINCIPAL).unwrap().is_some(), "clearing one portfolio leaves the others");
        clear_token_in(&service, PRINCIPAL).unwrap();
        assert_eq!(get_token_in(&service, PRINCIPAL).unwrap(), None);
    }

    #[test]
    fn keyring_entries_and_env_vars_derive_from_the_slug() {
        assert_eq!(token_entry_name(PRINCIPAL), "meta-token");
        assert_eq!(token_entry_name("otro-bm"), "meta-token:otro-bm");
        assert_eq!(token_env_name(PRINCIPAL), "AGENTAUTO_META_TOKEN__PRINCIPAL");
        assert_eq!(token_env_name("otro-bm"), "AGENTAUTO_META_TOKEN__OTRO_BM");
        assert!(valid_slug("bm-2") && valid_slug("principal"));
        for bad in ["", "Bm", "a b", "a_b", "../x", "a:b", &"x".repeat(41)] {
            assert!(!valid_slug(bad), "{bad}");
        }
    }

    #[test]
    fn builds_budget_plan_arguments_with_the_same_filters_as_the_report() {
        let base = AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), ..Default::default() };
        assert_eq!(&build_args("budget-plan", &base).unwrap()[2..], ["budget-plan", "--from", "2026-10-01", "--to", "2026-10-29"]);
        let full = AdsArgs { country: Some("MX"), accounts: Some("act_12345"), name: Some("ct, PZZ"), ..base.clone() };
        assert_eq!(
            &build_args("budget-plan", &full).unwrap()[2..],
            ["budget-plan", "--from", "2026-10-01", "--to", "2026-10-29", "--country", "MX", "--accounts", "act_12345", "--name", "ct, PZZ"]
        );
        assert!(build_args("budget-plan", &AdsArgs::default()).unwrap_err().contains("fechas"), "dates are required");
        assert!(build_args("budget-plan", &AdsArgs { from: Some("ayer"), ..base.clone() }).is_err());
        assert!(build_args("budget-plan", &AdsArgs { accounts: Some("act_1;calc"), ..base.clone() }).is_err());
        assert!(build_args("budget-plan", &AdsArgs { name: Some("--accounts"), ..base.clone() }).is_err());
        assert!(build_args("budget-plan", &AdsArgs { country: Some("Mexico"), ..base.clone() }).is_err());
        assert!(build_args("budget-plan", &AdsArgs { hours: Some("8-14"), ..base.clone() }).is_err(), "hours only apply to the report");
    }

    #[test]
    fn builds_comprobante_ad_arguments() {
        let key = "0123456789abcdef0123";
        assert_eq!(&build_args("comprobante-ad", &AdsArgs { key: Some(key), ad: Some("120212345678901"), ..Default::default() }).unwrap()[2..], ["comprobante-ad", "--key", key, "--ad", "120212345678901"]);
        assert_eq!(&build_args("comprobante-ad", &AdsArgs { key: Some(key), ad: Some(""), ..Default::default() }).unwrap()[2..], ["comprobante-ad", "--key", key], "empty removes the assignment");
        assert_eq!(&build_args("comprobante-ad", &AdsArgs { key: Some(key), ..Default::default() }).unwrap()[2..], ["comprobante-ad", "--key", key]);
        for bad in ["1234", "abc12345", "12345;calc", "../x", "1234567890123456789012345678"] {
            assert!(build_args("comprobante-ad", &AdsArgs { key: Some(key), ad: Some(bad), ..Default::default() }).is_err(), "ad {bad:?}");
        }
        assert!(build_args("comprobante-ad", &AdsArgs { key: Some("../x"), ad: Some("12345"), ..Default::default() }).is_err());
        assert!(build_args("comprobante-ad", &AdsArgs::default()).is_err());
    }

    #[test]
    fn builds_account_and_name_filter_arguments() {
        let base = AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), group: Some("campaign"), ..Default::default() };
        let r = build_args("report", &AdsArgs { accounts: Some("act_12345,act_67890"), name: Some("ct, PZZ"), ..base.clone() }).unwrap();
        assert_eq!(&r[2..], ["report", "--from", "2026-10-01", "--to", "2026-10-29", "--group", "campaign", "--accounts", "act_12345,act_67890", "--name", "ct, PZZ"]);
        let v = build_args("vouchers", &AdsArgs { from: Some("2026-10-01"), to: Some("2026-10-29"), accounts: Some("all"), ..Default::default() }).unwrap();
        assert_eq!(&v[2..], ["vouchers", "--from", "2026-10-01", "--to", "2026-10-29", "--accounts", "all"]);
        let sync = build_args("sync", &AdsArgs { auto: true, accounts: Some("act_12345"), ..Default::default() }).unwrap();
        assert_eq!(&sync[2..], ["sync", "--accounts", "act_12345", "--auto"]);
        // An empty name filter is simply not sent.
        assert!(!build_args("report", &AdsArgs { name: Some("  "), ..base.clone() }).unwrap().contains(&"--name".to_string()));
        for bad in ["act_1", "act_12345;calc", "12345", "act_12345,", "ALL", "act_12345,act_abc12", ""] {
            assert!(build_args("report", &AdsArgs { accounts: Some(bad), ..base.clone() }).is_err(), "accounts {bad:?}");
        }
        for bad in ["x'; DROP TABLE ads;--", "<b>", "--accounts", "a\nb", &"a".repeat(401)] {
            assert!(build_args("report", &AdsArgs { name: Some(bad), ..base.clone() }).is_err(), "name {bad:?}");
        }
        assert!(build_args("tick", &AdsArgs { accounts: Some("all"), ..Default::default() }).is_err(), "only sync/report/vouchers take accounts");
        assert!(build_args("sync", &AdsArgs { name: Some("ct"), from: Some("2026-10-01"), to: Some("2026-10-02"), ..Default::default() }).is_err());
        assert_eq!(&build_args("test-token", &AdsArgs { portfolio: Some("otro-bm"), ..Default::default() }).unwrap()[2..], ["test-token", "--portfolio", "otro-bm"]);
        assert!(build_args("test-token", &AdsArgs { portfolio: Some("../x"), ..Default::default() }).is_err());
        assert_eq!(build_args("account-add", &AdsArgs { stdin: true, ..Default::default() }).unwrap().last().unwrap(), "--stdin");
        assert_eq!(&build_args("portfolio-add", &AdsArgs { stdin: true, ..Default::default() }).unwrap()[2..], ["portfolio-add", "--stdin"]);
    }

    #[test]
    fn one_unreadable_token_does_not_stop_the_others() {
        let slugs: Vec<String> = ["principal", "roto", "bm-dos", "vacio"].iter().map(|s| s.to_string()).collect();
        let (tokens, warnings) = collect_tokens(&slugs, |slug| match slug {
            "roto" => Err("keyring: acceso denegado".to_string()),
            "vacio" => Ok(None),
            other => Ok(Some(format!("token-{other}"))),
        });
        assert_eq!(tokens, [("principal".to_string(), "token-principal".to_string()), ("bm-dos".to_string(), "token-bm-dos".to_string())]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("roto") && !warnings[0].contains("denegado"), "{warnings:?}");
        let answered = with_warnings(json!({"ok": true}), warnings);
        assert_eq!(answered["portfolioWarnings"].as_array().unwrap().len(), 1);
        assert!(with_warnings(json!({"ok": true}), vec![]).get("portfolioWarnings").is_none());
    }

    #[test]
    fn the_principal_portfolio_needs_an_explicit_confirmation_to_lose_its_token_or_disappear() {
        let settings = Settings::defaults(Path::new("C:/x"));
        assert!(clear_portfolio_token(PRINCIPAL, false).unwrap_err().contains("confirma"));
        assert!(portfolio_remove(&settings, PRINCIPAL, false).unwrap_err().contains("monitor de alertas"));
        assert!(portfolio_remove(&settings, "../x", true).is_err());
    }

    #[test]
    fn the_monitor_uses_the_portfolio_that_owns_the_primary_account() {
        let dir = std::env::temp_dir().join(format!("agentautox1-ads-primary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut settings = Settings::defaults(Path::new("C:/x"));
        settings.data_dir = dir.to_string_lossy().into_owned();
        assert_eq!(primary_portfolio_slug(&settings), PRINCIPAL, "no config");
        std::fs::create_dir_all(dir.join("ads")).unwrap();
        let write = |text: &str| std::fs::write(dir.join("ads").join("config.json"), text).unwrap();
        write(r#"{"adAccountId":"act_12345"}"#);
        assert_eq!(primary_portfolio_slug(&settings), PRINCIPAL, "legacy config");
        write(r#"{"portfolios":[{"id":"bm-dos","accounts":[{"id":"act_22222"}]},{"id":"principal","accounts":[{"id":"act_11111"}]}]}"#);
        assert_eq!(primary_portfolio_slug(&settings), PRINCIPAL);
        write(r#"{"portfolios":[{"id":"principal","accounts":[]},{"id":"bm-dos","accounts":[{"id":"act_22222"}]}]}"#);
        assert_eq!(primary_portfolio_slug(&settings), "bm-dos", "the principal one has no accounts");
        write(r#"{"portfolios":[{"id":"Bad Slug","accounts":[{"id":"act_1"}]},{"id":"bm-tres","accounts":[{"id":"act_33333"}]}]}"#);
        assert_eq!(primary_portfolio_slug(&settings), "bm-tres");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn portfolio_ids_come_from_the_config_file() {
        let dir = std::env::temp_dir().join(format!("agentautox1-ads-slugs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut settings = Settings::defaults(Path::new("C:/x"));
        settings.data_dir = dir.to_string_lossy().into_owned();
        assert_eq!(portfolio_slugs(&settings), [PRINCIPAL], "no config: only the principal one");
        std::fs::create_dir_all(dir.join("ads")).unwrap();
        std::fs::write(dir.join("ads").join("config.json"), r#"{"adAccountId":"act_12345"}"#).unwrap();
        assert_eq!(portfolio_slugs(&settings), [PRINCIPAL], "legacy config migrates to the principal portfolio");
        std::fs::write(dir.join("ads").join("config.json"), r#"{"portfolios":[{"id":"bm-dos","name":"x","accounts":[]},{"id":"Bad Slug"},{"id":"principal"}]}"#).unwrap();
        assert_eq!(portfolio_slugs(&settings), ["bm-dos", PRINCIPAL]);
        std::fs::write(dir.join("ads").join("config.json"), r#"{"portfolios":[]}"#).unwrap();
        assert!(portfolio_slugs(&settings).is_empty(), "an explicit empty list means first-run");
        let _ = std::fs::remove_dir_all(&dir);
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

        let status = run_engine(&settings, "status", &AdsArgs::default(), None, &[]).unwrap();
        assert_eq!(status["tokenPresent"], false);
        let cfg = config_get(&settings).unwrap();
        assert_eq!(cfg["config"]["campaignPrefix"], "all");
        let saved = config_set(&settings, &json!({"flowPrefix": "Barf"})).unwrap();
        assert_eq!(saved["config"]["flowPrefix"], "Barf");
        assert!(config_set(&settings, &json!({"token": "x"})).is_err());
        let report = report(&settings, "2026-10-01", "2026-10-02", "campaign", None, false, None, None, None).unwrap();
        assert_eq!(report["kpis"]["gasto"], 0);
        assert_eq!(report["daily"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real engine, throw-away data dir: a portfolio is created (first one = principal), its accounts are listed and the
    /// filters reach the report. No network and no keyring: a missing token is reported before Meta is asked.
    #[test]
    fn talks_to_the_real_engine_about_portfolios_offline() {
        let dir = std::env::temp_dir().join(format!("agentautox1-ads-pf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut settings = Settings::defaults(Path::new("C:/x"));
        settings.warmup_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("engines").join("warmup").to_string_lossy().into_owned();
        settings.data_dir = dir.to_string_lossy().into_owned();

        assert_eq!(config_get(&settings).unwrap()["config"]["portfolios"], json!([]), "a fresh data dir starts in first-run");
        let created = run_engine(&settings, "portfolio-add", &AdsArgs { stdin: true, ..Default::default() }, Some(&json!({"name": "Mi BM"})), &[]).unwrap();
        assert_eq!(created["portfolio"]["id"], "principal");
        assert_eq!(portfolio_slugs(&settings), [PRINCIPAL]);
        let no_token = account_add(&settings, "principal", "act_12345", "").unwrap_err();
        assert!(no_token.contains("token"), "{no_token}");
        assert!(account_add(&settings, "../x", "act_12345", "").is_err());

        let engine_tokens = vec![(PRINCIPAL.to_string(), "fake-test-token-0123456789abcdef".to_string())];
        let status = run_engine(&settings, "status", &AdsArgs::default(), None, &engine_tokens).unwrap();
        assert_eq!(status["portfolios"], json!([{"id": "principal", "tokenPresent": true}]));
        assert!(!status.to_string().contains("fake-test-token"), "token values never come back");

        let filtered = report(&settings, "2026-10-01", "2026-10-02", "campaign", None, false, Some("all"), Some("ct,pzz"), None).unwrap();
        assert_eq!(filtered["nameFilter"], json!(["ct", "pzz"]));
        assert!(report(&settings, "2026-10-01", "2026-10-02", "campaign", None, false, Some("act_99999"), None, None).is_err(), "unknown accounts are refused by the engine");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
