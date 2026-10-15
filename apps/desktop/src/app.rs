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
        // Snapshots and trying things: a made-up machine and account.
        if let Ok(path) = std::env::var("WADSPACES_FAKE") {
            crate::fake::load(std::path::Path::new(&path));
            return;
        }
        follow_wadd();
        crate::account::start();
        crate::account::follow_library();
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
    w.set_child(Some(&crate::setup::gate(crate::shell::shell())));
    wad_gtk::theme::mark(&w, wad_gtk::theme::shown());
    if args.kiosk {
        w.set_decorated(false);
        w.fullscreen();
    }
    // Esc closes the top dialog.
    let keys = gtk::EventControllerKey::new();
    keys.set_propagation_phase(gtk::PropagationPhase::Capture);
    keys.connect_key_pressed(|_, key, _, _| {
        if key == gtk::gdk::Key::Escape && crate::modal::escape() {
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    w.add_controller(keys);
    // sway knows the shell as "client" (host/etc/sway/wadspaces.conf). GTK
    // names the window after the application's id once its toplevel exists
    // (on map); renamed straight after, before its first frame, so sway's
    // rules see "client".
    w.connect_map(|w| {
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

/// Draws what's on screen (setup, without a sign-in), then the app, dark
/// and light, to DIR, and quits.
fn snapshot(w: &gtk::ApplicationWindow, dir: std::path::PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let w = w.clone();
    glib::spawn_future_local(async move {
        let display = WidgetExt::display(&w);
        let settle = |ms| glib::timeout_future(std::time::Duration::from_millis(ms));
        // The gate waits a moment for wadd.
        settle(3600).await;
        for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
            wad_gtk::theme::set(&display, t);
            settle(700).await;
            shot(&w, &dir.join(format!("setup-{}.png", t.name())));
        }
        crate::setup::show_app();
        for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
            wad_gtk::theme::set(&display, t);
            settle(700).await;
            shot(&w, &dir.join(format!("shell-{}.png", t.name())));
        }
        crate::launcher::open();
        for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
            wad_gtk::theme::set(&display, t);
            settle(900).await;
            shot(&w, &dir.join(format!("launcher-{}.png", t.name())));
        }
        crate::modal::escape();
        for (entry, name) in [("w:vanua-academy", "launcher-customize"), ("b:wadbrowser", "launcher-browser")] {
            crate::launcher::customize(entry);
            for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
                wad_gtk::theme::set(&display, t);
                settle(900).await;
                shot(&w, &dir.join(format!("{name}-{}.png", t.name())));
            }
            crate::modal::escape();
        }
        crate::shell::go(crate::shell::Page::Machines);
        for tab in ["wadspaces", "history", "storage", "files", "diagnostics"] {
            crate::pages::machines::show_tab(tab);
            let name = if tab == "wadspaces" { "machines".to_string() } else { format!("machines-{tab}") };
            for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
                wad_gtk::theme::set(&display, t);
                settle(800).await;
                shot(&w, &dir.join(format!("{name}-{}.png", t.name())));
            }
        }
        // The long tabs whole, and another machine's.
        wad_gtk::theme::set(&display, wad_gtk::Theme::Dark);
        for tab in ["storage", "diagnostics"] {
            crate::pages::machines::show_tab(tab);
            settle(800).await;
            if let Some(tab) = crate::pages::machines::tab_widget() {
                shot(&tab, &dir.join(format!("machines-{}-whole-dark.png", crate::pages::machines::tab_name())));
            }
        }
        crate::pages::machines::pick("m-desk");
        settle(800).await;
        shot(&w, &dir.join("machines-other-dark.png"));
        crate::shell::go(crate::shell::Page::Builder);
        for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
            wad_gtk::theme::set(&display, t);
            settle(1000).await;
            shot(&w, &dir.join(format!("builder-{}.png", t.name())));
        }
        crate::shell::go(crate::shell::Page::Secrets);
        for t in [wad_gtk::Theme::Dark, wad_gtk::Theme::Light] {
            wad_gtk::theme::set(&display, t);
            settle(900).await;
            shot(&w, &dir.join(format!("secrets-{}.png", t.name())));
        }
        if let Some(app) = w.application() {
            app.quit();
        }
    });
}

fn shot(w: &impl IsA<gtk::Widget>, path: &std::path::Path) {
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
