//! Small helpers shared by the command modules.

use std::process::Command;
use std::sync::{Mutex, MutexGuard};

/// Locks a mutex even when a thread panicked while holding it: the data is plain state, and taking the app down
/// because of an old panic would turn one failure into a restart.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

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

/// Digits only, with the Colombian country code removed (12 digits starting with 57), so that
/// 57XXXXXXXXXX and XXXXXXXXXX compare equal. Same rule as `phoneKey` in the warm-up engine.
pub fn phone_key(input: &str) -> String {
    let digits: String = input.chars().filter(char::is_ascii_digit).collect();
    if digits.len() == 12 && digits.starts_with("57") { digits[2..].to_string() } else { digits }
}

/// Phone as stored in pods-wsp.json: digits only, 10 digits for Colombian lines (no 57), 7-15 digits otherwise.
/// Blank input means "no phone" (`None`).
pub fn pods_phone(input: &str) -> Result<Option<String>, String> {
    if input.trim().is_empty() {
        return Ok(None);
    }
    let key = phone_key(input);
    if (7..=15).contains(&key.len()) {
        Ok(Some(key))
    } else {
        Err("El número debe tener entre 7 y 15 dígitos (para Colombia, 10 dígitos que empiecen por 3).".to_string())
    }
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
    fn pod_phone_keeps_the_ten_digit_format_of_pods_wsp() {
        assert_eq!(pods_phone("304 237 4349").unwrap(), Some("3042374349".to_string()));
        assert_eq!(pods_phone("+57 304 237 4349").unwrap(), Some("3042374349".to_string()));
        assert_eq!(pods_phone("573042374349").unwrap(), Some("3042374349".to_string()));
        assert_eq!(pods_phone("14155550123").unwrap(), Some("14155550123".to_string()));
        assert_eq!(pods_phone("   ").unwrap(), None);
        assert!(pods_phone("12345").is_err());
        assert!(pods_phone("1234567890123456").is_err());
    }

    #[test]
    fn phone_key_matches_with_and_without_country_code() {
        assert_eq!(phone_key("573042374349"), phone_key("304 237 4349"));
        assert_eq!(phone_key("+57 304 237 4349"), "3042374349");
        assert_eq!(phone_key("abc"), "");
    }

    #[test]
    fn a_poisoned_mutex_is_still_usable() {
        let m = std::sync::Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.lock().is_err());
        *lock(&m) += 1;
        assert_eq!(*lock(&m), 2);
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
