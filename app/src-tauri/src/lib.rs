mod data;
mod pods;
mod settings;
mod util;
mod warmup;

use settings::Settings;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

struct AppState {
    root: PathBuf,
    settings_file: PathBuf,
    settings: Arc<Mutex<Settings>>,
    runner: warmup::Runner,
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
    blocking(move || pods::run_action(&settings, &action, &name)).await
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
            read_warmup_data,
            read_pods_wsp,
            warmup_status,
            start_profile,
            stop_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
