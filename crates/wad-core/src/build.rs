//! A Builder wadspace → what the generator needs (src/core/build.ts). Desktop
//! icons become, in order, /etc/wadspaces/layout.json entries, and each app is
//! installed the way its catalog recipe says; apps that can't be yet come
//! back in `skipped`.

use serde_json::{Value, json};

use crate::js::{self, Obj};
use crate::model;
use crate::recipes::{Recipe, recipe_for};
use crate::spec::{DEFAULT_IMAGE_PREFIX, base_image_for};
use crate::url;

/// The launcher KaleBrowser's packager writes for an app (packager.py slugify).
pub fn kale_desktop(app_name: &str) -> String {
    let lower = js::trim(app_name).to_lowercase();
    let kept: String =
        lower.chars().filter(|&c| c.is_ascii_alphanumeric() || c == '_' || js::is_space(c) || c == '-').collect();
    let slug = js::replace_runs(&kept, |c| js::is_space(c) || c == '_' || c == '-', "-");
    format!("WADspaces-{}.desktop", js::trim_dashes(&slug))
}

fn safe_id(s: &str) -> String {
    let lower = s.to_lowercase();
    let id = js::replace_runs(&lower, |c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "-");
    let id = js::ascii_prefix(js::trim_dashes(&id), 60);
    if id.is_empty() { "app".into() } else { id.into() }
}

/// The site a web icon opens: its own url, else the domain of its favicon URL.
fn site_of(icon: &Value) -> Option<String> {
    if let Some(u) = icon.get("url").filter(|u| js::truthy(u)) {
        return Some(js::string(u));
    }
    let icon_url = icon.get("iconUrl").map(js::string).unwrap_or_else(|| "undefined".into());
    if url::host(&icon_url, "local")? == "www.google.com" { url::query_param(&icon_url, "domain") } else { None }
}

/// `toBuildSpec(ws, opts)` → `{ spec, skipped }`.
pub fn to_build_spec(ws: &Value, opts: &Value) -> Value {
    let adv = ws.get("advanced").cloned().unwrap_or(Value::Null);
    let mut features: Vec<Value> = Vec::new();
    let add_feature = |features: &mut Vec<Value>, f: Value| {
        if !features.contains(&f) {
            features.push(f);
        }
    };
    for t in js::arr(&adv, "tools") {
        add_feature(&mut features, t.clone());
    }
    let mut apt_apps = Vec::new();
    let mut webapps = Vec::new();
    let mut kale_from_icons: Vec<Value> = Vec::new();
    let mut layout = Vec::new();
    let mut skipped = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let icons = model::ordered_icons(&model::drop_file_icons(ws.get("layout").unwrap_or(&Value::Null)));
    for icon in &icons {
        let app_id = icon.get("appId").map(js::string).unwrap_or_else(|| "undefined".into());
        let app = safe_id(&app_id);
        let autostart = icon.get("autostart").filter(|a| js::truthy(a)).cloned();
        let label = icon.get("label").cloned();
        let recipe = recipe_for(&app_id, site_of(icon).as_deref());
        // The same app twice on a desktop is one install and one launcher.
        if seen.contains(&app) {
            continue;
        }
        seen.push(app.clone());
        let entry = |desktop: Option<String>| {
            let mut e = Obj::new();
            e.insert("app".into(), app.clone().into());
            if let Some(d) = desktop {
                e.insert("desktop".into(), d.into());
            }
            js::put(&mut e, "label", label.as_ref());
            js::put(&mut e, "autostart", autostart.as_ref());
            Value::Object(e)
        };
        match recipe {
            Recipe::Feature { feature, desktop } => {
                add_feature(&mut features, feature.into());
                layout.push(entry(desktop.first().map(|d| d.to_string())));
            }
            Recipe::Builtin { desktop } => layout.push(entry(Some(desktop.into()))),
            Recipe::Apt { packages, desktop } => {
                let mut a = Obj::new();
                a.insert("id".into(), app.clone().into());
                a.insert("packages".into(), json!(packages));
                if let Some(d) = desktop {
                    a.insert("desktop".into(), d.into());
                }
                apt_apps.push(Value::Object(a));
                layout.push(entry(desktop.map(String::from)));
            }
            Recipe::Webapp { url } => {
                if icon.get("launcher").and_then(Value::as_str) == Some("kale") {
                    let name = label.as_ref().map(js::string).unwrap_or_else(|| "undefined".into());
                    let mut k = Obj::new();
                    js::put(&mut k, "app_name", label.as_ref());
                    k.insert("app_url".into(), url.into());
                    kale_from_icons.push(Value::Object(k));
                    layout.push(entry(Some(kale_desktop(&name))));
                } else {
                    let mut w = Obj::new();
                    w.insert("id".into(), app.clone().into());
                    js::put(&mut w, "name", label.as_ref());
                    w.insert("url".into(), url.into());
                    webapps.push(Value::Object(w));
                    layout.push(entry(Some(format!("wadspaces-webapp-{app}.desktop"))));
                }
            }
            Recipe::Soon { reason } => {
                let mut s = Obj::new();
                js::put(&mut s, "label", label.as_ref());
                s.insert("reason".into(), reason.into());
                skipped.push(Value::Object(s));
            }
        }
    }

    let own = js::arr(&adv, "kaleResources").to_vec();
    let mut kale_resources = own.clone();
    for k in kale_from_icons {
        if !own.iter().any(|x| x.get("app_url") == k.get("app_url")) {
            kale_resources.push(k);
        }
    }
    let user_projects = js::arr(opts, "projects");
    let projects: Vec<Value> = js::arr(&adv, "projects")
        .iter()
        .filter_map(|id| {
            let p = user_projects
                .iter()
                .find(|x| x.get("id") == Some(id) && !js::truthy(x.get("deleted").unwrap_or(&Value::Null)))?;
            let mut o = Obj::new();
            o.insert("id".into(), id.clone());
            js::put(&mut o, "name", p.get("name"));
            js::put(&mut o, "mount", p.get("mountName"));
            Some(Value::Object(o))
        })
        .collect();

    let display = js::present(&adv, "display");
    let mut spec = Obj::new();
    js::put(&mut spec, "id", ws.get("id"));
    js::put(&mut spec, "name", ws.get("name"));
    let base = js::present(opts, "baseImage")
        .cloned()
        .unwrap_or_else(|| base_image_for(display.and_then(Value::as_str)).into());
    spec.insert("baseImage".into(), base);
    spec.insert("features".into(), Value::Array(features));
    spec.insert("aptApps".into(), Value::Array(apt_apps));
    spec.insert("webapps".into(), Value::Array(webapps));
    spec.insert("kaleResources".into(), Value::Array(kale_resources));
    if let Some(f) = opts.get("wallpaperFile").filter(|f| js::truthy(f)) {
        spec.insert("wallpaper".into(), json!({ "fileName": f, "mode": "fill", "color": "#0b0b14" }));
    }
    spec.insert("layout".into(), Value::Array(layout));
    if !projects.is_empty() {
        spec.insert("projects".into(), Value::Array(projects));
    }
    js::put(&mut spec, "display", adv.get("display"));
    let image = js::present(opts, "image").or_else(|| js::present(&adv, "image")).cloned().unwrap_or_else(|| {
        let prefix = js::present(opts, "imagePrefix").map(js::string).unwrap_or_else(|| DEFAULT_IMAGE_PREFIX.into());
        let id = ws.get("id").map(js::string).unwrap_or_else(|| "undefined".into());
        format!("{prefix}{id}:latest").into()
    });
    spec.insert("image".into(), image);
    spec.insert("port".into(), js::present(&adv, "port").cloned().unwrap_or(3160.into()));
    spec.insert("hotkey".into(), js::present(&adv, "hotkey").cloned().unwrap_or(Value::Null));
    for (to, from) in [
        ("env", "env"),
        ("secrets", "secrets"),
        ("persistConfig", "persistConfig"),
        ("devices", "devices"),
        ("shmSize", "shmSize"),
        ("autostart", "autostart"),
    ] {
        js::put(&mut spec, to, adv.get(from));
    }
    json!({ "spec": spec, "skipped": skipped })
}

/// /etc/wadspaces/layout.json: the desktop, in order.
pub fn layout_json(spec: &Value) -> String {
    let icons = js::present(spec, "layout").cloned().unwrap_or(json!([]));
    js::stringify_pretty(&json!({ "version": 1, "icons": icons }), 2) + "\n"
}
