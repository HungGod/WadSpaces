//! What the machine's app shows for wadd (the web app's MachineChrome):
//! which wadspace is starting (a pill along the bottom until it's on
//! screen), and, when the app starts in the middle of a focus session (the
//! machine restarted), whether to go back to it or end it. wadd's notices
//! are toasts (store.rs).

use std::cell::Cell;

use gtk::{glib, prelude::*};
use serde_json::Value;
use wad_proto::v1::SessionMode;
use wad_wadd_client::Method;

use crate::modal::Modal;
use crate::pages::machines::send;
use crate::store::{AppState, Topic, store};
use crate::ui::{self, Size, Variant};

/// Puts the pill in the app's frame and starts watching for a session to
/// go back to.
pub fn attach(frame: &gtk::Overlay) {
    let pill = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    pill.add_css_class("starting-pill");
    pill.set_halign(gtk::Align::Center);
    pill.set_valign(gtk::Align::End);
    pill.set_can_target(false);
    pill.set_visible(false);
    let spin = gtk::Spinner::new();
    spin.set_spinning(true);
    pill.append(&spin);
    let name = gtk::Label::new(None);
    name.add_css_class("strong");
    pill.append(&name);
    let msg = gtk::Label::new(None);
    msg.add_css_class("small-muted");
    msg.set_max_width_chars(40);
    msg.set_ellipsize(gtk::pango::EllipsizeMode::End);
    pill.append(&msg);
    frame.add_overlay(&pill);
    let pw = pill.downgrade();
    store().watch(&pill, Topic::VIEW | Topic::STATES | Topic::WORKSPACES, move |s| {
        let Some(pill) = pw.upgrade() else { return };
        let pending = s.view.as_ref().and_then(|v| v.pending.clone());
        let w = pending.as_ref().and_then(|id| s.workspaces.iter().find(|w| w.id == *id));
        match w {
            Some(w) => {
                name.set_text(&format!("Starting {}", w.name));
                let m = s.states.get(&w.id).and_then(|st| st.message.clone()).unwrap_or_default();
                msg.set_text(&m);
                msg.set_visible(!m.is_empty());
                pill.set_visible(true);
            }
            None => pill.set_visible(false),
        }
    });
    // Asked once per start, once wadd's said whether there's a session.
    let asked = Cell::new(false);
    store().watch(frame, Topic::SESSION | Topic::WADD, move |s| {
        if asked.get() || !s.connected {
            return;
        }
        asked.set(true);
        if s.session.as_ref().is_some_and(|x| x.mode == SessionMode::Focus && !x.expired) {
            glib::idle_add_local_once(resume);
        }
    });
}

/// "12 min left", "1 h 5 min left", or the time it'll have.
fn left(s: &AppState) -> String {
    let Some(x) = s.session.as_ref() else { return String::new() };
    let Some(ends) = x.ends_at else {
        return format!("{} minutes, from when you open it", x.minutes.unwrap_or(25));
    };
    let m = (((ends - crate::pages::now()) / 60.0).ceil() as i64).max(1);
    if m >= 60 { format!("{} h {} min left", m / 60, m % 60) } else { format!("{m} min left") }
}

/// The machine restarted in the middle of a focus session: back to it, or
/// end it early.
fn resume() {
    let Some((first, subtitle)) = store().read_now(|s| {
        let x = s.session.as_ref()?;
        let names: Vec<String> = x
            .workspaces
            .iter()
            .map(|id| s.workspaces.iter().find(|w| w.id == *id).map(|w| w.name.clone()).unwrap_or_else(|| id.clone()))
            .collect();
        Some((x.workspaces.first().cloned(), format!("{} · {}", names.join(", "), left(s))))
    }) else {
        return;
    };
    let m = Modal::open("You're in a focus session", Some(&subtitle), 460);
    let p = ui::wrapping("The machine restarted while it was running. Pick up where you were, or end it now.");
    p.add_css_class("small-muted-14");
    m.body().append(&p);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    row.set_margin_top(24);
    let back = ui::button("Back to focus", None, Variant::Primary, Size::Md);
    back.set_hexpand(true);
    let end = ui::button("End it early", None, Variant::Danger, Size::Md);
    let act = |path: String, method: Method, m: Modal| {
        move |b: &gtk::Button| {
            b.set_sensitive(false);
            let (b, m, path, method) = (b.clone(), m.clone(), path.clone(), method.clone());
            glib::spawn_future_local(async move {
                match send::<Value>(method, path, None).await {
                    Ok(_) => m.close(),
                    Err(e) => {
                        crate::toast::error("Couldn't do that", &e);
                        b.set_sensitive(true);
                    }
                }
            });
        }
    };
    match first {
        Some(id) => {
            back.connect_clicked(act(format!("/v1/workspaces/{}/switch", ui::enc(&id)), Method::POST, m.clone()));
        }
        None => back.set_sensitive(false),
    }
    end.connect_clicked(act("/v1/session?force=true".into(), Method::DELETE, m.clone()));
    row.append(&back);
    row.append(&end);
    m.body().append(&row);
}
