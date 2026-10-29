//! Windows toast notifications without extra crates: a hidden PowerShell call. The text travels in environment
//! variables, never inside the script, so no content can be interpreted as code.

use crate::util::hidden_command;
use std::process::Stdio;

const TITLE_ENV: &str = "AGENTAUTO_TOAST_TITLE";
const BODY_ENV: &str = "AGENTAUTO_TOAST_BODY";
/// AppUserModelID of Windows PowerShell: a registered id, so the toast is shown for an unpackaged app.
const APP_ID: &str = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";

pub fn toast_script() -> String {
    format!(
        "$ErrorActionPreference='Stop';\
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;\
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);\
$n=$t.GetElementsByTagName('text');\
$n.Item(0).AppendChild($t.CreateTextNode($env:{TITLE_ENV})) | Out-Null;\
$n.Item(1).AppendChild($t.CreateTextNode($env:{BODY_ENV})) | Out-Null;\
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($t))"
    )
}

pub fn clip(text: &str, max: usize) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    if clean.chars().count() <= max { clean } else { format!("{}…", clean.chars().take(max - 1).collect::<String>()) }
}

/// Best effort: a failed toast never matters (the in-app banner is the reliable channel).
pub fn toast(title: &str, body: &str) {
    let _ = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &toast_script()])
        .env(TITLE_ENV, clip(title, 120))
        .env(BODY_ENV, clip(body, 400))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_reads_text_from_the_environment_only() {
        let s = toast_script();
        assert!(s.contains("$env:AGENTAUTO_TOAST_TITLE") && s.contains("$env:AGENTAUTO_TOAST_BODY"));
        assert!(s.contains("ToastText02"));
    }

    #[test]
    fn clipping_removes_control_characters_and_long_text() {
        assert_eq!(clip("a\nb\tc", 10), "abc");
        assert_eq!(clip(&"x".repeat(50), 10).chars().count(), 10);
        assert!(clip(&"x".repeat(50), 10).ends_with('…'));
        assert_eq!(clip("Prueba: día 4", 120), "Prueba: día 4");
    }
}
