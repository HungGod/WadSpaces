//! WadBrowser: the WadSpaces web browser.
//!
//! Tauri owns each window and its one webview, the chrome (tabs, toolbar, URL
//! bar: `ui/`). The pages are plain WebKitGTK views that WadBrowser makes and
//! places itself, in a stack under the chrome: Tauri's own child webviews can't
//! be laid out on Wayland, and pages never get Tauri's IPC this way. Menus and
//! panels that must draw over a page go in a second, transparent view on top.
//!
//! ```text
//! GtkApplicationWindow (Tauri)
//! └ GtkBox (Tauri's default vbox)
//!   ├ chrome WebView (Tauri)              fixed height
//!   └ GtkOverlay                          the rest
//!     ├ GtkStack of tab WebViews          one shown
//!     └ popup WebView (transparent)       only while a menu is open
//! ```

mod app_id;
mod browser;
mod gpu;
mod profile;
#[cfg(feature = "spike")]
mod spike;
mod urlbar;

pub use browser::Mode;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("WADBROWSER_LOG").unwrap_or_else(|_| "wadbrowser=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    gpu::init(None);
    app_id::init();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            browser::chrome_ready,
            browser::tab_new,
            browser::tab_select,
            browser::tab_close,
            browser::tab_move,
            browser::tab_drag_begin,
            browser::tab_drop,
            browser::tab_drag_end,
            browser::focus_page,
            browser::navigate,
            browser::nav,
            browser::popup_show,
            browser::popup_hide,
            browser::win_action,
        ])
        .setup(|app| {
            let handle = app.handle();
            #[cfg(feature = "spike")]
            if spike::start(handle) {
                return Ok(());
            }
            browser::open(handle, browser::Opts::default())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("WadBrowser failed to start");
}
