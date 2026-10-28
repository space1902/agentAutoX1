mod data;
mod pods;
mod profiles;
mod settings;
mod util;
mod warmup;

use serde::Serialize;
use serde_json::{Value, json};
use settings::Settings;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    root: PathBuf,
    settings_file: PathBuf,
    settings: Arc<Mutex<Settings>>,
    runner: warmup::Runner,
    pod_job: pods::PodJob,
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
    let merged = Settings::merge_saved(&state.root, &serde_json::to_value(&settings).map_err(|e| e.to_string())?);
    merged.save(&state.settings_file)?;
    *state.settings.lock().unwrap() = merged.clone();
    Ok(merged)
}

#[tauri::command]
async fn list_pods(state: State<'_, AppState>) -> Result<Vec<pods::Pod>, String> {
    let settings = state.current();
    blocking(move || pods::list(&settings)).await
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

#[tauri::command]
fn read_warmup_data(state: State<'_, AppState>) -> Result<data::WarmupData, String> {
    data::read_warmup(&state.current())
}

#[tauri::command]
fn read_pods_wsp(state: State<'_, AppState>) -> Result<BTreeMap<String, String>, String> {
    data::read_pods_wsp(&state.current())
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
            app.manage(AppState {
                root,
                settings_file,
                settings: Arc::new(Mutex::new(settings)),
                runner: warmup::Runner::default(),
                pod_job: pods::PodJob::default(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Never leave a warm-up profile orphaned when the window is closed.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
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
            read_warmup_data,
            read_pods_wsp,
            warmup_status,
            start_profile,
            stop_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
