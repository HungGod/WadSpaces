//! The focus banner (the web app's FocusBanner): while a focus session's
//! time runs, the countdown, what it's locked to, and the way back to it.

use gtk::{glib, prelude::*};
use wad_gtk::Icon;
use wad_proto::v1::SessionMode;

use crate::pages::now;
use crate::store::{AppState, Topic, store};

/// "12:05" or "1:02:03" (the web app's countdown).
pub fn countdown(secs: f64) -> String {
    let t = secs.max(0.0).ceil() as u64;
    let (h, m, s) = (t / 3600, (t % 3600) / 60, t % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m:02}:{s:02}") }
}

/// The session's time left, and its share used, while it's a focus one.
fn left(s: &AppState) -> Option<(f64, f64)> {
    let x = s.session.as_ref()?;
    if x.mode != SessionMode::Focus || x.expired {
        return None;
    }
    let total = x.minutes.unwrap_or(25) as f64 * 60.0;
    // The clock starts when one is first opened; until then, the whole time.
    let remaining = x.ends_at.map(|e| e - now()).unwrap_or(total);
    (remaining > 0.0).then_some((remaining, 1.0 - remaining / total))
}

pub fn banner() -> gtk::Revealer {
    let rev = gtk::Revealer::new();
    rev.set_transition_type(gtk::RevealerTransitionType::SlideDown);
    let col = gtk::Box::new(gtk::Orientation::Vertical, 0);
    col.add_css_class("focus-banner");
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 16);
    row.add_css_class("focus-row");
    let tag = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    tag.add_css_class("focus-tag");
    tag.append(&Icon::new("lock", 16));
    tag.append(&gtk::Label::new(Some("Focus mode")));
    row.append(&tag);
    let clock = gtk::Label::new(Some("00:00"));
    clock.add_css_class("focus-clock");
    row.append(&clock);
    let locked = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    locked.add_css_class("small-muted");
    locked.set_hexpand(true);
    row.append(&locked);
    let note = gtk::Label::new(Some("There's no ending it early"));
    note.add_css_class("small-faint");
    row.append(&note);
    let open = gtk::Button::with_label("Open focus window");
    open.add_css_class("focus-open");
    open.connect_clicked(|_| {
        let first = store().read_now(|s| s.session.as_ref().and_then(|x| x.workspaces.first().cloned()));
        if let Some(id) = first {
            glib::spawn_future_local(async move {
                if let Err(e) = crate::launch::launch(vec![crate::launch::RunItem::Wadspace(id)], None).await {
                    crate::toast::error("Couldn't open it", &e);
                }
            });
        }
    });
    row.append(&open);
    col.append(&row);
    let bar = gtk::ProgressBar::new();
    bar.add_css_class("focus-progress");
    col.append(&bar);
    rev.set_child(Some(&col));

    let tick = {
        let (rev, clock, bar) = (rev.clone(), clock.clone(), bar.clone());
        move |s: &AppState| match left(s) {
            Some((remaining, used)) => {
                clock.set_text(&countdown(remaining));
                bar.set_fraction(used);
                rev.set_reveal_child(true);
            }
            None => rev.set_reveal_child(false),
        }
    };
    let t = tick.clone();
    store().watch(&rev, Topic::SESSION | Topic::LIBRARY, move |s| {
        ui_locked(&locked, s);
        t(s);
    });
    // The clock ticks while the banner shows.
    let weak = rev.downgrade();
    glib::timeout_add_seconds_local(1, move || {
        let Some(r) = weak.upgrade() else { return glib::ControlFlow::Break };
        if r.reveals_child() {
            store().read_now(|s| tick(s));
        }
        glib::ControlFlow::Continue
    });
    rev
}

fn ui_locked(b: &gtk::Box, s: &AppState) {
    crate::ui::clear(b);
    b.append(&gtk::Label::new(Some("Locked to")));
    for id in s.session.iter().flat_map(|x| x.workspaces.iter()) {
        let name = s
            .wadspaces()
            .into_iter()
            .find(|w| w["id"].as_str() == Some(id))
            .map(|w| s.wadspace_name(w))
            .unwrap_or_else(|| "Unknown".into());
        let chip = gtk::Label::new(Some(&name));
        chip.add_css_class("focus-chip");
        b.append(&chip);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_countdown_reads_as_the_web_apps() {
        assert_eq!(super::countdown(65.2), "01:06");
        assert_eq!(super::countdown(3723.0), "1:02:03");
        assert_eq!(super::countdown(-4.0), "00:00");
    }
}
