//! The Calendar card: one calendar for every wadspace. A month with a dot
//! per event in its wadspace's colour, the picked day's events, what's
//! coming up this week, and an editor for an event (a new one is for the
//! wadspace on screen, unless you pick another).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use chrono::{Datelike, Duration, NaiveDate, NaiveTime, Timelike};
use gtk::prelude::*;
use wad_notes::calendar::add_months;
use wad_notes::{DEFAULT, Event, month_grid, on_day, upcoming};

use super::widgets::{
    Chips, TimePick, calendar_day, clear, clock, day_words, dot, field, fit, glib_date, icon_button, label, line,
    md_view, text_button, text_of,
};
use super::{Ctx, Toast, now};

/// The reminder choices: (words, minutes before).
const REMIND: [(&str, Option<u32>); 7] = [
    ("None", None),
    ("At start", Some(0)),
    ("5 min", Some(5)),
    ("15 min", Some(15)),
    ("30 min", Some(30)),
    ("1 hour", Some(60)),
    ("1 day", Some(1440)),
];

/// "Coming up"'s most height before it scrolls.
const COMING_MAX: i32 = 200;

/// How many dots a day shows (the rest are counted in its agenda).
const DOTS: usize = 3;

struct Day {
    button: gtk::Button,
    num: gtk::Label,
    dots: gtk::Box,
}

pub struct CalendarCard {
    ctx: Rc<Ctx>,
    pub root: gtk::Box,
    toast: Rc<Toast>,
    month_label: gtk::Label,
    stack: gtk::Stack,
    days: Vec<Day>,
    day_title: gtk::Label,
    agenda: gtk::Box,
    coming: gtk::Box,
    coming_scroll: gtk::ScrolledWindow,
    coming_title: gtk::Label,
    /// The month shown, and the day picked.
    month: Cell<(i32, u32)>,
    picked: Cell<NaiveDate>,
    /// The day the card last drew as today.
    today: Cell<NaiveDate>,
    events: RefCell<Vec<Event>>,
    // The editor.
    edit_title: gtk::Entry,
    scopes_box: gtk::Box,
    scopes: RefCell<Option<(Rc<Chips>, Vec<String>)>>,
    day_pick: gtk::Calendar,
    all_day: gtk::Switch,
    times: gtk::Box,
    start: TimePick,
    end: TimePick,
    remind: Rc<Chips>,
    notes: gtk::TextView,
    delete: gtk::Button,
    editing: RefCell<Option<Event>>,
}

impl CalendarCard {
    pub fn build(ctx: Rc<Ctx>) -> Rc<CalendarCard> {
        let today = now().date();
        let root = gtk::Box::new(gtk::Orientation::Vertical, 8);
        root.add_css_class("notes-card");

        let head = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let title = label("Calendar", "heading");
        let month_label = label("", "count");
        month_label.set_hexpand(true);
        month_label.set_margin_start(6);
        let prev = icon_button("go-previous-symbolic", "The month before");
        let to_today = text_button("Today", &["link"]);
        let next = icon_button("go-next-symbolic", "The month after");
        let add = icon_button("list-add-symbolic", "New event");
        for w in [
            title.upcast_ref::<gtk::Widget>(),
            month_label.upcast_ref(),
            prev.upcast_ref(),
            to_today.upcast_ref(),
            next.upcast_ref(),
            add.upcast_ref(),
        ] {
            head.append(w);
        }
        root.append(&head);
        let toast = Toast::new(ctx.clone());
        root.append(&toast.row);

        let stack = gtk::Stack::new();
        stack.set_vhomogeneous(false);
        stack.set_hhomogeneous(true);

        // The month.
        let view = gtk::Box::new(gtk::Orientation::Vertical, 8);
        let grid = gtk::Grid::new();
        grid.set_column_homogeneous(true);
        grid.set_row_spacing(2);
        grid.set_column_spacing(2);
        for (i, d) in ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].iter().enumerate() {
            let l = label(d, "weekday");
            l.set_xalign(0.5);
            grid.attach(&l, i as i32, 0, 1, 1);
        }
        let mut days = Vec::with_capacity(42);
        for i in 0..42 {
            let button = gtk::Button::new();
            button.add_css_class("day");
            let inner = gtk::Box::new(gtk::Orientation::Vertical, 0);
            let num = gtk::Label::new(None);
            num.add_css_class("num");
            let dots = gtk::Box::new(gtk::Orientation::Horizontal, 1);
            dots.add_css_class("dots");
            dots.set_halign(gtk::Align::Center);
            inner.append(&num);
            inner.append(&dots);
            button.set_child(Some(&inner));
            grid.attach(&button, i % 7, 1 + i / 7, 1, 1);
            days.push(Day { button, num, dots });
        }
        view.append(&grid);
        let day_title = label("", "field-label");
        view.append(&day_title);
        let agenda = gtk::Box::new(gtk::Orientation::Vertical, 2);
        view.append(&agenda);
        let coming_title = label("COMING UP", "field-label");
        view.append(&coming_title);
        let coming = gtk::Box::new(gtk::Orientation::Vertical, 2);
        let coming_scroll = gtk::ScrolledWindow::new();
        coming_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        coming_scroll.set_propagate_natural_height(true);
        coming_scroll.set_max_content_height(COMING_MAX);
        coming_scroll.set_child(Some(&coming));
        view.append(&coming_scroll);
        stack.add_named(&view, Some("view"));

        // The editor.
        let editor = gtk::Box::new(gtk::Orientation::Vertical, 4);
        let edit_title = gtk::Entry::new();
        edit_title.add_css_class("title-entry");
        edit_title.set_placeholder_text(Some("What's happening"));
        editor.append(&edit_title);
        editor.append(&field("WADSPACE"));
        let scopes_box = gtk::Box::new(gtk::Orientation::Vertical, 0);
        editor.append(&scopes_box);
        editor.append(&field("DAY"));
        let day_pick = gtk::Calendar::new();
        editor.append(&day_pick);
        let all_day_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        all_day_row.set_margin_top(4);
        let all_day_text = line("All day", "row-title");
        let all_day = gtk::Switch::new();
        all_day.set_valign(gtk::Align::Center);
        all_day_row.append(&all_day_text);
        all_day_row.append(&all_day);
        editor.append(&all_day_row);
        let times = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let start = TimePick::new();
        let end = TimePick::new();
        times.append(&start.row);
        times.append(&label("to", "when"));
        times.append(&end.row);
        editor.append(&times);
        editor.append(&field("REMIND ME"));
        let remind = Chips::new(&REMIND.map(|(w, _)| w));
        editor.append(&remind.row);
        editor.append(&field("NOTES"));
        let notes = md_view(70);
        editor.append(&notes);
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        footer.set_margin_top(6);
        let delete = icon_button("user-trash-symbolic", "Delete this event");
        let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        spacer.set_hexpand(true);
        let cancel = text_button("Cancel", &["small-button"]);
        let save = text_button("Save", &["small-button", "primary"]);
        footer.append(&delete);
        footer.append(&spacer);
        footer.append(&cancel);
        footer.append(&save);
        editor.append(&footer);
        stack.add_named(&editor, Some("edit"));
        stack.set_visible_child_name("view");
        root.append(&stack);

        let card = Rc::new(CalendarCard {
            ctx,
            root,
            toast,
            month_label,
            stack,
            days,
            day_title,
            agenda,
            coming,
            coming_scroll,
            coming_title,
            month: Cell::new((today.year(), today.month())),
            picked: Cell::new(today),
            today: Cell::new(today),
            events: RefCell::default(),
            edit_title,
            scopes_box,
            scopes: RefCell::default(),
            day_pick,
            all_day,
            times,
            start,
            end,
            remind,
            notes,
            delete: delete.clone(),
            editing: RefCell::default(),
        });

        for (i, d) in card.days.iter().enumerate() {
            let c = card.clone();
            d.button.connect_clicked(move |_| {
                let (y, m) = c.month.get();
                if let Some(day) = month_grid(y, m).get(i) {
                    c.pick(*day);
                }
            });
        }
        for (b, by) in [(&prev, -1), (&next, 1)] {
            let c = card.clone();
            b.connect_clicked(move |_| {
                let (y, m) = c.month.get();
                c.month.set(add_months(y, m, by));
                c.draw();
            });
        }
        let c = card.clone();
        to_today.connect_clicked(move |_| c.pick(now().date()));
        let c = card.clone();
        add.connect_clicked(move |_| c.new_event());
        let c = card.clone();
        card.all_day.connect_active_notify(move |s| {
            c.times.set_visible(!s.is_active());
            c.ctx.relayout();
        });
        let c = card.clone();
        cancel.connect_clicked(move |_| c.close());
        let c = card.clone();
        save.connect_clicked(move |_| c.save());
        let c = card.clone();
        delete.connect_clicked(move |_| c.delete_editing());
        card.refresh();
        card
    }

    /// Reads the events again and draws them.
    pub fn refresh(self: &Rc<Self>) {
        self.events.replace(self.ctx.store.events());
        self.draw();
    }

    /// An event is open (the card is wider while it is).
    pub fn is_editing(&self) -> bool {
        self.editing.borrow().is_some()
    }

    pub fn refresh_if_idle(self: &Rc<Self>) {
        if self.editing.borrow().is_none() {
            self.refresh();
        }
    }

    /// Each half minute: a new day moves "today" (and what's coming up).
    pub fn tick(self: &Rc<Self>) {
        let today = now().date();
        if today != self.today.get() && self.editing.borrow().is_none() {
            self.today.set(today);
            self.refresh();
        }
    }

    fn pick(self: &Rc<Self>, day: NaiveDate) {
        self.picked.set(day);
        self.month.set((day.year(), day.month()));
        self.draw();
    }

    fn draw(self: &Rc<Self>) {
        let (y, m) = self.month.get();
        let today = now().date();
        self.today.set(today);
        let first = NaiveDate::from_ymd_opt(y, m, 1).unwrap_or(today);
        self.month_label.set_label(&first.format("%B %Y").to_string());
        let events = self.events.borrow();
        for (d, day) in self.days.iter().zip(month_grid(y, m)) {
            d.num.set_label(&day.day().to_string());
            for (class, on) in
                [("other", day.month() != m), ("today", day == today), ("selected", day == self.picked.get())]
            {
                if on { d.button.add_css_class(class) } else { d.button.remove_css_class(class) }
            }
            clear(&d.dots);
            let on = on_day(&events, day);
            for e in on.iter().take(DOTS) {
                d.dots.append(&dot(self.ctx.color_of(e.scope_or_default())));
            }
            let tip = match on.len() {
                0 => None,
                1 => Some(on[0].title.clone()),
                n => Some(format!("{n} events")),
            };
            d.button.set_tooltip_text(tip.as_deref());
        }

        let picked = self.picked.get();
        self.day_title
            .set_label(&format!("{} · {}", day_words(picked, today), picked.format("%A %-d %B")).to_uppercase());
        clear(&self.agenda);
        let on = on_day(&events, picked);
        if on.is_empty() {
            self.agenda.append(&label("Nothing on: + adds an event.", "empty-note"));
        }
        for e in on {
            self.agenda.append(&self.row(e, false));
        }
        // Coming up: the week ahead, past what's shown above.
        clear(&self.coming);
        let soon: Vec<&Event> = upcoming(&events, now(), 7)
            .into_iter()
            .filter(|e| {
                let (a, b) = e.days();
                !(a <= picked && picked <= b)
            })
            .collect();
        self.coming_title.set_visible(!soon.is_empty());
        for e in soon {
            self.coming.append(&self.row(e, true));
        }
        fit(&self.coming_scroll, COMING_MAX);
        drop(events);
        self.ctx.relayout();
    }

    /// An event as a row: its colour, title, when, and whose.
    fn row(self: &Rc<Self>, e: &Event, with_day: bool) -> gtk::Button {
        let b = gtk::Button::new();
        b.add_css_class("row");
        let inner = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let stripe = gtk::Box::new(gtk::Orientation::Vertical, 0);
        stripe.add_css_class("stripe");
        super::widgets::set_scope_class(&stripe, self.ctx.color_of(e.scope_or_default()));
        inner.append(&stripe);
        let words = gtk::Box::new(gtk::Orientation::Vertical, 1);
        words.set_hexpand(true);
        words.append(&line(if e.title.is_empty() { "Untitled" } else { &e.title }, "row-title"));
        words.append(&line(&format!("{} · {}", when(e, with_day), self.ctx.name_of(e.scope_or_default())), "row-sub"));
        inner.append(&words);
        if e.remind.is_some() {
            let bell = gtk::Image::from_icon_name("alarm-symbolic");
            bell.add_css_class("when");
            bell.set_tooltip_text(Some("Reminds you"));
            inner.append(&bell);
        }
        b.set_child(Some(&inner));
        let (c, ev) = (self.clone(), e.clone());
        b.connect_clicked(move |_| c.open(ev.clone()));
        b
    }

    // ------------------------------------------------------------- editor
    fn new_event(self: &Rc<Self>) {
        let day = self.picked.get();
        let n = now();
        // The next whole hour today; 9:00 another day.
        let start = if day == n.date() {
            let next = n + Duration::hours(1);
            if next.date() == day { next.date().and_hms_opt(next.hour(), 0, 0).unwrap() } else { n }
        } else {
            day.and_hms_opt(9, 0, 0).unwrap()
        };
        // For the wadspace on screen (the machine's own: none).
        let scope = Some(self.ctx.view_scope()).filter(|s| s != DEFAULT);
        let mut e = Event::new(start, scope);
        e.end = Some(start + Duration::hours(1));
        self.open(e);
        self.edit_title.grab_focus();
    }

    fn open(self: &Rc<Self>, e: Event) {
        self.edit_title.set_text(&e.title);
        // The wadspaces to pick from, each in its colour.
        clear(&self.scopes_box);
        let spaces = self.ctx.spaces();
        let ids: Vec<String> = spaces.iter().map(|(id, _)| id.clone()).collect();
        let chips = Chips::with(spaces.iter().map(|(id, name)| (Some(self.ctx.color_of(id)), name.clone())).collect());
        chips.set(ids.iter().position(|id| id == e.scope_or_default()).unwrap_or(0));
        self.scopes_box.append(&chips.row);
        self.scopes.replace(Some((chips, ids)));
        if let Some(d) = glib_date(e.start.date()) {
            self.day_pick.select_day(&d);
        }
        self.all_day.set_active(e.all_day);
        self.times.set_visible(!e.all_day);
        self.start.set(e.start.time());
        self.end.set(e.end.map(|t| t.time()).unwrap_or_else(|| (e.start + Duration::hours(1)).time()));
        self.remind.set(REMIND.iter().position(|(_, m)| *m == e.remind).unwrap_or(0));
        self.notes.buffer().set_text(&e.body);
        self.delete.set_visible(!e.id.is_empty());
        self.editing.replace(Some(e));
        self.stack.set_visible_child_name("edit");
        self.ctx.relayout();
    }

    /// The editor's event as it stands.
    fn edited(&self) -> Option<Event> {
        let base = self.editing.borrow().clone()?;
        let day = calendar_day(&self.day_pick).unwrap_or(base.start.date());
        let all_day = self.all_day.is_active();
        let (start, end) = if all_day {
            (day.and_time(NaiveTime::MIN), None)
        } else {
            let s = day.and_time(self.start.get());
            let e = day.and_time(self.end.get());
            (s, (e > s).then_some(e))
        };
        let scope = self.scopes.borrow().as_ref().and_then(|(chips, ids)| ids.get(chips.get()).cloned());
        Some(Event {
            title: self.edit_title.text().trim().to_string(),
            start,
            end,
            all_day,
            scope: scope.filter(|s| s != DEFAULT),
            remind: REMIND[self.remind.get()].1,
            body: text_of(&self.notes),
            ..base
        })
    }

    fn save(self: &Rc<Self>) {
        let Some(mut e) = self.edited() else { return };
        if e.title.is_empty() {
            e.title = "Untitled".into();
        }
        if let Err(err) = self.ctx.store.save_event(&mut e, now()) {
            eprintln!("wadnotes: saving an event: {err}");
            return;
        }
        self.editing.replace(None);
        self.stack.set_visible_child_name("view");
        self.ctx.events_changed();
        self.picked.set(e.start.date());
        self.month.set((e.start.year(), e.start.month()));
        self.refresh();
    }

    /// Leaves the editor (an event is only kept when you press Save).
    pub fn close(self: &Rc<Self>) {
        if self.editing.take().is_some() {
            self.stack.set_visible_child_name("view");
            self.refresh();
        }
    }

    fn delete_editing(self: &Rc<Self>) {
        let Some(e) = self.editing.take() else { return };
        self.stack.set_visible_child_name("view");
        if !e.id.is_empty() {
            match self.ctx.store.trash_event(&e.id) {
                Ok(t) => {
                    let c = self.clone();
                    let refresh: Rc<dyn Fn()> = Rc::new(move || {
                        c.ctx.events_changed();
                        c.refresh();
                    });
                    self.toast.offer(format!("“{}”", e.title), t, refresh);
                    self.ctx.events_changed();
                }
                Err(err) => eprintln!("wadnotes: deleting an event: {err}"),
            }
        }
        self.refresh();
    }

    /// For the snapshots: the first event coming up, open.
    pub fn open_first(self: &Rc<Self>) {
        let first = upcoming(&self.events.borrow(), now(), 30).first().map(|e| (*e).clone());
        if let Some(e) = first {
            self.open(e);
        }
    }
}

/// When an event is, in words: "2:30 PM – 3:00 PM", "All day", and with
/// its day in front for the week's list.
fn when(e: &Event, with_day: bool) -> String {
    let time = if e.all_day {
        "All day".to_string()
    } else {
        match e.end {
            Some(end) if end.date() == e.start.date() => format!("{} – {}", clock(e.start.time()), clock(end.time())),
            _ => clock(e.start.time()),
        }
    };
    if with_day { format!("{} {time}", day_words(e.start.date(), now().date())) } else { time }
}
