//! A tab's page: a WebKit view, and what it does when the page asks for
//! something (a new window, a download, the camera, another app's link).
//!
//! The handlers here run inside WebKit's signals: anything that needs the
//! window table is deferred to the next turn (`later`), never done in place.

use crate::browser::{self, Opts, Tab};
use crate::{gpu, pages, permissions, profile, zoom};
use base64::Engine;
use gtk::gio;
use gtk::glib;
use gtk::prelude::*;
use std::cell::RefCell;
use std::collections::HashMap;
use tauri::Manager;
use webkit2gtk::{
    AutoplayPolicy, ContextMenuAction, ContextMenuExt, ContextMenuItem, ContextMenuItemExt, HitTestResultExt,
    LoadEvent, NavigationPolicyDecision, NavigationPolicyDecisionExt, PolicyDecision, PolicyDecisionExt,
    PolicyDecisionType, ResponsePolicyDecision, ResponsePolicyDecisionExt, Settings, SettingsExt, URIRequestExt,
    WebView, WebViewExt, WebsitePolicies, WindowPropertiesExt,
};

thread_local! {
    /// Each live tab's id by its view (its GObject's address).
    static VIEW_TAB: RefCell<HashMap<usize, u64>> = RefCell::new(HashMap::new());
}

pub fn key(view: &WebView) -> usize {
    view.as_ptr() as usize
}

pub fn register(view: &WebView, id: u64) {
    VIEW_TAB.with_borrow_mut(|m| m.insert(key(view), id));
}

pub fn unregister(view: &WebView) {
    let _ = VIEW_TAB.try_with(|m| m.borrow_mut().remove(&key(view)));
}

/// A view done with (its tab closed, asleep, or given a new view): destroyed
/// now, so WebKit lets its page and web process go. Dropping our reference
/// isn't enough: whatever else holds one (WebKit's own pending work, a
/// signal's closure) would keep the page, and its process, alive.
pub fn discard(view: &WebView) {
    unregister(view);
    if gtk::is_initialized_main_thread() {
        // SAFETY: out of every container already, and nothing here uses it
        // again (its id is unregistered: deferred work finds no tab).
        unsafe { view.destroy() };
    }
}

/// The tab showing `view`.
pub fn id_of(view: &WebView) -> Option<u64> {
    VIEW_TAB.with_borrow(|m| m.get(&key(view)).copied())
}

/// Runs `f` on the next turn of the main loop (outside WebKit's signal).
fn later(f: impl FnOnce() + 'static) {
    glib::idle_add_local_once(f);
}

/// Runs `f` on the window and tab of `view`, on the next turn.
fn on_tab(view: &WebView, f: impl FnOnce(&mut browser::Browser, u64) + 'static) {
    let Some(id) = id_of(view) else { return };
    later(move || {
        if let Some(label) = browser::window_of(id) {
            browser::with(&label, |b| f(b, id));
        }
    });
}

pub fn new_tab(opts: &Opts, url: &str) -> Tab {
    let mut tab = Tab::new(view(opts, None));
    if !url.is_empty() {
        tab.url = url.to_owned();
        if let Some(v) = &tab.live {
            v.load_uri(url);
        }
    }
    tab
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
    s.set_enable_media_stream(true);
    s.set_enable_encrypted_media(true);
    s.set_enable_webgl(true);
    s
}

/// A page's view: in the profile's context, or (a page's popup) in its
/// opener's, so window.opener works for sign-in flows.
pub fn view(opts: &Opts, related: Option<&WebView>) -> WebView {
    let policies = WebsitePolicies::builder().autoplay(AutoplayPolicy::Allow).build();
    let builder = WebView::builder().settings(&settings()).website_policies(&policies);
    let view = match related {
        Some(opener) => builder.related_view(opener).build(),
        None => builder.web_context(&profile::context(opts.profile())).build(),
    };
    view.set_hexpand(true);
    view.set_vexpand(true);
    crate::resize::attach(view.upcast_ref());
    watch(&view);
    view
}

fn dirty(view: &WebView) {
    if let Some(id) = id_of(view) {
        browser::dirty(id);
    }
}

fn watch(view: &WebView) {
    view.connect_title_notify(dirty);
    view.connect_uri_notify(dirty);
    view.connect_estimated_load_progress_notify(dirty);
    view.connect_is_loading_notify(dirty);
    view.connect_is_playing_audio_notify(dirty);
    view.connect_is_muted_notify(dirty);
    view.connect_load_changed(|v, e| {
        if e == LoadEvent::Committed {
            zoom::apply(v);
        }
        dirty(v);
    });
    view.connect_favicon_notify(|v| {
        let url = v.favicon().and_then(|s| surface_data_url(&s));
        on_tab(v, move |b, id| {
            if let Some(t) = b.tabs.iter_mut().find(|t| t.id == id) {
                t.favicon = url;
            }
            b.push();
        });
    });
    view.connect_create(|opener, _action| Some(popup(opener).upcast()));
    view.connect_close(|v| on_tab(v, |b, id| b.close_tab(id)));
    view.connect_decide_policy(decide_policy);
    view.connect_context_menu(|v, menu, _event, hit| {
        context_menu(v, menu, hit);
        false
    });
    view.connect_mouse_target_changed(|v, hit, _mods| {
        let link = hit.context_is_link().then(|| hit.link_uri().map(String::from)).flatten();
        on_tab(v, move |b, id| {
            if b.active == Some(id) {
                b.set_status(link.as_deref());
            }
        });
    });
    view.connect_enter_fullscreen(|v| {
        on_tab(v, |b, _| b.set_fullscreen(true));
        false
    });
    view.connect_leave_fullscreen(|v| {
        on_tab(v, |b, _| b.set_fullscreen(false));
        false
    });
    view.connect_web_process_terminated(pages::crashed);
    view.connect_load_failed(|v, _event, uri, err| pages::failed(v, uri, err));
    view.connect_load_failed_with_tls_errors(pages::tls);
    view.connect_permission_request(permissions::request);
}

/// A page asked for a new window: a popup window when it gave a size (sign-in
/// flows), else a new tab beside it.
fn popup(opener: &WebView) -> WebView {
    let view = view(&Opts::default(), Some(opener));
    let opener_id = id_of(opener);
    view.connect_ready_to_show(move |v| {
        let sized = v.window_properties().map(|p| p.geometry()).is_some_and(|g| g.width() > 0 && g.height() > 0);
        if sized {
            popup_window(v);
            return;
        }
        let v = v.clone();
        later(move || {
            let Some(label) = opener_id.and_then(browser::window_of).or_else(|| browser::recent(|_| true)) else {
                return;
            };
            browser::with(&label, |b| {
                let tab = Tab::new(v);
                let id = tab.id;
                b.insert(tab, None);
                b.select(id);
            });
        });
    });
    view
}

/// A sized popup: a plain window of its own, closed when the page closes it.
fn popup_window(view: &WebView) {
    let win = gtk::Window::new(gtk::WindowType::Toplevel);
    let (w, h) = view
        .window_properties()
        .map(|p| p.geometry())
        .map_or((520, 660), |g| (g.width().clamp(320, 1600), g.height().clamp(240, 1200)));
    win.set_default_size(w, h);
    if let Some(parent) =
        browser::recent(|_| true).and_then(|l| browser::with(&l, |b| b.window.gtk_window().ok())).flatten()
    {
        win.set_transient_for(Some(&parent));
    }
    win.add(view);
    view.connect_title_notify(glib::clone!(@weak win => move |v| {
        win.set_title(&v.title().unwrap_or_default());
    }));
    view.connect_close(glib::clone!(@weak win => move |_| win.close()));
    win.show_all();
}

/// Links to other apps (mailto:, zoommtg:…) go to them; Ctrl- and middle-
/// clicks open a tab behind; what WebKit can't show is downloaded.
fn decide_policy(view: &WebView, decision: &PolicyDecision, kind: PolicyDecisionType) -> bool {
    match kind {
        PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction => {
            let Some(nav) = decision.downcast_ref::<NavigationPolicyDecision>() else { return false };
            let Some(action) = nav.navigation_action() else { return false };
            let Some(uri) = action.request().and_then(|r| r.uri()).map(String::from) else { return false };
            let scheme = uri.split(':').next().unwrap_or_default().to_ascii_lowercase();
            if scheme == pages::ACTION_SCHEME {
                decision.ignore();
                pages::action(view, &uri);
                return true;
            }
            if !matches!(
                scheme.as_str(),
                "http" | "https" | "about" | "data" | "blob" | "file" | "javascript" | "webkit"
            ) {
                decision.ignore();
                if let Err(e) = gio::AppInfo::launch_default_for_uri(&uri, None::<&gio::AppLaunchContext>) {
                    tracing::info!(%uri, %e, "no app for this link");
                }
                return true;
            }
            let ctrl = action.modifiers() & gtk::gdk::ModifierType::CONTROL_MASK.bits() != 0;
            if kind == PolicyDecisionType::NavigationAction
                && action.is_user_gesture()
                && (action.mouse_button() == 2 || ctrl)
            {
                decision.ignore();
                on_tab(view, move |b, _| {
                    b.new_tab(Some(&uri), true);
                });
                return true;
            }
            false
        }
        PolicyDecisionType::Response => {
            let Some(r) = decision.downcast_ref::<ResponsePolicyDecision>() else { return false };
            if !r.is_mime_type_supported() {
                decision.download();
                return true;
            }
            false
        }
        _ => false,
    }
}

/// WebKit's own menu, with "in new window" items turned into new tabs.
fn context_menu(view: &WebView, menu: &webkit2gtk::ContextMenu, hit: &webkit2gtk::HitTestResult) {
    let mut at = None;
    for (i, item) in menu.items().iter().enumerate() {
        match item.stock_action() {
            ContextMenuAction::OpenLinkInNewWindow => {
                at.get_or_insert(i);
                menu.remove(item);
            }
            ContextMenuAction::OpenImageInNewWindow
            | ContextMenuAction::OpenFrameInNewWindow
            | ContextMenuAction::OpenVideoInNewWindow
            | ContextMenuAction::OpenAudioInNewWindow => menu.remove(item),
            _ => {}
        }
    }
    let pos = at.unwrap_or(0) as i32;
    if let Some(link) = hit.context_is_link().then(|| hit.link_uri()).flatten() {
        menu.insert(&item(view, "Open Link in New Tab", link.to_string(), false), pos);
        menu.insert(&item(view, "Open Link in New Window", link.to_string(), true), pos + 1);
    } else if let Some(img) = hit.context_is_image().then(|| hit.image_uri()).flatten() {
        menu.insert(&item(view, "Open Image in New Tab", img.to_string(), false), pos);
    }
}

fn item(view: &WebView, label: &str, url: String, window: bool) -> ContextMenuItem {
    let action = gio::SimpleAction::new("wb-open", None);
    let view = view.downgrade();
    action.connect_activate(move |_, _| {
        let Some(view) = view.upgrade() else { return };
        let url = url.clone();
        on_tab(&view, move |b, _| {
            if window {
                let opts = b.opts.clone();
                let app = b.window.app_handle().clone();
                later(move || {
                    let opts = Opts {
                        mode: if opts.mode == browser::Mode::App { browser::Mode::Full } else { opts.mode },
                        ..opts
                    };
                    if let Err(e) = browser::open(&app, opts, browser::First::Urls(vec![url])) {
                        tracing::warn!(%e, "can't open a window");
                    }
                });
            } else {
                b.new_tab(Some(&url), true);
            }
        });
    });
    ContextMenuItem::from_gaction(&action, label, None)
}

/// A favicon as a data: URL for the chrome (a 32 px PNG at most).
fn surface_data_url(surface: &gtk::cairo::Surface) -> Option<String> {
    let img = gtk::cairo::ImageSurface::try_from(surface.clone()).ok()?;
    let (w, h) = (img.width(), img.height());
    if w <= 0 || h <= 0 {
        return None;
    }
    let side = w.max(h).min(32);
    let out = gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, side, side).ok()?;
    {
        let cr = gtk::cairo::Context::new(&out).ok()?;
        let s = side as f64 / w.max(h) as f64;
        cr.scale(s, s);
        cr.set_source_surface(&img, 0.0, 0.0).ok()?;
        cr.source().set_filter(gtk::cairo::Filter::Good);
        cr.paint().ok()?;
    }
    let mut png = Vec::new();
    out.write_to_png(&mut png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

/// A picture file (the app's `--icon`) as a data: URL, read once.
pub fn icon_data_url(path: &str) -> Option<String> {
    thread_local! {
        static CACHE: RefCell<HashMap<String, Option<String>>> = RefCell::new(HashMap::new());
    }
    CACHE.with_borrow_mut(|c| {
        c.entry(path.to_owned())
            .or_insert_with(|| {
                let bytes = std::fs::read(path).ok().filter(|b| b.len() < 4 << 20)?;
                let kind = if path.ends_with(".svg") { "image/svg+xml" } else { "image/png" };
                Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
            })
            .clone()
    })
}
