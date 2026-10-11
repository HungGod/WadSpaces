//! Small pieces WadNotes' cards share: labels, flat icon buttons, a
//! wadspace's colour dot, choice chips and text helpers. No popovers
//! anywhere: a layer surface's popups can open off the screen (sway doesn't
//! flip them), so every choice is inline.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::prelude::*;

pub fn label(text: &str, class: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.set_xalign(0.0);
    if !class.is_empty() {
        l.add_css_class(class);
    }
    l
}

/// A label that ends in … rather than growing the panel.
pub fn line(text: &str, class: &str) -> gtk::Label {
    let l = label(text, class);
    l.set_ellipsize(gtk::pango::EllipsizeMode::End);
    l.set_hexpand(true);
    l
}

pub fn icon_button(icon: &str, tooltip: &str) -> gtk::Button {
    let b = gtk::Button::from_icon_name(icon);
    b.add_css_class("flat-icon");
    b.set_tooltip_text(Some(tooltip));
    b
}

pub fn text_button(text: &str, classes: &[&str]) -> gtk::Button {
    let b = gtk::Button::with_label(text);
    for c in classes {
        b.add_css_class(c);
    }
    b
}

/// A wadspace's colour: a ● in it.
pub fn dot(index: usize) -> gtk::Label {
    let d = gtk::Label::new(Some("●"));
    d.add_css_class("dot");
    set_scope_class(&d, index);
    d
}

/// Points `w`'s scope-N class at `index` (dropping the old one).
pub fn set_scope_class(w: &impl IsA<gtk::Widget>, index: usize) {
    for i in 0..wad_notes::PALETTE.len() {
        w.remove_css_class(&format!("scope-{i}"));
    }
    w.add_css_class(&format!("scope-{index}"));
}

/// A scroller as tall as what's in it, up to `max` (in the panel, which
/// scrolls itself, it would otherwise be squeezed to its minimum: a line).
pub fn fit(scroll: &gtk::ScrolledWindow, max: i32) {
    if let Some(child) = scroll.child() {
        let (_, natural, _, _) = child.measure(gtk::Orientation::Vertical, 350);
        scroll.set_min_content_height(natural.min(max));
    }
}

pub fn clear(b: &gtk::Box) {
    while let Some(c) = b.first_child() {
        b.remove(&c);
    }
}

pub fn text_of(view: &gtk::TextView) -> String {
    let b = view.buffer();
    b.text(&b.start_iter(), &b.end_iter(), false).to_string()
}

/// A markdown editor: monospace, wrapping, at least `min_height` tall.
pub fn md_view(min_height: i32) -> gtk::TextView {
    let v = gtk::TextView::new();
    v.add_css_class("md");
    v.set_wrap_mode(gtk::WrapMode::WordChar);
    v.set_monospace(true);
    v.set_size_request(-1, min_height);
    v.set_accepts_tab(false);
    v
}

pub fn field(name: &str) -> gtk::Label {
    let l = label(name, "field-label");
    l.set_margin_top(6);
    l
}

/// One of a few choices, as a row of chips (the picked one lit).
type OnPick = Box<dyn Fn(usize)>;

pub struct Chips {
    pub row: gtk::FlowBox,
    buttons: Vec<gtk::Button>,
    picked: Cell<usize>,
    changed: RefCell<Option<OnPick>>,
}

impl Chips {
    pub fn new(labels: &[&str]) -> Rc<Self> {
        Self::with(labels.iter().map(|l| (None, l.to_string())).collect())
    }

    /// Chips with a colour dot each (wadspaces): (colour, name).
    pub fn with(items: Vec<(Option<usize>, String)>) -> Rc<Self> {
        let row = gtk::FlowBox::new();
        row.set_selection_mode(gtk::SelectionMode::None);
        row.set_row_spacing(4);
        row.set_column_spacing(4);
        row.set_max_children_per_line(8);
        row.set_homogeneous(false);
        let buttons: Vec<gtk::Button> = items
            .iter()
            .map(|(color, text)| {
                let b = gtk::Button::new();
                b.add_css_class("chip");
                let inner = gtk::Box::new(gtk::Orientation::Horizontal, 5);
                if let Some(c) = color {
                    inner.append(&dot(*c));
                }
                inner.append(&gtk::Label::new(Some(text)));
                b.set_child(Some(&inner));
                row.insert(&b, -1);
                b
            })
            .collect();
        let me = Rc::new(Self { row, buttons, picked: Cell::new(0), changed: RefCell::default() });
        for (i, b) in me.buttons.iter().enumerate() {
            let weak = Rc::downgrade(&me);
            b.connect_clicked(move |_| {
                if let Some(me) = weak.upgrade() {
                    me.set(i);
                    if let Some(f) = me.changed.borrow().as_ref() {
                        f(i);
                    }
                }
            });
        }
        me.set(0);
        me
    }

    pub fn set(&self, i: usize) {
        self.picked.set(i.min(self.buttons.len().saturating_sub(1)));
        for (j, b) in self.buttons.iter().enumerate() {
            if j == self.picked.get() { b.add_css_class("on") } else { b.remove_css_class("on") }
        }
    }

    pub fn get(&self) -> usize {
        self.picked.get()
    }

    pub fn on_change(&self, f: impl Fn(usize) + 'static) {
        self.changed.replace(Some(Box::new(f)));
    }
}

/// A time of day as two spin buttons (hours, minutes in fives).
pub struct TimePick {
    pub row: gtk::Box,
    hour: gtk::SpinButton,
    minute: gtk::SpinButton,
}

fn two_digits(s: &gtk::SpinButton) -> gtk::glib::Propagation {
    s.set_text(&format!("{:02}", s.value() as i64));
    gtk::glib::Propagation::Stop
}

impl TimePick {
    pub fn new() -> Self {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let hour = gtk::SpinButton::with_range(0.0, 23.0, 1.0);
        let minute = gtk::SpinButton::with_range(0.0, 55.0, 5.0);
        for s in [&hour, &minute] {
            s.set_wrap(true);
            s.set_numeric(true);
            s.set_width_chars(2);
            s.set_orientation(gtk::Orientation::Vertical);
            s.connect_output(two_digits);
        }
        row.append(&hour);
        row.append(&label(":", "when"));
        row.append(&minute);
        Self { row, hour, minute }
    }

    pub fn set(&self, t: chrono::NaiveTime) {
        use chrono::Timelike;
        self.hour.set_value(t.hour() as f64);
        self.minute.set_value((t.minute() / 5 * 5) as f64);
    }

    pub fn get(&self) -> chrono::NaiveTime {
        chrono::NaiveTime::from_hms_opt(self.hour.value() as u32, self.minute.value() as u32, 0).unwrap_or_default()
    }
}

/// chrono's day as GTK's (for a GtkCalendar).
pub fn glib_date(d: chrono::NaiveDate) -> Option<gtk::glib::DateTime> {
    use chrono::Datelike;
    gtk::glib::DateTime::from_local(d.year(), d.month() as i32, d.day() as i32, 12, 0, 0.0).ok()
}

pub fn calendar_day(c: &gtk::Calendar) -> Option<chrono::NaiveDate> {
    let d = c.date();
    chrono::NaiveDate::from_ymd_opt(d.year(), d.month() as u32, d.day_of_month() as u32)
}

/// A day as people say it: "Today", "Tomorrow", "Tue 13 Oct".
pub fn day_words(d: chrono::NaiveDate, today: chrono::NaiveDate) -> String {
    match (d - today).num_days() {
        0 => "Today".into(),
        1 => "Tomorrow".into(),
        -1 => "Yesterday".into(),
        _ => d.format("%a %-d %b").to_string(),
    }
}

/// A time as the bar's clock has it: "2:30 PM".
pub fn clock(t: chrono::NaiveTime) -> String {
    t.format("%-I:%M %p").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_and_times_in_words() {
        let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let today = d("2026-10-09");
        assert_eq!(day_words(today, today), "Today");
        assert_eq!(day_words(d("2026-10-10"), today), "Tomorrow");
        assert_eq!(day_words(d("2026-10-13"), today), "Tue 13 Oct");
        assert_eq!(clock(chrono::NaiveTime::from_hms_opt(14, 5, 0).unwrap()), "2:05 PM");
    }
}
