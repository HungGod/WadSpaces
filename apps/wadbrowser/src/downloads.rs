//! Downloads: saved straight to the Downloads folder (no question asked, a
//! number added if the name's taken), with progress in every window's chrome
//! and a panel to open them, show them in their folder, or cancel.

use crate::browser;
use gtk::gio;
use gtk::glib;
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Emitter;
use webkit2gtk::{Download, DownloadExt, URIResponseExt, WebContext, WebContextExt};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u64,
    pub name: String,
    #[serde(skip)]
    pub path: Option<PathBuf>,
    pub received: u64,
    pub total: u64,
    pub state: State,
}

thread_local! {
    static ITEMS: RefCell<Vec<Item>> = const { RefCell::new(Vec::new()) };
    static LIVE: RefCell<HashMap<u64, Download>> = RefCell::new(HashMap::new());
    static PUSH_QUEUED: Cell<bool> = const { Cell::new(false) };
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
const KEPT: usize = 50;

/// Wired once per profile's context.
pub fn watch(context: &WebContext) {
    context.connect_download_started(|_, d| started(d));
}

fn started(d: &Download) {
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    d.set_allow_overwrite(false);
    let total = d.response().map_or(0, |r| r.content_length());
    ITEMS.with_borrow_mut(|items| {
        items.insert(0, Item { id, name: String::new(), path: None, received: 0, total, state: State::Running });
        items.truncate(KEPT);
    });
    LIVE.with_borrow_mut(|l| l.insert(id, d.clone()));
    d.connect_decide_destination(move |d, suggested| {
        let path = unique(&dir(), &safe_name(suggested));
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        d.set_destination(&glib::filename_to_uri(&path, None).map(String::from).unwrap_or_default());
        update(id, |i| {
            i.name = name;
            i.path = Some(path);
        });
        true
    });
    d.connect_received_data(move |d, _| {
        let total = d.response().map_or(0, |r| r.content_length());
        let received = d.received_data_length();
        update(id, |i| {
            i.received = received;
            i.total = total.max(received);
        });
    });
    d.connect_failed(move |_, e| {
        let cancelled = e.matches(webkit2gtk::DownloadError::CancelledByUser);
        update(id, |i| i.state = if cancelled { State::Cancelled } else { State::Failed });
    });
    d.connect_finished(move |_| {
        update(id, |i| {
            if i.state == State::Running {
                i.state = State::Done;
                i.received = i.received.max(i.total);
            }
        });
        LIVE.with_borrow_mut(|l| l.remove(&id));
    });
    push();
}

fn update(id: u64, f: impl FnOnce(&mut Item)) {
    ITEMS.with_borrow_mut(|items| {
        if let Some(i) = items.iter_mut().find(|i| i.id == id) {
            f(i);
        }
    });
    push();
}

/// Tells every window, at most four times a second.
fn push() {
    if PUSH_QUEUED.replace(true) {
        return;
    }
    glib::timeout_add_local_once(Duration::from_millis(250), || {
        PUSH_QUEUED.set(false);
        let items = list();
        let panel = serde_json::json!({ "items": &items });
        browser::each(|label, b| {
            let _ = b.window.emit_to(label, "wb:downloads", &items);
            b.menu.update(&panel);
        });
    });
}

pub fn list() -> Vec<Item> {
    ITEMS.with_borrow(|i| i.clone())
}

/// The views downloading now (they aren't put to sleep).
pub fn busy_views() -> HashSet<usize> {
    LIVE.with_borrow(|l| l.values().filter_map(|d| d.web_view()).map(|v| crate::tab::key(&v)).collect())
}

/// What the downloads panel asks: open, show (in its folder), cancel, remove, clear.
pub fn act(id: u64, what: &str) {
    let path = ITEMS.with_borrow(|items| items.iter().find(|i| i.id == id).and_then(|i| i.path.clone()));
    match what {
        "open" => launch(path.as_deref()),
        "show" => show_in_folder(path.as_deref()),
        "cancel" => {
            if let Some(d) = LIVE.with_borrow(|l| l.get(&id).cloned()) {
                d.cancel();
            }
        }
        "remove" => ITEMS.with_borrow_mut(|items| items.retain(|i| i.id != id || i.state == State::Running)),
        "clear" => ITEMS.with_borrow_mut(|items| items.retain(|i| i.state == State::Running)),
        _ => {}
    }
    push();
}

fn launch(path: Option<&Path>) {
    let Some(uri) = path.and_then(|p| glib::filename_to_uri(p, None).ok()) else { return };
    if let Err(e) = gio::AppInfo::launch_default_for_uri(&uri, None::<&gio::AppLaunchContext>) {
        tracing::info!(%e, "no app opens this download");
    }
}

/// The file manager's ShowItems (selects it), else its folder opened.
fn show_in_folder(path: Option<&Path>) {
    let Some(path) = path else { return };
    let Some(uri) = glib::filename_to_uri(path, None).ok() else { return };
    let shown = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>).ok().is_some_and(|bus| {
        bus.call_sync(
            Some("org.freedesktop.FileManager1"),
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1",
            "ShowItems",
            Some(&(vec![uri.to_string()], "").into()),
            None,
            gio::DBusCallFlags::NONE,
            2000,
            None::<&gio::Cancellable>,
        )
        .is_ok()
    });
    if !shown {
        launch(path.parent());
    }
}

/// The Downloads folder (made if it's missing).
fn dir() -> PathBuf {
    let d =
        glib::user_special_dir(glib::UserDirectory::Downloads).unwrap_or_else(|| glib::home_dir().join("Downloads"));
    let _ = std::fs::create_dir_all(&d);
    d
}

/// A file name with no path in it.
fn safe_name(suggested: &str) -> String {
    let name: String =
        suggested.rsplit(['/', '\\']).next().unwrap_or_default().chars().filter(|c| !c.is_control()).collect();
    let name = name.trim().trim_start_matches('.').to_owned();
    if name.is_empty() { "download".into() } else { name }
}

/// `dir/name`, or `dir/name (2).ext`… if that's taken.
fn unique(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name(".bashrc"), "bashrc");
        assert_eq!(safe_name(""), "download");
        let d = tempfile::tempdir().unwrap();
        assert_eq!(unique(d.path(), "a.tar.gz"), d.path().join("a.tar.gz"));
        std::fs::write(d.path().join("a.tar.gz"), "").unwrap();
        assert_eq!(unique(d.path(), "a.tar.gz"), d.path().join("a.tar (2).gz"));
        std::fs::write(d.path().join("README"), "").unwrap();
        assert_eq!(unique(d.path(), "README"), d.path().join("README (2)"));
    }
}
