//! Browser windows and their tabs.
//!
//! GTK objects live on the main thread only, so the windows are kept in a
//! thread-local and Tauri's (sync) commands, which run on the main thread, use
//! them directly. WebKit's signals can fire while that table is borrowed (a
//! load starting inside `load_uri`, say), so they never touch it: they mark the
//! tab's window for a state push on the next idle turn.

use crate::{app_id, gpu, profile, urlbar};
use gtk::glib;
use gtk::prelude::*;
use javascriptcore::ValueExt;
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use webkit2gtk::{
    AutoplayPolicy, LoadEvent, Settings, SettingsExt, UserContentManager, UserContentManagerExt, WebView, WebViewExt,
    WebsitePolicies, WindowPropertiesExt,
};

type Error = Box<dyn std::error::Error>;

/// The chrome's height: tabs plus the URL bar row, or one slim row.
const CHROME_FULL: i32 = 76;
const CHROME_SLIM: i32 = 38;
const BACKGROUND: tauri::window::Color = tauri::window::Color(32, 33, 36, 255);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Tabs and a URL bar.
    #[default]
    Full,
    /// Tabs, no URL bar: pages arrive by links and by xdg-open.
    Focus,
    /// One web app's window: its own app_id and name, no URL bar, and a tab
    /// strip only once there's a second tab.
    App,
}

#[derive(Clone, Debug, Default)]
pub struct Opts {
    pub mode: Mode,
    /// For [`Mode::App`]: the app_id (`wadspaces-webapp-<id>`) and its name.
    pub app_id: Option<String>,
    pub name: Option<String>,
    pub url: Option<String>,
    pub profile: Option<String>,
}

impl Opts {
    fn profile(&self) -> &str {
        self.profile.as_deref().unwrap_or(profile::DEFAULT)
    }
    fn home(&self) -> String {
        self.url.clone().unwrap_or_else(|| "about:blank".into())
    }
}

struct Tab {
    id: u64,
    view: WebView,
}

/// The chrome's menus and panels: a transparent view in a popup surface of
/// its own over the window, so the compositor blends its rounded corners and
/// shadow over the page (GTK 3 can't blend one WebKit view over another).
struct Menu {
    win: gtk::Window,
    view: WebView,
}

struct Browser {
    window: WebviewWindow,
    stack: gtk::Stack,
    menu: Menu,
    tabs: Vec<Tab>,
    active: Option<u64>,
    opts: Opts,
    ready: bool,
}

thread_local! {
    static BROWSERS: RefCell<HashMap<String, Browser>> = RefCell::new(HashMap::new());
    /// Each tab's id by its view (its GObject's address), for WebKit's signals.
    static VIEW_TAB: RefCell<HashMap<usize, u64>> = RefCell::new(HashMap::new());
    static DIRTY: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
    static PUSH_QUEUED: Cell<bool> = const { Cell::new(false) };
    /// The tab being dragged, and its window: drags cross windows, and the
    /// window a tab is dropped on learns which tab from here.
    static DRAG: RefCell<Option<(String, u64)>> = const { RefCell::new(None) };
}

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
static NEXT_TAB: AtomicU64 = AtomicU64::new(1);

/// What a new window starts with.
enum First {
    Url(Option<String>),
    /// A tab moved from another window, live.
    Tab(Tab),
}

/// Opens a browser window; its label.
pub fn open(app: &AppHandle, opts: Opts) -> Result<String, Error> {
    open_with(app, opts, First::Url(None))
}

fn open_with(app: &AppHandle, opts: Opts, first: First) -> Result<String, Error> {
    let label = format!("w{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let title = opts.name.clone().unwrap_or_else(|| "WadBrowser".into());
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(1100.0, 750.0)
        .min_inner_size(400.0, 300.0)
        .decorations(false)
        .visible(false)
        .background_color(BACKGROUND)
        // Tauri's own drop handler would swallow the chrome's tab drags.
        .disable_drag_drop_handler()
        .build()?;

    let vbox = window.default_vbox()?;
    let chrome =
        vbox.children().into_iter().find_map(|w| w.downcast::<WebView>().ok()).ok_or("Tauri made no chrome webview")?;
    vbox.set_child_packing(&chrome, false, true, 0, gtk::PackType::Start);
    chrome.set_size_request(-1, if opts.mode == Mode::Full { CHROME_FULL } else { CHROME_SLIM });

    let stack = gtk::Stack::new();
    stack.set_hexpand(true);
    stack.set_vexpand(true);
    let overlay = gtk::Overlay::new();
    overlay.add(&stack);
    vbox.pack_start(&overlay, true, true, 0);

    let gtk_window = window.gtk_window()?;
    let menu = menu(app, &label, &chrome, &gtk_window);
    let app_id = opts.app_id.clone().filter(|id| app_id::valid(id)).unwrap_or_else(|| app_id::DEFAULT.into());
    let first = match first {
        First::Tab(tab) => tab,
        First::Url(url) => {
            let url = url.unwrap_or_else(|| opts.home());
            new_tab(&opts, None, &url)
        }
    };
    let first_id = first.id;
    stack.add(&first.view);
    BROWSERS.with_borrow_mut(|all| {
        all.insert(
            label.clone(),
            Browser {
                window: window.clone(),
                stack,
                menu,
                tabs: vec![first],
                active: Some(first_id),
                opts,
                ready: false,
            },
        )
    });

    let closing = label.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            let label = closing.clone();
            glib::idle_add_local_once(move || {
                BROWSERS.with_borrow_mut(|all| all.remove(&label));
            });
        }
    });

    app_id::show_as(&gtk_window, &app_id);
    with(&label, |b| b.select(first_id));
    Ok(label)
}

fn menu(app: &AppHandle, label: &str, chrome: &WebView, parent: &gtk::ApplicationWindow) -> Menu {
    let messages = UserContentManager::new();
    messages.register_script_message_handler("wb");
    let (app, label) = (app.clone(), label.to_owned());
    messages.connect_script_message_received(Some("wb"), move |_, msg| {
        let text = msg.js_value().map(|v| v.to_str().to_string()).unwrap_or_default();
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        let (app, label) = (app.clone(), label.clone());
        // Not inside WebKit's callback: on the next turn.
        glib::idle_add_local_once(move || menu_message(&app, &label, &msg));
    });
    let settings = Settings::new();
    settings.set_hardware_acceleration_policy(gpu::policy());
    // It shares the chrome's web process: a menu costs no new process.
    let view = WebView::builder().related_view(chrome).settings(&settings).user_content_manager(&messages).build();
    view.set_background_color(&gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
    view.load_html(include_str!("../ui/popup.html"), None);

    let win = gtk::Window::new(gtk::WindowType::Popup);
    if let Some(rgba) = GtkWindowExt::screen(&win).and_then(|s| s.rgba_visual()) {
        win.set_visual(Some(&rgba));
    }
    win.set_app_paintable(true);
    win.set_type_hint(gtk::gdk::WindowTypeHint::PopupMenu);
    win.set_transient_for(Some(parent));
    win.add(&view);
    view.show();
    Menu { win, view }
}

fn menu_message(app: &AppHandle, label: &str, msg: &serde_json::Value) {
    with(label, |b| b.menu.win.hide());
    if msg["kind"] != "menu" {
        return;
    }
    match msg["id"].as_str().unwrap_or_default() {
        "new-tab" => {
            with(label, |b| b.new_tab(None));
        }
        "new-window" => {
            if let Some(opts) = with(label, |b| b.opts.clone()) {
                let opts = Opts { url: None, ..opts };
                if let Err(e) = open(app, opts) {
                    tracing::warn!(%e, "can't open a window");
                }
            }
        }
        "fullscreen" => {
            with(label, |b| b.window.set_fullscreen(!b.window.is_fullscreen().unwrap_or(false)));
        }
        other => tracing::debug!(other, "menu item not built yet"),
    }
}

fn settings() -> Settings {
    let s = Settings::new();
    s.set_hardware_acceleration_policy(gpu::policy());
    s.set_enable_developer_extras(std::env::var_os("WADBROWSER_DEVTOOLS").is_some());
    s.set_javascript_can_open_windows_automatically(true);
    s.set_enable_back_forward_navigation_gestures(true);
    s.set_enable_site_specific_quirks(true);
    s.set_media_playback_requires_user_gesture(false);
    s.set_enable_smooth_scrolling(true);
    s
}

fn new_tab(opts: &Opts, related: Option<&WebView>, url: &str) -> Tab {
    let tab = Tab::new(tab_view(opts, related));
    if !url.is_empty() {
        tab.view.load_uri(url);
    }
    tab
}

impl Tab {
    fn new(view: WebView) -> Tab {
        let id = NEXT_TAB.fetch_add(1, Ordering::Relaxed);
        VIEW_TAB.with_borrow_mut(|m| m.insert(key(&view), id));
        Tab { id, view }
    }
}

impl Drop for Tab {
    fn drop(&mut self) {
        // Moving a tab moves this struct, so a drop is the tab closing.
        let _ = VIEW_TAB.try_with(|m| m.borrow_mut().remove(&key(&self.view)));
    }
}

fn key(view: &WebView) -> usize {
    view.as_ptr() as usize
}

fn tab_view(opts: &Opts, related: Option<&WebView>) -> WebView {
    let policies = WebsitePolicies::builder().autoplay(AutoplayPolicy::Allow).build();
    let builder = WebView::builder().settings(&settings()).website_policies(&policies);
    let view = match related {
        // A page's popup: same process and context as its opener, so
        // window.opener (sign-in popups) works.
        Some(opener) => builder.related_view(opener).build(),
        None => builder.web_context(&profile::context(opts.profile())).build(),
    };
    view.set_hexpand(true);
    view.set_vexpand(true);
    watch(&view);
    view
}

/// Tab state changes push the window's state to its chrome (batched).
fn watch(view: &WebView) {
    view.connect_title_notify(dirty);
    view.connect_uri_notify(dirty);
    view.connect_estimated_load_progress_notify(dirty);
    view.connect_is_loading_notify(dirty);
    view.connect_load_changed(|v, e| {
        if matches!(e, LoadEvent::Committed | LoadEvent::Finished) {
            dirty(v);
        }
    });
    view.connect_create(|opener, _action| {
        let popup = new_popup_view(opener)?;
        Some(popup.upcast())
    });
}

/// A page asked for a new window: a popup window when it gave a size (sign-in
/// flows), else a new tab beside it.
fn new_popup_view(opener: &WebView) -> Option<WebView> {
    let (label, opts) = BROWSERS.with_borrow(|all| {
        all.iter().find(|(_, b)| b.tab_of(opener).is_some()).map(|(l, b)| (l.clone(), b.opts.clone()))
    })?;
    let view = tab_view(&opts, Some(opener));
    view.connect_ready_to_show(move |v| {
        let sized = v.window_properties().map(|p| p.geometry()).is_some_and(|g| g.width() > 0 && g.height() > 0);
        if sized {
            popup_window(v);
        } else {
            let tab = Tab::new(v.clone());
            let id = tab.id;
            let label = label.clone();
            glib::idle_add_local_once(move || {
                with(&label, |b| {
                    b.insert(tab, None);
                    b.select(id);
                });
            });
        }
    });
    Some(view)
}

/// A sized popup: a plain window of its own, closed when the page closes it.
fn popup_window(view: &WebView) {
    let win = gtk::Window::new(gtk::WindowType::Toplevel);
    let (w, h) = view
        .window_properties()
        .map(|p| p.geometry())
        .map_or((520, 660), |g| (g.width().max(320), g.height().max(240)));
    win.set_default_size(w, h);
    win.add(view);
    view.connect_title_notify(glib::clone!(@weak win => move |v| {
        win.set_title(&v.title().unwrap_or_default());
    }));
    view.connect_close(glib::clone!(@weak win => move |_| win.close()));
    win.show_all();
}

fn dirty(view: &WebView) {
    let Some(id) = VIEW_TAB.with_borrow(|m| m.get(&key(view)).copied()) else { return };
    DIRTY.with_borrow_mut(|d| d.insert(id));
    if !PUSH_QUEUED.replace(true) {
        glib::idle_add_local_once(|| {
            PUSH_QUEUED.set(false);
            let ids = DIRTY.take();
            BROWSERS.with_borrow(|all| {
                for b in all.values().filter(|b| b.tabs.iter().any(|t| ids.contains(&t.id))) {
                    b.push();
                }
            });
        });
    }
}

fn with<R>(label: &str, f: impl FnOnce(&mut Browser) -> R) -> Option<R> {
    BROWSERS.with_borrow_mut(|all| all.get_mut(label).map(f))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabState {
    id: u64,
    title: String,
    url: String,
    loading: bool,
    progress: f64,
    can_back: bool,
    can_forward: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct State<'a> {
    mode: Mode,
    name: Option<&'a str>,
    tabs: Vec<TabState>,
    active: Option<u64>,
}

impl Browser {
    fn tab_of(&self, view: &WebView) -> Option<u64> {
        self.tabs.iter().find(|t| &t.view == view).map(|t| t.id)
    }

    fn view(&self, id: u64) -> Option<&WebView> {
        self.tabs.iter().find(|t| t.id == id).map(|t| &t.view)
    }

    fn active_view(&self) -> Option<&WebView> {
        self.active.and_then(|id| self.view(id))
    }

    fn insert(&mut self, tab: Tab, index: Option<usize>) {
        self.stack.add(&tab.view);
        tab.view.show();
        let at = index.unwrap_or_else(|| {
            self.active.and_then(|a| self.tabs.iter().position(|t| t.id == a)).map_or(self.tabs.len(), |p| p + 1)
        });
        self.tabs.insert(at.min(self.tabs.len()), tab);
        self.push();
    }

    fn select(&mut self, id: u64) {
        if let Some(view) = self.view(id).cloned() {
            self.stack.set_visible_child(&view);
            view.grab_focus();
            self.active = Some(id);
            self.push();
        }
    }

    /// Takes tab `id` out of this window (still live); selects a neighbour.
    fn take(&mut self, id: u64) -> Option<Tab> {
        let at = self.tabs.iter().position(|t| t.id == id)?;
        let tab = self.tabs.remove(at);
        self.stack.remove(&tab.view);
        if self.active == Some(id) {
            self.active = None;
            if let Some(next) = self.tabs.get(at.min(self.tabs.len().saturating_sub(1))).map(|t| t.id) {
                self.select(next);
            }
        }
        self.push();
        Some(tab)
    }

    fn new_tab(&mut self, url: Option<&str>) -> u64 {
        let url = url.map(urlbar::normalize).unwrap_or_else(|| self.opts.home());
        let tab = new_tab(&self.opts, None, &url);
        let id = tab.id;
        self.insert(tab, None);
        self.select(id);
        id
    }

    fn reorder(&mut self, id: u64, index: usize) {
        let Some(from) = self.tabs.iter().position(|t| t.id == id) else { return };
        let tab = self.tabs.remove(from);
        // The index counts the tab in its old place.
        let to = if index > from { index - 1 } else { index };
        self.tabs.insert(to.min(self.tabs.len()), tab);
        self.push();
    }

    fn state(&self) -> State<'_> {
        let tabs = self
            .tabs
            .iter()
            .map(|t| TabState {
                id: t.id,
                title: t.view.title().map(String::from).unwrap_or_default(),
                url: t.view.uri().map(String::from).unwrap_or_default(),
                loading: t.view.is_loading(),
                progress: t.view.estimated_load_progress(),
                can_back: t.view.can_go_back(),
                can_forward: t.view.can_go_forward(),
            })
            .collect();
        State { mode: self.opts.mode, name: self.opts.name.as_deref(), tabs, active: self.active }
    }

    /// Sends the chrome the window's state (once it's listening).
    fn push(&self) {
        if !self.ready {
            return;
        }
        if let Err(e) = self.window.emit_to(self.window.label(), "wb:state", self.state()) {
            tracing::warn!(%e, "can't update the chrome");
        }
    }

    fn close_window(&self) {
        let _ = self.window.close();
    }
}

// ---- commands from the chrome (sync: they run on the main thread) ----

/// The chrome is up and listening: its first state, and pushes from now on.
#[tauri::command]
pub fn chrome_ready(window: WebviewWindow) -> Option<serde_json::Value> {
    with(window.label(), |b| {
        b.ready = true;
        serde_json::to_value(b.state()).ok()
    })
    .flatten()
}

#[tauri::command]
pub fn tab_new(window: WebviewWindow, url: Option<String>) {
    with(window.label(), |b| b.new_tab(url.as_deref()));
}

#[tauri::command]
pub fn tab_select(window: WebviewWindow, id: u64) {
    with(window.label(), |b| b.select(id));
}

#[tauri::command]
pub fn tab_close(window: WebviewWindow, id: u64) {
    with(window.label(), |b| {
        b.take(id);
        if b.tabs.is_empty() {
            b.close_window();
        }
    });
}

/// Moves tab `id` of window `from` to window `to` at `index`, or to a new
/// window of its own. The page moves live: no reload.
fn move_tab(app: &AppHandle, from: &str, id: u64, to: Option<&str>, index: Option<usize>) -> Result<(), String> {
    if to == Some(from) {
        return with(from, |b| b.reorder(id, index.unwrap_or(usize::MAX))).ok_or_else(|| "no such window".into());
    }
    let (tab, opts) = with(from, |b| (b.take(id), b.opts.clone())).ok_or("no such window")?;
    let tab = tab.ok_or("no such tab")?;
    match to {
        Some(to) => {
            let moved = BROWSERS.with_borrow_mut(|all| match all.get_mut(to) {
                Some(b) => {
                    let id = tab.id;
                    b.insert(tab, index);
                    b.select(id);
                    Ok(())
                }
                None => Err(tab),
            });
            if let Err(tab) = moved {
                with(from, |b| b.insert(tab, None));
                return Err("no such window".into());
            }
        }
        None => {
            open_with(app, opts, First::Tab(tab)).map_err(|e| e.to_string())?;
        }
    }
    with(from, |b| {
        if b.tabs.is_empty() {
            b.close_window();
        }
    });
    Ok(())
}

/// Moves tab `id` to window `to` at `index`, or to a new window ("Move tab to
/// new window").
#[tauri::command]
pub fn tab_move(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
    to: Option<String>,
    index: Option<usize>,
) -> Result<(), String> {
    move_tab(&app, window.label(), id, to.as_deref(), index)
}

#[tauri::command]
pub fn tab_drag_begin(window: WebviewWindow, id: u64) {
    DRAG.set(Some((window.label().to_owned(), id)));
}

/// The dragged tab was dropped on this window's strip at `index`.
#[tauri::command]
pub fn tab_drop(app: AppHandle, window: WebviewWindow, index: usize) -> Result<(), String> {
    let Some((from, id)) = DRAG.take() else { return Ok(()) };
    move_tab(&app, &from, id, Some(window.label()), Some(index))
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
            && let Err(e) = move_tab(&app, &from, id, None, None)
        {
            tracing::warn!(%e, "can't detach the tab");
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

#[tauri::command]
pub fn navigate(window: WebviewWindow, input: String) {
    with(window.label(), |b| {
        if let (Some(view), Some(url)) = (b.active_view(), urlbar::resolve(&input, urlbar::DEFAULT_SEARCH)) {
            view.load_uri(&url);
            view.grab_focus();
        }
    });
}

#[tauri::command]
pub fn nav(window: WebviewWindow, action: String) {
    with(window.label(), |b| {
        let home = b.opts.home();
        let Some(view) = b.active_view() else { return };
        match action.as_str() {
            "back" => view.go_back(),
            "forward" => view.go_forward(),
            "reload" => view.reload(),
            "reload-hard" => view.reload_bypass_cache(),
            "stop" => view.stop_loading(),
            "home" => view.load_uri(&home),
            _ => {}
        }
    });
}

/// Shows the menu surface at a rectangle of the window (logical pixels from
/// its top left), drawing `kind` with `data`.
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
    with(window.label(), |b| {
        let Ok(parent) = b.window.gtk_window() else { return };
        let m = &b.menu;
        let script = format!(
            "window.wbPopup && window.wbPopup.show({}, {})",
            serde_json::to_string(&kind).unwrap_or_default(),
            data
        );
        m.view.evaluate_javascript(&script, None, None, None::<&gtk::gio::Cancellable>, |_| {});
        let (ox, oy) = parent
            .window()
            .map(|w| {
                let (_, x, y) = w.origin();
                (x, y)
            })
            .unwrap_or_default();
        m.view.set_size_request(width.max(1), height.max(1));
        m.win.resize(width.max(1), height.max(1));
        m.win.move_(ox + x.max(0), oy + y.max(0));
        m.win.show();
    });
}

#[tauri::command]
pub fn popup_hide(window: WebviewWindow) {
    with(window.label(), |b| b.menu.win.hide());
}

#[tauri::command]
pub fn win_action(window: WebviewWindow, action: String) {
    let _ = match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            _ => window.maximize(),
        },
        "fullscreen" => window.set_fullscreen(!window.is_fullscreen().unwrap_or(false)),
        "close" => window.close(),
        _ => Ok(()),
    };
}

// ---- for the spike ----

#[cfg(feature = "spike")]
pub mod probe {
    use super::*;

    pub fn labels() -> Vec<String> {
        BROWSERS.with_borrow(|all| all.keys().cloned().collect())
    }

    pub fn tabs(label: &str) -> Vec<u64> {
        with(label, |b| b.tabs.iter().map(|t| t.id).collect()).unwrap_or_default()
    }

    pub fn view(label: &str, id: u64) -> Option<WebView> {
        with(label, |b| b.view(id).cloned()).flatten()
    }

    pub fn window(label: &str) -> Option<WebviewWindow> {
        with(label, |b| b.window.clone())
    }

    pub fn new_tab(label: &str, url: &str) -> Option<u64> {
        with(label, |b| {
            let tab = super::new_tab(&b.opts, None, url);
            let id = tab.id;
            b.insert(tab, None);
            b.select(id);
            id
        })
    }

    pub fn menu(label: &str) -> Option<gtk::Window> {
        with(label, |b| b.menu.win.clone())
    }

    pub fn open_with_tab(app: &AppHandle, opts: Opts, from: &str, id: u64) -> Result<String, Error> {
        let tab = with(from, |b| b.take(id)).flatten().ok_or("no tab")?;
        open_with(app, opts, First::Tab(tab))
    }

    pub fn move_tab(from: &str, id: u64, to: &str) -> bool {
        let Some(tab) = with(from, |b| b.take(id)).flatten() else { return false };
        with(to, |b| {
            let id = tab.id;
            b.insert(tab, None);
            b.select(id);
        })
        .is_some()
    }
}
