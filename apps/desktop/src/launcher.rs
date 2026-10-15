//! The launcher (the web app's components/launcher/Launcher.tsx): the
//! wadspaces, each its own desktop, and what runs on the machine beside
//! them (WadBrowser, WadBrowser Focus, saved WadBrowser setups, the
//! terminal). Pick any mix, then launch, or launch in focus mode for a set
//! time. (Customizing one for a run comes with the Secrets page's sign-ins.)

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::{glib, prelude::*};
use serde_json::Value;
use wad_gtk::Icon;
use wad_proto::v1::ImageRow;

use crate::launch::{self, ImageState, RunItem};
use crate::modal::Modal;
use crate::rt;
use crate::store::{AppState, store};
use crate::thumb::thumb;
use crate::ui::{self, Size, Variant};

const PRESETS: [u32; 4] = [25, 50, 90, 120];

fn fmt_minutes(m: u32) -> String {
    match (m / 60, m % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// Something to pick.
#[derive(Clone)]
struct Entry {
    id: String,
    item: RunItem,
    label: String,
    detail: String,
    /// A space's stack, for its picture.
    wadspace: Option<Value>,
    saved: bool,
}

fn entries(s: &AppState, images: &HashMap<String, ImageRow>) -> (Vec<Entry>, Vec<Entry>) {
    let lib = s.library.as_ref().map(|l| l.lib()).unwrap_or_default();
    let spaces = s
        .wadspaces()
        .into_iter()
        .filter(|w| w["customization"].is_object())
        .map(|w| {
            let n = w["customization"]["projects"].as_array().map(Vec::len).unwrap_or(0);
            let count = format!("{n} project{}", if n == 1 { "" } else { "s" });
            let key = wad_core::layers::stack_image_key(w);
            let resolves = !wad_core::layers::resolve_stack(&lib, w).is_null();
            let detail = if !resolves {
                "Its template is gone".to_string()
            } else {
                match launch::image_state(&key, &lib, images) {
                    ImageState::Built => count,
                    ImageState::Update => format!("{count} · an update is available"),
                    ImageState::Never | ImageState::Changed => format!("{count} · its image builds first"),
                }
            };
            Entry {
                id: format!("w:{}", w["id"].as_str().unwrap_or_default()),
                item: RunItem::Wadspace(w["id"].as_str().unwrap_or_default().into()),
                label: s.wadspace_name(w),
                detail,
                wadspace: Some(w.clone()),
                saved: false,
            }
        })
        .collect();
    let browser_detail = |mode: &str, webapps: &[Value]| {
        let bar = if mode == "focus" { "No address bar" } else { "Address bar" };
        let apps: Vec<&str> = webapps.iter().filter_map(|w| w["name"].as_str()).collect();
        format!("{bar} · {}", if apps.is_empty() { "no web apps".to_string() } else { apps.join(", ") })
    };
    let mut apps = vec![
        Entry {
            id: "b:wadbrowser".into(),
            item: RunItem::App("browser".into()),
            label: "WadBrowser".into(),
            detail: browser_detail("browser", &[]),
            wadspace: None,
            saved: false,
        },
        Entry {
            id: "b:wadbrowser-focus".into(),
            item: RunItem::App("browser-focus".into()),
            label: "WadBrowser Focus".into(),
            detail: browser_detail("focus", &[]),
            wadspace: None,
            saved: false,
        },
    ];
    for b in s.library.iter().flat_map(|l| l.browsers.iter()).filter(|b| b.get("deletedAt").is_none_or(Value::is_null))
    {
        apps.push(Entry {
            id: format!("b:{}", b["id"].as_str().unwrap_or_default()),
            item: RunItem::Browser(b.clone()),
            label: b["name"].as_str().unwrap_or("WadBrowser").into(),
            detail: browser_detail(
                b["mode"].as_str().unwrap_or("browser"),
                b["webapps"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            ),
            wadspace: None,
            saved: true,
        });
    }
    apps.push(Entry {
        id: "terminal".into(),
        item: RunItem::Terminal,
        label: "Terminal".into(),
        detail: "foot, on the machine".into(),
        wadspace: None,
        saved: false,
    });
    (spaces, apps)
}

struct Flow {
    modal: Modal,
    picked: RefCell<Vec<String>>,
    all: RefCell<Vec<Entry>>,
    cards: RefCell<Vec<(String, gtk::Widget, gtk::Box)>>,
    count: gtk::Label,
    launch: gtk::Button,
    focus: gtk::Button,
    minutes: std::cell::Cell<u32>,
}

/// Opens the launcher.
pub fn open() {
    let modal = Modal::open("Launch", Some("Pick spaces and apps to open together."), 920);
    let count = gtk::Label::new(Some("Pick one or more"));
    let launch_b = ui::button("Launch", Some("play"), Variant::Primary, Size::Md);
    let focus_b = ui::button("Focus mode…", Some("lock"), Variant::Secondary, Size::Md);
    let f = Rc::new(Flow {
        modal,
        picked: RefCell::default(),
        all: RefCell::default(),
        cards: RefCell::default(),
        count,
        launch: launch_b,
        focus: focus_b,
        minutes: std::cell::Cell::new(50),
    });
    let me = f.clone();
    f.launch.connect_clicked(move |_| me.go(None));
    let me = f.clone();
    f.focus.connect_clicked(move |_| me.focus_view());
    f.pick_view(HashMap::new());
    // The images here say which spaces build first.
    let ff = f.clone();
    glib::spawn_future_local(async move {
        let w = wad_wadd_client::Wadd::here();
        let rows = rt::run(async move { w.get::<Vec<ImageRow>>("/v1/images").await }).await.unwrap_or_default();
        ff.pick_view(rows.into_iter().map(|r| (r.layer.clone(), r)).collect());
    });
}

fn heading(title: &str, hint: Option<&str>) -> gtk::Widget {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 4);
    b.add_css_class("launch-heading");
    let t = gtk::Label::new(Some(&title.to_uppercase()));
    t.add_css_class("launch-heading-title");
    t.set_xalign(0.0);
    b.append(&t);
    if let Some(h) = hint {
        let l = ui::wrapping(h);
        l.add_css_class("launch-heading-hint");
        b.append(&l);
    }
    b.upcast()
}

fn check(on: bool) -> gtk::Box {
    let c = gtk::Box::new(gtk::Orientation::Vertical, 0);
    c.add_css_class("check");
    c.set_valign(gtk::Align::Center);
    if on {
        c.add_css_class("on");
        c.append(&Icon::new("check", 12));
    }
    c
}

impl Flow {
    fn pick_view(self: &Rc<Self>, images: HashMap<String, ImageRow>) {
        let body = self.modal.body();
        ui::clear(body);
        let (spaces, apps) = store().read_now(|s| entries(s, &images));
        *self.all.borrow_mut() = spaces.iter().chain(apps.iter()).cloned().collect();
        self.cards.borrow_mut().clear();
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        scroll.set_max_content_height(520);
        scroll.set_propagate_natural_height(true);
        let col = gtk::Box::new(gtk::Orientation::Vertical, 24);
        col.set_margin_end(4);
        let sec = gtk::Box::new(gtk::Orientation::Vertical, 0);
        sec.append(&heading(
            "Wadspaces",
            Some("Each its own desktop. Customize one to change its background or keys for a run."),
        ));
        if spaces.is_empty() {
            let empty = ui::wrapping("No wadspaces yet. Make one in the Builder.");
            empty.add_css_class("launch-empty");
            sec.append(&empty);
        } else {
            let grid = gtk::Grid::new();
            grid.set_column_homogeneous(true);
            grid.set_column_spacing(8);
            grid.set_row_spacing(8);
            for (n, e) in spaces.iter().enumerate() {
                grid.attach(&self.card(e, true), (n % 2) as i32, (n / 2) as i32, 1, 1);
            }
            sec.append(&grid);
        }
        col.append(&sec);
        let sec = gtk::Box::new(gtk::Orientation::Vertical, 0);
        sec.append(&heading("On this machine", Some("On the machine itself, beside the spaces. Run as many WadBrowsers as you like, each set up its own way.")));
        let grid = gtk::Grid::new();
        grid.set_column_homogeneous(true);
        grid.set_column_spacing(8);
        grid.set_row_spacing(8);
        for (n, e) in apps.iter().enumerate() {
            grid.attach(&self.card(e, false), (n % 3) as i32, (n / 3) as i32, 1, 1);
        }
        sec.append(&grid);
        col.append(&sec);
        scroll.set_child(Some(&col));
        body.append(&scroll);

        let foot = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        foot.add_css_class("launch-foot");
        self.count.add_css_class("small-muted");
        self.count.set_hexpand(true);
        self.count.set_xalign(0.0);
        // Kept across views: out of the last footer first.
        for w in [self.count.upcast_ref::<gtk::Widget>(), self.focus.upcast_ref(), self.launch.upcast_ref()] {
            if let Some(b) = w.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
                b.remove(w);
            }
        }
        foot.append(&self.count);
        foot.append(&self.focus);
        foot.append(&self.launch);
        body.append(&foot);
        self.refresh();
    }

    fn card(self: &Rc<Self>, e: &Entry, space: bool) -> gtk::Widget {
        let b = gtk::Button::new();
        b.add_css_class("pick");
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        if space {
            let st = store();
            let t = st.read_now(|s| e.wadspace.as_ref().map(|w| thumb(s, w)));
            if let Some(t) = t {
                t.set_fixed_width(96);
                t.set_radius(12.0);
                t.set_screen(1920.0, 1080.0, 2.0);
                t.set_valign(gtk::Align::Center);
                row.append(&t);
            }
        } else {
            let svg: &'static [u8] = include_bytes!("../../../apps/client/public/brand/wadbrowser-icon-dark.svg");
            let icon: gtk::Widget = if matches!(e.item, RunItem::Terminal) {
                let img = gtk::Image::new();
                img.set_pixel_size(32);
                crate::images::desktop_icon(
                    "/icons/terminal.png",
                    crate::images::later(&img, |i, t| i.set_paintable(Some(&t))),
                );
                img.upcast()
            } else {
                wad_gtk::Svg::new(svg, 32, 32).upcast()
            };
            icon.set_valign(gtk::Align::Center);
            row.append(&icon);
        }
        let text = gtk::Box::new(gtk::Orientation::Vertical, 0);
        text.set_hexpand(true);
        text.set_valign(gtk::Align::Center);
        let l = gtk::Label::new(Some(&e.label));
        l.add_css_class("pick-label");
        l.set_xalign(0.0);
        l.set_ellipsize(gtk::pango::EllipsizeMode::End);
        let d = gtk::Label::new(Some(&e.detail));
        d.add_css_class("pick-detail");
        d.set_xalign(0.0);
        d.set_ellipsize(gtk::pango::EllipsizeMode::End);
        text.append(&l);
        text.append(&d);
        if e.saved {
            let badge = crate::pages::badge("Saved", None, false);
            badge.set_halign(gtk::Align::Start);
            badge.set_margin_top(4);
            text.append(&badge);
        }
        row.append(&text);
        let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        slot.set_valign(gtk::Align::Center);
        slot.append(&check(false));
        row.append(&slot);
        b.set_child(Some(&row));
        let (me, id) = (self.clone(), e.id.clone());
        b.connect_clicked(move |_| me.toggle(&id));
        self.cards.borrow_mut().push((e.id.clone(), b.clone().upcast(), slot));
        b.upcast()
    }

    fn toggle(self: &Rc<Self>, id: &str) {
        {
            let mut p = self.picked.borrow_mut();
            match p.iter().position(|x| x == id) {
                Some(i) => {
                    p.remove(i);
                }
                None => p.push(id.into()),
            }
        }
        self.refresh();
    }

    fn refresh(&self) {
        let picked = self.picked.borrow();
        for (id, card, slot) in self.cards.borrow().iter() {
            let on = picked.contains(id);
            if on {
                card.add_css_class("on");
            } else {
                card.remove_css_class("on");
            }
            ui::clear(slot);
            slot.append(&check(on));
        }
        self.count.set_text(&if picked.is_empty() {
            "Pick one or more".to_string()
        } else {
            format!("{} picked", picked.len())
        });
        self.launch.set_sensitive(!picked.is_empty());
        self.focus.set_sensitive(!picked.is_empty());
    }

    /// What's picked, spaces first, then what runs beside them.
    fn items(&self) -> Vec<RunItem> {
        let all = self.all.borrow();
        let picked: Vec<RunItem> = self
            .picked
            .borrow()
            .iter()
            .filter_map(|id| all.iter().find(|e| e.id == *id).map(|e| e.item.clone()))
            .collect();
        let (mut spaces, rest): (Vec<RunItem>, Vec<RunItem>) =
            picked.into_iter().partition(|i| matches!(i, RunItem::Wadspace(_)));
        spaces.extend(rest);
        spaces
    }

    fn go(self: &Rc<Self>, focus: Option<u32>) {
        let items = self.items();
        if items.is_empty() {
            return;
        }
        self.launch.set_sensitive(false);
        self.focus.set_sensitive(false);
        let me = self.clone();
        glib::spawn_future_local(async move {
            match launch::launch(items, focus).await {
                Ok(_) => {
                    crate::toast::show("Launching", None, crate::toast::Tone::Success);
                    me.modal.close();
                }
                Err(e) => {
                    crate::toast::error("Couldn't launch", &e);
                    me.refresh();
                }
            }
        });
    }

    fn focus_view(self: &Rc<Self>) {
        let body = self.modal.body();
        ui::clear(body);
        let col = gtk::Box::new(gtk::Orientation::Vertical, 20);
        let hint = gtk::Label::new(None);
        let label = gtk::Box::new(gtk::Orientation::Vertical, 6);
        label.append(&ui::field_label("Focus for how long?", Some(&hint)));
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let mut presets = vec![];
        for m in PRESETS {
            let b = gtk::Button::with_label(&fmt_minutes(m));
            b.add_css_class("preset");
            row.append(&b);
            presets.push((m, b));
        }
        let hours = gtk::SpinButton::with_range(0.0, 12.0, 1.0);
        hours.add_css_class("number");
        let mins = gtk::SpinButton::with_range(0.0, 59.0, 5.0);
        mins.add_css_class("number");
        let hl = gtk::Label::new(Some("h"));
        hl.add_css_class("small-muted-14");
        let ml = gtk::Label::new(Some("min"));
        ml.add_css_class("small-muted-14");
        row.append(&hours);
        row.append(&hl);
        row.append(&mins);
        row.append(&ml);
        label.append(&row);
        col.append(&label);
        let note = ui::wrapping(&format!(
            "Only these {} open until the time's up, and there's no ending it early.",
            self.picked.borrow().len()
        ));
        note.add_css_class("small-muted");
        col.append(&note);
        let foot = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        foot.add_css_class("launch-foot");
        let back = ui::button("Back", None, Variant::Ghost, Size::Md);
        back.set_hexpand(true);
        back.set_halign(gtk::Align::Start);
        let start = ui::button("Start focus", Some("timer"), Variant::Primary, Size::Md);
        foot.append(&back);
        foot.append(&start);
        col.append(&foot);
        body.append(&col);

        let presets = Rc::new(presets);
        let show = {
            let (me, hint, start, presets, hours, mins) =
                (self.clone(), hint.clone(), start.clone(), presets.clone(), hours.clone(), mins.clone());
            Rc::new(move || {
                let m = me.minutes.get();
                for (pm, b) in presets.iter() {
                    if *pm == m {
                        b.add_css_class("on");
                    } else {
                        b.remove_css_class("on");
                    }
                }
                hours.set_value((m / 60) as f64);
                mins.set_value((m % 60) as f64);
                let until = glib::DateTime::now_local()
                    .ok()
                    .and_then(|d| d.add_minutes(m as i32).ok())
                    .and_then(|d| d.format("%H:%M").ok());
                hint.set_text(&format!("until about {}", until.map(|g| g.to_string()).unwrap_or_default()));
                ui::set_text(&start, &format!("Start focus for {}", fmt_minutes(m)));
            })
        };
        show();
        for (m, b) in presets.iter() {
            let (me, show, m) = (self.clone(), show.clone(), *m);
            b.connect_clicked(move |_| {
                me.minutes.set(m);
                show();
            });
        }
        let set = {
            let (me, show, hours, mins) = (self.clone(), show.clone(), hours.clone(), mins.clone());
            Rc::new(move || {
                let m = (hours.value() as u32 * 60 + mins.value() as u32).clamp(1, 12 * 60);
                if m != me.minutes.get() {
                    me.minutes.set(m);
                    show();
                }
            })
        };
        let s1 = set.clone();
        hours.connect_value_changed(move |_| s1());
        mins.connect_value_changed(move |_| set());
        let me = self.clone();
        back.connect_clicked(move |_| me.pick_view(HashMap::new()));
        let me = self.clone();
        start.connect_clicked(move |_| me.go(Some(me.minutes.get())));
    }
}
