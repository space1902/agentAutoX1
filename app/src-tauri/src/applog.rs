//! Application log: `<data dir>/logs/app.log`. It records every start of the app, Rust panics (with a backtrace) and
//! the errors the UI reports, so a "the app restarted by itself" can be told apart from a development rebuild.
//! Logging never fails the caller: any I/O problem is swallowed.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn dir_slot() -> &'static Mutex<Option<PathBuf>> {
    static SLOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Where logs go: the data directory of the app (changes when the user changes it in Ajustes).
pub fn set_data_dir(dir: &Path) {
    *crate::util::lock(dir_slot()) = Some(dir.to_path_buf());
}

pub fn log_file() -> PathBuf {
    let base = crate::util::lock(dir_slot()).clone().unwrap_or_else(std::env::temp_dir);
    base.join("logs").join("app.log")
}

/// UTC "2026-10-29T18:07:03Z" from Unix seconds (civil-from-days, no external crates).
pub fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// One log entry: control characters are removed so a message can never forge extra lines, and size is capped.
pub fn format_entry(kind: &str, message: &str, secs: u64) -> String {
    let clean: String = message.chars().map(|c| if c == '\n' { '\u{23ce}' } else { c }).filter(|c| !c.is_control()).take(6_000).collect();
    let kind: String = kind.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(24).collect();
    format!("{} [{}] {}\n", iso_utc(secs), kind, clean)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn append(path: &Path, entry: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(entry.as_bytes());
    }
}

pub fn log(kind: &str, message: &str) {
    append(&log_file(), &format_entry(kind, message, now_secs()));
}

pub fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    let text = payload.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic sin texto".to_string());
    let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
    let thread = std::thread::current().name().unwrap_or("sin-nombre").to_string();
    format!("hilo «{thread}» en {place}: {text} | {}", std::backtrace::Backtrace::force_capture().to_string().lines().map(str::trim).filter(|l| l.contains("app_lib") || l.contains("agentAutoX1")).take(12).collect::<Vec<_>>().join(" <- "))
}

/// Writes every panic to the log and then lets the default hook run (so the console still shows it).
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log("panic", &panic_message(info));
        previous(info);
    }));
}

/// Errors reported by the UI (render errors, unhandled rejections). Sizes are capped.
pub fn log_client(kind: &str, message: &str, stack: Option<&str>) {
    let text = match stack {
        Some(s) if !s.is_empty() => format!("{} | {}", message.chars().take(1_500).collect::<String>(), s.chars().take(2_500).collect::<String>()),
        _ => message.chars().take(1_500).collect(),
    };
    log(&format!("ui-{kind}"), &text);
}

#[cfg(test)]
mod tests {
    use super::*;

    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn dates_are_formatted_in_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_793_311_720), "2026-10-29T22:08:40Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn entries_cannot_forge_lines_or_kinds() {
        let e = format_entry("pa nic;\n", "boom\nFAKE [panic] line\u{7}", 0);
        assert_eq!(e.matches('\n').count(), 1, "one entry, one line");
        assert!(e.starts_with("1970-01-01T00:00:00Z [panic] "));
        assert!(!e.contains('\u{7}'));
    }

    #[test]
    fn appends_and_rotates_big_files() {
        let dir = std::env::temp_dir().join(format!("agentautox1-applog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("logs").join("app.log");
        append(&file, "uno\n");
        append(&file, "dos\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "uno\ndos\n");
        std::fs::write(&file, vec![b'x'; (MAX_BYTES + 10) as usize]).unwrap();
        append(&file, "nuevo\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "nuevo\n");
        assert!(file.with_extension("log.1").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_panic_is_logged_with_its_location_and_message() {
        let _serial = crate::util::lock(&SERIAL);
        let dir = std::env::temp_dir().join(format!("agentautox1-applog-panic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        set_data_dir(&dir);
        install_panic_hook();
        let handle = std::thread::Builder::new().name("hilo-de-prueba".into()).spawn(|| panic!("fallo simulado")).unwrap();
        assert!(handle.join().is_err());
        let text = std::fs::read_to_string(log_file()).unwrap();
        assert!(text.contains("[panic]") && text.contains("fallo simulado") && text.contains("hilo-de-prueba"), "{text}");
        let _ = std::panic::take_hook();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ui_errors_are_logged_with_a_prefix() {
        let _serial = crate::util::lock(&SERIAL);
        let dir = std::env::temp_dir().join(format!("agentautox1-applog-ui-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        set_data_dir(&dir);
        log_client("render", "Cannot read properties of undefined", Some("at Anuncios"));
        let text = std::fs::read_to_string(log_file()).unwrap();
        assert!(text.contains("[ui-render] Cannot read properties of undefined | at Anuncios"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
