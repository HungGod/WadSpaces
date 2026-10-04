//! Pages asking for the camera, the microphone or notifications: the window's
//! chrome asks the user (a row under the toolbar), and the answer can be kept
//! for that site (`~/.config/wadbrowser/permissions.json`). Location is never
//! given; pointer lock and storage access always are.

use crate::browser;
use gtk::prelude::*;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use tauri::Emitter;
use webkit2gtk::{
    DeviceInfoPermissionRequest, NotificationPermissionRequest, PermissionRequest, PermissionRequestExt,
    PointerLockPermissionRequest, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebView, WebViewExt,
    WebsiteDataAccessPermissionRequest,
};

type Store = BTreeMap<String, BTreeMap<String, bool>>;

thread_local! {
    static PENDING: RefCell<HashMap<u64, (PermissionRequest, String, String)>> = RefCell::new(HashMap::new());
    static STORE: RefCell<Option<Store>> = const { RefCell::new(None) };
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prompt {
    id: u64,
    site: String,
    what: String,
}

pub fn request(view: &WebView, req: &PermissionRequest) -> bool {
    let origin = origin(view);
    let what = if let Some(m) = req.downcast_ref::<UserMediaPermissionRequest>() {
        match (m.is_for_video_device(), m.is_for_audio_device()) {
            (true, true) => "camera and microphone",
            (true, false) => "camera",
            _ => "microphone",
        }
    } else if req.is::<NotificationPermissionRequest>() {
        "notifications"
    } else if req.is::<DeviceInfoPermissionRequest>() {
        // Listing the devices: only for sites already let at one.
        let ok = ["camera and microphone", "camera", "microphone"].iter().any(|k| stored(&origin, k) == Some(true));
        if ok {
            req.allow()
        } else {
            req.deny()
        }
        return true;
    } else if req.is::<PointerLockPermissionRequest>() || req.is::<WebsiteDataAccessPermissionRequest>() {
        req.allow();
        return true;
    } else {
        // Location (GeolocationPermissionRequest), DRM (MediaKeySystem…),
        // plugins and anything newer: no.
        req.deny();
        return true;
    };
    match stored(&origin, what) {
        Some(true) => req.allow(),
        Some(false) => req.deny(),
        None => {
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            PENDING.with_borrow_mut(|p| p.insert(id, (req.clone(), origin.clone(), what.to_owned())));
            let Some(tab) = crate::tab::id_of(view) else {
                req.deny();
                return true;
            };
            let prompt = Prompt { id, site: host(&origin), what: what.to_owned() };
            gtk::glib::idle_add_local_once(move || {
                if let Some(label) = browser::window_of(tab) {
                    browser::with(&label, |b| {
                        let _ = b.window.emit_to(b.window.label(), "wb:prompt", prompt);
                    });
                }
            });
        }
    }
    true
}

/// The user's answer to prompt `id`.
pub fn answer(id: u64, allow: bool, remember: bool) {
    let Some((req, origin, what)) = PENDING.with_borrow_mut(|p| p.remove(&id)) else { return };
    if allow {
        req.allow()
    } else {
        req.deny()
    }
    if remember {
        with_store(|s| {
            s.entry(origin).or_default().insert(what, allow);
        });
    }
}

fn origin(view: &WebView) -> String {
    view.uri().and_then(|u| tauri::Url::parse(&u).ok()).map(|u| u.origin().ascii_serialization()).unwrap_or_default()
}

fn host(origin: &str) -> String {
    tauri::Url::parse(origin).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_else(|| origin.to_owned())
}

fn file() -> PathBuf {
    crate::config::user_dir().join("permissions.json")
}

fn stored(origin: &str, what: &str) -> Option<bool> {
    with_store(|s| s.get(origin).and_then(|m| m.get(what)).copied())
}

fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    STORE.with_borrow_mut(|s| {
        let store = s.get_or_insert_with(|| {
            std::fs::read(file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
        });
        let before = serde_json::to_vec(store).unwrap_or_default();
        let out = f(store);
        let after = serde_json::to_vec_pretty(store).unwrap_or_default();
        if serde_json::to_vec(store).unwrap_or_default() != before {
            let _ = std::fs::create_dir_all(crate::config::user_dir());
            let _ = std::fs::write(file(), after);
        }
        out
    })
}
