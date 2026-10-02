//! The app catalog (data/apps.json), and catalog icons shipped with the app
//! in place of Google's favicon service (src/core/catalog/icons.ts).

use std::sync::OnceLock;

use serde_json::Value;

use crate::url;

pub const APPS_JSON: &str = include_str!("../data/apps.json");

pub fn apps() -> &'static [Value] {
    static APPS: OnceLock<Vec<Value>> = OnceLock::new();
    APPS.get_or_init(|| serde_json::from_str(APPS_JSON).expect("data/apps.json is valid"))
}

/// The bundled icon for a Google favicon URL's domain; anything else as it is.
pub fn local_icon(u: &str) -> String {
    if !u.starts_with("https://www.google.com/s2/favicons") {
        return u.into();
    }
    let Some(domain) = url::query_param(u, "domain").filter(|d| !d.is_empty()) else { return u.into() };
    // The last app with that domain wins, as a Map built from the list does.
    apps()
        .iter()
        .rev()
        .find(|a| {
            a.get("domain").and_then(Value::as_str) == Some(&domain)
                && a.get("iconUrl").and_then(Value::as_str).is_some_and(|i| !i.is_empty())
        })
        .and_then(|a| a.get("iconUrl").and_then(Value::as_str))
        .unwrap_or(u)
        .into()
}
