//! A Builder wadspace → what the generator needs (src/core/build.ts). Desktop
//! icons become, in order, /etc/wadspaces/layout.json entries, and each app is
//! installed the way its catalog recipe says; apps that can't be yet come
//! back in `skipped`. Web apps are WadBrowser windows; their icons are made
//! before the image builds (wadd, wad-icons), from the site or the user's
//! own picture (`iconUrl`).

use serde_json::{Value, json};

use crate::js::{self, Obj};
use crate::model;
use crate::recipes::{Recipe, recipe_for};
use crate::spec::{DEFAULT_IMAGE_PREFIX, base_image_for};
use crate::url;

fn safe_id(s: &str) -> String {
    let lower = s.to_lowercase();
    let id = js::replace_runs(&lower, |c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "-");
    let id = js::ascii_prefix(js::trim_dashes(&id), 60);
    if id.is_empty() { "app".into() } else { id.into() }
}

/// The picture the user chose for a web app's icon (an upload, or a picture's
/// address), if it isn't one of the catalog's own or a stock favicon. wadd
/// puts it in the image instead of the site's icon.
fn custom_icon(icon: &Value) -> Option<String> {
    let u = icon.get("iconUrl").and_then(Value::as_str)?;
    let mine = u.starts_with("data:image/")
        || (u.starts_with("https://") && url::host(u, "local").is_some_and(|h| h != "www.google.com"));
    mine.then(|| u.to_string())
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
    // What links open in: the WadBrowser on the desktop (with an address bar wins).
    let mut default_browser: Option<&str> = None;
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
            Recipe::Builtin { desktop } => {
                match app_id.as_str() {
                    "wadbrowser" => default_browser = Some("full"),
                    "wadbrowser-focus" if default_browser.is_none() => default_browser = Some("focus"),
                    _ => {}
                }
                layout.push(entry(Some(desktop.into())));
            }
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
            Recipe::Webapp { url, chrome } => {
                // (Designs from before WadBrowser may say launcher: "kale":
                // every web app is a WadBrowser window now.)
                let mut w = Obj::new();
                w.insert("id".into(), app.clone().into());
                js::put(&mut w, "name", label.as_ref());
                w.insert("url".into(), url.into());
                if chrome {
                    w.insert("chrome".into(), true.into());
                }
                if let Some(i) = custom_icon(icon) {
                    w.insert("iconUrl".into(), i.into());
                }
                webapps.push(Value::Object(w));
                layout.push(entry(Some(format!("wadspaces-webapp-{app}.desktop"))));
            }
            Recipe::Soon { reason } => {
                let mut s = Obj::new();
                js::put(&mut s, "label", label.as_ref());
                s.insert("reason".into(), reason.into());
                skipped.push(Value::Object(s));
            }
        }
    }

    // Designs from before WadBrowser kept Kale Browser apps in advanced: web
    // apps now, in the app menu (they never had desktop icons of their own).
    for k in js::arr(&adv, "kaleResources") {
        let url = k.get("app_url").map(js::string).unwrap_or_default();
        if url.is_empty() || webapps.iter().any(|w| w["url"] == url.as_str()) {
            continue;
        }
        let name = k.get("app_name").map(js::string).unwrap_or_else(|| url.clone());
        let base = safe_id(&name);
        let mut id = base.clone();
        let mut n = 2;
        while webapps.iter().any(|w| w["id"] == id.as_str()) {
            id = format!("{base}-{n}");
            n += 1;
        }
        webapps.push(json!({ "id": id, "name": name, "url": url }));
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
    if let Some(d) = default_browser {
        spec.insert("defaultBrowser".into(), d.into());
    }
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
