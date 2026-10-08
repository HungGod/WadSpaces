//! The WadSpaces HUD: what floats above every window on a machine.
//!
//! - **The bar**, bottom-right: Home (WadSpaces Client on screen, as Super+0),
//!   Wi-Fi, brightness and volume, power and the clock. During a focus
//!   session Home, Wi-Fi and power give way to a timer icon (hover or tap it
//!   for the time left). Its › tucks it away, leaving only an arrow that
//!   brings it back (remembered, prefs.rs).
//! - **Menus** over a dimmed screen: power (restart, shut down) and Wi-Fi
//!   (networks in range, joining one with its password). Brightness and
//!   volume are a panel over the corner, the screen left undimmed.
//! - **The switcher** (Super+Tab), from wadd's `carousel` events.
//! - **The clipboard history** (Super+V, wadd's `shortcut` event): the
//!   machine's copies from every wadspace (wad-clip), one picked to paste.
//!   The HUD also keeps the latest copy alive when whoever copied it goes.
//!
//! All are wlr-layer-shell overlays, which sway stacks above normal and
//! fullscreen windows, so they show over whatever wadspace is on screen.
//! Only the Wi-Fi menu (for a password) and the clipboard history (arrows,
//! Enter, Esc) take the keyboard, and only while open. Without layer-shell
//! (a desktop session) they're plain windows.
//!
//! WADSPACES_HUD_SNAPSHOT=<dir> renders each surface to a PNG there and exits.

mod audio;
mod clips;
mod model;
mod power;
mod prefs;
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
use wad_clip::{Change, Content};
use wadd::{Incoming, Wadd};

/// The WadSpaces logo mark for each theme (apps/client/public/brand), 128 px.
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

/// wadd never sets the backlight lower (apps/wadd/src/screen.rs).
const BRIGHTNESS_FLOOR: f64 = 5.0;

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

#[derive(Clone, Copy, PartialEq)]
enum Place {
    /// Centred over a dimmed screen (a menu).
    Centre,
    /// Over the bar's corner, the screen left as it is (brightness must be
    /// judged by eye).
    Corner,
}

/// A full-screen overlay: a backdrop (a click on it closes) under a card.
fn dimmed(
    app: &gtk::Application,
    title: &str,
    namespace: &str,
    keyboard: KeyboardMode,
    card: &gtk::Box,
    place: Place,
) -> (gtk::Window, gtk::Button) {
    let win = gtk::Window::builder().application(app).title(title).build();
    layer(&win, namespace, &[Edge::Top, Edge::Bottom, Edge::Left, Edge::Right], true, keyboard);
    if !gtk4_layer_shell::is_supported() {
        win.set_default_size(900, 600);
    }
    let overlay = gtk::Overlay::new();
    let dim = gtk::Button::new();
    dim.add_css_class(if place == Place::Corner { "catcher" } else { "dim" });
    dim.set_hexpand(true);
    dim.set_vexpand(true);
    overlay.set_child(Some(&dim));
    card.add_css_class("card");
    match place {
        Place::Centre => {
            card.set_halign(gtk::Align::Center);
            card.set_valign(gtk::Align::Center);
        }
        Place::Corner => {
            card.set_halign(gtk::Align::End);
            card.set_valign(gtk::Align::End);
            card.set_margin_end(12);
            card.set_margin_bottom(56);
        }
    }
    overlay.add_overlay(card);
    win.set_child(Some(&overlay));
    (win, dim)
}

/// Slider moves, sent one at a time: while one is on its way, only the
/// latest waits behind it.
#[derive(Default)]
struct Throttle {
    pending: Cell<Option<u8>>,
    busy: Cell<bool>,
}

impl Throttle {
    fn send(self: &Rc<Self>, wadd: &Wadd, value: u8, work: fn(&Wadd, u8) -> Result<(), String>) {
        self.pending.set(Some(value));
        if self.busy.get() {
            return;
        }
        let Some(v) = self.pending.take() else { return };
        self.busy.set(true);
        let (w, me, again) = (wadd.clone(), self.clone(), wadd.clone());
        background(
            move || work(&w, v),
            move |r| {
                report(r, "slider");
                me.busy.set(false);
                if let Some(next) = me.pending.take() {
                    me.send(&again, next, work);
                }
            },
        );
    }
}

/// One of Adwaita's symbolic icons, coloured by the theme like the text.
fn icon(name: &str, px: i32) -> gtk::Image {
    let i = gtk::Image::from_icon_name(name);
    i.set_pixel_size(px);
    i
}

const BRIGHTNESS_ICON: &str = "display-brightness-symbolic";

/// A bubble on the bar holding just an icon.
fn icon_pill(image: &gtk::Image, tooltip: &str) -> gtk::Button {
    let b = gtk::Button::new();
    b.set_child(Some(image));
    b.add_css_class("pill");
    b.add_css_class("icon-pill");
    b.set_tooltip_text(Some(tooltip));
    b
}

/// A slider panel over the corner: brightness, or volume.
struct Level {
    win: gtk::Window,
    row: gtk::Box,
    scale: gtk::Scale,
    value: gtk::Label,
    /// Why it can't be set here (shown instead of the slider).
    why: gtk::Label,
    send: Rc<Throttle>,
}

impl Level {
    /// `lead`: the icon before the slider (the mute button, for volume).
    fn build(app: &gtk::Application, namespace: &str, lead: &gtk::Widget, min: f64) -> (Level, gtk::Button) {
        let card = gtk::Box::new(gtk::Orientation::Vertical, 8);
        card.add_css_class("level");
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        row.add_css_class("slider-row");
        let scale = gtk::Scale::with_range(gtk::Orientation::Horizontal, min, 100.0, 1.0);
        scale.set_draw_value(false);
        scale.set_hexpand(true);
        scale.set_size_request(220, -1);
        let value = label("", "value");
        value.set_width_chars(4);
        value.set_xalign(1.0);
        row.append(lead);
        row.append(&scale);
        row.append(&value);
        let why = label("", "sub");
        why.set_wrap(true);
        why.set_max_width_chars(34);
        why.set_xalign(0.0);
        why.set_visible(false);
        card.append(&row);
        card.append(&why);
        let (win, dim) = dimmed(app, namespace, namespace, KeyboardMode::None, &card, Place::Corner);
        (Level { win, row, scale, value, why, send: Rc::default() }, dim)
    }

    /// What it is now, or why it can't be set.
    fn show(&self, now: Result<u8, String>, syncing: &Cell<bool>) {
        self.row.set_visible(now.is_ok());
        self.why.set_visible(now.is_err());
        match now {
            Ok(p) => {
                syncing.set(true);
                self.scale.set_value(p as f64);
                syncing.set(false);
                self.value.set_label(&format!("{p}%"));
            }
            Err(why) => self.why.set_label(&why),
        }
    }
}

/// The bubble a brightness or volume key shows for a moment.
struct Osd {
    win: gtk::Window,
    icon: gtk::Image,
    bar: gtk::ProgressBar,
    value: gtk::Label,
    hide: RefCell<Option<glib::SourceId>>,
}

/// The bar's tooltips, drawn above it. GTK's own open below their widget,
/// which for a bar on the bottom edge is off the screen (sway doesn't flip
/// a layer surface's popups), so the bar's widgets have no GTK tooltip: their
/// text is the HUD's (`Hud::set_tip`), which this shows.
struct Tip {
    win: gtk::Window,
    card: gtk::Box,
    text: gtk::Label,
    /// The hover's delay.
    pending: RefCell<Option<glib::SourceId>>,
    /// Whose tip is on screen.
    showing: Cell<Option<usize>>,
}

fn tip_key(w: &impl IsA<gtk::Widget>) -> usize {
    w.as_ref().as_ptr() as usize
}

/// Key presses, run one at a time: presses that come meanwhile add up.
#[derive(Default)]
struct Steps {
    pending: Cell<i32>,
    busy: Cell<bool>,
}

/// Why brightness or volume can't be set, in words.
const NO_BRIGHTNESS: &str = "This screen's brightness can't be set from here.";
const NO_SOUND: &str = "No sound output found.";

struct Clip {
    win: gtk::Window,
    list: gtk::ListBox,
    empty: gtk::Label,
    clear: gtk::Button,
    history: RefCell<clips::History>,
    /// sway's clipboard (None: no wlr-data-control, or a snapshot).
    board: RefCell<Option<wad_clip::Clipboard>>,
    /// The clipboard now is the history's latest (not a password).
    current_kept: Cell<bool>,
}

/// From the clipboard's threads to the GTK loop.
enum ClipEvent {
    Copied(Content, Option<Vec<u8>>),
    Cleared,
    Closed(String),
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
    row: gtk::Box,
    done: gtk::Label,
    timer: gtk::Button,
    home: gtk::Button,
    net: gtk::Button,
    bright_button: gtk::Button,
    sound_button: gtk::Button,
    sound_icon: gtk::Image,
    power_button: gtk::Button,
    clock: gtk::Label,
    battery: gtk::Box,
    battery_icon: gtk::Image,
    battery_text: gtk::Label,
    /// The arrow left when the bar is tucked away.
    expand: gtk::Button,
    power: gtk::Window,
    wifi: Wifi,
    bright: Level,
    sound: Level,
    mute: gtk::Button,
    mute_icon: gtk::Image,
    /// The volume as last heard (None: no sound output).
    volume: Cell<Option<audio::Volume>>,
    /// Set while the HUD moves a slider itself (not a person's change).
    syncing: Cell<bool>,
    osd: Osd,
    tip: Tip,
    /// The bar's tooltips, by widget (they're not GTK's: see Tip).
    tips: RefCell<HashMap<usize, String>>,
    bright_steps: Rc<Steps>,
    sound_steps: Rc<Steps>,
    clip: Clip,
    switcher: gtk::Window,
    switcher_box: gtk::Box,
    carousel: RefCell<Carousel>,
    icons: RefCell<HashMap<String, Option<gdk::Texture>>>,
    /// The site's colours, dark or light as WadSpaces Client is.
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
        let outer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let done = label("Time's up", "pill");
        done.add_css_class("done");
        let timer = button("⏱", &["pill", "focus"]);
        let home = gtk::Button::new();
        home.add_css_class("pill");
        home.add_css_class("logo-button");
        home.set_label("Home"); // until the theme's logo is in (apply_theme)
        home.set_tooltip_text(Some("Back to WadSpaces (Super+0)"));
        let net = button("Wi-Fi", &["pill"]);
        net.set_tooltip_text(Some("Networks"));
        let bright_button = icon_pill(&icon(BRIGHTNESS_ICON, 16), "Brightness");
        let sound_icon = icon(audio::icon(None), 16);
        let sound_button = icon_pill(&sound_icon, "Volume");
        let power_button = icon_pill(&icon("system-shutdown-symbolic", 16), "Power");
        let clock = label("", "pill");
        clock.add_css_class("clock");
        // The battery: hidden until there is one (power.rs), as on a desktop.
        let battery = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        battery.add_css_class("pill");
        battery.add_css_class("battery");
        let battery_icon = icon("battery-missing-symbolic", 16);
        let battery_text = label("", "");
        battery.append(&battery_icon);
        battery.append(&battery_text);
        battery.set_visible(false);
        let collapse = button("›", &["pill", "arrow"]);
        collapse.set_tooltip_text(Some("Hide the bar"));
        for w in [
            done.upcast_ref::<gtk::Widget>(),
            timer.upcast_ref(),
            home.upcast_ref(),
            net.upcast_ref(),
            bright_button.upcast_ref(),
            sound_button.upcast_ref(),
            power_button.upcast_ref(),
            battery.upcast_ref(),
            clock.upcast_ref(),
            collapse.upcast_ref(),
        ] {
            row.append(w);
        }
        let expand = button("‹", &["pill", "arrow"]);
        expand.set_tooltip_text(Some("Show the bar"));
        expand.set_visible(false);
        outer.append(&row);
        outer.append(&expand);
        bar.set_child(Some(&outer));

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
        let (power, power_dim) =
            dimmed(app, "wadspaces-power", "wadspaces-power", KeyboardMode::None, &card, Place::Centre);

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
        let (wifi_win, wifi_dim) =
            dimmed(app, "wadspaces-wifi", "wadspaces-wifi", KeyboardMode::OnDemand, &card, Place::Centre);

        // Brightness and volume: a panel each, over the corner.
        let sun = icon(BRIGHTNESS_ICON, 18);
        sun.add_css_class("slider-icon");
        let (bright, bright_dim) = Level::build(app, "wadspaces-brightness", sun.upcast_ref(), BRIGHTNESS_FLOOR);
        let mute_icon = icon(audio::icon(None), 18);
        let mute = gtk::Button::new();
        mute.set_child(Some(&mute_icon));
        mute.add_css_class("small-button");
        mute.add_css_class("slider-icon");
        mute.set_tooltip_text(Some("Mute"));
        let (sound, sound_dim) = Level::build(app, "wadspaces-volume", mute.upcast_ref(), 0.0);

        // What a brightness or volume key shows: the level, for a moment.
        let osd_win = gtk::Window::builder().application(app).title("wadspaces-level").build();
        layer(&osd_win, "wadspaces-level", &[Edge::Bottom, Edge::Right], false, KeyboardMode::None);
        if gtk4_layer_shell::is_supported() {
            osd_win.set_margin(Edge::Bottom, 56);
        }
        let osd_box = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        osd_box.add_css_class("card");
        osd_box.add_css_class("osd");
        let osd_icon = icon(BRIGHTNESS_ICON, 20);
        let osd_bar = gtk::ProgressBar::new();
        osd_bar.set_size_request(180, -1);
        osd_bar.set_valign(gtk::Align::Center);
        let osd_value = label("", "value");
        osd_value.set_width_chars(4);
        osd_value.set_xalign(1.0);
        osd_box.append(&osd_icon);
        osd_box.append(&osd_bar);
        osd_box.append(&osd_value);
        osd_win.set_child(Some(&osd_box));

        // The clipboard history.
        let card = gtk::Box::new(gtk::Orientation::Vertical, 10);
        card.set_size_request(460, -1);
        let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let title = label("Clipboard", "title");
        title.set_hexpand(true);
        title.set_halign(gtk::Align::Start);
        let clear = button("Clear all", &["small-button"]);
        head.append(&title);
        head.append(&clear);
        card.append(&head);
        let sub = label("Copies from every wadspace. Pick one, then paste it with Ctrl+V.", "sub");
        sub.set_halign(gtk::Align::Start);
        sub.set_wrap(true);
        card.append(&sub);
        let empty = label("Nothing copied yet.", "sub");
        empty.add_css_class("empty");
        card.append(&empty);
        let clip_list = gtk::ListBox::new();
        clip_list.add_css_class("clips");
        clip_list.set_selection_mode(gtk::SelectionMode::Browse);
        let scroller = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .max_content_height(440)
            .propagate_natural_height(true)
            .child(&clip_list)
            .build();
        card.append(&scroller);
        let clip_done = button("Done", &["menu-button", "quiet"]);
        card.append(&clip_done);
        // The keyboard while it's open: arrows, Enter, Delete, Esc.
        let (clip_win, clip_dim) =
            dimmed(app, "wadspaces-clipboard", "wadspaces-clipboard", KeyboardMode::Exclusive, &card, Place::Centre);

        // The switcher.
        let switcher = gtk::Window::builder().application(app).title("wadspaces-switcher").build();
        layer(&switcher, "wadspaces-switcher", &[], false, KeyboardMode::None);
        let switcher_box = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        switcher_box.add_css_class("switcher");
        switcher.set_child(Some(&switcher_box));

        // The bar's tooltips, above it: made last, so sway stacks them over
        // every other overlay.
        let tip_win = gtk::Window::builder().application(app).title("wadspaces-tip").build();
        layer(&tip_win, "wadspaces-tip", &[Edge::Bottom, Edge::Right], false, KeyboardMode::None);
        let tip_card = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        tip_card.add_css_class("tip");
        // One line (they're short): its natural width is its width, so the
        // centring in tip_show() is exact.
        let tip_text = label("", "");
        tip_card.append(&tip_text);
        tip_win.set_child(Some(&tip_card));

        let hud = Rc::new(Hud {
            wadd,
            state: RefCell::default(),
            show_left: Cell::new(false),
            bar,
            row,
            done,
            timer,
            home,
            net,
            bright_button,
            sound_button,
            sound_icon,
            power_button,
            clock,
            battery,
            battery_icon,
            battery_text,
            expand,
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
            bright,
            sound,
            mute,
            mute_icon,
            volume: Cell::new(None),
            syncing: Cell::new(false),
            osd: Osd { win: osd_win, icon: osd_icon, bar: osd_bar, value: osd_value, hide: RefCell::default() },
            tip: Tip {
                win: tip_win,
                card: tip_card,
                text: tip_text,
                pending: RefCell::default(),
                showing: Cell::new(None),
            },
            tips: RefCell::default(),
            bright_steps: Rc::default(),
            sound_steps: Rc::default(),
            clip: Clip {
                win: clip_win,
                list: clip_list,
                empty,
                clear,
                history: RefCell::default(),
                board: RefCell::default(),
                current_kept: Cell::new(false),
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

        for w in [
            hud.timer.upcast_ref::<gtk::Widget>(),
            hud.home.upcast_ref(),
            hud.net.upcast_ref(),
            hud.bright_button.upcast_ref(),
            hud.sound_button.upcast_ref(),
            hud.power_button.upcast_ref(),
            hud.battery.upcast_ref(),
            hud.clock.upcast_ref(),
            collapse.upcast_ref(),
            hud.expand.upcast_ref(),
        ] {
            hud.hover_tip(w);
        }
        let h = hud.clone();
        collapse.connect_clicked(move |_| h.set_collapsed(true, true));
        let h = hud.clone();
        hud.expand.connect_clicked(move |_| h.set_collapsed(false, true));

        let h = hud.clone();
        hud.bright_button.connect_clicked(move |_| h.open_brightness());
        let h = hud.clone();
        hud.sound_button.connect_clicked(move |_| h.open_volume());
        let h = hud.clone();
        bright_dim.connect_clicked(move |_| h.bright.win.set_visible(false));
        let h = hud.clone();
        sound_dim.connect_clicked(move |_| h.sound.win.set_visible(false));
        let h = hud.clone();
        hud.bright.scale.connect_value_changed(move |s| {
            let v = s.value().round() as u8;
            h.bright.value.set_label(&format!("{v}%"));
            if !h.syncing.get() {
                h.bright.send.send(&h.wadd, v, |w, p| w.set_brightness(p).map(|_| ()));
            }
        });
        let h = hud.clone();
        hud.sound.scale.connect_value_changed(move |s| {
            let v = s.value().round() as u8;
            h.sound.value.set_label(&format!("{v}%"));
            if !h.syncing.get() {
                // Moving it unmutes (audio::set).
                h.show_volume(Some(audio::Volume { percent: v, muted: false }));
                h.sound.send.send(&h.wadd, v, |_, p| audio::set(p));
            }
        });
        let h = hud.clone();
        hud.mute.connect_clicked(move |_| {
            let Some(v) = h.volume.get() else { return };
            let muted = !v.muted;
            let h2 = h.clone();
            background(
                move || audio::set_muted(muted),
                move |r| match r {
                    Ok(()) => h2.show_volume(Some(audio::Volume { muted, ..v })),
                    Err(e) => eprintln!("hud: mute: {e}"),
                },
            );
        });

        for b in [&clip_done, &clip_dim] {
            let h = hud.clone();
            b.connect_clicked(move |_| h.close_clips());
        }
        let h = hud.clone();
        hud.clip.clear.connect_clicked(move |_| {
            h.clip.history.borrow_mut().clear();
            // What's copied now stays copied, but isn't kept alive any more.
            h.clip.current_kept.set(false);
            h.fill_clips();
        });
        let h = hud.clone();
        hud.clip.list.connect_row_activated(move |_, row| {
            if let Ok(id) = row.widget_name().parse() {
                h.pick_clip(id);
            }
        });
        let keys = gtk::EventControllerKey::new();
        let h = hud.clone();
        keys.connect_key_pressed(move |_, key, _, _| match key {
            gdk::Key::Escape => {
                h.close_clips();
                glib::Propagation::Stop
            }
            gdk::Key::Delete | gdk::Key::BackSpace => {
                if let Some(id) = h.clip.list.selected_row().and_then(|r| r.widget_name().parse().ok()) {
                    h.forget_clip(id);
                }
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
        hud.clip.win.add_controller(keys);

        hud.update_bar();
        hud.tick();
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

    /// Follows WadSpaces Client's theme file (it rewrites it when you switch).
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
        let expired = session.is_some_and(|s| s.expired);
        self.done.set_visible(expired);
        // Tucked away, the arrow says time's up.
        if expired {
            self.expand.add_css_class("attention")
        } else {
            self.expand.remove_css_class("attention")
        }
        if let Some(s) = session.filter(|_| focus) {
            let text = model::focus_left(s, now());
            self.set_tip(&self.timer, &text);
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

    /// The clock (each second; the label only changes each minute).
    fn tick(&self) {
        let Ok(t) = glib::DateTime::now_local() else { return };
        let text = t.format("%-l:%M %p").map(|s| s.trim().to_string()).unwrap_or_default();
        if self.clock.label() != text {
            self.clock.set_label(&text);
            if let Ok(day) = t.format("%A %-e %B %Y") {
                self.set_tip(&self.clock, &day);
            }
        }
    }

    /// `w`'s tooltip, shown above the bar instead of GTK's below it.
    fn hover_tip(self: &Rc<Self>, w: &gtk::Widget) {
        // Its GTK tooltip becomes ours (GTK would show its own below too).
        if let Some(t) = w.tooltip_text() {
            self.set_tip(w, &t);
        }
        w.set_tooltip_text(None);
        w.set_has_tooltip(false);
        let motion = gtk::EventControllerMotion::new();
        let (h, weak) = (self.clone(), w.downgrade());
        motion.connect_enter(move |_, _, _| {
            if let Some(w) = weak.upgrade() {
                h.tip_soon(&w);
            }
        });
        let h = self.clone();
        motion.connect_leave(move |_| h.tip_hide());
        w.add_controller(motion);
        // A press hides it (the button still gets the click).
        let press = gtk::GestureClick::new();
        press.set_propagation_phase(gtk::PropagationPhase::Capture);
        let h = self.clone();
        press.connect_pressed(move |_, _, _, _| h.tip_hide());
        w.add_controller(press);
    }

    /// A bar widget's tooltip (live, if it's on screen now).
    fn set_tip(&self, w: &impl IsA<gtk::Widget>, text: &str) {
        let key = tip_key(w);
        self.tips.borrow_mut().insert(key, text.to_string());
        if self.tip.showing.get() == Some(key) && self.tip.win.is_visible() {
            self.tip.text.set_label(text);
        }
    }

    fn tip_soon(self: &Rc<Self>, w: &gtk::Widget) {
        self.tip_hide();
        let (h, weak) = (self.clone(), w.downgrade());
        let id = glib::timeout_add_local_once(std::time::Duration::from_millis(450), move || {
            h.tip.pending.replace(None);
            if let Some(w) = weak.upgrade() {
                h.tip_show(&w);
            }
        });
        self.tip.pending.replace(Some(id));
    }

    fn tip_hide(&self) {
        if let Some(id) = self.tip.pending.take() {
            id.remove();
        }
        self.tip.win.set_visible(false);
        self.tip.showing.set(None);
    }

    /// Centred over `w`, just above the bar.
    fn tip_show(&self, w: &gtk::Widget) {
        let key = tip_key(w);
        let Some(text) = self.tips.borrow().get(&key).filter(|t| !t.is_empty()).cloned() else { return };
        self.tip.text.set_label(&text);
        self.tip.showing.set(Some(key));
        if gtk4_layer_shell::is_supported() {
            let at = w.compute_point(&self.bar, &gtk::graphene::Point::new(0.0, 0.0));
            let (_, natural, _, _) = self.tip.card.measure(gtk::Orientation::Horizontal, -1);
            let centre = at.map(|p| p.x() + w.width() as f32 / 2.0).unwrap_or(self.bar.width() as f32 / 2.0);
            // The bar sits 12 px from the right and bottom edges (layer()).
            let right = 12.0 + self.bar.width() as f32 - centre - natural as f32 / 2.0;
            self.tip.win.set_margin(Edge::Right, right.max(6.0) as i32);
            self.tip.win.set_margin(Edge::Bottom, 12 + self.bar.height() + 6);
        }
        self.tip.win.set_default_size(1, 1);
        self.tip.win.present();
    }

    /// The battery bubble (every few seconds; sysfs is cheap to read).
    fn show_battery(&self, b: Option<power::Battery>) {
        self.battery.set_visible(b.is_some());
        let Some(b) = b else { return };
        self.battery_icon.set_icon_name(Some(&power::icon(&b)));
        self.battery_text.set_label(&format!("{}%", b.percent));
        self.set_tip(&self.battery, &power::describe(&b));
        if power::low(&b) { self.battery.add_css_class("low") } else { self.battery.remove_css_class("low") }
    }

    /// Tucks the bar away behind its arrow, or brings it back.
    fn set_collapsed(&self, collapsed: bool, remember: bool) {
        self.tip_hide();
        self.row.set_visible(!collapsed);
        self.expand.set_visible(collapsed);
        // Shrink to what's left, so the empty corner takes no clicks.
        self.bar.set_default_size(1, 1);
        if remember {
            prefs::save_to(&prefs::file(), &prefs::Prefs { collapsed });
        }
    }

    // ------------------------------------------------- brightness, volume
    fn open_brightness(self: &Rc<Self>) {
        self.sound.win.set_visible(false);
        self.bright.win.present();
        let w = self.wadd.clone();
        let h = self.clone();
        background(
            move || w.brightness(),
            move |r| {
                let now = match r {
                    Ok(b) if b.available => Ok(b.percent),
                    Ok(_) => Err(NO_BRIGHTNESS.to_string()),
                    Err(e) => {
                        eprintln!("hud: brightness: {e}");
                        Err(NO_BRIGHTNESS.to_string())
                    }
                };
                h.bright.show(now, &h.syncing);
            },
        );
    }

    fn open_volume(self: &Rc<Self>) {
        self.bright.win.set_visible(false);
        self.sound.win.present();
        let h = self.clone();
        background(audio::get, move |r| h.heard_volume(r));
    }

    fn heard_volume(&self, r: Result<audio::Volume, String>) {
        if let Err(e) = &r {
            eprintln!("hud: volume: {e}");
        }
        self.show_volume(r.as_ref().ok().copied());
        self.sound.show(r.map(|v| v.percent).map_err(|_| NO_SOUND.to_string()), &self.syncing);
    }

    /// The volume's icons (the bubble's and the mute button's).
    fn show_volume(&self, v: Option<audio::Volume>) {
        self.volume.set(v);
        let name = audio::icon(v);
        self.sound_icon.set_icon_name(Some(name));
        self.mute_icon.set_icon_name(Some(name));
        let muted = v.is_some_and(|v| v.muted);
        self.mute.set_tooltip_text(Some(if muted { "Unmute" } else { "Mute" }));
        if muted { self.sound.row.add_css_class("muted") } else { self.sound.row.remove_css_class("muted") }
    }

    /// A brightness or volume key (sway runs `hud --key <name>`, which hands
    /// it to this HUD): the change, then its level for a moment.
    fn on_key(self: &Rc<Self>, key: &str) {
        match key {
            "brightness-up" => self.step_brightness(10),
            "brightness-down" => self.step_brightness(-10),
            "volume-up" => self.step_volume(5),
            "volume-down" => self.step_volume(-5),
            "volume-mute" => {
                let h = self.clone();
                background(audio::toggle_mute, move |r| h.volume_stepped(r));
            }
            other => eprintln!("hud: no such key {other:?}"),
        }
    }

    fn step_brightness(self: &Rc<Self>, delta: i32) {
        let steps = self.bright_steps.clone();
        steps.pending.set(steps.pending.get() + delta);
        if steps.busy.replace(true) {
            return;
        }
        let delta = steps.pending.replace(0);
        let w = self.wadd.clone();
        let h = self.clone();
        background(
            move || {
                let b = w.brightness()?;
                if !b.available {
                    return Ok(b);
                }
                w.set_brightness((b.percent as i32 + delta).clamp(0, 100) as u8)
            },
            move |r| {
                h.bright_steps.busy.set(false);
                let now = match r {
                    Ok(b) if b.available => Ok(b.percent),
                    _ => Err(NO_BRIGHTNESS.to_string()),
                };
                if h.bright.win.is_visible() {
                    h.bright.show(now.clone(), &h.syncing);
                }
                h.flash(BRIGHTNESS_ICON, now);
                if h.bright_steps.pending.get() != 0 {
                    h.step_brightness(0);
                }
            },
        );
    }

    fn step_volume(self: &Rc<Self>, delta: i32) {
        let steps = self.sound_steps.clone();
        steps.pending.set(steps.pending.get() + delta);
        if steps.busy.replace(true) {
            return;
        }
        let delta = steps.pending.replace(0);
        let h = self.clone();
        background(
            move || audio::step(delta),
            move |r| {
                h.sound_steps.busy.set(false);
                h.volume_stepped(r);
                if h.sound_steps.pending.get() != 0 {
                    h.step_volume(0);
                }
            },
        );
    }

    fn volume_stepped(self: &Rc<Self>, r: Result<audio::Volume, String>) {
        let v = r.as_ref().ok().copied();
        if self.sound.win.is_visible() {
            self.heard_volume(r);
        } else {
            self.show_volume(v);
        }
        let now = match v {
            Some(v) if v.muted => Ok(0),
            Some(v) => Ok(v.percent),
            None => Err(NO_SOUND.to_string()),
        };
        self.flash(audio::icon(v), now);
    }

    /// The level bubble, for a moment.
    fn flash(self: &Rc<Self>, icon_name: &str, now: Result<u8, String>) {
        self.osd.icon.set_icon_name(Some(icon_name));
        match now {
            Ok(p) => {
                self.osd.bar.set_visible(true);
                self.osd.bar.set_fraction(p as f64 / 100.0);
                self.osd.value.set_label(&format!("{p}%"));
                self.osd.value.set_width_chars(4);
            }
            Err(why) => {
                self.osd.bar.set_visible(false);
                self.osd.value.set_label(&why);
                self.osd.value.set_width_chars(-1);
            }
        }
        self.osd.win.set_default_size(1, 1);
        self.osd.win.present();
        if let Some(old) = self.osd.hide.take() {
            old.remove();
        }
        let h = self.clone();
        let id = glib::timeout_add_local_once(std::time::Duration::from_millis(1500), move || {
            h.osd.hide.replace(None);
            h.osd.win.set_visible(false);
        });
        self.osd.hide.replace(Some(id));
    }

    // ------------------------------------------------------------ clipboard
    /// Follows sway's clipboard: every copy into the history.
    fn start_clipboard(self: &Rc<Self>) {
        let (tx, rx) = async_channel::unbounded();
        let socket = wad_clip::wl::env_socket();
        let watched = wad_clip::wl::watch(&socket, "hud", move |c| {
            let ev = match c {
                Change::Copied(c) => {
                    // Made here, off the GTK loop: decoding a screenshot takes a moment.
                    let thumb = c.image().and_then(|(_, bytes)| thumb::fit(bytes, 192, 96));
                    ClipEvent::Copied(c, thumb)
                }
                Change::Cleared => ClipEvent::Cleared,
                Change::Closed(why) => ClipEvent::Closed(why),
            };
            let _ = tx.send_blocking(ev);
        });
        match watched {
            Ok(board) => self.clip.board.replace(Some(board)),
            Err(e) => {
                eprintln!("hud: no clipboard history: {e}");
                return;
            }
        };
        let h = self.clone();
        glib::spawn_future_local(async move {
            while let Ok(ev) = rx.recv().await {
                h.on_clip(ev);
            }
        });
    }

    fn on_clip(self: &Rc<Self>, ev: ClipEvent) {
        match ev {
            ClipEvent::Copied(c, thumb) => {
                let kept = self.clip.history.borrow_mut().add(c, thumb, now());
                self.clip.current_kept.set(kept);
                if self.clip.win.is_visible() {
                    self.fill_clips();
                }
            }
            // Whoever copied it went away (a wadspace stopped, an app
            // closed): copy it again, so it can still be pasted.
            ClipEvent::Cleared => {
                if self.clip.current_kept.get()
                    && let (Some(e), Some(board)) = (self.clip.history.borrow().latest(), &*self.clip.board.borrow())
                {
                    board.set(e.content.clone());
                }
            }
            ClipEvent::Closed(why) => {
                eprintln!("hud: the clipboard went away: {why}");
                self.clip.board.replace(None);
            }
        }
    }

    fn toggle_clips(self: &Rc<Self>) {
        if self.clip.win.is_visible() {
            self.close_clips();
            return;
        }
        self.fill_clips();
        self.clip.win.present();
        if let Some(first) = self.clip.list.row_at_index(0) {
            first.grab_focus();
        }
    }

    fn close_clips(&self) {
        self.clip.win.set_visible(false);
    }

    fn fill_clips(self: &Rc<Self>) {
        while let Some(row) = self.clip.list.first_child() {
            self.clip.list.remove(&row);
        }
        let history = self.clip.history.borrow();
        let none = history.entries().is_empty();
        self.clip.empty.set_visible(none);
        self.clip.list.set_visible(!none);
        self.clip.clear.set_sensitive(!none);
        let t = now();
        for e in history.entries() {
            let row = gtk::ListBoxRow::new();
            row.add_css_class("clip");
            row.set_widget_name(&e.id.to_string());
            let line = gtk::Box::new(gtk::Orientation::Horizontal, 12);
            let texture = e.thumb.as_ref().and_then(|b| gdk::Texture::from_bytes(&glib::Bytes::from(b)).ok());
            let face: gtk::Widget = match texture {
                Some(tex) => {
                    // At its own (thumbnail) size, never stretched to the row.
                    let pic = gtk::Picture::for_paintable(&tex);
                    pic.set_can_shrink(false);
                    pic.set_content_fit(gtk::ContentFit::ScaleDown);
                    pic.set_size_request(tex.width(), tex.height());
                    pic.set_halign(gtk::Align::Start);
                    pic.set_valign(gtk::Align::Center);
                    pic.add_css_class("thumb");
                    pic.upcast()
                }
                None => {
                    let text = label(&e.label(), "text");
                    text.set_wrap(true);
                    text.set_wrap_mode(gtk::pango::WrapMode::WordChar);
                    text.set_lines(3);
                    text.set_ellipsize(gtk::pango::EllipsizeMode::End);
                    text.set_max_width_chars(42);
                    text.set_xalign(0.0);
                    text.upcast()
                }
            };
            face.set_hexpand(true);
            line.append(&face);
            let side = gtk::Box::new(gtk::Orientation::Vertical, 2);
            let when = label(&clips::ago(t - e.at), "when");
            when.set_halign(gtk::Align::End);
            side.append(&when);
            let forget = button("✕", &["forget"]);
            forget.set_tooltip_text(Some("Remove from the history"));
            forget.set_halign(gtk::Align::End);
            let (h, id) = (self.clone(), e.id);
            forget.connect_clicked(move |_| h.forget_clip(id));
            side.append(&forget);
            line.append(&side);
            row.set_child(Some(&line));
            self.clip.list.append(&row);
        }
        drop(history);
        if let Some(first) = self.clip.list.row_at_index(0) {
            self.clip.list.select_row(Some(&first));
        }
    }

    fn forget_clip(self: &Rc<Self>, id: u64) {
        let was_latest = self.clip.history.borrow().latest().is_some_and(|e| e.id == id);
        self.clip.history.borrow_mut().remove(id);
        if was_latest {
            self.clip.current_kept.set(false);
        }
        self.fill_clips();
        if let Some(first) = self.clip.list.row_at_index(0) {
            first.grab_focus();
        }
    }

    /// The pick becomes the clipboard, in every wadspace (their bridges copy it in).
    fn pick_clip(self: &Rc<Self>, id: u64) {
        let picked = self.clip.history.borrow_mut().promote(id);
        if let (Some(c), Some(board)) = (picked, &*self.clip.board.borrow()) {
            board.set(c);
            self.clip.current_kept.set(true);
        }
        self.close_clips();
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
            // WadSpaces Client (wadd's "home" view) is the WadSpaces logo.
            let texture = if item.view == "home" {
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
            Incoming::Event(name, data) if name == "session" => {
                if let Ok(session) = serde_json::from_value::<Option<model::Session>>(data) {
                    if !model::locked(session.as_ref()) {
                        self.show_left.set(false);
                    }
                    self.state.borrow_mut().session = session;
                    self.update_bar();
                }
            }
            Incoming::Event(name, data) if name == "network" => {
                if let Ok(network) = serde_json::from_value::<model::Network>(data) {
                    self.state.borrow_mut().network = Some(network);
                    self.update_bar();
                }
            }
            Incoming::Event(name, data) if name == "shortcut" => {
                if data.get("name").and_then(|n| n.as_str()) == Some("clipboard") {
                    self.toggle_clips();
                }
            }
            Incoming::Event(name, data) if name == "carousel" => {
                self.carousel.replace(serde_json::from_value(data).unwrap_or_default());
                self.show_switcher();
            }
            // The old way the bar opened WadSpaces Client's menus: only power
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
        hud.icons.borrow_mut().insert("/v1/workspaces/writing/icon".into(), Some(t));
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
    hud.show_battery(Some(power::Battery { percent: 76, state: power::State::Discharging, minutes: Some(250) }));
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
                icon: Some("/v1/workspaces/writing/icon".into()),
                running: true,
            },
            model::CarouselItem { view: "home".into(), name: "WadSpaces".into(), icon: None, running: true },
            model::CarouselItem {
                view: "workspace:iq-dev".into(),
                name: "IntelligenceQuest Dev".into(),
                icon: None,
                running: false,
            },
        ],
    });
    hud.show_switcher();
    // Brightness and volume, as if both answered.
    hud.bright.win.present();
    hud.bright.show(Ok(70), &hud.syncing);
    hud.sound.win.present();
    hud.show_volume(Some(audio::Volume { percent: 40, muted: false }));
    hud.sound.show(Ok(40), &hud.syncing);
    hud.flash(audio::icon(Some(audio::Volume { percent: 80, muted: false })), Ok(80));
    // A tooltip, over the battery.
    let h = hud.clone();
    glib::timeout_add_local_once(std::time::Duration::from_millis(300), move || h.tip_show(h.battery.upcast_ref()));
    // The clipboard history: text, code, and an image (the switcher's icon).
    let text = |t: &str| Content {
        items: vec![wad_clip::Item { mime: "text/plain;charset=utf-8".into(), data: t.as_bytes().to_vec() }],
    };
    {
        let mut h = hud.clip.history.borrow_mut();
        h.add(text("fn main() {\n    println!(\"hello from Writing\");\n}"), None, now() - 7200.0);
        if let Some(bytes) = std::env::var_os("WADSPACES_HUD_SNAPSHOT_ICON").and_then(|p| std::fs::read(p).ok()) {
            let thumb = thumb::fit(&bytes, 192, 96);
            h.add(
                Content { items: vec![wad_clip::Item { mime: "image/png".into(), data: bytes }] },
                thumb,
                now() - 300.0,
            );
        }
        h.add(text("https://github.com/HungGod/WadSpaces/pull/42"), None, now() - 20.0);
    }
    hud.toggle_clips();
    glib::timeout_add_local_once(std::time::Duration::from_millis(800), move || {
        for (win, name) in [
            (&hud.bar, "bar"),
            (&hud.power, "power"),
            (&hud.wifi.win, "wifi"),
            (&hud.switcher, "switcher"),
            (&hud.bright.win, "brightness"),
            (&hud.sound.win, "volume"),
            (&hud.osd.win, "level"),
            (&hud.tip.win, "tip"),
            (&hud.clip.win, "clipboard"),
        ] {
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
            // Tucked away, after time ran out: only the arrow, lit.
            hud.state.borrow_mut().session.as_mut().unwrap().expired = true;
            hud.update_bar();
            hud.set_collapsed(true, false);
            glib::timeout_add_local_once(std::time::Duration::from_millis(300), move || {
                save_png(&hud.bar, &dir.join("bar-collapsed.png"));
                app.quit();
            });
        });
    });
}

/// `hud --key <name>`: a brightness or volume key (sway's bindings).
fn key_arg(args: &[String]) -> Option<&str> {
    let i = args.iter().position(|a| a == "--key")?;
    args.get(i + 1).map(String::as_str)
}

fn main() -> glib::ExitCode {
    // One HUD per session: running it again with `--key` hands the key to
    // the one that's running (over the session bus) and exits.
    let app = gtk::Application::builder()
        .application_id("io.wadspaces.hud")
        .flags(gtk::gio::ApplicationFlags::HANDLES_COMMAND_LINE)
        .build();
    let running: Rc<RefCell<Option<Rc<Hud>>>> = Rc::default();
    let r = running.clone();
    app.connect_command_line(move |app, cmd| {
        let args: Vec<String> = cmd.arguments().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        if r.borrow().is_none() {
            app.activate();
        }
        if let (Some(key), Some(hud)) = (key_arg(&args), r.borrow().as_ref()) {
            hud.on_key(key);
        }
        glib::ExitCode::SUCCESS
    });
    let r = running.clone();
    app.connect_activate(move |app| {
        if r.borrow().is_some() {
            return;
        }
        // Adwaita's icons, whatever the desktop's theme (KDE's Breeze lacks
        // the battery-level ones): the HUD names them (icon(), power::icon).
        if let Some(settings) = gtk::Settings::default() {
            settings.set_gtk_icon_theme_name(Some("Adwaita"));
        }
        let css = gtk::CssProvider::new();
        if let Some(display) = gdk::Display::default() {
            gtk::style_context_add_provider_for_display(&display, &css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
        let hud = Hud::build(app, css, theme::current());
        r.replace(Some(hud.clone()));
        if let Some(dir) = std::env::var_os("WADSPACES_HUD_SNAPSHOT") {
            let _hold = app.hold();
            snapshot(hud, app.clone(), dir.into());
            std::mem::forget(_hold);
            return;
        }
        // Its volume icon, from the start.
        let h = hud.clone();
        background(audio::get, move |r| h.show_volume(r.ok()));
        if prefs::load_from(&prefs::file()).collapsed {
            hud.set_collapsed(true, false);
        }
        hud.start_clipboard();
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
        // The battery, now and every 10 s.
        let h = hud.clone();
        let check = move || h.show_battery(power::combine(&power::read(&power::dir())));
        check();
        glib::timeout_add_seconds_local(10, move || {
            check();
            glib::ControlFlow::Continue
        });
        // The clock, and the focus timer counting down.
        let h = hud.clone();
        glib::timeout_add_seconds_local(1, move || {
            h.tick();
            if model::locked(h.state.borrow().session.as_ref()) {
                h.update_bar();
            }
            glib::ControlFlow::Continue
        });
    });
    app.run()
}
