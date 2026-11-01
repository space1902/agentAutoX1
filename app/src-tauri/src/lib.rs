mod ads;
mod applog;
mod alerts;
mod agents;
mod ai;
mod data;
mod embed;
mod linker;
mod notify;
mod keepalive;
mod keepalive_real;
mod linker_real;
mod pods;
mod profiles;
mod settings;
mod util;
mod voices;
mod pairing;
mod warmup;

use serde::Serialize;
use serde_json::{Value, json};
use settings::Settings;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    root: PathBuf,
    settings_file: PathBuf,
    settings: Arc<Mutex<Settings>>,
    runner: warmup::Runner,
    pull: ai::PullJob,
    pod_job: pods::PodJob,
    link_cancel: Arc<AtomicBool>,
    keepalive: Arc<keepalive::Scheduler>,
    keep_stop: Arc<AtomicBool>,
    last_on_file: PathBuf,
    embedder: Mutex<Option<Arc<embed::Embedder<embed::win::RealWin>>>>,
    alerts: alerts::Alerts,
    agents: agents::Agents,
}

/// Profile the app is running right now (the engine refuses to edit it).
fn running_profile(state: &AppState) -> Option<String> {
    let status = state.runner.status();
    if status.running { status.profile } else { None }
}

/// Registry/profile data plus a warning when the pod list could not be read (e.g. BlueStacks missing).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Overview {
    data: Value,
    pods_error: Option<String>,
}

fn overview(settings: &Settings, command: &str) -> Result<Overview, String> {
    let (pods, pods_error) = match pods::list(settings) {
        Ok(list) => (list, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let data = profiles::call(settings, command, &json!({ "pods": pods }))?;
    Ok(Overview { data, pods_error })
}

impl AppState {
    fn current(&self) -> Settings {
        crate::util::lock(&self.settings).clone()
    }
}

/// Runs blocking work (PowerShell, file IO, waits) off the async runtime threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Errors the UI could not handle (render errors, unhandled rejections) end up in the application log.
#[tauri::command]
fn log_client_error(kind: String, message: String, stack: Option<String>) {
    applog::log_client(&kind, &message, stack.as_deref());
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.current()
}

#[tauri::command]
fn get_default_settings(state: State<'_, AppState>) -> Settings {
    Settings::defaults(&state.root)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let mut merged = Settings::merge_saved(&state.root, &serde_json::to_value(&settings).map_err(|e| e.to_string())?);
    // The Ajustes form does not own this switch: it has its own command.
    merged.keep_alive = state.current().keep_alive;
    merged.embed_view = state.current().embed_view;
    merged.save(&state.settings_file)?;
    *crate::util::lock(&state.settings) = merged.clone();
    applog::set_data_dir(Path::new(&merged.data_dir));
    Ok(merged)
}

#[tauri::command]
async fn list_pods(state: State<'_, AppState>) -> Result<Vec<pods::Pod>, String> {
    let settings = state.current();
    let last_on = state.last_on_file.clone();
    blocking(move || {
        let list = pods::list(&settings)?;
        // Every pod seen running counts as "last on now" for the keep-alive scheduler.
        keepalive_real::record_running(&last_on, &list);
        Ok(list)
    })
    .await
}

#[tauri::command]
async fn pod_action(state: State<'_, AppState>, action: String, name: String) -> Result<String, String> {
    let settings = state.current();
    if let Some(job) = state.pod_job.current() {
        return Err(format!("Hay una operación de pods en curso ({job}); espera a que termine."));
    }
    blocking(move || pods::run_action(&settings, &action, &name)).await
}

/// Creates a pod (long: ~12-15 min). Streams `pod-create-progress` events while it runs.
#[tauri::command]
async fn create_pod(app: AppHandle, state: State<'_, AppState>, name: String, phone: String) -> Result<String, String> {
    let settings = state.current();
    let guard = state.pod_job.begin(&format!("crear {name}"))?;
    blocking(move || {
        let _guard = guard;
        pods::create(&settings, &name, &phone, &mut |p| {
            let _ = app.emit("pod-create-progress", p);
        })
    })
    .await
}

#[tauri::command]
async fn rename_pod(state: State<'_, AppState>, name: String, new_name: String) -> Result<String, String> {
    let settings = state.current();
    let guard = state.pod_job.begin(&format!("renombrar {name}"))?;
    blocking(move || {
        let _guard = guard;
        pods::rename(&settings, &name, &new_name)
    })
    .await
}

#[tauri::command]
async fn set_pod_phone(state: State<'_, AppState>, name: String, phone: String) -> Result<String, String> {
    let settings = state.current();
    let guard = state.pod_job.begin(&format!("guardar número de {name}"))?;
    blocking(move || {
        let _guard = guard;
        pods::set_phone(&settings, &name, &phone)
    })
    .await
}

#[tauri::command]
async fn delete_pod(state: State<'_, AppState>, name: String, confirm: String) -> Result<String, String> {
    let settings = state.current();
    let guard = state.pod_job.begin(&format!("borrar {name}"))?;
    blocking(move || {
        let _guard = guard;
        pods::delete(&settings, &name, &confirm)
    })
    .await
}

#[tauri::command]
fn keepalive_status(state: State<'_, AppState>) -> keepalive::KeepAliveStatus {
    state.keepalive.status()
}

/// Turns the "Auto revisión de números en los pods" switch on or off (persisted in the app settings).
#[tauri::command]
fn set_keep_alive(state: State<'_, AppState>, enabled: bool) -> Result<keepalive::KeepAliveStatus, String> {
    let mut next = state.current();
    next.keep_alive = enabled;
    next.save(&state.settings_file)?;
    *crate::util::lock(&state.settings) = next;
    state.keepalive.set_enabled(enabled);
    Ok(state.keepalive.status())
}

// ---------- embedded BlueStacks view (experimental, behind settings.embedView) ----------

/// A `follow` is already queued on a worker thread.
static FOLLOW_PENDING: AtomicBool = AtomicBool::new(false);

/// The embedder is created on first use, parented to the main window.
fn embedder_for(window: &tauri::WebviewWindow, state: &AppState) -> Result<Arc<embed::Embedder<embed::win::RealWin>>, String> {
    if !state.current().embed_view {
        return Err("La vista embebida está desactivada (función experimental).".into());
    }
    let mut slot = crate::util::lock(&state.embedder);
    if let Some(existing) = slot.as_ref() {
        return Ok(existing.clone());
    }
    let hwnd = window.hwnd().map_err(|e| format!("No se pudo obtener la ventana de la app: {e}"))?;
    let created = Arc::new(embed::Embedder::new(embed::win::RealWin::default(), hwnd.0 as isize));
    *slot = Some(created.clone());
    Ok(created)
}

/// Every couple of seconds, off the UI thread: a pod window that stays unresponsive is released (hidden, no owner),
/// so it can never freeze the app. The BlueStacks process itself is never touched.
fn spawn_embed_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let embedder = crate::util::lock(&app.state::<AppState>().embedder).clone();
            let Some(embedder) = embedder else { continue };
            let now_ms = started.elapsed().as_millis() as u64;
            for pod in embedder.check_hangs(now_ms) {
                applog::log("embed", &format!("La ventana del pod {pod} no responde desde hace más de {} s: se soltó de la app (oculta y sin dueño). BlueStacks sigue encendido.", embed::HANG_LIMIT_MS / 1000));
                let _ = app.emit("embed-hung", &pod);
            }
        }
    });
}

#[tauri::command]
fn set_embed_view(state: State<'_, AppState>, enabled: bool) -> Result<Settings, String> {
    let mut next = state.current();
    next.embed_view = enabled;
    next.save(&state.settings_file)?;
    *crate::util::lock(&state.settings) = next.clone();
    if !enabled {
        if let Some(embedder) = crate::util::lock(&state.embedder).take() {
            embedder.detach_all();
        }
    }
    Ok(next)
}

/// Shows the pod's BlueStacks window in its stage (CSS pixels + devicePixelRatio): the stage is the FULL box, even the
/// part scrolled out of view; `view_*` is the visible webview, which the native window is clipped to.
///
/// The window is only embedded once the pod finished booting (`serial` known, `sys.boot_completed` = 1, window
/// answering). Until then nothing is touched and the pod is reported in `booting`; the UI asks again.
#[tauri::command]
async fn embed_attach(window: tauri::WebviewWindow, state: State<'_, AppState>, name: String, serial: Option<String>, x: f64, y: f64, width: f64, height: f64, view_width: f64, view_height: f64, dpr: f64) -> Result<embed::EmbedState, String> {
    if !util::is_valid_pod_name(&name) {
        return Err(format!("Nombre de pod no válido: {name}"));
    }
    let embedder = embedder_for(&window, &state)?;
    let settings = state.current();
    blocking(move || {
        embedder.set_viewport(embed::scale_rect(0.0, 0.0, view_width, view_height, dpr));
        let ready = embedder.prepare(&name, serial.as_deref(), || serial.as_deref().is_some_and(|s| pods::boot_completed(&settings, s)));
        if matches!(ready, embed::Readiness::Booting(_)) {
            return Ok(embedder.state()); // not logged: the UI asks again every few seconds while the pod boots
        }
        embedder.attach(&name, embed::scale_rect(x, y, width, height, dpr))?;
        Ok(embedder.state())
    })
    .await
}

/// Current embedding state (attached, booting, released as hung), cheap and independent of the window locks.
#[tauri::command]
async fn embed_state(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<embed::EmbedState, String> {
    let embedder = embedder_for(&window, &state)?;
    blocking(move || Ok(embedder.state())).await
}

/// "Reintentar": forgets that the pod's window was released as hung so the next attach embeds it again.
#[tauri::command]
async fn embed_retry(window: tauri::WebviewWindow, state: State<'_, AppState>, name: String) -> Result<embed::EmbedState, String> {
    let embedder = embedder_for(&window, &state)?;
    blocking(move || {
        embedder.retry(&name);
        Ok(embedder.state())
    })
    .await
}

#[tauri::command]
async fn embed_resize(window: tauri::WebviewWindow, state: State<'_, AppState>, name: String, x: f64, y: f64, width: f64, height: f64, view_width: f64, view_height: f64, dpr: f64) -> Result<(), String> {
    let embedder = embedder_for(&window, &state)?;
    blocking(move || {
        embedder.set_viewport(embed::scale_rect(0.0, 0.0, view_width, view_height, dpr));
        embedder.resize(&name, embed::scale_rect(x, y, width, height, dpr))
    })
    .await
}

/// Shows that pod's window and hides the rest; `None` hides all of them (modal open, other section...).
#[tauri::command]
async fn embed_activate(window: tauri::WebviewWindow, state: State<'_, AppState>, name: Option<String>) -> Result<embed::EmbedState, String> {
    let embedder = embedder_for(&window, &state)?;
    blocking(move || {
        embedder.activate(name.as_deref());
        Ok(embedder.state())
    })
    .await
}

/// Gives the window back (no owner, original place and size) and brings it to the front: "Abrir en ventana aparte".
#[tauri::command]
async fn embed_detach(window: tauri::WebviewWindow, state: State<'_, AppState>, name: String) -> Result<embed::EmbedState, String> {
    let embedder = embedder_for(&window, &state)?;
    blocking(move || {
        embedder.detach(&name)?;
        Ok(embedder.state())
    })
    .await
}

/// Pods that must be linked before `name` can start: unlinked testers whose phone belongs to a pod.
#[tauri::command]
async fn plan_pod_links(state: State<'_, AppState>, name: String) -> Result<Vec<linker::LinkTarget>, String> {
    let settings = state.current();
    blocking(move || {
        let pods = pods::list(&settings)?;
        let data = profiles::call(&settings, "list", &json!({ "pods": pods }))?;
        let profile = data["profiles"]
            .as_array()
            .and_then(|list| list.iter().find(|p| p["name"] == name.as_str()))
            .ok_or_else(|| format!("El perfil «{name}» no existe."))?;
        Ok(linker::plan_links(profile, &pods))
    })
    .await
}

/// Links the pods of `name` one at a time. Streams `pod-link-progress` events. `dry_run` only reads screens.
#[tauri::command]
async fn run_pod_links(app: AppHandle, state: State<'_, AppState>, name: String, dry_run: bool, power_off_after: bool) -> Result<Vec<linker::LinkResult>, String> {
    let settings = state.current();
    if let Some(running) = running_profile(&state) {
        return Err(format!("El perfil «{running}» está en curso; detenlo antes de vincular pods."));
    }
    let guard = state.pod_job.begin("vincular pods")?;
    let cancel = state.link_cancel.clone();
    cancel.store(false, Ordering::SeqCst);
    blocking(move || {
        let _guard = guard;
        let pods = pods::list(&settings)?;
        let data = profiles::call(&settings, "list", &json!({ "pods": pods }))?;
        let profile = data["profiles"]
            .as_array()
            .and_then(|list| list.iter().find(|p| p["name"] == name.as_str()))
            .ok_or_else(|| format!("El perfil «{name}» no existe."))?;
        let targets = linker::plan_links(profile, &pods);
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        let ops = linker_real::RealOps::new(settings, cancel)?;
        let options = linker::Options { power_off_after, dry_run };
        Ok(linker::run_links(&ops, &targets, &options, &linker::Limits::default(), &mut |p| {
            let _ = app.emit("pod-link-progress", p);
        }))
    })
    .await
}

#[tauri::command]
fn cancel_pod_links(state: State<'_, AppState>) {
    state.link_cancel.store(true, Ordering::SeqCst);
}

/// Profiles (with numbers, pod names and linked state) plus the merged number registry.
#[tauri::command]
async fn profiles_overview(state: State<'_, AppState>) -> Result<Overview, String> {
    let settings = state.current();
    blocking(move || overview(&settings, "list")).await
}

#[tauri::command]
async fn registry_overview(state: State<'_, AppState>) -> Result<Overview, String> {
    let settings = state.current();
    blocking(move || overview(&settings, "registry")).await
}

/// Mutating profile commands: the engine validates everything and refuses to touch the running profile.
async fn profile_mutation(state: &State<'_, AppState>, command: &'static str, payload: Value) -> Result<Value, String> {
    let settings = state.current();
    let payload = profiles::with_running(payload, running_profile(state).as_deref());
    blocking(move || profiles::call(&settings, command, &payload)).await
}

#[tauri::command]
async fn profile_create(state: State<'_, AppState>, name: String, group: Option<String>, selections: Value) -> Result<Value, String> {
    profile_mutation(&state, "create", json!({ "name": name, "group": group, "selections": selections })).await
}

#[tauri::command]
async fn profile_update(
    state: State<'_, AppState>,
    name: String,
    new_name: Option<String>,
    group: Option<String>,
    selections: Option<Value>,
) -> Result<Value, String> {
    profile_mutation(&state, "update", json!({ "name": name, "newName": new_name, "group": group, "selections": selections })).await
}

#[tauri::command]
async fn profile_delete(state: State<'_, AppState>, name: String) -> Result<Value, String> {
    profile_mutation(&state, "delete", json!({ "name": name })).await
}

#[tauri::command]
async fn profile_set_group(state: State<'_, AppState>, name: String, group: String) -> Result<Value, String> {
    profile_mutation(&state, "set-group", json!({ "name": name, "group": group })).await
}

/// Traffic light and 0-100 strength per tester (computed by the engine from events, activity and results).
#[tauri::command]
async fn line_health(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || profiles::call(&settings, "line-health", &json!({}))).await
}

#[tauri::command]
fn read_warmup_data(state: State<'_, AppState>) -> Result<data::WarmupData, String> {
    data::read_warmup(&state.current())
}

#[tauri::command]
fn read_pods_wsp(state: State<'_, AppState>) -> Result<BTreeMap<String, String>, String> {
    data::read_pods_wsp(&state.current())
}

// ---- IA section

/// Engine commands of the IA section. The key of the chosen provider is injected only for `ai-test`.
#[tauri::command]
async fn ai_call(state: State<'_, AppState>, command: String, payload: Value) -> Result<Value, String> {
    let settings = state.current();
    let mut payload = payload;
    if command == "local-delete" {
        payload = profiles::with_running(payload, running_profile(&state).as_deref());
    }
    blocking(move || {
        let key = ai::key_for_command(&command, &payload)?;
        ai::call(&settings, &command, &payload, key.as_deref())
    })
    .await
}

#[tauri::command]
async fn ai_key_status(presets: Vec<String>) -> Result<BTreeMap<String, ai::KeyStatus>, String> {
    blocking(move || presets.into_iter().map(|p| ai::key_status(&p).map(|s| (p, s))).collect()).await
}

#[tauri::command]
async fn ai_key_set(preset: String, key: String) -> Result<ai::KeyStatus, String> {
    blocking(move || ai::set_key(&preset, &key)).await
}

#[tauri::command]
async fn ai_key_clear(preset: String) -> Result<(), String> {
    blocking(move || ai::clear_key(&preset)).await
}

#[tauri::command]
fn ai_pull_start(app: AppHandle, state: State<'_, AppState>, model: String) -> Result<(), String> {
    state.pull.start(&app, &state.current(), &model)
}

#[tauri::command]
fn ai_pull_cancel(state: State<'_, AppState>) -> bool {
    state.pull.cancel()
}

#[tauri::command]
fn ollama_installed() -> bool {
    ai::ollama_exe().is_some()
}

#[tauri::command]
fn ollama_install(app: AppHandle) {
    ai::install_ollama(app);
}

#[tauri::command]
fn ollama_launch() -> Result<(), String> {
    ai::launch_ollama()
}

// ---- Anuncios section

#[tauri::command]
async fn ads_sync(state: State<'_, AppState>, from: String, to: String) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::sync(&settings, &from, &to)).await
}

#[tauri::command]
async fn ads_report(state: State<'_, AppState>, from: String, to: String, group: String, country: Option<String>, split: Option<bool>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::report(&settings, &from, &to, &group, country.as_deref(), split.unwrap_or(false))).await
}

/// Payments of an arbitrary range for the Comprobantes card.
#[tauri::command]
async fn ads_vouchers(state: State<'_, AppState>, from: String, to: String, country: Option<String>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::vouchers(&settings, &from, &to, country.as_deref())).await
}

/// Incremental sync (last days + today); the first run backfills the whole history.
#[tauri::command]
async fn ads_sync_auto(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::sync_auto(&settings)).await
}

#[tauri::command]
async fn ads_tracking(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::tracking(&settings)).await
}

/// Manual country of one payment (an empty code removes it).
#[tauri::command]
async fn ads_comprobante_country(state: State<'_, AppState>, key: String, code: String) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::comprobante_country(&settings, &key, &code)).await
}

/// Accepts a payment by hand (or undoes it). The sheet is never modified.
#[tauri::command]
async fn ads_comprobante_accept(state: State<'_, AppState>, key: String, undo: bool) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::comprobante_accept(&settings, &key, undo)).await
}

#[tauri::command]
async fn ads_status(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::status(&settings)).await
}

#[tauri::command]
async fn ads_config_get(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::config_get(&settings)).await
}

#[tauri::command]
async fn ads_config_set(state: State<'_, AppState>, config: Value) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::config_set(&settings, &config)).await
}

#[tauri::command]
async fn ads_decisions(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::decisions(&settings)).await
}

#[tauri::command]
async fn ads_decision_status(state: State<'_, AppState>, id: u64, status: String) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::decision_status(&settings, id, &status)).await
}

/// "Evaluar ahora": one scheduler step on demand (snapshot, sync and decisions that are due).
#[tauri::command]
async fn ads_tick_now(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    let result = blocking(move || ads::tick(&settings, true)).await?;
    ads::announce(&app, &result);
    Ok(result)
}

// ---- Voces section (ElevenLabs). The key lives in the Windows Credential Manager and is never returned.

/// Engine commands of the Voces section; the key is injected only for the ones that call ElevenLabs.
#[tauri::command]
async fn voices_call(state: State<'_, AppState>, command: String, payload: Value) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || voices::call_with_stored_key(&settings, &command, &payload)).await
}

#[tauri::command]
async fn voices_key_status() -> Result<ai::KeyStatus, String> {
    blocking(voices::key_status).await
}

#[tauri::command]
async fn voices_key_set(key: String) -> Result<ai::KeyStatus, String> {
    blocking(move || voices::set_key(&key)).await
}

#[tauri::command]
async fn voices_key_clear() -> Result<(), String> {
    blocking(voices::clear_key).await
}

// ---- Agentes (chat agents on the local Claude Code; the engine's registry lists them)

/// One-shot command of an agent. `agent_id` is checked against the fixed list before anything runs.
#[tauri::command]
async fn agent_call(state: State<'_, AppState>, agent_id: String, command: String, payload: Value) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || agents::call(&settings, &agent_id, &command, &payload)).await
}

/// Starts a streaming command (`turn` or `eval-run`); events arrive as `agent-status` / `agent-eval-status` (with
/// `agentId` inside), plus the legacy `analista-*` names for the Analista.
#[tauri::command]
async fn agent_start(app: AppHandle, state: State<'_, AppState>, agent_id: String, command: String, payload: Value) -> Result<u32, String> {
    let settings = state.current();
    let agents = state.agents.clone();
    let emit = event_emitter(&app);
    blocking(move || agents.start(&settings, &agent_id, &command, &payload, emit)).await
}

#[tauri::command]
async fn agent_cancel(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.cancel(&agent_id)).await
}

#[tauri::command]
fn agent_status(state: State<'_, AppState>, agent_id: String) -> Result<Value, String> {
    state.agents.status(&agent_id)
}

// Aliases kept for one phase: they act on the Analista.

#[tauri::command]
async fn analista_call(state: State<'_, AppState>, command: String, payload: Value) -> Result<Value, String> {
    agent_call(state, agents::LEGACY_AGENT.to_string(), command, payload).await
}

#[tauri::command]
async fn analista_start(app: AppHandle, state: State<'_, AppState>, command: String, payload: Value) -> Result<u32, String> {
    agent_start(app, state, agents::LEGACY_AGENT.to_string(), command, payload).await
}

#[tauri::command]
async fn analista_cancel(state: State<'_, AppState>) -> Result<(), String> {
    agent_cancel(state, agents::LEGACY_AGENT.to_string()).await
}

#[tauri::command]
fn analista_status(state: State<'_, AppState>) -> Result<Value, String> {
    agent_status(state, agents::LEGACY_AGENT.to_string())
}

// ---- Alertas panel

#[tauri::command]
async fn ads_alerts_config_get(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::alerts_config_get(&settings)).await
}

#[tauri::command]
async fn ads_alerts_config_set(state: State<'_, AppState>, config: Value) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::alerts_config_set(&settings, &config)).await
}

#[tauri::command]
async fn ads_alerts_recent(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::alerts_recent(&settings)).await
}

#[tauri::command]
async fn ads_wa_status(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::wa_status(&settings)).await
}

fn event_emitter(app: &AppHandle) -> alerts::Emit {
    let app = app.clone();
    Arc::new(move |name: &str, payload: Value| {
        let _ = app.emit(name, payload);
    })
}

/// Minutes since the standalone monitor last wrote its log, when that looks like "still running".
#[tauri::command]
fn ads_monitor_conflict(state: State<'_, AppState>) -> Option<u64> {
    alerts::conflict_minutes(&state.root)
}

#[tauri::command]
fn ads_monitor_status(state: State<'_, AppState>) -> alerts::ProcStatus {
    state.alerts.monitor.status()
}

#[tauri::command]
async fn ads_monitor_start(app: AppHandle, state: State<'_, AppState>, confirm_conflict: bool) -> Result<alerts::ProcStatus, String> {
    let settings = state.current();
    let root = state.root.clone();
    let alerts = state.alerts.clone();
    let emit = event_emitter(&app);
    blocking(move || {
        let token = ads::stored_token()?;
        alerts.start_monitor(&settings, &root, token, confirm_conflict, emit)?;
        Ok(alerts.monitor.status())
    })
    .await
}

#[tauri::command]
async fn ads_monitor_stop(state: State<'_, AppState>) -> Result<(), String> {
    let proc = state.alerts.monitor.clone();
    blocking(move || proc.stop()).await
}

#[tauri::command]
fn ads_link_status(state: State<'_, AppState>) -> alerts::ProcStatus {
    state.alerts.link.status()
}

#[tauri::command]
async fn ads_wa_link_start(app: AppHandle, state: State<'_, AppState>, phone: String) -> Result<(), String> {
    let settings = state.current();
    let alerts = state.alerts.clone();
    let emit = event_emitter(&app);
    blocking(move || alerts.start_link(&settings, &phone, emit).map(|_| ())).await
}

#[tauri::command]
async fn ads_wa_link_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let proc = state.alerts.link.clone();
    blocking(move || proc.stop()).await
}

/// Copies the standalone monitor's WhatsApp session into the app data dir (the original stays untouched).
#[tauri::command]
async fn ads_wa_import_session(state: State<'_, AppState>, overwrite: bool) -> Result<usize, String> {
    let settings = state.current();
    let root = state.root.clone();
    let alerts = state.alerts.clone();
    blocking(move || {
        if alerts.monitor.is_running() || alerts.link.is_running() {
            return Err("Detén el monitor y la vinculación antes de importar la sesión.".to_string());
        }
        alerts::import_session(&root, &alerts::session_dir(&settings), overwrite)
    })
    .await
}

/// Only whether a token exists; the value never reaches the UI.
#[tauri::command]
async fn ads_token_status() -> Result<bool, String> {
    blocking(ads::token_present).await
}

#[tauri::command]
async fn ads_token_set(token: String) -> Result<(), String> {
    blocking(move || ads::set_token(&token)).await
}

#[tauri::command]
async fn ads_token_clear() -> Result<(), String> {
    blocking(ads::clear_token).await
}

#[tauri::command]
async fn ads_token_test(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::test_token(&settings)).await
}

#[tauri::command]
async fn ads_token_import_from_monitor(state: State<'_, AppState>) -> Result<(), String> {
    let root = state.root.clone();
    blocking(move || ads::import_from_monitor(&root)).await
}

#[tauri::command]
fn warmup_status(state: State<'_, AppState>) -> warmup::Status {
    state.runner.status()
}

#[tauri::command]
async fn start_profile(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<warmup::Status, String> {
    let settings = state.current();
    let runner = state.runner.clone();
    blocking(move || runner.start(&app, &settings, &name)).await
}

#[tauri::command]
async fn stop_profile(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let runner = state.runner.clone();
    blocking(move || runner.stop(&app)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = settings::find_project_root();
            let settings_file = app.path().app_config_dir()?.join("settings.json");
            let settings = Settings::load(&settings_file, &root);
            applog::set_data_dir(Path::new(&settings.data_dir));
            applog::install_panic_hook();
            applog::log("start", &format!("agentAutoX1 {} pid {}", env!("CARGO_PKG_VERSION"), std::process::id()));
            let last_on_file = app.path().app_config_dir()?.join("pods-last-on.json");
            let notifier = app.handle().clone();
            let keepalive = Arc::new(keepalive::Scheduler::new(
                keepalive::Config::default(),
                Box::new(move |status| {
                    let _ = notifier.emit("keepalive-status", status);
                }),
            ));
            keepalive.set_enabled(settings.keep_alive);
            let settings = Arc::new(Mutex::new(settings));
            let pod_job = pods::PodJob::default();
            let keep_stop = Arc::new(AtomicBool::new(false));
            keepalive_real::spawn_loop(
                keepalive.clone(),
                Arc::new(keepalive_real::RealHost {
                    settings: settings.clone(),
                    pod_job: pod_job.clone(),
                    state_file: last_on_file.clone(),
                    stop: keep_stop.clone(),
                }),
            );
            ads::spawn_scheduler(app.handle().clone(), settings.clone(), keep_stop.clone());
            app.manage(AppState {
                root,
                settings_file,
                settings,
                runner: warmup::Runner::default(),
                pull: ai::PullJob::default(),
                pod_job,
                link_cancel: Arc::new(AtomicBool::new(false)),
                keepalive,
                keep_stop,
                last_on_file,
                embedder: Mutex::new(None),
                alerts: alerts::Alerts::default(),
                agents: agents::Agents::default(),
            });
            spawn_embed_watchdog(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // An owned BlueStacks window does not travel with the app window: keep it glued to its placeholder.
            // This handler runs on the UI thread: the Win32 calls go to a worker, coalescing the burst of events a drag makes.
            if let tauri::WindowEvent::Moved(_) = event {
                let state = window.state::<AppState>();
                let embedder = crate::util::lock(&state.embedder).clone();
                if let Some(embedder) = embedder {
                    if !FOLLOW_PENDING.swap(true, Ordering::SeqCst) {
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(30));
                            FOLLOW_PENDING.store(false, Ordering::SeqCst);
                            embedder.follow();
                        });
                    }
                }
            }
            // Never leave a warm-up profile orphaned when the window is closed.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                // A pod turned on by the keep-alive check must be turned off before the app goes away.
                // Embedded BlueStacks windows must go back to top level or they would die with the app window.
                if let Some(embedder) = crate::util::lock(&state.embedder).take() {
                    embedder.detach_all();
                }
                state.keep_stop.store(true, Ordering::SeqCst);
                // The alerts monitor and the WhatsApp linking close their session cleanly (their own pid only).
                let mut procs = vec![state.alerts.monitor.clone(), state.alerts.link.clone()];
                procs.extend(state.agents.all_procs());
                for proc in &procs {
                    if proc.is_running() {
                        let _ = proc.stop();
                    }
                }
                for _ in 0..90 {
                    if state.keepalive.status().phase == keepalive::Phase::Idle {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                if state.runner.status().running {
                    let _ = state.runner.stop(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            log_client_error,
            get_settings,
            get_default_settings,
            save_settings,
            list_pods,
            pod_action,
            create_pod,
            rename_pod,
            set_pod_phone,
            delete_pod,
            profiles_overview,
            registry_overview,
            profile_create,
            profile_update,
            profile_delete,
            profile_set_group,
            line_health,
            plan_pod_links,
            run_pod_links,
            cancel_pod_links,
            keepalive_status,
            set_keep_alive,
            set_embed_view,
            embed_attach,
            embed_state,
            embed_retry,
            embed_resize,
            embed_activate,
            embed_detach,
            read_warmup_data,
            read_pods_wsp,
            warmup_status,
            start_profile,
            stop_profile,
            ai_call,
            ai_key_status,
            ai_key_set,
            ai_key_clear,
            ai_pull_start,
            ai_pull_cancel,
            ollama_installed,
            ollama_install,
            ollama_launch,
            ads_sync,
            ads_report,
            ads_vouchers,
            ads_sync_auto,
            ads_tracking,
            ads_comprobante_country,
            ads_comprobante_accept,
            ads_status,
            ads_config_get,
            ads_config_set,
            ads_decisions,
            ads_alerts_config_get,
            ads_alerts_config_set,
            ads_alerts_recent,
            ads_wa_status,
            ads_monitor_conflict,
            ads_monitor_status,
            ads_monitor_start,
            ads_monitor_stop,
            ads_link_status,
            ads_wa_link_start,
            ads_wa_link_cancel,
            ads_wa_import_session,
            ads_decision_status,
            ads_tick_now,
            ads_token_status,
            ads_token_set,
            ads_token_clear,
            ads_token_test,
            ads_token_import_from_monitor,
            voices_call,
            voices_key_status,
            voices_key_set,
            voices_key_clear,
            agent_call,
            agent_start,
            agent_cancel,
            agent_status,
            analista_call,
            analista_start,
            analista_cancel,
            analista_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
