//! Stage 0 spike (spike/run.sh): opens windows and tabs on a headless sway,
//! and prints `SPIKE` lines on whether the design holds up:
//!
//! - the chrome sits above the tab stack at its fixed height;
//! - the transparent popup view draws over the page;
//! - each window gets its own app_id;
//! - a tab moved to another window keeps its page (no reload).
//!
//! `WADBROWSER_SPIKE_SHOT=<script>` is run with a path to save screenshots.

use crate::browser::{self, Mode, Opts, probe};
use gtk::glib;
use gtk::prelude::*;
use javascriptcore::ValueExt;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;
use webkit2gtk::WebViewExt;

const PAGE: &str = r#"<!doctype html><title>Page __NAME__</title>
<body style="margin:0;background:__BG__;color:#111;font:28px sans-serif;padding:24px">
<h1 id=h>__NAME__</h1><input id=i value="typed before the move" style="font:20px sans-serif;width:420px">
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
<script>window.born = Date.now() + Math.random(); document.getElementById("h").textContent = "__NAME__ born " + window.born;</script>"#;

const STATE: &str = r#"JSON.stringify({ born: window.born, input: document.getElementById("i").value, href: location.href,
  w: innerWidth, h: innerHeight, nav: performance.getEntriesByType("navigation").length })"#;

/// What this WebKit can do, from inside a page: video calls (WebRTC), DRM
/// (EME key systems), codecs, and the GPU.
const CAPS: &str = r#"(async () => {
  const r = { ua: navigator.userAgent, rtc: typeof RTCPeerConnection, getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    webgl: !!document.createElement("canvas").getContext("webgl2"), webcodecs: typeof VideoDecoder, mse: typeof MediaSource };
  const v = document.createElement("video");
  for (const [k, t] of Object.entries({ h264: 'video/mp4; codecs="avc1.42E01E"', vp9: 'video/webm; codecs="vp9"', av1: 'video/mp4; codecs="av01.0.05M.08"', opus: 'audio/webm; codecs="opus"' })) r[k] = v.canPlayType(t) || "no";
  r.eme = {};
  for (const ks of ["com.widevine.alpha", "org.w3.clearkey", "com.microsoft.playready"]) {
    try { await navigator.requestMediaKeySystemAccess(ks, [{ videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]); r.eme[ks] = true; }
    catch (e) { r.eme[ks] = String(e.name); }
  }
  try { const gl = document.createElement("canvas").getContext("webgl"); const d = gl.getExtension("WEBGL_debug_renderer_info"); r.gpu = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { r.gpu = String(e); }
  return JSON.stringify(r);
})()"#;

pub fn start(app: &AppHandle) -> bool {
    let Some(dir) = std::env::var_os("WADBROWSER_SPIKE_DIR").map(PathBuf::from) else { return false };
    if let Ok(urls) = std::env::var("WADBROWSER_SPIKE_SITES") {
        return sites(app, dir, urls.split_whitespace().map(str::to_owned).collect());
    }
    let w1 = match browser::open(app, Opts { mode: Mode::Full, url: Some(String::new()), ..Default::default() }) {
        Ok(l) => l,
        Err(e) => {
            println!("SPIKE open-failed {e}");
            app.exit(1);
            return true;
        }
    };
    let a = probe::tabs(&w1)[0];
    load(&w1, a, "A", "#9fd8a4");
    let b = probe::new_tab(&w1, "").unwrap_or_default();
    load(&w1, b, "B", "#a4c2f4");
    with_tab_select(&w1, a);

    let app = app.clone();
    let steps: Vec<(u64, Box<dyn FnOnce()>)> = vec![
        (2500, {
            let (w1, dir) = (w1.clone(), dir.clone());
            Box::new(move || {
                layout(&w1);
                eval(&w1, a, "before-move");
                shot(&dir, "1-two-tabs");
            })
        }),
        (3500, {
            let w1 = w1.clone();
            Box::new(move || {
                let Some(win) = probe::window(&w1) else { return };
                let data = serde_json::json!({ "items": [
                    { "id": "new-tab", "label": "New tab", "key": "Ctrl+T" },
                    { "id": "new-window", "label": "New window", "key": "Ctrl+N" },
                    { "id": "fullscreen", "label": "Full screen", "key": "F11" },
                    { "id": "downloads", "label": "Downloads", "key": "" }]});
                browser::popup_show(win, 760, 76, 240, 148, "menu".into(), data);
            })
        }),
        (4500, {
            let (w1, dir) = (w1.clone(), dir.clone());
            Box::new(move || {
                if let Some(m) = probe::menu(&w1) {
                    let (x, y) = m.position();
                    let (w, h) = m.size();
                    println!("SPIKE menu visible={} at {x},{y} {w}x{h}", m.is_visible());
                }
                shot(&dir, "2-popup");
                if let Some(win) = probe::window(&w1) {
                    browser::popup_hide(win);
                }
            })
        }),
        (5000, {
            let (w1, app) = (w1.clone(), app.clone());
            Box::new(move || {
                let opts = Opts {
                    mode: Mode::App,
                    app_id: Some("wadspaces-webapp-spike".into()),
                    name: Some("Spike App".into()),
                    url: Some(String::new()),
                    ..Default::default()
                };
                match browser::open(&app, opts) {
                    Ok(w2) => {
                        let c = probe::tabs(&w2)[0];
                        load(&w2, c, "C", "#f4d4a4");
                        println!("SPIKE second-window {w2}");
                        let moved = probe::move_tab(&w1, a, &w2);
                        println!("SPIKE moved-tab {moved} w1={:?} w2={:?}", probe::tabs(&w1), probe::tabs(&w2));
                    }
                    Err(e) => println!("SPIKE second-window-failed {e}"),
                }
            })
        }),
        (7000, {
            let dir = dir.clone();
            Box::new(move || {
                for w in probe::labels() {
                    if probe::tabs(&w).contains(&a) {
                        eval(&w, a, "after-move");
                        layout(&w);
                    }
                }
                shot(&dir, "3-moved");
            })
        }),
        (7500, {
            let app = app.clone();
            Box::new(move || {
                // A tab dragged off the strip: a window of its own, page kept.
                let Some(from) = probe::labels().into_iter().find(|w| probe::tabs(w).contains(&a)) else { return };
                match probe::open_with_tab(&app, Opts::default(), &from, a) {
                    Ok(w3) => println!("SPIKE detached-tab to {w3}"),
                    Err(e) => println!("SPIKE detach-failed {e}"),
                }
            })
        }),
        (8800, {
            let dir = dir.clone();
            Box::new(move || {
                for w in probe::labels() {
                    if probe::tabs(&w).contains(&a) {
                        eval(&w, a, "after-detach");
                        layout(&w);
                    }
                }
                println!("SPIKE windows {:?}", probe::labels());
                shot(&dir, "4-detached");
            })
        }),
        (10000, {
            let app = app.clone();
            Box::new(move || {
                println!("SPIKE done");
                app.exit(0);
            })
        }),
    ];
    for (at, step) in steps {
        glib::timeout_add_local_once(Duration::from_millis(at), step);
    }
    true
}

fn load(label: &str, tab: u64, name: &str, bg: &str) {
    if let Some(v) = probe::view(label, tab) {
        v.load_html(&PAGE.replace("__NAME__", name).replace("__BG__", bg), Some("http://spike.localhost/"));
    }
}

fn with_tab_select(label: &str, tab: u64) {
    if let Some(win) = probe::window(label) {
        browser::tab_select(win, tab);
    }
}

fn eval(label: &str, tab: u64, what: &'static str) {
    let Some(v) = probe::view(label, tab) else { return };
    v.evaluate_javascript(STATE, None, None, None::<&gtk::gio::Cancellable>, move |r| match r {
        Ok(v) => println!("SPIKE {what} {}", v.to_str()),
        Err(e) => println!("SPIKE {what}-failed {e}"),
    });
}

fn layout(label: &str) {
    let Some(win) = probe::window(label) else { return };
    let Ok(vbox) = win.default_vbox() else { return };
    let parts: Vec<String> = vbox
        .children()
        .iter()
        .map(|w| {
            let r = w.allocation();
            format!("{}@{},{} {}x{}", w.type_().name(), r.x(), r.y(), r.width(), r.height())
        })
        .collect();
    println!("SPIKE layout {label} {}", parts.join(" | "));
}

fn shot(dir: &std::path::Path, name: &str) {
    let Some(script) = std::env::var_os("WADBROWSER_SPIKE_SHOT") else { return };
    let path = dir.join(name);
    match std::process::Command::new(script).arg(&path).status() {
        Ok(s) if s.success() => println!("SPIKE shot {}", path.display()),
        other => println!("SPIKE shot-failed {other:?}"),
    }
}

/// `WADBROWSER_SPIKE_SITES="url ..."`: what WebKit supports, then each site
/// loaded in turn and screenshotted.
fn sites(app: &AppHandle, dir: PathBuf, urls: Vec<String>) -> bool {
    let label = match browser::open(app, Opts { mode: Mode::Full, url: Some(String::new()), ..Default::default() }) {
        Ok(l) => l,
        Err(e) => {
            println!("SPIKE open-failed {e}");
            app.exit(1);
            return true;
        }
    };
    let tab = probe::tabs(&label)[0];
    if let Some(v) = probe::view(&label, tab) {
        v.load_html("<title>caps</title><p>caps", Some("https://caps.localhost/"));
    }
    glib::timeout_add_local_once(Duration::from_millis(1500), {
        let label = label.clone();
        move || {
            let Some(v) = probe::view(&label, tab) else { return };
            v.call_async_javascript_function(
                &format!("return await {CAPS};"),
                None,
                None,
                None,
                None::<&gtk::gio::Cancellable>,
                |r| match r {
                    Ok(v) => println!("SPIKE caps {}", v.to_str()),
                    Err(e) => println!("SPIKE caps-failed {e}"),
                },
            );
        }
    });
    let mut at = 3000;
    for (i, url) in urls.into_iter().enumerate() {
        let (label, dir, name) = (label.clone(), dir.clone(), format!("site-{i}"));
        glib::timeout_add_local_once(Duration::from_millis(at), {
            let label = label.clone();
            let url = url.clone();
            move || {
                if let Some(v) = probe::view(&label, tab) {
                    v.load_uri(&url);
                }
            }
        });
        at += 9000;
        glib::timeout_add_local_once(Duration::from_millis(at), move || {
            if let Some(v) = probe::view(&label, tab) {
                let title = v.title().unwrap_or_default();
                println!("SPIKE site {url} -> {} \"{title}\"", v.uri().unwrap_or_default());
                // WebKit's own pages (webkit://gpu): their text, in full.
                if url.starts_with("webkit:") {
                    v.evaluate_javascript("document.body.innerText", None, None, None::<&gtk::gio::Cancellable>, |r| {
                        if let Ok(t) = r {
                            println!("SPIKE text {}", t.to_str().replace('\n', " | "));
                        }
                    });
                }
            }
            shot(&dir, &name);
        });
        at += 500;
    }
    let app = app.clone();
    glib::timeout_add_local_once(Duration::from_millis(at + 500), move || {
        println!("SPIKE done");
        app.exit(0);
    });
    true
}
