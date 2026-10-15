//! The template editor (TemplateEditor.tsx): the apps on the left, the
//! desktop in the middle, the picked app's details on the right. Drag apps
//! onto the desktop, move them about on it (the image draws them in this
//! order), drag them back to the left to take them off. A template built on
//! another can't take off the apps it inherits; what's added here reaches
//! the templates above when it's saved.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use gtk::{glib, prelude::*};
use wad_board::catalog::{self, CatalogApp};
use wad_board::*;
use wad_gtk::Icon;

use super::{Editor, field, group_label, icon_note, live_box, note, panel_title, scroller};
use crate::drag::{self, Mods, Payload, Target, Verdict};
use crate::pages::builder::faces::{self, img};
use crate::ui::{self, Size, Variant};

/// The desktop's icons go down the left side, this many to a column.
const ROWS: usize = 5;

thread_local! {
    /// The open editor's apps and desktop (for the snapshots' drags).
    static PARTS: RefCell<(glib::WeakRef<gtk::ScrolledWindow>, glib::WeakRef<gtk::Overlay>)> = RefCell::default();
}

/// The editor's own state: the app picked to read about.
struct Tpl {
    picked: RefCell<Option<String>>,
}

fn draft_of(ed: &Editor) -> TemplateModule {
    match ed.draft() {
        Module::Template(t) => t,
        _ => unreachable!("the template editor edits a template"),
    }
}

/// The template it builds on, in the stack as it'd be.
fn below(ed: &Editor) -> Option<TemplateModule> {
    let live = ed.live();
    faces::below_of(&live, &draft_of(ed)).cloned()
}

fn inherited(ed: &Editor, id: &str) -> bool {
    below(ed).is_some_and(|b| b.apps.iter().any(|a| a == id))
}

fn app_name(id: &str) -> String {
    catalog::app(id).map(|a| a.name).unwrap_or_else(|| id.to_string())
}

/// `apps` with `id` moved from `from` (None: it's new) to before `to`.
fn moved(apps: &[String], id: &str, from: Option<usize>, to: usize) -> Vec<String> {
    let mut next: Vec<String> =
        apps.iter().enumerate().filter(|(i, _)| Some(*i) != from).map(|(_, a)| a.clone()).collect();
    let at = if from.is_some_and(|f| f < to) { to - 1 } else { to };
    next.insert(at.min(next.len()), id.to_string());
    next
}

fn move_to(ed: &Rc<Editor>, tpl: &Tpl, id: &str, from: Option<usize>, to: usize) {
    let mut t = draft_of(ed);
    t.apps = moved(&t.apps, id, from, to);
    tpl.picked.replace(Some(id.to_string()));
    ed.set(Module::Template(t));
}

fn remove(ed: &Rc<Editor>, id: &str) {
    if inherited(ed, id) {
        return;
    }
    let mut t = draft_of(ed);
    t.apps.retain(|a| a != id);
    ed.set(Module::Template(t));
}

pub fn build(ed: &Rc<Editor>) -> gtk::Widget {
    let t = draft_of(ed);
    let tpl = Rc::new(Tpl { picked: RefCell::new(t.apps.first().cloned()) });
    ed.keep(tpl.clone());
    let root = gtk::Box::new(gtk::Orientation::Horizontal, 14);
    root.add_css_class("tpl-editor");

    // The apps, with the name and description over them.
    let pal = gtk::Box::new(gtk::Orientation::Vertical, 0);
    pal.add_css_class("palette-col");
    let name = ui::entry("Template name");
    name.set_text(&t.name);
    let w = Rc::downgrade(ed);
    name.connect_changed(move |e| {
        if let Some(ed) = w.upgrade() {
            let mut t = draft_of(&ed);
            t.name = e.text().to_string();
            ed.set_quiet(Module::Template(t));
        }
    });
    pal.append(&field("Template name", &name));
    let desc = gtk::TextView::new();
    desc.set_wrap_mode(gtk::WrapMode::WordChar);
    // A few lines (a text view's own height is wrong while it's narrow).
    let desc_box = gtk::ScrolledWindow::new();
    desc_box.add_css_class("textarea");
    desc_box.set_hscrollbar_policy(gtk::PolicyType::Never);
    desc_box.set_min_content_height(56);
    desc_box.set_max_content_height(110);
    desc_box.set_propagate_natural_height(true);
    desc_box.set_child(Some(&desc));
    desc.buffer().set_text(&t.description);
    let w = Rc::downgrade(ed);
    desc.buffer().connect_changed(move |b| {
        if let Some(ed) = w.upgrade() {
            let mut t = draft_of(&ed);
            t.description = b.text(&b.start_iter(), &b.end_iter(), false).to_string();
            ed.set_quiet(Module::Template(t));
        }
    });
    pal.append(&field("Description", &desc_box));
    let apps_title = panel_title("Apps");
    apps_title.set_margin_top(4);
    pal.append(&apps_title);
    let n = note("Drag an app onto the desktop. Drag one back here to take it out.");
    n.set_margin_bottom(8);
    pal.append(&n);
    let groups = gtk::Box::new(gtk::Orientation::Vertical, 10);
    let tp = tpl.clone();
    live_box(ed, &groups, move |ed, b| palette(ed, &tp, b));
    pal.append(&groups);
    let pal_scroll = scroller(&pal);
    pal_scroll.add_css_class("panel");
    pal_scroll.add_css_class("palette");
    drag::target(&pal_scroll, PaletteTarget(Rc::downgrade(ed)));
    root.append(&wad_gtk::Width::new(&pal_scroll, 250));

    // The desktop, and what's to know about it.
    let stage = gtk::Box::new(gtk::Orientation::Vertical, 10);
    stage.add_css_class("tpl-stage");
    stage.set_hexpand(true);
    let desktop = gtk::Overlay::new();
    desktop.add_css_class("desktop");
    desktop.add_css_class("desktop-template");
    desktop.set_vexpand(true);
    desktop.set_overflow(gtk::Overflow::Hidden);
    desktop.set_child(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
    let grid = gtk::Box::new(gtk::Orientation::Vertical, 0);
    grid.set_halign(gtk::Align::Start);
    grid.set_valign(gtk::Align::Start);
    grid.set_margin_start(14);
    grid.set_margin_top(14);
    let tp = tpl.clone();
    live_box(ed, &grid, move |ed, b| desk(ed, &tp, b));
    desktop.add_overlay(&grid);
    let bar = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    bar.set_valign(gtk::Align::End);
    bar.append(&taskbar());
    desktop.add_overlay(&bar);
    drag::target(&desktop, DeskTarget(Rc::downgrade(ed), tpl.clone()));
    PARTS.with(|p| {
        let p = p.borrow();
        p.0.set(Some(&pal_scroll));
        p.1.set(Some(&desktop));
    });
    stage.append(&desktop);
    let notes = gtk::Box::new(gtk::Orientation::Vertical, 4);
    notes.add_css_class("stage-notes");
    live_box(ed, &notes, stage_notes);
    stage.append(&notes);
    root.append(&stage);

    // The picked app.
    let detail = gtk::Box::new(gtk::Orientation::Vertical, 6);
    detail.add_css_class("panel");
    detail.add_css_class("app-detail");
    let tp = tpl.clone();
    live_box(ed, &detail, move |ed, b| app_detail(ed, &tp, b));
    root.append(&wad_gtk::Width::new(&detail, 230));
    root.upcast()
}

fn palette(ed: &Rc<Editor>, tpl: &Rc<Tpl>, b: &gtk::Box) {
    let all = catalog::apps();
    let on = draft_of(ed).apps;
    let mut cats: Vec<String> = vec![];
    for a in &all {
        if !cats.contains(&a.category) {
            cats.push(a.category.clone());
        }
    }
    for c in cats {
        let g = gtk::Box::new(gtk::Orientation::Vertical, 6);
        g.append(&group_label(&c));
        let grid = gtk::FlowBox::new();
        grid.add_css_class("palette-grid");
        grid.set_selection_mode(gtk::SelectionMode::None);
        grid.set_homogeneous(true);
        grid.set_min_children_per_line(3);
        grid.set_max_children_per_line(3);
        grid.set_column_spacing(6);
        grid.set_row_spacing(6);
        for a in all.iter().filter(|a| a.category == c) {
            grid.insert(&palette_app(ed, tpl, a, on.contains(&a.id)), -1);
        }
        g.append(&grid);
        b.append(&g);
    }
}

fn desk_face(id: &str, icon: &str) -> gtk::Box {
    let d = gtk::Box::new(gtk::Orientation::Vertical, 4);
    d.add_css_class("desk-icon");
    let i = img(icon, 44);
    i.set_halign(gtk::Align::Center);
    d.append(&i);
    let l = gtk::Label::new(Some(&app_name(id)));
    l.set_ellipsize(gtk::pango::EllipsizeMode::End);
    l.set_max_width_chars(12);
    l.set_justify(gtk::Justification::Center);
    d.append(&l);
    d
}

/// An app's ghost while it's dragged.
fn ghost(id: &str) -> gtk::Widget {
    let icon = catalog::app(id).map(|a| a.icon).unwrap_or_default();
    let g = desk_face(id, &icon);
    g.add_css_class("ghosted");
    faces::ghost(&g)
}

fn palette_app(ed: &Rc<Editor>, tpl: &Rc<Tpl>, a: &CatalogApp, on: bool) -> gtk::Widget {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 4);
    b.add_css_class("palette-app");
    let i = img(&a.icon, 30);
    i.set_halign(gtk::Align::Center);
    b.append(&i);
    let l = gtk::Label::new(Some(&a.name));
    l.set_ellipsize(gtk::pango::EllipsizeMode::End);
    l.set_max_width_chars(9);
    b.append(&l);
    if on {
        b.add_css_class("on");
        b.set_tooltip_text(Some("On the desktop"));
    } else {
        b.set_tooltip_text(Some(&a.summary));
        let id = a.id.clone();
        drag::draggable(&b, move |_| Some((Payload::App { app_id: id.clone(), at: None }, ghost(&id))));
    }
    pick_on_click(ed, tpl, &b, &a.id);
    b.upcast()
}

fn pick_on_click(ed: &Rc<Editor>, tpl: &Rc<Tpl>, w: &impl IsA<gtk::Widget>, id: &str) {
    let click = gtk::GestureClick::new();
    let (w2, tp, id) = (Rc::downgrade(ed), tpl.clone(), id.to_string());
    click.connect_released(move |_, _, _, _| {
        if let Some(ed) = w2.upgrade() {
            tp.picked.replace(Some(id.clone()));
            ed.redraw();
        }
    });
    w.add_controller(click);
}

fn desk(ed: &Rc<Editor>, tpl: &Rc<Tpl>, b: &gtk::Box) {
    let apps = draft_of(ed).apps;
    let grid = gtk::Grid::new();
    grid.add_css_class("desk-grid");
    grid.set_column_spacing(6);
    grid.set_row_spacing(6);
    let picked = tpl.picked.borrow().clone();
    for (n, id) in apps.iter().enumerate() {
        let cell = desk_app(ed, tpl, id, n, picked.as_deref() == Some(id));
        grid.attach(&cell, (n / ROWS) as i32, (n % ROWS) as i32, 1, 1);
    }
    // While an app's dragged: where it'd go.
    let next = gtk::Box::new(gtk::Orientation::Vertical, 0);
    next.add_css_class("desk-cell");
    next.add_css_class("next-spot");
    next.set_size_request(98, 90);
    let l = gtk::Label::new(Some("Next spot"));
    l.set_vexpand(true);
    next.append(&l);
    let n = apps.len();
    grid.attach(&next, (n / ROWS) as i32, (n % ROWS) as i32, 1, 1);
    b.append(&grid);
}

fn desk_app(ed: &Rc<Editor>, tpl: &Rc<Tpl>, id: &str, at: usize, picked: bool) -> gtk::Widget {
    let cell = gtk::Box::new(gtk::Orientation::Vertical, 0);
    cell.add_css_class("desk-cell");
    cell.set_size_request(98, 90);
    let icon = catalog::app(id).map(|a| a.icon).unwrap_or_default();
    let face = desk_face(id, &icon);
    face.set_valign(gtk::Align::Center);
    face.set_halign(gtk::Align::Center);
    face.set_vexpand(true);
    if picked {
        face.add_css_class("picked");
    }
    let o = gtk::Overlay::new();
    o.set_child(Some(&face));
    o.set_halign(gtk::Align::Center);
    o.set_valign(gtk::Align::Center);
    o.set_vexpand(true);
    let locked = inherited(ed, id);
    if locked {
        let l = gtk::Box::new(gtk::Orientation::Vertical, 0);
        l.add_css_class("desk-lock");
        l.append(&Icon::new("lock", 9));
        l.set_halign(gtk::Align::End);
        l.set_valign(gtk::Align::Start);
        l.set_tooltip_text(Some("From the template this builds on"));
        o.add_overlay(&l);
        face.add_css_class("locked");
    } else {
        let x = gtk::Button::new();
        x.add_css_class("desk-x");
        x.set_child(Some(&Icon::new("x", 10)));
        x.set_tooltip_text(Some("Take off"));
        x.set_halign(gtk::Align::End);
        x.set_valign(gtk::Align::Start);
        let (w, id2) = (Rc::downgrade(ed), id.to_string());
        x.connect_clicked(move |_| {
            if let Some(ed) = w.upgrade() {
                remove(&ed, &id2);
            }
        });
        o.add_overlay(&x);
    }
    cell.append(&o);
    let id2 = id.to_string();
    drag::draggable(&face, move |_| Some((Payload::App { app_id: id2.clone(), at: Some(at) }, ghost(&id2))));
    pick_on_click(ed, tpl, &face, id);
    drag::target(&cell, DeskAppTarget { ed: Rc::downgrade(ed), tpl: tpl.clone(), id: id.to_string(), at });
    cell.upcast()
}

/// The desktop's taskbar: just its clock (the apps are on the desktop).
fn taskbar() -> gtk::Box {
    let t = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    t.add_css_class("desk-taskbar");
    t.set_hexpand(true);
    let clock = gtk::Label::new(Some("9:41"));
    clock.set_hexpand(true);
    clock.set_xalign(1.0);
    clock.add_css_class("tb-clock");
    t.append(&clock);
    t
}

fn stage_notes(ed: &Rc<Editor>, b: &gtk::Box) {
    let live = ed.live();
    let t = draft_of(ed);
    if let Some(bl) = below(ed) {
        let n = bl.apps.len();
        b.append(&icon_note(
            "lock",
            &format!(
                "Builds on {}: its {n} app{} locked here; add more on top.",
                bl.name,
                if n == 1 { " is" } else { "s are" }
            ),
            "chain-note",
        ));
    }
    let at = live.templates.iter().position(|x| x.id == t.id).map(|i| i + 1).unwrap_or(live.templates.len());
    let above: Vec<&TemplateModule> = live.templates[at..].iter().collect();
    if !above.is_empty() {
        let names: Vec<&str> = above.iter().map(|t| t.name.as_str()).collect();
        let one = above.len() == 1;
        b.append(&icon_note(
            "layers",
            &format!(
                "{} build{} on this: any app added here reaches {} too.",
                names.join(", "),
                if one { "s" } else { "" },
                if one { "it" } else { "them" }
            ),
            "chain-note",
        ));
    }
    // Saved, it goes on top of the templates elsewhere whose apps it has
    // (a new one in an empty stack, or the bottom one given other apps).
    let own = ed.stack();
    let bottom = match ed.original() {
        None => own.templates.is_empty(),
        Some(Module::Template(o)) => own.templates.first().is_some_and(|x| x.id == o.id) && !board::same_apps(&o, &t),
        Some(_) => false,
    };
    if bottom && !t.apps.is_empty() {
        let others: Vec<Stack> =
            crate::pages::builder::state::read(|s| s.board.stacks.iter().filter(|x| x.id != own.id).cloned().collect());
        let chain = board::chain_under(&t, &others);
        if !chain.is_empty() {
            let names: Vec<&str> = chain.iter().map(|c| c.name.as_str()).collect();
            let one = chain.len() == 1;
            b.append(&icon_note(
                "layers",
                &format!(
                    "Saved, it goes on top of {}: it has all of {} apps.",
                    names.join(" → "),
                    if one { format!("{}'s", names[0]) } else { "their".into() }
                ),
                "chain-note",
            ));
        }
    }
    let l = ui::wrapping(
        "Just this template's apps, in the order the desktop shows them. Preview a stack to see it finished.",
    );
    b.append(&l);
    let mut lost = vec![];
    if !live.has_app("vscode") && live.vscode().is_some() {
        lost.push("VS Code extensions");
    }
    if !live.has_app("wadbrowser") && live.browser().is_some() {
        lost.push("WadBrowser apps");
    }
    if !lost.is_empty() {
        b.append(&icon_note(
            "triangle-alert",
            &format!("Without those apps, this stack's {} won't apply.", lost.join(" and ")),
            "warn-note",
        ));
    }
}

fn app_detail(ed: &Rc<Editor>, tpl: &Rc<Tpl>, b: &gtk::Box) {
    let picked = tpl.picked.borrow().clone();
    let Some(a) = picked.as_deref().and_then(catalog::app) else {
        b.append(&note("Pick an app to see what it brings."));
        return;
    };
    let i = img(&a.icon, 56);
    i.add_css_class("detail-icon");
    i.set_halign(gtk::Align::Start);
    b.append(&i);
    b.append(&panel_title(&a.name));
    b.append(&note(&a.summary));
    let facts = gtk::Grid::new();
    facts.add_css_class("facts");
    facts.set_column_spacing(10);
    facts.set_row_spacing(4);
    let layer = match a.layer.as_deref() {
        Some("vscode") => "Extensions",
        Some(_) => "Web apps and mode",
        None => "None",
    };
    let secret = if a.secret.is_some() { "Yes (a secret slot)" } else { "No" };
    for (n, (k, v)) in [("Category", a.category.as_str()), ("Customization layer", layer), ("Keeps a sign-in", secret)]
        .into_iter()
        .enumerate()
    {
        let kl = gtk::Label::new(Some(k));
        kl.add_css_class("fact-name");
        kl.set_xalign(0.0);
        kl.set_valign(gtk::Align::Start);
        facts.attach(&kl, 0, n as i32, 1, 1);
        let vl = ui::wrapping(v);
        facts.attach(&vl, 1, n as i32, 1, 1);
    }
    b.append(&facts);
    let on = draft_of(ed).apps.contains(&a.id);
    if inherited(ed, &a.id) {
        let from = below(ed).map(|b| b.name).unwrap_or_default();
        b.append(&icon_note("lock", &format!("From {from}, the template this builds on"), "chain-note"));
    } else if on {
        let x = ui::button("Take off the desktop", None, Variant::Ghost, Size::Sm);
        x.set_halign(gtk::Align::Start);
        let (w, id) = (Rc::downgrade(ed), a.id.clone());
        x.connect_clicked(move |_| {
            if let Some(ed) = w.upgrade() {
                remove(&ed, &id);
            }
        });
        b.append(&x);
    } else {
        let add = ui::button("Add to the desktop", None, Variant::Primary, Size::Sm);
        add.set_halign(gtk::Align::Start);
        let (w, tp, id) = (Rc::downgrade(ed), tpl.clone(), a.id.clone());
        add.connect_clicked(move |_| {
            if let Some(ed) = w.upgrade() {
                let n = draft_of(&ed).apps.len();
                move_to(&ed, &tp, &id, None, n);
            }
        });
        b.append(&add);
    }
}

// ─────────────────────────────── drops ───────────────────────────────

/// The apps on the left: an app from the desktop dropped here comes off it.
struct PaletteTarget(Weak<Editor>);

impl Target for PaletteTarget {
    fn accepts(&self, p: &Payload, _m: Mods, _at: (f64, f64)) -> Option<Verdict> {
        let Payload::App { app_id, at: Some(_) } = p else { return None };
        let ed = self.0.upgrade()?;
        if inherited(&ed, app_id) {
            let from = below(&ed).map(|b| b.name).unwrap_or_default();
            return Verdict::no(format!("{} comes from {from}, the template this builds on", app_name(app_id)));
        }
        Verdict::yes(format!("Take {} off the desktop", app_name(app_id)))
    }

    fn land(&self, p: &Payload, _m: Mods, _at: (f64, f64)) {
        if let (Payload::App { app_id, .. }, Some(ed)) = (p, self.0.upgrade()) {
            remove(&ed, app_id);
        }
    }
}

/// The desktop: an app dropped anywhere on it takes the next spot.
struct DeskTarget(Weak<Editor>, Rc<Tpl>);

impl Target for DeskTarget {
    fn accepts(&self, p: &Payload, _m: Mods, _at: (f64, f64)) -> Option<Verdict> {
        let Payload::App { app_id, at } = p else { return None };
        let ed = self.0.upgrade()?;
        let n = draft_of(&ed).apps.len();
        match at {
            None => Verdict::yes(format!("Add {}", app_name(app_id))),
            Some(i) if *i + 1 == n => None,
            Some(_) => Verdict::yes("Move to the end"),
        }
    }

    fn land(&self, p: &Payload, _m: Mods, _at: (f64, f64)) {
        let Payload::App { app_id, at } = p else { return };
        let Some(ed) = self.0.upgrade() else { return };
        let n = draft_of(&ed).apps.len();
        move_to(&ed, &self.1, app_id, *at, n);
    }
}

/// An app on the desktop: one dropped on it goes just before it.
struct DeskAppTarget {
    ed: Weak<Editor>,
    tpl: Rc<Tpl>,
    id: String,
    at: usize,
}

impl Target for DeskAppTarget {
    fn accepts(&self, p: &Payload, _m: Mods, _at: (f64, f64)) -> Option<Verdict> {
        let Payload::App { app_id, at } = p else { return None };
        if *app_id == self.id {
            return None;
        }
        let name = app_name(&self.id);
        match at {
            None => Verdict::yes(format!("Add {} before {name}", app_name(app_id))),
            Some(_) => Verdict::yes(format!("Move before {name}")),
        }
    }

    fn land(&self, p: &Payload, _m: Mods, _at: (f64, f64)) {
        if let (Payload::App { app_id, at }, Some(ed)) = (p, self.ed.upgrade()) {
            move_to(&ed, &self.tpl, app_id, *at, self.at);
        }
    }
}

/// A drag made by hand, for the snapshots: an app from the left onto the
/// desktop.
pub mod sim {
    use super::*;

    pub fn pick_up(app_id: &str) -> bool {
        let Some(pal) = PARTS.with(|p| p.borrow().0.upgrade()) else { return false };
        let payload = Payload::App { app_id: app_id.into(), at: None };
        drag::sim::begin(&pal, payload, ghost(app_id));
        true
    }

    pub fn over_desktop() {
        if let Some(d) = PARTS.with(|p| p.borrow().1.upgrade()) {
            drag::sim::over(&d, 0.0, 360.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn apps_move_before_where_theyre_dropped() {
        let apps = v(&["a", "b", "c", "d"]);
        // New: at the end, or before one.
        assert_eq!(moved(&apps, "e", None, 4), v(&["a", "b", "c", "d", "e"]));
        assert_eq!(moved(&apps, "e", None, 1), v(&["a", "e", "b", "c", "d"]));
        // Along: before the one it's dropped on.
        assert_eq!(moved(&apps, "a", Some(0), 3), v(&["b", "c", "a", "d"]));
        assert_eq!(moved(&apps, "d", Some(3), 0), v(&["d", "a", "b", "c"]));
        // To the end.
        assert_eq!(moved(&apps, "b", Some(1), 4), v(&["a", "c", "d", "b"]));
    }
}
