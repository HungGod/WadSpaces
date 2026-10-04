//! Browser profiles: where pages keep cookies, storage and cache.
//!
//! Every window shares the `default` profile, so one sign-in covers every web
//! app (as Chrome's --app windows did). A profile is one WebKit context: one
//! network process and one HTTP cache, whatever number of windows use it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use webkit2gtk::{CacheModel, MemoryPressureSettings, WebContext, WebContextExt, WebsiteDataManager};

pub const DEFAULT: &str = "default";

thread_local! {
    static CONTEXTS: RefCell<HashMap<String, WebContext>> = RefCell::new(HashMap::new());
}

/// The WebKit context of profile `name`, made on first use.
pub fn context(name: &str) -> WebContext {
    CONTEXTS.with_borrow_mut(|all| all.entry(name.to_owned()).or_insert_with(|| make(name)).clone())
}

fn make(name: &str) -> WebContext {
    let data = xdg("XDG_DATA_HOME", ".local/share").join("wadbrowser/profiles").join(name);
    let cache = xdg("XDG_CACHE_HOME", ".cache").join("wadbrowser").join(name);
    let manager = WebsiteDataManager::builder()
        .base_data_directory(data.to_string_lossy().as_ref())
        .base_cache_directory(cache.to_string_lossy().as_ref())
        .build();
    let context = WebContext::builder().website_data_manager(&manager).memory_pressure_settings(&pressure()).build();
    context.set_cache_model(CacheModel::WebBrowser);
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
