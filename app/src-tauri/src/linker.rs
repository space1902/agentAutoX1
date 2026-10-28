//! Auto-link pods to the warm-up. For every tester whose phone belongs to a pod and has no saved session,
//! the pod is linked ONE AT A TIME: power on (if off) -> wait for Android + WhatsApp Business -> ask Baileys for a
//! pairing code -> type it in the pod over adb -> wait for the session -> power off again (if it was off before).
//!
//! This file holds the decisions (plan, state machine, parsing). The side effects (PowerShell, Node, adb) sit behind
//! `LinkOps`, implemented for real in `linker_real.rs` and faked in the tests, so the flow is tested without any pod.

use crate::pods::Pod;
use crate::util::phone_key;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    pub tester_id: String,
    pub phone: String,
    pub pod_name: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Queued,
    PoweringOn,
    WaitingAndroid,
    RequestingCode,
    TypingCode,
    WaitingLink,
    Linked,
    PoweringOff,
    /// The automatic typing failed (or was refused): the user must finish by hand; the code is shown big.
    Manual,
    Failed,
    Cancelled,
    DryRun,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkProgress {
    pub tester_id: String,
    pub pod_name: String,
    pub phone: String,
    pub stage: Stage,
    pub message: String,
    pub code: Option<String>,
    /// 1-based position in the queue and queue size.
    pub index: usize,
    pub total: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkResult {
    pub tester_id: String,
    pub pod_name: String,
    pub stage: Stage,
    pub ok: bool,
    pub message: String,
    pub code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileTester {
    id: String,
    phone: Option<String>,
    #[serde(default)]
    linked: bool,
    pod_name: Option<String>,
}

/// Testers of `profile` (the JSON the engine returns for `list`) that must be linked first: unlinked, with a phone
/// that belongs to an existing pod. One target per pod, in the profile's order. External numbers are not included.
pub fn plan_links(profile: &Value, pods: &[Pod]) -> Vec<LinkTarget> {
    let testers: Vec<ProfileTester> = profile
        .get("testers")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let mut targets: Vec<LinkTarget> = Vec::new();
    for tester in testers {
        let (Some(phone), Some(pod_name)) = (tester.phone, tester.pod_name) else { continue };
        if tester.linked || phone_key(&phone).is_empty() {
            continue;
        }
        let Some(pod) = pods.iter().find(|p| p.name == pod_name) else { continue };
        if targets.iter().any(|t| t.pod_name == pod.name) {
            continue;
        }
        targets.push(LinkTarget { tester_id: tester.id, phone, pod_name: pod.name.clone() });
    }
    targets
}

// ---------- what the Node CLIs print ----------

#[derive(Debug, PartialEq, Clone)]
pub enum SessionEvent {
    Code(String),
    Linked,
    AlreadyLinked,
    Error { code: String, message: String },
    Exit(String),
}

/// One JSON line of `link-session-cli.js`.
pub fn parse_session_event(line: &str) -> Option<SessionEvent> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let text = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    match v.get("event")?.as_str()? {
        "code" => Some(SessionEvent::Code(text("code"))),
        "linked" => Some(SessionEvent::Linked),
        "already-linked" => Some(SessionEvent::AlreadyLinked),
        "error" => Some(SessionEvent::Error { code: text("code"), message: text("message") }),
        "exit" => Some(SessionEvent::Exit(text("status"))),
        _ => None,
    }
}

#[derive(Debug, PartialEq, Clone)]
pub struct DriveError {
    pub code: String,
    pub message: String,
    pub manual_hint: Option<String>,
}

/// Last JSON line of `pod-driver-cli.js`: `done` -> Ok, `error` -> Err with the screen-specific manual hint.
pub fn parse_driver_output(stdout: &str) -> Result<(), DriveError> {
    let last = stdout.lines().rev().map(str::trim).find(|l| l.starts_with('{'));
    let Some(value) = last.and_then(|l| serde_json::from_str::<Value>(l).ok()) else {
        return Err(DriveError { code: "NO_OUTPUT".into(), message: "El controlador del pod no respondió.".into(), manual_hint: None });
    };
    match value.get("event").and_then(Value::as_str) {
        Some("done") => Ok(()),
        _ => Err(DriveError {
            code: value.get("code").and_then(Value::as_str).unwrap_or("UNEXPECTED").to_string(),
            message: value.get("message").and_then(Value::as_str).unwrap_or("Error desconocido.").to_string(),
            manual_hint: value.pointer("/details/manualHint").and_then(Value::as_str).map(str::to_string),
        }),
    }
}

// ---------- side effects, behind a trait ----------

pub enum StreamItem {
    Event(SessionEvent),
    Timeout,
    Closed,
}

/// Events of one running link session (a Node process in production).
pub trait SessionStream {
    fn next(&mut self, wait: Duration) -> StreamItem;
    fn close(&mut self);
}

pub trait LinkOps {
    fn pod(&self, name: &str) -> Result<Pod, String>;
    fn power_on(&self, name: &str) -> Result<(), String>;
    fn power_off(&self, name: &str) -> Result<(), String>;
    /// adb online + Android booted + WhatsApp Business in the foreground.
    fn wait_ready(&self, serial: &str) -> Result<(), DriveError>;
    fn start_session(&self, tester_id: &str) -> Result<Box<dyn SessionStream>, String>;
    /// Types `code` in the pod. With `dry_run` it only reads the screen.
    fn drive(&self, serial: &str, code: &str, dry_run: bool) -> Result<(), DriveError>;
    fn cancelled(&self) -> bool;
}

pub struct Limits {
    /// How long one `next` call waits.
    pub tick: Duration,
    /// Ticks without the session finishing before giving up (code never typed, WhatsApp silent...).
    pub max_ticks: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { tick: Duration::from_secs(1), max_ticks: 6 * 60 }
    }
}

pub struct Options {
    /// Turn the pod off again when it was off before we started.
    pub power_off_after: bool,
    pub dry_run: bool,
}

fn pretty_code(code: &str) -> String {
    let clean: String = code.chars().filter(char::is_ascii_alphanumeric).collect();
    if clean.len() == 8 { format!("{}-{}", &clean[..4], &clean[4..]) } else { code.to_string() }
}

struct Reporter<'a> {
    target: &'a LinkTarget,
    index: usize,
    total: usize,
    emit: &'a mut dyn FnMut(LinkProgress),
}

impl Reporter<'_> {
    fn say(&mut self, stage: Stage, message: impl Into<String>, code: Option<&str>) {
        (self.emit)(LinkProgress {
            tester_id: self.target.tester_id.clone(),
            pod_name: self.target.pod_name.clone(),
            phone: self.target.phone.clone(),
            stage,
            message: message.into(),
            code: code.map(str::to_string),
            index: self.index,
            total: self.total,
        });
    }

    fn result(&self, stage: Stage, ok: bool, message: impl Into<String>, code: Option<&str>) -> LinkResult {
        LinkResult {
            tester_id: self.target.tester_id.clone(),
            pod_name: self.target.pod_name.clone(),
            stage,
            ok,
            message: message.into(),
            code: code.map(str::to_string),
        }
    }
}

fn drive_message(error: &DriveError) -> String {
    match &error.manual_hint {
        Some(hint) => format!("{} {hint}", error.message),
        None => error.message.clone(),
    }
}

/// Links ONE pod. Never panics; every failure becomes a `LinkResult`.
fn link_one(ops: &dyn LinkOps, target: &LinkTarget, options: &Options, limits: &Limits, index: usize, total: usize, emit: &mut dyn FnMut(LinkProgress)) -> LinkResult {
    let mut r = Reporter { target, index, total, emit };
    let name = target.pod_name.as_str();

    let pod = match ops.pod(name) {
        Ok(p) => p,
        Err(e) => {
            r.say(Stage::Failed, e.clone(), None);
            return r.result(Stage::Failed, false, e, None);
        }
    };
    let was_running = pod.state == "running";

    if options.dry_run {
        return dry_run(ops, &pod, &mut r);
    }
    if ops.cancelled() {
        return cancelled(&mut r);
    }

    if !was_running {
        r.say(Stage::PoweringOn, format!("Encendiendo {name}… puede tardar un par de minutos."), None);
        if let Err(e) = ops.power_on(name) {
            let message = format!("No se pudo encender {name}: {e}");
            r.say(Stage::Failed, message.clone(), None);
            return r.result(Stage::Failed, false, message, None);
        }
    }

    let outcome = link_running_pod(ops, name, target, limits, &mut r);

    // While waiting for a manual finish the pod stays on (the loop above keeps listening); once the outcome is
    // known, a pod that was off before goes back to off.
    let mut result = outcome;
    if !was_running && options.power_off_after {
        r.say(Stage::PoweringOff, format!("Apagando {name}…"), None);
        if let Err(e) = ops.power_off(name) {
            result.message = format!("{} (no se pudo apagar {name}: {e})", result.message);
        }
    }
    result
}

fn cancelled(r: &mut Reporter) -> LinkResult {
    r.say(Stage::Cancelled, "Cancelado.", None);
    r.result(Stage::Cancelled, false, "Cancelado.", None)
}

fn dry_run(ops: &dyn LinkOps, pod: &Pod, r: &mut Reporter) -> LinkResult {
    let name = pod.name.as_str();
    let message = match (&pod.state[..], &pod.serial) {
        ("running", Some(serial)) => match ops.drive(serial, "ABCD1234", true) {
            Ok(()) => format!("Simulación: {name} está encendido y su pantalla se puede leer. No se tocó nada."),
            Err(e) => format!("Simulación: {name} está encendido pero {}", drive_message(&e)),
        },
        _ => format!("Simulación: {name} está apagado; se encendería, se esperaría a WhatsApp Business y se vincularía. No se tocó nada."),
    };
    r.say(Stage::DryRun, message.clone(), None);
    r.result(Stage::DryRun, true, message, None)
}

fn link_running_pod(ops: &dyn LinkOps, name: &str, target: &LinkTarget, limits: &Limits, r: &mut Reporter) -> LinkResult {
    let fail = |r: &mut Reporter, message: String| {
        r.say(Stage::Failed, message.clone(), None);
        r.result(Stage::Failed, false, message, None)
    };

    // The serial only exists while the pod runs: read it after the power on.
    let serial = match ops.pod(name).map(|p| p.serial) {
        Ok(Some(serial)) => serial,
        Ok(None) => return fail(r, format!("{name} está encendido pero adb todavía no lo ve. Inténtalo de nuevo en un minuto.")),
        Err(e) => return fail(r, e),
    };

    r.say(Stage::WaitingAndroid, "Esperando a que Android y WhatsApp Business estén listos…", None);
    if let Err(e) = ops.wait_ready(&serial) {
        return fail(r, e.message);
    }
    if ops.cancelled() {
        return cancelled(r);
    }

    r.say(Stage::RequestingCode, format!("Pidiendo el código de vinculación para {}…", target.phone), None);
    let mut session = match ops.start_session(&target.tester_id) {
        Ok(s) => s,
        Err(e) => return fail(r, e),
    };

    let result = follow_session(ops, &serial, session.as_mut(), limits, r);
    session.close();
    result
}

fn follow_session(ops: &dyn LinkOps, serial: &str, session: &mut dyn SessionStream, limits: &Limits, r: &mut Reporter) -> LinkResult {
    let mut handled_code: Option<String> = None;
    let mut manual_code: Option<String> = None;
    let mut ticks = 0u32;

    loop {
        if ops.cancelled() {
            return cancelled(r);
        }
        match session.next(limits.tick) {
            StreamItem::Timeout => {
                ticks += 1;
                if ticks >= limits.max_ticks {
                    let code = manual_code.clone().or(handled_code.clone());
                    let message = "Pasó el tiempo y la vinculación no terminó.".to_string();
                    r.say(Stage::Failed, message.clone(), code.as_deref());
                    return r.result(Stage::Failed, false, message, code.as_deref());
                }
            }
            StreamItem::Closed => {
                let message = "El proceso de vinculación terminó sin vincular el número.".to_string();
                r.say(Stage::Failed, message.clone(), None);
                return r.result(Stage::Failed, false, message, None);
            }
            StreamItem::Event(SessionEvent::Linked) | StreamItem::Event(SessionEvent::AlreadyLinked) => {
                r.say(Stage::Linked, "Número vinculado.", None);
                return r.result(Stage::Linked, true, "Número vinculado.", None);
            }
            StreamItem::Event(SessionEvent::Error { message, .. }) => {
                let code = manual_code.clone();
                r.say(Stage::Failed, message.clone(), code.as_deref());
                return r.result(Stage::Failed, false, message, code.as_deref());
            }
            StreamItem::Event(SessionEvent::Exit(_)) => {}
            StreamItem::Event(SessionEvent::Code(code)) => {
                if handled_code.as_deref() == Some(code.as_str()) {
                    continue;
                }
                handled_code = Some(code.clone());
                let shown = pretty_code(&code);
                r.say(Stage::TypingCode, format!("Escribiendo el código {shown} en el pod…"), Some(&shown));
                match ops.drive(serial, &code, false) {
                    Ok(()) => r.say(Stage::WaitingLink, "Código escrito; esperando a que WhatsApp confirme…", Some(&shown)),
                    Err(e) => {
                        manual_code = Some(shown.clone());
                        let message = format!("No pude terminar solo. {}", drive_message(&e));
                        r.say(Stage::Manual, message, Some(&shown));
                        // Keep listening: if the user types the code by hand the session still links.
                    }
                }
            }
        }
    }
}

/// Runs the queue sequentially. A failure never stops the next pod; cancelling marks the rest as cancelled.
pub fn run_links(ops: &dyn LinkOps, targets: &[LinkTarget], options: &Options, limits: &Limits, emit: &mut dyn FnMut(LinkProgress)) -> Vec<LinkResult> {
    let total = targets.len();
    for (i, target) in targets.iter().enumerate() {
        emit(LinkProgress {
            tester_id: target.tester_id.clone(),
            pod_name: target.pod_name.clone(),
            phone: target.phone.clone(),
            stage: Stage::Queued,
            message: "En cola.".into(),
            code: None,
            index: i + 1,
            total,
        });
    }
    targets
        .iter()
        .enumerate()
        .map(|(i, target)| link_one(ops, target, options, limits, i + 1, total, emit))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn pod(name: &str, running: bool, phone: &str) -> Pod {
        Pod {
            name: name.into(),
            instance_id: format!("Rvc64_{name}"),
            state: if running { "running" } else { "stopped" }.into(),
            serial: running.then(|| "emulator-5564".to_string()),
            adb_port: 5565,
            phone: Some(phone.into()),
        }
    }

    // ----- plan -----

    #[test]
    fn plans_only_unlinked_testers_whose_phone_belongs_to_a_pod() {
        let profile = json!({"testers": [
            {"id": "tester1", "phone": "573042370764", "linked": false, "podName": "pod1"},
            {"id": "tester2", "phone": "573109998877", "linked": true,  "podName": "pod2"},
            {"id": "tester3", "phone": "573001112233", "linked": false, "podName": null},
            {"id": "tester4", "phone": null, "linked": false, "podName": null},
            {"id": "tester5", "phone": "573115556677", "linked": false, "podName": "pod3"},
            {"id": "tester6", "phone": "573115556677", "linked": false, "podName": "pod3"},
            {"id": "tester7", "phone": "573000000000", "linked": false, "podName": "ghost"}
        ]});
        let pods = vec![pod("pod1", false, "3042370764"), pod("pod2", true, "3109998877"), pod("pod3", true, "3115556677")];
        let plan = plan_links(&profile, &pods);
        assert_eq!(
            plan,
            vec![
                LinkTarget { tester_id: "tester1".into(), phone: "573042370764".into(), pod_name: "pod1".into() },
                LinkTarget { tester_id: "tester5".into(), phone: "573115556677".into(), pod_name: "pod3".into() },
            ]
        );
    }

    #[test]
    fn plans_nothing_when_everything_is_linked_or_the_json_is_odd() {
        assert!(plan_links(&json!({"testers": []}), &[]).is_empty());
        assert!(plan_links(&json!({}), &[]).is_empty());
        assert!(plan_links(&json!(null), &[]).is_empty());
    }

    // ----- parsing -----

    #[test]
    fn parses_session_events() {
        assert_eq!(parse_session_event(r#"{"event":"code","code":"ABCD-1234"}"#), Some(SessionEvent::Code("ABCD-1234".into())));
        assert_eq!(parse_session_event(r#"{"event":"linked"}"#), Some(SessionEvent::Linked));
        assert_eq!(parse_session_event(r#"{"event":"already-linked"}"#), Some(SessionEvent::AlreadyLinked));
        assert_eq!(
            parse_session_event(r#"{"event":"error","code":"TIMEOUT","message":"tarde"}"#),
            Some(SessionEvent::Error { code: "TIMEOUT".into(), message: "tarde".into() })
        );
        assert_eq!(parse_session_event(r#"{"event":"exit","status":"linked"}"#), Some(SessionEvent::Exit("linked".into())));
        assert_eq!(parse_session_event("not json"), None);
        assert_eq!(parse_session_event(r#"{"event":"mystery"}"#), None);
    }

    #[test]
    fn parses_driver_output_done_and_error_with_manual_hint() {
        assert!(parse_driver_output("{\"event\":\"step\",\"screen\":\"chats\"}\n{\"event\":\"done\",\"typed\":true}\n").is_ok());
        let err = parse_driver_output(
            "{\"event\":\"error\",\"code\":\"NO_PROGRESS\",\"message\":\"No cambió\",\"details\":{\"manualHint\":\"Termina a mano\"}}",
        )
        .unwrap_err();
        assert_eq!(err.code, "NO_PROGRESS");
        assert_eq!(err.manual_hint.as_deref(), Some("Termina a mano"));
        assert_eq!(parse_driver_output("").unwrap_err().code, "NO_OUTPUT");
    }

    // ----- state machine with a fake pod -----

    struct FakeStream(VecDeque<StreamItem>);
    impl SessionStream for FakeStream {
        fn next(&mut self, _wait: Duration) -> StreamItem {
            self.0.pop_front().unwrap_or(StreamItem::Timeout)
        }
        fn close(&mut self) {}
    }

    struct FakeOps {
        pods: RefCell<Vec<Pod>>,
        calls: RefCell<Vec<String>>,
        session: RefCell<Vec<VecDeque<StreamItem>>>,
        drive_result: RefCell<Result<(), DriveError>>,
        ready: RefCell<Result<(), DriveError>>,
        cancel_after_calls: Option<usize>,
    }

    impl FakeOps {
        fn new(pods: Vec<Pod>, sessions: Vec<Vec<StreamItem>>) -> FakeOps {
            FakeOps {
                pods: RefCell::new(pods),
                calls: RefCell::new(vec![]),
                session: RefCell::new(sessions.into_iter().map(VecDeque::from).collect()),
                drive_result: RefCell::new(Ok(())),
                ready: RefCell::new(Ok(())),
                cancel_after_calls: None,
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
        fn log(&self, entry: String) {
            self.calls.borrow_mut().push(entry);
        }
    }

    impl LinkOps for FakeOps {
        fn pod(&self, name: &str) -> Result<Pod, String> {
            self.pods.borrow().iter().find(|p| p.name == name).cloned().ok_or_else(|| format!("No existe el pod «{name}»."))
        }
        fn power_on(&self, name: &str) -> Result<(), String> {
            self.log(format!("on:{name}"));
            if let Some(p) = self.pods.borrow_mut().iter_mut().find(|p| p.name == name) {
                p.state = "running".into();
                p.serial = Some("emulator-5564".into());
            }
            Ok(())
        }
        fn power_off(&self, name: &str) -> Result<(), String> {
            self.log(format!("off:{name}"));
            if let Some(p) = self.pods.borrow_mut().iter_mut().find(|p| p.name == name) {
                p.state = "stopped".into();
                p.serial = None;
            }
            Ok(())
        }
        fn wait_ready(&self, serial: &str) -> Result<(), DriveError> {
            self.log(format!("ready:{serial}"));
            self.ready.borrow().clone()
        }
        fn start_session(&self, tester_id: &str) -> Result<Box<dyn SessionStream>, String> {
            self.log(format!("session:{tester_id}"));
            Ok(Box::new(FakeStream(self.session.borrow_mut().remove(0))))
        }
        fn drive(&self, _serial: &str, code: &str, dry_run: bool) -> Result<(), DriveError> {
            self.log(format!("drive:{code}:{dry_run}"));
            self.drive_result.borrow().clone()
        }
        fn cancelled(&self) -> bool {
            self.cancel_after_calls.is_some_and(|n| self.calls.borrow().len() >= n)
        }
    }

    fn target(tester: &str, pod_name: &str) -> LinkTarget {
        LinkTarget { tester_id: tester.into(), phone: "573042370764".into(), pod_name: pod_name.into() }
    }

    fn code(c: &str) -> StreamItem {
        StreamItem::Event(SessionEvent::Code(c.into()))
    }

    const FAST: Limits = Limits { tick: Duration::from_millis(0), max_ticks: 5 };
    const NORMAL: Options = Options { power_off_after: true, dry_run: false };

    fn run(ops: &FakeOps, targets: &[LinkTarget], options: &Options) -> (Vec<LinkResult>, Vec<LinkProgress>) {
        let mut events = Vec::new();
        let results = run_links(ops, targets, options, &FAST, &mut |p| events.push(p));
        (results, events)
    }

    #[test]
    fn happy_path_powers_on_links_and_powers_off_again() {
        let ops = FakeOps::new(vec![pod("pod1", false, "3042370764")], vec![vec![code("ABCD-1234"), StreamItem::Event(SessionEvent::Linked)]]);
        let (results, events) = run(&ops, &[target("tester1", "pod1")], &NORMAL);

        assert_eq!(ops.calls(), vec!["on:pod1", "ready:emulator-5564", "session:tester1", "drive:ABCD-1234:false", "off:pod1"]);
        assert_eq!(results.len(), 1);
        assert!(results[0].ok);
        assert_eq!(results[0].stage, Stage::Linked);
        let stages: Vec<Stage> = events.iter().map(|e| e.stage).collect();
        assert_eq!(
            stages,
            vec![Stage::Queued, Stage::PoweringOn, Stage::WaitingAndroid, Stage::RequestingCode, Stage::TypingCode, Stage::WaitingLink, Stage::Linked, Stage::PoweringOff]
        );
        assert_eq!(events[4].code.as_deref(), Some("ABCD-1234"));
    }

    #[test]
    fn a_pod_that_was_already_on_is_not_powered_on_or_off() {
        let ops = FakeOps::new(vec![pod("pod1", true, "3042370764")], vec![vec![code("ABCD-1234"), StreamItem::Event(SessionEvent::Linked)]]);
        let (results, _) = run(&ops, &[target("tester1", "pod1")], &NORMAL);
        assert!(results[0].ok);
        assert!(!ops.calls().iter().any(|c| c.starts_with("on:") || c.starts_with("off:")));
    }

    #[test]
    fn the_power_off_can_be_disabled() {
        let ops = FakeOps::new(vec![pod("pod1", false, "3042370764")], vec![vec![code("ABCD-1234"), StreamItem::Event(SessionEvent::Linked)]]);
        let (results, _) = run(&ops, &[target("tester1", "pod1")], &Options { power_off_after: false, dry_run: false });
        assert!(results[0].ok);
        assert!(!ops.calls().contains(&"off:pod1".to_string()));
    }

    #[test]
    fn pods_are_processed_one_at_a_time_in_order() {
        let ops = FakeOps::new(
            vec![pod("pod1", false, "3042370764"), pod("pod2", false, "3109998877")],
            vec![vec![code("AAAA-1111"), StreamItem::Event(SessionEvent::Linked)], vec![code("BBBB-2222"), StreamItem::Event(SessionEvent::Linked)]],
        );
        let (results, events) = run(&ops, &[target("tester1", "pod1"), target("tester2", "pod2")], &NORMAL);
        assert!(results.iter().all(|r| r.ok));
        let calls = ops.calls();
        let off1 = calls.iter().position(|c| c == "off:pod1").unwrap();
        let on2 = calls.iter().position(|c| c == "on:pod2").unwrap();
        assert!(off1 < on2, "pod1 must be off before pod2 turns on: {calls:?}");
        assert_eq!(events.iter().filter(|e| e.stage == Stage::Queued).count(), 2);
        assert!(events.iter().any(|e| e.index == 2 && e.total == 2 && e.stage == Stage::PoweringOn));
    }

    #[test]
    fn when_typing_fails_the_code_is_shown_for_a_manual_finish_and_the_pod_stays_on() {
        let ops = FakeOps::new(vec![pod("pod1", false, "3042370764")], vec![vec![code("ABCD-1234")]]);
        *ops.drive_result.borrow_mut() = Err(DriveError {
            code: "ELEMENT_NOT_FOUND".into(),
            message: "No encontré el botón.".into(),
            manual_hint: Some("Termina a mano en la ventana del pod.".into()),
        });
        let (results, events) = run(&ops, &[target("tester1", "pod1")], &NORMAL);

        let manual = events.iter().find(|e| e.stage == Stage::Manual).expect("manual stage");
        assert_eq!(manual.code.as_deref(), Some("ABCD-1234"));
        assert!(manual.message.contains("Termina a mano"));
        assert_eq!(results[0].stage, Stage::Failed); // the session timed out afterwards
        assert_eq!(results[0].code.as_deref(), Some("ABCD-1234"));
    }

    #[test]
    fn a_manual_finish_that_links_in_time_counts_as_linked_and_powers_off() {
        let ops = FakeOps::new(
            vec![pod("pod1", false, "3042370764")],
            vec![vec![code("ABCD-1234"), StreamItem::Timeout, StreamItem::Event(SessionEvent::Linked)]],
        );
        *ops.drive_result.borrow_mut() = Err(DriveError { code: "NO_PROGRESS".into(), message: "x".into(), manual_hint: None });
        let (results, _) = run(&ops, &[target("tester1", "pod1")], &NORMAL);
        assert!(results[0].ok);
        assert!(ops.calls().contains(&"off:pod1".to_string()));
    }

    #[test]
    fn a_repeated_code_is_typed_only_once() {
        let ops = FakeOps::new(vec![pod("pod1", true, "3042370764")], vec![vec![code("ABCD-1234"), code("ABCD-1234"), StreamItem::Event(SessionEvent::Linked)]]);
        run(&ops, &[target("tester1", "pod1")], &NORMAL);
        assert_eq!(ops.calls().iter().filter(|c| c.starts_with("drive:")).count(), 1);
    }

    #[test]
    fn a_rotated_code_is_typed_again() {
        let ops = FakeOps::new(vec![pod("pod1", true, "3042370764")], vec![vec![code("AAAA-1111"), code("BBBB-2222"), StreamItem::Event(SessionEvent::Linked)]]);
        run(&ops, &[target("tester1", "pod1")], &NORMAL);
        assert_eq!(ops.calls().iter().filter(|c| c.starts_with("drive:")).count(), 2);
    }

    #[test]
    fn engine_errors_fail_the_pod_but_not_the_queue_and_the_pod_is_turned_off() {
        let ops = FakeOps::new(
            vec![pod("pod1", false, "3042370764"), pod("pod2", true, "3109998877")],
            vec![
                vec![StreamItem::Event(SessionEvent::Error { code: "PAIRING_REFUSED".into(), message: "WhatsApp no dio código".into() })],
                vec![code("BBBB-2222"), StreamItem::Event(SessionEvent::Linked)],
            ],
        );
        let (results, _) = run(&ops, &[target("tester1", "pod1"), target("tester2", "pod2")], &NORMAL);
        assert!(!results[0].ok);
        assert_eq!(results[0].message, "WhatsApp no dio código");
        assert!(results[1].ok);
        assert!(ops.calls().contains(&"off:pod1".to_string()));
    }

    #[test]
    fn a_pod_that_never_becomes_ready_fails_clearly() {
        let ops = FakeOps::new(vec![pod("pod1", false, "3042370764")], vec![]);
        *ops.ready.borrow_mut() = Err(DriveError { code: "NOT_READY".into(), message: "Android sigue arrancando".into(), manual_hint: None });
        let (results, _) = run(&ops, &[target("tester1", "pod1")], &NORMAL);
        assert!(!results[0].ok);
        assert!(results[0].message.contains("Android"));
        assert!(!ops.calls().iter().any(|c| c.starts_with("session:")));
        assert!(ops.calls().contains(&"off:pod1".to_string()));
    }

    #[test]
    fn a_session_that_closes_without_linking_is_a_failure() {
        let ops = FakeOps::new(vec![pod("pod1", true, "3042370764")], vec![vec![StreamItem::Closed]]);
        let (results, _) = run(&ops, &[target("tester1", "pod1")], &NORMAL);
        assert_eq!(results[0].stage, Stage::Failed);
    }

    #[test]
    fn a_missing_pod_fails_without_touching_anything() {
        let ops = FakeOps::new(vec![], vec![]);
        let (results, _) = run(&ops, &[target("tester1", "ghost")], &NORMAL);
        assert!(!results[0].ok);
        assert!(ops.calls().is_empty());
    }

    #[test]
    fn dry_run_never_powers_or_starts_a_session() {
        let ops = FakeOps::new(vec![pod("pod1", false, "3042370764"), pod("pod2", true, "3109998877")], vec![]);
        let (results, events) = run(&ops, &[target("tester1", "pod1"), target("tester2", "pod2")], &Options { power_off_after: true, dry_run: true });
        assert!(results.iter().all(|r| r.ok && r.stage == Stage::DryRun));
        // Only a read-only screen check on the pod that is already on.
        assert_eq!(ops.calls(), vec!["drive:ABCD1234:true"]);
        assert!(events.iter().any(|e| e.message.contains("Simulación")));
    }

    #[test]
    fn cancelling_stops_before_the_next_step() {
        let mut ops = FakeOps::new(
            vec![pod("pod1", false, "3042370764"), pod("pod2", false, "3109998877")],
            vec![vec![code("AAAA-1111"), StreamItem::Event(SessionEvent::Linked)]],
        );
        ops.cancel_after_calls = Some(1); // cancelled as soon as the first pod was powered on
        let (results, _) = run(&ops, &[target("tester1", "pod1"), target("tester2", "pod2")], &NORMAL);
        assert!(results.iter().all(|r| r.stage == Stage::Cancelled));
        assert!(!ops.calls().iter().any(|c| c.starts_with("session:")));
    }

    #[test]
    fn pretty_code_adds_the_dash_only_for_eight_characters() {
        assert_eq!(pretty_code("ABCD1234"), "ABCD-1234");
        assert_eq!(pretty_code("ABCD-1234"), "ABCD-1234");
        assert_eq!(pretty_code("XYZ"), "XYZ");
    }
}
