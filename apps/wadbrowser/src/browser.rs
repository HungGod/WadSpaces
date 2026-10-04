//! Browser windows and their tabs.
//!
//! GTK objects live on the main thread only, so the windows are kept in a
//! thread-local, and Tauri's commands (sync ones run on the main thread) use
//! them directly. WebKit's signals can fire while that table is borrowed (a
//! load starting inside `load_uri`, say), so they never touch it: what needs
//! the table is deferred to the next turn of the main loop (see `tab.rs`).

use crate::{app_id, config, menu, profile, resize, tab};
use gtk::glib;
use gtk::prelude::*;
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use webkit2gtk::{BackForwardListExt, WebView, WebViewExt, WebViewSessionState};

pub type Error = Box<dyn std::error::Error>;

/// The chrome's height: tabs plus the URL bar row, or one slim row. It grows
/// while the find row or a permission question shows (`chrome_height`).
pub const CHROME_FULL: i32 = 76;
pub const CHROME_SLIM: i32 = 38;
const BACKGROUND: tauri::window::Color = tauri::window::Color(32, 33, 36, 255);
const CLOSED_KEPT: usize = 25;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Tabs and a URL bar.
    #[default]
    Full,
    /// WadBrowser Focus: tabs, no URL bar; pages arrive by links (xdg-open).
    Focus,
    /// One web app's window: its own app_id and name, no URL bar, a tab
    /// strip only once there's a second tab.
    App,
}

#[derive(Clone, Debug, Default)]
pub struct Opts {
    pub mode: Mode,
    /// For [`Mode::App`]: its app_id (`wadspaces-webapp-<id>`), name, start page and picture.
    pub app_id: Option<String>,
    pub name: Option<String>,
    pub start: Option<String>,
    pub icon: Option<String>,
    pub profile: Option<String>,
}

impl Opts {
    pub fn profile(&self) -> &str {
        self.profile.as_deref().unwrap_or(profile::DEFAULT)
    }

    /// Where Home and a new tab go: the app's start page, or the configured home.
    pub fn home(&self) -> String {
        match (self.mode, &self.start) {
            (Mode::App, Some(start)) => start.clone(),
            _ => config::get().home.clone(),
        }
    }
}

pub struct Tab {
    pub id: u64,
    /// The page; None while the tab sleeps (hibernated) to free its memory.
    pub live: Option<WebView>,
    /// A sleeping tab's history, to wake it where it was.
    pub saved: Option<glib::Bytes>,
    pub title: String,
    pub url: String,
    pub favicon: Option<String>,
    pub last_seen: Instant,
}

impl Tab {
    pub fn new(view: WebView) -> Tab {
        let id = NEXT_TAB.fetch_add(1, Ordering::Relaxed);
        tab::register(&view, id);
        Tab {
            id,
            live: Some(view),
            saved: None,
            title: String::new(),
            url: String::new(),
            favicon: None,
            last_seen: Instant::now(),
        }
    }

    /// Takes in a view's latest title, address and icon (for sleeping later).
    pub fn refresh(&mut self) {
        if let Some(v) = &self.live {
            self.title = v.title().map(String::from).unwrap_or_default();
            if let Some(u) = v.uri() {
                self.url = u.into();
            }
        }
    }
}

impl Tab {
    /// A tab that isn't loaded until it's looked at (a restored session).
    pub fn asleep(url: String, title: String) -> Tab {
        let id = NEXT_TAB.fetch_add(1, Ordering::Relaxed);
        Tab { id, live: None, saved: None, title, url, favicon: None, last_seen: Instant::now() }
    }
}

impl Drop for Tab {
    fn drop(&mut self) {
        // A move moves this struct; a drop is the tab closing.
        if let Some(v) = &self.live {
            tab::discard(v);
        }
    }
}

/// A closed tab, for Ctrl+Shift+T: its address and history.
struct Closed {
    url: String,
    saved: Option<glib::Bytes>,
}

pub struct Browser {
    pub window: WebviewWindow,
    pub chrome: WebView,
    stack: gtk::Stack,
    status: Status,
    pub menu: menu::Menu,
    pub tabs: Vec<Tab>,
    pub active: Option<u64>,
    pub opts: Opts,
    ready: bool,
    closed: Vec<Closed>,
    chrome_extra: i32,
}

thread_local! {
    static BROWSERS: RefCell<HashMap<String, Browser>> = RefCell::new(HashMap::new());
    /// Window labels, the most recently used last.
    static RECENT: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static DIRTY: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
    static PUSH_QUEUED: Cell<bool> = const { Cell::new(false) };
}

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
static NEXT_TAB: AtomicU64 = AtomicU64::new(1);

/// What a new window starts with.
pub enum First {
    /// These pages (the home page if none).
    Urls(Vec<String>),
    /// A tab moved from another window, live.
    Tab(Tab),
    /// A crashed browser's tabs, `active` shown.
    Restored { tabs: Vec<Tab>, active: usize },
}

/// Opens a browser window; its label.
pub fn open(app: &AppHandle, opts: Opts, first: First) -> Result<String, Error> {
    open_near(app, opts, first, None)
}

/// A window's size and place, in logical pixels: (x, y, width, height).
type Geometry = (f64, f64, f64, f64);

fn geometry(w: &WebviewWindow) -> Option<Geometry> {
    let scale = w.scale_factor().ok()?;
    let size = w.inner_size().ok()?.to_logical::<f64>(scale);
    let pos = w.outer_position().map(|p| p.to_logical::<f64>(scale)).unwrap_or_default();
    Some((pos.x, pos.y, size.width, size.height))
}

/// Opens a window like `open`, the size of `near` and a little down and to
/// the right of it (where the compositor lets a window choose: X11; Wayland
/// places windows itself, and the workspaces' labwc maximizes them).
fn open_near(app: &AppHandle, opts: Opts, first: First, near: Option<Geometry>) -> Result<String, Error> {
    let label = format!("w{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let title = opts.name.clone().unwrap_or_else(|| "WadBrowser".into());
    let app_id = opts.app_id.clone().filter(|id| app_id::valid(id)).unwrap_or_else(|| app_id::DEFAULT.into());
    let (w, h) = near.map_or((1100.0, 750.0), |g| (g.2, g.3));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(w, h)
        .min_inner_size(400.0, 300.0)
        .decorations(false)
        .visible(false)
        .background_color(BACKGROUND)
        // Tauri's own drop handler would swallow the chrome's tab drags.
        .disable_drag_drop_handler();
    if let Some((x, y, ..)) = near {
        builder = builder.position(x + 40.0, y + 40.0);
    }
    let window = builder.build()?;

    let vbox = window.default_vbox()?;
    let chrome =
        vbox.children().into_iter().find_map(|w| w.downcast::<WebView>().ok()).ok_or("Tauri made no chrome webview")?;
    vbox.set_child_packing(&chrome, false, true, 0, gtk::PackType::Start);
    chrome.set_size_request(-1, base_height(opts.mode));
    // Tauri's own edge-resizing on this view takes the view's bottom edge
    // for the window's (a resize cursor under the URL bar): ours, which
    // knows the window's real edges, instead.
    resize::replace(chrome.upcast_ref());
    // A tab dragged off the strip: dropped anywhere but a strip, it gets a
    // window of its own (the page's dragend alone can't tell, outside it).
    let drag_app = app.clone();
    chrome.connect_drag_end(move |_, _| crate::commands::drag_ended(&drag_app));
    chrome.connect_drag_failed(|_, _, result| {
        if result == gtk::DragResult::UserCancelled {
            crate::commands::drag_cancelled();
        }
        // No slide-back animation: the tab is going to a window of its own.
        glib::Propagation::Stop
    });

    let stack = gtk::Stack::new();
    stack.set_hexpand(true);
    stack.set_vexpand(true);
    vbox.pack_start(&stack, true, true, 0);
    stack.show();

    let gtk_window = window.gtk_window()?;
    let status = Status::new(&gtk_window);
    let menu = menu::Menu::new(app, &label, &chrome, &gtk_window);
    crate::keys::attach(app, &label, &gtk_window);

    let (tabs, shown) = match first {
        First::Tab(tab) => (vec![tab], 0),
        First::Urls(urls) if urls.is_empty() => (vec![tab::new_tab(&opts, &opts.home())], 0),
        First::Urls(urls) => (urls.iter().map(|u| tab::new_tab(&opts, u)).collect(), 0),
        First::Restored { tabs, active } if !tabs.is_empty() => {
            let active = active.min(tabs.len() - 1);
            (tabs, active)
        }
        First::Restored { .. } => (vec![tab::new_tab(&opts, &opts.home())], 0),
    };
    for t in &tabs {
        if let Some(v) = &t.live {
            stack.add(v);
            v.show();
        }
    }
    let first_id = tabs[shown].id;
    BROWSERS.with_borrow_mut(|all| {
        all.insert(
            label.clone(),
            Browser {
                window: window.clone(),
                chrome,
                stack,
                status,
                menu,
                tabs,
                active: None,
                opts,
                ready: false,
                closed: Vec::new(),
                chrome_extra: 0,
            },
        )
    });

    let closing = label.clone();
    window.on_window_event(move |e| match e {
        WindowEvent::Focused(true) => used(&closing),
        WindowEvent::Focused(false) => {
            // A menu open over the window closes with it.
            let label = closing.clone();
            glib::idle_add_local_once(move || {
                with(&label, |b| b.menu.hide());
            });
        }
        WindowEvent::Destroyed => {
            let label = closing.clone();
            glib::idle_add_local_once(move || {
                BROWSERS.with_borrow_mut(|all| all.remove(&label));
                RECENT.with_borrow_mut(|r| r.retain(|l| l != &label));
                crate::session::save_soon();
            });
        }
        _ => {}
    });

    app_id::show_as(&gtk_window, &app_id);
    used(&label);
    with(&label, |b| b.select(first_id));
    Ok(label)
}

fn base_height(mode: Mode) -> i32 {
    if mode == Mode::Full { CHROME_FULL } else { CHROME_SLIM }
}

/// The hovered link's address, bottom left over the page: a tooltip-like
/// surface of its own. (A GtkOverlay child over the pages would give the
/// window another GDK child window, and the chrome's view then stops
/// repainting.)
pub struct Status {
    win: gtk::Window,
    label: gtk::Label,
    parent: gtk::ApplicationWindow,
}

impl Drop for Status {
    fn drop(&mut self) {
        // A toplevel lives until it's destroyed (GTK holds it), whatever we drop.
        if gtk::is_initialized_main_thread() {
            // SAFETY: the window is ours alone and isn't used after this.
            unsafe { self.win.destroy() };
        }
    }
}

impl Status {
    fn new(parent: &gtk::ApplicationWindow) -> Status {
        let win = gtk::Window::new(gtk::WindowType::Popup);
        win.set_type_hint(gtk::gdk::WindowTypeHint::Tooltip);
        win.set_transient_for(Some(parent));
        win.set_accept_focus(false);
        let label = gtk::Label::new(None);
        label.set_ellipsize(gtk::pango::EllipsizeMode::Middle);
        label.set_max_width_chars(90);
        label.set_xalign(0.0);
        let css = gtk::CssProvider::new();
        let _ = css.load_from_data(
            b"window { background: #202124; } label { color: #e8eaed; padding: 3px 8px; font-size: 12px; }",
        );
        for w in [win.upcast_ref::<gtk::Widget>(), label.upcast_ref()] {
            w.style_context().add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
        win.add(&label);
        label.show();
        Status { win, label, parent: parent.clone() }
    }

    fn show(&self, text: &str) {
        self.label.set_text(text);
        let (_, h) = self.label.preferred_height();
        let (_, w) = self.label.preferred_width();
        let (ox, oy) = self
            .parent
            .window()
            .map(|g| {
                let (_, x, y) = g.origin();
                (x, y)
            })
            .unwrap_or_default();
        self.win.resize(w.max(1), h.max(1));
        self.win.move_(ox, oy + self.parent.allocated_height() - h);
        self.win.show();
    }

    fn hide(&self) {
        if self.win.is_visible() {
            self.win.hide();
        }
    }
}

fn used(label: &str) {
    RECENT.with_borrow_mut(|r| {
        r.retain(|l| l != label);
        r.push(label.to_owned());
    });
}

/// Runs `f` on window `label`.
pub fn with<R>(label: &str, f: impl FnOnce(&mut Browser) -> R) -> Option<R> {
    BROWSERS.with_borrow_mut(|all| all.get_mut(label).map(f))
}

/// Runs `f` on every window.
pub fn each(mut f: impl FnMut(&str, &mut Browser)) {
    BROWSERS.with_borrow_mut(|all| {
        for (label, b) in all.iter_mut() {
            f(label, b)
        }
    });
}

/// The window holding tab `id`.
pub fn window_of(id: u64) -> Option<String> {
    BROWSERS.with_borrow(|all| all.iter().find(|(_, b)| b.tabs.iter().any(|t| t.id == id)).map(|(l, _)| l.clone()))
}

/// The most recently used window that `pick` accepts.
pub fn recent(pick: impl Fn(&Browser) -> bool) -> Option<String> {
    let order = RECENT.with_borrow(|r| r.clone());
    BROWSERS.with_borrow(|all| order.iter().rev().find(|l| all.get(*l).is_some_and(&pick)).cloned())
}

/// Marks tab `id` changed: its window's chrome hears within a frame or two.
pub fn dirty(id: u64) {
    DIRTY.with_borrow_mut(|d| d.insert(id));
    if !PUSH_QUEUED.replace(true) {
        glib::timeout_add_local_once(Duration::from_millis(30), || {
            PUSH_QUEUED.set(false);
            let ids = DIRTY.take();
            each(|_, b| {
                let mut hit = false;
                for t in b.tabs.iter_mut().filter(|t| ids.contains(&t.id)) {
                    t.refresh();
                    hit = true;
                }
                if hit {
                    b.push();
                }
            });
        });
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabState<'a> {
    id: u64,
    title: &'a str,
    url: &'a str,
    favicon: Option<&'a str>,
    loading: bool,
    progress: f64,
    can_back: bool,
    can_forward: bool,
    audio: bool,
    muted: bool,
    sleeping: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State<'a> {
    mode: Mode,
    name: Option<&'a str>,
    app_icon: Option<String>,
    /// The app's own site (app windows show the address when off it).
    home_host: Option<String>,
    can_new_tab: bool,
    tabs: Vec<TabState<'a>>,
    active: Option<u64>,
    zoom: u32,
    fullscreen: bool,
}

impl Browser {
    pub fn tab(&self, id: u64) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == id)
    }

    pub fn view(&self, id: u64) -> Option<&WebView> {
        self.tab(id).and_then(|t| t.live.as_ref())
    }

    pub fn active_view(&self) -> Option<&WebView> {
        self.active.and_then(|id| self.view(id))
    }

    /// Adds `tab` after the active one (or at `index`).
    pub fn insert(&mut self, tab: Tab, index: Option<usize>) {
        if let Some(v) = &tab.live {
            self.stack.add(v);
            v.show();
        }
        let at = index.unwrap_or_else(|| {
            self.active.and_then(|a| self.tabs.iter().position(|t| t.id == a)).map_or(self.tabs.len(), |p| p + 1)
        });
        self.tabs.insert(at.min(self.tabs.len()), tab);
        self.push();
    }

    /// Shows tab `id`, waking it if it sleeps.
    pub fn select(&mut self, id: u64) {
        let opts = self.opts.clone();
        let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) else { return };
        if t.live.is_none() {
            let view = tab::view(&opts, None);
            tab::register(&view, t.id);
            match t.saved.take() {
                Some(bytes) => {
                    view.restore_session_state(&WebViewSessionState::new(&bytes));
                    match view.back_forward_list().and_then(|l| l.current_item()) {
                        Some(item) => view.go_to_back_forward_list_item(&item),
                        None => view.load_uri(&t.url),
                    }
                }
                None => view.load_uri(&t.url),
            }
            self.stack.add(&view);
            view.show();
            t.live = Some(view);
        }
        t.last_seen = Instant::now();
        let view = t.live.clone().expect("woken above");
        if let Some(old) = self.active.and_then(|a| self.tabs.iter_mut().find(|t| t.id == a)) {
            old.last_seen = Instant::now();
        }
        self.stack.set_visible_child(&view);
        view.grab_focus();
        self.active = Some(id);
        self.push();
    }

    /// Takes tab `id` out of this window (still live); selects a neighbour.
    pub fn take(&mut self, id: u64) -> Option<Tab> {
        let at = self.tabs.iter().position(|t| t.id == id)?;
        let tab = self.tabs.remove(at);
        if let Some(v) = &tab.live {
            self.stack.remove(v);
        }
        if self.active == Some(id) {
            self.active = None;
            if let Some(next) = self.tabs.get(at.min(self.tabs.len().saturating_sub(1))).map(|t| t.id) {
                self.select(next);
            }
        }
        self.push();
        Some(tab)
    }

    /// Closes tab `id` (kept for Ctrl+Shift+T); the window too if it was the last.
    pub fn close_tab(&mut self, id: u64) {
        let Some(mut tab) = self.take(id) else { return };
        tab.refresh();
        let saved = tab.live.as_ref().and_then(|v| v.session_state()).and_then(|s| s.serialize()).or(tab.saved.take());
        if !tab.url.is_empty() && tab.url != "about:blank" {
            self.closed.push(Closed { url: tab.url.clone(), saved });
            if self.closed.len() > CLOSED_KEPT {
                self.closed.remove(0);
            }
        }
        if self.tabs.is_empty() {
            self.close_window();
        }
    }

    pub fn reopen_closed(&mut self) {
        let Some(c) = self.closed.pop() else { return };
        let mut tab = tab::new_tab(&self.opts, "");
        tab.url = c.url;
        if let (Some(bytes), Some(v)) = (c.saved, &tab.live) {
            v.restore_session_state(&WebViewSessionState::new(&bytes));
            match v.back_forward_list().and_then(|l| l.current_item()) {
                Some(item) => v.go_to_back_forward_list_item(&item),
                None => v.load_uri(&tab.url),
            }
        } else if let Some(v) = &tab.live {
            v.load_uri(&tab.url);
        }
        let id = tab.id;
        self.insert(tab, None);
        self.select(id);
    }

    pub fn new_tab(&mut self, url: Option<&str>, background: bool) -> u64 {
        let url = url.map(crate::urlbar::normalize).unwrap_or_else(|| self.opts.home());
        let tab = tab::new_tab(&self.opts, &url);
        let id = tab.id;
        self.insert(tab, None);
        if !background {
            self.select(id);
        }
        if url == "about:blank" && self.opts.mode == Mode::Full && !background {
            let _ = self.window.emit_to(self.window.label(), "wb:focus-url", ());
        }
        id
    }

    pub fn reorder(&mut self, id: u64, index: usize) {
        let Some(from) = self.tabs.iter().position(|t| t.id == id) else { return };
        let tab = self.tabs.remove(from);
        // The index counts the tab in its old place.
        let to = if index > from { index - 1 } else { index };
        self.tabs.insert(to.min(self.tabs.len()), tab);
        self.push();
    }

    /// Puts tab `id` to sleep: its history kept, its page (and memory) freed.
    pub fn sleep(&mut self, id: u64) -> bool {
        if self.active == Some(id) {
            return false;
        }
        let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) else { return false };
        let Some(view) = t.live.take() else { return false };
        t.refresh_from(&view);
        t.saved = view.session_state().and_then(|s| s.serialize());
        self.stack.remove(&view);
        tab::discard(&view);
        self.push();
        true
    }

    pub fn set_status(&self, text: Option<&str>) {
        match text {
            Some(t) if !t.is_empty() => self.status.show(t),
            _ => self.status.hide(),
        }
    }

    /// The chrome asks for room (its find row or a question showing).
    pub fn set_chrome_height(&mut self, height: i32) {
        let base = base_height(self.opts.mode);
        self.chrome_extra = (height - base).clamp(0, 120);
        self.chrome.set_size_request(-1, base + self.chrome_extra);
    }

    pub fn set_fullscreen(&self, on: bool) {
        let _ = self.window.set_fullscreen(on);
        self.chrome.set_visible(!on);
        self.push();
    }

    pub fn is_fullscreen(&self) -> bool {
        self.window.is_fullscreen().unwrap_or(false)
    }

    /// The shown page's zoom, in percent.
    pub fn state_zoom(&self) -> u32 {
        (self.active_view().map_or(1.0, |v| v.zoom_level()) * 100.0).round() as u32
    }

    pub fn state(&self) -> State<'_> {
        let tabs = self
            .tabs
            .iter()
            .map(|t| {
                let v = t.live.as_ref();
                TabState {
                    id: t.id,
                    title: &t.title,
                    url: &t.url,
                    favicon: t.favicon.as_deref(),
                    loading: v.is_some_and(|v| v.is_loading()),
                    progress: v.map_or(1.0, |v| v.estimated_load_progress()),
                    can_back: v.map_or(t.saved.is_some(), |v| v.can_go_back()),
                    can_forward: v.is_some_and(|v| v.can_go_forward()),
                    audio: v.is_some_and(|v| v.is_playing_audio()),
                    muted: v.is_some_and(|v| v.is_muted()),
                    sleeping: v.is_none(),
                }
            })
            .collect();
        let home_host = (self.opts.mode == Mode::App)
            .then(|| self.opts.start.as_deref().and_then(|s| tauri::Url::parse(s).ok()?.host_str().map(str::to_owned)))
            .flatten();
        State {
            mode: self.opts.mode,
            name: self.opts.name.as_deref(),
            app_icon: self.opts.icon.as_deref().and_then(crate::tab::icon_data_url),
            home_host,
            can_new_tab: self.opts.mode != Mode::Focus || self.opts.home() != "about:blank",
            tabs,
            active: self.active,
            zoom: self.state_zoom(),
            fullscreen: self.is_fullscreen(),
        }
    }

    /// Sends the chrome the window's state (once it's listening), and titles the window.
    pub fn push(&self) {
        let title = match (self.opts.mode, self.active.and_then(|a| self.tab(a))) {
            (Mode::App, _) => self.opts.name.clone().unwrap_or_else(|| "WadBrowser".into()),
            (_, Some(t)) if !t.title.is_empty() => format!("{} – WadBrowser", t.title),
            _ => "WadBrowser".into(),
        };
        let _ = self.window.set_title(&title);
        crate::session::save_soon();
        if !self.ready {
            return;
        }
        if let Err(e) = self.window.emit_to(self.window.label(), "wb:state", self.state()) {
            tracing::warn!(%e, "can't update the chrome");
        }
    }

    pub fn mark_ready(&mut self) -> serde_json::Value {
        self.ready = true;
        serde_json::to_value(self.state()).unwrap_or_default()
    }

    pub fn close_window(&self) {
        self.menu.hide();
        self.status.hide();
        let _ = self.window.close();
    }

    pub fn present(&self, activation_token: Option<&str>) {
        if let Ok(w) = self.window.gtk_window() {
            if let Some(token) = activation_token {
                w.set_startup_id(token);
            }
            w.present();
        }
    }
}

impl Tab {
    /// Ready to go to another window: its page's history kept, its view
    /// gone (the window it lands in makes a new one when it shows it).
    fn pack(&mut self) {
        let Some(view) = self.live.take() else { return };
        self.refresh_from(&view);
        self.saved = view.session_state().and_then(|s| s.serialize());
        tab::discard(&view);
    }

    fn refresh_from(&mut self, view: &WebView) {
        self.title = view.title().map(String::from).unwrap_or_default();
        if let Some(u) = view.uri() {
            self.url = u.into();
        }
    }
}

/// Moves tab `id` of window `from` to window `to` at `index`, or to a new
/// window of its own. The tab goes as its history: its page loads again there.
pub fn move_tab(app: &AppHandle, from: &str, id: u64, to: Option<&str>, index: Option<usize>) -> Result<(), String> {
    if to == Some(from) {
        return with(from, |b| b.reorder(id, index.unwrap_or(usize::MAX))).ok_or_else(|| "no such window".into());
    }
    let (tab, opts, near) =
        with(from, |b| (b.take(id), b.opts.clone(), geometry(&b.window))).ok_or("no such window")?;
    let mut tab = tab.ok_or("no such tab")?;
    // A view never changes windows: WebKit (GPU drawing) keeps a view tied
    // to the window it's shown in, and in another one it draws garbage. The
    // tab goes as its history; the window it lands in makes its view.
    tab.pack();
    match to {
        Some(to) => {
            let moved = BROWSERS.with_borrow_mut(|all| match all.get_mut(to) {
                Some(b) => {
                    let id = tab.id;
                    b.insert(tab, index);
                    b.select(id);
                    Ok(())
                }
                None => Err(Box::new(tab)),
            });
            if let Err(tab) = moved {
                with(from, |b| b.insert(*tab, None));
                return Err("no such window".into());
            }
        }
        None => {
            open_near(app, opts, First::Tab(tab), near).map_err(|e| e.to_string())?;
        }
    }
    with(from, |b| {
        if b.tabs.is_empty() {
            b.close_window();
        }
    });
    Ok(())
}

/// Puts tabs to sleep that haven't been looked at for a while (checked each
/// minute): not the shown one, nor one playing sound or downloading.
pub fn start_hibernation() {
    let minutes = config::get().hibernate_after_minutes;
    if minutes == 0 {
        return;
    }
    let after = Duration::from_secs(minutes * 60);
    glib::timeout_add_seconds_local(60, move || {
        let busy = crate::downloads::busy_views();
        each(|_, b| {
            let sleepy: Vec<u64> = b
                .tabs
                .iter()
                .filter(|t| Some(t.id) != b.active && t.last_seen.elapsed() > after)
                .filter(|t| t.live.as_ref().is_some_and(|v| !v.is_playing_audio() && !busy.contains(&tab::key(v))))
                .map(|t| t.id)
                .collect();
            for id in sleepy {
                b.sleep(id);
            }
        });
        glib::ControlFlow::Continue
    });
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
            let tab = tab::new_tab(&b.opts, url);
            let id = tab.id;
            b.insert(tab, None);
            b.select(id);
            id
        })
    }

    pub fn chrome(label: &str) -> Option<WebView> {
        with(label, |b| b.chrome.clone())
    }

    pub fn menu(label: &str) -> Option<gtk::Window> {
        with(label, |b| b.menu.window())
    }

    /// Tab `id` to a window of its own (as a drag off the strip does).
    pub fn open_with_tab(app: &AppHandle, _opts: Opts, from: &str, id: u64) -> Result<String, Error> {
        super::move_tab(app, from, id, None, None)?;
        labels().into_iter().find(|l| tabs(l).contains(&id)).ok_or_else(|| "it went nowhere".into())
    }

    /// Tab `id` into window `to` (as a drop on its strip does).
    pub fn move_tab(app: &AppHandle, from: &str, id: u64, to: &str) -> bool {
        super::move_tab(app, from, id, Some(to), None).is_ok()
    }

    pub fn sleep(label: &str, id: u64) -> bool {
        with(label, |b| b.sleep(id)).unwrap_or(false)
    }

    pub fn select(label: &str, id: u64) {
        with(label, |b| b.select(id));
    }

    pub fn active(label: &str) -> Option<u64> {
        with(label, |b| b.active).flatten()
    }

    pub fn is_live(label: &str, id: u64) -> bool {
        with(label, |b| b.view(id).is_some()).unwrap_or(false)
    }
}
