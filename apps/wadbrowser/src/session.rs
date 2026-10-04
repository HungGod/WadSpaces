//! The open windows and tabs, written down as they change, so a browser that
//! crashed (or a container stopped under it) comes back as it was. A browser
//! that quits normally (its last window closed) throws the file away, so the
//! next start is fresh.

use crate::browser::{self, First, Mode, Opts, Tab};
use gtk::glib;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Serialize, Deserialize)]
struct Saved {
    windows: Vec<SavedWindow>,
}

#[derive(Serialize, Deserialize)]
struct SavedWindow {
    mode: Mode,
    app_id: Option<String>,
    name: Option<String>,
    start: Option<String>,
    icon: Option<String>,
    profile: Option<String>,
    tabs: Vec<SavedTab>,
    active: usize,
}

#[derive(Serialize, Deserialize)]
struct SavedTab {
    url: String,
    title: String,
}

thread_local! {
    static QUEUED: Cell<bool> = const { Cell::new(false) };
    static DONE: Cell<bool> = const { Cell::new(false) };
}

fn file() -> PathBuf {
    let base = match std::env::var_os("XDG_STATE_HOME") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state"),
    };
    base.join("wadbrowser/session.json")
}

/// Writes the session down in a couple of seconds (changes come in bursts).
pub fn save_soon() {
    if DONE.get() || QUEUED.replace(true) {
        return;
    }
    glib::timeout_add_local_once(Duration::from_secs(2), || {
        QUEUED.set(false);
        if !DONE.get() {
            save();
        }
    });
}

fn save() {
    let mut windows = Vec::new();
    browser::each(|_, b| {
        let tabs: Vec<SavedTab> = b
            .tabs
            .iter()
            .filter(|t| !t.url.is_empty())
            .map(|t| SavedTab { url: t.url.clone(), title: t.title.clone() })
            .collect();
        if tabs.is_empty() {
            return;
        }
        let active = b.active.and_then(|a| b.tabs.iter().position(|t| t.id == a)).unwrap_or(0).min(tabs.len() - 1);
        let o = &b.opts;
        windows.push(SavedWindow {
            mode: o.mode,
            app_id: o.app_id.clone(),
            name: o.name.clone(),
            start: o.start.clone(),
            icon: o.icon.clone(),
            profile: o.profile.clone(),
            tabs,
            active,
        });
    });
    let path = file();
    if windows.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    let Ok(json) = serde_json::to_vec(&Saved { windows }) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("part");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

/// Quit normally: nothing to bring back next time.
pub fn clear() {
    DONE.set(true);
    let _ = std::fs::remove_file(file());
}

/// Reopens what a crashed browser had open; whether there was anything.
/// Only each window's shown tab loads now; the rest wake when looked at.
pub fn restore(app: &AppHandle) -> bool {
    let Some(saved) = std::fs::read(file()).ok().and_then(|b| serde_json::from_slice::<Saved>(&b).ok()) else {
        return false;
    };
    let mut any = false;
    for w in saved.windows {
        let opts =
            Opts { mode: w.mode, app_id: w.app_id, name: w.name, start: w.start, icon: w.icon, profile: w.profile };
        let tabs: Vec<Tab> = w
            .tabs
            .into_iter()
            .enumerate()
            .map(|(i, t)| if i == w.active { crate::tab::new_tab(&opts, &t.url) } else { Tab::asleep(t.url, t.title) })
            .collect();
        match browser::open(app, opts, First::Restored { tabs, active: w.active }) {
            Ok(_) => any = true,
            Err(e) => tracing::warn!(%e, "can't bring a window back"),
        }
    }
    any
}
