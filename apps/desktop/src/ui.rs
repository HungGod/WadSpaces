//! The web app's building blocks (components/ui.tsx, AuthCard.tsx) as GTK
//! widgets with its look (style.css): buttons in its variants, text fields,
//! labels, notices, the glass card.

use gtk::prelude::*;
use wad_gtk::Icon;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Primary,
    Secondary,
    Ghost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Sm,
    Md,
    Lg,
}

/// A button: its text, an icon before it (or after it, for an arrow).
pub fn button(text: &str, icon: Option<&'static str>, variant: Variant, size: Size) -> gtk::Button {
    let b = gtk::Button::new();
    b.add_css_class("btn");
    b.add_css_class(match variant {
        Variant::Primary => "primary",
        Variant::Secondary => "secondary",
        Variant::Ghost => "ghost",
    });
    b.add_css_class(match size {
        Size::Sm => "sm",
        Size::Md => "md",
        Size::Lg => "lg",
    });
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    row.set_halign(gtk::Align::Center);
    let px = if size == Size::Sm { 14 } else { 16 };
    let after = icon.is_some_and(|i| i.starts_with("arrow-"));
    if let Some(i) = icon.filter(|_| !after) {
        row.append(&Icon::new(i, px));
    }
    if !text.is_empty() {
        row.append(&gtk::Label::new(Some(text)));
    }
    if let Some(i) = icon.filter(|_| after) {
        row.append(&Icon::new(i, px));
    }
    b.set_child(Some(&row));
    b
}

/// The button's text, changed.
pub fn set_text(b: &gtk::Button, text: &str) {
    if let Some(l) = b.child().and_then(|r| {
        let mut c = r.first_child();
        while let Some(w) = c {
            if let Ok(l) = w.clone().downcast::<gtk::Label>() {
                return Some(l);
            }
            c = w.next_sibling();
        }
        None
    }) {
        l.set_text(text);
    }
}

/// "Sign in with GitHub" with GitHub's mark (drawn here: it works offline).
pub fn github_button(text: &str) -> gtk::Button {
    let b = gtk::Button::new();
    b.add_css_class("github");
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    row.set_halign(gtk::Align::Center);
    let mark = gtk::Image::new();
    mark.set_pixel_size(16);
    mark.add_css_class("github-mark");
    let show = {
        let mark = mark.clone();
        move |t: wad_gtk::Theme| {
            let fill = if t == wad_gtk::Theme::Dark { "#f5f2fa" } else { "#0a0614" };
            let svg = GITHUB_MARK.replace("currentColor", fill);
            if let Some(tex) = wad_gtk::icon::svg_texture(svg.as_bytes(), 32) {
                mark.set_paintable(Some(&tex));
            }
        }
    };
    show(wad_gtk::theme::shown());
    wad_gtk::theme::on_change(show);
    row.append(&mark);
    row.append(&gtk::Label::new(Some(text)));
    b.set_child(Some(&row));
    b
}

const GITHUB_MARK: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>"#;

/// A text field.
pub fn entry(placeholder: &str) -> gtk::Entry {
    let e = gtk::Entry::new();
    e.add_css_class("input");
    e.set_placeholder_text(Some(placeholder));
    e
}

/// A field's name above it, with a hint at its end.
pub fn field_label(text: &str, hint: Option<&gtk::Label>) -> gtk::Widget {
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    row.add_css_class("field-label");
    let l = gtk::Label::new(Some(text));
    l.set_xalign(0.0);
    l.set_hexpand(true);
    row.append(&l);
    if let Some(h) = hint {
        h.add_css_class("field-hint");
        row.append(h);
    }
    row.upcast()
}

/// A label that wraps to the width it's given (GTK would otherwise ask for
/// its whole text on one line).
pub fn wrapping(text: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.set_wrap(true);
    l.set_wrap_mode(gtk::pango::WrapMode::WordChar);
    l.set_max_width_chars(1);
    l.set_hexpand(true);
    l.set_xalign(0.0);
    l
}

/// A message in a tinted box: `error` (the danger colour) or a note (the accent's).
pub fn notice(text: &str, error: bool) -> gtk::Label {
    let l = wrapping(text);
    l.add_css_class(if error { "notice-error" } else { "notice" });
    l
}

/// A spinner and words: something under way.
pub fn busy(text: &str) -> gtk::Box {
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    row.add_css_class("busy");
    let s = gtk::Spinner::new();
    s.start();
    row.append(&s);
    row.append(&wrapping(text));
    row
}

/// The glass card the sign-in and setup screens hold their content in.
pub fn card(title: &str, subtitle: Option<&str>, body: &impl IsA<gtk::Widget>) -> gtk::Box {
    let c = gtk::Box::new(gtk::Orientation::Vertical, 0);
    c.add_css_class("glass-card");
    let t = gtk::Label::new(Some(title));
    t.add_css_class("card-title");
    t.set_xalign(0.0);
    c.append(&t);
    if let Some(s) = subtitle {
        let l = wrapping(s);
        l.add_css_class("card-subtitle");
        c.append(&l);
    }
    let b = body.upcast_ref::<gtk::Widget>();
    b.add_css_class("card-body");
    c.append(b);
    c
}

/// Empties a box.
pub fn clear(b: &gtk::Box) {
    while let Some(c) = b.first_child() {
        b.remove(&c);
    }
}
