//! The six hand-written workspaces from before the Builder, as generator specs, and
//! as Builder wadspaces with their real desktops (src/core/presets.ts).

use std::sync::OnceLock;

use serde_json::{Value, json};

use crate::js;
use crate::model::default_advanced;
use crate::recipes::{Recipe, recipe_for};
use crate::spec::new_spec;

pub const PRESET_DESKTOPS_JSON: &str = include_str!("../data/preset-desktops.json");

fn desktops() -> &'static Value {
    static D: OnceLock<Value> = OnceLock::new();
    D.get_or_init(|| serde_json::from_str(PRESET_DESKTOPS_JSON).expect("data/preset-desktops.json is valid"))
}

fn kale(pairs: &[(&str, &str)]) -> Value {
    Value::Array(pairs.iter().map(|(n, u)| json!({ "app_name": n, "app_url": u })).collect())
}

fn web(pairs: &[(&str, &str)]) -> Value {
    Value::Array(pairs.iter().map(|(n, u)| json!({ "name": n, "url": u })).collect())
}

/// The presets, as `newSpec` makes them.
pub fn presets() -> &'static [Value] {
    static P: OnceLock<Vec<Value>> = OnceLock::new();
    P.get_or_init(|| {
        let kale_dev = kale(&[("Github", "https://github.com"), ("Claude", "https://claude.ai"), ("Open Router", "https://openrouter.ai/")]);
        vec![
            new_spec(&json!({ "id": "writing", "name": "Writing", "features": ["git", "obsidian"], "port": 3100, "hotkey": 1, "persistConfig": false, "display": "host" })),
            new_spec(&json!({
                "id": "iq-dev", "name": "IntelligenceQuest Dev", "port": 3110, "hotkey": 2, "display": "host",
                "features": ["git", "cpp", "python", "nodejs", "vscode", "claude-code", "tiled"],
                "kaleResources": kale(&[("Spritesheet Packer", "https://www.codeandweb.com/free-sprite-sheet-packer"), ("Github", "https://github.com"), ("Claude", "https://claude.ai"), ("Piskel", "https://www.piskelapp.com/")]),
            })),
            new_spec(&json!({
                "id": "wad-c", "name": "Wad Creator Dev", "port": 3120, "hotkey": 3, "display": "host",
                "features": ["git", "nodejs", "firebase", "vscode", "claude-code", "chrome"],
                "webapps": web(&[("Claude", "https://claude.ai"), ("GitHub", "https://github.com"), ("Google Cloud", "https://console.cloud.google.com"), ("OpenRouter", "https://openrouter.ai")]),
            })),
            new_spec(&json!({
                "id": "kale-b", "name": "Kale Browser", "port": 3130, "hotkey": 4, "display": "host",
                "features": ["git", "python", "nodejs", "vscode", "claude-code"],
                "kaleResources": kale_dev,
            })),
            new_spec(&json!({
                "id": "vanua-academy", "name": "Vanua Academy", "port": 3140, "hotkey": 5, "display": "host",
                "features": ["git", "python", "nodejs", "firebase", "vscode", "claude-code", "chrome", "hplip"],
                "webapps": web(&[("Gmail", "https://mail.google.com"), ("Claude", "https://claude.ai"), ("GitHub", "https://github.com"), ("Google Cloud", "https://console.cloud.google.com"), ("Google Workspace", "https://workspace.google.com/dashboard"), ("Google Drive", "https://drive.google.com")]),
            })),
            new_spec(&json!({
                "id": "kale-p", "name": "Kale Phone", "port": 3150, "hotkey": 6, "display": "host", "devices": ["/dev/dri", "/dev/kvm"],
                "features": ["git", "nodejs", "vscode", "claude-code", "android-studio"],
                "kaleResources": kale_dev,
            })),
        ]
    })
}

pub fn preset(id: &str) -> Option<&'static Value> {
    presets().iter().find(|p| p["id"] == id)
}

fn gh(repo: &str, mount: &str, setup: &str) -> Value {
    json!({ "name": mount, "mountName": mount, "source": { "kind": "git", "url": format!("https://github.com/HungGod/{repo}.git") }, "setup": setup })
}

/// Each preset's default projects. Writing's folder must stay "Writing": the
/// image's init-writing-vault looks for ~/Desktop/Writing.
pub fn preset_projects(id: &str) -> Value {
    json!(match id {
        "writing" => vec![gh("Writing", "Writing", "")],
        "iq-dev" => vec![gh("intelligencequest", "IntelligenceQuest", "")],
        "wad-c" => vec![gh("WadCreator", "WadCreator", "npm install")],
        "kale-b" => vec![gh("KaleBrowser", "KaleBrowser", "npm install")],
        "vanua-academy" => vec![gh("VanuaAcademy", "VanuaAcademy", "npm run install:all")],
        "kale-p" => vec![gh("KalePhone", "KalePhone", "")],
        _ => vec![],
    })
}

/// A preset as a Builder wadspace: its real desktop plus its build and run
/// settings. advanced.projects is empty: the data layer fills it in.
pub fn preset_wadspace(id: &str) -> Option<Value> {
    let p = preset(id)?;
    let desk = desktops().get(id)?;
    // Features an icon already brings in don't need listing as tools.
    let from_icons: Vec<&str> = js::arr(&desk["layout"], "icons")
        .iter()
        .filter_map(|i| match recipe_for(i.get("appId").and_then(Value::as_str).unwrap_or(""), None) {
            Recipe::Feature { feature, .. } => Some(feature),
            _ => None,
        })
        .collect();
    let tz = p["env"]["TZ"].as_str().unwrap_or("Etc/UTC");
    let mut adv = js::obj(&default_advanced(tz));
    let tools: Vec<Value> =
        js::arr(p, "features").iter().filter(|f| !from_icons.iter().any(|x| f.as_str() == Some(x))).cloned().collect();
    for (k, v) in [
        ("display", js::present(p, "display").cloned().unwrap_or("stream".into())),
        ("port", p["port"].clone()),
        ("hotkey", js::present(p, "hotkey").cloned().unwrap_or(Value::Null)),
        ("tools", Value::Array(tools)),
        ("projects", json!([])),
        ("env", p["env"].clone()),
        ("secrets", p["secrets"].clone()),
        ("devices", p["devices"].clone()),
        ("shmSize", p["shmSize"].clone()),
        ("persistConfig", p["persistConfig"].clone()),
        ("autostart", p["autostart"].clone()),
    ] {
        adv.insert(k.into(), v);
    }
    Some(json!({
        "id": p["id"],
        "name": p["name"],
        "description": desk["description"],
        "layout": desk["layout"],
        "advanced": adv,
    }))
}
