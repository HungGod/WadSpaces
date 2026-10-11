//! WadNotes, in the HUD: notes, tasks and a calendar, side by side at the
//! top right of the screen, above the wadspaces. The bar's WadNotes button
//! puts them away and brings them back; its menu (hover, or a long press)
//! turns each one on or off and picks the notespace. Collapsing the bar
//! hides them too, until it's back.
//!
//! - Notes and tasks belong to a notespace: the wadspace on screen, or the
//!   machine's own ("Default") for WadSpaces Client, Terminal and WadBrowser
//!   (model::scope_for). The menu looks at another one for a while (until
//!   the screen changes); each card says whose it shows.
//! - A card being edited grows (leftwards, over its neighbours) and the card
//!   you touch is drawn on top: the others never move.
//! - The calendar is one for all, each event in its wadspace's colour; a new
//!   event is for the wadspace on screen unless you pick another.
//! - Reminders pop up at the top of the screen, whatever's showing.
//!
//! The files are wad_notes' (on this machine, as the kiosk user).

mod calendar;
pub mod markup;
mod notebook;
mod reminder;
mod tasks;
mod widgets;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use chrono::{Local, NaiveDateTime};
use gtk::prelude::*;
use gtk::glib;
use gtk4_layer_shell::{Edge, KeyboardMode, LayerShell};
use wad_notes::{Colors, DEFAULT, ReminderFile, Store, Trashed};

use widgets::{clear, dot, icon_button, label, line, set_scope_class, text_button};

/// Run after an undo: the card draws what's back.
pub type Refresh = Rc<dyn Fn()>;

pub fn now() -> NaiveDateTime {
    Local::now().naive_local()
}

/// What the cards share: the files, which notespace is shown, the names and
/// colours, and a few calls back into the panel.
pub struct Ctx {
    pub store: Store,
    /// The wadspace on screen's notespace.
    view_scope: RefCell<String>,
    /// Another one looked at for a while (None: the screen's).
    looking: RefCell<Option<String>>,
    /// Every notespace: (id, name), Default first.
    spaces: RefCell<Vec<(String, String)>>,
    colors: RefCell<Colors>,
    relayout: RefCell<Option<Rc<dyn Fn()>>>,
    events_changed: RefCell<Option<Rc<dyn Fn()>>>,
}

impl Ctx {
    /// The notespace the notes and tasks show.
    pub fn scope(&self) -> String {
        self.looking.borrow().clone().unwrap_or_else(|| self.view_scope.borrow().clone())
    }

    pub fn view_scope(&self) -> String {
        self.view_scope.borrow().clone()
    }

    pub fn spaces(&self) -> Vec<(String, String)> {
        self.spaces.borrow().clone()
    }

    pub fn name_of(&self, scope: &str) -> String {
        if scope == DEFAULT {
            return "Default".into();
        }
        self.spaces.borrow().iter().find(|(id, _)| id == scope).map(|(_, n)| n.clone()).unwrap_or_else(|| scope.into())
    }

    /// A notespace's colour (handed out, and saved, the first time).
    pub fn color_of(&self, scope: &str) -> usize {
        if let Some(i) = self.colors.borrow().get(scope) {
            return i;
        }
        let c = self.store.colors_for([scope]);
        let i = c.get(scope).unwrap_or(0);
        self.colors.replace(c);
        i
    }

    fn set_color(&self, scope: &str, index: usize) {
        let mut c = self.colors.borrow().clone();
        c.set(scope, index);
        if let Err(e) = self.store.save_colors(&c) {
            eprintln!("wadnotes: {e}");
        }
        self.colors.replace(c);
    }

    /// The panel's size follows its contents.
    pub fn relayout(&self) {
        if let Some(f) = self.relayout.borrow().clone() {
            f();
        }
    }

    pub fn events_changed(&self) {
        if let Some(f) = self.events_changed.borrow().clone() {
            f();
        }
    }
}

/// The sections, left to right.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Section {
    Notes,
    Tasks,
    Calendar,
}

impl Section {
    pub const ALL: [Section; 3] = [Section::Notes, Section::Tasks, Section::Calendar];

    pub fn label(self) -> &'static str {
        match self {
            Section::Notes => "Notes",
            Section::Tasks => "Tasks",
            Section::Calendar => "Calendar",
        }
    }
}

/// A card's width, and a card being edited (it grows leftwards over the
/// card beside it).
const CARD: i32 = 340;
const WIDE: i32 = 480;
const GAP: i32 = 12;

pub struct Panel {
    pub ctx: Rc<Ctx>,
    pub win: gtk::Window,
    /// The cards, placed by hand (arrange): a card's growing never moves another.
    stage: gtk::Fixed,
    /// Each card in its own scroller (a card taller than the screen scrolls).
    frames: [gtk::ScrolledWindow; 3],
    /// The most a card may be tall (it stops above the bar).
    max_height: i32,
    /// The notespace picker, for the bar's WadNotes menu to show: a chip
    /// naming the notespace, which drops the list down.
    pub scope_box: gtk::Box,
    chip_dot: gtk::Label,
    chip_name: gtk::Label,
    /// The list (dropped down from the chip).
    pub picker: gtk::Revealer,
    looking_row: gtk::Box,
    looking_text: gtk::Label,
    back: gtk::Button,
    picker_list: gtk::Box,
    pub notes: Rc<notebook::NotesCard>,
    pub tasks: Rc<tasks::TasksCard>,
    pub calendar: Rc<calendar::CalendarCard>,
    pub reminder: Rc<reminder::Reminder>,
    on: Cell<[bool; 3]>,
    /// The bar's WadNotes button put them away.
    put_away: Cell<bool>,
    /// The bar is tucked away: so are they.
    bar_hidden: Cell<bool>,
    /// Which cards were being edited (one that starts comes to the front).
    was_editing: Cell<[bool; 3]>,
    /// The input region last set: the cards' rectangles (x, y, w, h).
    input: RefCell<Vec<(i32, i32, i32, i32)>>,
}

/// The screen's height, for the cards' limit (they stop above the bar).
fn screen_height() -> i32 {
    let monitor = gtk::gdk::Display::default()
        .and_then(|d| d.monitors().item(0))
        .and_then(|m| m.downcast::<gtk::gdk::Monitor>().ok());
    monitor.map(|m| m.geometry().height()).filter(|h| *h > 0).unwrap_or(800)
}

impl Panel {
    /// `store`: the notes' folders; `reminders`: where what you dismissed or
    /// snoozed is kept.
    pub fn build(app: &gtk::Application, store: Store, reminders: ReminderFile) -> Rc<Panel> {
        let ctx = Rc::new(Ctx {
            colors: RefCell::new(store.colors()),
            store,
            view_scope: RefCell::new(DEFAULT.into()),
            looking: RefCell::default(),
            spaces: RefCell::new(vec![(DEFAULT.into(), "Default".into())]),
            relayout: RefCell::default(),
            events_changed: RefCell::default(),
        });

        let win = gtk::Window::builder().application(app).title("wadspaces-notes").decorated(false).build();
        if gtk4_layer_shell::is_supported() {
            win.init_layer_shell();
            win.set_layer(gtk4_layer_shell::Layer::Overlay);
            win.set_namespace(Some("wadspaces-notes"));
            // Typing goes to it once you click into it (a note, a title).
            win.set_keyboard_mode(KeyboardMode::OnDemand);
            for edge in [Edge::Top, Edge::Right] {
                win.set_anchor(edge, true);
                win.set_margin(edge, 12);
            }
        } else {
            win.set_default_size(1100, 760);
        }

        let notes = notebook::NotesCard::build(ctx.clone());
        let tasks = tasks::TasksCard::build(ctx.clone());
        let calendar = calendar::CalendarCard::build(ctx.clone());
        let stage = gtk::Fixed::new();
        let max_height = screen_height() - 12 - 56 - 12;
        let frames = [&notes.root, &tasks.root, &calendar.root].map(|card| {
            let frame = gtk::ScrolledWindow::new();
            frame.set_hscrollbar_policy(gtk::PolicyType::Never);
            frame.set_child(Some(card));
            frame.set_visible(false);
            stage.put(&frame, 0.0, 0.0);
            frame
        });
        win.set_child(Some(&stage));

        // The notespace picker (the bar's menu shows it): a dropdown.
        let scope_box = gtk::Box::new(gtk::Orientation::Vertical, 4);
        let chip = gtk::Button::new();
        chip.add_css_class("scope-chip");
        let chip_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let chip_dot = dot(0);
        let chip_name = line("Default", "");
        chip_box.append(&chip_dot);
        chip_box.append(&chip_name);
        chip_box.append(&gtk::Image::from_icon_name("pan-down-symbolic"));
        chip.set_child(Some(&chip_box));
        scope_box.append(&chip);
        let looking_row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let looking_text = line("", "row-sub");
        let back = text_button("", &["link"]);
        looking_row.append(&looking_text);
        looking_row.append(&back);
        looking_row.set_visible(false);
        scope_box.append(&looking_row);
        let picker_list = gtk::Box::new(gtk::Orientation::Vertical, 2);
        let picker = gtk::Revealer::new();
        picker.set_child(Some(&picker_list));
        picker.set_reveal_child(false);
        scope_box.append(&picker);

        let reminder = reminder::Reminder::build(app, ctx.clone(), reminders);

        let panel = Rc::new(Panel {
            ctx: ctx.clone(),
            win,
            stage,
            frames,
            max_height,
            scope_box,
            chip_dot,
            chip_name,
            picker,
            looking_row,
            looking_text,
            back: back.clone(),
            picker_list,
            notes,
            tasks,
            calendar,
            reminder,
            on: Cell::new([false; 3]),
            put_away: Cell::new(false),
            bar_hidden: Cell::new(false),
            was_editing: Cell::new([false; 3]),
            input: RefCell::default(),
        });

        let weak = Rc::downgrade(&panel);
        ctx.relayout.replace(Some(Rc::new(move || {
            if let Some(p) = weak.upgrade() {
                p.arrange();
            }
        })));
        let weak = Rc::downgrade(&panel);
        ctx.events_changed.replace(Some(Rc::new(move || {
            if let Some(p) = weak.upgrade() {
                p.reminder.check();
            }
        })));
        // The card you touch comes to the front.
        for (i, frame) in panel.frames.iter().enumerate() {
            let press = gtk::GestureClick::new();
            press.set_propagation_phase(gtk::PropagationPhase::Capture);
            let weak = Rc::downgrade(&panel);
            press.connect_pressed(move |_, _, _, _| {
                if let Some(p) = weak.upgrade() {
                    p.raise(i);
                }
            });
            frame.add_controller(press);
        }
        // Clicks between and below the cards reach the wadspace: the
        // surface only takes them where a card is (after each repaint).
        let weak = Rc::downgrade(&panel);
        panel.win.connect_realize(move |w| {
            let Some(clock) = w.frame_clock() else { return };
            let weak = weak.clone();
            clock.connect_after_paint(move |_| {
                if let Some(p) = weak.upgrade() {
                    p.update_input();
                }
            });
        });
        let p = panel.clone();
        back.connect_clicked(move |_| p.look_at(None));
        let p = panel.clone();
        chip.connect_clicked(move |_| p.picker.set_reveal_child(!p.picker.reveals_child()));
        panel.show_scope();
        panel
    }

    fn editing(&self) -> [bool; 3] {
        [self.notes.is_editing(), self.tasks.is_editing(), self.calendar.is_editing()]
    }

    /// Places the cards that are on side by side from the right edge, each
    /// as tall as it needs (to the bar at most). One being edited is wider,
    /// growing leftwards over its neighbour, and comes to the front.
    fn arrange(&self) {
        let on = self.on.get();
        let editing = self.editing();
        let shown: Vec<usize> = (0..3).filter(|&i| on[i]).collect();
        let slots: Vec<(usize, i32, i32)> = shown
            .iter()
            .enumerate()
            .map(|(j, &i)| {
                let width = if editing[i] { WIDE } else { CARD };
                let right = (j as i32 + 1) * CARD + j as i32 * GAP;
                (i, right - width, width)
            })
            .collect();
        let shift = slots.iter().map(|s| s.1).min().unwrap_or(0).min(0);
        for (i, frame) in self.frames.iter().enumerate() {
            frame.set_visible(on[i]);
        }
        for (i, left, width) in slots {
            let frame = &self.frames[i];
            // The card's own width (a scroller that doesn't scroll sideways
            // ignores min-content-width).
            let card = frame.child().expect("a card");
            card.set_size_request(width, -1);
            let (_, natural, _, _) = card.measure(gtk::Orientation::Vertical, width);
            frame.set_min_content_height(natural.min(self.max_height));
            self.stage.move_(frame, (left - shift) as f64, 0.0);
        }
        let was = self.was_editing.replace(editing);
        for i in 0..3 {
            if editing[i] && !was[i] {
                self.raise(i);
            }
        }
        self.win.set_default_size(1, 1);
    }

    /// Draws card `i` over the others (the last child is drawn last).
    fn raise(&self, i: usize) {
        let frame = &self.frames[i];
        if self.stage.last_child().as_ref() != Some(frame.upcast_ref()) {
            frame.insert_before(&self.stage, None::<&gtk::Widget>);
        }
    }

    /// The surface takes input only where the cards are.
    fn update_input(&self) {
        let rects: Vec<(i32, i32, i32, i32)> = self
            .frames
            .iter()
            .filter(|f| f.is_visible())
            .filter_map(|f| f.compute_bounds(&self.stage))
            .map(|r| (r.x() as i32, r.y() as i32, r.width().ceil() as i32, r.height().ceil() as i32))
            .collect();
        if *self.input.borrow() == rects {
            return;
        }
        let Some(surface) = self.win.surface() else { return };
        let region = gtk::cairo::Region::create_rectangles(
            &rects.iter().map(|&(x, y, w, h)| gtk::cairo::RectangleInt::new(x, y, w, h)).collect::<Vec<_>>(),
        );
        surface.set_input_region(Some(&region));
        self.input.replace(rects);
    }

    // -------------------------------------------------------------- scope
    /// The screen changed (wadd's `view`/`workspaces`): its notespace, and
    /// the notespaces there are. Looking at another one ends here.
    pub fn set_view(self: &Rc<Self>, scope: String, spaces: Vec<(String, String)>) {
        let moved = *self.ctx.view_scope.borrow() != scope;
        let listed = *self.ctx.spaces.borrow() != spaces;
        if !moved && !listed {
            return;
        }
        self.ctx.spaces.replace(spaces);
        self.ctx.view_scope.replace(scope);
        if moved {
            self.ctx.looking.replace(None);
        }
        // Colours for every notespace up front (one save, not one each).
        let ids: Vec<String> = self.ctx.spaces().into_iter().map(|(id, _)| id).collect();
        self.ctx.colors.replace(self.ctx.store.colors_for(ids.iter().map(String::as_str)));
        if moved {
            self.scope_changed();
        } else {
            self.show_scope();
            self.calendar.refresh();
        }
        self.fill_picker();
    }

    /// Looks at another notespace (None: the screen's again).
    fn look_at(self: &Rc<Self>, scope: Option<String>) {
        let scope = scope.filter(|s| *s != self.ctx.view_scope());
        self.ctx.looking.replace(scope);
        self.picker.set_reveal_child(false);
        self.scope_changed();
        self.fill_picker();
    }

    fn scope_changed(&self) {
        self.notes.close();
        self.tasks.close();
        self.show_scope();
        self.notes.refresh();
        self.tasks.refresh();
        self.calendar.refresh();
        self.ctx.relayout();
    }

    /// Each card's head names the notespace it shows.
    fn show_scope(&self) {
        let scope = self.ctx.scope();
        let looking = self.ctx.looking.borrow().is_some();
        let (color, name) = (self.ctx.color_of(&scope), self.ctx.name_of(&scope));
        self.notes.scope_tag.set(color, &name, looking);
        self.tasks.scope_tag.set(color, &name, looking);
        set_scope_class(&self.chip_dot, color);
        self.chip_name.set_label(&name);
        self.looking_row.set_visible(looking);
        if looking {
            self.looking_text.set_label(&format!("Looking at {name}"));
            self.back.set_label(&format!("Back to {}", self.ctx.name_of(&self.ctx.view_scope())));
        }
    }

    /// The notespaces to pick from, each with its colour (tap the dot to change it).
    pub fn fill_picker(self: &Rc<Self>) {
        clear(&self.picker_list);
        let current = self.ctx.scope();
        let on_screen = self.ctx.view_scope();
        for (id, name) in self.ctx.spaces() {
            let color = self.ctx.color_of(&id);
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
            let swatch = gtk::Button::new();
            swatch.add_css_class("flat-icon");
            swatch.set_child(Some(&dot(color)));
            swatch.set_tooltip_text(Some("Its colour"));
            let pick = gtk::Button::new();
            pick.add_css_class("row");
            if id == current {
                pick.add_css_class("picked");
            }
            pick.set_hexpand(true);
            let inner = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            inner.append(&line(&name, "row-title"));
            if id == on_screen {
                inner.append(&label("on screen", "row-sub"));
            }
            pick.set_child(Some(&inner));
            row.append(&swatch);
            row.append(&pick);
            self.picker_list.append(&row);

            let swatches = gtk::FlowBox::new();
            swatches.set_selection_mode(gtk::SelectionMode::None);
            swatches.set_max_children_per_line(6);
            swatches.set_min_children_per_line(6);
            for (i, (cname, _)) in wad_notes::PALETTE.iter().enumerate() {
                let b = gtk::Button::new();
                b.add_css_class("flat-icon");
                b.set_child(Some(&dot(i)));
                b.set_tooltip_text(Some(cname));
                let (p, id) = (self.clone(), id.clone());
                b.connect_clicked(move |_| {
                    p.ctx.set_color(&id, i);
                    p.fill_picker();
                    p.show_scope();
                    p.calendar.refresh();
                });
                swatches.insert(&b, -1);
            }
            let reveal = gtk::Revealer::new();
            reveal.set_child(Some(&swatches));
            self.picker_list.append(&reveal);
            swatch.connect_clicked(move |_| reveal.set_reveal_child(!reveal.reveals_child()));
            let (p, id) = (self.clone(), id.clone());
            pick.connect_clicked(move |_| p.look_at(Some(id.clone())));
        }
    }

    // ----------------------------------------------------------- sections
    /// Turns a section on or off (the bar's menu). Turning one on brings
    /// WadNotes back if it was put away.
    pub fn set_section(&self, s: Section, on: bool) {
        let mut all = self.on.get();
        all[s as usize] = on;
        self.on.set(all);
        if on {
            self.put_away.set(false);
        } else {
            match s {
                Section::Notes => self.notes.close(),
                Section::Tasks => self.tasks.close(),
                Section::Calendar => self.calendar.close(),
            }
        }
        self.show();
    }

    pub fn section_on(&self, s: Section) -> bool {
        self.on.get()[s as usize]
    }

    pub fn any_on(&self) -> bool {
        self.on.get().iter().any(|on| *on)
    }

    /// The bar's WadNotes button: every card that's on goes away, or comes back.
    pub fn set_put_away(&self, away: bool) {
        self.put_away.set(away);
        self.show();
    }

    pub fn is_put_away(&self) -> bool {
        self.put_away.get()
    }

    /// On screen now (some card on, not put away, the bar out).
    pub fn showing(&self) -> bool {
        self.any_on() && !self.put_away.get() && !self.bar_hidden.get()
    }

    /// The bar was tucked away (hide everything) or brought back (show what was on).
    pub fn set_hidden(&self, hidden: bool) {
        self.bar_hidden.set(hidden);
        self.show();
    }

    fn show(&self) {
        let visible = self.showing();
        if !visible {
            // Typing in progress is kept (the editors stay as they are); saved now.
            self.notes.flush();
            self.tasks.flush();
        }
        if visible && !self.win.is_visible() {
            self.notes.refresh_if_idle();
            self.tasks.refresh_if_idle();
            self.calendar.refresh_if_idle();
        }
        self.arrange();
        if visible {
            self.win.present();
        } else {
            self.win.set_visible(false);
        }
    }

    /// Every half minute: reminders due, and the calendar's "today".
    pub fn tick(&self) {
        self.reminder.check();
        if self.win.is_visible() && self.section_on(Section::Calendar) {
            self.calendar.tick();
        }
    }
}

/// "Deleted …  Undo" in a card, for a few seconds after a delete.
pub(crate) struct Toast {
    ctx: Rc<Ctx>,
    pub row: gtk::Box,
    text: gtk::Label,
    undo: RefCell<Option<(Trashed, Refresh)>>,
    timer: RefCell<Option<glib::SourceId>>,
}

impl Toast {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Toast> {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        row.add_css_class("toast-row");
        let text = line("", "row-title");
        let button = text_button("Undo", &["small-button"]);
        row.append(&text);
        row.append(&button);
        row.set_visible(false);
        let toast = Rc::new(Toast { ctx, row, text, undo: RefCell::default(), timer: RefCell::default() });
        let t = toast.clone();
        button.connect_clicked(move |_| t.undo());
        toast
    }

    /// `what` was deleted (moved to the trash): offer to put it back.
    pub fn offer(self: &Rc<Self>, what: String, t: Trashed, refresh: Refresh) {
        self.text.set_label(&format!("Deleted {what}"));
        self.row.set_visible(true);
        self.undo.replace(Some((t, refresh)));
        if let Some(id) = self.timer.take() {
            id.remove();
        }
        let weak = Rc::downgrade(self);
        let id = glib::timeout_add_seconds_local_once(8, move || {
            if let Some(t) = weak.upgrade() {
                t.timer.replace(None);
                t.row.set_visible(false);
                t.undo.replace(None);
                t.ctx.relayout();
            }
        });
        self.timer.replace(Some(id));
        self.ctx.relayout();
    }

    fn undo(&self) {
        if let Some(id) = self.timer.take() {
            id.remove();
        }
        self.row.set_visible(false);
        if let Some((t, refresh)) = self.undo.take() {
            if let Err(e) = self.ctx.store.restore(&t) {
                eprintln!("wadnotes: undo: {e}");
            }
            refresh();
        }
        self.ctx.relayout();
    }
}

/// Whose notes a card shows: the notespace's dot and name.
pub(crate) struct ScopeTag {
    pub row: gtk::Box,
    dot: gtk::Label,
    name: gtk::Label,
}

impl ScopeTag {
    fn new() -> ScopeTag {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        row.add_css_class("scope-tag");
        let dot = dot(0);
        let name = gtk::Label::new(None);
        name.set_ellipsize(gtk::pango::EllipsizeMode::End);
        name.set_max_width_chars(16);
        row.append(&dot);
        row.append(&name);
        ScopeTag { row, dot, name }
    }

    pub fn set(&self, color: usize, name: &str, looking: bool) {
        set_scope_class(&self.dot, color);
        self.name.set_label(name);
        if looking { self.row.add_css_class("looking") } else { self.row.remove_css_class("looking") }
        self.row.set_tooltip_text(Some(&if looking {
            format!("Looking at {name}'s (the bar's WadNotes menu goes back)")
        } else {
            format!("{name}'s, the wadspace on screen")
        }));
    }
}

/// A card's head: its name, whose it is, a count, and a + to make one.
pub(crate) fn card_head(title: &str, add_tip: &str) -> (gtk::Box, ScopeTag, gtk::Label, gtk::Button) {
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let name = label(title, "heading");
    let tag = ScopeTag::new();
    let count = label("", "count");
    count.set_hexpand(true);
    let add = icon_button("list-add-symbolic", add_tip);
    head.append(&name);
    head.append(&tag.row);
    head.append(&count);
    head.append(&add);
    (head, tag, count, add)
}
