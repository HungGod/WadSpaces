//! Everything a user can do to a window, whichever way they asked: a
//! shortcut (`keys.rs`), a menu item (`menu.rs`) or a chrome button. The
//! chrome and the menus send these as JSON: `{"do": "tab-close", "tab": 3}`.

use crate::browser::{self, First, Mode};
use crate::zoom::{self, Step};
use gtk::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use webkit2gtk::{PrintOperation, PrintOperationExt, WebInspectorExt, WebViewExt};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "do", rename_all = "kebab-case")]
pub enum Action {
    NewTab,
    NewWindow,
    CloseTab,
    ReopenTab,
    NextTab,
    PrevTab,
    /// Ctrl+1..8.
    NthTab {
        index: usize,
    },
    /// Ctrl+9.
    LastTab,
    Back,
    Forward,
    Reload,
    ReloadHard,
    Stop,
    Home,
    FocusUrl,
    Find,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    Print,
    Fullscreen,
    DevTools,
    Downloads,
    Menu,
    TabSelect {
        tab: u64,
    },
    TabClose {
        tab: u64,
    },
    TabReload {
        tab: u64,
    },
    TabDuplicate {
        tab: u64,
    },
    TabCloseOthers {
        tab: u64,
    },
    TabNewWindow {
        tab: u64,
    },
    TabMute {
        tab: u64,
    },
}

/// Does `action` in window `label`.
pub fn run(app: &AppHandle, label: &str, action: Action) {
    use Action::*;
    match action {
        NewWindow => {
            let Some(opts) = browser::with(label, |b| b.opts.clone()) else { return };
            if let Err(e) = browser::open(app, opts, First::Urls(vec![])) {
                tracing::warn!(%e, "can't open a window");
            }
        }
        TabNewWindow { tab } => {
            if let Err(e) = browser::move_tab(app, label, tab, None, None) {
                tracing::warn!(%e, "can't move the tab");
            }
        }
        DevTools => {
            browser::with(label, |b| {
                if let Some(i) = b.active_view().and_then(|v| v.inspector()) {
                    i.show();
                }
            });
        }
        Print => {
            let Some((view, parent)) = browser::with(label, |b| (b.active_view().cloned(), b.window.gtk_window().ok()))
            else {
                return;
            };
            if let Some(view) = view {
                PrintOperation::builder().web_view(&view).build().run_dialog(parent.as_ref());
            }
        }
        other => {
            browser::with(label, |b| act(b, label, other));
        }
    }
}

fn act(b: &mut browser::Browser, label: &str, action: Action) {
    use Action::*;
    let ids: Vec<u64> = b.tabs.iter().map(|t| t.id).collect();
    let at = b.active.and_then(|a| ids.iter().position(|&i| i == a)).unwrap_or(0);
    let emit = |b: &browser::Browser, event: &str| {
        let _ = b.window.emit_to(label, event, ());
    };
    match action {
        NewTab if b.opts.mode != Mode::Focus || b.opts.home() != "about:blank" => {
            b.new_tab(None, false);
        }
        NewTab => {}
        CloseTab => {
            if let Some(a) = b.active {
                b.close_tab(a);
            }
        }
        ReopenTab => b.reopen_closed(),
        NextTab if !ids.is_empty() => b.select(ids[(at + 1) % ids.len()]),
        PrevTab if !ids.is_empty() => b.select(ids[(at + ids.len() - 1) % ids.len()]),
        NthTab { index } => {
            if let Some(&id) = ids.get(index) {
                b.select(id);
            }
        }
        LastTab => {
            if let Some(&id) = ids.last() {
                b.select(id);
            }
        }
        Back | Forward | Reload | ReloadHard | Stop | Home => {
            let home = b.opts.home();
            let Some(v) = b.active_view() else { return };
            match action {
                Back => v.go_back(),
                Forward => v.go_forward(),
                Reload => v.reload(),
                ReloadHard => v.reload_bypass_cache(),
                Stop => v.stop_loading(),
                _ => v.load_uri(&home),
            }
        }
        FocusUrl if b.opts.mode == Mode::Full => {
            b.chrome.grab_focus();
            emit(b, "wb:focus-url");
        }
        Find => {
            b.chrome.grab_focus();
            emit(b, "wb:find");
        }
        Downloads => emit(b, "wb:open-downloads"),
        Menu => emit(b, "wb:open-menu"),
        ZoomIn | ZoomOut | ZoomReset => {
            if let Some(v) = b.active_view() {
                zoom::change(
                    v,
                    match action {
                        ZoomIn => Step::In,
                        ZoomOut => Step::Out,
                        _ => Step::Reset,
                    },
                );
            }
            b.push();
        }
        Fullscreen => {
            let on = !b.is_fullscreen();
            b.set_fullscreen(on);
        }
        TabSelect { tab } => b.select(tab),
        TabClose { tab } => b.close_tab(tab),
        TabReload { tab } => {
            if let Some(v) = b.view(tab) {
                v.reload();
            } else {
                b.select(tab);
            }
        }
        TabDuplicate { tab } => {
            if let Some(url) = b.tab(tab).map(|t| t.url.clone()) {
                b.new_tab(Some(&url), false);
            }
        }
        TabCloseOthers { tab } => {
            for id in ids.into_iter().filter(|&i| i != tab) {
                b.close_tab(id);
            }
        }
        TabMute { tab } => {
            if let Some(v) = b.view(tab) {
                v.set_is_muted(!v.is_muted());
            }
            b.push();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_forms() {
        let a: Action = serde_json::from_str(r#"{"do":"tab-close","tab":3}"#).unwrap();
        assert_eq!(a, Action::TabClose { tab: 3 });
        let a: Action = serde_json::from_str(r#"{"do":"reload-hard"}"#).unwrap();
        assert_eq!(a, Action::ReloadHard);
        assert!(serde_json::from_str::<Action>(r#"{"do":"rm-rf"}"#).is_err());
    }
}
