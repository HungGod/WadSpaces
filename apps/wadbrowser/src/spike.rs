//! Stage 0 spike (spike/run.sh): opens windows and tabs on a headless sway,
//! and prints `SPIKE` lines on whether the design holds up:
//!
//! - the chrome sits above the tab stack at its fixed height;
//! - the transparent popup view draws over the page;
//! - each window gets its own app_id;
//! - a tab moved to another window keeps its page (no reload).
//!
//! `WADBROWSER_SPIKE_SHOT=<script>` is run with a path to save screenshots.

use crate::browser::{self, First, Mode, Opts, probe};
use crate::commands;
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
    if std::env::var_os("WADBROWSER_SPIKE_CLOSE_SOURCE").is_some() {
        return close_source(app, dir);
    }
    if std::env::var_os("WADBROWSER_SPIKE_DRAG").is_some() {
        return drag(app, dir);
    }
    if std::env::var_os("WADBROWSER_SPIKE_DRAG_OUT").is_some() {
        return drag_out(app, dir);
    }
    if std::env::var_os("WADBROWSER_SPIKE_EDGES").is_some() {
        return edges(app);
    }
    if std::env::var_os("WADBROWSER_SPIKE_STRESS").is_some() {
        return stress(app);
    }
    if std::env::var_os("WADBROWSER_SPIKE_ROUNDTRIP").is_some() {
        return roundtrip(app, dir);
    }
    let w1 = match browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![String::new()]))
    {
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
                chrome_report(&w1);
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
                commands::popup_show(win, 760, 76, 240, 148, "menu".into(), data);
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
                    commands::popup_hide(win);
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
                    start: Some("http://spike.localhost/".into()),
                    ..Default::default()
                };
                match browser::open(&app, opts, First::Urls(vec![String::new()])) {
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
                    chrome_report(&w);
                    if probe::tabs(&w).contains(&a) {
                        eval(&w, a, "after-detach");
                        layout(&w);
                    }
                }
                println!("SPIKE windows {:?}", probe::labels());
                shot(&dir, "4-detached");
            })
        }),
        (9500, {
            let w1 = w1.clone();
            Box::new(move || {
                // Hibernation: a tab with history, put to sleep, then woken.
                let Some(d) = probe::new_tab(&w1, "data:text/html,<title>D1</title>one") else { return };
                if let Some(v) = probe::view(&w1, d) {
                    glib::timeout_add_local_once(Duration::from_millis(500), move || {
                        v.load_uri("data:text/html,<title>D2</title>two")
                    });
                }
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    let e = probe::new_tab(&w1, "data:text/html,<title>E</title>e").unwrap_or_default();
                    let slept = probe::sleep(&w1, d);
                    println!("SPIKE slept {slept} live={}", probe::is_live(&w1, d));
                    glib::timeout_add_local_once(Duration::from_millis(500), move || {
                        probe::select(&w1, d);
                        let _ = e;
                        glib::timeout_add_local_once(Duration::from_millis(1200), move || {
                            if let Some(v) = probe::view(&w1, d) {
                                println!(
                                    "SPIKE woke live={} title={:?} can_back={}",
                                    probe::is_live(&w1, d),
                                    v.title().unwrap_or_default(),
                                    v.can_go_back()
                                );
                            }
                        });
                    });
                });
            })
        }),
        (13500, {
            let dir = dir.clone();
            Box::new(move || shot(&dir, "5-woken"))
        }),
        (14000, {
            let w1 = w1.clone();
            Box::new(move || {
                // A download (to the Downloads folder run.sh sets) and a find.
                probe::new_tab(
                    &w1,
                    "data:text/html,<title>Dl</title><p>Lorem one, Lorem two, lorem three</p>\
                     <a id=d download=hello.txt href='data:text/plain,hello'>x</a>\
                     <script>setTimeout(() => document.getElementById('d').click(), 300)</script>",
                );
            })
        }),
        (16000, {
            let (w1, app) = (w1.clone(), app.clone());
            Box::new(move || {
                let items: Vec<String> = crate::downloads::list()
                    .iter()
                    .map(|i| format!("{}:{:?}:{}", i.name, i.state, i.received))
                    .collect();
                println!("SPIKE downloads {items:?}");
                crate::actions::run(&app, &w1, crate::actions::Action::Find);
                if let Some(c) = probe::chrome(&w1) {
                    // Typed into the find row: it shows the count for what's in it.
                    let w1 = w1.clone();
                    c.evaluate_javascript(
                        r#"const f = document.getElementById("findtext"); f.value = "lorem"; f.dispatchEvent(new Event("input"));"#,
                        None,
                        None,
                        None::<&gtk::gio::Cancellable>,
                        move |_| {
                            let _ = &w1;
                        },
                    );
                }
            })
        }),
        (17500, {
            let (w1, dir) = (w1.clone(), dir.clone());
            Box::new(move || {
                chrome_report(&w1);
                shot(&dir, "6-find");
            })
        }),
        (18500, {
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
    probe::select(label, tab);
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
    let label =
        match browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![String::new()])) {
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

/// What the chrome's page shows, and any errors it had.
fn chrome_report(label: &str) {
    let Some(c) = probe::chrome(label) else { return };
    let js = r#"JSON.stringify({ body: document.body.className, tabs: document.getElementById("tabs").children.length,
        url: document.getElementById("url").value, errors: window.__wbErrors,
        find: document.getElementById("findcount").textContent, downloads: !document.getElementById("downloads").hidden })"#;
    let label = label.to_owned();
    c.evaluate_javascript(js, None, None, None::<&gtk::gio::Cancellable>, move |r| match r {
        Ok(v) => println!("SPIKE chrome {label} {}", v.to_str()),
        Err(e) => println!("SPIKE chrome-failed {label} {e}"),
    });
}

/// A tab moved out of a window that then closes (its last tab gone): the
/// tab detached first, then the window's last tab moved after it.
fn close_source(app: &AppHandle, dir: PathBuf) -> bool {
    let Ok(w1) = browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![String::new()]))
    else {
        return true;
    };
    // data: pages, so a page made again loads (spike.localhost doesn't).
    let page = |name: &str, bg: &str| {
        format!(
            "data:text/html,<title>Page {name}</title><body style='background:{bg};font:40px sans-serif'><h1>{name}</h1><input id=i value='typed'><script>window.born=Date.now()</script>"
        )
    };
    let x = probe::tabs(&w1)[0];
    if let Some(v) = probe::view(&w1, x) {
        v.load_uri(&page("X", "%23f4a4a4"));
    }
    let y = probe::new_tab(&w1, &page("Y", "%23a4c2f4")).unwrap_or_default();
    let app2 = app.clone();
    let (w1b, dir2) = (w1.clone(), dir.clone());
    glib::timeout_add_local_once(Duration::from_millis(2500), move || {
        let w2 = probe::open_with_tab(&app2, Opts::default(), &w1b, y).unwrap();
        println!("SPIKE detached Y to {w2}");
        let (app3, w1c) = (app2.clone(), w1b.clone());
        glib::timeout_add_local_once(Duration::from_millis(2000), move || {
            let r = browser::move_tab(&app3, &w1c, x, Some(&w2), None);
            println!("SPIKE moved X into {w2}: {r:?}, windows {:?}", probe::labels());
            let (w2b, dir3) = (w2.clone(), dir2.clone());
            glib::timeout_add_local_once(Duration::from_millis(2500), move || {
                eval(&w2b, x, "x-after-move");
                shot(&dir3, "c1-moved");
                if let Some(v) = probe::view(&w2b, x) {
                    v.reload();
                }
                let (w2c, dir4) = (w2b.clone(), dir3.clone());
                glib::timeout_add_local_once(Duration::from_millis(2500), move || {
                    eval(&w2c, x, "x-after-reload");
                    shot(&dir4, "c2-reloaded");
                });
            });
        });
    });
    let app = app.clone();
    glib::timeout_add_local_once(Duration::from_millis(14000), move || {
        println!("SPIKE done");
        app.exit(0);
    });
    true
}

thread_local! {
    static POINTER: std::cell::RefCell<Option<crate::vpointer::VPointer>> =
        std::cell::RefCell::new(crate::vpointer::VPointer::new((1280, 800)));
}

/// The virtual pointer: `set x y`, `press button1`, `release button1`.
fn pointer(cmd: &str) {
    POINTER.with_borrow_mut(|p| {
        let Some(p) = p else {
            println!("SPIKE no-virtual-pointer");
            return;
        };
        let parts: Vec<&str> = cmd.split(' ').collect();
        match parts.as_slice() {
            ["set", x, y] => p.move_to(x.parse().unwrap_or(0), y.parse().unwrap_or(0)),
            ["press", _] => p.button(true),
            ["release", _] => p.button(false),
            _ => {}
        }
    });
}

/// Steps one after another: (wait ms, what).
fn steps(list: Vec<(u64, Box<dyn FnOnce()>)>) {
    let mut at = 0;
    for (wait, f) in list {
        at += wait;
        glib::timeout_add_local_once(Duration::from_millis(at), f);
    }
}

fn press_drag_release(from: (i32, i32), to: (i32, i32), escape: bool) -> Vec<(u64, Box<dyn FnOnce()>)> {
    let mut v: Vec<(u64, Box<dyn FnOnce()>)> = vec![
        (100, Box::new(move || pointer(&format!("set {} {}", from.0, from.1)))),
        (150, Box::new(|| pointer("press button1"))),
    ];
    // Moved in steps, as a hand would (GTK starts a drag past a threshold).
    for i in 1..=10 {
        let (x, y) = (from.0 + (to.0 - from.0) * i / 10, from.1 + (to.1 - from.1) * i / 10);
        v.push((60, Box::new(move || pointer(&format!("set {x} {y}")))));
    }
    let _ = escape;
    v.push((200, Box::new(|| pointer("release button1"))));
    v
}

/// Real drags with sway's pointer: a tab dropped on the page (a window of its
/// own), then one dropped on the other window's chrome away from its tabs
/// (docked there).
fn drag(app: &AppHandle, dir: PathBuf) -> bool {
    let Ok(w1) = browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![String::new()]))
    else {
        return true;
    };
    let a = probe::tabs(&w1)[0];
    load(&w1, a, "A", "#9fd8a4");
    let b = probe::new_tab(&w1, "").unwrap_or_default();
    load(&w1, b, "B", "#a4c2f4");
    let c = probe::new_tab(&w1, "").unwrap_or_default();
    load(&w1, c, "C", "#f4d4a4");
    let report = |what: &'static str| {
        Box::new(move || {
            let ws: Vec<String> = probe::labels().iter().map(|l| format!("{l}:{:?}", probe::tabs(l))).collect();
            println!("SPIKE {what} {}", ws.join(" "));
        }) as Box<dyn FnOnce()>
    };
    let mut list: Vec<(u64, Box<dyn FnOnce()>)> = vec![(2500, report("start"))];
    // First a plain click on tab A (x≈100): does the pointer reach the chrome?
    let w = w1.clone();
    list.push((100, Box::new(move || println!("SPIKE active before click {:?}", probe::active(&w)))));
    list.push((100, Box::new(|| pointer("set 100 19"))));
    list.push((100, Box::new(|| pointer("press button1"))));
    list.push((100, Box::new(|| pointer("release button1"))));
    let w = w1.clone();
    list.push((500, Box::new(move || println!("SPIKE active after click {:?}", probe::active(&w)))));
    // Tab B (second in the strip, about x=310 y=19) down onto the page.
    list.extend(press_drag_release((310, 19), (500, 500), false));
    list.push((1500, report("after-drop-on-page")));
    let d = dir.clone();
    list.push((200, Box::new(move || shot(&d, "d1-detached"))));
    // Now two windows side by side (sway tiles them): w1 on the left half,
    // the new one on the right. Tab C (w1's second, x≈310) onto the right
    // window's toolbar row, away from its tabs (x≈1100 y≈57).
    list.extend(press_drag_release((310, 19), (1100, 57), false));
    list.push((1500, report("after-drop-on-chrome")));
    list.push((200, Box::new(move || shot(&dir, "d2-docked"))));
    let app = app.clone();
    list.push((
        500,
        Box::new(move || {
            println!("SPIKE done");
            app.exit(0);
        }),
    ));
    steps(list);
    true
}

/// A tab dragged off the window onto the bare desktop (run.sh floats the
/// windows, so there is some): a window of its own.
fn drag_out(app: &AppHandle, dir: PathBuf) -> bool {
    let Ok(w1) = browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![String::new()]))
    else {
        return true;
    };
    let a = probe::tabs(&w1)[0];
    load(&w1, a, "A", "#9fd8a4");
    let b = probe::new_tab(&w1, "").unwrap_or_default();
    load(&w1, b, "B", "#a4c2f4");
    let report = |what: &'static str| {
        Box::new(move || {
            let ws: Vec<String> = probe::labels().iter().map(|l| format!("{l}:{:?}", probe::tabs(l))).collect();
            println!("SPIKE {what} {}", ws.join(" "));
        }) as Box<dyn FnOnce()>
    };
    let mut list: Vec<(u64, Box<dyn FnOnce()>)> = vec![(2500, report("start"))];
    let d = dir.clone();
    list.push((100, Box::new(move || shot(&d, "o0-start"))));
    // The window floats centred (1100×750 on 1280×800: from x 90, y 25);
    // tab B is at about (310, 19) in it. Off to the bottom-left corner.
    list.extend(press_drag_release((400, 44), (20, 790), false));
    list.push((1500, report("after-drop-outside")));
    let d = dir.clone();
    list.push((200, Box::new(move || shot(&d, "o1-outside"))));
    list.push((
        100,
        Box::new(move || {
            for w in probe::labels() {
                for t in probe::tabs(&w) {
                    if let Some(v) = probe::view(&w, t) {
                        let r = v.allocation();
                        println!(
                            "SPIKE view {w}/{t} visible={} mapped={} {}x{}",
                            v.is_visible(),
                            v.is_mapped(),
                            r.width(),
                            r.height()
                        );
                    }
                }
                layout(&w);
            }
        }),
    ));
    list.push((3000, Box::new(move || shot(&dir, "o2-later"))));
    let app = app.clone();
    list.push((
        500,
        Box::new(move || {
            println!("SPIKE done");
            app.exit(0);
        }),
    ));
    steps(list);
    true
}

/// Pressing and dragging at the bottom of the chrome (just under the URL bar)
/// must not resize the window; at the window's bottom edge it must.
fn edges(app: &AppHandle) -> bool {
    let Ok(w1) = browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![String::new()]))
    else {
        return true;
    };
    let size = {
        let w1 = w1.clone();
        move |what: &'static str| {
            let w1 = w1.clone();
            Box::new(move || {
                if let Some(w) = probe::window(&w1) {
                    let s = w.inner_size().unwrap();
                    println!("SPIKE size {what} {}x{}", s.width, s.height);
                }
            }) as Box<dyn FnOnce()>
        }
    };
    // Floating, centred: the window spans x 90..1190, y 25..775; its chrome's
    // bottom is at y 25+76.
    let mut list: Vec<(u64, Box<dyn FnOnce()>)> = vec![(2500, size("start"))];
    list.extend(press_drag_release((600, 25 + 74), (600, 25 + 74 + 40), false));
    list.push((800, size("after-chrome-bottom")));
    list.extend(press_drag_release((600, 25 + 748), (600, 25 + 748 - 60), false));
    list.push((800, size("after-window-bottom")));
    let app = app.clone();
    list.push((
        300,
        Box::new(move || {
            println!("SPIKE done");
            app.exit(0);
        }),
    ));
    steps(list);
    true
}

/// This process and the WebKit processes it started: how many, and their
/// memory (PSS, MB).
fn memory() -> (usize, u64) {
    let me = std::process::id();
    let mut n = 0;
    let mut kb = 0;
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        let ppid: u32 =
            stat.rsplit(')').next().and_then(|r| r.split_whitespace().nth(1)).and_then(|p| p.parse().ok()).unwrap_or(0);
        if pid != me && ppid != me {
            continue;
        }
        if pid != me {
            n += 1;
        }
        let rollup = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).unwrap_or_default();
        kb += rollup
            .lines()
            .find(|l| l.starts_with("Pss:"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
    }
    (n, kb / 1024)
}

/// A tab detached into a window of its own and docked back (that window
/// closing), again and again: memory should settle, not climb.
fn stress(app: &AppHandle) -> bool {
    let Ok(w1) = browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![String::new()]))
    else {
        return true;
    };
    let a = probe::tabs(&w1)[0];
    load(&w1, a, "A", "#9fd8a4");
    let b = probe::new_tab(&w1, "").unwrap_or_default();
    load(&w1, b, "B", "#a4c2f4");
    let cycles: u32 = std::env::var("WADBROWSER_SPIKE_STRESS").ok().and_then(|n| n.parse().ok()).unwrap_or(12);
    let mut list: Vec<(u64, Box<dyn FnOnce()>)> = vec![(
        2500,
        Box::new(|| {
            let (n, mb) = memory();
            println!("SPIKE memory start: {n} web processes, {mb} MB");
        }),
    )];
    for i in 1..=cycles {
        let (app1, w1a) = (app.clone(), w1.clone());
        list.push((
            600,
            Box::new(move || {
                if let Err(e) = probe::open_with_tab(&app1, Opts::default(), &w1a, b) {
                    println!("SPIKE detach-failed {e}");
                }
            }),
        ));
        let (app2, w1b) = (app.clone(), w1.clone());
        list.push((
            900,
            Box::new(move || {
                let Some(from) = probe::labels().into_iter().find(|l| *l != w1b && probe::tabs(l).contains(&b)) else {
                    return;
                };
                if let Err(e) = browser::move_tab(&app2, &from, b, Some(&w1b), None) {
                    println!("SPIKE dock-failed {e}");
                }
            }),
        ));
        list.push((
            900,
            Box::new(move || {
                let (n, mb) = memory();
                println!("SPIKE memory cycle {i}: {n} web processes, {mb} MB, windows {}", probe::labels().len());
            }),
        ));
    }
    let app = app.clone();
    list.push((
        500,
        Box::new(move || {
            println!("SPIKE done");
            app.exit(0);
        }),
    ));
    steps(list);
    true
}

/// Tab X (first shown in w1) goes to a window of its own and comes home;
/// that window closes behind it. Then tab Y (also first shown in w1) goes to a
/// window of its own, and w1 closes. Does each still draw (GPU path)?
fn roundtrip(app: &AppHandle, dir: PathBuf) -> bool {
    let page = |name: &str, bg: &str| {
        format!(
            "data:text/html,<title>Page {name}</title><body style='background:{bg};font:40px sans-serif'><h1>{name}</h1><script>window.born=Date.now()</script>"
        )
    };
    let Ok(w1) =
        browser::open(app, Opts { mode: Mode::Full, ..Default::default() }, First::Urls(vec![page("X", "%23f4a4a4")]))
    else {
        return true;
    };
    let x = probe::tabs(&w1)[0];
    let y = probe::new_tab(&w1, &page("Y", "%23a4c2f4")).unwrap_or_default();
    let z = probe::new_tab(&w1, &page("Z", "%23d4f4a4")).unwrap_or_default();
    let _ = z;
    let mut list: Vec<(u64, Box<dyn FnOnce()>)> = vec![];
    let (a, w) = (app.clone(), w1.clone());
    list.push((
        2500,
        Box::new(move || {
            probe::open_with_tab(&a, Opts::default(), &w, x).unwrap();
        }),
    ));
    let (a, w) = (app.clone(), w1.clone());
    list.push((
        1500,
        Box::new(move || {
            let from = probe::labels().into_iter().find(|l| *l != w && probe::tabs(l).contains(&x)).unwrap();
            browser::move_tab(&a, &from, x, Some(&w), None).unwrap();
            probe::select(&w, x);
        }),
    ));
    let d = dir.clone();
    list.push((
        2500,
        Box::new(move || {
            shot(&d, "r1-x-home");
        }),
    ));
    let (a, w) = (app.clone(), w1.clone());
    list.push((
        500,
        Box::new(move || {
            probe::open_with_tab(&a, Opts::default(), &w, y).unwrap();
        }),
    ));
    let w = w1.clone();
    list.push((
        1500,
        Box::new(move || {
            if let Some(win) = probe::window(&w) {
                let _ = win.close();
            }
        }),
    ));
    list.push((
        2500,
        Box::new(move || {
            shot(&dir, "r2-y-alone");
        }),
    ));
    let app = app.clone();
    list.push((
        800,
        Box::new(move || {
            println!("SPIKE done");
            app.exit(0);
        }),
    ));
    steps(list);
    true
}
