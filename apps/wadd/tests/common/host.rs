//! A machine's block devices for tests: lsblk's answer (the shared
//! fixture), changing as systemd-mount or udisksctl mount things.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;
use wadd::drives::{DRIVES_DIR, LSBLK, Runner};

pub fn fixture() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/drives/lsblk.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[derive(Default)]
pub struct Host {
    pub tree: Value,
    pub calls: Vec<Vec<String>>,
    /// Where a mount appears.
    pub mount_dir: Option<String>,
    pub fail_mount: bool,
    /// lsblk calls before a systemd-mount shows.
    pub lag: u32,
    pub pending: Option<(String, String)>,
}

/// Sets a device's field, found by uuid anywhere in the tree.
fn set(v: &mut Value, uuid: &str, key: &str, val: &Value) -> bool {
    if v.get("uuid").and_then(Value::as_str) == Some(uuid) {
        v[key] = val.clone();
        return true;
    }
    for k in ["blockdevices", "children"] {
        if let Some(a) = v.get_mut(k).and_then(Value::as_array_mut)
            && a.iter_mut().any(|c| set(c, uuid, key, val))
        {
            return true;
        }
    }
    false
}

fn label(v: &Value, uuid: &str) -> Option<String> {
    if v.get("uuid").and_then(Value::as_str) == Some(uuid) {
        return v.get("label").and_then(Value::as_str).map(String::from);
    }
    ["blockdevices", "children"].iter().find_map(|k| v.get(*k)?.as_array()?.iter().find_map(|c| label(c, uuid)))
}

fn mount_at(tree: &mut Value, uuid: &str, at: &str) {
    assert!(set(tree, uuid, "mountpoints", &serde_json::json!([at])), "no device {uuid}");
}

#[derive(Clone)]
pub struct FakeHost(pub Arc<Mutex<Host>>);

impl FakeHost {
    pub fn new(mount_dir: Option<&str>) -> Self {
        Self(Arc::new(Mutex::new(Host {
            tree: fixture(),
            mount_dir: mount_dir.map(String::from),
            ..Default::default()
        })))
    }
    pub fn mounted(&self, uuid: &str, at: &str) {
        mount_at(&mut self.0.lock().unwrap().tree, uuid, at);
    }
    pub fn calls(&self) -> Vec<Vec<String>> {
        self.0.lock().unwrap().calls.clone()
    }
}

#[async_trait]
impl Runner for FakeHost {
    async fn run(&self, argv: &[String]) -> (i32, String, String) {
        let mut h = self.0.lock().unwrap();
        h.calls.push(argv.to_vec());
        if argv == LSBLK {
            if h.lag > 0 {
                h.lag -= 1;
                if h.lag == 0 {
                    let (u, at) = h.pending.take().unwrap();
                    mount_at(&mut h.tree, &u, &at);
                }
            }
            return (0, h.tree.to_string(), String::new());
        }
        if h.fail_mount {
            return (1, String::new(), "Failed to mount: wrong fs type".into());
        }
        match argv[0].as_str() {
            "systemd-mount" => {
                let uuid = argv.last().unwrap().rsplit('/').next().unwrap().to_string();
                let at = h.mount_dir.clone().unwrap_or(format!("{DRIVES_DIR}/{uuid}"));
                if h.lag > 0 {
                    h.pending = Some((uuid.clone(), at));
                } else {
                    mount_at(&mut h.tree, &uuid, &at);
                }
                (0, format!("Started unit run-wadspaces\\x2ddrives-{uuid}.mount\n"), String::new())
            }
            "udisksctl" => {
                let uuid = argv[3].rsplit('/').next().unwrap().to_string();
                let name = label(&h.tree, &uuid).unwrap_or_default();
                let at = h.mount_dir.clone().unwrap_or(format!("/run/media/wad/{name}"));
                mount_at(&mut h.tree, &uuid, &at);
                (0, format!("Mounted /dev/sdb1 at {at}.\n"), String::new())
            }
            other => (127, String::new(), format!("{other}: not found")),
        }
    }
}
