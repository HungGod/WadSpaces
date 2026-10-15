//! How modules and submodules look (the web app's builder/faces.tsx): each
//! module is a small desktop showing what its layer brings.
//!
//! - Template: its apps, as desktop icons and in the taskbar; one built on
//!   another shows the apps it inherits faded. Under the top template,
//!   templates fold into strips.
//! - Extensions: a little window per app setup: WadBrowser's web apps, VS
//!   Code's extensions, the command line's tools.
//! - Customization: the finished desktop: its background, every icon, its
//!   projects; Look, Projects and Secrets sit in the taskbar.
//!
//! A face hands back its parts ([`Face`]) so the board can make them
//! renamable, clickable and draggable.

use gtk::prelude::*;
use wad_board::catalog::{self, app_sub_info};
use wad_board::*;
use wad_gtk::Icon;
use wad_wallpaper::{Paint, Wallpaper};

use super::state::Standing;
use crate::images;

pub const MOD_W: i32 = 288;
const SCREEN_H: i32 = 150;

pub fn layer_icon(l: Layer) -> &'static str {
    match l {
        Layer::Template => "layout-grid",
        Layer::Extensions => "puzzle",
        Layer::Customization => "palette",
    }
}

fn layer_class(l: Layer) -> &'static str {
    match l {
        Layer::Template => "mod-template",
        Layer::Extensions => "mod-extensions",
        Layer::Customization => "mod-customization",
    }
}

/// A picture by path or URL, `px` square (WadSpaces' own or fetched).
pub fn img(src: &str, px: i32) -> gtk::Image {
    let i = gtk::Image::new();
    i.set_pixel_size(px);
    if !src.is_empty() {
        images::desktop_icon(src, images::later(&i, |i, t| i.set_paintable(Some(&t))));
    }
    i
}

/// A module's parts the board makes live.
pub struct Face {
    pub root: gtk::Box,
    /// Where the name is (the board puts a renamable one in).
    pub name_slot: gtk::Box,
    /// Submodules' widgets: (its id, the widget).
    pub subs: Vec<(String, gtk::Widget)>,
    /// Blank windows (an app setup it could have): (its key, the widget).
    pub blanks: Vec<(&'static str, gtk::Widget)>,
    /// Prompts for what a customization hasn't set: (the editor section, the widget).
    pub prompts: Vec<(&'static str, gtk::Widget)>,
}

fn label(text: &str, class: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.add_css_class(class);
    l.set_xalign(0.0);
    l
}

fn bar(layer: Layer, name: &str, with_label: bool, blank: bool) -> (gtk::Box, gtk::Box) {
    let bar = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    bar.add_css_class("mod-bar");
    let l = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    l.add_css_class("mod-layer");
    l.append(&Icon::new(layer_icon(layer), 13));
    if with_label {
        l.append(&gtk::Label::new(Some(&layer.label().to_uppercase())));
    }
    bar.append(&l);
    let slot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    slot.set_hexpand(true);
    let n = label(name, "mod-name");
    n.set_ellipsize(gtk::pango::EllipsizeMode::End);
    if blank {
        n.add_css_class("faint");
    }
    slot.append(&n);
    bar.append(&slot);
    (bar, slot)
}

fn state_tag(s: Standing) -> Option<gtk::Label> {
    let (text, class) = match s {
        Standing::Unbuilt => ("Not built", ""),
        Standing::Building => ("Building…", "building"),
        Standing::Update => ("Update", "update"),
        Standing::Built => return None,
    };
    let l = gtk::Label::new(Some(text));
    l.add_css_class("build-tag");
    if !class.is_empty() {
        l.add_css_class(class);
    }
    if s == Standing::Update {
        l.set_tooltip_text(Some("Built on an older base: update it from the stack's Update available"));
    }
    Some(l)
}

fn state_class(m: &gtk::Box, s: Standing) {
    match s {
        Standing::Unbuilt => m.add_css_class("unbuilt"),
        Standing::Building => m.add_css_class("building"),
        Standing::Update => m.add_css_class("update"),
        Standing::Built => {}
    }
}

/// The template under `t` in its stack, if it builds on one.
pub fn below_of<'a>(stack: &'a Stack, t: &TemplateModule) -> Option<&'a TemplateModule> {
    let at = stack.templates.iter().position(|x| x.id == t.id)?;
    at.checked_sub(1).and_then(|i| stack.templates.get(i))
}

/// A module's face. `compact`: a template under another, as a strip.
pub fn module(stack: &Stack, m: &Module, compact: bool, state: Standing) -> Face {
    let layer = m.layer();
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.add_css_class("mod");
    root.add_css_class(layer_class(layer));
    root.set_size_request(MOD_W, -1);
    state_class(&root, state);
    let below = if let Module::Template(t) = m { below_of(stack, t) } else { None };
    if let (true, Module::Template(t)) = (compact, m) {
        root.add_css_class("compact");
        let (b, slot) = bar(layer, &t.name, false, false);
        if let Some(tag) = state_tag(state) {
            b.append(&tag);
        }
        let adds: Vec<&String> = t.apps.iter().filter(|a| below.is_none_or(|b| !b.apps.contains(a))).collect();
        let strip = gtk::Box::new(gtk::Orientation::Horizontal, 3);
        strip.add_css_class("strip-apps");
        strip.set_tooltip_text(Some(&adds.iter().map(|a| app_name(a)).collect::<Vec<_>>().join(", ")));
        if below.is_some() {
            strip.append(&label("+", "strip-plus"));
        }
        for a in adds.iter().take(5) {
            strip.append(&img(&catalog::app(a).map(|x| x.icon).unwrap_or_default(), 16));
        }
        if adds.len() > 5 {
            strip.append(&label(&format!("+{}", adds.len() - 5), "strip-more"));
        }
        b.append(&strip);
        root.append(&b);
        return Face { root, name_slot: slot, subs: vec![], blanks: vec![], prompts: vec![] };
    }
    let (b, slot) = bar(layer, &module_name(m), true, false);
    if let Some(tag) = state_tag(state) {
        b.append(&tag);
    }
    if let Some(bl) = below {
        let on = label(&format!("on {}", bl.name), "mod-on");
        b.append(&on);
    }
    root.append(&b);
    let mut face = Face { root: root.clone(), name_slot: slot, subs: vec![], blanks: vec![], prompts: vec![] };
    match m {
        Module::Template(t) => root.append(&template_screen(t, below)),
        Module::Extensions(e) => root.append(&extensions_screen(stack, &e.subs, &mut face)),
        Module::Customization(c) => root.append(&customization_screen(stack, &c.subs, &mut face)),
    }
    if state == Standing::Unbuilt {
        root.add_css_class("dim-screen");
    }
    face
}

fn screen(class: &str) -> gtk::Overlay {
    let o = gtk::Overlay::new();
    o.add_css_class("screen");
    o.add_css_class(class);
    o.set_size_request(-1, SCREEN_H);
    o.set_overflow(gtk::Overflow::Hidden);
    o
}

fn template_screen(t: &TemplateModule, below: Option<&TemplateModule>) -> gtk::Widget {
    let o = screen("screen-template");
    o.set_child(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
    let desk = gtk::Grid::new();
    desk.add_css_class("desk");
    desk.set_row_spacing(8);
    desk.set_column_spacing(4);
    desk.set_halign(gtk::Align::Start);
    desk.set_valign(gtk::Align::Start);
    for (n, id) in t.apps.iter().take(8).enumerate() {
        let Some(a) = catalog::app(id) else { continue };
        let cell = gtk::Box::new(gtk::Orientation::Vertical, 3);
        cell.add_css_class("desk-app");
        cell.set_size_request(60, -1);
        if let Some(bl) = below.filter(|b| b.apps.contains(id)) {
            cell.add_css_class("inherited");
            cell.set_tooltip_text(Some(&format!("From {}", bl.name)));
        }
        cell.append(&img(&a.icon, 30));
        let l = gtk::Label::new(Some(&a.name));
        l.set_ellipsize(gtk::pango::EllipsizeMode::End);
        l.set_max_width_chars(11);
        cell.append(&l);
        desk.attach(&cell, (n / 2) as i32, (n % 2) as i32, 1, 1);
    }
    if t.apps.is_empty() {
        desk.attach(&label("No apps yet: open it to add some", "screen-empty"), 0, 0, 1, 1);
    }
    o.add_overlay(&desk);
    let task = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    task.add_css_class("taskbar");
    task.set_valign(gtk::Align::End);
    let logo = wad_gtk::Svg::new(
        include_bytes!("../../../../client/public/brand/wadspaces-icon-dark-transparent.svg"),
        14,
        14,
    );
    logo.add_css_class("tb-logo");
    task.append(&logo);
    for id in &t.apps {
        task.append(&img(&catalog::app(id).map(|a| a.icon).unwrap_or_default(), 16));
    }
    o.add_overlay(&task);
    o.upcast()
}

/// An Extensions submodule as a little app window.
pub fn app_window(sub: &AppSub, warn: Option<&str>) -> gtk::Box {
    let w = gtk::Box::new(gtk::Orientation::Vertical, 0);
    w.add_css_class("win");
    w.add_css_class(&format!("win-{}", sub.key()));
    if let Some(why) = warn {
        w.add_css_class("warn");
        w.set_tooltip_text(Some(why));
    }
    let (_, app, icon) = app_sub_info(sub.key());
    let b = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    b.add_css_class("win-bar");
    b.append(&img(icon, 11));
    let a = gtk::Label::new(Some(app));
    a.set_hexpand(true);
    a.set_xalign(0.0);
    b.append(&a);
    let count = match sub {
        AppSub::Vscode(v) => v.extensions.len().to_string(),
        AppSub::Browser(x) => format!("{}{}", x.webapps.len(), if x.mode == "focus" { " · focus" } else { "" }),
        AppSub::Tools(t) => t.tools.len().to_string(),
    };
    b.append(&label(&count, "win-count"));
    w.append(&b);
    let body = gtk::Box::new(gtk::Orientation::Vertical, 2);
    body.add_css_class("win-body");
    match sub {
        AppSub::Browser(x) if x.webapps.is_empty() => body.append(&label("No web apps", "win-empty")),
        AppSub::Browser(x) => {
            let grid = gtk::Box::new(gtk::Orientation::Horizontal, 5);
            for wa in x.webapps.iter().take(10) {
                grid.append(&img(&catalog::site_icon(&wa.url), 15));
            }
            body.append(&grid);
        }
        AppSub::Vscode(v) if v.extensions.is_empty() => body.append(&label("No extensions", "win-empty")),
        AppSub::Vscode(v) => {
            for id in v.extensions.iter().take(4) {
                let e = catalog::extension(id);
                let row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
                row.add_css_class("ext");
                match &e.icon {
                    Some(i) => row.append(&img(i, 11)),
                    None => {
                        let d = label(&e.name.chars().next().map(|c| c.to_string()).unwrap_or_default(), "ext-dot");
                        d.set_xalign(0.5);
                        row.append(&d);
                    }
                }
                let n = gtk::Label::new(Some(&e.name));
                n.set_ellipsize(gtk::pango::EllipsizeMode::End);
                n.set_xalign(0.0);
                row.append(&n);
                body.append(&row);
            }
            if v.extensions.len() > 4 {
                body.append(&label(&format!("+{}", v.extensions.len() - 4), "ext-more"));
            }
        }
        AppSub::Tools(t) => {
            let names: Vec<String> = t
                .tools
                .iter()
                .map(|id| catalog::tool_name(id).replace(" CLI", "").replace(" dev tools", "").to_lowercase())
                .collect();
            let l = gtk::Label::new(None);
            l.add_css_class("term");
            let joined = if names.is_empty() { "—".to_string() } else { names.join(" ") };
            l.set_markup(&format!("<span alpha=\"40%\">$</span> {}", gtk::glib::markup_escape_text(&joined)));
            l.set_xalign(0.0);
            l.set_wrap(true);
            body.append(&l);
        }
    }
    w.append(&body);
    w
}

/// An app setup it could have but doesn't: a blank, dashed window.
pub fn blank_window(key: &str) -> gtk::Box {
    let w = gtk::Box::new(gtk::Orientation::Vertical, 0);
    w.add_css_class("win");
    w.add_css_class("blank");
    let (_, app, icon) = app_sub_info(key);
    let b = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    b.add_css_class("win-bar");
    b.append(&img(icon, 11));
    b.append(&gtk::Label::new(Some(app)));
    w.append(&b);
    let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
    body.add_css_class("win-body");
    body.append(&label("+ Set up", "win-empty"));
    w.append(&body);
    w
}

fn extensions_screen(stack: &Stack, subs: &[AppSub], face: &mut Face) -> gtk::Widget {
    let o = screen("screen-extensions");
    o.set_child(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
    let possible = catalog::setups_for(stack.apps());
    let keys: Vec<&'static str> = ["wadbrowser", "vscode", "tools"]
        .into_iter()
        .filter(|k| possible.contains(k) || subs.iter().any(|s| s.key() == *k))
        .collect();
    let wins = gtk::Box::new(gtk::Orientation::Vertical, 6);
    wins.add_css_class("wins");
    wins.set_valign(gtk::Align::Start);
    // WadBrowser's window takes a row; the others share one.
    let mut row: Option<gtk::Box> = None;
    for k in keys {
        let w: gtk::Widget = match subs.iter().find(|s| s.key() == k) {
            Some(sub) => {
                let fit = if k == "tools" { Ok(()) } else { catalog::sub_fits(k, Some(stack.apps())) };
                let w = app_window(sub, fit.err().as_deref());
                face.subs.push((sub.id().to_string(), w.clone().upcast()));
                w.upcast()
            }
            None => {
                let w = blank_window(k);
                face.blanks.push((k, w.clone().upcast()));
                w.upcast()
            }
        };
        if k == "wadbrowser" {
            wins.append(&w);
        } else {
            let r = row.get_or_insert_with(|| {
                let r = gtk::Box::new(gtk::Orientation::Horizontal, 6);
                r.set_homogeneous(true);
                wins.append(&r);
                r
            });
            r.append(&w);
        }
    }
    o.add_overlay(&wins);
    o.upcast()
}

/// Something a customization hasn't set: (the editor section, the words).
fn prompts_for(stack: &Stack, subs: &[CustomSub]) -> (Vec<(&'static str, String)>, bool) {
    let look = subs.iter().find_map(|s| if let CustomSub::Look(l) = s { Some(l) } else { None });
    let folders = subs.iter().find_map(|s| if let CustomSub::Folders(f) = s { Some(f) } else { None });
    let secrets = subs.iter().any(|s| matches!(s, CustomSub::Secrets(_)));
    let (slots, set) = catalog::key_count(stack);
    let mut bar = vec![];
    if look.is_none_or(|l| l.name.trim().is_empty()) {
        bar.push(("look", "+ Name".to_string()));
    }
    if folders.is_none_or(|f| f.mounts.is_empty()) {
        bar.push(("folders", "+ Projects".into()));
    }
    if slots > 0 && (!secrets || set == 0) {
        bar.push(("secrets", format!("+ Secrets 0/{slots}")));
    }
    (bar, is_blank_wallpaper(look.map(|l| &l.wallpaper)))
}

/// A wallpaper (`{type, value}`) drawn to fill its box (a picture, made
/// thumbnail-sized).
pub fn wallpaper_of(w: Option<&serde_json::Value>) -> wad_gtk::Wallpaper {
    wallpaper_sized(w, false)
}

/// A wallpaper drawn to fill its box; `full`: a picture at the screen's size.
pub fn wallpaper_sized(w: Option<&serde_json::Value>, full: bool) -> wad_gtk::Wallpaper {
    let v = wad_gtk::Wallpaper::new();
    let wall: Wallpaper = w
        .and_then(|w| serde_json::from_value(w.clone()).ok())
        .unwrap_or_else(|| Wallpaper { kind: wad_wallpaper::Kind::Gradient, value: wad_board::BLANK_WALLPAPER.into() });
    let paint = wall.paint();
    v.set_paint(&paint);
    if let Paint::Image(src) = &paint {
        let later = images::later(&v, |v, t| v.set_picture(Some(t)));
        if full {
            images::wallpaper_full(src, later);
        } else {
            images::wallpaper(src, later);
        }
    }
    v
}

/// What a submodule is, in a few words: (title, detail).
pub fn sub_summary(sub: &AnySub, stack: Option<&Stack>) -> (String, String) {
    match sub {
        AnySub::App(AppSub::Vscode(v)) => ("VS Code extensions".into(), v.extensions.len().to_string()),
        AnySub::App(AppSub::Browser(b)) => {
            ("Web apps".into(), format!("{}{}", b.webapps.len(), if b.mode == "focus" { " · focus" } else { "" }))
        }
        AnySub::App(AppSub::Tools(t)) => ("Tools".into(), t.tools.len().to_string()),
        AnySub::Custom(CustomSub::Look(l)) => {
            ("Look".into(), if l.name.is_empty() { "Untitled".into() } else { l.name.clone() })
        }
        AnySub::Custom(CustomSub::Folders(f)) => ("Projects".into(), f.mounts.len().to_string()),
        AnySub::Custom(CustomSub::Secrets(s)) => {
            let detail = match stack {
                Some(st) => {
                    let (all, set) = catalog::key_count(st);
                    format!("{set}/{all}")
                }
                None => (s.by_slot.len() + s.groups.iter().flatten().filter(|g| g.key.is_some()).count()).to_string(),
            };
            ("Secrets".into(), detail)
        }
    }
}

fn sub_icon(sub: &AnySub) -> gtk::Widget {
    match sub {
        AnySub::App(a) => img(app_sub_info(a.key()).2, 12).upcast(),
        AnySub::Custom(CustomSub::Look(l)) => {
            let w = wallpaper_of(Some(&l.wallpaper));
            w.add_css_class("swatch");
            w.set_size_request(12, 12);
            w.set_overflow(gtk::Overflow::Hidden);
            w.upcast()
        }
        AnySub::Custom(CustomSub::Folders(_)) => Icon::new("folder", 12).upcast(),
        AnySub::Custom(CustomSub::Secrets(_)) => Icon::new("key-round", 12).upcast(),
    }
}

/// A Customization submodule as a taskbar item.
pub fn tray(sub: &CustomSub, stack: Option<&Stack>) -> gtk::Box {
    let any = AnySub::Custom(sub.clone());
    let (title, detail) = sub_summary(&any, stack);
    let t = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    t.add_css_class("tray");
    t.add_css_class(&format!("tray-{}", sub.key()));
    let i = sub_icon(&any);
    i.add_css_class("tray-icon");
    t.append(&i);
    t.append(&label(&title, "tray-title"));
    if !matches!(sub, CustomSub::Look(_)) {
        t.append(&label(&detail, "tray-detail"));
    }
    t
}

/// A submodule as a compact pill (drag ghosts, Recently deleted).
pub fn chip(sub: &AnySub, stack: Option<&Stack>) -> gtk::Box {
    let (title, detail) = sub_summary(sub, stack);
    let c = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    c.add_css_class("chip");
    c.add_css_class(&format!("chip-{}", sub.key()));
    let i = sub_icon(sub);
    i.add_css_class("chip-icon");
    c.append(&i);
    c.append(&label(&title, "chip-title"));
    let d = label(&detail, "chip-detail");
    d.set_ellipsize(gtk::pango::EllipsizeMode::End);
    d.set_max_width_chars(14);
    c.append(&d);
    c.set_halign(gtk::Align::Start);
    c
}

fn sub_order(key: &str) -> u8 {
    match key {
        "wadbrowser" | "look" => 0,
        "vscode" | "folders" => 1,
        _ => 2,
    }
}

fn prompt(text: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.add_css_class("tray");
    l.add_css_class("prompt");
    l
}

fn customization_screen(stack: &Stack, subs: &[CustomSub], face: &mut Face) -> gtk::Widget {
    let o = screen("screen-customization");
    let look = subs.iter().find_map(|s| if let CustomSub::Look(l) = s { Some(l) } else { None });
    let wall = wallpaper_of(look.map(|l| &l.wallpaper));
    wall.add_css_class("screen-wall");
    o.set_child(Some(&wall));
    let desk = gtk::Grid::new();
    desk.add_css_class("desk-small");
    desk.set_row_spacing(6);
    desk.set_column_spacing(6);
    desk.set_halign(gtk::Align::Start);
    desk.set_valign(gtk::Align::Start);
    for (n, i) in catalog::desktop_of(stack).iter().take(12).enumerate() {
        let im = img(&i.icon, 20);
        im.add_css_class("desk-app-small");
        im.set_tooltip_text(Some(&i.label));
        desk.attach(&im, (n / 3) as i32, (n % 3) as i32, 1, 1);
    }
    o.add_overlay(&desk);
    let (bar, background) = prompts_for(stack, subs);
    if background {
        let p = prompt("Set a background");
        p.add_css_class("bg-prompt");
        p.set_halign(gtk::Align::Center);
        p.set_valign(gtk::Align::Center);
        p.set_margin_bottom(18);
        face.prompts.push(("look", p.clone().upcast()));
        o.add_overlay(&p);
    }
    let task = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    task.add_css_class("taskbar");
    task.add_css_class("tray-bar");
    task.set_valign(gtk::Align::End);
    let mut shown: Vec<&CustomSub> = subs
        .iter()
        .filter(|s| !bar.iter().any(|(f, _)| *f == s.key()))
        .filter(|s| !matches!(s, CustomSub::Look(l) if l.name.trim().is_empty()))
        .collect();
    shown.sort_by_key(|s| sub_order(s.key()));
    for s in shown {
        let t = tray(s, Some(stack));
        face.subs.push((s.id().to_string(), t.clone().upcast()));
        task.append(&t);
    }
    for (focus, text) in bar {
        let p = prompt(&text);
        face.prompts.push((focus, p.clone().upcast()));
        task.append(&p);
    }
    o.add_overlay(&task);
    o.upcast()
}

/// A stack without Extensions: a blank block with the setups it could have.
pub fn blank_extensions(stack: &Stack) -> Face {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.add_css_class("mod");
    root.add_css_class("mod-extensions");
    root.add_css_class("blank-mod");
    root.set_size_request(MOD_W, -1);
    let (b, slot) = bar(Layer::Extensions, "None yet", true, true);
    root.append(&b);
    let mut face = Face { root: root.clone(), name_slot: slot, subs: vec![], blanks: vec![], prompts: vec![] };
    root.append(&extensions_screen(stack, &[], &mut face));
    face
}

/// A stack without a Customization: a blank block showing what it could set.
pub fn blank_customization(stack: &Stack) -> Face {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.add_css_class("mod");
    root.add_css_class("mod-customization");
    root.add_css_class("blank-mod");
    root.set_size_request(MOD_W, -1);
    let (b, slot) = bar(Layer::Customization, "None yet", true, true);
    root.append(&b);
    let mut face = Face { root: root.clone(), name_slot: slot, subs: vec![], blanks: vec![], prompts: vec![] };
    root.append(&customization_screen(stack, &[], &mut face));
    face
}

/// Modules as a stack shows them, top first (drag ghosts, Recently deleted).
pub fn pile(stack: &Stack, modules: &[Module]) -> gtk::Box {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 8);
    b.add_css_class("pile");
    let last_template = modules.iter().rev().find(|m| m.layer() == Layer::Template).map(|m| m.id().to_string());
    for m in modules.iter().rev() {
        let compact = m.layer() == Layer::Template && last_template.as_deref() != Some(m.id());
        b.append(&module(stack, m, compact, Standing::Built).root);
    }
    b
}

/// A drag's ghost, in the board's look (its styles are the board's).
pub fn ghost(w: &impl IsA<gtk::Widget>) -> gtk::Widget {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
    b.add_css_class("wb");
    b.append(w);
    b.upcast()
}
