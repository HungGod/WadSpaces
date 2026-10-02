//! A wadspace as the Builder edits it (src/core/model.ts): defaults, ids,
//! and the desktop's icon order.

use serde_json::{Value, json};

use crate::js::{self, Obj};

/// `defaultAdvanced(tz)`.
pub fn default_advanced(tz: &str) -> Value {
    json!({
        "display": "host",
        "port": null,
        "hotkey": null,
        "tools": ["git"],
        "projects": [],
        "kaleResources": [],
        "env": { "PUID": "1000", "PGID": "1000", "TZ": tz },
        "secrets": [],
        "devices": ["/dev/dri"],
        "shmSize": "1g",
        "persistConfig": true,
        "autostart": false,
    })
}

const ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// `slug-xxxxxx`: lowercase, valid as a wadd id, a container name and an
/// image path. `rand`: six numbers in [0, 1) (Math.random's), for the tail.
pub fn new_wadspace_id(name: &str, rand: &[f64]) -> String {
    let lower = name.to_lowercase();
    let slug = js::replace_runs(&lower, |c| !(c.is_ascii_lowercase() || c.is_ascii_digit()), "-");
    let slug = js::ascii_prefix(js::trim_dashes(&slug), 40);
    let slug = if slug.is_empty() { "wadspace" } else { slug };
    let tail: String = (0..6)
        .map(|i| {
            let r = rand.get(i % rand.len().max(1)).copied().unwrap_or(0.0);
            ALPHABET[((r * 36.0).floor() as usize).min(35)] as char
        })
        .collect();
    format!("{slug}-{tail}")
}

/// Desktops saved with cloud-file shortcuts (`kind: "file"`) lose them.
pub fn drop_file_icons(layout: &Value) -> Value {
    let icons = js::arr(layout, "icons");
    let kept: Vec<Value> = icons.iter().filter(|i| js::str_of(i, "kind") != Some("file")).cloned().collect();
    if kept.len() == icons.len() {
        return layout.clone();
    }
    let mut out = js::obj(layout);
    out.insert("icons".into(), Value::Array(kept));
    Value::Object(out)
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn f(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// Icons in desktop order: by grid cell (column-major), else top-to-bottom, left-to-right.
pub fn ordered_icons(layout: &Value) -> Vec<Value> {
    let grid = js::truthy(layout.get("grid").unwrap_or(&Value::Null));
    let key = |i: &Value| -> (f64, f64) {
        match i.get("cell").filter(|c| js::truthy(c)) {
            Some(cell) if grid => (f(cell.get("col")), f(cell.get("row"))),
            _ => (js_round(f(i.get("x")) * 20.0), f(i.get("y"))),
        }
    };
    let mut icons = js::arr(layout, "icons").to_vec();
    icons.sort_by(|a, b| {
        let ((a0, a1), (b0, b1)) = (key(a), key(b));
        // `a0 - b0 || a1 - b1`: NaN counts as equal.
        let d = a0 - b0;
        let d = if d != 0.0 && !d.is_nan() { d } else { a1 - b1 };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    icons
}

/// A layout's object form, for building on.
pub fn layout_obj(v: &Value) -> Obj {
    js::obj(v)
}
