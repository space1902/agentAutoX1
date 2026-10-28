//! App settings (paths), persisted as `settings.json` in the Tauri app config dir.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Warm-up data: config.json, profiles.json, .baileys_auth/, results/, .env (AGENTAUTO_DATA_DIR).
    pub data_dir: String,
    /// Folder with the warm-up engine code (perfil.js).
    pub warmup_dir: String,
    /// Folder with pods.ps1.
    pub pods_dir: String,
    /// WhatsApp Business APK root (AGENTAUTO_APK_DIR; pods.ps1 appends `business`).
    pub apk_dir: String,
    /// pods-wsp.json: instance id -> phone (AGENTAUTO_PODS_WSP_FILE).
    pub pods_wsp_file: String,
    /// Node executable.
    pub node_path: String,
}

/// Locates the agentAutoX1 folder: walks up from the executable looking for `engines/warmup`,
/// falling back to the folder this crate was compiled in (dev builds).
pub fn find_project_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            if ancestor.join("engines").join("warmup").is_dir() {
                return ancestor.to_path_buf();
            }
        }
    }
    // app/src-tauri -> app -> agentAutoX1
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn s(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

impl Settings {
    /// Defaults: engines inside the project, data/APK/pods-wsp in the ORIGINAL sibling projects
    /// so WhatsApp sessions and APKs are never duplicated.
    pub fn defaults(root: &Path) -> Settings {
        let sibling = root.parent().unwrap_or(root);
        Settings {
            data_dir: s(sibling.join("whatsapp-bot-tester")),
            warmup_dir: s(root.join("engines").join("warmup")),
            pods_dir: s(root.join("engines").join("pods")),
            apk_dir: s(sibling.join("whatsapp-pods").join("apk")),
            pods_wsp_file: s(sibling.join("whatsapp-pods").join("pods-wsp.json")),
            node_path: "node".to_string(),
        }
    }

    /// Saved values win; blank or missing fields fall back to the defaults.
    pub fn merge_saved(root: &Path, saved: &serde_json::Value) -> Settings {
        let mut out = Settings::defaults(root);
        let pick = |key: &str, slot: &mut String| {
            if let Some(v) = saved.get(key).and_then(|v| v.as_str()) {
                if !v.trim().is_empty() {
                    *slot = v.trim().to_string();
                }
            }
        };
        pick("dataDir", &mut out.data_dir);
        pick("warmupDir", &mut out.warmup_dir);
        pick("podsDir", &mut out.pods_dir);
        pick("apkDir", &mut out.apk_dir);
        pick("podsWspFile", &mut out.pods_wsp_file);
        pick("nodePath", &mut out.node_path);
        out
    }

    pub fn load(file: &Path, root: &Path) -> Settings {
        let saved = fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        Settings::merge_saved(root, &saved)
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear {}: {e}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(file, text).map_err(|e| format!("No se pudo guardar {}: {e}", file.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &str) -> String {
        s.replace('\\', "/")
    }

    #[test]
    fn defaults_point_at_original_sibling_projects() {
        let root = Path::new("C:/p/agentAutoX1");
        let d = Settings::defaults(root);
        assert!(norm(&d.data_dir).ends_with("p/whatsapp-bot-tester"));
        assert!(norm(&d.apk_dir).ends_with("p/whatsapp-pods/apk"));
        assert!(norm(&d.pods_wsp_file).ends_with("whatsapp-pods/pods-wsp.json"));
        assert!(norm(&d.pods_dir).ends_with("agentAutoX1/engines/pods"));
        assert_eq!(d.node_path, "node");
    }

    #[test]
    fn saved_values_override_and_blank_falls_back() {
        let root = Path::new("C:/p/agentAutoX1");
        let saved = serde_json::json!({ "dataDir": " D:/data ", "nodePath": "  " });
        let m = Settings::merge_saved(root, &saved);
        assert_eq!(m.data_dir, "D:/data");
        assert_eq!(m.node_path, "node");
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("agentautox1-settings-{}", std::process::id()));
        let file = dir.join("settings.json");
        let root = Path::new("C:/p/agentAutoX1");
        let mut s = Settings::defaults(root);
        s.node_path = "C:/node/node.exe".into();
        s.save(&file).unwrap();
        assert_eq!(Settings::load(&file, root), s);
        let _ = fs::remove_dir_all(dir);
    }
}
