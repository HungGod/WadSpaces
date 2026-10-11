//! Reminders: when an event's reminder goes off, a card at the top of the
//! screen (over whatever's showing, the bar tucked away or not) says what's
//! coming, in its wadspace's colour. Snooze brings it back in 5 minutes;
//! Dismiss is for good (until the event moves).

use std::rc::Rc;

use chrono::Duration;
use gtk::prelude::*;
use gtk4_layer_shell::{Edge, KeyboardMode, LayerShell};
use wad_notes::{Event, ReminderFile, due_reminders};

use super::widgets::{clear, clock, day_words, label, line, set_scope_class, text_button};
use super::{Ctx, now};

/// How many show at once (the rest wait their turn).
const AT_ONCE: usize = 3;

pub struct Reminder {
    ctx: Rc<Ctx>,
    pub win: gtk::Window,
    list: gtk::Box,
    file: ReminderFile,
}

impl Reminder {
    /// `file`: where what you dismissed or snoozed is kept.
    pub fn build(app: &gtk::Application, ctx: Rc<Ctx>, file: ReminderFile) -> Rc<Reminder> {
        let win = gtk::Window::builder().application(app).title("wadspaces-reminder").build();
        if gtk4_layer_shell::is_supported() {
            win.init_layer_shell();
            win.set_layer(gtk4_layer_shell::Layer::Overlay);
            win.set_namespace(Some("wadspaces-reminder"));
            win.set_keyboard_mode(KeyboardMode::None);
            // Top, centred (anchored to the top edge only).
            win.set_anchor(Edge::Top, true);
            win.set_margin(Edge::Top, 12);
        }
        let card = gtk::Box::new(gtk::Orientation::Vertical, 10);
        card.add_css_class("card");
        card.add_css_class("reminder");
        card.set_size_request(360, -1);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 10);
        card.append(&list);
        win.set_child(Some(&card));
        Rc::new(Reminder { ctx, win, list, file })
    }

    /// Shows the reminders due now (or hides the card when there are none).
    pub fn check(self: &Rc<Self>) {
        let events = self.ctx.store.events();
        let t = now();
        let mut done = self.file.load();
        let before = done.clone();
        done.prune(&events, t);
        if done != before
            && let Err(e) = self.file.save(&done)
        {
            eprintln!("wadnotes: {e}");
        }
        let due: Vec<Event> = due_reminders(&events, t, &done).into_iter().cloned().collect();
        clear(&self.list);
        if due.is_empty() {
            self.win.set_visible(false);
            return;
        }
        let head = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        head.append(&gtk::Image::from_icon_name("alarm-symbolic"));
        head.append(&label("REMINDER", "section"));
        self.list.append(&head);
        for e in due.iter().take(AT_ONCE) {
            self.list.append(&self.row(e));
        }
        if due.len() > AT_ONCE {
            self.list.append(&label(&format!("and {} more", due.len() - AT_ONCE), "row-sub"));
        }
        self.win.set_default_size(1, 1);
        self.win.present();
    }

    fn row(self: &Rc<Self>, e: &Event) -> gtk::Box {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        let stripe = gtk::Box::new(gtk::Orientation::Vertical, 0);
        stripe.add_css_class("stripe");
        set_scope_class(&stripe, self.ctx.color_of(e.scope_or_default()));
        row.append(&stripe);
        let words = gtk::Box::new(gtk::Orientation::Vertical, 2);
        words.set_hexpand(true);
        words.append(&line(if e.title.is_empty() { "Untitled" } else { &e.title }, "row-title"));
        let today = now().date();
        let when = if e.all_day {
            format!("{}, all day", day_words(e.start.date(), today))
        } else {
            format!("{} at {}", day_words(e.start.date(), today), clock(e.start.time()))
        };
        words.append(&line(&format!("{when} · {}", self.ctx.name_of(e.scope_or_default())), "row-sub"));
        row.append(&words);
        let buttons = gtk::Box::new(gtk::Orientation::Vertical, 4);
        let snooze = text_button("Snooze 5 min", &["small-button"]);
        let dismiss = text_button("Dismiss", &["small-button", "primary"]);
        buttons.append(&snooze);
        buttons.append(&dismiss);
        row.append(&buttons);
        let (me, ev) = (self.clone(), e.clone());
        snooze.connect_clicked(move |_| {
            let mut done = me.file.load();
            done.snooze(&ev, now() + Duration::minutes(5));
            me.keep(&done);
        });
        let (me, ev) = (self.clone(), e.clone());
        dismiss.connect_clicked(move |_| {
            let mut done = me.file.load();
            done.dismiss(&ev);
            me.keep(&done);
        });
        row
    }

    fn keep(self: &Rc<Self>, done: &wad_notes::Reminders) {
        if let Err(e) = self.file.save(done) {
            eprintln!("wadnotes: {e}");
        }
        self.check();
    }
}
