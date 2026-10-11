//! The Tasks card, Jira-style: the notespace's tasks with a key each (WRI-3),
//! a status you tap to move on, a priority and maybe a due day; one opens in
//! place to edit (saved as you go).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;
use wad_notes::{Priority, Status, Task};

use super::widgets::{
    Chips, calendar_day, clear, day_words, field, fit, glib_date, icon_button, label, line, md_view, text_button,
    text_of,
};
use super::{Ctx, ScopeTag, Toast, card_head, now};

const SAVE_AFTER: Duration = Duration::from_millis(600);
const LIST_MAX: i32 = 420;

/// The list's filter: by status, or all of them.
const FILTERS: [&str; 4] = ["All", "To do", "In progress", "Done"];

fn shown(filter: usize, s: Status) -> bool {
    match filter {
        1 => s == Status::Todo,
        2 => s == Status::Doing,
        3 => s == Status::Done,
        _ => true,
    }
}

fn status_class(s: Status) -> &'static str {
    match s {
        Status::Todo => "todo",
        Status::Doing => "doing",
        Status::Done => "done",
    }
}

fn priority_mark(p: Priority) -> (&'static str, &'static str) {
    match p {
        Priority::High => ("▲", "high"),
        Priority::Medium => ("■", "medium"),
        Priority::Low => ("▼", "low"),
    }
}

pub struct TasksCard {
    ctx: Rc<Ctx>,
    pub root: gtk::Box,
    pub scope_tag: ScopeTag,
    toast: Rc<Toast>,
    count: gtk::Label,
    filter: Rc<Chips>,
    stack: gtk::Stack,
    list: gtk::Box,
    list_scroll: gtk::ScrolledWindow,
    title: gtk::Entry,
    status: Rc<Chips>,
    priority: Rc<Chips>,
    due_text: gtk::Label,
    due_clear: gtk::Button,
    due_pick: gtk::Revealer,
    due_calendar: gtk::Calendar,
    text: gtk::TextView,
    editing: RefCell<Option<(String, Task)>>,
    /// The due day in the editor (the calendar only shows it while open).
    due: Cell<Option<chrono::NaiveDate>>,
    save_soon: RefCell<Option<glib::SourceId>>,
    filling: Cell<bool>,
}

impl TasksCard {
    pub fn build(ctx: Rc<Ctx>) -> Rc<TasksCard> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 8);
        root.add_css_class("notes-card");
        let (head, scope_tag, count, add) = card_head("Tasks", "New task");
        root.append(&head);
        let toast = Toast::new(ctx.clone());
        root.append(&toast.row);

        let stack = gtk::Stack::new();
        stack.set_vhomogeneous(false);
        stack.set_hhomogeneous(true);

        let board = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let filter = Chips::new(&FILTERS);
        board.append(&filter.row);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 2);
        let list_scroll = gtk::ScrolledWindow::new();
        list_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        list_scroll.set_propagate_natural_height(true);
        list_scroll.set_max_content_height(LIST_MAX);
        list_scroll.set_child(Some(&list));
        board.append(&list_scroll);
        stack.add_named(&board, Some("list"));

        let editor = gtk::Box::new(gtk::Orientation::Vertical, 4);
        let bar = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let back = icon_button("go-previous-symbolic", "Back to the tasks");
        let key = line("", "key");
        let delete = icon_button("user-trash-symbolic", "Delete this task");
        bar.append(&back);
        bar.append(&key);
        bar.append(&delete);
        editor.append(&bar);
        let title = gtk::Entry::new();
        title.add_css_class("title-entry");
        title.set_placeholder_text(Some("What needs doing"));
        editor.append(&title);
        editor.append(&field("STATUS"));
        let status = Chips::new(&Status::ALL.map(Status::label));
        editor.append(&status.row);
        editor.append(&field("PRIORITY"));
        let priority = Chips::new(&Priority::ALL.map(Priority::label));
        editor.append(&priority.row);
        editor.append(&field("DUE"));
        let due_row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let due_text = line("No due day", "row-title");
        let due_set = text_button("Pick", &["small-button"]);
        let due_clear = icon_button("window-close-symbolic", "No due day");
        due_row.append(&due_text);
        due_row.append(&due_set);
        due_row.append(&due_clear);
        editor.append(&due_row);
        let due_calendar = gtk::Calendar::new();
        let due_pick = gtk::Revealer::new();
        due_pick.set_child(Some(&due_calendar));
        editor.append(&due_pick);
        editor.append(&field("DESCRIPTION"));
        let text = md_view(110);
        let text_scroll = gtk::ScrolledWindow::new();
        text_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        text_scroll.set_propagate_natural_height(true);
        text_scroll.set_max_content_height(240);
        text_scroll.set_min_content_height(110);
        text_scroll.set_child(Some(&text));
        editor.append(&text_scroll);
        stack.add_named(&editor, Some("edit"));
        stack.set_visible_child_name("list");
        root.append(&stack);

        let card = Rc::new(TasksCard {
            ctx,
            root,
            scope_tag,
            toast,
            count,
            filter,
            stack,
            list,
            list_scroll,
            title,
            status,
            priority,
            due_text,
            due_clear,
            due_pick,
            due_calendar,
            text,
            editing: RefCell::default(),
            due: Cell::new(None),
            save_soon: RefCell::default(),
            filling: Cell::new(false),
        });

        let c = card.clone();
        add.connect_clicked(move |_| {
            c.close();
            c.open(Task::new(now()));
            c.title.grab_focus();
        });
        let c = card.clone();
        card.filter.on_change(move |_| c.refresh());
        let c = card.clone();
        back.connect_clicked(move |_| c.close());
        let c = card.clone();
        delete.connect_clicked(move |_| c.delete());
        let c = card.clone();
        card.title.connect_changed(move |_| c.changed());
        let c = card.clone();
        card.text.buffer().connect_changed(move |_| c.changed());
        let c = card.clone();
        card.status.on_change(move |_| c.changed());
        let c = card.clone();
        card.priority.on_change(move |_| c.changed());
        let c = card.clone();
        due_set.connect_clicked(move |_| {
            let open = !c.due_pick.reveals_child();
            if open && let Some(d) = glib_date(c.due.get().unwrap_or_else(|| now().date())) {
                c.due_calendar.select_day(&d);
            }
            c.due_pick.set_reveal_child(open);
            c.ctx.relayout();
        });
        let c = card.clone();
        card.due_calendar.connect_day_selected(move |cal| {
            if c.filling.get() {
                return;
            }
            c.set_due(calendar_day(cal));
            c.due_pick.set_reveal_child(false);
            c.changed();
            c.ctx.relayout();
        });
        let c = card.clone();
        card.due_clear.connect_clicked(move |_| {
            c.set_due(None);
            c.due_pick.set_reveal_child(false);
            c.changed();
            c.ctx.relayout();
        });
        // Its key, shown in the editor's bar.
        let c = card.clone();
        card.stack.connect_visible_child_name_notify(move |_| {
            let k = c.editing.borrow().as_ref().map(|(_, k)| k.key.clone()).unwrap_or_default();
            key.set_label(if k.is_empty() { "New task" } else { &k });
        });
        card.refresh();
        card
    }

    pub fn refresh(self: &Rc<Self>) {
        clear(&self.list);
        let tasks = self.ctx.store.tasks(&self.ctx.scope());
        let open = tasks.iter().filter(|k| k.status != Status::Done).count();
        self.count.set_label(&if tasks.is_empty() { String::new() } else { format!("{open} open") });
        let today = now().date();
        let filter = self.filter.get();
        let shown: Vec<Task> = tasks.into_iter().filter(|k| shown(filter, k.status)).collect();
        if shown.is_empty() {
            let why = if filter == 0 { "No tasks here yet: + adds one." } else { "None like that." };
            self.list.append(&label(why, "empty-note"));
        }
        for k in shown {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            let status = text_button(k.status.label(), &["status", status_class(k.status)]);
            status.set_valign(gtk::Align::Center);
            status.set_tooltip_text(Some("Move it on"));
            let open = gtk::Button::new();
            open.add_css_class("row");
            open.set_hexpand(true);
            let inner = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            let words = gtk::Box::new(gtk::Orientation::Vertical, 1);
            words.set_hexpand(true);
            let title = line(if k.title.is_empty() { "Untitled" } else { &k.title }, "row-title");
            if k.status == Status::Done {
                title.add_css_class("done");
            }
            words.append(&title);
            let sub = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            sub.append(&label(&k.key, "key"));
            if let Some(d) = k.due {
                let due = label(&format!("due {}", day_words(d, today)), "row-sub");
                if k.overdue(today) {
                    due.add_css_class("overdue");
                }
                sub.append(&due);
            }
            words.append(&sub);
            inner.append(&words);
            let (mark, class) = priority_mark(k.priority);
            let prio = label(mark, "prio");
            prio.add_css_class(class);
            prio.set_tooltip_text(Some(&format!("{} priority", k.priority.label())));
            inner.append(&prio);
            open.set_child(Some(&inner));
            row.append(&status);
            row.append(&open);
            let (c, task) = (self.clone(), k.clone());
            open.connect_clicked(move |_| c.open(task.clone()));
            let (c, scope) = (self.clone(), self.ctx.scope());
            status.connect_clicked(move |_| {
                let mut moved = Task { status: k.status.next(), ..k.clone() };
                if let Err(e) = c.ctx.store.save_task(&scope, &mut moved) {
                    eprintln!("wadnotes: saving a task: {e}");
                }
                c.refresh();
            });
            self.list.append(&row);
        }
        fit(&self.list_scroll, LIST_MAX);
        self.ctx.relayout();
    }

    /// A task is open (the card is wider while it is).
    pub fn is_editing(&self) -> bool {
        self.editing.borrow().is_some()
    }

    pub fn refresh_if_idle(self: &Rc<Self>) {
        if self.editing.borrow().is_none() {
            self.refresh();
        }
    }

    fn set_due(&self, d: Option<chrono::NaiveDate>) {
        self.due.set(d);
        self.due_text.set_label(&match d {
            Some(d) => format!("{} · {}", day_words(d, now().date()), d.format("%-d %b")),
            None => "No due day".into(),
        });
        self.due_clear.set_visible(d.is_some());
    }

    fn open(&self, task: Task) {
        self.filling.set(true);
        self.title.set_text(&task.title);
        self.text.buffer().set_text(&task.body);
        self.status.set(Status::ALL.iter().position(|s| *s == task.status).unwrap_or(0));
        self.priority.set(Priority::ALL.iter().position(|p| *p == task.priority).unwrap_or(1));
        self.set_due(task.due);
        self.due_pick.set_reveal_child(false);
        self.editing.replace(Some((self.ctx.scope(), task)));
        self.filling.set(false);
        self.stack.set_visible_child_name("edit");
        self.ctx.relayout();
    }

    fn changed(self: &Rc<Self>) {
        if self.filling.get() || self.editing.borrow().is_none() {
            return;
        }
        if let Some(id) = self.save_soon.take() {
            id.remove();
        }
        let c = self.clone();
        let id = glib::timeout_add_local_once(SAVE_AFTER, move || {
            c.save_soon.replace(None);
            c.save();
        });
        self.save_soon.replace(Some(id));
    }

    fn save(&self) {
        let mut editing = self.editing.borrow_mut();
        let Some((scope, task)) = editing.as_mut() else { return };
        let next = Task {
            title: self.title.text().trim().to_string(),
            body: text_of(&self.text),
            status: Status::ALL[self.status.get()],
            priority: Priority::ALL[self.priority.get()],
            due: self.due.get(),
            ..task.clone()
        };
        if next == *task || (next.key.is_empty() && next.title.is_empty() && next.body.trim().is_empty()) {
            return;
        }
        let mut next = next;
        match self.ctx.store.save_task(scope, &mut next) {
            Ok(()) => *task = next,
            Err(e) => eprintln!("wadnotes: saving a task: {e}"),
        }
    }

    pub fn flush(&self) {
        if let Some(id) = self.save_soon.take() {
            id.remove();
        }
        self.save();
    }

    pub fn close(self: &Rc<Self>) {
        let was_open = self.editing.borrow().is_some();
        self.flush();
        self.editing.replace(None);
        self.stack.set_visible_child_name("list");
        if was_open {
            self.refresh();
        }
    }

    fn delete(self: &Rc<Self>) {
        if let Some(id) = self.save_soon.take() {
            id.remove();
        }
        let Some((scope, task)) = self.editing.take() else { return };
        self.stack.set_visible_child_name("list");
        if !task.key.is_empty() {
            match self.ctx.store.trash_task(&scope, &task.key) {
                Ok(t) => {
                    let c = self.clone();
                    self.toast.offer(task.key.clone(), t, Rc::new(move || c.refresh()));
                }
                Err(e) => eprintln!("wadnotes: deleting a task: {e}"),
            }
        }
        self.refresh();
    }
}
