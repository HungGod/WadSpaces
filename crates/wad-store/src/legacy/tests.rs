//! Every case Python's parse_config was given (fixtures/python-state/configs.json):
//! the same files are accepted, the same refused (for the same workspace),
//! and accepted ones give the same workspaces, field by field.

use serde_json::{Value, json};
use wad_proto::v1::{Display, Workspace};

use super::*;

const CASES: &str = include_str!("../../../../fixtures/python-state/configs.json");

/// A workspace as Python's asdict(WorkspaceSpec) has it.
fn as_python(w: &Workspace) -> Value {
    let env: serde_json::Map<String, Value> =
        w.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    json!({
        "id": w.id, "name": w.name, "image": w.image, "port": w.port, "hotkey": w.hotkey, "icon": w.icon,
        "enabled": w.enabled, "container_name": w.container_name, "container_port": w.container_port,
        "env": env, "secrets": w.secrets, "volumes": w.volumes, "devices": w.devices, "shm_size": w.shm_size,
        "autostart": w.autostart, "display": if w.display == Display::Host { "host" } else { "stream" },
        "projects": w.projects.iter().map(|p| match &p.path {
            Some(path) => json!({ "id": p.id, "mount": p.mount, "path": path }),
            None => json!({ "id": p.id, "mount": p.mount }),
        }).collect::<Vec<_>>(),
    })
}

#[test]
fn reads_what_python_reads() {
    let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
    assert!(cases.len() >= 20);
    for c in &cases {
        let name = c["name"].as_str().unwrap();
        let yaml_text = c["yaml"].as_str().unwrap();
        let data: Value =
            if yaml_text.trim().is_empty() { json!({}) } else { serde_norway::from_str(yaml_text).unwrap() };
        let data = if data.is_null() { json!({}) } else { data };
        let got = parse(&data);
        match (c.get("error"), got) {
            (Some(want), Err(e)) => {
                // The same complaint about the same place (Python prints its
                // values with repr, so only the start must match).
                let want = want.as_str().unwrap();
                let where_ = want.split(':').next().unwrap();
                assert!(e.to_string().starts_with(where_), "{name}: want {want:?}, got {e}");
            }
            (None, Ok(cfg)) => {
                assert_eq!(cfg.machine_name, c["machine"].as_str().unwrap(), "{name}");
                assert_eq!(cfg.cloud.is_some(), c["cloud"].as_bool().unwrap(), "{name}");
                let ours: Vec<Value> = cfg.workspaces.iter().map(as_python).collect();
                assert_eq!(Value::Array(ours), c["workspaces"], "{name}");
            }
            (Some(want), Ok(_)) => panic!("{name}: Python refused it ({want}), we didn't"),
            (None, Err(e)) => panic!("{name}: Python took it, we refused: {e}"),
        }
    }
}

#[test]
fn the_vendor_cloud_file_wins() {
    let d = tempfile::tempdir().unwrap();
    let yaml = d.path().join("workspaces.yaml");
    std::fs::write(&yaml, "cloud: {project_id: old, heartbeat_s: 5}\nworkspaces: []\n").unwrap();
    let vendor = d.path().join("cloud.yaml");
    std::fs::write(&vendor, "project_id: wad-spaces\n").unwrap();
    let c = read(&yaml, Some(&vendor)).unwrap().cloud.unwrap();
    assert_eq!(c["project_id"], "wad-spaces");
    assert_eq!(c["heartbeat_s"], 5);
    assert!(
        matches!(read(&d.path().join("nope.yaml"), None), Err(Error::Config(m)) if m.starts_with("config not found"))
    );
}

#[test]
fn workspaces_round_trip_through_the_yaml_shape() {
    let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
    let mut checked = 0;
    for c in &cases {
        let text = c["yaml"].as_str().unwrap();
        let data: Value = if text.trim().is_empty() { json!({}) } else { serde_norway::from_str(text).unwrap() };
        let data = if data.is_null() { json!({}) } else { data };
        let Ok(cfg) = parse(&data) else { continue };
        let again = check_workspaces(cfg.workspaces.iter().map(to_yaml).collect()).unwrap();
        assert_eq!(again, cfg.workspaces, "{}", c["name"]);
        checked += cfg.workspaces.len();
    }
    assert!(checked > 10);
    // Checked together: a second workspace on the same port is refused.
    let one = to_yaml(
        &check_workspaces(vec![serde_json::json!({"id": "a", "name": "A", "image": "i", "port": 3100})]).unwrap()[0],
    );
    let mut two = one.clone();
    two["id"] = "b".into();
    two["container_name"] = "wad-b".into();
    let e = check_workspaces(vec![one, two]).unwrap_err();
    assert!(e.to_string().contains("port 3100 already used"), "{e}");
}
