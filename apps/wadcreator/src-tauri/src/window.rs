//! The app's one window, locked down: it only ever shows the app itself. No
//! navigating away, no new windows, no browser context menu (release builds),
//! and file drops go to the page (the Builder's drag and drop) rather than
//! being opened.

use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::window::Color;
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindow};

pub const MAIN: &str = "main";

/// The app's background (`--bg` in globals.css), shown before the page paints.
const BACKGROUND: Color = Color(0x0a, 0x06, 0x14, 0xff);

/// Runs in every page before its own scripts.
const LOCKDOWN: &str = r#"(() => {
  window.open = () => null;
  if (!__DEBUG__) {
    document.addEventListener("contextmenu", (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest("input, textarea, [contenteditable]")) e.preventDefault();
    }, true);
  }
})();"#;

/// Whether the window may show `url`: the app's own pages only (and, while
/// developing, Vite's dev server).
fn allowed(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http", Some("tauri.localhost")) => true,
        ("http", Some("localhost")) => cfg!(debug_assertions) && url.port() == Some(8081),
        _ => false,
    }
}

pub fn open_main(app: &AppHandle, kiosk: bool) -> tauri::Result<WebviewWindow> {
    #[allow(unused_mut)]
    let mut script = LOCKDOWN.replace("__DEBUG__", if cfg!(debug_assertions) { "true" } else { "false" });
    #[cfg(feature = "spike")]
    script.push_str(crate::spike::WATCH);
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Wad Creator")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 560.0)
        .fullscreen(kiosk)
        .decorations(!kiosk)
        .background_color(BACKGROUND)
        .disable_drag_drop_handler()
        .initialization_script(script)
        .on_navigation(|url| {
            #[cfg(feature = "spike")]
            if url.scheme() == "spike" {
                crate::spike::report(url);
                return false;
            }
            let ok = allowed(url);
            if !ok {
                tracing::warn!(%url, "blocked navigation");
            }
            ok
        })
        .on_new_window(|url, _| {
            tracing::warn!(%url, "blocked new window");
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_app_itself() {
        let ok = |s: &str| allowed(&Url::parse(s).unwrap());
        assert!(ok("tauri://localhost/projects"));
        assert!(ok("http://tauri.localhost/"));
        assert_eq!(ok("http://localhost:8081/"), cfg!(debug_assertions));
        assert!(!ok("http://localhost:8080/"));
        assert!(!ok("https://wad-spaces.firebaseapp.com/__/auth/handler"));
        assert!(!ok("https://github.com/login/device"));
        assert!(!ok("file:///etc/passwd"));
    }
}
