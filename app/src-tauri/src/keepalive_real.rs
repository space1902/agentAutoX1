//! Real host for the keep-alive scheduler: pod listing/power through `pods.ps1`, the global pod-job slot, free memory
//! from Windows, the last-on JSON file and the background loop. The decisions live in `keepalive.rs`.

use crate::keepalive::{Clock, KeepOps, LastOnState, SCAN_SECS, Scheduler, observe_running};
use crate::pods::{self, Pod, PodJob};
use crate::settings::Settings;
use std::any::Any;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct RealClock;

impl Clock for RealClock {
    fn now(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
    }
    fn sleep(&self, secs: i64) {
        std::thread::sleep(Duration::from_secs(secs.max(0) as u64));
    }
}

/// Reads the last-on file; a missing or broken file is an empty state (never an error).
pub fn load_state(file: &Path) -> LastOnState {
    fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()).unwrap_or_default()
}

/// Atomic write (temp file + rename) so a crash never leaves half a JSON.
pub fn save_state(file: &Path, state: &LastOnState) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, file).map_err(|e| e.to_string())
}

/// Called whenever the app lists pods: every running pod counts as "seen on now".
pub fn record_running(file: &Path, pods: &[Pod]) {
    let mut state = load_state(file);
    if observe_running(&mut state, pods, RealClock.now()) {
        let _ = save_state(file, &state);
    }
}

#[cfg(windows)]
mod mem {
    #[repr(C)]
    pub struct MemoryStatusEx {
        pub length: u32,
        pub memory_load: u32,
        pub total_phys: u64,
        pub avail_phys: u64,
        pub total_page_file: u64,
        pub avail_page_file: u64,
        pub total_virtual: u64,
        pub avail_virtual: u64,
        pub avail_extended_virtual: u64,
    }
    unsafe extern "system" {
        pub fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
}

/// Free physical memory in MB.
#[cfg(windows)]
pub fn available_memory_mb() -> Option<u64> {
    let mut status = mem::MemoryStatusEx {
        length: std::mem::size_of::<mem::MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // SAFETY: `status` is a correctly sized, initialised MEMORYSTATUSEX and `length` is set as the API requires.
    let ok = unsafe { mem::GlobalMemoryStatusEx(&mut status) };
    (ok != 0).then(|| status.avail_phys / (1024 * 1024))
}

#[cfg(not(windows))]
pub fn available_memory_mb() -> Option<u64> {
    None
}

pub struct RealHost {
    pub settings: Arc<Mutex<Settings>>,
    pub pod_job: PodJob,
    pub state_file: PathBuf,
    pub stop: Arc<AtomicBool>,
}

impl RealHost {
    fn current(&self) -> Settings {
        crate::util::lock(&self.settings).clone()
    }
}

impl KeepOps for RealHost {
    fn enabled(&self) -> bool {
        crate::util::lock(&self.settings).keep_alive
    }
    fn should_stop(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    fn list(&self) -> Result<Vec<Pod>, String> {
        pods::list(&self.current())
    }
    fn power_on(&self, name: &str) -> Result<(), String> {
        pods::run_action(&self.current(), "prender", name).map(|_| ())
    }
    fn power_off(&self, name: &str) -> Result<(), String> {
        pods::run_action(&self.current(), "apagar", name).map(|_| ())
    }
    fn try_begin_job(&self, what: &str) -> Option<Box<dyn Any>> {
        self.pod_job.begin(what).ok().map(|guard| Box::new(guard) as Box<dyn Any>)
    }
    fn available_memory_mb(&self) -> Option<u64> {
        available_memory_mb()
    }
    fn load_state(&self) -> LastOnState {
        load_state(&self.state_file)
    }
    fn save_state(&self, state: &LastOnState) {
        let _ = save_state(&self.state_file, state);
    }
}

/// Background loop: once the feature is ON it scans right away and then every 30 minutes (or 2 minutes after a scan
/// that had to skip a pod because another pod operation was running). Stops when `host.stop` is set.
pub fn spawn_loop(scheduler: Arc<Scheduler>, host: Arc<RealHost>) {
    std::thread::spawn(move || {
        let clock = RealClock;
        let mut next_scan = 0i64;
        while !host.should_stop() {
            if host.enabled() {
                if clock.now() >= next_scan {
                    // A panic must not kill this thread (the card would stay "en curso" for good and no scan would
                    // ever run again): it is reported on the card and the loop goes on.
                    let scan = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| scheduler.scan(host.as_ref(), &clock)));
                    if scan.is_err() {
                        crate::applog::log("keepalive", "La revisión de pods terminó con un error interno; se reintentará en la próxima.");
                        scheduler.recover_from_panic();
                    }
                    scheduler.finish_if_stuck();
                    let busy = scheduler.status().last_run.is_some_and(|r| r.outcome == "skipped" && r.note.starts_with("Hay otra operación"));
                    next_scan = clock.now() + if busy { 120 } else { SCAN_SECS };
                }
            } else {
                next_scan = 0;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("agentautox1-keepalive-{}-{name}", std::process::id()))
    }

    #[test]
    fn state_file_round_trips_and_a_broken_file_reads_as_empty() {
        let file = temp_file("state.json");
        let mut state = LastOnState::default();
        state.last_on.insert("Rvc64_1".into(), 123);
        save_state(&file, &state).unwrap();
        assert_eq!(load_state(&file), state);
        assert!(!file.with_extension("json.tmp").exists(), "no temp file left behind");

        fs::write(&file, "{not json").unwrap();
        assert_eq!(load_state(&file), LastOnState::default());
        let _ = fs::remove_file(&file);
        assert_eq!(load_state(&file), LastOnState::default());
    }

    #[test]
    fn record_running_stores_only_running_pods() {
        let file = temp_file("record.json");
        let _ = fs::remove_file(&file);
        let pods = vec![
            Pod { name: "a".into(), instance_id: "Rvc64_a".into(), state: "running".into(), serial: None, adb_port: 1, phone: None },
            Pod { name: "b".into(), instance_id: "Rvc64_b".into(), state: "stopped".into(), serial: None, adb_port: 2, phone: None },
        ];
        record_running(&file, &pods);
        let state = load_state(&file);
        assert!(state.last_on.contains_key("Rvc64_a"));
        assert!(!state.last_on.contains_key("Rvc64_b"));
        let _ = fs::remove_file(&file);
    }

    #[cfg(windows)]
    #[test]
    fn reads_a_plausible_amount_of_free_memory() {
        let mb = available_memory_mb().expect("GlobalMemoryStatusEx works on Windows");
        assert!(mb > 64, "free memory looks wrong: {mb} MB");
    }
}
