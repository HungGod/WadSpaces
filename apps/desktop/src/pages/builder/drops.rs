//! What drags do on the board (Board.tsx's targets): modules dropped on a
//! stack copy there (replacing a layer it has); held between two stacks (or
//! dropped after the last) they start a new stack; dropped on another
//! stack's template they start one beside it, on a copy of that template,
//! when the stack itself would have to replace something. Submodules drop
//! into their module. Build builds a dropped wadspace; Delete deletes what's
//! dropped on it. Recently deleted's entries drag back out.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gtk::{glib, prelude::*};
use wad_board::board::{From, SubFrom};
use wad_board::*;

use super::{faces, state};
use crate::drag::{self, Mods, Payload, Target, Verdict};
use crate::store::store;
use crate::ui;

/// What dropping modules does: deleted ones are restored, others copied.
fn verb(from: &From) -> &'static str {
    if matches!(from, From::Deleted { .. }) { "Restore" } else { "Copy" }
}

fn modules_label(ms: &[Module]) -> String {
    match ms {
        [m] => m.layer().label().to_string(),
        _ => format!("{} modules", ms.len()),
    }
}

/// A stack's column: modules dropped on it copy there.
pub struct StackTarget(pub String);

impl Target for StackTarget {
    fn accepts(&self, p: &Payload, _m: Mods, at: (f64, f64)) -> Option<Verdict> {
        let Payload::Modules { modules, from } = p else { return None };
        // Its left edge is the gap's (a new stack there).
        if at.0 < 30.0 {
            return None;
        }
        state::read(|s| {
            let stack = s.board.stack(&self.0)?;
            Some(match s.board.can_place(modules, &self.0, from) {
                Ok(replaces) => Verdict {
                    ok: true,
                    why: Some(format!(
                        "{} {} to {}{}",
                        verb(from),
                        modules_label(modules),
                        stack_name(stack),
                        replaces.map(|r| format!(" (replaces {r})")).unwrap_or_default()
                    )),
                },
                Err(why) => Verdict { ok: false, why },
            })
        })
    }

    fn land(&self, p: &Payload, _m: Mods, _at: (f64, f64)) {
        if let Payload::Modules { modules, from } = p {
            let n = state::edit(|b| b.place_modules(modules, from, &self.0, false));
            state::tell(n);
        }
    }
}

/// The row's gaps (between stacks, and the open board after the last):
/// hold a dragged module in a gap and it opens into a slot for a new stack.
pub struct GapsTarget {
    pub row: glib::WeakRef<gtk::Box>,
    open: Rc<Cell<Option<usize>>>,
    near: Rc<Cell<Option<usize>>>,
    timer: Rc<RefCell<Option<glib::SourceId>>>,
}

impl GapsTarget {
    pub fn new(row: &gtk::Box) -> Self {
        GapsTarget { row: row.downgrade(), open: Rc::default(), near: Rc::default(), timer: Rc::default() }
    }

    fn gaps(row: &gtk::Box) -> Vec<gtk::Widget> {
        std::iter::successors(row.first_child(), |w| w.next_sibling()).filter(|w| w.has_css_class("gap")).collect()
    }

    /// The gap the pointer's in (it reaches 30 px into each stack), or the
    /// open board after the last stack (`len`).
    fn which(row: &gtk::Box, x: f64) -> Option<usize> {
        let gaps = Self::gaps(row);
        for (i, g) in gaps.iter().enumerate() {
            let Some(b) = g.compute_bounds(row) else { continue };
            let (l, r) = (b.x() as f64 - 30.0, (b.x() + b.width()) as f64 + 30.0);
            if x >= l && x <= r {
                return Some(i);
            }
        }
        let last = std::iter::successors(row.last_child(), |w| w.prev_sibling()).find(|w| w.has_css_class("stack-col"));
        match last.and_then(|l| l.compute_bounds(row)) {
            Some(b) if x > (b.x() + b.width()) as f64 - 2.0 => Some(gaps.len()),
            None => Some(0),
            _ => None,
        }
    }

    fn set_open(row: &gtk::Box, open: Option<usize>) {
        for (i, g) in Self::gaps(row).iter().enumerate() {
            let on = open == Some(i);
            let Some(b) = g.downcast_ref::<gtk::Box>() else { continue };
            if on == b.has_css_class("open") {
                continue;
            }
            ui::clear(b);
            if on {
                b.add_css_class("open");
                b.set_size_request(210, -1);
                let slot = gtk::Box::new(gtk::Orientation::Vertical, 8);
                slot.add_css_class("gap-slot");
                slot.set_vexpand(true);
                slot.set_hexpand(true);
                let i = wad_gtk::Icon::new("plus", 18);
                i.set_valign(gtk::Align::End);
                i.set_vexpand(true);
                slot.append(&i);
                let l = gtk::Label::new(Some("New stack here"));
                l.set_valign(gtk::Align::Start);
                l.set_vexpand(true);
                slot.append(&l);
                b.append(&slot);
            } else {
                b.remove_css_class("open");
                b.set_size_request(22, -1);
            }
        }
    }
}

impl Target for GapsTarget {
    fn accepts(&self, p: &Payload, _m: Mods, at: (f64, f64)) -> Option<Verdict> {
        let Payload::Modules { modules, from } = p else { return None };
        // Only with a pointer (it opens a gap where it is).
        if at.0.is_nan() {
            return None;
        }
        let row = self.row.upgrade()?;
        let i = Self::which(&row, at.0)?;
        let last = Self::gaps(&row).len();
        let says = format!("{} {} into a new stack here", verb(from), modules_label(modules));
        if i == last {
            return Verdict::yes(says);
        }
        if self.near.replace(Some(i)) != Some(i) {
            // Held here a moment, it opens.
            if let Some(t) = self.timer.borrow_mut().take() {
                t.remove();
            }
            if self.open.get() != Some(i) {
                let (open, timer, w) = (self.open.clone(), self.timer.clone(), self.row.clone());
                let id = glib::timeout_add_local_once(Duration::from_millis(320), move || {
                    timer.borrow_mut().take();
                    open.set(Some(i));
                    if let Some(row) = w.upgrade() {
                        Self::set_open(&row, Some(i));
                    }
                    drag::refresh();
                });
                self.timer.replace(Some(id));
            }
        }
        if self.open.get() == Some(i) {
            Verdict::yes(says)
        } else {
            Verdict::no("Hold here to make room for a new stack")
        }
    }

    fn land(&self, p: &Payload, _m: Mods, at: (f64, f64)) {
        let Payload::Modules { modules, from } = p else { return };
        let Some(row) = self.row.upgrade() else { return };
        let Some(i) = Self::which(&row, at.0) else { return };
        let id = state::edit(|b| b.new_stack(modules, from, i, false, &[]));
        state::set_created(id);
    }

    fn hover(&self, on: bool) {
        if on {
            return;
        }
        self.near.set(None);
        if let Some(t) = self.timer.borrow_mut().take() {
            t.remove();
        }
        // It stays open a moment after the pointer slips off.
        let (open, w) = (self.open.clone(), self.row.clone());
        let close = move || {
            open.set(None);
            if let Some(row) = w.upgrade() {
                Self::set_open(&row, None);
            }
        };
        if drag::active() {
            glib::timeout_add_local_once(Duration::from_millis(450), close);
        } else {
            close();
        }
    }
}

/// A module on the board: submodules drop into it; modules dropped on a
/// template of another stack start a new one beside it when the stack
/// itself would have to replace something.
pub struct ModuleTarget {
    pub stack_id: String,
    pub module: Module,
}

impl ModuleTarget {
    /// The templates up to this one (what a new stack beside starts on).
    fn base(&self, stack: &Stack) -> Vec<TemplateModule> {
        match &self.module {
            Module::Template(t) => {
                let at = stack.templates.iter().position(|x| x.id == t.id).map(|i| i + 1).unwrap_or(0);
                stack.templates[..at].to_vec()
            }
            _ => vec![],
        }
    }
}

impl Target for ModuleTarget {
    fn accepts(&self, p: &Payload, _m: Mods, _at: (f64, f64)) -> Option<Verdict> {
        state::read(|s| {
            let stack = s.board.stack(&self.stack_id)?;
            match p {
                Payload::Modules { modules, from } => {
                    let Module::Template(t) = &self.module else { return None };
                    if matches!(from, From::Stack { stack_id } if *stack_id == self.stack_id) {
                        return None;
                    }
                    // Only when the stack would have to replace something.
                    let replaces = s.board.can_place(modules, &self.stack_id, from).ok().flatten();
                    if replaces.is_none() || s.board.can_start(modules, &self.base(stack)).is_err() {
                        return None;
                    }
                    Verdict::yes(format!(
                        "New stack beside {}: {} on a copy of {}",
                        stack_name(stack),
                        modules_label(modules),
                        t.name
                    ))
                }
                Payload::Sub { sub, from } => {
                    let layer = self.module.layer();
                    match s.board.can_place_sub(sub, &self.stack_id, layer, from) {
                        Err(None) => None,
                        Err(Some(why)) => Verdict::no(why),
                        Ok(()) => {
                            let replaces = match &self.module {
                                Module::Extensions(e) => e.subs.iter().any(|x| x.key() == sub.key()),
                                Module::Customization(c) => c.subs.iter().any(|x| x.key() == sub.key()),
                                Module::Template(_) => false,
                            };
                            let how = if matches!(from, SubFrom::Deleted { .. }) { "Restore" } else { "Copy" };
                            Verdict::yes(format!(
                                "{how} {} here{}",
                                faces::sub_summary(sub, None).0,
                                if replaces { " (replaces this one's)" } else { "" }
                            ))
                        }
                    }
                }
                _ => None,
            }
        })
    }

    fn land(&self, p: &Payload, _m: Mods, _at: (f64, f64)) {
        match p {
            Payload::Modules { modules, from } => {
                let base = state::read(|s| s.board.stack(&self.stack_id).map(|st| self.base(st))).unwrap_or_default();
                let at = state::read(|s| s.board.stacks.iter().position(|x| x.id == self.stack_id))
                    .map(|i| i + 1)
                    .unwrap_or(0);
                let id = state::edit(|b| b.new_stack(modules, from, at, false, &base));
                state::set_created(id);
            }
            Payload::Sub { sub, from } => {
                let layer = self.module.layer();
                state::edit(|b| b.place_sub(sub, from, &self.stack_id, layer, false));
            }
            _ => {}
        }
    }
}

/// Build, along the bottom: a dropped wadspace builds what it hasn't.
pub struct BuildTarget;

impl Target for BuildTarget {
    fn accepts(&self, p: &Payload, _m: Mods, _at: (f64, f64)) -> Option<Verdict> {
        match p {
            Payload::Sub { .. } => Verdict::no("Drop the module (or its stack) to build it"),
            Payload::Modules { modules, from } => {
                let From::Stack { stack_id } = from else { return Verdict::no("Not on the board") };
                if modules.iter().all(|m| m.layer() == Layer::Customization) {
                    return Verdict::no("Customizations don't need building");
                }
                let stack = state::read(|s| s.board.stack(stack_id).cloned())?;
                let name = stack_name(&stack);
                store().read_now(|s| {
                    let (unbuilt, updates) = state::counts(&stack, s);
                    let todo = unbuilt + updates;
                    if state::stack_building(&stack, s) {
                        Verdict::no(format!("{name} is building"))
                    } else if todo == 0 {
                        Verdict::no(format!("{name} is built and up to date"))
                    } else if stack.apps().is_empty() {
                        Verdict::no(format!("{name} needs a template to build on"))
                    } else if !catalog::problems_of(&stack).is_empty() {
                        Verdict::no(format!("Fix {name}'s configuration first"))
                    } else if stack.look().is_none_or(|l| l.name.trim().is_empty()) {
                        Verdict::no(format!("{name} needs a named Customization"))
                    } else {
                        Verdict::yes(format!("Build {name}: {todo} image{}", if todo == 1 { "" } else { "s" }))
                    }
                })
            }
            _ => None,
        }
    }

    fn land(&self, p: &Payload, _m: Mods, _at: (f64, f64)) {
        if let Payload::Modules { from: From::Stack { stack_id }, .. } = p {
            state::build_stack(stack_id);
        }
    }
}

/// Delete, along the bottom: what's dropped goes to Recently deleted (a
/// whole stack asks first).
pub struct DeleteTarget;

impl Target for DeleteTarget {
    fn accepts(&self, p: &Payload, _m: Mods, _at: (f64, f64)) -> Option<Verdict> {
        match p {
            Payload::Modules { modules, from } => {
                let From::Stack { stack_id } = from else { return Verdict::no("Not on the board") };
                let stack = state::read(|s| s.board.stack(stack_id).cloned());
                let whole = stack
                    .as_ref()
                    .is_some_and(|st| st.modules().iter().all(|m| modules.iter().any(|x| x.id() == m.id())));
                Verdict::yes(if whole {
                    format!(
                        "Delete {}, the whole stack…",
                        stack.map(|s| stack_name(&s)).unwrap_or_else(|| "the stack".into())
                    )
                } else {
                    format!("Delete {}", modules_label(modules))
                })
            }
            Payload::Sub { sub, from } => match from {
                SubFrom::Module { .. } => Verdict::yes(format!("Delete {}", faces::sub_summary(sub, None).0)),
                SubFrom::Deleted { .. } => Verdict::no("Already deleted"),
            },
            _ => None,
        }
    }

    fn land(&self, p: &Payload, _m: Mods, _at: (f64, f64)) {
        match p {
            Payload::Modules { modules, from } => {
                let n = state::edit(|b| b.delete_modules(modules, from));
                state::tell(n);
                super::confirm_if_asked();
            }
            Payload::Sub { sub, from } => {
                let n = state::edit(|b| b.delete_sub(sub, from));
                state::tell(n);
            }
            _ => {}
        }
    }
}

/// A stack holding just these modules (to draw ones not on the board).
pub fn stack_of(modules: &[Module]) -> Stack {
    let mut s = Stack::new("ghost");
    for m in modules {
        match m {
            Module::Template(t) => s.templates.push(t.clone()),
            Module::Extensions(e) => s.extensions = Some(e.clone()),
            Module::Customization(c) => s.customization = Some(c.clone()),
        }
    }
    s
}

/// Recently deleted, over the board above Delete: entries drag back out.
pub fn deleted_panel() -> gtk::Box {
    let panel = gtk::Box::new(gtk::Orientation::Vertical, 8);
    panel.add_css_class("wb");
    panel.add_css_class("deleted-pop");
    panel.set_size_request(360, -1);
    panel.set_halign(gtk::Align::Center);
    panel.set_valign(gtk::Align::End);
    panel.set_margin_bottom(74);
    panel.set_margin_start(400);
    panel.set_visible(false);
    panel
}

pub fn fill_deleted(panel: &gtk::Box) {
    ui::clear(panel);
    let deleted = state::read(|s| s.board.deleted.clone());
    let orphans = store().read_now(state::orphans);
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let t = gtk::Label::new(Some("Recently deleted"));
    t.add_css_class("strong");
    t.set_hexpand(true);
    t.set_xalign(0.0);
    head.append(&t);
    if !deleted.is_empty() || !orphans.is_empty() {
        let empty = ui::button("Empty", Some("trash"), ui::Variant::Ghost, ui::Size::Sm);
        empty.add_css_class("danger-text");
        empty.set_tooltip_text(Some("Delete everything here for good"));
        let sure = Rc::new(Cell::new(false));
        let (s2, ids, ws) = (
            sure.clone(),
            deleted.iter().map(|d| d.id().to_string()).collect::<Vec<_>>(),
            orphans.iter().filter_map(|w| w["id"].as_str().map(String::from)).collect::<Vec<_>>(),
        );
        empty.connect_clicked(move |b| {
            if !s2.replace(true) {
                ui::set_text(b, "Click again: for good");
                b.add_css_class("sure");
                return;
            }
            state::delete_forever(ids.clone(), ws.clone());
        });
        let leave = gtk::EventControllerMotion::new();
        let (s2, eb) = (sure, empty.downgrade());
        leave.connect_leave(move |_| {
            if s2.replace(false)
                && let Some(b) = eb.upgrade()
            {
                ui::set_text(&b, "Empty");
                b.remove_css_class("sure");
            }
        });
        empty.add_controller(leave);
        head.append(&empty);
    }
    let x = ui::icon_button("x", "Close", 14);
    let p = panel.downgrade();
    x.connect_clicked(move |_| {
        if let Some(p) = p.upgrade() {
            p.set_visible(false);
        }
    });
    head.append(&x);
    panel.append(&head);
    let note = ui::wrapping(
        "Drag one back onto a stack, or between two stacks, to restore it. The bin deletes it for good: its document, and its image when nothing else uses them.",
    );
    note.add_css_class("rail-note");
    panel.append(&note);
    if deleted.is_empty() && orphans.is_empty() {
        let e = gtk::Label::new(Some("Nothing here."));
        e.add_css_class("empty-note");
        e.set_xalign(0.0);
        panel.append(&e);
    }
    let list = gtk::Box::new(gtk::Orientation::Vertical, 8);
    for d in deleted {
        let item = gtk::Box::new(gtk::Orientation::Vertical, 4);
        item.add_css_class("deleted-item");
        let (face, from_text, at, what): (gtk::Widget, String, f64, String) = match &d {
            Deleted::Module { module, from, at, .. } => (
                faces::pile(&stack_of(std::slice::from_ref(module)), std::slice::from_ref(module)).upcast(),
                from.clone(),
                *at,
                module_name(module),
            ),
            Deleted::Sub { sub, from, at, .. } => {
                (faces::chip(sub, None).upcast(), from.clone(), *at, faces::sub_summary(sub, None).0)
            }
        };
        item.append(&face);
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let l = gtk::Label::new(Some(&format!("from {from_text} · {}", state::time_ago(at))));
        l.add_css_class("tiny-muted");
        l.set_xalign(0.0);
        l.set_hexpand(true);
        row.append(&l);
        row.append(&forever(&what, d.id().to_string(), None));
        item.append(&row);
        let dd = d.clone();
        drag::draggable(&item, move |_| match &dd {
            Deleted::Module { id, module, .. } => Some((
                Payload::Modules { modules: vec![module.clone()], from: From::Deleted { deleted_id: id.clone() } },
                faces::ghost(&faces::pile(&stack_of(std::slice::from_ref(module)), std::slice::from_ref(module))),
            )),
            Deleted::Sub { id, sub, .. } => Some((
                Payload::Sub { sub: sub.clone(), from: SubFrom::Deleted { deleted_id: id.clone() } },
                faces::ghost(&faces::chip(sub, None)),
            )),
        });
        list.append(&item);
    }
    for w in orphans {
        let id = w["id"].as_str().unwrap_or_default().to_string();
        let name = store().read_now(|s| s.wadspace_name(&w));
        let item = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        item.add_css_class("deleted-item");
        let texts = gtk::Box::new(gtk::Orientation::Vertical, 2);
        texts.set_hexpand(true);
        let n = gtk::Label::new(Some(&name));
        n.add_css_class("deleted-name");
        n.set_xalign(0.0);
        texts.append(&n);
        let when = w["deletedAt"].as_str().and_then(state::iso_ms).map(state::time_ago).unwrap_or_default();
        let l = gtk::Label::new(Some(&format!("a wadspace, deleted {when}")));
        l.add_css_class("tiny-muted");
        l.set_xalign(0.0);
        texts.append(&l);
        item.append(&texts);
        let back = ui::button("Restore", Some("undo-2"), ui::Variant::Ghost, ui::Size::Sm);
        back.set_valign(gtk::Align::Center);
        let id2 = id.clone();
        back.connect_clicked(move |_| state::restore_wadspace(id2.clone()));
        item.append(&back);
        let bin = forever(&name, String::new(), Some(id));
        bin.set_valign(gtk::Align::Center);
        item.append(&bin);
        list.append(&item);
    }
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
    scroll.set_max_content_height(420);
    scroll.set_propagate_natural_height(true);
    scroll.set_child(Some(&list));
    drag::autoscroll(&scroll);
    panel.append(&scroll);
}

/// An entry's bin: gone for good (an entry by its id, or a wadspace left over).
fn forever(what: &str, id: String, wadspace: Option<String>) -> gtk::Button {
    let b = ui::icon_button("trash", "Delete for good", 13);
    b.add_css_class("danger-text");
    b.update_property(&[gtk::accessible::Property::Label(&format!("Delete {what} for good"))]);
    b.connect_clicked(move |_| match &wadspace {
        Some(w) => state::delete_forever(vec![], vec![w.clone()]),
        None => state::delete_forever(vec![id.clone()], vec![]),
    });
    b
}
