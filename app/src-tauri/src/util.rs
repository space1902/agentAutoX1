//! Small helpers shared by the command modules.

use std::process::Command;

/// Windows flag: do not flash a console window for child processes.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Builds a command that never opens a console window on Windows.
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Like `hidden_command`, but in its own process group so only Ctrl+Break (not Ctrl+C) reaches it.
/// The app uses this to stop warm-up runs gracefully without touching any other console process.
pub fn hidden_group_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    cmd
}

/// Pod names accepted by pods.ps1 (`Test-NombrePod`): letters, digits, `-` and `_`, max 24 chars.
pub fn is_valid_pod_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    name.len() <= 24 && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_pod_names() {
        assert!(is_valid_pod_name("pod2"));
        assert!(is_valid_pod_name("a_b-c"));
        assert!(is_valid_pod_name(&"a".repeat(24)));
    }

    #[test]
    fn rejects_invalid_pod_names() {
        assert!(!is_valid_pod_name(""));
        assert!(!is_valid_pod_name("-x"));
        assert!(!is_valid_pod_name("with space"));
        assert!(!is_valid_pod_name("a;b"));
        assert!(!is_valid_pod_name(&"a".repeat(25)));
    }
}
