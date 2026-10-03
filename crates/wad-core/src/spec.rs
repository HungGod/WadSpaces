//! A workspace as the generator sees it (src/core/spec.ts): features, the
//! spec's defaults, wadd's form of it, and validation.

use serde_json::{Value, json};

use crate::js::{self, Obj};

/// Features in install order (images/base's feature scripts).
pub const FEATURES: &[&str] = &[
    "git",
    "cpp",
    "python",
    "nodejs",
    "firebase",
    "electron-deps",
    "vscode",
    "claude-code",
    "chrome",
    "kalebrowser",
    "tiled",
    "android-studio",
    "hplip",
    "obsidian",
];

pub const DEFAULT_BASE_IMAGE: &str = "localhost/wadspaces-base:trixie";
pub const SELKIES_BASE_IMAGE: &str = "localhost/wadspaces-selkies:trixie";
pub const DEFAULT_IMAGE_PREFIX: &str = "localhost/wadspaces-";

/// The base image for a display kind (anything but "host" is streamed).
pub fn base_image_for(display: Option<&str>) -> &'static str {
    if display == Some("host") { DEFAULT_BASE_IMAGE } else { SELKIES_BASE_IMAGE }
}

/// A spec's display: absent means "stream" (specs saved before it existed).
pub fn display_of(spec: &Value) -> &str {
    js::present(spec, "display").and_then(Value::as_str).unwrap_or("stream")
}

/// `/^[a-z0-9][a-z0-9-]{0,62}$/`
pub fn is_id(s: &str) -> bool {
    let mut cs = s.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() <= 63
        && cs.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `newSpec(partial)`: the defaults, then whatever `partial` has.
pub fn new_spec(partial: &Value) -> Value {
    let id = js::present(partial, "id").map(js::string).unwrap_or_default();
    let display = js::present(partial, "display").map(js::string).unwrap_or_else(|| "host".into());
    let image = if id.is_empty() { String::new() } else { format!("{DEFAULT_IMAGE_PREFIX}{id}:latest") };
    let mut out = match json!({
        "id": id,
        "name": "",
        "display": display,
        "baseImage": base_image_for(Some(&display)),
        "features": ["git", "vscode", "claude-code"],
        "webapps": [],
        "kaleResources": [],
        "image": image,
        "port": 3160,
        "hotkey": null,
        "env": { "PUID": "1000", "PGID": "1000", "TZ": "Pacific/Fiji" },
        "secrets": ["github_token"],
        "persistConfig": true,
        "devices": ["/dev/dri"],
        "shmSize": "1g",
        "autostart": false,
    }) {
        Value::Object(o) => o,
        _ => unreachable!(),
    };
    for (k, v) in js::obj(partial) {
        out.insert(k, v);
    }
    Value::Object(out)
}

/// `slugify(s)`: lowercase letters, digits and dashes, 63 at most.
pub fn slugify(s: &str) -> String {
    let lower = s.to_lowercase();
    let slug = js::replace_runs(&lower, |c| !(c.is_ascii_lowercase() || c.is_ascii_digit()), "-");
    js::ascii_prefix(js::trim_dashes(&slug), 63).to_string()
}

/// Features in install order: web apps bring chrome, Kale Browser apps kalebrowser.
pub fn resolve_features(spec: &Value) -> Vec<&'static str> {
    let mut want = js::strs(spec, "features");
    if !js::arr(spec, "webapps").is_empty() {
        want.push("chrome".into());
    }
    if !js::arr(spec, "kaleResources").is_empty() {
        want.push("kalebrowser".into());
    }
    FEATURES.iter().copied().filter(|f| want.iter().any(|w| w == f)).collect()
}

pub fn volumes_for(spec: &Value) -> Vec<String> {
    if js::truthy(spec.get("persistConfig").unwrap_or(&Value::Null)) {
        vec![format!("wad-{}-config:/config:z", js::string(spec.get("id").unwrap_or(&Value::Null)))]
    } else {
        vec![]
    }
}

/// What wadd stores in workspaces.yaml, in the order its fields are written.
pub fn to_wadd_spec(spec: &Value) -> Value {
    let g = |k: &str| spec.get(k).cloned().unwrap_or(Value::Null);
    let mut w = Obj::new();
    for k in ["id", "name", "image"] {
        js::put(&mut w, k, spec.get(k));
    }
    if display_of(spec) == "host" {
        w.insert("display".into(), "host".into());
    } else {
        js::put(&mut w, "port", spec.get("port"));
    }
    w.insert("enabled".into(), true.into());
    if js::truthy(&g("hotkey")) {
        w.insert("hotkey".into(), g("hotkey"));
    }
    if spec.get("env").and_then(Value::as_object).is_some_and(|e| !e.is_empty()) {
        w.insert("env".into(), g("env"));
    }
    if !js::arr(spec, "secrets").is_empty() {
        w.insert("secrets".into(), g("secrets"));
    }
    let vols = volumes_for(spec);
    if !vols.is_empty() {
        w.insert("volumes".into(), json!(vols));
    }
    if !js::arr(spec, "devices").is_empty() {
        w.insert("devices".into(), g("devices"));
    }
    let shm = g("shmSize");
    w.insert("shm_size".into(), if js::truthy(&shm) { shm } else { Value::Null });
    if js::truthy(&g("autostart")) {
        w.insert("autostart".into(), true.into());
    }
    Value::Object(w)
}

/// A machine's workspace merged into a creator spec, for editing.
pub fn from_wadd_spec(w: &Value, base: Option<&Value>) -> Value {
    let s = match base {
        Some(b) if !b.is_null() => js::obj(b),
        _ => js::obj(&new_spec(&json!({ "id": w.get("id").cloned().unwrap_or(Value::Null), "features": [] }))),
    };
    let or = |k: &str, d: Value| js::present(w, k).cloned().unwrap_or(d);
    let id = js::string(w.get("id").unwrap_or(&Value::Null));
    let prefix = format!("wad-{id}-config:/config");
    let persist = js::arr(w, "volumes").iter().any(|v| js::string(v).starts_with(&prefix));
    let mut out = s.clone();
    for k in ["id", "name", "image"] {
        js::put(&mut out, k, w.get(k));
    }
    out.insert("display".into(), or("display", "stream".into()));
    out.insert("port".into(), or("port", s.get("port").cloned().unwrap_or(Value::Null)));
    out.insert("hotkey".into(), or("hotkey", Value::Null));
    out.insert("env".into(), or("env", json!({})));
    out.insert("secrets".into(), or("secrets", json!([])));
    out.insert("persistConfig".into(), persist.into());
    out.insert("devices".into(), or("devices", json!([])));
    out.insert("shmSize".into(), or("shm_size", "".into()));
    out.insert("autostart".into(), or("autostart", false.into()));
    Value::Object(out)
}

/// `/^https?:\/\/\S+$/`
fn is_url(s: &str) -> bool {
    let rest = s.strip_prefix("http://").or_else(|| s.strip_prefix("https://"));
    rest.is_some_and(|r| !r.is_empty() && !r.chars().any(js::is_space))
}

/// What's wrong with a spec.
pub fn validate(spec: &Value) -> Vec<String> {
    let mut errs = Vec::new();
    let s = |k: &str| js::string(spec.get(k).unwrap_or(&Value::Null));
    if !is_id(&s("id")) {
        errs.push("ID must be lowercase letters, digits and dashes.".into());
    }
    if js::trim(&s("name")).is_empty() {
        errs.push("Name is required.".into());
    }
    if js::trim(&s("image")).is_empty() {
        errs.push("Image is required.".into());
    }
    if display_of(spec) == "stream" {
        let port = spec.get("port").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if !((1024.0..=65535.0).contains(&port)) {
            errs.push("Port must be between 1024 and 65535.".into());
        }
        if [8080.0, 8081.0, 9222.0].contains(&port) {
            errs.push("Ports 8080, 8081 and 9222 are used by the host.".into());
        }
    }
    if let Some(h) = js::present(spec, "hotkey") {
        let h = h.as_f64().unwrap_or(f64::NAN);
        if !((1.0..=9.0).contains(&h)) {
            errs.push("Hotkey must be 1 to 9.".into());
        }
    }
    let urls = js::arr(spec, "webapps")
        .iter()
        .map(|w| w.get("url"))
        .chain(js::arr(spec, "kaleResources").iter().map(|k| k.get("app_url")));
    for u in urls {
        // A missing one is tested as "undefined", and shown as "(empty)".
        let tested = u.map(js::string).unwrap_or_else(|| "undefined".into());
        if !is_url(&tested) {
            let shown = match u {
                Some(v) if js::truthy(v) => js::string(v),
                _ => "(empty)".into(),
            };
            errs.push(format!("Not a URL: {shown}"));
        }
    }
    errs
}
