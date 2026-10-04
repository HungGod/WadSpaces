//! The chrome's menus and panels (the ⋮ menu, a tab's menu, downloads): a
//! transparent view in a popup surface of its own over the window, so the
//! compositor blends its rounded corners and shadow over the page. (GTK 3
//! can't blend one WebKit view over another inside a window: each owns a
//! child window, drawn opaque.) It shares the chrome's web process.
//!
//! It's shown with a seat grab, like GTK's own menus: it takes the keyboard,
//! and a click anywhere else closes it.

use crate::actions::{self, Action};
use crate::gpu;
use gtk::gdk;
use gtk::glib;
use gtk::prelude::*;
use javascriptcore::ValueExt;
use tauri::AppHandle;
use webkit2gtk::{Settings, SettingsExt, UserContentManager, UserContentManagerExt, WebView, WebViewExt};

pub struct Menu {
    win: gtk::Window,
    view: WebView,
    parent: gtk::ApplicationWindow,
}

impl Menu {
    pub fn new(app: &AppHandle, label: &str, chrome: &WebView, parent: &gtk::ApplicationWindow) -> Menu {
        let messages = UserContentManager::new();
        messages.register_script_message_handler("wb");
        let (app, label) = (app.clone(), label.to_owned());
        messages.connect_script_message_received(Some("wb"), move |_, msg| {
            let text = msg.js_value().map(|v| v.to_str().to_string()).unwrap_or_default();
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else { return };
            let (app, label) = (app.clone(), label.clone());
            // Not inside WebKit's callback: on the next turn.
            glib::idle_add_local_once(move || message(&app, &label, &msg));
        });
        let settings = Settings::new();
        settings.set_hardware_acceleration_policy(gpu::policy());
        let view = WebView::builder().related_view(chrome).settings(&settings).user_content_manager(&messages).build();
        view.set_background_color(&gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
        view.load_html(include_str!("../ui/popup.html"), None);

        let win = gtk::Window::new(gtk::WindowType::Popup);
        if let Some(rgba) = GtkWindowExt::screen(&win).and_then(|s| s.rgba_visual()) {
            win.set_visual(Some(&rgba));
        }
        win.set_app_paintable(true);
        win.set_type_hint(gdk::WindowTypeHint::PopupMenu);
        win.set_transient_for(Some(parent));
        win.add(&view);
        view.show();
        win.connect_grab_broken_event(|w, _| {
            w.hide();
            glib::Propagation::Proceed
        });
        win.connect_key_press_event(|w, e| {
            if e.keyval() == gdk::keys::constants::Escape {
                w.hide();
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        win.connect_hide(|w| {
            if let Some(seat) = w.display().default_seat() {
                seat.ungrab();
            }
        });
        Menu { win, view, parent: parent.clone() }
    }

    /// Draws `kind` with `data`, at (x, y) in the window, `width` × `height`.
    pub fn show(&self, x: i32, y: i32, width: i32, height: i32, kind: &str, data: &serde_json::Value) {
        let script = format!(
            "window.wbPopup && window.wbPopup.show({}, {})",
            serde_json::to_string(kind).unwrap_or_default(),
            data
        );
        self.view.evaluate_javascript(&script, None, None, None::<&gtk::gio::Cancellable>, |_| {});
        if self.win.is_visible() {
            self.win.hide();
        }
        let (ox, oy) = self
            .parent
            .window()
            .map(|w| {
                let (_, x, y) = w.origin();
                (x, y)
            })
            .unwrap_or_default();
        let (w, h) = (width.clamp(1, 1200), height.clamp(1, 1000));
        self.view.set_size_request(w, h);
        self.win.resize(w, h);
        self.win.move_(ox + x.max(0), oy + y.max(0));
        self.win.realize();
        let grabbed = match (self.win.window(), self.win.display().default_seat()) {
            (Some(gw), Some(seat)) => {
                let win = self.win.clone();
                let mut map = move |_: &gdk::Seat, _: &gdk::Window| win.show();
                seat.grab(&gw, gdk::SeatCapabilities::ALL, true, None, None, Some(&mut map)) == gdk::GrabStatus::Success
            }
            _ => false,
        };
        if !grabbed {
            self.win.show();
        }
        self.view.grab_focus();
    }

    pub fn hide(&self) {
        if self.win.is_visible() {
            self.win.hide();
        }
    }

    pub fn update(&self, data: &serde_json::Value) {
        if self.win.is_visible() {
            let script = format!("window.wbPopup && window.wbPopup.update({data})");
            self.view.evaluate_javascript(&script, None, None, None::<&gtk::gio::Cancellable>, |_| {});
        }
    }

    #[cfg(feature = "spike")]
    pub fn window(&self) -> gtk::Window {
        self.win.clone()
    }
}

/// A click in the menu: `{"kind": "act", "action": {...}}`, `{"kind":
/// "download", "id": 3, "what": "open"}`, or `{"kind": "close"}`.
fn message(app: &AppHandle, label: &str, msg: &serde_json::Value) {
    let keep_open = msg["keep"].as_bool().unwrap_or(false);
    if !keep_open {
        crate::browser::with(label, |b| b.menu.hide());
    }
    match msg["kind"].as_str() {
        Some("act") => match serde_json::from_value::<Action>(msg["action"].clone()) {
            Ok(a) => {
                actions::run(app, label, a);
                if keep_open {
                    // The zoom row stays open, showing the new level.
                    crate::browser::with(label, |b| {
                        let zoom = b.state_zoom();
                        b.menu.update(&serde_json::json!({ "zoom": zoom }));
                    });
                }
            }
            Err(e) => tracing::warn!(%e, "a menu item with a bad action"),
        },
        Some("download") => {
            if let (Some(id), Some(what)) = (msg["id"].as_u64(), msg["what"].as_str()) {
                crate::downloads::act(id, what);
            }
        }
        _ => {}
    }
}
