//! Toasts (the web app's Toaster): a note in the corner that goes by
//! itself (an error stays a little longer), or with its X.

use std::cell::RefCell;

use gtk::{glib, prelude::*};
use wad_gtk::Icon;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Info,
    Success,
    Error,
}

thread_local! {
    static HOST: RefCell<Option<gtk::Box>> = const { RefCell::new(None) };
}

/// Where toasts go: over the app, bottom right.
pub fn host() -> gtk::Box {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 8);
    b.add_css_class("toaster");
    b.set_halign(gtk::Align::End);
    b.set_valign(gtk::Align::End);
    b.set_size_request(340, -1);
    HOST.with(|h| h.replace(Some(b.clone())));
    b
}

pub fn show(title: &str, body: Option<&str>, tone: Tone) {
    make(title, body, tone, None);
}

/// A toast with a button (the Builder's Undo): pressing it does `f` and
/// closes the toast.
pub fn with_action(title: &str, tone: Tone, label: &str, f: impl Fn() + 'static) {
    make(title, None, tone, Some((label, Box::new(f))));
}

/// A toast's button: its label, what it does.
type Action<'a> = (&'a str, Box<dyn Fn()>);

fn make(title: &str, body: Option<&str>, tone: Tone, action: Option<Action>) {
    let Some(host) = HOST.with(|h| h.borrow().clone()) else {
        tracing::info!("{title}: {}", body.unwrap_or(""));
        return;
    };
    let t = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    t.add_css_class("toast");
    let icon = Icon::new(
        match tone {
            Tone::Success => "circle-check",
            Tone::Error => "circle-alert",
            Tone::Info => "info",
        },
        16,
    );
    icon.add_css_class(match tone {
        Tone::Success => "toast-success",
        Tone::Error => "toast-error",
        Tone::Info => "toast-info",
    });
    icon.set_valign(gtk::Align::Start);
    t.append(&icon);
    let text = gtk::Box::new(gtk::Orientation::Vertical, 2);
    text.set_hexpand(true);
    let ti = crate::ui::wrapping(title);
    ti.add_css_class("toast-title");
    text.append(&ti);
    if let Some(b) = body {
        let bl = crate::ui::wrapping(b);
        bl.add_css_class("toast-body");
        bl.set_lines(2);
        bl.set_ellipsize(gtk::pango::EllipsizeMode::End);
        text.append(&bl);
    }
    t.append(&text);
    if let Some((label, f)) = action {
        let b = crate::ui::button(label, Some("undo-2"), crate::ui::Variant::Ghost, crate::ui::Size::Sm);
        b.set_valign(gtk::Align::Center);
        let (tw, h) = (t.downgrade(), host.downgrade());
        b.connect_clicked(move |_| {
            f();
            if let (Some(t), Some(h)) = (tw.upgrade(), h.upgrade()) {
                h.remove(&t);
            }
        });
        t.append(&b);
    }
    let close = gtk::Button::new();
    close.add_css_class("toast-close");
    close.set_child(Some(&Icon::new("x", 14)));
    close.set_valign(gtk::Align::Start);
    let tw = t.downgrade();
    let h = host.downgrade();
    close.connect_clicked(move |_| {
        if let (Some(t), Some(h)) = (tw.upgrade(), h.upgrade()) {
            h.remove(&t);
        }
    });
    t.append(&close);
    host.append(&t);
    let (tw, h) = (t.downgrade(), host.downgrade());
    let secs = if tone == Tone::Error { 8 } else { 5 };
    glib::timeout_add_seconds_local_once(secs, move || {
        if let (Some(t), Some(h)) = (tw.upgrade(), h.upgrade())
            && t.parent().is_some()
        {
            h.remove(&t);
        }
    });
}

pub fn error(title: &str, body: &str) {
    show(title, Some(body), Tone::Error);
}
