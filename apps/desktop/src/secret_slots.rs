//! A key per slot (the web app's launcher/SecretSlots.tsx): save a new
//! sign-in, use one of the same kind already saved (or new for another slot
//! here, to share it), or don't save: sign in inside the app and keep
//! nothing on the machine.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::prelude::*;
use serde_json::Value;
use wad_gtk::Icon;

use crate::slots::{Choice, Draft, Mode};
use crate::store::store;
use crate::{images, signins, ui};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The rows for `slots`, drawn again as choices change; `changed` hears each
/// change (after the draft has it).
pub fn view(
    slots: Vec<Value>,
    draft: Rc<RefCell<Draft>>,
    dont_save: &'static str,
    changed: impl Fn() + 'static,
) -> gtk::Box {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 8);
    let me = Rc::new(Slots { root: root.clone(), slots, draft, dont_save, changed: Box::new(changed) });
    me.render();
    root
}

struct Slots {
    root: gtk::Box,
    slots: Vec<Value>,
    draft: Rc<RefCell<Draft>>,
    dont_save: &'static str,
    changed: Box<dyn Fn()>,
}

impl Slots {
    fn set(self: &Rc<Self>, key: &str, c: Choice, redraw: bool) {
        self.draft.borrow_mut().secrets.insert(key.into(), c);
        if redraw {
            self.render();
        }
        (self.changed)();
    }

    fn render(self: &Rc<Self>) {
        ui::clear(&self.root);
        let d = self.draft.borrow().clone();
        if self.slots.len() > 1 {
            let all_none = self.slots.iter().all(|sl| d.choice(sl).mode == Mode::None);
            let b = gtk::Button::with_label("Don't save any");
            b.add_css_class("text-accent");
            b.set_halign(gtk::Align::End);
            b.set_sensitive(!all_none);
            let me = self.clone();
            b.connect_clicked(move |_| {
                for sl in me.slots.clone() {
                    me.draft
                        .borrow_mut()
                        .secrets
                        .insert(s(&sl, "key").into(), Choice { mode: Mode::None, name: String::new(), id: None });
                }
                me.render();
                (me.changed)();
            });
            self.root.append(&b);
        }
        let known = store().read_now(signins::known);
        for slot in &self.slots {
            self.root.append(&self.row(slot, &d, &known));
        }
    }

    fn row(self: &Rc<Self>, slot: &Value, d: &Draft, known: &[(String, String, String)]) -> gtk::Widget {
        let key = s(slot, "key").to_string();
        let kind = s(slot, "kind").to_string();
        let choice = d.choice(slot);
        let card = gtk::Box::new(gtk::Orientation::Vertical, 8);
        card.add_css_class("slot-row");
        let top = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        let icon = gtk::Image::new();
        icon.set_pixel_size(20);
        images::desktop_icon(s(slot, "iconUrl"), images::later(&icon, |i, t| i.set_paintable(Some(&t))));
        top.append(&icon);
        let texts = gtk::Box::new(gtk::Orientation::Vertical, 0);
        texts.set_hexpand(true);
        let l = gtk::Label::new(Some(s(slot, "label")));
        l.add_css_class("medium");
        l.set_xalign(0.0);
        l.set_ellipsize(gtk::pango::EllipsizeMode::End);
        texts.append(&l);
        let k = gtk::Label::new(Some(&signins::kind_label(&kind)));
        k.add_css_class("tiny-muted");
        k.set_xalign(0.0);
        texts.append(&k);
        top.append(&texts);

        // Reusable here: saved ones of this kind, and ones this draft is
        // about to save for another slot of the kind.
        let saved: Vec<&(String, String, String)> =
            known.iter().filter(|(_, _, k)| (if k == "wadbrowser" { "web" } else { k.as_str() }) == kind).collect();
        let mut pending: Vec<String> = vec![];
        for o in self.slots.iter().filter(|o| s(o, "key") != key && s(o, "kind") == kind) {
            if d.choice(o).mode == Mode::New
                && let Some(n) = d.resolved_name(o)
                && !pending.contains(&n)
                && !saved.iter().any(|x| x.1.eq_ignore_ascii_case(&n))
            {
                pending.push(n);
            }
        }
        // (value, label, its choice)
        let mut options: Vec<(String, String, Choice)> = saved
            .iter()
            .map(|(id, name, _)| {
                (
                    format!("id:{id}"),
                    name.clone(),
                    Choice { mode: Mode::Existing, name: name.clone(), id: Some(id.clone()) },
                )
            })
            .chain(pending.iter().map(|n| {
                (
                    format!("new:{n}"),
                    format!("{n} (new here)"),
                    Choice { mode: Mode::Existing, name: n.clone(), id: None },
                )
            }))
            .collect();
        let current = match (&choice.mode, &choice.id) {
            (Mode::Existing, Some(id)) => format!("id:{id}"),
            (Mode::Existing, None) => format!("new:{}", choice.name),
            _ => String::new(),
        };
        // A saved pick the machine doesn't list stays offered.
        if let (Mode::Existing, Some(_)) = (&choice.mode, &choice.id)
            && !options.iter().any(|(v, _, _)| *v == current)
        {
            options.insert(0, (current.clone(), choice.name.clone(), choice.clone()));
        }

        let mode = match choice.mode {
            Mode::New => "new",
            Mode::Existing => "existing",
            Mode::None => "none",
        };
        let (me, k2, opts, cur, ch) = (self.clone(), key.clone(), options.clone(), current.clone(), choice.clone());
        let seg = ui::segmented(
            &[("new", None, "New"), ("existing", None, "Existing"), ("none", None, "Don't save")],
            mode,
            move |m| {
                let c = match m {
                    "existing" => opts
                        .iter()
                        .find(|(v, _, _)| *v == cur)
                        .or(opts.first())
                        .map(|(_, _, c)| c.clone())
                        .unwrap_or(Choice { mode: Mode::Existing, name: String::new(), id: None }),
                    "new" => Choice::new(if ch.mode == Mode::New { &ch.name } else { "" }),
                    _ => Choice { mode: Mode::None, name: String::new(), id: None },
                };
                me.set(&k2, c, true);
            },
        );
        seg.add_css_class("small");
        seg.set_valign(gtk::Align::Center);
        top.append(&seg);
        card.append(&top);

        match choice.mode {
            Mode::New => {
                let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
                let i = Icon::new("key-round", 14);
                i.add_css_class("faint");
                row.append(&i);
                let e = ui::entry(&d.default_name(slot));
                e.add_css_class("small");
                e.add_css_class("mono");
                e.set_hexpand(true);
                e.set_text(&choice.name);
                let (me, k3) = (self.clone(), key.clone());
                // Typing doesn't redraw (the field keeps its focus).
                e.connect_changed(move |e| me.set(&k3, Choice::new(&e.text()), false));
                row.append(&e);
                card.append(&row);
            }
            Mode::Existing if options.is_empty() => {
                let p = ui::wrapping(&format!(
                    "No {}s saved yet: only those can be mounted here.",
                    signins::kind_label(&kind).to_lowercase()
                ));
                p.add_css_class("tiny-muted");
                card.append(&p);
            }
            Mode::Existing => {
                let mut labels: Vec<String> = vec![];
                if current.is_empty() {
                    labels.push("Pick one".into());
                }
                labels.extend(options.iter().map(|(_, l, _)| l.clone()));
                let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
                let dd = gtk::DropDown::from_strings(&refs);
                dd.add_css_class("select");
                dd.add_css_class("mono");
                let at =
                    options.iter().position(|(v, _, _)| *v == current).map(|p| p + usize::from(current.is_empty()));
                dd.set_selected(at.unwrap_or(0) as u32);
                let (me, k4, opts, offset) =
                    (self.clone(), key.clone(), options.clone(), usize::from(current.is_empty()));
                dd.connect_selected_notify(move |dd| {
                    let i = dd.selected() as usize;
                    if i >= offset
                        && let Some((_, _, c)) = opts.get(i - offset)
                    {
                        me.set(&k4, c.clone(), true);
                    }
                });
                card.append(&dd);
            }
            Mode::None => {
                let p = ui::wrapping(self.dont_save);
                p.add_css_class("tiny-muted");
                card.append(&p);
            }
        }
        // Which other slots end up with the same secret.
        if let Some(name) = d.resolved_name(slot) {
            let with: Vec<&str> = self
                .slots
                .iter()
                .filter(|o| s(o, "key") != key && d.resolved_name(o).as_deref() == Some(name.as_str()))
                .map(|o| s(o, "label"))
                .collect();
            if !with.is_empty() {
                let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
                row.add_css_class("shared");
                row.append(&Icon::new("users", 14));
                row.append(&gtk::Label::new(Some(&format!("Shared with {}", with.join(", ")))));
                card.append(&row);
            }
        }
        card.upcast()
    }
}
