//! Stage 1a spike (S3): drives the real UI in the real webview and reports
//! what WebKitGTK does, with screenshots. Built only with `--features spike`.
//!
//! The page reports by navigating to `spike:<name>?<json>`, which the window's
//! navigation guard catches (and blocks) before anything loads.

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Url, WebviewWindow};

/// Added to the lockdown script: collects CSP violations and errors from the
/// first moment.
pub const WATCH: &str = r#"
window.__spike = { csp: [], errors: [] };
document.addEventListener("securitypolicyviolation", (e) => window.__spike.csp.push(`${e.violatedDirective} ${e.blockedURI}`));
window.addEventListener("error", (e) => window.__spike.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__spike.errors.push(String(e.reason)));
window.__report = (name, data) => { location.href = `spike:${name}?${encodeURIComponent(JSON.stringify(data))}`; };
"#;

const ENV: &str = r#"(async () => {
  const r = { href: location.href, origin: location.origin, secure: isSecureContext, ua: navigator.userAgent };
  try { localStorage.setItem("spike", "1"); r.localStorage = localStorage.getItem("spike") === "1"; } catch (e) { r.localStorage = String(e); }
  try {
    r.indexedDB = await new Promise((res, rej) => {
      const q = indexedDB.open("spike", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("s");
      q.onsuccess = () => { const tx = q.result.transaction("s", "readwrite"); tx.objectStore("s").put("ok", "k"); tx.oncomplete = () => res("ok"); tx.onerror = () => rej(tx.error); };
      q.onerror = () => rej(q.error);
    });
  } catch (e) { r.indexedDB = String(e); }
  try { r.databases = (await indexedDB.databases()).map((d) => d.name); } catch (e) { r.databases = String(e); }
  r.randomUUID = typeof crypto.randomUUID;
  r.webAssembly = typeof WebAssembly;
  try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); r.wasmCompile = "ok"; } catch (e) { r.wasmCompile = String(e); }
  const c = document.createElement("canvas"); c.width = c.height = 4;
  r.toBlob = {};
  for (const t of ["image/webp", "image/jpeg", "image/png"]) r.toBlob[t] = await new Promise((res) => c.toBlob((b) => res(b ? b.type : null), t, 0.8));
  r.clipboard = typeof navigator.clipboard?.writeText;
  r.text = document.body.innerText.slice(0, 200);
  r.watch = window.__spike;
  window.__report("env", r);
})();"#;

/// A failed sign-in with an address that can't exist: proves requests reach
/// Firebase Auth from this origin (the API key's restrictions, CSP, CORS).
const LOGIN: &str = r#"(() => {
  const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const email = document.querySelector("input[type=email]"), pw = document.querySelector("input[type=password]");
  if (!email || !pw) return window.__report("login", { error: "no login form", text: document.body.innerText.slice(0, 200) });
  set(email, "spike-nobody@example.invalid");
  set(pw, "not-a-real-password-123");
  setTimeout(() => document.querySelector("form button[type=submit]").click(), 300);
})();"#;

const AFTER: &str = r#"window.__report("page", { href: location.href, text: document.body.innerText.slice(0, 300), watch: window.__spike });"#;

/// Calls to wadd through the app (src/wadd.rs): which wadd, reads, a 404, a
/// refused secret, a raw upload, and whether the event stream has delivered
/// a state.
const WADD: &str = r#"(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const r = {};
  const t = async (k, f) => { try { r[k] = { ok: await f() }; } catch (e) { r[k] = { err: e }; } };
  await t("kind", () => inv("wadd_kind"));
  await t("network", async () => (await inv("wadd_request", { method: "GET", path: "/api/network", body: null })).connectivity);
  await t("wifi", async () => (await inv("wadd_request", { method: "GET", path: "/api/network/wifi", body: null })).length);
  await t("specs", async () => (await inv("wadd_request", { method: "GET", path: "/api/specs", body: null })).map((s) => s.id));
  await t("missing", () => inv("wadd_request", { method: "GET", path: "/api/workspaces/nope", body: null }));
  await t("secret", () => inv("wadd_request", { method: "PUT", path: "/api/secrets/github_token", body: { value: "x" } }));
  await t("traversal", () => inv("wadd_request", { method: "GET", path: "/api/../etc", body: null }));
  await t("upload", () => inv("wadd_build_context", new Uint8Array(1024), { headers: { "x-build-id": "nope" } }));
  await t("lastState", async () => (await inv("wadd_last_state"))?.machine);
  window.__report("wadd", r);
})();"#;

/// The Wi-Fi step (when the machine is offline): pick a network, give a password.
const WIFI: &str = r#"(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Home Network"));
  if (!btn) return window.__report("wifi", { error: "no network list", text: document.body.innerText.slice(0, 300) });
  btn.click();
  setTimeout(() => {
    const pw = document.querySelector("input[type=password]");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(pw, "wrong-password");
    pw.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Join").click(), 200);
  }, 300);
})();"#;

/// A deep route, reloaded: does the asset protocol serve the app for it?
const RELOAD: &str = r#"history.pushState({}, "", "/signup"); location.reload();"#;

pub fn report(url: &Url) {
    let name = url.path();
    let data = url.query().map(percent_decode).unwrap_or_default();
    println!("SPIKE {name} {data}");
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into()
}

fn snapshot(w: &WebviewWindow, path: PathBuf) {
    let _ = w.with_webview(move |pw| {
        use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
        pw.inner().snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&webkit2gtk::gio::Cancellable>,
            move |r| {
                let saved = r.map_err(|e| e.to_string()).and_then(|s| {
                    let img = cairo::ImageSurface::try_from(s).map_err(|_| "not an image surface".to_string())?;
                    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
                    img.write_to_png(&mut f).map_err(|e| e.to_string())
                });
                match saved {
                    Ok(()) => println!("SPIKE snapshot {}", path.display()),
                    Err(e) => println!("SPIKE snapshot-failed {e}"),
                }
            },
        );
    });
}

pub fn start(app: AppHandle, w: WebviewWindow) {
    let Some(dir) = std::env::var_os("WADCREATOR_SPIKE_DIR").map(PathBuf::from) else { return };
    std::thread::spawn(move || {
        let wait = |s| std::thread::sleep(Duration::from_secs(s));
        let t0 = std::time::Instant::now();
        wait(6);
        println!("SPIKE started {:?}", t0.elapsed());
        snapshot(&w, dir.join("1-start.png"));
        let _ = w.eval(ENV);
        wait(3);
        let _ = w.eval(WADD);
        wait(3);
        if std::env::var_os("WADCREATOR_SPIKE_WIFI").is_some() {
            let _ = w.eval(WIFI);
        } else {
            let _ = w.eval(LOGIN);
        }
        wait(8);
        snapshot(&w, dir.join("2-login.png"));
        let _ = w.eval(AFTER);
        wait(2);
        let _ = w.eval(RELOAD);
        wait(6);
        snapshot(&w, dir.join("3-reload.png"));
        let _ = w.eval(AFTER);
        wait(2);
        app.exit(0);
    });
}
