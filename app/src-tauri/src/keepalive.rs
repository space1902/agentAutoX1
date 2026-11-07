//! "Auto revisión de números en los pods": WhatsApp unlinks devices that stay off too long, so when this is ON every
//! pod that has been off for longer than the chosen interval (4/6/8/12/24 h, default 6) is turned on for ~15 minutes, then off again, ONE pod at a time.
//!
//! The decisions live here and run against `KeepOps` + `Clock` (fake clock in the tests):
//!   - `observe_running` / `due_pods`: the per-pod "last time it was on" bookkeeping and the queue.
//!   - `Scheduler::scan`: build the queue and process it sequentially.
//!   - `Scheduler::check_pod`: on -> hold -> off -> wait until the BlueStacks process is gone and memory is free.
//! Real PowerShell/process/memory access is in `keepalive_real.rs`.

use crate::pods::Pod;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const HOLD_SECS: i64 = 15 * 60;
/// How often WhatsApp is brought to the foreground while a pod is on.
pub const WA_CHECK_SECS: i64 = 5 * 60;
pub const SCAN_SECS: i64 = 30 * 60;

/// Last moment each pod was seen on (unix seconds), keyed by BlueStacks instance id so renames do not lose it.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LastOnState {
    #[serde(default)]
    pub last_on: BTreeMap<String, i64>,
}

/// Records every running pod as seen on at `now`. Returns true when the state changed.
pub fn observe_running(state: &mut LastOnState, pods: &[Pod], now: i64) -> bool {
    let mut changed = false;
    for pod in pods.iter().filter(|p| p.state == "running") {
        if state.last_on.get(&pod.instance_id) != Some(&now) {
            state.last_on.insert(pod.instance_id.clone(), now);
            changed = true;
        }
    }
    changed
}

/// Stopped pods with a phone number that were last on more than `threshold` ago, oldest first.
/// A pod we never saw on counts as the oldest (the app cannot know how long it has been off).
pub fn due_pods(state: &LastOnState, pods: &[Pod], now: i64, threshold: i64) -> Vec<Pod> {
    let mut due: Vec<(i64, Pod)> = pods
        .iter()
        .filter(|p| p.state != "running" && p.phone.as_deref().is_some_and(|ph| !ph.trim().is_empty()))
        .filter_map(|p| match state.last_on.get(&p.instance_id) {
            Some(&at) if now - at <= threshold => None,
            Some(&at) => Some((at, p.clone())),
            None => Some((i64::MIN, p.clone())),
        })
        .collect();
    due.sort_by_key(|(at, pod)| (*at, pod.name.clone()));
    due.into_iter().map(|(_, p)| p).collect()
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    #[default]
    Idle,
    Scanning,
    PoweringOn,
    Holding,
    PoweringOff,
    WaitingExit,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub pod: String,
    pub at: i64,
    /// "ok" | "skipped" | "failed" | "interrupted"
    pub outcome: String,
    pub note: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeepAliveStatus {
    pub enabled: bool,
    pub phase: Phase,
    pub current: Option<String>,
    /// Hours a pod may stay off before it is cycled (mirror of the setting).
    pub interval_hours: u32,
    /// Unix second when the current pod will be turned off (only while holding).
    pub hold_until: Option<i64>,
    pub queue: Vec<String>,
    pub last_run: Option<LastRun>,
    pub last_scan_at: Option<i64>,
    pub message: String,
}

pub trait Clock {
    fn now(&self) -> i64;
    fn sleep(&self, secs: i64);
}

pub trait KeepOps {
    fn enabled(&self) -> bool;
    /// The app is closing: finish what is on and stop.
    fn should_stop(&self) -> bool;
    fn list(&self) -> Result<Vec<Pod>, String>;
    fn power_on(&self, name: &str) -> Result<(), String>;
    fn power_off(&self, name: &str) -> Result<(), String>;
    /// Brings WhatsApp to the foreground in the pod (pods.ps1 `abrir-wa`).
    fn ensure_whatsapp(&self, name: &str) -> Result<(), String>;
    /// Hours a pod may stay off before it is cycled; read at every scan.
    fn interval_hours(&self) -> u32;
    /// Takes the global pod-job slot (create/rename/delete/phone/link). None when something else is running.
    fn try_begin_job(&self, what: &str) -> Option<Box<dyn Any>>;
    fn available_memory_mb(&self) -> Option<u64>;
    fn load_state(&self) -> LastOnState;
    fn save_state(&self, state: &LastOnState);
}

#[derive(Clone, Debug)]
pub struct Config {
    pub hold_secs: i64,
    /// How long to wait for the BlueStacks process to disappear and memory to come back after turning a pod off.
    pub exit_timeout_secs: i64,
    /// Memory may stay this far below the level measured before the pod was turned on.
    pub memory_tolerance_mb: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config { hold_secs: HOLD_SECS, exit_timeout_secs: 120, memory_tolerance_mb: 400 }
    }
}

type Notify = Box<dyn Fn(&KeepAliveStatus) + Send + Sync>;

pub struct Scheduler {
    status: Arc<Mutex<KeepAliveStatus>>,
    config: Config,
    notify: Notify,
    /// Bumped by `reset`: a scan or check that started before the bump stops at its next step.
    epoch: AtomicU64,
}

impl Scheduler {
    pub fn new(config: Config, notify: Notify) -> Scheduler {
        Scheduler { status: Arc::new(Mutex::new(KeepAliveStatus::default())), config, notify, epoch: AtomicU64::new(0) }
    }

    pub fn status(&self) -> KeepAliveStatus {
        crate::util::lock(&self.status).clone()
    }

    /// "Reiniciar pods": whatever scan or check is running stops at its next step WITHOUT touching any pod (the reset
    /// itself stops them), the queue is dropped and the card goes back to idle. The next scan runs on its normal
    /// schedule.
    pub fn reset(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.update(|s| {
            s.phase = Phase::Idle;
            s.current = None;
            s.hold_until = None;
            s.queue.clear();
            s.message = "Se reinició a mano; la revisión sigue en su horario normal.".into();
        });
    }

    /// The scan thread crashed: never leave the card "en curso" for a job that no longer exists.
    pub fn recover_from_panic(&self) {
        self.update(|s| {
            s.phase = Phase::Idle;
            s.current = None;
            s.hold_until = None;
            s.queue.clear();
            s.message = "La revisión se interrumpió por un error interno; se intentará en la próxima.".into();
        });
    }

    /// Safety net after every scan: a finished scan is always idle. Anything else is a stale "en curso".
    pub fn finish_if_stuck(&self) {
        if self.status().phase != Phase::Idle {
            self.recover_from_panic();
        }
    }

    fn aborted(&self, started: u64) -> bool {
        self.epoch.load(Ordering::SeqCst) != started
    }

    fn update(&self, change: impl FnOnce(&mut KeepAliveStatus)) {
        let snapshot = {
            let mut s = crate::util::lock(&self.status);
            change(&mut s);
            s.clone()
        };
        (self.notify)(&snapshot);
    }

    pub fn set_interval_hours(&self, hours: u32) {
        self.update(|s| s.interval_hours = hours);
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.update(|s| {
            s.enabled = enabled;
            if !enabled && s.phase == Phase::Idle {
                s.queue.clear();
                s.message = "Desactivada.".into();
            }
        });
    }

    /// One pass: record the running pods, build the queue of due pods and process it, one pod at a time.
    pub fn scan(&self, ops: &dyn KeepOps, clock: &dyn Clock) {
        let started = self.epoch.load(Ordering::SeqCst);
        let hours = ops.interval_hours();
        self.update(|s| {
            s.phase = Phase::Scanning;
            s.interval_hours = hours;
            s.message = format!("Revisando qué pods llevan más de {hours} horas apagados…");
        });
        let pods = match ops.list() {
            Ok(p) => p,
            Err(e) => {
                self.update(|s| {
                    s.phase = Phase::Idle;
                    s.message = format!("No se pudo leer la lista de pods: {e}");
                });
                return;
            }
        };

        if self.aborted(started) {
            return;
        }
        let now = clock.now();
        let mut state = ops.load_state();
        if observe_running(&mut state, &pods, now) {
            ops.save_state(&state);
        }
        let due = due_pods(&state, &pods, now, hours as i64 * 3600);
        let names: Vec<String> = due.iter().map(|p| p.name.clone()).collect();
        if self.aborted(started) {
            return;
        }
        self.update(|s| {
            s.queue = names.clone();
            s.last_scan_at = Some(now);
            s.message = if names.is_empty() { "Todos los pods están al día.".into() } else { format!("{} pod(s) por revisar.", names.len()) };
            s.phase = Phase::Idle;
        });

        for pod in due {
            if !ops.enabled() || ops.should_stop() || self.aborted(started) {
                break;
            }
            let run = self.check_pod(ops, clock, &pod);
            if self.aborted(started) {
                return; // reset: the card already shows idle
            }
            self.update(|s| {
                s.queue.retain(|n| n != &pod.name);
                s.last_run = Some(run);
            });
        }
        if self.aborted(started) {
            return;
        }
        self.update(|s| {
            s.phase = Phase::Idle;
            s.current = None;
            s.hold_until = None;
            s.queue.clear();
            if s.message.is_empty() || s.message.contains("por revisar") {
                s.message = "Revisión terminada.".into();
            }
        });
    }

    fn run_record(&self, clock: &dyn Clock, pod: &Pod, outcome: &str, note: impl Into<String>) -> LastRun {
        LastRun { pod: pod.name.clone(), at: clock.now(), outcome: outcome.into(), note: note.into() }
    }

    /// Power on, keep on for `hold_secs`, power off, wait until the process is gone and memory is free.
    pub fn check_pod(&self, ops: &dyn KeepOps, clock: &dyn Clock, pod: &Pod) -> LastRun {
        let name = pod.name.as_str();
        let started = self.epoch.load(Ordering::SeqCst);

        // Somebody may have turned it on (or it may be gone) since the queue was built.
        let fresh = match ops.list() {
            Ok(list) => list.into_iter().find(|p| p.instance_id == pod.instance_id),
            Err(e) => return self.run_record(clock, pod, "failed", format!("No se pudo leer el estado: {e}")),
        };
        let Some(fresh) = fresh else { return self.run_record(clock, pod, "skipped", "El pod ya no existe.") };
        if fresh.state == "running" {
            let mut state = ops.load_state();
            state.last_on.insert(pod.instance_id.clone(), clock.now());
            ops.save_state(&state);
            return self.run_record(clock, pod, "skipped", "Ya estaba encendido (en uso): solo se anotó su última vez encendido.");
        }

        let Some(_job) = ops.try_begin_job(&format!("revisión de {name}")) else {
            return self.run_record(clock, pod, "skipped", "Hay otra operación de pods en curso; se intentará en la próxima revisión.");
        };

        let baseline = ops.available_memory_mb();
        self.update(|s| {
            s.phase = Phase::PoweringOn;
            s.current = Some(name.to_string());
            s.hold_until = None;
            s.message = format!("Encendiendo {name}…");
        });

        let powered = ops.power_on(name);
        if self.aborted(started) {
            return self.run_record(clock, pod, "interrupted", "Se reinició a mano durante el encendido.");
        }
        let mut state = ops.load_state();
        if powered.is_ok() {
            state.last_on.insert(pod.instance_id.clone(), clock.now());
            ops.save_state(&state);
        }
        let mut failure = powered.err().map(|e| format!("No se pudo encender: {e}"));
        let mut interrupted = false;
        let mut wa_issue: Option<String> = None;

        if failure.is_none() {
            let until = clock.now() + self.config.hold_secs;
            self.update(|s| {
                s.phase = Phase::Holding;
                s.hold_until = Some(until);
                s.message = format!("Revisando {name}: se mantiene encendido unos minutos.");
            });
            let mut next_wa_check = clock.now();
            while clock.now() < until {
                if !ops.enabled() || ops.should_stop() {
                    interrupted = true;
                    break;
                }
                if self.aborted(started) {
                    return self.run_record(clock, pod, "interrupted", "Se reinició a mano durante la revisión.");
                }
                if clock.now() >= next_wa_check {
                    // A failed check never aborts the cycle: it is recorded and the pod is still powered off at the end.
                    match ops.ensure_whatsapp(name) {
                        Ok(()) => wa_issue = None,
                        Err(_) => {
                            let issue = format!("WhatsApp no abrió en {name}");
                            wa_issue = Some(issue.clone());
                            self.update(|s| s.message = format!("{issue}; se reintentará en unos minutos."));
                        }
                    }
                    next_wa_check = clock.now() + WA_CHECK_SECS;
                    continue;
                }
                clock.sleep(1);
            }
        }

        self.update(|s| {
            s.phase = Phase::PoweringOff;
            s.hold_until = None;
            s.message = format!("Apagando {name}…");
        });
        let visited = failure.is_none();
        let off = ops.power_off(name);
        if visited {
            // It was on until now: that is its last time on.
            state.last_on.insert(pod.instance_id.clone(), clock.now());
            ops.save_state(&state);
        }
        if let Err(e) = off {
            failure.get_or_insert(format!("No se pudo apagar: {e}"));
        }

        let waited = self.wait_until_released(ops, clock, pod, baseline, started);

        let (outcome, note) = match (failure, interrupted) {
            (Some(note), _) => ("failed", note),
            (None, true) => ("interrupted", format!("Se apagó antes de tiempo. {waited}")),
            (None, false) => ("ok", format!("Revisado: estuvo encendido {} min. {waited}", self.config.hold_secs / 60)),
        };
        let note = match wa_issue {
            Some(issue) => format!("{} {issue}.", note.trim()),
            None => note,
        };
        self.run_record(clock, pod, outcome, note.trim().to_string())
    }

    /// Waits until the pod reads as stopped and the free memory is back near its level before the pod started.
    fn wait_until_released(&self, ops: &dyn KeepOps, clock: &dyn Clock, pod: &Pod, baseline: Option<u64>, started: u64) -> String {
        self.update(|s| {
            s.phase = Phase::WaitingExit;
            s.message = format!("Esperando a que {} libere la memoria…", pod.name);
        });
        let deadline = clock.now() + self.config.exit_timeout_secs;
        loop {
            let stopped = ops.list().map(|l| l.iter().any(|p| p.instance_id == pod.instance_id && p.state != "running")).unwrap_or(false);
            let memory_ok = match (baseline, ops.available_memory_mb()) {
                (Some(before), Some(now)) => now + self.config.memory_tolerance_mb >= before,
                _ => true,
            };
            if self.aborted(started) {
                return "Se reinició a mano.".into();
            }
            if stopped && memory_ok {
                return "Proceso cerrado y memoria liberada.".into();
            }
            if clock.now() >= deadline {
                return if stopped {
                    "El proceso cerró, pero la memoria tardó en liberarse (se siguió igual).".into()
                } else {
                    "El pod seguía figurando como encendido al terminar la espera.".into()
                };
            }
            clock.sleep(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    fn pod(name: &str, running: bool, phone: Option<&str>) -> Pod {
        Pod {
            name: name.into(),
            instance_id: format!("Rvc64_{name}"),
            state: if running { "running" } else { "stopped" }.into(),
            serial: running.then(|| "emulator-5564".to_string()),
            adb_port: 5565,
            phone: phone.map(str::to_string),
        }
    }

    const H: i64 = 3600;

    // ----- pure bookkeeping -----

    #[test]
    fn running_pods_are_recorded_as_seen_now() {
        let mut state = LastOnState::default();
        let pods = vec![pod("a", true, Some("1")), pod("b", false, Some("2"))];
        assert!(observe_running(&mut state, &pods, 1000));
        assert_eq!(state.last_on.get("Rvc64_a"), Some(&1000));
        assert!(!state.last_on.contains_key("Rvc64_b"));
        assert!(!observe_running(&mut state, &pods, 1000), "same second: no change");
    }

    #[test]
    fn due_pods_are_stopped_with_a_phone_and_older_than_the_threshold_oldest_first() {
        let mut state = LastOnState::default();
        state.last_on.insert("Rvc64_old".into(), 100 * H - 50 * H);
        state.last_on.insert("Rvc64_older".into(), 100 * H - 90 * H);
        state.last_on.insert("Rvc64_fresh".into(), 100 * H - 5 * H);
        state.last_on.insert("Rvc64_edge".into(), 100 * H - 24 * H); // exactly 24 h: not yet
        state.last_on.insert("Rvc64_running".into(), 0);
        let pods = vec![
            pod("old", false, Some("1")),
            pod("older", false, Some("2")),
            pod("fresh", false, Some("3")),
            pod("edge", false, Some("4")),
            pod("running", true, Some("5")),
            pod("nophone", false, None),
            pod("blankphone", false, Some("  ")),
            pod("unknown", false, Some("6")),
        ];
        let names: Vec<String> = due_pods(&state, &pods, 100 * H, 24 * H).into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["unknown", "older", "old"], "never-seen first, then the oldest");
    }

    #[test]
    fn state_round_trips_as_camel_case_json_and_tolerates_missing_fields() {
        let mut state = LastOnState::default();
        state.last_on.insert("Rvc64_1".into(), 42);
        let text = serde_json::to_string(&state).unwrap();
        assert!(text.contains("lastOn"));
        assert_eq!(serde_json::from_str::<LastOnState>(&text).unwrap(), state);
        assert_eq!(serde_json::from_str::<LastOnState>("{}").unwrap(), LastOnState::default());
    }

    // ----- scheduler against a fake pod host and a fake clock -----

    struct FakeClock(Cell<i64>);
    impl Clock for FakeClock {
        fn now(&self) -> i64 {
            self.0.get()
        }
        fn sleep(&self, secs: i64) {
            self.0.set(self.0.get() + secs);
        }
    }

    struct FakeHost<'a> {
        clock: &'a FakeClock,
        pods: RefCell<Vec<Pod>>,
        log: RefCell<Vec<String>>,
        state: RefCell<LastOnState>,
        enabled: Cell<bool>,
        stop: Cell<bool>,
        busy: Cell<bool>,
        power_on_error: RefCell<Option<String>>,
        /// Free memory readings; the last one repeats.
        memory: RefCell<Vec<u64>>,
        /// Seconds a pod keeps reading as running after power_off.
        exit_delay: Cell<i64>,
        /// (pod name, unix second until which it still reads as running)
        lingering: RefCell<Option<(String, i64)>>,
        disable_after: Cell<Option<i64>>,
        /// The scheduler under test and the second at which "Reiniciar pods" is pressed.
        sched: RefCell<Option<Rc<Scheduler>>>,
        reset_after: Cell<Option<i64>>,
        reset_on_power_on: Cell<bool>,
        wa_error: RefCell<Option<String>>,
        interval: Cell<u32>,
    }

    impl<'a> FakeHost<'a> {
        fn maybe_reset(&self) {
            if self.reset_after.get().is_some_and(|at| self.clock.now() >= at) {
                self.reset_after.set(None);
                self.press_reset();
            }
        }
        fn press_reset(&self) {
            if let Some(s) = self.sched.borrow().as_ref() {
                s.reset();
            }
        }
        fn new(clock: &'a FakeClock, pods: Vec<Pod>) -> FakeHost<'a> {
            FakeHost {
                clock,
                pods: RefCell::new(pods),
                log: RefCell::new(vec![]),
                state: RefCell::new(LastOnState::default()),
                enabled: Cell::new(true),
                stop: Cell::new(false),
                busy: Cell::new(false),
                power_on_error: RefCell::new(None),
                memory: RefCell::new(vec![8000]),
                exit_delay: Cell::new(0),
                lingering: RefCell::new(None),
                disable_after: Cell::new(None),
                sched: RefCell::new(None),
                reset_after: Cell::new(None),
                reset_on_power_on: Cell::new(false),
                wa_error: RefCell::new(None),
                interval: Cell::new(24),
            }
        }
        fn log(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
        fn set_state(&self, name: &str, running: bool) {
            for p in self.pods.borrow_mut().iter_mut().filter(|p| p.name == name) {
                p.state = if running { "running" } else { "stopped" }.into();
            }
        }
    }

    impl KeepOps for FakeHost<'_> {
        fn enabled(&self) -> bool {
            self.maybe_reset();
            if let Some(limit) = self.disable_after.get() {
                if self.clock.now() >= limit {
                    return false;
                }
            }
            self.enabled.get()
        }
        fn should_stop(&self) -> bool {
            self.stop.get()
        }
        fn list(&self) -> Result<Vec<Pod>, String> {
            self.maybe_reset();
            let mut pods = self.pods.borrow().clone();
            // A pod that was powered off keeps reading "running" until its process is gone.
            if let Some((name, until)) = self.lingering.borrow().clone() {
                if self.clock.now() < until {
                    pods.iter_mut().filter(|p| p.name == name).for_each(|p| p.state = "running".into());
                }
            }
            Ok(pods)
        }
        fn power_on(&self, name: &str) -> Result<(), String> {
            self.log.borrow_mut().push(format!("on:{name}@{}", self.clock.now()));
            if self.reset_on_power_on.get() {
                self.press_reset();
                return Err("PowerShell se canceló".into());
            }
            if let Some(e) = self.power_on_error.borrow().clone() {
                return Err(e);
            }
            self.set_state(name, true);
            self.clock.sleep(30); // Android boot
            Ok(())
        }
        fn power_off(&self, name: &str) -> Result<(), String> {
            self.log.borrow_mut().push(format!("off:{name}@{}", self.clock.now()));
            self.set_state(name, false);
            if self.exit_delay.get() > 0 {
                *self.lingering.borrow_mut() = Some((name.to_string(), self.clock.now() + self.exit_delay.get()));
            }
            Ok(())
        }
        fn ensure_whatsapp(&self, name: &str) -> Result<(), String> {
            self.log.borrow_mut().push(format!("wa:{name}@{}", self.clock.now()));
            self.wa_error.borrow().clone().map_or(Ok(()), Err)
        }
        fn interval_hours(&self) -> u32 {
            self.interval.get()
        }
        fn try_begin_job(&self, what: &str) -> Option<Box<dyn Any>> {
            if self.busy.get() {
                return None;
            }
            self.log.borrow_mut().push(format!("job:{what}"));
            Some(Box::new(()))
        }
        fn available_memory_mb(&self) -> Option<u64> {
            let mut m = self.memory.borrow_mut();
            if m.len() > 1 { Some(m.remove(0)) } else { m.first().copied() }
        }
        fn load_state(&self) -> LastOnState {
            self.state.borrow().clone()
        }
        fn save_state(&self, state: &LastOnState) {
            *self.state.borrow_mut() = state.clone();
        }
    }

    fn scheduler() -> Scheduler {
        Scheduler::new(Config { hold_secs: 15 * 60, exit_timeout_secs: 60, memory_tolerance_mb: 300 }, Box::new(|_| {}))
    }

    #[test]
    fn checking_a_pod_powers_on_holds_15_minutes_and_powers_off() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        let s = scheduler();
        let candidate = host.pods.borrow()[0].clone();
        let run = s.check_pod(&host, &clock, &candidate);

        assert_eq!(run.outcome, "ok", "{run:?}");
        let log = host.log();
        assert_eq!(log[0], "job:revisión de a");
        let on = 100 * H;
        assert_eq!(log[1], format!("on:a@{on}"));
        // Booting took 30 s, then 15 minutes hold.
        assert_eq!(log.last().unwrap(), &format!("off:a@{}", on + 30 + 15 * 60));
        assert_eq!(host.state.borrow().last_on["Rvc64_a"], on + 30 + 15 * 60, "last on = when it was turned off");
    }

    #[test]
    fn a_pod_that_is_already_on_is_not_touched_but_its_last_on_is_recorded() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", true, Some("3001112233"))]);
        let candidate = pod("a", false, Some("3001112233")); // the queue was built when it was off
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "skipped");
        assert!(run.note.contains("en uso"));
        assert!(host.log().is_empty(), "no job, no power calls");
        assert_eq!(host.state.borrow().last_on["Rvc64_a"], 100 * H);
    }

    #[test]
    fn a_running_pod_job_pauses_the_check() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        host.busy.set(true);
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "skipped");
        assert!(run.note.contains("otra operación"));
        assert!(host.log().is_empty());
        assert!(host.state.borrow().last_on.is_empty(), "untouched pods keep their old timestamp");
    }

    #[test]
    fn turning_the_feature_off_during_the_hold_powers_the_pod_off_right_away() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        host.disable_after.set(Some(100 * H + 30 + 120)); // two minutes into the hold
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "interrupted");
        assert!(host.log().iter().any(|l| l.starts_with("off:a@")));
        assert!(clock.now() < 100 * H + 30 + 15 * 60, "did not wait out the whole hold");
    }

    #[test]
    fn app_shutdown_during_the_hold_also_powers_off() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        host.stop.set(true);
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "interrupted");
        assert!(host.log().iter().any(|l| l.starts_with("off:a@")));
        assert!(clock.now() < 100 * H + 15 * 60, "did not wait out the hold");
    }

    #[test]
    fn a_failed_power_on_is_reported_and_the_pod_is_still_asked_to_stop() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        *host.power_on_error.borrow_mut() = Some("Android no arrancó".into());
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "failed");
        assert!(run.note.contains("Android no arrancó"));
        assert!(host.log().iter().any(|l| l.starts_with("off:a@")), "a half-started BlueStacks is closed");
        assert!(!host.state.borrow().last_on.contains_key("Rvc64_a"), "a failed check does not count as a visit");
    }

    #[test]
    fn it_waits_until_the_bluestacks_process_is_gone_before_the_next_pod() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        host.exit_delay.set(20);
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "ok");
        assert!(run.note.contains("Proceso cerrado"), "{}", run.note);
        let off_at = 100 * H + 30 + 15 * 60;
        assert!(clock.now() >= off_at + 20, "waited for the process to disappear");
    }

    #[test]
    fn it_gives_up_waiting_for_a_process_that_never_exits_but_says_so() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        host.exit_delay.set(10_000);
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert!(run.note.contains("seguía figurando como encendido"), "{}", run.note);
    }

    #[test]
    fn it_waits_for_the_memory_to_come_back_before_finishing() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        // baseline 8000, then the pod ate memory: 5000, 6000, finally 7800 (within 300 MB of the baseline).
        *host.memory.borrow_mut() = vec![8000, 5000, 6000, 7800];
        let before = clock.now();
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "ok");
        assert!(run.note.contains("memoria liberada"));
        assert!(clock.now() >= before + 30 + 15 * 60 + 4, "slept at least two polls waiting for memory");
    }

    #[test]
    fn if_memory_never_returns_it_gives_up_after_the_timeout_without_failing() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("3001112233"))]);
        *host.memory.borrow_mut() = vec![8000, 1000];
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "ok");
        assert!(run.note.contains("tardó en liberarse"));
    }

    #[test]
    fn a_scan_processes_the_queue_one_pod_at_a_time_oldest_first_and_skips_fresh_ones() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(
            &clock,
            vec![pod("b", false, Some("2")), pod("a", false, Some("1")), pod("fresh", false, Some("3")), pod("nophone", false, None)],
        );
        host.state.borrow_mut().last_on.insert("Rvc64_a".into(), 100 * H - 80 * H);
        host.state.borrow_mut().last_on.insert("Rvc64_b".into(), 100 * H - 30 * H);
        host.state.borrow_mut().last_on.insert("Rvc64_fresh".into(), 100 * H - 2 * H);
        let s = scheduler();
        s.scan(&host, &clock);

        let log = host.log();
        let power: Vec<&String> = log.iter().filter(|l| l.starts_with("on:") || l.starts_with("off:")).collect();
        assert_eq!(power.len(), 4);
        assert!(power[0].starts_with("on:a") && power[1].starts_with("off:a") && power[2].starts_with("on:b") && power[3].starts_with("off:b"), "{power:?}");

        let status = s.status();
        assert_eq!(status.phase, Phase::Idle);
        assert!(status.queue.is_empty());
        assert_eq!(status.last_run.as_ref().unwrap().pod, "b");
        assert_eq!(status.last_scan_at, Some(100 * H));
    }

    #[test]
    fn a_scan_records_running_pods_and_does_not_power_anything_when_all_are_up_to_date() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", true, Some("1")), pod("b", false, Some("2"))]);
        host.state.borrow_mut().last_on.insert("Rvc64_b".into(), 100 * H - H);
        let s = scheduler();
        s.scan(&host, &clock);
        assert!(host.log().is_empty());
        assert_eq!(host.state.borrow().last_on["Rvc64_a"], 100 * H);
        assert_eq!(s.status().message, "Todos los pods están al día.");
    }

    #[test]
    fn status_reports_the_hold_deadline_while_a_pod_is_on() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("1"))]);
        let seen = Arc::new(Mutex::new(Vec::<KeepAliveStatus>::new()));
        let sink = seen.clone();
        let s = Scheduler::new(Config { hold_secs: 600, exit_timeout_secs: 10, memory_tolerance_mb: 300 }, Box::new(move |st| sink.lock().unwrap().push(st.clone())));
        s.scan(&host, &clock);
        let seen = seen.lock().unwrap();
        let holding = seen.iter().find(|st| st.phase == Phase::Holding).expect("a holding status was emitted");
        assert_eq!(holding.current.as_deref(), Some("a"));
        assert_eq!(holding.hold_until, Some(100 * H + 30 + 600));
        let phases: Vec<Phase> = seen.iter().map(|st| st.phase).collect();
        let order = [Phase::PoweringOn, Phase::Holding, Phase::PoweringOff, Phase::WaitingExit];
        let mut at = 0;
        for p in phases {
            if at < order.len() && p == order[at] {
                at += 1;
            }
        }
        assert_eq!(at, order.len(), "phases went through on -> hold -> off -> wait in order");
    }

    #[test]
    fn disabling_stops_the_queue_between_pods() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("1")), pod("b", false, Some("2"))]);
        host.state.borrow_mut().last_on.insert("Rvc64_a".into(), 0);
        host.state.borrow_mut().last_on.insert("Rvc64_b".into(), 1);
        host.disable_after.set(Some(100 * H + 60)); // off during the first pod's hold
        scheduler().scan(&host, &clock);
        assert!(!host.log().iter().any(|l| l.starts_with("on:b")), "second pod never started: {:?}", host.log());
    }

    // ----- reset ("Reiniciar pods") and recovery -----

    fn due_host<'a>(clock: &'a FakeClock, names: &[&str]) -> FakeHost<'a> {
        let host = FakeHost::new(clock, names.iter().map(|n| pod(n, false, Some("1"))).collect());
        for (i, n) in names.iter().enumerate() {
            host.state.borrow_mut().last_on.insert(format!("Rvc64_{n}"), i as i64);
        }
        host
    }

    #[test]
    fn a_reset_during_the_hold_stops_the_run_clears_the_queue_and_leaves_the_pod_to_the_reset() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = due_host(&clock, &["a", "b"]);
        let s = Rc::new(scheduler());
        *host.sched.borrow_mut() = Some(s.clone());
        host.reset_after.set(Some(100 * H + 30 + 120)); // two minutes into the hold of "a"
        s.scan(&host, &clock);

        let log = host.log();
        assert!(!log.iter().any(|l| l.starts_with("off:")), "the reset owns the shutdown, the scan must not race it: {log:?}");
        assert!(!log.iter().any(|l| l.starts_with("on:b")), "the rest of the queue is dropped: {log:?}");
        assert!(clock.now() < 100 * H + 30 + 15 * 60, "did not wait out the hold");
        let status = s.status();
        assert_eq!(status.phase, Phase::Idle);
        assert!(status.current.is_none() && status.hold_until.is_none() && status.queue.is_empty(), "{status:?}");
        assert!(status.message.contains("reinici"), "{}", status.message);
    }

    #[test]
    fn a_reset_during_power_on_does_not_continue_with_the_rest_of_the_check() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = due_host(&clock, &["a"]);
        let s = Rc::new(scheduler());
        *host.sched.borrow_mut() = Some(s.clone());
        host.reset_on_power_on.set(true);
        let candidate = host.pods.borrow()[0].clone();
        let run = s.check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "interrupted");
        assert_eq!(host.log().len(), 2, "job + power on only: {:?}", host.log());
        assert_eq!(s.status().phase, Phase::Idle);
    }

    #[test]
    fn a_reset_while_waiting_for_the_process_to_exit_stops_waiting() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = due_host(&clock, &["a"]);
        host.exit_delay.set(10_000);
        let s = Rc::new(scheduler());
        *host.sched.borrow_mut() = Some(s.clone());
        host.reset_after.set(Some(100 * H + 30 + 15 * 60 + 6));
        let candidate = host.pods.borrow()[0].clone();
        s.check_pod(&host, &clock, &candidate);
        assert!(clock.now() < 100 * H + 30 + 15 * 60 + 30, "gave up right after the reset, not at the timeout");
        assert_eq!(s.status().phase, Phase::Idle);
    }

    #[test]
    fn a_scan_started_after_a_reset_runs_normally() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = due_host(&clock, &["a"]);
        let s = scheduler();
        s.reset();
        s.scan(&host, &clock);
        assert!(host.log().iter().any(|l| l.starts_with("off:a")), "{:?}", host.log());
        assert_eq!(s.status().phase, Phase::Idle);
        assert_eq!(s.status().last_run.unwrap().outcome, "ok");
    }

    #[test]
    fn a_crashed_scan_cannot_leave_the_card_in_progress() {
        let s = scheduler();
        s.update(|st| {
            st.phase = Phase::Holding;
            st.current = Some("pod2MX".into());
            st.queue = vec!["pod2MX".into(), "pilotoMX".into()];
            st.hold_until = Some(5);
        });
        s.recover_from_panic();
        let st = s.status();
        assert_eq!(st.phase, Phase::Idle);
        assert!(st.current.is_none() && st.queue.is_empty() && st.hold_until.is_none());
        assert!(st.message.contains("error"), "{}", st.message);
    }

    // ----- WhatsApp foreground checks and the interval setting -----

    #[test]
    fn whatsapp_is_checked_about_three_times_during_a_15_minute_hold() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("1"))]);
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        assert_eq!(run.outcome, "ok");
        let checks: Vec<String> = host.log().into_iter().filter(|l| l.starts_with("wa:")).collect();
        let first = 100 * H + 30;
        assert_eq!(checks, vec![format!("wa:a@{first}"), format!("wa:a@{}", first + 300), format!("wa:a@{}", first + 600)]);
        assert!(!run.note.contains("no abrió"));
    }

    #[test]
    fn a_failing_whatsapp_check_is_reported_but_the_pod_is_still_powered_off() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("1"))]);
        *host.wa_error.borrow_mut() = Some("timeout".into());
        let candidate = host.pods.borrow()[0].clone();
        let run = scheduler().check_pod(&host, &clock, &candidate);
        let log = host.log();
        assert_eq!(log.iter().filter(|l| l.starts_with("wa:")).count(), 3, "keeps retrying: {log:?}");
        assert!(log.iter().any(|l| l.starts_with("off:a@")), "{log:?}");
        assert_eq!(run.outcome, "ok");
        assert!(run.note.contains("WhatsApp no abrió en a"), "{}", run.note);
        assert!(host.state.borrow().last_on.contains_key("Rvc64_a"));
    }

    #[test]
    fn the_scan_uses_the_interval_read_from_the_host_each_time() {
        let clock = FakeClock(Cell::new(100 * H));
        let host = FakeHost::new(&clock, vec![pod("a", false, Some("1"))]);
        host.state.borrow_mut().last_on.insert("Rvc64_a".into(), 100 * H - 7 * H);
        host.interval.set(8);
        let s = scheduler();
        s.scan(&host, &clock);
        assert!(host.log().is_empty(), "7 h off is within 8 h: {:?}", host.log());
        assert_eq!(s.status().interval_hours, 8);

        host.interval.set(6);
        s.scan(&host, &clock);
        assert!(host.log().iter().any(|l| l.starts_with("off:a@")), "7 h off exceeds 6 h: {:?}", host.log());
    }

    #[test]
    fn scan_cadence_is_small_compared_to_the_shortest_interval() {
        assert!(SCAN_SECS * 4 <= 4 * 3600, "scans must be well inside the shortest (4 h) interval");
    }
}
