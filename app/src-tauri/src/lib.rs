mod ads;
mod ai;
mod data;
mod embed;
mod linker;
mod keepalive;
mod keepalive_real;
mod linker_real;
mod pods;
mod profiles;
mod settings;
mod util;
mod pairing;
mod warmup;

use serde::Serialize;
use serde_json::{Value, json};
use settings::Settings;
use std::collections::BTreeMap;
use std::path::PathBuf;
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
        self.settings.lock().unwrap().clone()
    }
}

/// Runs blocking work (PowerShell, file IO, waits) off the async runtime threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
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
    *state.settings.lock().unwrap() = merged.clone();
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
    *state.settings.lock().unwrap() = next;
    state.keepalive.set_enabled(enabled);
    Ok(state.keepalive.status())
}

// ---------- embedded BlueStacks view (experimental, behind settings.embedView) ----------

/// The embedder is created on first use, parented to the main window.
fn embedder_for(window: &tauri::WebviewWindow, state: &AppState) -> Result<Arc<embed::Embedder<embed::win::RealWin>>, String> {
    if !state.current().embed_view {
        return Err("La vista embebida está desactivada (función experimental).".into());
    }
    let mut slot = state.embedder.lock().unwrap();
    if let Some(existing) = slot.as_ref() {
        return Ok(existing.clone());
    }
    let hwnd = window.hwnd().map_err(|e| format!("No se pudo obtener la ventana de la app: {e}"))?;
    let created = Arc::new(embed::Embedder::new(embed::win::RealWin::default(), hwnd.0 as isize));
    *slot = Some(created.clone());
    Ok(created)
}

#[tauri::command]
fn set_embed_view(state: State<'_, AppState>, enabled: bool) -> Result<Settings, String> {
    let mut next = state.current();
    next.embed_view = enabled;
    next.save(&state.settings_file)?;
    *state.settings.lock().unwrap() = next.clone();
    if !enabled {
        if let Some(embedder) = state.embedder.lock().unwrap().take() {
            embedder.detach_all();
        }
    }
    Ok(next)
}

/// Shows the pod's BlueStacks window in its stage (CSS pixels + devicePixelRatio): the stage is the FULL box, even the
/// part scrolled out of view; `view_*` is the visible webview, which the native window is clipped to.
#[tauri::command]
async fn embed_attach(window: tauri::WebviewWindow, state: State<'_, AppState>, name: String, x: f64, y: f64, width: f64, height: f64, view_width: f64, view_height: f64, dpr: f64) -> Result<embed::EmbedState, String> {
    if !util::is_valid_pod_name(&name) {
        return Err(format!("Nombre de pod no válido: {name}"));
    }
    let embedder = embedder_for(&window, &state)?;
    blocking(move || {
        embedder.set_viewport(embed::scale_rect(0.0, 0.0, view_width, view_height, dpr));
        embedder.attach(&name, embed::scale_rect(x, y, width, height, dpr))?;
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
async fn ads_report(state: State<'_, AppState>, from: String, to: String, group: String) -> Result<Value, String> {
    let settings = state.current();
    blocking(move || ads::report(&settings, &from, &to, &group)).await
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
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // An owned BlueStacks window does not travel with the app window: keep it glued to its placeholder.
            if let tauri::WindowEvent::Moved(_) = event {
                let state = window.state::<AppState>();
                let embedder = state.embedder.lock().unwrap().clone();
                if let Some(embedder) = embedder {
                    embedder.follow();
                }
            }
            // Never leave a warm-up profile orphaned when the window is closed.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                // A pod turned on by the keep-alive check must be turned off before the app goes away.
                // Embedded BlueStacks windows must go back to top level or they would die with the app window.
                if let Some(embedder) = state.embedder.lock().unwrap().take() {
                    embedder.detach_all();
                }
                state.keep_stop.store(true, Ordering::SeqCst);
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
            ads_status,
            ads_config_get,
            ads_config_set,
            ads_token_status,
            ads_token_set,
            ads_token_clear,
            ads_token_test,
            ads_token_import_from_monitor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
