//! Page zoom, remembered per site (`~/.config/wadbrowser/zoom.json`).

use std::cell::RefCell;
use std::collections::BTreeMap;
use webkit2gtk::{WebView, WebViewExt};

const LEVELS: &[f64] = &[0.3, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

thread_local! {
    static ZOOMS: RefCell<Option<BTreeMap<String, f64>>> = const { RefCell::new(None) };
}

pub enum Step {
    In,
    Out,
    Reset,
}

fn host(view: &WebView) -> Option<String> {
    tauri::Url::parse(&view.uri()?).ok()?.host_str().map(str::to_owned)
}

fn with<R>(f: impl FnOnce(&mut BTreeMap<String, f64>) -> R) -> R {
    ZOOMS.with_borrow_mut(|z| {
        let file = crate::config::user_dir().join("zoom.json");
        let map = z.get_or_insert_with(|| {
            std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
        });
        f(map)
    })
}

/// The site's zoom, as the page commits.
pub fn apply(view: &WebView) {
    let level = host(view).and_then(|h| with(|m| m.get(&h).copied())).unwrap_or(1.0);
    if (view.zoom_level() - level).abs() > f64::EPSILON {
        view.set_zoom_level(level);
    }
}

pub fn change(view: &WebView, step: Step) {
    let now = view.zoom_level();
    let level = match step {
        Step::In => LEVELS.iter().copied().find(|&l| l > now + 0.001).unwrap_or(now),
        Step::Out => LEVELS.iter().rev().copied().find(|&l| l < now - 0.001).unwrap_or(now),
        Step::Reset => 1.0,
    };
    view.set_zoom_level(level);
    let Some(h) = host(view) else { return };
    let saved = with(|m| {
        if (level - 1.0).abs() < 0.001 {
            m.remove(&h);
        } else {
            m.insert(h, level);
        }
        serde_json::to_vec_pretty(m).unwrap_or_default()
    });
    let _ = std::fs::create_dir_all(crate::config::user_dir());
    let _ = std::fs::write(crate::config::user_dir().join("zoom.json"), saved);
}
