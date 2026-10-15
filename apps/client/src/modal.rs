//! Dialogs (the web app's Modal): over the app, dimmed behind, the card
//! easing in; Esc or a click outside closes one (unless it says not).

use std::cell::RefCell;
use std::rc::Rc;

use gtk::{glib, prelude::*};
use wad_gtk::Icon;

thread_local! {
    static LAYER: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
    /// The open ones, the top last: what Esc closes.
    static OPEN: RefCell<Vec<Modal>> = const { RefCell::new(Vec::new()) };
}

/// Where dialogs open: over the app (toasts stay above them).
pub fn layer() -> gtk::Overlay {
    let o = gtk::Overlay::new();
    o.set_can_target(false);
    o.set_visible(false);
    LAYER.with(|l| l.replace(Some(o.clone())));
    o
}

/// Esc closes the top dialog: called with the window's key events.
pub fn escape() -> bool {
    let top = OPEN.with(|o| o.borrow().last().cloned());
    match top {
        Some(m) if m.0.dismissable => {
            m.close();
            true
        }
        _ => false,
    }
}

struct Inner {
    root: gtk::Overlay,
    body: gtk::Box,
    dismissable: bool,
    on_close: RefCell<Option<Box<dyn Fn()>>>,
}

#[derive(Clone)]
pub struct Modal(Rc<Inner>);

impl Modal {
    /// Opens one, `width` wide at most.
    pub fn open(title: &str, subtitle: Option<&str>, width: i32) -> Modal {
        let root = gtk::Overlay::new();
        let dim = gtk::Box::new(gtk::Orientation::Vertical, 0);
        dim.add_css_class("modal-dim");
        root.set_child(Some(&dim));
        let card = gtk::Box::new(gtk::Orientation::Vertical, 0);
        card.add_css_class("modal-card");
        card.set_halign(gtk::Align::Center);
        card.set_valign(gtk::Align::Center);
        card.set_size_request(width, -1);
        let head = gtk::Box::new(gtk::Orientation::Horizontal, 16);
        head.add_css_class("modal-head");
        let texts = gtk::Box::new(gtk::Orientation::Vertical, 4);
        texts.set_hexpand(true);
        let t = gtk::Label::new(Some(title));
        t.add_css_class("modal-title");
        t.set_xalign(0.0);
        let st = crate::ui::wrapping(subtitle.unwrap_or(""));
        st.add_css_class("modal-subtitle");
        st.set_visible(subtitle.is_some());
        texts.append(&t);
        texts.append(&st);
        head.append(&texts);
        let close = gtk::Button::new();
        close.add_css_class("icon-button");
        close.set_child(Some(&Icon::new("x", 16)));
        close.set_tooltip_text(Some("Close"));
        close.set_valign(gtk::Align::Start);
        head.append(&close);
        card.append(&head);
        let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
        card.append(&body);
        root.add_overlay(&card);
        let m = Modal(Rc::new(Inner { root, body, dismissable: true, on_close: RefCell::default() }));
        let mm = m.clone();
        close.connect_clicked(move |_| mm.close());
        // A click on the dim (not the card) closes it.
        let click = gtk::GestureClick::new();
        let mm = m.clone();
        click.connect_released(move |_, _, _, _| mm.close());
        dim.add_controller(click);
        LAYER.with(|l| {
            if let Some(layer) = l.borrow().as_ref() {
                layer.add_overlay(&m.0.root);
                layer.set_visible(true);
                layer.set_can_target(true);
            }
        });
        OPEN.with(|o| o.borrow_mut().push(m.clone()));
        // Eases in once it's on screen.
        glib::idle_add_local_once(move || card.add_css_class("shown"));
        m
    }

    /// A drawer: a panel along the right, `width` wide and the window's
    /// height, sliding in (the web app's Drawer). Its body is the panel.
    pub fn drawer(width: i32) -> Modal {
        let root = gtk::Overlay::new();
        let dim = gtk::Box::new(gtk::Orientation::Vertical, 0);
        dim.add_css_class("modal-dim");
        dim.add_css_class("drawer-dim");
        root.set_child(Some(&dim));
        let panel = gtk::Box::new(gtk::Orientation::Vertical, 0);
        panel.add_css_class("drawer");
        panel.set_halign(gtk::Align::End);
        panel.set_valign(gtk::Align::Fill);
        panel.set_size_request(width, -1);
        panel.set_overflow(gtk::Overflow::Hidden);
        root.add_overlay(&panel);
        let m = Modal(Rc::new(Inner { root, body: panel.clone(), dismissable: true, on_close: RefCell::default() }));
        let click = gtk::GestureClick::new();
        let mm = m.clone();
        click.connect_released(move |_, _, _, _| mm.close());
        dim.add_controller(click);
        LAYER.with(|l| {
            if let Some(layer) = l.borrow().as_ref() {
                layer.add_overlay(&m.0.root);
                layer.set_visible(true);
                layer.set_can_target(true);
            }
        });
        OPEN.with(|o| o.borrow_mut().push(m.clone()));
        glib::idle_add_local_once(move || panel.add_css_class("shown"));
        m
    }

    pub fn body(&self) -> &gtk::Box {
        &self.0.body
    }

    pub fn close(&self) {
        OPEN.with(|o| o.borrow_mut().retain(|m| !Rc::ptr_eq(&m.0, &self.0)));
        LAYER.with(|l| {
            if let Some(layer) = l.borrow().as_ref() {
                layer.remove_overlay(&self.0.root);
                if OPEN.with(|o| o.borrow().is_empty()) {
                    layer.set_visible(false);
                    layer.set_can_target(false);
                }
            }
        });
        if let Some(f) = self.0.on_close.borrow_mut().take() {
            f();
        }
    }
}
