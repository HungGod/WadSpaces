//! What the chrome (ui/chrome.js) calls. Sync commands: Tauri runs them on
//! the main thread, where the windows live.

use crate::actions::{self, Action};
use crate::browser::{self, with};
use crate::{downloads, permissions, urlbar};
use gtk::glib;
use gtk::prelude::*;
use tauri::{AppHandle, WebviewWindow};
use webkit2gtk::{FindControllerExt, FindOptions, WebViewExt};

/// The chrome is up and listening: its first state; pushes from now on.
#[tauri::command]
pub fn chrome_ready(window: WebviewWindow) -> Option<serde_json::Value> {
    with(window.label(), |b| b.mark_ready())
}

#[tauri::command]
pub fn act(app: AppHandle, window: WebviewWindow, action: Action) {
    actions::run(&app, window.label(), action);
}

/// What was typed in the URL bar: an address, or a search.
#[tauri::command]
pub fn navigate(window: WebviewWindow, input: String) {
    let search = &crate::config::get().search;
    with(window.label(), |b| {
        if let (Some(view), Some(url)) = (b.active_view(), urlbar::resolve(&input, search)) {
            view.load_uri(&url);
            view.grab_focus();
        }
    });
}

#[tauri::command]
pub fn focus_page(window: WebviewWindow) {
    with(window.label(), |b| {
        if let Some(v) = b.active_view() {
            v.grab_focus();
        }
    });
}

/// The chrome's height in px (it grows for the find row, a question).
#[tauri::command]
pub fn chrome_height(window: WebviewWindow, height: i32) {
    with(window.label(), |b| b.set_chrome_height(height));
}

#[tauri::command]
pub fn tab_move(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
    to: Option<String>,
    index: Option<usize>,
) -> Result<(), String> {
    browser::move_tab(&app, window.label(), id, to.as_deref(), index)
}

// ---- tabs dragged between windows ----

thread_local! {
    /// The tab being dragged, and its window: the window it's dropped on
    /// learns which tab from here (a drag's data can't be trusted across views).
    static DRAG: std::cell::RefCell<Option<(String, u64)>> = const { std::cell::RefCell::new(None) };
}

#[tauri::command]
pub fn tab_drag_begin(window: WebviewWindow, id: u64) {
    DRAG.set(Some((window.label().to_owned(), id)));
}

/// The dragged tab was dropped on this window's strip at `index`.
#[tauri::command]
pub fn tab_drop(app: AppHandle, window: WebviewWindow, index: usize) -> Result<(), String> {
    let Some((from, id)) = DRAG.take() else { return Ok(()) };
    browser::move_tab(&app, &from, id, Some(window.label()), Some(index))
}

/// The drag ended. With `detach` (no strip took it), the tab gets a window of
/// its own, unless it's its window's only tab. A drop on another window may
/// still be on its way, so this waits a moment for it.
#[tauri::command]
pub fn tab_drag_end(app: AppHandle, detach: bool) {
    if !detach {
        DRAG.set(None);
        return;
    }
    glib::timeout_add_local_once(std::time::Duration::from_millis(150), move || {
        let Some((from, id)) = DRAG.take() else { return };
        if with(&from, |b| b.tabs.len() > 1) == Some(true)
            && let Err(e) = browser::move_tab(&app, &from, id, None, None)
        {
            tracing::warn!(%e, "can't detach the tab");
        }
    });
}

// ---- menus and panels ----

/// Shows a menu or panel at (x, y) of the window, `width` × `height`.
#[tauri::command]
pub fn popup_show(
    window: WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    kind: String,
    data: serde_json::Value,
) {
    with(window.label(), |b| b.menu.show(x, y, width, height, &kind, &data));
}

#[tauri::command]
pub fn popup_hide(window: WebviewWindow) {
    with(window.label(), |b| b.menu.hide());
}

#[tauri::command]
pub fn downloads_list() -> Vec<downloads::Item> {
    downloads::list()
}

#[tauri::command]
pub fn download_act(id: u64, what: String) {
    downloads::act(id, &what);
}

// ---- find in page ----

/// Finds `text` in the page: `step` 0 starts, 1 next, -1 previous. The match
/// count comes back as a `wb:find-count` event.
#[tauri::command]
pub fn find(window: WebviewWindow, text: String, step: i32) {
    with(window.label(), |b| {
        let Some(fc) = b.active_view().and_then(|v| v.find_controller()) else { return };
        if text.is_empty() {
            fc.search_finish();
            return;
        }
        let opts = (FindOptions::CASE_INSENSITIVE | FindOptions::WRAP_AROUND).bits();
        match step {
            1 if fc.search_text().as_deref() == Some(&text) => fc.search_next(),
            -1 if fc.search_text().as_deref() == Some(&text) => fc.search_previous(),
            _ => {
                let label = window.label().to_owned();
                fc.connect_counted_matches(move |_, n| {
                    let label = label.clone();
                    glib::idle_add_local_once(move || {
                        with(&label, |b| {
                            use tauri::Emitter;
                            let _ = b.window.emit_to(&label, "wb:find-count", n);
                        });
                    });
                });
                fc.count_matches(&text, opts, 1000);
                fc.search(&text, opts, 1000);
            }
        }
    });
}

#[tauri::command]
pub fn find_close(window: WebviewWindow) {
    with(window.label(), |b| {
        if let Some(v) = b.active_view() {
            if let Some(fc) = v.find_controller() {
                fc.search_finish();
            }
            v.grab_focus();
        }
    });
}

// ---- permission questions ----

#[tauri::command]
pub fn prompt_answer(id: u64, allow: bool, remember: bool) {
    permissions::answer(id, allow, remember);
}

#[tauri::command]
pub fn win_action(window: WebviewWindow, action: String) {
    let _ = match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            _ => window.maximize(),
        },
        "close" => {
            with(window.label(), |b| b.close_window());
            Ok(())
        }
        _ => Ok(()),
    };
}
