//! "Reiniciar pods": the recovery for a Pods section that got stuck (a pod job whose script died or hung, an
//! auto-review that stays "en curso", embedded windows that never finish booting).
//!
//! The decisions live in `reset_pods` and run against `ResetOps` (a fake in the tests). The real host is `RealOps`.
//! Order of a reset:
//!   1. stop what the app itself started for pod jobs (its own PIDs, never BlueStacks or anything found by name);
//!   2. force-release the pod-job lock and stop the auto-review run (it resumes on its normal schedule later);
//!   3. give every embedded pod window back and forget the embedding state;
//!   4. stop the pods that were running and start them again, one at a time (`pods.ps1 apagar` / `prender`);
//!      pods that were off stay off.

use crate::embed::{self, Embedder};
use crate::keepalive::Scheduler;
use crate::pods::{self, Pod, PodJob, PODS_PROCS};
use crate::settings::Settings;
use serde::Serialize;
use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResetFailure {
    pub pod: String,
    /// "apagar" | "prender"
    pub step: String,
    pub error: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResetReport {
    /// Pods that were running, were stopped and are running again.
    pub restarted: Vec<String>,
    /// The pod the auto-review had turned on: it is stopped and left off (it was never "in use").
    pub left_off: Vec<String>,
    pub failed: Vec<ResetFailure>,
    pub message: String,
}

pub trait ResetOps {
    /// The pod the auto-review currently has turned on, if any (read BEFORE the run is reset).
    fn auto_review_pod(&self) -> Option<String>;
    /// Kills the child processes the app spawned for pod jobs.
    fn cancel_children(&self);
    fn force_release_job(&self);
    fn reset_auto_review(&self);
    fn release_embeds(&self);
    /// Holds the pod-job slot while the restart runs, so nothing else starts a pod meanwhile.
    fn begin_job(&self) -> Option<Box<dyn Any>>;
    fn list(&self) -> Result<Vec<Pod>, String>;
    fn stop(&self, name: &str) -> Result<(), String>;
    fn start(&self, name: &str) -> Result<(), String>;
    fn progress(&self, text: &str);
}

fn plural(n: usize) -> String {
    if n == 1 { "1 pod".into() } else { format!("{n} pods") }
}

fn summary(report: &ResetReport, was_running: usize) -> String {
    let mut text = if was_running == 0 && !report.left_off.is_empty() {
        format!("Listo: «{}» se apagó porque lo había encendido la revisión automática; no había otros pods encendidos.", report.left_off.join("», «"))
    } else if was_running == 0 {
        "Listo: no había pods encendidos; todo quedó liberado y la sección se recargó.".to_string()
    } else if report.failed.is_empty() {
        let n = report.restarted.len();
        let verb = if n == 1 { "se reinició" } else { "se reiniciaron" };
        let mut t = format!("Listo: {verb} {}.", plural(n));
        if !report.left_off.is_empty() {
            t.push_str(&format!(" «{}» quedó apagado porque lo había encendido la revisión automática.", report.left_off.join("», «")));
        }
        t
    } else {
        let failed: Vec<String> = report.failed.iter().map(|f| format!("{} ({}: {})", f.pod, f.step, f.error)).collect();
        format!("Se reiniciaron {} de {}. No se pudo con: {}.", report.restarted.len(), was_running, failed.join("; "))
    };
    if was_running == 0 && !report.failed.is_empty() {
        text.push_str(" Hubo errores.");
    }
    text
}

/// Runs the whole reset. `Err` only when the pods could not even be listed (everything was still released).
pub fn reset_pods(ops: &dyn ResetOps) -> Result<ResetReport, String> {
    let auto_review = ops.auto_review_pod();

    ops.progress("Cancelando lo que estaba en curso…");
    ops.cancel_children();
    ops.force_release_job();
    ops.reset_auto_review();
    ops.progress("Soltando las ventanas de los pods…");
    ops.release_embeds();

    let _job = ops.begin_job();
    ops.progress("Leyendo qué pods están encendidos…");
    let running: Vec<Pod> = ops
        .list()
        .map_err(|e| format!("No se pudo leer la lista de pods: {e}"))?
        .into_iter()
        .filter(|p| p.state == "running")
        .collect();

    let mut report = ResetReport::default();
    let mut to_restart: Vec<&Pod> = Vec::new();
    for pod in &running {
        ops.progress(&format!("Apagando {}…", pod.name));
        match ops.stop(&pod.name) {
            Ok(()) if auto_review.as_deref() == Some(pod.name.as_str()) => report.left_off.push(pod.name.clone()),
            Ok(()) => to_restart.push(pod),
            Err(error) => report.failed.push(ResetFailure { pod: pod.name.clone(), step: "apagar".into(), error }),
        }
    }
    for pod in to_restart {
        ops.progress(&format!("Encendiendo {}… (puede tardar unos minutos)", pod.name));
        match ops.start(&pod.name) {
            Ok(()) => report.restarted.push(pod.name.clone()),
            Err(error) => report.failed.push(ResetFailure { pod: pod.name.clone(), step: "prender".into(), error }),
        }
    }
    report.message = summary(&report, running.len() - report.left_off.len());
    Ok(report)
}

/// Only one reset at a time (a second click while the first still runs is refused).
#[derive(Default)]
pub struct ResetGate(AtomicBool);

pub struct ResetGateGuard<'a>(&'a ResetGate);

impl ResetGate {
    pub fn try_enter(&self) -> Option<ResetGateGuard<'_>> {
        (!self.0.swap(true, Ordering::SeqCst)).then_some(ResetGateGuard(self))
    }
}

impl Drop for ResetGateGuard<'_> {
    fn drop(&mut self) {
        (self.0).0.store(false, Ordering::SeqCst);
    }
}

/// The real thing: pods.ps1, the app's own job slot, scheduler and embedder.
pub struct RealOps {
    pub settings: Settings,
    pub pod_job: PodJob,
    pub keepalive: Arc<Scheduler>,
    pub embedder: Option<Arc<Embedder<embed::win::RealWin>>>,
    pub on_progress: Box<dyn Fn(&str) + Send + Sync>,
}

impl ResetOps for RealOps {
    fn auto_review_pod(&self) -> Option<String> {
        self.keepalive.status().current
    }
    fn cancel_children(&self) {
        let killed = PODS_PROCS.kill_all();
        crate::applog::log("pods", &format!("Reiniciar pods: se cancelaron {killed} proceso(s) propios de la app."));
    }
    fn force_release_job(&self) {
        if let Some(what) = self.pod_job.force_release() {
            crate::applog::log("pods", &format!("Reiniciar pods: se liberó la operación «{what}»."));
        }
    }
    fn reset_auto_review(&self) {
        self.keepalive.reset();
    }
    fn release_embeds(&self) {
        let Some(embedder) = self.embedder.clone() else { return };
        // Giving a window back can wait on a worker stuck inside Win32: never let that hold the reset forever.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(embedder.release_all());
        });
        match rx.recv_timeout(std::time::Duration::from_secs(15)) {
            Ok(errors) if !errors.is_empty() => crate::applog::log("embed", &format!("Reiniciar pods: {} ventana(s) no se pudieron soltar bien.", errors.len())),
            Ok(_) => {}
            Err(_) => crate::applog::log("embed", "Reiniciar pods: soltar las ventanas tardó demasiado; se siguió igual."),
        }
    }
    fn begin_job(&self) -> Option<Box<dyn Any>> {
        self.pod_job.begin("reiniciar pods").ok().map(|g| Box::new(g) as Box<dyn Any>)
    }
    fn list(&self) -> Result<Vec<Pod>, String> {
        pods::list(&self.settings)
    }
    fn stop(&self, name: &str) -> Result<(), String> {
        pods::run_action(&self.settings, "apagar", name).map(|_| ())
    }
    fn start(&self, name: &str) -> Result<(), String> {
        pods::run_action(&self.settings, "prender", name).map(|_| ())
    }
    fn progress(&self, text: &str) {
        (self.on_progress)(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn pod(name: &str, running: bool) -> Pod {
        Pod {
            name: name.into(),
            instance_id: format!("Rvc64_{name}"),
            state: if running { "running" } else { "stopped" }.into(),
            serial: None,
            adb_port: 5565,
            phone: None,
        }
    }

    struct JobToken(Rc<RefCell<Vec<String>>>);
    impl Drop for JobToken {
        fn drop(&mut self) {
            self.0.borrow_mut().push("job:end".into());
        }
    }

    struct Fake {
        log: Rc<RefCell<Vec<String>>>,
        pods: RefCell<Result<Vec<Pod>, String>>,
        auto_review: Option<String>,
        stop_errors: Vec<&'static str>,
        start_errors: Vec<&'static str>,
    }

    impl Fake {
        fn new(pods: Vec<Pod>) -> Fake {
            Fake { log: Rc::default(), pods: RefCell::new(Ok(pods)), auto_review: None, stop_errors: vec![], start_errors: vec![] }
        }
        fn log(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
        fn push(&self, s: impl Into<String>) {
            self.log.borrow_mut().push(s.into());
        }
    }

    impl ResetOps for Fake {
        fn auto_review_pod(&self) -> Option<String> {
            self.auto_review.clone()
        }
        fn cancel_children(&self) {
            self.push("cancel");
        }
        fn force_release_job(&self) {
            self.push("release-job");
        }
        fn reset_auto_review(&self) {
            self.push("reset-auto-review");
        }
        fn release_embeds(&self) {
            self.push("release-embeds");
        }
        fn begin_job(&self) -> Option<Box<dyn Any>> {
            self.push("job:begin");
            Some(Box::new(JobToken(self.log.clone())))
        }
        fn list(&self) -> Result<Vec<Pod>, String> {
            self.push("list");
            self.pods.borrow().clone()
        }
        fn stop(&self, name: &str) -> Result<(), String> {
            self.push(format!("stop:{name}"));
            if self.stop_errors.contains(&name) { Err("no cerró".into()) } else { Ok(()) }
        }
        fn start(&self, name: &str) -> Result<(), String> {
            self.push(format!("start:{name}"));
            if self.start_errors.contains(&name) { Err("no arrancó".into()) } else { Ok(()) }
        }
        fn progress(&self, _: &str) {}
    }

    #[test]
    fn releases_everything_first_then_restarts_only_the_pods_that_were_running_one_at_a_time() {
        let ops = Fake::new(vec![pod("a", true), pod("b", false), pod("c", true)]);
        let report = reset_pods(&ops).unwrap();
        assert_eq!(
            ops.log(),
            ["cancel", "release-job", "reset-auto-review", "release-embeds", "job:begin", "list", "stop:a", "stop:c", "start:a", "start:c", "job:end"]
        );
        assert_eq!(report.restarted, vec!["a", "c"]);
        assert!(report.failed.is_empty() && report.left_off.is_empty());
        assert_eq!(report.message, "Listo: se reiniciaron 2 pods.");
    }

    #[test]
    fn pods_that_were_off_stay_off_and_a_reset_with_nothing_running_still_releases_everything() {
        let ops = Fake::new(vec![pod("pod2MX", false), pod("pilotoMX", false)]);
        let report = reset_pods(&ops).unwrap();
        assert!(!ops.log().iter().any(|l| l.starts_with("stop:") || l.starts_with("start:")), "{:?}", ops.log());
        assert!(ops.log().contains(&"release-job".to_string()));
        assert!(report.message.contains("no había pods encendidos"), "{}", report.message);
    }

    #[test]
    fn singular_message() {
        let ops = Fake::new(vec![pod("a", true)]);
        assert_eq!(reset_pods(&ops).unwrap().message, "Listo: se reinició 1 pod.");
    }

    #[test]
    fn the_pod_the_auto_review_had_turned_on_is_stopped_and_left_off() {
        let mut ops = Fake::new(vec![pod("a", true), pod("c", true)]);
        ops.auto_review = Some("a".into());
        let report = reset_pods(&ops).unwrap();
        assert_eq!(report.left_off, vec!["a"]);
        assert_eq!(report.restarted, vec!["c"]);
        assert!(ops.log().contains(&"stop:a".to_string()) && !ops.log().contains(&"start:a".to_string()), "{:?}", ops.log());
        assert!(report.message.contains("«a» quedó apagado"), "{}", report.message);
    }

    #[test]
    fn a_pod_that_will_not_stop_is_reported_and_does_not_block_the_others() {
        let mut ops = Fake::new(vec![pod("a", true), pod("c", true)]);
        ops.stop_errors = vec!["a"];
        let report = reset_pods(&ops).unwrap();
        assert_eq!(report.restarted, vec!["c"]);
        assert_eq!(report.failed, vec![ResetFailure { pod: "a".into(), step: "apagar".into(), error: "no cerró".into() }]);
        assert!(!ops.log().contains(&"start:a".to_string()), "a pod that did not stop is not started again");
        assert!(report.message.starts_with("Se reiniciaron 1 de 2."), "{}", report.message);
        assert!(report.message.contains("a (apagar: no cerró)"), "{}", report.message);
    }

    #[test]
    fn a_pod_that_will_not_start_is_reported() {
        let mut ops = Fake::new(vec![pod("a", true), pod("c", true)]);
        ops.start_errors = vec!["a"];
        let report = reset_pods(&ops).unwrap();
        assert_eq!(report.restarted, vec!["c"]);
        assert_eq!(report.failed[0].step, "prender");
        assert!(ops.log().contains(&"start:c".to_string()), "the next pod is still started");
    }

    #[test]
    fn when_the_list_cannot_be_read_everything_was_still_released() {
        let ops = Fake::new(vec![]);
        *ops.pods.borrow_mut() = Err("BlueStacks no responde".into());
        let err = reset_pods(&ops).unwrap_err();
        assert!(err.contains("No se pudo leer la lista de pods") && err.contains("BlueStacks no responde"), "{err}");
        assert_eq!(ops.log()[..4], ["cancel", "release-job", "reset-auto-review", "release-embeds"]);
        assert_eq!(ops.log().last().map(String::as_str), Some("job:end"), "the job slot is not left held");
    }

    #[test]
    fn a_second_reset_is_refused_while_one_runs_and_allowed_afterwards() {
        let gate = ResetGate::default();
        let first = gate.try_enter().expect("first");
        assert!(gate.try_enter().is_none());
        drop(first);
        assert!(gate.try_enter().is_some());
    }

    #[test]
    fn the_report_serializes_as_camel_case_for_the_ui() {
        let report = ResetReport { restarted: vec!["a".into()], left_off: vec![], failed: vec![], message: "ok".into() };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"leftOff\"") && json.contains("\"restarted\""), "{json}");
    }
}
