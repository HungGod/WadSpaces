//! The WadSpaces HUD: what floats above every window on a machine.
//!
//! - **The bar**, bottom-right: Home (Wad Creator on screen, as Super+0),
//!   Wi-Fi and power. During a focus session they give way to a timer icon
//!   (hover or tap it for the time left).
//! - **Menus** over a dimmed screen: power (restart, shut down) and Wi-Fi
//!   (networks in range, joining one with its password).
//! - **The switcher** (Super+Tab), from wadd's `carousel` events.
//!
//! All are wlr-layer-shell overlays, which sway stacks above normal and
//! fullscreen windows, so they show over whatever wadspace is on screen.
//! Only the Wi-Fi menu takes the keyboard (for a password), and only while
//! it's open. Without layer-shell (a desktop session) they're plain windows.
//!
//! WADSPACES_HUD_SNAPSHOT=<dir> renders each surface to a PNG there and exits.

mod model;
mod theme;
mod thumb;
mod wadd;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use gtk::prelude::*;
use gtk::{gdk, glib};
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use model::{Carousel, Pick, State, WifiNetwork};
use theme::Theme;
use wadd::{Incoming, Wadd};

/// The WadSpaces logo mark for each theme (apps/wadcreator/public/brand), 128 px.
const LOGO_DARK: &[u8] = include_bytes!("../assets/logo-dark.png");
const LOGO_LIGHT: &[u8] = include_bytes!("../assets/logo-light.png");

fn logo(t: Theme) -> Option<gdk::Texture> {
    let bytes = if t == Theme::Light { LOGO_LIGHT } else { LOGO_DARK };
    gdk::Texture::from_bytes(&glib::Bytes::from_static(bytes)).ok()
}

/// A square image drawn at `px` logical pixels (whatever its own size),
/// rounded by the `class` CSS (the box clips it).
fn square_image(texture: &gdk::Texture, px: i32, class: &str) -> gtk::Widget {
    let image = gtk::Image::from_paintable(Some(texture));
    image.set_pixel_size(px);
    let frame = gtk::Box::new(gtk::Orientation::Vertical, 0);
    frame.set_overflow(gtk::Overflow::Hidden);
    frame.set_size_request(px, px);
    frame.set_halign(gtk::Align::Center);
    frame.set_valign(gtk::Align::Center);
    if !class.is_empty() {
        frame.add_css_class(class);
    }
    frame.append(&image);
    frame.upcast()
}

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Runs `work` on a thread, then `done` with its result on the GTK loop.
fn background<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, done: impl FnOnce(T) + 'static) {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(work());
    });
    glib::spawn_future_local(async move {
        if let Ok(v) = rx.recv().await {
            done(v);
        }
    });
}

/// Makes `win` an overlay surface above every window (when the compositor can).
fn layer(win: &gtk::Window, namespace: &str, anchors: &[Edge], fill: bool, keyboard: KeyboardMode) {
    if !gtk4_layer_shell::is_supported() {
        return;
    }
    win.init_layer_shell();
    win.set_layer(Layer::Overlay);
    win.set_namespace(Some(namespace));
    win.set_keyboard_mode(keyboard);
    for &edge in anchors {
        win.set_anchor(edge, true);
        if !fill {
            win.set_margin(edge, 12);
        }
    }
    if fill {
        win.set_exclusive_zone(-1);
    }
}

fn label(text: &str, class: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    if !class.is_empty() {
        l.add_css_class(class);
    }
    l
}

fn button(text: &str, classes: &[&str]) -> gtk::Button {
    let b = gtk::Button::with_label(text);
    for c in classes {
        b.add_css_class(c);
    }
    b
}

/// A full-screen overlay: a dimmed backdrop (a click on it closes) under a
/// centred card.
fn dimmed(
    app: &gtk::Application,
    title: &str,
    namespace: &str,
    keyboard: KeyboardMode,
    card: &gtk::Box,
) -> (gtk::Window, gtk::Button) {
    let win = gtk::Window::builder().application(app).title(title).build();
    layer(&win, namespace, &[Edge::Top, Edge::Bottom, Edge::Left, Edge::Right], true, keyboard);
    if !gtk4_layer_shell::is_supported() {
        win.set_default_size(900, 600);
    }
    let overlay = gtk::Overlay::new();
    let dim = gtk::Button::new();
    dim.add_css_class("dim");
    dim.set_hexpand(true);
    dim.set_vexpand(true);
    overlay.set_child(Some(&dim));
    card.add_css_class("card");
    card.set_halign(gtk::Align::Center);
    card.set_valign(gtk::Align::Center);
    overlay.add_overlay(card);
    win.set_child(Some(&overlay));
    (win, dim)
}

struct Wifi {
    win: gtk::Window,
    status: gtk::Label,
    disconnect: gtk::Button,
    list: gtk::Box,
    scanning: gtk::Label,
    ask: gtk::Box,
    ask_label: gtk::Label,
    password: gtk::PasswordEntry,
    asking: RefCell<Option<String>>,
    error: gtk::Label,
    busy: Cell<bool>,
}

struct Hud {
    wadd: Wadd,
    state: RefCell<State>,
    show_left: Cell<bool>,
    bar: gtk::Window,
    done: gtk::Label,
    timer: gtk::Button,
    home: gtk::Button,
    net: gtk::Button,
    power_button: gtk::Button,
    power: gtk::Window,
    wifi: Wifi,
    switcher: gtk::Window,
    switcher_box: gtk::Box,
    carousel: RefCell<Carousel>,
    icons: RefCell<HashMap<String, Option<gdk::Texture>>>,
    /// The site's colours, dark or light as Wad Creator is.
    theme: Cell<Theme>,
    css: gtk::CssProvider,
    logo: RefCell<Option<gdk::Texture>>,
}

impl Hud {
    fn build(app: &gtk::Application, css: gtk::CssProvider, theme: Theme) -> Rc<Hud> {
        let wadd = Wadd::from_env();

        // The bar.
        let bar = gtk::Window::builder().application(app).title("wadspaces-hud").build();
        layer(&bar, "wadspaces-hud", &[Edge::Bottom, Edge::Right], false, KeyboardMode::None);
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let done = label("Time's up", "pill");
        done.add_css_class("done");
        let timer = button("⏱", &["pill", "focus"]);
        let home = gtk::Button::new();
        home.add_css_class("pill");
        home.add_css_class("logo-button");
        home.set_label("Home"); // until the theme's logo is in (apply_theme)
        home.set_tooltip_text(Some("Back to Wad Creator (Super+0)"));
        let net = button("Wi-Fi", &["pill"]);
        let power_button = button("⏻", &["pill"]);
        power_button.set_tooltip_text(Some("Power"));
        for w in [
            done.upcast_ref::<gtk::Widget>(),
            timer.upcast_ref(),
            home.upcast_ref(),
            net.upcast_ref(),
            power_button.upcast_ref(),
        ] {
            row.append(w);
        }
        bar.set_child(Some(&row));

        // Power.
        let card = gtk::Box::new(gtk::Orientation::Vertical, 10);
        card.append(&label("Power", "title"));
        card.append(&label("Your wadspaces stop; their files stay.", "sub"));
        let restart = button("↻  Restart", &["menu-button"]);
        let shutdown = button("⏻  Shut down", &["menu-button", "danger"]);
        let cancel = button("Cancel", &["menu-button", "quiet"]);
        card.append(&restart);
        card.append(&shutdown);
        card.append(&cancel);
        for l in [&card.first_child().unwrap(), &card.first_child().unwrap().next_sibling().unwrap()] {
            l.set_halign(gtk::Align::Start);
        }
        let (power, power_dim) = dimmed(app, "wadspaces-power", "wadspaces-power", KeyboardMode::None, &card);

        // Wi-Fi.
        let card = gtk::Box::new(gtk::Orientation::Vertical, 10);
        card.set_size_request(420, -1);
        let title = label("Wi-Fi", "title");
        title.set_halign(gtk::Align::Start);
        card.append(&title);
        let status_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        status_row.add_css_class("status");
        let status = label("", "");
        status.set_hexpand(true);
        status.set_halign(gtk::Align::Start);
        let disconnect = button("Disconnect", &["small-button"]);
        status_row.append(&status);
        status_row.append(&disconnect);
        card.append(&status_row);
        let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let section = label("NETWORKS", "section");
        section.set_hexpand(true);
        section.set_halign(gtk::Align::Start);
        let scan = button("Scan", &["small-button"]);
        head.append(&section);
        head.append(&scan);
        card.append(&head);
        let scanning = label("Looking for networks…", "sub");
        card.append(&scanning);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 2);
        let scroller = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .min_content_height(80)
            .max_content_height(300)
            .propagate_natural_height(true)
            .child(&list)
            .build();
        card.append(&scroller);
        let ask = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let ask_label = label("", "sub");
        ask_label.set_halign(gtk::Align::Start);
        let ask_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let password = gtk::PasswordEntry::new();
        password.set_show_peek_icon(true);
        password.set_hexpand(true);
        let join = button("Join", &["small-button", "primary"]);
        ask_row.append(&password);
        ask_row.append(&join);
        ask.append(&ask_label);
        ask.append(&ask_row);
        ask.set_visible(false);
        card.append(&ask);
        let error = label("", "error");
        error.set_wrap(true);
        error.set_halign(gtk::Align::Start);
        error.set_visible(false);
        card.append(&error);
        let close = button("Done", &["menu-button", "quiet"]);
        card.append(&close);
        // The password needs the keyboard: on demand, only while this is open.
        let (wifi_win, wifi_dim) = dimmed(app, "wadspaces-wifi", "wadspaces-wifi", KeyboardMode::OnDemand, &card);

        // The switcher.
        let switcher = gtk::Window::builder().application(app).title("wadspaces-switcher").build();
        layer(&switcher, "wadspaces-switcher", &[], false, KeyboardMode::None);
        let switcher_box = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        switcher_box.add_css_class("switcher");
        switcher.set_child(Some(&switcher_box));

        let hud = Rc::new(Hud {
            wadd,
            state: RefCell::default(),
            show_left: Cell::new(false),
            bar,
            done,
            timer,
            home,
            net,
            power_button,
            power,
            wifi: Wifi {
                win: wifi_win,
                status,
                disconnect,
                list,
                scanning,
                ask,
                ask_label,
                password,
                asking: RefCell::default(),
                error,
                busy: Cell::new(false),
            },
            switcher,
            switcher_box,
            carousel: RefCell::default(),
            icons: RefCell::default(),
            theme: Cell::new(theme),
            css,
            logo: RefCell::default(),
        });
        hud.apply_theme(theme);

        // Wiring.
        let h = hud.clone();
        hud.timer.connect_clicked(move |_| {
            h.show_left.set(!h.show_left.get());
            h.update_bar();
        });
        let h = hud.clone();
        hud.home.connect_clicked(move |_| {
            let w = h.wadd.clone();
            background(move || w.home(), |r| report(r, "Home"));
        });
        let h = hud.clone();
        hud.net.connect_clicked(move |_| h.open_wifi());
        let h = hud.clone();
        hud.power_button.connect_clicked(move |_| h.power.present());
        for (b, action) in [(&restart, "reboot"), (&shutdown, "poweroff")] {
            let h = hud.clone();
            b.connect_clicked(move |_| {
                h.power.set_visible(false);
                let w = h.wadd.clone();
                background(move || w.power(action), |r| report(r, "Power"));
            });
        }
        for b in [&cancel, &power_dim] {
            let h = hud.clone();
            b.connect_clicked(move |_| h.power.set_visible(false));
        }
        for b in [&close, &wifi_dim] {
            let h = hud.clone();
            b.connect_clicked(move |_| h.close_wifi());
        }
        let h = hud.clone();
        scan.connect_clicked(move |_| h.scan());
        let h = hud.clone();
        hud.wifi.disconnect.connect_clicked(move |_| {
            let w = h.wadd.clone();
            let h2 = h.clone();
            background(
                move || w.wifi_disconnect(),
                move |r| match r {
                    Ok(()) => h2.scan(),
                    Err(e) => h2.wifi_error(&e),
                },
            );
        });
        let h = hud.clone();
        join.connect_clicked(move |_| h.join_asked());
        let h = hud.clone();
        hud.wifi.password.connect_activate(move |_| h.join_asked());

        hud.update_bar();
        hud.bar.present();
        hud
    }

    // -------------------------------------------------------------- theme
    /// Colours and logos for `t`.
    fn apply_theme(self: &Rc<Self>, t: Theme) {
        self.theme.set(t);
        self.css.load_from_string(&theme::css(t));
        let l = logo(t);
        match &l {
            Some(tex) => self.home.set_child(Some(&square_image(tex, 18, ""))),
            None => self.home.set_label("Home"),
        }
        self.logo.replace(l);
        if self.switcher.is_visible() {
            self.show_switcher();
        }
    }

    /// Follows Wad Creator's theme file (it rewrites it when you switch).
    fn follow_theme(self: &Rc<Self>) -> Option<gtk::gio::FileMonitor> {
        let path = theme::file();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let monitor = gtk::gio::File::for_path(&path)
            .monitor_file(gtk::gio::FileMonitorFlags::WATCH_MOVES, None::<&gtk::gio::Cancellable>)
            .ok()?;
        let h = self.clone();
        monitor.connect_changed(move |_, _, _, _| {
            let t = theme::current();
            if t != h.theme.get() {
                eprintln!("hud: theme {t:?}");
                h.apply_theme(t);
            }
        });
        Some(monitor)
    }

    // ---------------------------------------------------------------- bar
    fn update_bar(&self) {
        let st = self.state.borrow();
        let session = st.session.as_ref();
        let focus = model::locked(session);
        self.timer.set_visible(focus);
        for w in [&self.home, &self.power_button] {
            w.set_visible(!focus);
        }
        self.done.set_visible(session.is_some_and(|s| s.expired));
        if let Some(s) = session.filter(|_| focus) {
            let text = model::focus_left(s, now());
            self.timer.set_tooltip_text(Some(&text));
            self.timer.set_label(&if self.show_left.get() { format!("⏱  {text}") } else { "⏱".into() });
        }
        match model::network_label(st.network.as_ref()) {
            Some((text, online)) if !focus => {
                self.net.set_visible(true);
                self.net.set_label(&text);
                if online { self.net.remove_css_class("offline") } else { self.net.add_css_class("offline") }
            }
            _ => self.net.set_visible(false),
        }
        if let Some(n) = &st.network {
            let text = match (&n.ssid, n.connectivity.as_deref()) {
                (Some(s), Some("full")) if !s.is_empty() => format!("Connected to {s}"),
                (Some(s), _) if !s.is_empty() => format!("{s}: no internet yet"),
                (_, Some("full")) => "Connected (wired)".into(),
                _ => "Not connected: pick a network".into(),
            };
            self.wifi.status.set_label(&text);
            self.wifi.disconnect.set_visible(n.ssid.as_ref().is_some_and(|s| !s.is_empty()));
        }
    }

    // --------------------------------------------------------------- Wi-Fi
    fn open_wifi(self: &Rc<Self>) {
        self.wifi.error.set_visible(false);
        self.wifi.ask.set_visible(false);
        self.wifi.asking.replace(None);
        self.wifi.win.present();
        self.scan();
    }

    fn close_wifi(&self) {
        self.wifi.password.set_text("");
        self.wifi.win.set_visible(false);
    }

    fn wifi_error(&self, e: &str) {
        self.wifi.error.set_label(&model::join_error(e));
        self.wifi.error.set_visible(true);
    }

    fn scan(self: &Rc<Self>) {
        self.wifi.scanning.set_visible(true);
        let w = self.wadd.clone();
        let h = self.clone();
        background(
            move || w.wifi_scan(),
            move |r| {
                h.wifi.scanning.set_visible(false);
                match r {
                    Ok(list) => h.show_networks(&list),
                    Err(e) => h.wifi_error(&e),
                }
            },
        );
    }

    fn show_networks(self: &Rc<Self>, list: &[WifiNetwork]) {
        while let Some(c) = self.wifi.list.first_child() {
            self.wifi.list.remove(&c);
        }
        if list.is_empty() {
            self.wifi.list.append(&label("No networks in range.", "sub"));
        }
        for n in list {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
            let bars = label(model::bars(n.signal), "bars");
            bars.set_xalign(0.0);
            row.append(&bars);
            let name = label(&n.ssid, "");
            name.set_hexpand(true);
            name.set_halign(gtk::Align::Start);
            name.set_ellipsize(gtk::pango::EllipsizeMode::End);
            row.append(&name);
            let tag = if n.active {
                "connected"
            } else if !n.supported {
                "can't join"
            } else if n.known {
                "saved"
            } else if n.secure {
                "secured"
            } else {
                "open"
            };
            row.append(&label(tag, "tag"));
            let b = gtk::Button::new();
            b.set_child(Some(&row));
            b.add_css_class("net-row");
            if n.active {
                b.add_css_class("active");
            }
            let h = self.clone();
            let net = n.clone();
            b.connect_clicked(move |_| h.pick(&net));
            self.wifi.list.append(&b);
        }
    }

    fn pick(self: &Rc<Self>, n: &WifiNetwork) {
        if self.wifi.busy.get() {
            return;
        }
        self.wifi.error.set_visible(false);
        match model::pick(n) {
            Pick::Nothing => {}
            Pick::Refuse(why) => self.wifi_error(&why),
            Pick::AskPassword => {
                self.wifi.asking.replace(Some(n.ssid.clone()));
                self.wifi.ask_label.set_label(&format!("Password for {}", n.ssid));
                self.wifi.password.set_text("");
                self.wifi.ask.set_visible(true);
                self.wifi.password.grab_focus();
            }
            Pick::Join => self.join(&n.ssid, None),
        }
    }

    fn join_asked(self: &Rc<Self>) {
        let Some(ssid) = self.wifi.asking.borrow().clone() else { return };
        let pw = self.wifi.password.text().to_string();
        if pw.len() < 8 {
            return self.wifi_error("Wi-Fi passwords are at least 8 characters.");
        }
        self.join(&ssid, Some(pw));
    }

    fn join(self: &Rc<Self>, ssid: &str, password: Option<String>) {
        self.wifi.busy.set(true);
        self.wifi.scanning.set_label(&format!("Joining {ssid}…"));
        self.wifi.scanning.set_visible(true);
        let w = self.wadd.clone();
        let h = self.clone();
        let ssid = ssid.to_string();
        background(
            move || w.wifi_connect(&ssid, password.as_deref()),
            move |r| {
                h.wifi.busy.set(false);
                h.wifi.scanning.set_label("Looking for networks…");
                h.wifi.scanning.set_visible(false);
                match r {
                    Ok(()) => {
                        h.wifi.ask.set_visible(false);
                        h.wifi.asking.replace(None);
                        h.wifi.password.set_text("");
                        h.scan();
                    }
                    Err(e) if e.to_lowercase().contains("password required") => {
                        h.wifi.ask.set_visible(true);
                        h.wifi.password.grab_focus();
                    }
                    Err(e) => h.wifi_error(&e),
                }
            },
        );
    }

    // ------------------------------------------------------------ switcher
    fn show_switcher(self: &Rc<Self>) {
        let c = self.carousel.borrow().clone();
        if !c.open || c.items.is_empty() {
            self.switcher.set_visible(false);
            return;
        }
        while let Some(child) = self.switcher_box.first_child() {
            self.switcher_box.remove(&child);
        }
        for (i, item) in c.items.iter().enumerate() {
            let cell = gtk::Box::new(gtk::Orientation::Vertical, 0);
            cell.add_css_class("item");
            if i == c.index {
                cell.add_css_class("selected");
            }
            // Wad Creator (wadd's "launcher" view) is the WadSpaces logo.
            let texture = if item.view == "launcher" {
                self.logo.borrow().clone()
            } else {
                item.icon.as_ref().and_then(|p| self.icon(p))
            };
            let face: gtk::Widget = match texture {
                Some(t) => square_image(&t, 64, "icon"),
                None => {
                    let initial = label(
                        &item.name.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default(),
                        "icon",
                    );
                    initial.set_halign(gtk::Align::Center);
                    initial.upcast()
                }
            };
            cell.append(&face);
            let name = label(&item.name, "name");
            name.set_max_width_chars(16);
            name.set_ellipsize(gtk::pango::EllipsizeMode::End);
            cell.append(&name);
            if !item.running {
                cell.append(&label("not running", "state"));
            }
            self.switcher_box.append(&cell);
        }
        self.switcher.present();
    }

    /// A workspace's icon: from the cache, else fetched (the switcher redraws when it arrives).
    fn icon(self: &Rc<Self>, path: &str) -> Option<gdk::Texture> {
        if let Some(t) = self.icons.borrow().get(path) {
            return t.clone();
        }
        self.icons.borrow_mut().insert(path.into(), None);
        let w = self.wadd.clone();
        let h = self.clone();
        let p = path.to_string();
        // Fetched and shrunk off the GTK loop: icons are often whole wallpapers.
        background(
            move || w.bytes(&p).and_then(|b| thumb::thumbnail(&b, 128)).map(|b| (p, b)),
            move |r| {
                if let Some((p, bytes)) = r
                    && let Ok(t) = gdk::Texture::from_bytes(&glib::Bytes::from(&bytes))
                {
                    h.icons.borrow_mut().insert(p, Some(t));
                    if h.switcher.is_visible() {
                        h.show_switcher();
                    }
                }
            },
        );
        None
    }

    // -------------------------------------------------------------- events
    fn on_event(self: &Rc<Self>, ev: Incoming) {
        match ev {
            Incoming::Event(name, data) if name == "state" => {
                if let Ok(s) = serde_json::from_value::<State>(data) {
                    if !model::locked(s.session.as_ref()) {
                        self.show_left.set(false);
                    }
                    self.state.replace(s);
                    self.update_bar();
                }
            }
            Incoming::Event(name, data) if name == "carousel" => {
                self.carousel.replace(serde_json::from_value(data).unwrap_or_default());
                self.show_switcher();
            }
            // The old way the bar opened Wad Creator's menus: only power
            // and Wi-Fi asked, and both are here now.
            Incoming::Event(..) => {}
            Incoming::Disconnected => {
                self.carousel.replace(Carousel::default());
                self.switcher.set_visible(false);
            }
        }
    }
}

fn report(r: Result<(), String>, what: &str) {
    if let Err(e) = r {
        eprintln!("hud: {what}: {e}");
    }
}

/// Renders a window's contents to a PNG.
fn save_png(win: &gtk::Window, path: &std::path::Path) {
    let (w, h) = (win.width(), win.height());
    let paintable = gtk::WidgetPaintable::new(Some(win));
    let snap = gtk::Snapshot::new();
    paintable.snapshot(&snap, w as f64, h as f64);
    let (Some(node), Some(native)) = (snap.to_node(), win.native()) else { return };
    let texture = native.renderer().map(|r| r.render_texture(node, None));
    if let Some(t) = texture
        && t.save_to_png(path).is_ok()
    {
        println!("hud: wrote {}", path.display());
    }
}

fn snapshot(hud: Rc<Hud>, app: gtk::Application, dir: std::path::PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    // WADSPACES_HUD_SNAPSHOT_ICON: an image file to show as Writing's icon.
    if let Some(bytes) = std::env::var_os("WADSPACES_HUD_SNAPSHOT_ICON").and_then(|p| std::fs::read(p).ok())
        && let Some(t) =
            thumb::thumbnail(&bytes, 128).and_then(|b| gdk::Texture::from_bytes(&glib::Bytes::from(&b)).ok())
    {
        hud.icons.borrow_mut().insert("/api/icons/writing".into(), Some(t));
    }
    hud.state.replace(State {
        session: None,
        network: Some(model::Network {
            available: true,
            connectivity: Some("full".into()),
            ssid: Some("Home Network".into()),
        }),
    });
    hud.update_bar();
    hud.power.present();
    hud.wifi.win.present();
    hud.show_networks(&[
        WifiNetwork {
            ssid: "Home Network".into(),
            signal: 82,
            security: "WPA2".into(),
            secure: true,
            supported: true,
            active: true,
            known: true,
        },
        WifiNetwork {
            ssid: "Cafe Guest".into(),
            signal: 54,
            security: String::new(),
            secure: false,
            supported: true,
            active: false,
            known: false,
        },
        WifiNetwork {
            ssid: "Neighbours".into(),
            signal: 30,
            security: "WPA2".into(),
            secure: true,
            supported: true,
            active: false,
            known: false,
        },
        WifiNetwork {
            ssid: "Office 802.1X".into(),
            signal: 40,
            security: "WPA2 802.1X".into(),
            secure: true,
            supported: false,
            active: false,
            known: false,
        },
    ]);
    hud.wifi.scanning.set_visible(false);
    hud.pick(&WifiNetwork {
        ssid: "Neighbours".into(),
        signal: 30,
        security: "WPA2".into(),
        secure: true,
        supported: true,
        active: false,
        known: false,
    });
    hud.carousel.replace(Carousel {
        open: true,
        index: 1,
        items: vec![
            model::CarouselItem {
                view: "workspace:writing".into(),
                name: "Writing".into(),
                icon: Some("/api/icons/writing".into()),
                running: true,
            },
            model::CarouselItem { view: "launcher".into(), name: "Wad Creator".into(), icon: None, running: true },
            model::CarouselItem {
                view: "workspace:iq-dev".into(),
                name: "IntelligenceQuest Dev".into(),
                icon: None,
                running: false,
            },
        ],
    });
    hud.show_switcher();
    glib::timeout_add_local_once(std::time::Duration::from_millis(800), move || {
        for (win, name) in
            [(&hud.bar, "bar"), (&hud.power, "power"), (&hud.wifi.win, "wifi"), (&hud.switcher, "switcher")]
        {
            save_png(win, &dir.join(format!("{name}.png")));
        }
        hud.state.borrow_mut().session = Some(model::Session {
            mode: "focus".into(),
            minutes: Some(25.0),
            ends_at: Some(now() + 1500.0),
            expired: false,
        });
        hud.show_left.set(true);
        hud.update_bar();
        glib::timeout_add_local_once(std::time::Duration::from_millis(300), move || {
            save_png(&hud.bar, &dir.join("bar-focus.png"));
            app.quit();
        });
    });
}

fn main() -> glib::ExitCode {
    let app = gtk::Application::builder().application_id("io.wadspaces.hud").build();
    app.connect_activate(|app| {
        let css = gtk::CssProvider::new();
        if let Some(display) = gdk::Display::default() {
            gtk::style_context_add_provider_for_display(&display, &css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
        let hud = Hud::build(app, css, theme::current());
        if let Some(dir) = std::env::var_os("WADSPACES_HUD_SNAPSHOT") {
            let _hold = app.hold();
            snapshot(hud, app.clone(), dir.into());
            std::mem::forget(_hold);
            return;
        }
        // Kept for as long as the HUD runs.
        std::mem::forget(hud.follow_theme());
        let (tx, rx) = async_channel::unbounded();
        hud.wadd.follow(tx);
        let h = hud.clone();
        glib::spawn_future_local(async move {
            while let Ok(ev) = rx.recv().await {
                h.on_event(ev);
            }
        });
        // The focus timer counts down.
        let h = hud.clone();
        glib::timeout_add_seconds_local(1, move || {
            if model::locked(h.state.borrow().session.as_ref()) {
                h.update_bar();
            }
            glib::ControlFlow::Continue
        });
    });
    app.run_with_args::<&str>(&[])
}
