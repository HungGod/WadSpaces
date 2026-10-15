//! The application: one instance (a second start shows the window), the
//! window (full screen in the kiosk), the theme and fonts, wadd's events
//! into the store.

use std::rc::Rc;

use gtk::{gdk, glib, prelude::*};

use crate::Args;
use crate::store::store;

/// The program's id, as the Tauri app's (its folders), and the window's
/// app_id on Wayland: what sway's rules for the shell name.
const APP_ID: &str = "io.wadspaces.client";
const WINDOW_APP_ID: &str = "client";

const CSS: &str = include_str!("style.css");

pub fn run(args: Args) -> std::process::ExitCode {
    let app = gtk::Application::builder().application_id(APP_ID).build();
    app.connect_startup(|_| {
        wad_gtk::fonts::install();
        let display = gdk::Display::default().expect("a display");
        wad_gtk::theme::install(&display, CSS);
        follow_wadd();
    });
    let args = Rc::new(args);
    app.connect_activate(move |app| {
        if let Some(w) = app.active_window() {
            w.present();
            return;
        }
        let w = window(app, &args);
        w.present();
        if let Some(dir) = args.snapshot.clone() {
            snapshot(&w, dir);
        }
    });
    // Our own options are read in main.rs; GApplication sees none.
    let code = app.run_with_args::<&str>(&[]);
    std::process::ExitCode::from(code.get())
}

fn window(app: &gtk::Application, args: &Args) -> gtk::ApplicationWindow {
    let w = gtk::ApplicationWindow::builder()
        .application(app)
        .title("WadSpaces")
        .default_width(1280)
        .default_height(800)
        .width_request(800)
        .height_request(560)
        .build();
    w.set_child(Some(&crate::shell::shell()));
    wad_gtk::theme::mark(&w, wad_gtk::theme::shown());
    if args.kiosk {
        w.set_decorated(false);
        w.fullscreen();
    }
    // sway knows the shell as "client" (host/etc/sway/wadspaces.conf):
    // named before it's first shown, so the rules match.
    w.connect_realize(|w| {
        if let Some(t) = w.surface().and_then(|s| s.downcast::<gdk_wayland::WaylandToplevel>().ok()) {
            t.set_application_id(WINDOW_APP_ID);
        }
    });
    w
}

/// wadd's events, from tokio to the store on GTK's loop.
fn follow_wadd() {
    let (tx, rx) = async_channel::unbounded();
    {
        let _rt = crate::rt::enter();
        wad_wadd_client::Wadd::here().follow(move |i| tx.send_blocking(i).is_ok());
    }
    glib::spawn_future_local(async move {
        let s = store();
        while let Ok(i) = rx.recv().await {
            s.apply(i);
        }
    });
}

/// Draws the window, dark then light (and narrow), to DIR, and quits.
fn snapshot(w: &gtk::ApplicationWindow, dir: std::path::PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let w = w.clone();
    glib::spawn_future_local(async move {
        let display = WidgetExt::display(&w);
        let settle = || glib::timeout_future(std::time::Duration::from_millis(700));
        settle().await;
        for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
            wad_gtk::theme::set(&display, t);
            settle().await;
            shot(&w, &dir.join(format!("shell-{}.png", t.name())));
        }
        if let Some(app) = w.application() {
            app.quit();
        }
    });
}

fn shot(w: &gtk::ApplicationWindow, path: &std::path::Path) {
    match save_png(w, path) {
        Ok(()) => tracing::info!("wrote {}", path.display()),
        Err(e) => tracing::warn!("{}: {e}", path.display()),
    }
}

fn save_png(w: &impl IsA<gtk::Widget>, path: &std::path::Path) -> Result<(), String> {
    let w = w.upcast_ref::<gtk::Widget>();
    let paintable = gtk::WidgetPaintable::new(Some(w));
    let (width, height) = (w.width() as f64, w.height() as f64);
    let snap = gtk::Snapshot::new();
    paintable.snapshot(&snap, width, height);
    let node = snap.to_node().ok_or("nothing drawn")?;
    let renderer = w.native().and_then(|n| n.renderer()).ok_or("no renderer")?;
    let texture = renderer.render_texture(&node, None);
    texture.save_to_png(path).map_err(|e| e.to_string())
}
