//! The Builder's three layers, and the rules between them (the UI's
//! src/core/layers.ts wraps these):
//!
//!   Template       the base image plus one or more apps. Its own image,
//!                  localhost/wadspaces-template-<id>:latest, FROM the base.
//!   Customization  a template's apps set up: WadBrowser's mode and web apps,
//!                  VS Code's extensions, tools, what opens at boot. Its own
//!                  image, localhost/wadspaces-custom-<id>:latest, FROM the
//!                  template's.
//!   Wadspace       a template or customization made into a space: name,
//!                  wallpaper, project folders and secrets (saved sign-ins).
//!                  No image of its own: wadd mounts those when it starts.
//!
//! What a wadspace ends up with, which sign-ins it can keep and which secrets
//! fit them, its desktop and Start menu as the image draws them, each layer's
//! Dockerfile and build folder, and turning a wadspace from before the layers
//! (a v1 design) into them. Values are JSON, as everywhere in the core.

use std::cmp::Ordering;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::catalog::{self, App};
use crate::generator::q;
use crate::js::{self, Obj};
use crate::recipes::{Recipe, recipe_for};
use crate::spec::{DEFAULT_BASE_IMAGE, FEATURES, is_id};
use crate::{icons, model, signins, url};

/// Where wadd puts a wadspace's wallpaper inside it (its extra folder).
pub const WALLPAPER_DIR: &str = "/run/wadspaces-extra";

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn strs<'a>(v: &'a Value, k: &str) -> Vec<&'a str> {
    js::arr(v, k).iter().filter_map(Value::as_str).collect()
}

fn deleted(v: &Value) -> bool {
    v.get("deletedAt").is_some_and(js::truthy)
}

/// A name or label on one line: control characters become spaces, so no
/// name can add lines of its own to a Dockerfile.
fn one_line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// `encodeURIComponent`.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Google's favicon service for a domain (lib/favicon.ts's).
pub fn favicon(domain: &str) -> String {
    format!("https://www.google.com/s2/favicons?domain={}&sz=128", encode_component(domain))
}

/// A URL's host, or the text itself when it isn't one.
pub fn host_of(u: &str) -> String {
    match url::host(u, "") {
        Some(h) if !h.is_empty() => h,
        _ => u.to_string(),
    }
}

/// A web app's icon: the bundled one for a site the catalog knows, else the favicon.
pub fn webapp_icon(u: &str) -> String {
    icons::local_icon(&favicon(&host_of(u)))
}

// ------------------------------------------------------------------ setups

/// A template on its own: WadBrowser with an address bar, nothing added.
pub fn empty_setup(template_id: &str) -> Value {
    json!({ "templateId": template_id, "browserMode": "browser", "webapps": [], "extensions": [], "tools": [], "autostart": [] })
}

/// Just the setup part of a customization (or a template's defaults).
pub fn setup_of(c: &Value) -> Value {
    let or_list = |k: &str| c.get(k).filter(|v| v.is_array()).cloned().unwrap_or(json!([]));
    json!({
        "templateId": s(c, "templateId"),
        "browserMode": if s(c, "browserMode") == "focus" { "focus" } else { "browser" },
        "webapps": or_list("webapps"),
        "extensions": or_list("extensions"),
        "tools": or_list("tools"),
        "autostart": or_list("autostart"),
    })
}

/// Whether two setups set the same things (a customization unchanged from its base).
pub fn same_setup(a: &Value, b: &Value) -> bool {
    setup_of(a) == setup_of(b)
}

/// A web app's id from its name: "Google Cloud" → "google-cloud".
pub fn webapp_id(name: &str) -> String {
    let lower = name.to_lowercase();
    let id = js::replace_runs(&lower, |c| !(c.is_ascii_lowercase() || c.is_ascii_digit()), "-");
    let id = js::ascii_prefix(js::trim_dashes(&id), 60);
    let id = js::trim_dashes(id);
    if id.is_empty() { "app".into() } else { id.into() }
}

/// "template:<id>" or "custom:<id>": the image a base runs on.
pub fn image_key(base: &Value) -> String {
    let prefix = if s(base, "kind") == "customization" { "custom" } else { "template" };
    format!("{prefix}:{}", s(base, "id"))
}

/// The image an image key names.
pub fn image_ref(key: &str) -> String {
    match key.split_once(':') {
        Some(("custom", id)) => format!("localhost/wadspaces-custom-{id}:latest"),
        Some((_, id)) => format!("localhost/wadspaces-template-{id}:latest"),
        None => format!("localhost/wadspaces-template-{key}:latest"),
    }
}

/// What a base (template or customization) has, with its template:
/// `{template, setup, customization?}`, or null when either is missing.
/// Deleted ones still resolve: a wadspace on one keeps working until it's
/// deleted for good.
pub fn resolve(lib: &Value, base: &Value) -> Value {
    let find = |coll: &str, id: &str| js::arr(lib, coll).iter().find(|x| s(x, "id") == id).cloned();
    if s(base, "kind") != "customization" {
        return match find("templates", s(base, "id")) {
            Some(t) => json!({ "template": t, "setup": empty_setup(s(&t, "id")) }),
            None => Value::Null,
        };
    }
    let Some(c) = find("customizations", s(base, "id")) else { return Value::Null };
    match find("templates", s(&c, "templateId")) {
        Some(t) => json!({ "template": t, "setup": setup_of(&c), "customization": c }),
        None => Value::Null,
    }
}

fn apps_of(template: &Value) -> Vec<App> {
    strs(template, "apps").into_iter().filter_map(catalog::app).collect()
}

fn has_app(template: &Value, id: &str) -> bool {
    strs(template, "apps").contains(&id)
}

// ----------------------------------------------------------------- secrets

fn slot(key: String, kind: &str, label: String, app_id: String, icon: &str) -> Value {
    json!({ "key": key, "kind": kind, "label": label, "appId": app_id, "iconUrl": icon })
}

/// The id a new secret for a web app is named with: WadBrowser-<Name>.
fn web_app_id(name: &str) -> String {
    format!("WadBrowser-{}", name.chars().filter(char::is_ascii_alphanumeric).collect::<String>())
}

/// The sign-ins a template with this setup can keep, in desktop order: an
/// app's own (Obsidian, Steam), each AI extension's, and each web app's.
pub fn slots_for(template: &Value, setup: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for app in apps_of(template) {
        if let Some((kind, app_id)) = &app.secret {
            out.push(slot(format!("app:{}", app.id), kind, app.name.clone(), app_id.clone(), &app.icon));
        }
        if app.id == "vscode" {
            for ext_id in strs(setup, "extensions") {
                let ext = catalog::extension(ext_id);
                if let Some(sec) = ext.get("secret").filter(|x| x.is_object()) {
                    let label = format!("{} (VS Code)", s(&ext, "name"));
                    out.push(slot(format!("ext:{ext_id}"), s(sec, "kind"), label, s(sec, "id").into(), &app.icon));
                }
            }
        }
        if app.id == "wadbrowser" {
            for w in js::arr(setup, "webapps") {
                let label = format!("{} (web app)", s(w, "name"));
                let key = format!("web:{}", s(w, "id"));
                out.push(slot(key, signins::WEB, label, web_app_id(s(w, "name")), &webapp_icon(s(w, "url"))));
            }
        }
    }
    out
}

/// A WadBrowser setup's sign-ins: one per web app.
pub fn browser_slots(setup: &Value) -> Vec<Value> {
    js::arr(setup, "webapps")
        .iter()
        .map(|w| {
            let key = format!("web:{}", s(w, "id"));
            slot(key, signins::WEB, s(w, "name").into(), web_app_id(s(w, "name")), &webapp_icon(s(w, "url")))
        })
        .collect()
}

/// A new secret's name: <wadspace name without spaces>-<slot's app id>.
pub fn new_secret_name(wadspace_name: &str, slot: &Value) -> String {
    let name: String = wadspace_name.chars().filter(|c| !js::is_space(*c)).collect();
    format!("{}-{}", if name.is_empty() { "Wadspace" } else { &name }, s(slot, "appId"))
}

/// A new secret's name in a WadBrowser setup: as [`new_secret_name`] after
/// the setup's name, or WadSpaces-WadBrowser.<App> when it has none.
pub fn default_browser_secret_name(setup_name: &str, slot: &Value) -> String {
    if js::trim(setup_name).is_empty() {
        let app = s(slot, "appId");
        format!("WadSpaces-WadBrowser.{}", app.strip_prefix("WadBrowser-").unwrap_or(app))
    } else {
        new_secret_name(setup_name, slot)
    }
}

/// Whether a secret can go in a slot: only one of its kind (a web sign-in
/// in a web app, Obsidian's in Obsidian...).
pub fn fits(secret: &Value, slot: &Value) -> bool {
    let kind = |v: &Value| match s(v, "kind") {
        "wadbrowser" => signins::WEB.to_string(),
        k => k.to_string(),
    };
    kind(secret) == kind(slot)
}

/// The kind of sign-in a slot key takes ("web:<id>", "ext:<id>", "app:<id>").
pub fn kind_of_slot_key(key: &str) -> Option<String> {
    let (prefix, id) = key.split_once(':')?;
    match prefix {
        "web" => Some(signins::WEB.into()),
        "ext" => {
            catalog::extension(id).get("secret").and_then(|x| x.get("kind")).and_then(Value::as_str).map(String::from)
        }
        "app" => catalog::app(id).and_then(|a| a.secret).map(|(k, _)| k),
        _ => None,
    }
}

/// Who uses each saved sign-in: `{<sign-in id>: [{kind, id, name, slot}]}`
/// over wadspaces and WadBrowser setups (not deleted ones).
pub fn secret_use(wadspaces: &[Value], browsers: &[Value]) -> Value {
    let mut out = Obj::new();
    let lists = [("wadspace", wadspaces), ("browser", browsers)];
    for (kind, list) in lists {
        for x in list.iter().filter(|x| !deleted(x)) {
            for (slot, r) in x.get("secrets").and_then(Value::as_object).into_iter().flatten() {
                let Some(id) = r.get("id").and_then(Value::as_str) else { continue };
                let e = out.entry(id.to_string()).or_insert_with(|| json!([]));
                e.as_array_mut().expect("a list").push(json!({
                    "kind": kind, "id": s(x, "id"), "name": s(x, "name"), "slot": slot,
                }));
            }
        }
    }
    Value::Object(out)
}

// ---------------------------------------------------------- desktop, menu

/// Whether anything in the template opens a folder in a window. Without one,
/// a project's desktop icon would only open a terminal there, so projects are
/// mounted with no icon (the image's wadspaces-projects does the same).
pub fn opens_folders(template: &Value) -> bool {
    apps_of(template).iter().any(|a| a.opens_folders)
}

fn app_label(app: &App, setup: &Value) -> String {
    if app.id == "wadbrowser" && s(setup, "browserMode") == "focus" {
        "WadBrowser Focus".into()
    } else {
        app.name.clone()
    }
}

/// What the image puts on the desktop, in selkies-desktop's order: the
/// template's apps, then the web apps, then a folder per mounted project
/// (only where an app opens folders). `{id, label, iconUrl, project?, added?}`;
/// `added`: VS Code's extensions, which the mock images mark with a +.
pub fn desktop_for(template: &Value, setup: &Value, projects: &[Value]) -> Vec<Value> {
    let mut items = Vec::new();
    for app in apps_of(template) {
        let mut item = json!({ "id": format!("app:{}", app.id), "label": app_label(&app, setup), "iconUrl": app.icon });
        let n = js::arr(setup, "extensions").len();
        if app.id == "vscode" && n > 0 {
            item["added"] = n.into();
        }
        items.push(item);
    }
    if has_app(template, "wadbrowser") {
        for w in js::arr(setup, "webapps") {
            items.push(json!({ "id": format!("web:{}", s(w, "id")), "label": s(w, "name"), "iconUrl": webapp_icon(s(w, "url")) }));
        }
    }
    if opens_folders(template) {
        for p in projects {
            items.push(json!({ "id": format!("project:{}", s(p, "id")), "label": s(p, "name"), "iconUrl": "/folder.svg", "project": true }));
        }
    }
    items
}

fn cmp_names(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

/// selkies-desktop's Start menu: every launcher in the image, by category
/// A–Z (Misc last), each A–Z. `[{name, apps: [{key, name, iconUrl}]}]`.
pub fn start_menu_for(template: &Value, setup: &Value) -> Vec<Value> {
    const BROWSER: &str = "/brand/wadbrowser-icon-dark.svg";
    const FOOT: &str = "/catalog/terminal.png";
    let mut entries: Vec<(String, String, String, String)> = vec![
        ("app:wadbrowser".into(), "WadBrowser".into(), BROWSER.into(), "Internet".into()),
        ("wadbrowser-focus".into(), "WadBrowser Focus".into(), BROWSER.into(), "Internet".into()),
        ("foot".into(), "Foot".into(), FOOT.into(), "System".into()),
        ("footclient".into(), "Foot Client".into(), FOOT.into(), "System".into()),
        ("foot-server".into(), "Foot Server".into(), FOOT.into(), "System".into()),
    ];
    for app in apps_of(template) {
        // The base's own (WadBrowser, the terminal) are listed already.
        if !matches!(app.recipe, Recipe::Builtin { .. }) {
            entries.push((format!("app:{}", app.id), app.name.clone(), app.icon.clone(), app.category.clone()));
        }
    }
    if has_app(template, "wadbrowser") {
        for w in js::arr(setup, "webapps") {
            entries.push((
                format!("web:{}", s(w, "id")),
                s(w, "name").into(),
                webapp_icon(s(w, "url")),
                "Internet".into(),
            ));
        }
    }
    let mut cats: Vec<(String, Vec<Value>)> = Vec::new();
    for (key, name, icon, cat) in entries {
        let app = json!({ "key": key, "name": name, "iconUrl": icon });
        match cats.iter_mut().find(|(c, _)| *c == cat) {
            Some((_, apps)) => apps.push(app),
            None => cats.push((cat, vec![app])),
        }
    }
    for (_, apps) in cats.iter_mut() {
        apps.sort_by(|a, b| cmp_names(s(a, "name"), s(b, "name")));
    }
    cats.sort_by(|(a, _), (b, _)| match (a.as_str(), b.as_str()) {
        ("Misc", "Misc") => Ordering::Equal,
        ("Misc", _) => Ordering::Greater,
        (_, "Misc") => Ordering::Less,
        _ => cmp_names(a, b),
    });
    cats.into_iter().map(|(name, apps)| json!({ "name": name, "apps": apps })).collect()
}

/// What can open at boot: the template's apps and the web apps. `[{key, name, iconUrl}]`.
pub fn bootables(template: &Value, setup: &Value) -> Vec<Value> {
    desktop_for(template, setup, &[])
        .into_iter()
        .map(|i| json!({ "key": i["id"], "name": i["label"], "iconUrl": i["iconUrl"] }))
        .collect()
}

// ------------------------------------------------------------ Dockerfiles

/// The launcher an app's desktop icon copies.
fn launcher(app: &App, setup: &Value) -> Option<String> {
    if app.id == "wadbrowser" {
        let focus = s(setup, "browserMode") == "focus";
        return Some(if focus { "wadbrowser-focus.desktop" } else { "wadbrowser.desktop" }.into());
    }
    match &app.recipe {
        Recipe::Feature { desktop, .. } => desktop.first().map(|d| d.to_string()),
        Recipe::Apt { desktop, .. } => desktop.map(String::from),
        Recipe::Builtin { desktop } => Some(desktop.to_string()),
        _ => None,
    }
}

/// /etc/wadspaces/layout.json: the desktop's icons in order (the template's
/// apps, then the web apps) and which open at boot; wadspaces-layout reads it.
pub fn layout_json_for(template: &Value, setup: &Value) -> String {
    let boot = strs(setup, "autostart");
    let mut icons = Vec::new();
    for app in apps_of(template) {
        let mut e = Obj::new();
        e.insert("app".into(), app.id.clone().into());
        if let Some(d) = launcher(&app, setup) {
            e.insert("desktop".into(), d.into());
        }
        e.insert("label".into(), app_label(&app, setup).into());
        if boot.contains(&format!("app:{}", app.id).as_str()) {
            e.insert("autostart".into(), true.into());
        }
        icons.push(Value::Object(e));
    }
    if has_app(template, "wadbrowser") {
        for w in js::arr(setup, "webapps").iter().filter(|w| is_id(s(w, "id"))) {
            let id = s(w, "id");
            let mut e = Obj::new();
            e.insert("app".into(), format!("webapp-{id}").into());
            e.insert("desktop".into(), format!("wadspaces-webapp-{id}.desktop").into());
            e.insert("label".into(), s(w, "name").into());
            if boot.contains(&format!("web:{id}").as_str()) {
                e.insert("autostart".into(), true.into());
            }
            icons.push(Value::Object(e));
        }
    }
    js::stringify_pretty(&json!({ "version": 1, "icons": icons }), 2) + "\n"
}

/// Features in install order, from these names (unknown ones are dropped).
fn in_order<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<&'static str> {
    let want: Vec<&str> = names.into_iter().collect();
    FEATURES.iter().copied().filter(|f| want.contains(f)).collect()
}

/// A marketplace id: publisher.name, nothing a shell would read.
pub fn is_extension_id(id: &str) -> bool {
    let ok = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    id.len() <= 120 && id.split_once('.').is_some_and(|(a, b)| ok(a) && b.split('.').all(ok))
}

/// The template's image: the base plus its apps.
pub fn template_dockerfile(t: &Value) -> String {
    let apps = apps_of(t);
    let name = one_line(s(t, "name"));
    let mut lines = vec![
        format!("# {name} template. Generated by WadSpaces Client."),
        format!("ARG BASE_IMAGE={DEFAULT_BASE_IMAGE}"),
        "FROM ${BASE_IMAGE}".into(),
        String::new(),
        format!("ENV TITLE={}", q(&name)),
        format!(
            "LABEL io.wadspaces.layer={} io.wadspaces.apps={}",
            q(&format!("template:{}", s(t, "id"))),
            q(&apps.iter().map(|a| a.id.as_str()).collect::<Vec<_>>().join(","))
        ),
        String::new(),
    ];
    let features = in_order(apps.iter().filter_map(|a| match a.recipe {
        Recipe::Feature { feature, .. } => Some(feature),
        _ => None,
    }));
    if !features.is_empty() {
        lines.push(format!("RUN wadspaces-feature {}", features.join(" ")));
        lines.push(String::new());
    }
    let apt: Vec<String> = apps
        .iter()
        .filter_map(|a| match a.recipe {
            Recipe::Apt { packages, desktop } => {
                let mut parts = vec!["wadspaces-apt".to_string(), a.id.clone()];
                if let Some(d) = desktop {
                    parts.extend(["--desktop".into(), d.to_string()]);
                }
                parts.extend(packages.iter().map(|p| p.to_string()));
                Some(parts.join(" "))
            }
            _ => None,
        })
        .collect();
    if !apt.is_empty() {
        // One RUN: apt's lists are fetched once, and --clean drops them from the layer.
        let mut cmds = apt;
        cmds.push("wadspaces-apt --clean".into());
        lines.push(format!("RUN {}", cmds.join(" && \\\n    ")));
        lines.push(String::new());
    }
    lines.push("COPY root/ /".into());
    lines.join("\n") + "\n"
}

/// A customization's image: its template's, with the apps set up.
pub fn customization_dockerfile(c: &Value, t: &Value) -> String {
    let name = one_line(s(c, "name"));
    let mut lines = vec![
        format!("# {name}: {} customized. Generated by WadSpaces Client.", one_line(s(t, "name"))),
        format!("ARG BASE_IMAGE={}", image_ref(&format!("template:{}", s(t, "id")))),
        "FROM ${BASE_IMAGE}".into(),
        String::new(),
        format!("LABEL io.wadspaces.layer={}", q(&format!("custom:{}", s(c, "id")))),
        String::new(),
    ];
    let tools = in_order(strs(c, "tools"));
    if !tools.is_empty() {
        lines.push(format!("RUN wadspaces-feature {}", tools.join(" ")));
        lines.push(String::new());
    }
    let exts: Vec<&str> = strs(c, "extensions").into_iter().filter(|e| is_extension_id(e)).collect();
    if has_app(t, "vscode") && !exts.is_empty() {
        // In the image, so they're there on first start; the image's init
        // copies them into ~/.vscode/extensions, where they can be updated.
        lines.push(format!("RUN wadspaces-vscode-extensions {}", exts.join(" ")));
        lines.push(String::new());
    }
    let webapps: Vec<String> = js::arr(c, "webapps")
        .iter()
        .filter(|w| is_id(s(w, "id")))
        .map(|w| {
            format!("wadspaces-webapp --id {} {} {}", s(w, "id"), q(&one_line(s(w, "name"))), q(&one_line(s(w, "url"))))
        })
        .collect();
    if has_app(t, "wadbrowser") && !webapps.is_empty() {
        lines.push(format!("RUN {}", webapps.join(" && \\\n    ")));
        lines.push(String::new());
    }
    // After the web apps: root/ holds their icons (made by wadd before the build).
    lines.push("COPY root/ /".into());
    lines.join("\n") + "\n"
}

fn wadbrowser_conf(template: &Value, setup: &Value) -> Option<String> {
    let mode = if s(setup, "browserMode") == "focus" { "focus" } else { "full" };
    has_app(template, "wadbrowser").then(|| crate::generator::wadbrowser_conf(&json!({ "defaultBrowser": mode })))?
}

fn layer(key: String, from: String, files: Vec<(String, String)>) -> Value {
    let sha = layer_sha(&files);
    let files: Vec<Value> = files.into_iter().map(|(p, c)| json!({ "path": p, "content": c })).collect();
    json!({ "key": key, "ref": image_ref(&key), "from": from, "files": files, "sha": sha })
}

/// A template's build folder: `{key, ref, from, files: [{path, content}], sha}`.
/// `sha` labels the built image, so a later Dockerfile can be told apart.
pub fn template_layer(t: &Value) -> Value {
    let setup = empty_setup(s(t, "id"));
    let mut files = vec![
        ("Dockerfile".to_string(), template_dockerfile(t)),
        ("root/etc/wadspaces/layout.json".into(), layout_json_for(t, &setup)),
    ];
    if let Some(conf) = wadbrowser_conf(t, &setup) {
        files.push(("root/etc/wadspaces/wadbrowser.conf".into(), conf));
    }
    layer(format!("template:{}", s(t, "id")), DEFAULT_BASE_IMAGE.into(), files)
}

/// A customization's build folder, FROM its template's image. (wadd adds
/// the web apps' icons under root/; they follow from the web apps' sites,
/// which the Dockerfile already has, so they aren't in the sha.)
pub fn customization_layer(c: &Value, t: &Value) -> Value {
    let mut files = vec![
        ("Dockerfile".to_string(), customization_dockerfile(c, t)),
        ("root/etc/wadspaces/layout.json".into(), layout_json_for(t, c)),
    ];
    if let Some(conf) = wadbrowser_conf(t, c) {
        files.push(("root/etc/wadspaces/wadbrowser.conf".into(), conf));
    }
    layer(format!("custom:{}", s(c, "id")), image_ref(&format!("template:{}", s(t, "id"))), files)
}

/// SHA-256 of a build folder's files (path, then content), as hex.
pub fn layer_sha(files: &[(String, String)]) -> String {
    let mut h = Sha256::new();
    for (path, content) in files {
        h.update(path.as_bytes());
        h.update([0]);
        h.update(content.as_bytes());
        h.update([0]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The extension a wallpaper is stored with: a JPEG picture's "jpg", else
/// "png" (gradients and colours are drawn to a PNG).
pub fn wallpaper_ext(wallpaper: &Value) -> &'static str {
    let v = s(wallpaper, "value").to_ascii_lowercase();
    let jpeg = v.starts_with("data:image/jpeg") || v.ends_with(".jpg") || v.ends_with(".jpeg");
    if s(wallpaper, "type") == "image" && jpeg { "jpg" } else { "png" }
}

/// What wadd mounts when the wadspace starts (none of it is in an image), for
/// the Image tab: its wallpaper, project folders and secrets.
pub fn run_summary(w: &Value, projects: &[Value], slots: &[Value]) -> Vec<String> {
    let wp = w.get("wallpaper").unwrap_or(&Value::Null);
    let mut out = vec![format!(
        "wallpaper  → {WALLPAPER_DIR}/wallpaper.{} ({})",
        wallpaper_ext(wp),
        if s(wp, "type").is_empty() { "color" } else { s(wp, "type") }
    )];
    for id in strs(w, "projects") {
        if let Some(p) = projects.iter().find(|p| s(p, "id") == id) {
            out.push(format!("project    {} → ~/Desktop/{}", s(p, "name"), s(p, "mountName")));
        }
    }
    let mut by_id: Vec<(String, String, Vec<String>)> = Vec::new();
    for sl in slots {
        let Some(r) = w.get("secrets").and_then(|x| x.get(s(sl, "key"))) else { continue };
        let label = s(sl, "label").to_string();
        match by_id.iter_mut().find(|(id, ..)| id == s(r, "id")) {
            Some((.., users)) => users.push(label),
            None => by_id.push((s(r, "id").into(), s(r, "name").into(), vec![label])),
        }
    }
    for (_, name, users) in by_id {
        out.push(format!("secret     {name} → {}", users.join(", ")));
    }
    out
}

// ------------------------------------------------------- installing one

/// The wadd workspace a wadspace installs as on a machine: its layers' image
/// (or the image it had before the layers, until those are built), its name
/// and wallpaper at run time, a /config of its own, and its secrets. No
/// Super+number (that follows what's running) and no start with the machine.
/// `opts`: `{tz, secrets?: [podman secret names]}`.
pub fn workspace_for(w: &Value, template: &Value, setup: &Value, opts: &Value) -> Value {
    let id = s(w, "id");
    let legacy = w.get("legacyImage").and_then(Value::as_str).filter(|i| !i.is_empty());
    let base = w.get("base").cloned().unwrap_or(Value::Null);
    let image = legacy.map(String::from).unwrap_or_else(|| image_ref(&image_key(&base)));
    let tz = match s(opts, "tz") {
        "" => "Etc/UTC",
        tz => tz,
    };
    let mut env = Obj::new();
    for (k, v) in [("PUID", "1000"), ("PGID", "1000"), ("TZ", tz)] {
        env.insert(k.into(), v.into());
    }
    env.insert("TITLE".into(), one_line(s(w, "name")).into());
    // An image from before the layers has its wallpaper baked in.
    if legacy.is_none() {
        let wp = w.get("wallpaper").unwrap_or(&Value::Null);
        env.insert("WALLPAPER".into(), format!("{WALLPAPER_DIR}/wallpaper.{}", wallpaper_ext(wp)).into());
    }
    let mut signins = Vec::new();
    for sl in slots_for(template, setup) {
        let key = s(&sl, "key");
        let Some(r) = w.get("secrets").and_then(|x| x.get(key)).filter(|r| !s(r, "id").is_empty()) else { continue };
        let (prefix, rest) = key.split_once(':').unwrap_or(("", key));
        let mut e = Obj::new();
        e.insert("id".into(), s(r, "id").into());
        // The app the sign-in is for: a web app's id (its WadBrowser window is
        // wadspaces-webapp-<id>), VS Code for an extension's, else the app.
        let app = match prefix {
            "ext" => "vscode",
            _ => rest,
        };
        e.insert("app".into(), app.into());
        if prefix == "web" {
            e.insert("web".into(), true.into());
        }
        e.insert("name".into(), s(r, "name").into());
        e.insert("kind".into(), s(&sl, "kind").into());
        e.insert("slot".into(), key.into());
        signins.push(Value::Object(e));
    }
    let mut out = Obj::new();
    out.insert("id".into(), id.into());
    out.insert("name".into(), one_line(s(w, "name")).into());
    out.insert("image".into(), image.into());
    out.insert("display".into(), "host".into());
    out.insert("enabled".into(), true.into());
    out.insert("env".into(), Value::Object(env));
    out.insert("secrets".into(), opts.get("secrets").filter(|x| x.is_array()).cloned().unwrap_or(json!([])));
    out.insert("volumes".into(), json!([format!("wad-{id}-config:/config:z")]));
    out.insert("devices".into(), json!(["/dev/dri"]));
    out.insert("shm_size".into(), "1g".into());
    out.insert("signins".into(), Value::Array(signins));
    out.insert("hotkey".into(), Value::Null);
    out.insert("autostart".into(), false.into());
    Value::Object(out)
}

// -------------------------------------------------------- WadBrowser runs

/// Web apps used anywhere already, to add to a WadBrowser setup in a click.
pub fn known_webapps(customizations: &[Value], browsers: &[Value]) -> Vec<Value> {
    let mut seen: Vec<Value> = Vec::new();
    for w in customizations.iter().chain(browsers).flat_map(|x| js::arr(x, "webapps")) {
        if !seen.iter().any(|x| x["url"] == w["url"]) {
            seen.push(w.clone());
        }
    }
    seen
}

/// Whether a name is already taken in this list (but `except`, the one being renamed).
pub fn named(name: &str, taken: &[Value], except: Option<&str>) -> bool {
    let n = js::trim(name).to_lowercase();
    taken.iter().any(|x| Some(s(x, "id")) != except && js::trim(s(x, "name")).to_lowercase() == n)
}

// ------------------------------------------------------------------ stacks

fn by_time(mut xs: Vec<Value>) -> Vec<Value> {
    xs.sort_by(|a, b| s(a, "createdAt").cmp(s(b, "createdAt")));
    xs
}

/// Each template with what's been built on it, for Step 1's stacks (deleted
/// ones are left out: they're under "Recently deleted"). `[{template,
/// customizations: [{customization, wadspaces}], wadspaces}]`, oldest first.
pub fn stacks(lib: &Value) -> Vec<Value> {
    let live = |k: &str| js::arr(lib, k).iter().filter(|x| !deleted(x)).cloned().collect::<Vec<_>>();
    let (customizations, wadspaces) = (live("customizations"), live("wadspaces"));
    let on = |kind: &str, id: &str| {
        by_time(
            wadspaces.iter().filter(|w| s(&w["base"], "kind") == kind && s(&w["base"], "id") == id).cloned().collect(),
        )
    };
    live("templates")
        .into_iter()
        .map(|t| {
            let tid = s(&t, "id").to_string();
            let cs: Vec<Value> =
                by_time(customizations.iter().filter(|c| s(c, "templateId") == tid).cloned().collect())
                    .into_iter()
                    .map(|c| {
                        let ws = on("customization", s(&c, "id"));
                        json!({ "customization": c, "wadspaces": ws })
                    })
                    .collect();
            json!({ "template": t, "customizations": cs, "wadspaces": on("template", &tid) })
        })
        .collect()
}

/// Whether a template or customization name is in use (deleted ones still
/// hold theirs: they can be restored). `except`: the one being saved.
pub fn name_taken(name: &str, lib: &Value, except: Option<&str>) -> bool {
    let all: Vec<Value> = js::arr(lib, "templates").iter().chain(js::arr(lib, "customizations")).cloned().collect();
    named(name, &all, except)
}

// --------------------------------------------------------------- importing

/// The parts of a customization another can import.
pub const IMPORT_PARTS: &[&str] = &["webapps", "extensions", "tools", "autostart", "browserMode"];

/// What another setup has to bring into this template: how much of each
/// part, whether it fits, and why not. `{<part>: {count, ok, why?}}`.
pub fn importable(from: &Value, template: &Value) -> Value {
    let browser = has_app(template, "wadbrowser");
    let code = has_app(template, "vscode");
    let tname = s(template, "name");
    let no_browser = format!("{tname} has no WadBrowser");
    let part = |count: usize, ok: bool, why: Option<String>| {
        let mut o = json!({ "count": count, "ok": ok });
        if let Some(w) = why {
            o["why"] = w.into();
        }
        o
    };
    let n = |k: &str| js::arr(from, k).len();
    let focus = s(from, "browserMode") == "focus";
    json!({
        "webapps": part(n("webapps"), browser && n("webapps") > 0, (!browser).then(|| no_browser.clone())),
        "extensions": part(n("extensions"), code && n("extensions") > 0, (!code).then(|| format!("{tname} has no VS Code"))),
        "tools": part(n("tools"), n("tools") > 0, None),
        "autostart": part(n("autostart"), n("autostart") > 0, None),
        "browserMode": part(usize::from(focus), browser && focus, (!browser).then_some(no_browser)),
    })
}

fn same_url(a: &str, b: &str) -> bool {
    a.strip_suffix('/').unwrap_or(a) == b.strip_suffix('/').unwrap_or(b)
}

fn push_unique(list: &mut Vec<Value>, more: &[Value]) {
    for v in more {
        if !list.contains(v) {
            list.push(v.clone());
        }
    }
}

/// `into` with the chosen parts of `from` added: lists merged without
/// repeats (a web app with the same address is kept once, and boot keys
/// follow it), boot entries only for apps this template has.
pub fn import_into(into: &Value, from: &Value, template: &Value, parts: &[&str]) -> Value {
    let can = importable(from, template);
    let want = |p: &str| parts.contains(&p) && can[p]["ok"] == true;
    let mut next = setup_of(into);
    let mut renamed: Vec<(String, String)> = Vec::new();
    if want("webapps") {
        let mut webapps = js::arr(&next, "webapps").to_vec();
        for w in js::arr(from, "webapps") {
            if let Some(same) = webapps.iter().find(|x| same_url(s(x, "url"), s(w, "url"))) {
                renamed.push((s(w, "id").into(), s(same, "id").into()));
                continue;
            }
            let base = s(w, "id").to_string();
            let mut id = base.clone();
            let mut n = 2;
            while webapps.iter().any(|x| s(x, "id") == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            renamed.push((base, id.clone()));
            let mut nw = w.clone();
            nw["id"] = id.into();
            webapps.push(nw);
        }
        next["webapps"] = Value::Array(webapps);
    }
    for p in ["extensions", "tools"] {
        if want(p) {
            let mut l = js::arr(&next, p).to_vec();
            push_unique(&mut l, js::arr(from, p));
            next[p] = Value::Array(l);
        }
    }
    if want("browserMode") {
        next["browserMode"] = from["browserMode"].clone();
    }
    if want("autostart") {
        let here: Vec<String> = bootables(template, &next).iter().map(|b| s(b, "key").to_string()).collect();
        let keys: Vec<Value> = strs(from, "autostart")
            .into_iter()
            .map(|k| match k.strip_prefix("web:").and_then(|id| renamed.iter().find(|(a, _)| a == id)) {
                Some((_, to)) => format!("web:{to}"),
                None => k.to_string(),
            })
            .filter(|k| here.contains(k))
            .map(Value::from)
            .collect();
        let mut l = js::arr(&next, "autostart").to_vec();
        push_unique(&mut l, &keys);
        next["autostart"] = Value::Array(l);
    }
    next
}

// ------------------------------------------------- wadspaces from before

/// A lowercase id from a name, unique among `taken`.
fn free_id(name: &str, taken: &[&str]) -> String {
    let lower = name.to_lowercase();
    let slug = js::replace_runs(&lower, |c| !(c.is_ascii_lowercase() || c.is_ascii_digit()), "-");
    let slug = js::trim_dashes(js::ascii_prefix(js::trim_dashes(&slug), 40)).to_string();
    let base = if slug.is_empty() { "item".to_string() } else { slug };
    let mut id = base.clone();
    let mut n = 2;
    while taken.contains(&id.as_str()) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

/// A name not yet in use among templates and customizations.
fn free_name(name: &str, lib: &Value) -> String {
    let mut out = name.to_string();
    let mut n = 2;
    while name_taken(&out, lib, None) {
        out = format!("{name} {n}");
        n += 1;
    }
    out
}

/// "<first app> + <n> apps", for a template made from an old wadspace's desktop.
fn template_name(apps: &[String]) -> String {
    let first = apps.first().and_then(|id| catalog::app(id)).map(|a| a.name).unwrap_or_else(|| "Desktop".into());
    match apps.len() {
        0 | 1 => first,
        2 => format!("{first} + 1 app"),
        n => format!("{first} + {} apps", n - 1),
    }
}

/// A wadspace from before the layers (a v1 design: its layout and advanced
/// settings) as a template, a customization and a v2 wadspace.
///
/// - `lib`: `{templates, customizations}` so far (templates are reused when
///   one has the same apps; names and ids are kept unique).
/// - `opts`: `{owner, now, signins: [{id, name, app}] (the machine's),
///   legacyImage: the image it's installed with, or null; projects?: the ids
///   that exist (others are dropped)}`.
///
/// Returns `{template, newTemplate, customization, wadspace, leftOut,
/// chromeApps, notice}`: `customization` is null when nothing differs from
/// the template, and `notice` (or null) says what couldn't come across.
pub fn migrate_wadspace_v1(v1: &Value, lib: &Value, opts: &Value) -> Value {
    let now = s(opts, "now");
    let owner = s(opts, "owner");
    let name = js::trim(s(v1, "name")).to_string();
    let layout = v1.get("layout").cloned().unwrap_or(json!({ "icons": [] }));
    let adv = v1.get("advanced").cloned().unwrap_or(Value::Null);
    let machine_signins = js::arr(opts, "signins");
    let signin_ref = |id: &str, kind: &str| {
        let known = machine_signins.iter().find(|x| s(x, "id") == id);
        json!({ "id": id, "name": known.map(|k| s(k, "name")).filter(|n| !n.is_empty()).unwrap_or(id), "kind": kind })
    };

    let mut apps: Vec<String> = Vec::new();
    let mut webapps: Vec<Value> = Vec::new();
    let mut autostart: Vec<String> = Vec::new();
    let mut secrets = Obj::new();
    let (mut full, mut focus) = (false, false);
    let (mut left_out, mut chrome_apps, mut lost_signins) = (Vec::new(), Vec::new(), Vec::new());
    let add_app = |apps: &mut Vec<String>, id: &str| {
        if !apps.iter().any(|a| a == id) {
            apps.push(id.into());
        }
    };
    for icon in model::ordered_icons(&model::drop_file_icons(&layout)) {
        let app_id = s(&icon, "appId");
        let label = match js::trim(s(&icon, "label")) {
            "" => app_id.to_string(),
            l => l.to_string(),
        };
        let boot = icon.get("autostart").is_some_and(js::truthy);
        let sign_in = icon.get("signIn").and_then(Value::as_str).filter(|x| !x.is_empty());
        match recipe_for(app_id, crate::build::site_of(&icon).as_deref()) {
            Recipe::Webapp { url, chrome } => {
                add_app(&mut apps, "wadbrowser");
                if let Some(same) = webapps.iter().find(|w| same_url(s(w, "url"), &url)) {
                    if boot {
                        autostart.push(format!("web:{}", s(same, "id")));
                    }
                    continue;
                }
                let base = webapp_id(&label);
                let mut id = base.clone();
                let mut n = 2;
                while webapps.iter().any(|w| s(w, "id") == id) {
                    id = format!("{base}-{n}");
                    n += 1;
                }
                if chrome {
                    chrome_apps.push(label.clone());
                }
                if boot {
                    autostart.push(format!("web:{id}"));
                }
                if let Some(si) = sign_in {
                    secrets.insert(format!("web:{id}"), signin_ref(si, signins::WEB));
                }
                webapps.push(json!({ "id": id, "name": label, "url": url }));
            }
            Recipe::Soon { .. } => left_out.push(label),
            _ if app_id == "wadbrowser" || app_id == "wadbrowser-focus" => {
                if app_id == "wadbrowser" {
                    full = true
                } else {
                    focus = true
                }
                add_app(&mut apps, "wadbrowser");
                if boot {
                    autostart.push("app:wadbrowser".into());
                }
            }
            _ => match catalog::app(app_id) {
                Some(app) => {
                    add_app(&mut apps, &app.id);
                    if boot {
                        autostart.push(format!("app:{}", app.id));
                    }
                    if let Some(si) = sign_in {
                        match &app.secret {
                            Some((kind, _)) => {
                                secrets.insert(format!("app:{}", app.id), signin_ref(si, kind));
                            }
                            None => lost_signins.push(label),
                        }
                    }
                }
                None => left_out.push(label),
            },
        }
    }
    let mut seen_boot = Vec::new();
    autostart.retain(|k| {
        let first = !seen_boot.contains(k);
        seen_boot.push(k.clone());
        first
    });
    let browser_mode = if focus && !full { "focus" } else { "browser" };
    let tools: Vec<&str> = in_order(strs(&adv, "tools")).into_iter().filter(|t| *t != "git").collect();

    // The template: one with the same apps, else a new one.
    let mut set = apps.clone();
    set.sort();
    let existing = js::arr(lib, "templates").iter().find(|t| {
        let mut a: Vec<String> = strs(t, "apps").into_iter().map(String::from).collect();
        a.sort();
        !deleted(t) && a == set
    });
    let (template, new_template) = match existing {
        Some(t) => (t.clone(), false),
        None => {
            let tname = free_name(&template_name(&apps), lib);
            let taken: Vec<&str> = js::arr(lib, "templates").iter().map(|t| s(t, "id")).collect();
            let t = json!({
                "id": free_id(&tname, &taken), "owner": owner, "name": tname, "description": "",
                "apps": apps, "createdAt": now, "updatedAt": now,
            });
            (t, true)
        }
    };
    let tid = s(&template, "id").to_string();

    // A customization when anything differs from the template.
    let differs = !webapps.is_empty() || !tools.is_empty() || !autostart.is_empty() || browser_mode == "focus";
    let customization = if differs {
        let lib_now = {
            let mut l = lib.clone();
            if new_template && let Some(ts) = l.get_mut("templates").and_then(Value::as_array_mut) {
                ts.push(template.clone());
            }
            l
        };
        let cname = free_name(&format!("{} setup", if name.is_empty() { "Wadspace" } else { &name }), &lib_now);
        let taken: Vec<&str> = js::arr(lib, "customizations").iter().map(|c| s(c, "id")).collect();
        json!({
            "id": free_id(&cname, &taken), "owner": owner, "name": cname, "description": "",
            "templateId": tid, "browserMode": browser_mode, "webapps": webapps, "extensions": [],
            "tools": tools, "autostart": autostart, "createdAt": now, "updatedAt": now,
        })
    } else {
        Value::Null
    };
    let base = match customization.get("id").and_then(Value::as_str) {
        Some(cid) => json!({ "kind": "customization", "id": cid }),
        None => json!({ "kind": "template", "id": tid }),
    };

    let known_projects = opts.get("projects").and_then(Value::as_array);
    let projects: Vec<Value> =
        js::arr(&adv, "projects").iter().filter(|p| known_projects.is_none_or(|k| k.contains(p))).cloned().collect();
    let wallpaper = layout
        .get("wallpaper")
        .filter(|w| w.is_object())
        .cloned()
        .unwrap_or(json!({ "type": "color", "value": "#0b0b14" }));
    let mut wadspace = json!({
        "version": 2, "id": s(v1, "id"), "owner": owner, "name": name, "description": s(v1, "description"),
        "base": base, "wallpaper": wallpaper, "projects": projects, "secrets": secrets,
        "createdAt": now, "updatedAt": v1.get("updatedAt").and_then(Value::as_str).unwrap_or(now),
    });
    if let Some(img) = opts.get("legacyImage").and_then(Value::as_str).filter(|i| !i.is_empty()) {
        wadspace["legacyImage"] = img.into();
    }

    let mut notes = Vec::new();
    let mut gone = left_out.clone();
    gone.extend(lost_signins.iter().map(|l| format!("{l}'s saved sign-in")));
    if !gone.is_empty() {
        notes.push(format!("Left out of {name}: {}.", gone.join(", ")));
    }
    if !chrome_apps.is_empty() {
        let verb = if chrome_apps.len() == 1 { "opens" } else { "open" };
        notes.push(format!(
            "{} {verb} in WadBrowser now, which can't do video calls or play DRM video.",
            chrome_apps.join(", ")
        ));
    }
    json!({
        "template": template,
        "newTemplate": new_template,
        "customization": customization,
        "wadspace": wadspace,
        "leftOut": left_out,
        "chromeApps": chrome_apps,
        "notice": if notes.is_empty() { Value::Null } else { notes.join(" ").into() },
    })
}

#[cfg(test)]
mod tests;
