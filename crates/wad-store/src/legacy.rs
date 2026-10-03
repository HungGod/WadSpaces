//! The Python wadd's configuration, /etc/wadspaces/workspaces.yaml, read the
//! way its config.py does (parse_config): the same defaults, the same old
//! names and dropped keys, and the same checks, so a file Python accepted is
//! accepted here and the workspaces come out the same.

use std::path::Path;

use serde_json::{Map, Value};
use wad_proto::v1::{Display, MountedProject, Workspace};

use crate::Error;

/// Keys older wadds wrote that are gone: dropped on load.
const DEPRECATED_DAEMON: &[&str] = &["base_registry"];
const DEPRECATED_CLOUD: &[&str] = &["storage_bucket", "storage_base", "files_every_s"];

const WORKSPACE_KEYS: &[&str] = &[
    "id",
    "name",
    "image",
    "port",
    "hotkey",
    "icon",
    "enabled",
    "container_name",
    "container_port",
    "env",
    "secrets",
    "volumes",
    "devices",
    "shm_size",
    "autostart",
    "display",
    "projects",
];
const DAEMON_KEYS: &[&str] = &[
    "bind",
    "port",
    "backend",
    "systemd_scope",
    "podman_socket",
    "cdp_url",
    "keys",
    "ready_timeout_s",
    "quadlet_dir",
    "secrets_dir",
    "state_dir",
    "prefetch",
    "prefetch_min_free_gb",
    "max_parallel_pulls",
    "build_min_free_gb",
    "projects_dir",
    "projects_uid",
    "tailscale_socket",
    "tailscale_bin",
    "tailnet_streams",
    "folder_roots",
];
const KEYS_KEYS: &[&str] = &["enabled", "launcher", "block", "pass_super", "grab"];

/// What the Rust wadd takes from the old file.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyConfig {
    pub machine_name: String,
    /// The daemon section as written (minus dropped keys); defaults are the caller's.
    pub daemon: Map<String, Value>,
    /// The cloud section, with /usr/lib/wadspaces/cloud.yaml's keys over it.
    pub cloud: Option<Map<String, Value>>,
    pub workspaces: Vec<Workspace>,
}

impl LegacyConfig {
    fn daemon_str(&self, key: &str, default: &str) -> String {
        self.daemon.get(key).and_then(Value::as_str).unwrap_or(default).to_string()
    }
    pub fn state_dir(&self) -> String {
        self.daemon_str("state_dir", "/var/lib/wadspaces")
    }
    pub fn quadlet_dir(&self) -> String {
        self.daemon_str("quadlet_dir", "/etc/containers/systemd")
    }
    pub fn projects_dir(&self) -> String {
        self.daemon_str("projects_dir", "/var/lib/wadspaces-projects")
    }
}

fn err(msg: impl Into<String>) -> Error {
    Error::Config(msg.into())
}

fn yaml(path: &Path) -> Result<Option<Value>, Error> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::Io(path.display().to_string(), e)),
    };
    let v: Value = serde_norway::from_str(&text).map_err(|e| Error::Yaml(path.display().to_string(), e.to_string()))?;
    Ok(Some(if v.is_null() { Value::Object(Map::new()) } else { v }))
}

/// Reads the file (and the image's cloud.yaml, whose keys win).
pub fn read(path: &Path, vendor_cloud: Option<&Path>) -> Result<LegacyConfig, Error> {
    let mut data = yaml(path)?.ok_or_else(|| err(format!("config not found: {}", path.display())))?;
    if let Some(vc) = vendor_cloud
        && let Some(Value::Object(vendor)) = yaml(vc)?
        && !vendor.is_empty()
    {
        let mut cloud = data.get("cloud").and_then(Value::as_object).cloned().unwrap_or_default();
        cloud.extend(vendor);
        if let Value::Object(d) = &mut data {
            d.insert("cloud".into(), Value::Object(cloud));
        }
    }
    parse(&data)
}

/// Where a value (or a key) holds a control character, if anywhere: the
/// key's name, or "a key".
fn control_chars(v: &Value) -> Option<String> {
    let bad = |s: &str| s.chars().any(char::is_control);
    match v {
        Value::String(s) if bad(s) => Some("a value".into()),
        Value::Array(a) => a.iter().find_map(control_chars),
        Value::Object(m) => m.iter().find_map(|(k, x)| {
            if bad(k) {
                Some("a key".into())
            } else {
                control_chars(x).map(|w| if w == "a value" { k.clone() } else { w })
            }
        }),
        _ => None,
    }
}

/// Python's `str(v)`, for env values written as YAML numbers or booleans.
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn section(data: &Value, name: &str) -> Map<String, Value> {
    data.get(name).and_then(Value::as_object).cloned().unwrap_or_default()
}

fn check_known(map: &Map<String, Value>, known: &[&str], name: &str) -> Result<(), Error> {
    let mut unknown: Vec<&String> = map.keys().filter(|k| !known.contains(&k.as_str())).collect();
    unknown.sort();
    if unknown.is_empty() { Ok(()) } else { Err(err(format!("{name}: unknown keys {unknown:?}"))) }
}

fn int(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(py_str).collect()).unwrap_or_default()
}

/// `/[:%\\"'\x00-\x1f\x7f]/`: what a host path may not contain.
pub fn host_path_ok(p: &str) -> bool {
    !p.chars().any(|c| matches!(c, ':' | '%' | '\\' | '"' | '\'') || (c as u32) < 0x20 || c as u32 == 0x7f)
}

pub fn parse(data: &Value) -> Result<LegacyConfig, Error> {
    if !data.is_object() {
        return Err(err("config must be a mapping"));
    }
    let version = data.get("version").cloned().unwrap_or(1.into());
    if version.as_i64() != Some(1) {
        return Err(err(format!("unsupported config version {version}")));
    }
    let machine_name = data
        .get("machine")
        .and_then(|m| m.get("name"))
        .filter(|n| !n.is_null() && n.as_str() != Some(""))
        .map(py_str)
        .unwrap_or_else(|| "wadspaces".into());

    let mut daemon = section(data, "daemon");
    for k in DEPRECATED_DAEMON {
        daemon.remove(*k);
    }
    // `hotkeys` is the old name for `keys`.
    let mut keys = daemon.remove("hotkeys").and_then(|v| v.as_object().cloned()).unwrap_or_default();
    keys.extend(daemon.remove("keys").and_then(|v| v.as_object().cloned()).unwrap_or_default());
    check_known(&keys, KEYS_KEYS, "daemon.keys")?;
    check_known(&daemon, DAEMON_KEYS, "daemon")?;
    let pick = |k: &str, allowed: &[&str], default: &str| -> Result<(), Error> {
        let v = daemon.get(k).and_then(Value::as_str).unwrap_or(default);
        if allowed.contains(&v) {
            Ok(())
        } else {
            // As Python prints its tuple.
            let tuple = allowed.iter().map(|a| format!("'{a}'")).collect::<Vec<_>>().join(", ");
            Err(err(format!("daemon.{k} must be one of ({tuple})")))
        }
    };
    pick("backend", &["systemd", "podman"], "systemd")?;
    pick("systemd_scope", &["system", "user"], "system")?;
    pick("prefetch", &["autostart", "all", "none"], "none")?;
    if int(daemon.get("max_parallel_pulls")).unwrap_or(3) < 1 {
        return Err(err("daemon.max_parallel_pulls must be at least 1"));
    }
    daemon.insert("keys".into(), Value::Object(keys));
    let daemon_port = int(daemon.get("port")).unwrap_or(8080);

    let wadcreator = section(data, "wadcreator");
    let wc_enabled = wadcreator.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let wc_port = int(wadcreator.get("port")).unwrap_or(8081);

    let cloud = match data.get("cloud").filter(|c| crate::state::truthy(c)) {
        Some(_) => {
            let mut c = section(data, "cloud");
            for k in DEPRECATED_CLOUD {
                c.remove(*k);
            }
            if !c.get("project_id").is_some_and(crate::state::truthy) {
                return Err(err("cloud.project_id is required when cloud is set"));
            }
            Some(c)
        }
        None => None,
    };

    let mut workspaces = Vec::new();
    let (mut ids, mut ports, mut hotkeys, mut names) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (i, raw) in data.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate() {
        let where_ = format!("workspaces[{i}]");
        let raw = raw.as_object().cloned().ok_or_else(|| err(format!("{where_}: not a mapping")))?;
        check_known(&raw, WORKSPACE_KEYS, &where_)?;
        // Each value becomes a line of a systemd unit: a line break would add
        // lines of its own (a shared design's name running a command as root).
        if let Some(key) = control_chars(&Value::Object(raw.clone())) {
            return Err(err(format!("{where_}: {key} has a line break or another control character")));
        }
        for req in ["id", "name", "image"] {
            if !raw.contains_key(req) {
                return Err(err(format!("{where_}: missing {req}")));
            }
        }
        let display = raw.get("display").map(py_str).unwrap_or_else(|| "stream".into());
        let display = match display.as_str() {
            "host" => Display::Host,
            "stream" => Display::Stream,
            _ => return Err(err(format!("{where_}: display must be one of ('stream', 'host')"))),
        };
        let port = int(raw.get("port").filter(|p| !p.is_null()));
        if display == Display::Stream && port.is_none() {
            return Err(err(format!("{where_}: missing port (a streamed workspace needs one)")));
        }
        let id = py_str(&raw["id"]);
        let where_ = format!("workspace '{id}'");
        if !wad_core::spec::is_id(&id) {
            return Err(err(format!("{where_}: id must match ^[a-z0-9][a-z0-9-]{{0,62}}$")));
        }
        if ids.contains(&id) {
            return Err(err(format!("{where_}: duplicate id")));
        }
        if let Some(p) = port {
            if !(1..=65535).contains(&p) {
                return Err(err(format!("{where_}: port out of range")));
            }
            if ports.contains(&p) || p == daemon_port || (wc_enabled && p == wc_port) {
                return Err(err(format!("{where_}: port {p} already used")));
            }
            ports.push(p);
        }
        let container_name =
            raw.get("container_name").map(py_str).filter(|n| !n.is_empty()).unwrap_or_else(|| format!("wad-{id}"));
        if names.contains(&container_name) {
            return Err(err(format!("{where_}: duplicate container_name")));
        }
        let projects = check_projects(raw.get("projects"), &where_)?;
        let enabled = raw.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let hotkey = int(raw.get("hotkey").filter(|h| !h.is_null()));
        if let Some(h) = hotkey {
            if !(1..=9).contains(&h) {
                return Err(err(format!("{where_}: hotkey must be 1..9")));
            }
            if enabled && hotkeys.contains(&h) {
                return Err(err(format!("{where_}: hotkey {h} already used")));
            }
            if enabled {
                hotkeys.push(h);
            }
        }
        let env = raw
            .get("env")
            .and_then(Value::as_object)
            .map(|e| e.iter().map(|(k, v)| (k.clone(), py_str(v))).collect())
            .unwrap_or_default();
        let shm_size = match raw.get("shm_size") {
            None => Some("1g".to_string()),
            Some(Value::Null) => None,
            Some(v) => Some(py_str(v)),
        };
        ids.push(id.clone());
        names.push(container_name.clone());
        workspaces.push(Workspace {
            id,
            name: py_str(&raw["name"]),
            image: py_str(&raw["image"]),
            display,
            port: port.map(|p| p as u16),
            hotkey: hotkey.map(|h| h as u8),
            icon: raw.get("icon").filter(|i| !i.is_null()).map(py_str),
            enabled,
            autostart: raw.get("autostart").and_then(Value::as_bool).unwrap_or(false),
            container_name,
            container_port: int(raw.get("container_port")).unwrap_or(3000) as u16,
            env,
            secrets: strings(raw.get("secrets")),
            volumes: strings(raw.get("volumes")),
            devices: strings(raw.get("devices")),
            shm_size,
            projects,
        });
    }
    Ok(LegacyConfig { machine_name, daemon, cloud, workspaces })
}

fn check_projects(v: Option<&Value>, where_: &str) -> Result<Vec<MountedProject>, Error> {
    let Some(v) = v.filter(|v| !v.is_null()) else { return Ok(vec![]) };
    let list = v.as_array().ok_or_else(|| err(format!("{where_}: projects must be a list")))?;
    let mut out: Vec<MountedProject> = Vec::new();
    for p in list {
        let o = p.as_object();
        let keys: Vec<&str> = o.map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
        let shape_ok = o.is_some()
            && keys.contains(&"id")
            && keys.contains(&"mount")
            && keys.iter().all(|k| matches!(*k, "id" | "mount" | "path"));
        if !shape_ok {
            return Err(err(format!("{where_}: each project is {{id, mount, path?}}, not {p}")));
        }
        let o = o.unwrap();
        let (id, mount) = (py_str(&o["id"]), py_str(&o["mount"]));
        let path = match o.get("path") {
            None => None,
            Some(Value::String(s)) if s.starts_with('/') && host_path_ok(s) => Some(s.clone()),
            Some(other) => {
                return Err(err(format!("{where_}: project path {other} must be absolute, without ':' or '%'")));
            }
        };
        if !wad_core::projects::is_project_id(&id) {
            return Err(err(format!("{where_}: project id '{id}' must match ^[A-Za-z0-9_-]{{1,64}}$")));
        }
        if !wad_core::projects::is_mount(&mount) || mount == "." || mount == ".." {
            return Err(err(format!("{where_}: project mount '{mount}' must match ^[A-Za-z0-9._-]{{1,64}}$")));
        }
        if out.iter().any(|x| x.id == id) {
            return Err(err(format!("{where_}: project {id} is listed twice")));
        }
        if out.iter().any(|x| x.mount == mount) {
            return Err(err(format!("{where_}: two projects are mounted at Desktop/{mount}")));
        }
        out.push(MountedProject { id, mount, path });
    }
    Ok(out)
}

/// A workspace in workspaces.yaml's shape: what parse() reads back.
pub fn to_yaml(w: &Workspace) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), w.id.clone().into());
    o.insert("name".into(), w.name.clone().into());
    o.insert("image".into(), w.image.clone().into());
    o.insert("display".into(), if w.display == Display::Host { "host" } else { "stream" }.into());
    if let Some(p) = w.port {
        o.insert("port".into(), p.into());
    }
    if let Some(h) = w.hotkey {
        o.insert("hotkey".into(), h.into());
    }
    if let Some(i) = &w.icon {
        o.insert("icon".into(), i.clone().into());
    }
    o.insert("enabled".into(), w.enabled.into());
    o.insert("autostart".into(), w.autostart.into());
    o.insert("container_name".into(), w.container_name.clone().into());
    o.insert("container_port".into(), w.container_port.into());
    let env: Map<String, Value> = w.env.iter().map(|(k, v)| (k.clone(), v.clone().into())).collect();
    o.insert("env".into(), Value::Object(env));
    o.insert("secrets".into(), w.secrets.clone().into());
    o.insert("volumes".into(), w.volumes.clone().into());
    o.insert("devices".into(), w.devices.clone().into());
    o.insert("shm_size".into(), w.shm_size.clone().map(Value::from).unwrap_or(Value::Null));
    let projects: Vec<Value> = w
        .projects
        .iter()
        .map(|p| {
            let mut m = Map::new();
            m.insert("id".into(), p.id.clone().into());
            m.insert("mount".into(), p.mount.clone().into());
            if let Some(path) = &p.path {
                m.insert("path".into(), path.clone().into());
            }
            Value::Object(m)
        })
        .collect();
    o.insert("projects".into(), projects.into());
    Value::Object(o)
}

/// Workspaces (in workspaces.yaml's shape) checked together, as the file
/// would be: ids, ports, hotkeys and names unique, and each one valid.
pub fn check_workspaces(list: Vec<Value>) -> Result<Vec<Workspace>, Error> {
    // The Rust wadd has no TCP port of its own to keep free.
    let data = serde_json::json!({"daemon": {"port": 0}, "wadcreator": {"enabled": false}, "workspaces": list});
    parse(&data).map(|c| c.workspaces)
}

#[cfg(test)]
mod tests;
