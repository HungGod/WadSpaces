//! Viewing another machine's wadspace here: wadd opens a view (its
//! remote.rs: a proxy on 127.0.0.1 that pins that machine's certificate and
//! adds the stream password) and this opens it in a window of its own over
//! the app. The page never sees the view's address, token or password: the
//! Rust side asks wadd and opens the window.
//!
//! The window shows that one address and nothing else (no other origin, no
//! new windows), keeps nothing (private), can't call the app's commands
//! (lib.rs answers the main window alone), and closing it (Ctrl+W, or its
//! Close button) ends the view in wadd.

use serde_json::json;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WindowEvent};

use crate::wadd::{Method, Wadd, WaddFailure};

/// Where the window's Close goes: never loaded, it closes the window.
const CLOSE_URL: &str = "http://127.0.0.1:1/__wad_close";

/// In the stream's page: Ctrl+W and a small Close button take you back to
/// the app, and no popups.
const SCRIPT: &str = r#"(() => {
  window.open = () => null;
  const close = () => { location.href = "__CLOSE__"; };
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") { e.preventDefault(); close(); }
  }, true);
  const add = () => {
    if (!document.body || document.getElementById("__wad_close")) return;
    const b = document.createElement("button");
    b.id = "__wad_close";
    b.textContent = "✕ Close";
    b.title = "Back to Wad Creator (Ctrl+W)";
    b.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;padding:6px 12px;border:0;border-radius:10px;" +
      "background:rgba(10,6,20,.72);color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;opacity:.55";
    b.onmouseenter = () => (b.style.opacity = "1");
    b.onmouseleave = () => (b.style.opacity = ".55");
    b.onclick = close;
    document.body.appendChild(b);
  };
  document.addEventListener("DOMContentLoaded", add);
  setInterval(add, 2000);
})();"#;

/// A view's address from wadd: http://127.0.0.1:<port>/__wad/<64 hex>.
/// (scheme, host, port) the window may show, if it is one.
fn view_origin(url: &Url) -> Option<u16> {
    let token = url.path().strip_prefix("/__wad/")?;
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && token.len() == 64
        && token.bytes().all(|b| b.is_ascii_hexdigit())
        && url.query().is_none())
    .then_some(url.port()?)
}

/// The window may show this: the view's own origin, nothing else.
fn same_origin(url: &Url, port: u16) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
}

fn label_for(view_id: &str) -> Option<String> {
    (!view_id.is_empty() && view_id.len() <= 32 && view_id.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("stream-{view_id}"))
}

/// Shows `machine_id`'s stream of `ws_id` in a window of its own (that
/// machine must be streaming it: the UI asks it first).
#[tauri::command]
#[specta::specta]
pub async fn stream_view(
    app: AppHandle,
    wadd: State<'_, Wadd>,
    machine_id: String,
    ws_id: String,
    title: String,
) -> Result<(), WaddFailure> {
    let v =
        wadd.call(Method::Post, "/api/remote-views", Some(json!({ "machineId": machine_id, "wsId": ws_id }))).await?;
    let field = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let (id, url) = (field("id"), field("url"));
    let bad = || WaddFailure::new(502, "wadd's view isn't one this window opens");
    let url = Url::parse(&url).map_err(|_| bad())?;
    let window = open_window(&app, url, &id, &title).map_err(|e| WaddFailure::new(502, e))?;
    // Closed however it closes: the view ends in wadd.
    let app2 = app.clone();
    window.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            let (app, id) = (app2.clone(), id.clone());
            tauri::async_runtime::spawn(async move {
                let wadd = app.state::<Wadd>();
                if let Err(e) = wadd.call(Method::Delete, &format!("/api/remote-views/{id}"), None).await {
                    tracing::info!("closing remote view {id}: {}", e.message);
                }
            });
        }
    });
    Ok(())
}

/// The window for a view at `url` (wadd's: checked here again), titled
/// `title`, labelled by the view's id.
pub fn open_window(app: &AppHandle, url: Url, view_id: &str, title: &str) -> Result<tauri::WebviewWindow, String> {
    let port = view_origin(&url).ok_or("not a view's address")?;
    let label = label_for(view_id).ok_or("not a view's id")?;
    let title: String = title.chars().filter(|c| !c.is_control()).take(80).collect();
    let handle = app.clone();
    let close_label = label.clone();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(if title.is_empty() { "Wadspace".into() } else { title })
        .inner_size(1280.0, 800.0)
        .incognito(true)
        .initialization_script(SCRIPT.replace("__CLOSE__", CLOSE_URL))
        .on_navigation(move |u| {
            #[cfg(feature = "spike")]
            if u.scheme() == "spike" {
                crate::spike::report(u);
                return false;
            }
            if u.as_str() == CLOSE_URL {
                close_window(&handle, &close_label);
                return false;
            }
            let ok = same_origin(u, port);
            if !ok {
                tracing::warn!(url = %u, "blocked navigation in a stream window");
            }
            ok
        })
        .on_new_window(|u, _| {
            tracing::warn!(url = %u, "blocked new window");
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())
}

fn close_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        tauri::async_runtime::spawn(async move {
            let _ = w.destroy();
        });
    }
}

/// A QR code (SVG) of `text`: a stream's link, for a phone's camera.
#[tauri::command]
#[specta::specta]
pub fn qr_svg(text: String) -> String {
    wad_github::qr_svg(&text.chars().take(512).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_wadds_view_addresses_open() {
        let t = "ab".repeat(32);
        let ok = Url::parse(&format!("http://127.0.0.1:41234/__wad/{t}")).unwrap();
        assert_eq!(view_origin(&ok), Some(41234));
        for bad in [
            format!("https://127.0.0.1:41234/__wad/{t}"),
            format!("http://localhost:41234/__wad/{t}"),
            format!("http://192.168.1.5:41234/__wad/{t}"),
            format!("http://127.0.0.1:41234/__wad/{}", "x".repeat(64)),
            format!("http://127.0.0.1:41234/__wad/{t}?u=1"),
            "http://127.0.0.1:41234/".into(),
        ] {
            assert_eq!(view_origin(&Url::parse(&bad).unwrap()), None, "{bad}");
        }
        assert!(same_origin(&Url::parse("http://127.0.0.1:41234/websocket").unwrap(), 41234));
        assert!(!same_origin(&Url::parse("http://127.0.0.1:41235/").unwrap(), 41234));
        assert!(!same_origin(&Url::parse("https://evil.example/").unwrap(), 41234));
        assert_eq!(label_for("0a1b2c3d4e5f6a7b").as_deref(), Some("stream-0a1b2c3d4e5f6a7b"));
        assert_eq!(label_for("../main"), None);
    }
}
