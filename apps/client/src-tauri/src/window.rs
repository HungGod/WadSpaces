//! The app's window, locked down: it only ever shows the app itself. No
//! navigating away, no new windows, no browser context menu (release builds),
//! and file drops go to the page (the Builder's drag and drop) rather than
//! being opened.
//!
//! One other window may open over it: GitHub's sign-in page (open_github),
//! for signing in without a phone. It's private (nothing is kept), https
//! only, and can't call the app's commands (lib.rs answers the main window
//! alone).

use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow};

pub const MAIN: &str = "main";
pub const GITHUB: &str = "github";
/// The GitHub window's title (sway floats it by this: host/etc/sway).
pub const GITHUB_TITLE: &str = "Sign in to GitHub";
/// Where the GitHub window's Ctrl+W goes: never loaded, it closes the window.
const CLOSE_URL: &str = "https://close.client.invalid/";

/// Runs in GitHub's page: no popups, and Ctrl+W closes the window (as it did
/// in a browser).
const GITHUB_SCRIPT: &str = r#"(() => {
  window.open = () => null;
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      location.href = "__CLOSE__";
    }
  }, true);
})();"#;

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
        .title("WadSpaces")
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

/// Whether the GitHub window may go to `url`: https pages (GitHub's sign-in
/// may pass through its own hosts), nothing else.
fn github_allowed(url: &Url) -> bool {
    url.scheme() == "https" && url.as_str() != CLOSE_URL
}

/// GitHub's page at `url`, in a window of its own over the app (a new one
/// replaces an old one).
pub fn open_github(app: &AppHandle, url: Url) -> tauri::Result<WebviewWindow> {
    close_github(app);
    let handle = app.clone();
    WebviewWindowBuilder::new(app, GITHUB, WebviewUrl::External(url))
        .title(GITHUB_TITLE)
        .inner_size(900.0, 720.0)
        .incognito(true)
        .initialization_script(GITHUB_SCRIPT.replace("__CLOSE__", CLOSE_URL))
        .on_navigation(move |url| {
            if url.as_str() == CLOSE_URL {
                close_github(&handle);
                return false;
            }
            let ok = github_allowed(url);
            if !ok {
                tracing::warn!(%url, "blocked navigation in the GitHub window");
            }
            ok
        })
        .on_new_window(|url, _| {
            tracing::warn!(%url, "blocked new window");
            NewWindowResponse::Deny
        })
        .build()
}

/// Closes the GitHub window, if it's open.
pub fn close_github(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(GITHUB) {
        // Not from inside the window's own callbacks: on the next turn.
        tauri::async_runtime::spawn(async move {
            let _ = w.destroy();
        });
    }
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

    #[test]
    fn the_github_window_stays_on_https() {
        let ok = |s: &str| github_allowed(&Url::parse(s).unwrap());
        assert!(ok("https://github.com/login/device") && ok("https://github.com/sessions/two-factor/app"));
        assert!(!ok("http://github.com/login") && !ok("tauri://localhost/") && !ok("file:///etc/passwd"));
        assert!(!ok(CLOSE_URL));
    }
}
