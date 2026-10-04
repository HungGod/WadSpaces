//! WadBrowser: the WadSpaces web browser.
//!
//! Tauri owns each window and its one webview, the chrome (tabs, toolbar, URL
//! bar: `ui/`). The pages are plain WebKitGTK views that WadBrowser makes and
//! places itself, in a stack under the chrome: Tauri's own child webviews can't
//! be laid out on Wayland, and pages never get Tauri's IPC this way. Menus and
//! panels that must draw over a page go in a popup surface of their own.
//!
//! ```text
//! GtkApplicationWindow (Tauri)            app_id: wadbrowser, or wadspaces-webapp-<id>
//! └ GtkBox (Tauri's default vbox)
//!   ├ chrome WebView (Tauri)              fixed height
//!   └ GtkStack of tab WebViews            the rest; one shown, idle ones sleep
//! popup GtkWindow (RGBA) + WebView        the open menu or panel
//! popup GtkWindow + GtkLabel              the hovered link (bottom left)
//! ```
//!
//! One process per user holds every window (`ipc.rs`): later launches hand
//! their request over and exit.

mod actions;
mod app_id;
mod browser;
mod cli;
mod commands;
mod config;
mod downloads;
mod gpu;
mod ipc;
mod keys;
mod menu;
mod pages;
mod permissions;
mod profile;
mod resize;
mod session;
#[cfg(feature = "spike")]
mod spike;
mod tab;
mod urlbar;
#[cfg(feature = "spike")]
mod vpointer;
mod zoom;

pub use browser::Mode;

use browser::{First, Opts};
use cli::Request;
use gtk::glib;
use std::os::fd::AsRawFd;
use tauri::{AppHandle, RunEvent};

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("WADBROWSER_LOG").unwrap_or_else(|_| "wadbrowser=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let cwd = std::env::current_dir().unwrap_or_else(|_| "/".into());
    let mut req = match cli::parse(std::env::args().skip(1), &cwd) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("wadbrowser: {e}\n{}", cli::USAGE);
            std::process::exit(2);
        }
    };
    if req.help {
        println!("{}", cli::USAGE);
        return;
    }
    if req.version {
        println!("wadbrowser {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    req.activation_token = std::env::var("XDG_ACTIVATION_TOKEN").or_else(|_| std::env::var("DESKTOP_STARTUP_ID")).ok();

    #[cfg(feature = "spike")]
    let spiking = std::env::var_os("WADBROWSER_SPIKE_DIR").is_some();
    #[cfg(not(feature = "spike"))]
    let spiking = false;
    let listener = if spiking {
        None
    } else {
        match ipc::claim(&req) {
            Ok(ipc::Claim::Forwarded) => return,
            Ok(ipc::Claim::Primary(l)) => Some(l),
            Err(e) => {
                tracing::warn!(%e, "no single-instance socket: this browser runs on its own");
                None
            }
        }
    };

    gpu::init(req.gpu.as_deref().or(config::get().gpu.as_deref()));
    app_id::init();
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::chrome_ready,
            commands::act,
            commands::navigate,
            commands::focus_page,
            commands::chrome_height,
            commands::tab_move,
            commands::tab_drag_begin,
            commands::tab_drop,
            commands::tab_drag_end,
            commands::popup_show,
            commands::popup_hide,
            commands::downloads_list,
            commands::download_act,
            commands::find,
            commands::find_close,
            commands::prompt_answer,
            commands::win_action,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            #[cfg(feature = "spike")]
            if spike::start(&handle) {
                return Ok(());
            }
            if let Some(listener) = listener {
                let h = handle.clone();
                glib::source::unix_fd_add_local(listener.as_raw_fd(), glib::IOCondition::IN, move |_, _| {
                    for r in ipc::accept(&listener) {
                        route(&h, r);
                    }
                    glib::ControlFlow::Continue
                });
            }
            let restored = session::restore(&handle);
            if !restored || !req.urls.is_empty() || req.app_id.is_some() {
                route(&handle, req.clone());
            }
            browser::start_hibernation();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("WadBrowser failed to start");
    app.run(|_, event| {
        if let RunEvent::Exit = event {
            session::clear();
        }
    });
}

/// Opens what `req` asks for, in a window already open where that fits.
fn route(app: &AppHandle, req: Request) {
    // Launchers' unexpanded field codes (%U) aren't addresses.
    let urls: Vec<String> = req.urls.iter().filter(|u| !u.starts_with('%')).map(|u| urlbar::normalize(u)).collect();
    let token = req.activation_token.as_deref();

    if let Some(app_id) = &req.app_id {
        if !req.new_window
            && let Some(label) = browser::recent(|b| b.opts.app_id.as_deref() == Some(app_id))
        {
            browser::with(&label, |b| {
                for u in &urls {
                    b.new_tab(Some(u), false);
                }
                b.present(token);
            });
            return;
        }
        let opts = Opts {
            mode: Mode::App,
            app_id: Some(app_id.clone()),
            name: req.name.clone(),
            start: req.start.as_deref().map(urlbar::normalize),
            icon: req.icon.clone(),
            profile: req.profile.clone(),
        };
        open(app, opts, urls);
        return;
    }

    let mode = if req.default {
        config::get().default_mode
    } else if req.no_urlbar {
        Mode::Focus
    } else {
        Mode::Full
    };
    if !urls.is_empty()
        && !req.new_window
        && let Some(label) = browser::recent(|b| b.opts.mode == mode && b.opts.profile == req.profile)
    {
        browser::with(&label, |b| {
            for u in &urls {
                b.new_tab(Some(u), false);
            }
            b.present(token);
        });
        return;
    }
    open(app, Opts { mode, profile: req.profile.clone(), ..Default::default() }, urls);
}

fn open(app: &AppHandle, opts: Opts, urls: Vec<String>) {
    if let Err(e) = browser::open(app, opts, First::Urls(urls)) {
        tracing::error!(%e, "can't open a window");
    }
}
