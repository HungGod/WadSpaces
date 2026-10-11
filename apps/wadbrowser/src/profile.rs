//! Browser profiles: where pages keep cookies, storage and cache.
//!
//! Windows share the `default` profile, so one sign-in covers every web app
//! (as Chrome's --app windows did). A profile is one WebKit context: one
//! network process and one HTTP cache, whatever number of windows use it.
//!
//! In a wadspace, a web app can use a saved sign-in instead: a folder on the
//! machine, mounted into each wadspace that uses it (so signing in once
//! covers all of them). wadd lists them in /run/wadspaces-extra/signins.json;
//! such an app's windows get profile `signin-<id>`, whose data is that
//! folder. Its cache stays this wadspace's own.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use webkit2gtk::{
    CacheModel, CookieManagerExt, CookiePersistentStorage, MemoryPressureSettings, SecurityManagerExt, WebContext,
    WebContextExt, WebsiteDataManager,
};

pub const DEFAULT: &str = "default";
const SIGNIN: &str = "signin-";
const SIGNINS: &str = "/run/wadspaces-extra/signins.json";

/// A saved web sign-in this wadspace mounts: its id, folder and web apps.
#[derive(Debug, serde::Deserialize)]
struct WebSignIn {
    id: String,
    #[serde(default)]
    web: bool,
    #[serde(default)]
    apps: Vec<String>,
    dir: PathBuf,
}

#[derive(serde::Deserialize)]
struct Manifest {
    #[serde(default)]
    signins: Vec<WebSignIn>,
}

/// The web sign-ins (read once; `WADBROWSER_SIGNINS` names another file).
fn signins() -> &'static [WebSignIn] {
    static ALL: OnceLock<Vec<WebSignIn>> = OnceLock::new();
    ALL.get_or_init(|| {
        let path = std::env::var_os("WADBROWSER_SIGNINS").map(PathBuf::from).unwrap_or_else(|| SIGNINS.into());
        let Ok(text) = std::fs::read_to_string(&path) else { return vec![] };
        match serde_json::from_str::<Manifest>(&text) {
            Ok(m) => m.signins.into_iter().filter(|s| s.web && s.dir.is_dir()).collect(),
            Err(e) => {
                eprintln!("wadbrowser: {}: {e}", path.display());
                vec![]
            }
        }
    })
}

/// The profile of a web app (its window's app_id, `wadspaces-webapp-<id>`)
/// with a saved sign-in, if it has one.
pub fn for_app(app_id: &str) -> Option<String> {
    let id = app_id.strip_prefix("wadspaces-webapp-")?;
    signins().iter().find(|s| s.apps.iter().any(|a| a == id)).map(|s| format!("{SIGNIN}{}", s.id))
}

/// A saved sign-in's profile (only while this wadspace mounts it).
pub fn is_signin(name: &str) -> bool {
    name.starts_with(SIGNIN)
}

/// Where a profile's cookies and storage live.
fn data_dir(name: &str) -> PathBuf {
    if let Some(id) = name.strip_prefix(SIGNIN)
        && let Some(s) = signins().iter().find(|s| s.id == id)
    {
        return s.dir.clone();
    }
    xdg("XDG_DATA_HOME", ".local/share").join("wadbrowser/profiles").join(name)
}

thread_local! {
    static CONTEXTS: RefCell<HashMap<String, WebContext>> = RefCell::new(HashMap::new());
}

/// The WebKit context of profile `name`, made on first use.
pub fn context(name: &str) -> WebContext {
    CONTEXTS.with_borrow_mut(|all| all.entry(name.to_owned()).or_insert_with(|| make(name)).clone())
}

fn make(name: &str) -> WebContext {
    let data = data_dir(name);
    let cache = xdg("XDG_CACHE_HOME", ".cache").join("wadbrowser").join(name);
    let manager = WebsiteDataManager::builder()
        .base_data_directory(data.to_string_lossy().as_ref())
        .base_cache_directory(cache.to_string_lossy().as_ref())
        .build();
    let context = WebContext::builder().website_data_manager(&manager).memory_pressure_settings(&pressure()).build();
    context.set_cache_model(CacheModel::WebBrowser);
    // Kept on disk, so a sign-in outlasts the browser.
    if let Some(cookies) = context.cookie_manager() {
        cookies.set_persistent_storage(&data.join("cookies.sqlite").to_string_lossy(), CookiePersistentStorage::Sqlite);
    }
    context.register_uri_scheme(crate::pages::SCHEME, crate::pages::serve);
    if let Some(sec) = context.security_manager() {
        // Its own pages: treated like https (no mixed-content warnings).
        sec.register_uri_scheme_as_secure(crate::pages::SCHEME);
    }
    crate::downloads::watch(&context);
    context.set_favicon_database_directory(Some(&data.join("favicons").to_string_lossy()));
    context
}

/// Web processes start shedding caches well before the machine runs short: a
/// limit of a quarter of RAM each, caches dropped from a third of it.
fn pressure() -> MemoryPressureSettings {
    let mut settings = MemoryPressureSettings::new();
    if let Some(mb) = total_ram_mb() {
        settings.set_memory_limit((mb / 4).clamp(512, 8192));
    }
    settings.set_conservative_threshold(0.33);
    settings.set_strict_threshold(0.5);
    settings
}

fn total_ram_mb() -> Option<u32> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb: u64 = info.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
    u32::try_from(kb / 1024).ok()
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into())).join(fallback),
    }
}
