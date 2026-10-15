//! What ran on this machine (the web app's RunHistory, for a machine):
//! wadd's runs by day, who started each and for how long; read again when
//! something starts or stops, live durations ticking while it shows.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::{glib, prelude::*};
use wad_gtk::Icon;
use wad_proto::v1::{Project, Run};

use super::get;
use crate::pages::now;
use crate::store::{Topic, store};
use crate::ui;

/// Shown at a time ("Show older" adds as many again).
const PAGE: usize = 30;

/// "1h 12m", "14m", "<1m"
fn length(secs: f64) -> String {
    let m = (secs / 60.0).floor() as u64;
    if m < 1 {
        return "<1m".into();
    }
    let h = m / 60;
    if h > 0 { format!("{h}h {}m", m % 60) } else { format!("{m}m") }
}

fn local(t: f64) -> Option<glib::DateTime> {
    glib::DateTime::from_unix_local(t as i64).ok()
}

/// "3:05 PM"
fn clock(t: f64) -> String {
    local(t).and_then(|d| d.format("%-I:%M %p").ok()).map(String::from).unwrap_or_default()
}

/// Today, Yesterday, else "Wed, Oct 14".
fn day(t: f64) -> String {
    let (Some(d), Ok(today)) = (local(t), glib::DateTime::now_local()) else { return String::new() };
    let ymd = |d: &glib::DateTime| d.ymd();
    if ymd(&d) == ymd(&today) {
        return "Today".into();
    }
    if today.add_days(-1).is_ok_and(|y| ymd(&y) == ymd(&d)) {
        return "Yesterday".into();
    }
    d.format("%a, %b %-d").map(String::from).unwrap_or_default()
}

struct History {
    runs: RefCell<Option<Vec<Run>>>,
    projects: RefCell<HashMap<String, String>>,
    shown: Cell<usize>,
    list: gtk::Box,
    /// What runs (a run starts or ends only when this changes).
    running: RefCell<String>,
}

pub fn view() -> gtk::Widget {
    let p = ui::panel(
        "History",
        Some("rotate-ccw-clock"),
        Some("What ran on This machine, who started it, and for how long."),
    );
    p.body.add_css_class("history-body");
    let h = Rc::new(History {
        runs: RefCell::default(),
        projects: RefCell::default(),
        shown: Cell::new(PAGE),
        list: p.body.clone(),
        running: RefCell::new("\0".into()),
    });
    h.render();
    let hh = h.clone();
    store().watch(&p.root, Topic::STATES | Topic::WADD, move |s| {
        let mut on: Vec<&str> =
            s.states.values().filter(|st| st.container == "running").map(|st| st.id.as_str()).collect();
        on.sort();
        let key = on.join(" ");
        if *hh.running.borrow() != key {
            hh.running.replace(key);
            hh.clone().load();
        }
    });
    let (weak, h2) = (p.root.downgrade(), h.clone());
    glib::timeout_add_seconds_local(30, move || {
        let Some(root) = weak.upgrade() else { return glib::ControlFlow::Break };
        if root.is_mapped() {
            h2.render();
        }
        glib::ControlFlow::Continue
    });
    p.root.upcast()
}

impl History {
    fn load(self: Rc<Self>) {
        glib::spawn_future_local(async move {
            let runs = get::<Vec<Run>>("/v1/runs?limit=200".into()).await.unwrap_or_default();
            let projects = get::<Vec<Project>>("/v1/projects".into()).await.unwrap_or_default();
            self.projects.replace(projects.into_iter().map(|p| (p.id, p.name)).collect());
            self.runs.replace(Some(runs));
            self.render();
        });
    }

    fn render(self: &Rc<Self>) {
        ui::clear(&self.list);
        let runs = self.runs.borrow();
        let Some(runs) = runs.as_ref() else {
            let s = gtk::Spinner::new();
            s.start();
            s.add_css_class("history-wait");
            self.list.append(&s);
            return;
        };
        if runs.is_empty() {
            let b = gtk::Box::new(gtk::Orientation::Vertical, 8);
            b.add_css_class("history-empty");
            let i = Icon::new("rotate-ccw-clock", 20);
            i.add_css_class("faint");
            b.append(&i);
            b.append(&gtk::Label::new(Some("Nothing has run on this machine yet.")));
            self.list.append(&b);
            return;
        }
        let me =
            store().read_now(|s| s.profile().map(|p| (p.username.clone(), p.display_name.clone(), p.color.clone())));
        let mut last_day = String::new();
        let mut group: Option<gtk::Box> = None;
        for r in runs.iter().take(self.shown.get()) {
            let d = day(r.started_at);
            if d != last_day || group.is_none() {
                let head = gtk::Label::new(Some(&d.to_uppercase()));
                head.add_css_class("day-head");
                head.set_xalign(0.0);
                self.list.append(&head);
                let g = gtk::Box::new(gtk::Orientation::Vertical, 4);
                self.list.append(&g);
                group = Some(g);
                last_day = d;
            }
            if let Some(g) = &group {
                g.append(&self.row(r, me.as_ref()));
            }
        }
        if runs.len() > self.shown.get() {
            let more = gtk::Button::with_label(&format!("Show older ({} more)", runs.len() - self.shown.get()));
            more.add_css_class("show-more");
            let me = self.clone();
            more.connect_clicked(move |_| {
                me.shown.set(me.shown.get() + PAGE);
                me.render();
            });
            self.list.append(&more);
        }
    }

    /// `me`: who's signed in (username, name, colour).
    fn row(&self, r: &Run, me: Option<&(String, String, String)>) -> gtk::Widget {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        row.add_css_class("run-row");
        let at = gtk::Label::new(Some(&clock(r.started_at)));
        at.add_css_class("run-time");
        at.set_xalign(0.0);
        at.set_size_request(64, -1);
        row.append(&at);
        let text = gtk::Box::new(gtk::Orientation::Vertical, 2);
        text.set_hexpand(true);
        let name = gtk::Label::new(Some(&r.wadspace_name));
        name.add_css_class("run-name");
        name.set_xalign(0.0);
        name.set_ellipsize(gtk::pango::EllipsizeMode::End);
        text.append(&name);
        let facts = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        facts.add_css_class("run-facts");
        let fact = |icon: Option<gtk::Widget>, t: &str| {
            let b = gtk::Box::new(gtk::Orientation::Horizontal, 4);
            if let Some(i) = icon {
                b.append(&i);
            }
            let l = gtk::Label::new(Some(t));
            l.set_ellipsize(gtk::pango::EllipsizeMode::End);
            b.append(&l);
            b
        };
        let stream = r.mode == "stream";
        facts.append(&fact(
            Some(Icon::new(if stream { "radio" } else { "monitor-play" }, 12).upcast()),
            if stream { "Streamed" } else { "Local" },
        ));
        // Who started it: you (your name and colour), or as wadd says.
        let (who, hue) = match me {
            Some((u, d, c)) if *u == r.user => (d.clone(), c.clone()),
            _ => (r.user.clone(), "#888888".into()),
        };
        facts.append(&fact(Some(avatar(&who, &hue)), &who));
        if !r.projects.is_empty() {
            let names = self.projects.borrow();
            let list: Vec<&str> =
                r.projects.iter().map(|id| names.get(id).map(String::as_str).unwrap_or("deleted")).collect();
            let f = fact(Some(Icon::new("folder", 12).upcast()), &list.join(", "));
            f.set_tooltip_text(Some("Projects it had"));
            facts.append(&f);
        }
        let span = gtk::Label::new(Some(&format!(
            "{}–{}",
            clock(r.started_at),
            r.ended_at.map(clock).unwrap_or_else(|| "now".into())
        )));
        span.add_css_class("faint-text");
        facts.append(&span);
        text.append(&facts);
        row.append(&text);
        let live = r.ended_at.is_none();
        let len = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        len.add_css_class("run-length");
        len.set_valign(gtk::Align::Center);
        if live {
            len.add_css_class("live");
            len.append(&ui::dot("on"));
        }
        len.append(&gtk::Label::new(Some(&length(r.ended_at.unwrap_or_else(now) - r.started_at))));
        row.append(&len);
        row.upcast()
    }
}

/// A person's initial on their colour.
fn avatar(name: &str, color: &str) -> gtk::Widget {
    let l = gtk::Label::new(Some(&name.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default()));
    l.add_css_class("avatar-xs");
    let css = gtk::CssProvider::new();
    css.load_from_string(&format!("label.avatar-xs {{ background: {color}; }}"));
    #[allow(deprecated)]
    l.style_context().add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION + 2);
    l.upcast()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_read_as_the_web_app_says_them() {
        assert_eq!(length(30.0), "<1m");
        assert_eq!(length(14.0 * 60.0 + 5.0), "14m");
        assert_eq!(length(72.0 * 60.0), "1h 12m");
    }
}
