//! Read-only views over the warm-up data dir (profiles.json, config.json, .baileys_auth) and pods-wsp.json.
//! Only non-sensitive fields are returned (never proxies, tokens or session contents).

use crate::settings::Settings;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tester {
    pub id: String,
    pub phone: Option<String>,
    /// A linked WhatsApp session exists (.baileys_auth/<id>/creds.json has `me.id`).
    pub has_session: bool,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub testers: Vec<String>,
    pub group_name: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WarmupData {
    pub profiles: Vec<Profile>,
    pub testers: Vec<Tester>,
    pub default_group: Option<String>,
}

fn read_json(file: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(file).map_err(|e| format!("No se pudo leer {}: {e}", file.display()))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{} no es JSON válido: {e}", file.display()))
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// config.json `testers` entries are either "tester1" or { "id": "tester15", "phone": "..." }.
pub fn parse_testers(config: &Value) -> Vec<(String, Option<String>)> {
    config
        .get("testers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| match entry {
                    Value::String(id) => Some((id.clone(), None)),
                    Value::Object(_) => non_empty(entry.get("id")).map(|id| (id, non_empty(entry.get("phone")))),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_profiles(profiles: &Value) -> Vec<Profile> {
    profiles
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(name, p)| Profile {
                    name: name.clone(),
                    testers: p
                        .get("testers")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    group_name: non_empty(p.get("groupName")),
                    created_at: non_empty(p.get("createdAt")),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn has_session(auth_dir: &Path, id: &str) -> bool {
    fs::read_to_string(auth_dir.join(id).join("creds.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|c| c.pointer("/me/id").is_some_and(|v| !v.is_null()))
        .unwrap_or(false)
}

pub fn profile_exists(settings: &Settings, name: &str) -> Result<bool, String> {
    let profiles = read_json(&Path::new(&settings.data_dir).join("profiles.json"))?;
    Ok(profiles.get(name).is_some_and(Value::is_object))
}

pub fn read_warmup(settings: &Settings) -> Result<WarmupData, String> {
    let dir = Path::new(&settings.data_dir);
    let profiles = parse_profiles(&read_json(&dir.join("profiles.json"))?);
    let config = read_json(&dir.join("config.json"))?;
    let auth = dir.join(".baileys_auth");
    let testers = parse_testers(&config)
        .into_iter()
        .map(|(id, phone)| {
            let has_session = has_session(&auth, &id);
            Tester { id, phone, has_session }
        })
        .collect();
    Ok(WarmupData { profiles, testers, default_group: non_empty(config.get("groupName")) })
}

/// pods-wsp.json: instance id -> phone. A missing file is an empty map.
pub fn read_pods_wsp(settings: &Settings) -> Result<BTreeMap<String, String>, String> {
    let file = Path::new(&settings.pods_wsp_file);
    if !file.exists() {
        return Ok(BTreeMap::new());
    }
    let value = read_json(file)?;
    Ok(value
        .as_object()
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn testers_accept_strings_and_objects() {
        let cfg = json!({ "testers": ["tester1", { "id": "tester15", "phone": "3001112233" }, { "id": "t2" }, 5] });
        assert_eq!(
            parse_testers(&cfg),
            vec![
                ("tester1".to_string(), None),
                ("tester15".to_string(), Some("3001112233".to_string())),
                ("t2".to_string(), None),
            ]
        );
    }

    #[test]
    fn profiles_keep_group_and_testers() {
        let p = json!({ "cal": { "testers": ["tester1", "tester2"], "groupName": "G", "createdAt": "2026-01-01" }, "b": {} });
        let list = parse_profiles(&p);
        let cal = list.iter().find(|p| p.name == "cal").unwrap();
        assert_eq!(cal.testers, vec!["tester1", "tester2"]);
        assert_eq!(cal.group_name.as_deref(), Some("G"));
        assert!(list.iter().find(|p| p.name == "b").unwrap().testers.is_empty());
    }

    #[test]
    fn missing_pods_wsp_is_empty() {
        let mut s = Settings::defaults(Path::new("C:/nope"));
        s.pods_wsp_file = "C:/definitely/not/here.json".into();
        assert!(read_pods_wsp(&s).unwrap().is_empty());
    }
}
