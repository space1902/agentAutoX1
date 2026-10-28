//! Real side effects for the pod linker: PowerShell (pods.ps1), the two Node CLIs and adb through them.
//! Nothing here decides anything; the flow lives in `linker.rs`.

use crate::linker::{DriveError, LinkOps, SessionEvent, SessionStream, StreamItem, parse_driver_output, parse_session_event};
use crate::pods::{self, BlueStacksInfo, Pod};
use crate::settings::Settings;
use crate::util::hidden_command;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::Arc;
use std::time::Duration;

pub struct RealOps {
    settings: Settings,
    adb: String,
    cancel: Arc<AtomicBool>,
}

impl RealOps {
    pub fn new(settings: Settings, cancel: Arc<AtomicBool>) -> Result<RealOps, String> {
        let BlueStacksInfo { adb, .. } = pods::bluestacks_info(&settings)?;
        Ok(RealOps { settings, adb, cancel })
    }

    fn node(&self, script: &str) -> std::process::Command {
        let mut cmd = hidden_command(&self.settings.node_path);
        cmd.arg(script)
            .current_dir(&self.settings.warmup_dir)
            .env("AGENTAUTO_DATA_DIR", &self.settings.data_dir)
            .stdin(Stdio::null());
        cmd
    }

    fn driver(&self, args: &[&str]) -> Result<(), DriveError> {
        let out = self
            .node("pod-driver-cli.js")
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| DriveError { code: "SPAWN".into(), message: format!("No se pudo iniciar Node ({}): {e}", self.settings.node_path), manual_hint: None })?;
        parse_driver_output(&String::from_utf8_lossy(&out.stdout))
    }
}

struct ProcessStream {
    rx: Receiver<SessionEvent>,
    child: Child,
}

/// Starts the command and turns its JSON lines into `SessionEvent`s on a channel.
fn spawn_session(mut cmd: std::process::Command) -> std::io::Result<ProcessStream> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(event) = parse_session_event(&line) {
                if tx.send(event).is_err() {
                    break;
                }
            }
        }
    });
    Ok(ProcessStream { rx, child })
}

impl SessionStream for ProcessStream {
    fn next(&mut self, wait: Duration) -> StreamItem {
        match self.rx.recv_timeout(wait) {
            Ok(event) => StreamItem::Event(event),
            Err(RecvTimeoutError::Timeout) => StreamItem::Timeout,
            Err(RecvTimeoutError::Disconnected) => StreamItem::Closed,
        }
    }

    /// Gives the CLI a moment to close its Baileys socket on its own, then kills only this child.
    fn close(&mut self) {
        for _ in 0..30 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ProcessStream {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl LinkOps for RealOps {
    fn pod(&self, name: &str) -> Result<Pod, String> {
        pods::list(&self.settings)?.into_iter().find(|p| p.name == name).ok_or_else(|| format!("No existe el pod «{name}»."))
    }

    fn power_on(&self, name: &str) -> Result<(), String> {
        pods::run_action(&self.settings, "prender", name).map(|_| ())
    }

    fn power_off(&self, name: &str) -> Result<(), String> {
        pods::run_action(&self.settings, "apagar", name).map(|_| ())
    }

    fn wait_ready(&self, serial: &str) -> Result<(), DriveError> {
        self.driver(&["ready", "--adb", &self.adb, "--serial", serial, "--timeout", "240"])
    }

    fn start_session(&self, tester_id: &str) -> Result<Box<dyn SessionStream>, String> {
        let mut cmd = self.node("link-session-cli.js");
        cmd.args(["--tester", tester_id]);
        spawn_session(cmd).map(|s| Box::new(s) as Box<dyn SessionStream>).map_err(|e| format!("No se pudo iniciar Node ({}): {e}", self.settings.node_path))
    }

    fn drive(&self, serial: &str, code: &str, dry_run: bool) -> Result<(), DriveError> {
        let mut args = vec!["link", "--adb", &self.adb, "--serial", serial, "--code", code];
        if dry_run {
            args.push("--dry-run");
        }
        self.driver(&args)
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_the_json_lines_of_a_child_into_events_and_then_closes() {
        let mut cmd = hidden_command("node");
        cmd.args([
            "-e",
            "console.log('noise');console.log(JSON.stringify({event:'code',code:'ABCD-1234'}));console.log(JSON.stringify({event:'linked'}))",
        ]);
        let mut stream = spawn_session(cmd).unwrap();
        let wait = Duration::from_secs(10);
        assert!(matches!(stream.next(wait), StreamItem::Event(SessionEvent::Code(c)) if c == "ABCD-1234"));
        assert!(matches!(stream.next(wait), StreamItem::Event(SessionEvent::Linked)));
        assert!(matches!(stream.next(wait), StreamItem::Closed));
        stream.close();
    }

    #[test]
    fn close_kills_a_child_that_does_not_exit_and_a_silent_child_times_out() {
        let mut cmd = hidden_command("node");
        cmd.args(["-e", "setInterval(()=>{},1000)"]);
        let mut stream = spawn_session(cmd).unwrap();
        assert!(matches!(stream.next(Duration::from_millis(100)), StreamItem::Timeout));
        stream.close();
        assert!(matches!(stream.child.try_wait(), Ok(Some(_))));
    }
}
