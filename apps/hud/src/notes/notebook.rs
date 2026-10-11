//! The Notes card: the notespace's notes, newest first; one opens in place
//! to edit (markdown, saved as you type) or to read (the preview).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;
use wad_notes::Note;

use super::widgets::{clear, clock, day_words, fit, icon_button, label, line, md_view, text_button, text_of};
use super::{Ctx, ScopeTag, Toast, card_head, markup, now};

/// Typing pauses this long before it's saved.
const SAVE_AFTER: Duration = Duration::from_millis(600);
/// The list's most height before it scrolls.
const LIST_MAX: i32 = 420;

pub struct NotesCard {
    ctx: Rc<Ctx>,
    pub root: gtk::Box,
    pub scope_tag: ScopeTag,
    toast: Rc<Toast>,
    count: gtk::Label,
    stack: gtk::Stack,
    list: gtk::Box,
    list_scroll: gtk::ScrolledWindow,
    title: gtk::Entry,
    text: gtk::TextView,
    edit_scroll: gtk::ScrolledWindow,
    preview: gtk::Label,
    preview_scroll: gtk::ScrolledWindow,
    mode: gtk::Button,
    /// The note open, and whose it is.
    editing: RefCell<Option<(String, Note)>>,
    save_soon: RefCell<Option<glib::SourceId>>,
    /// Set while the editor is filled in (not a change of yours).
    filling: Cell<bool>,
}

/// When a note was last changed: the time today, else the day.
fn age(n: &Note) -> String {
    let today = now().date();
    if n.updated.date() == today { clock(n.updated.time()) } else { day_words(n.updated.date(), today) }
}

impl NotesCard {
    pub fn build(ctx: Rc<Ctx>) -> Rc<NotesCard> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 8);
        root.add_css_class("notes-card");
        let (head, scope_tag, count, add) = card_head("Notes", "New note");
        root.append(&head);
        let toast = Toast::new(ctx.clone());
        root.append(&toast.row);

        let stack = gtk::Stack::new();
        stack.set_vhomogeneous(false);
        stack.set_hhomogeneous(true);

        let list = gtk::Box::new(gtk::Orientation::Vertical, 2);
        let list_scroll = gtk::ScrolledWindow::new();
        list_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        list_scroll.set_propagate_natural_height(true);
        list_scroll.set_max_content_height(LIST_MAX);
        list_scroll.set_child(Some(&list));
        stack.add_named(&list_scroll, Some("list"));

        let editor = gtk::Box::new(gtk::Orientation::Vertical, 8);
        let bar = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let back = icon_button("go-previous-symbolic", "Back to the notes");
        let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        spacer.set_hexpand(true);
        let mode = text_button("Preview", &["small-button"]);
        let delete = icon_button("user-trash-symbolic", "Delete this note");
        bar.append(&back);
        bar.append(&spacer);
        bar.append(&mode);
        bar.append(&delete);
        editor.append(&bar);
        let title = gtk::Entry::new();
        title.add_css_class("title-entry");
        title.set_placeholder_text(Some("Title"));
        editor.append(&title);
        let text = md_view(200);
        let edit_scroll = gtk::ScrolledWindow::new();
        edit_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        edit_scroll.set_propagate_natural_height(true);
        edit_scroll.set_max_content_height(360);
        edit_scroll.set_min_content_height(200);
        edit_scroll.set_child(Some(&text));
        editor.append(&edit_scroll);
        let preview = label("", "preview");
        preview.set_wrap(true);
        preview.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        preview.set_selectable(true);
        preview.set_valign(gtk::Align::Start);
        let preview_scroll = gtk::ScrolledWindow::new();
        preview_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        preview_scroll.set_propagate_natural_height(true);
        preview_scroll.set_max_content_height(360);
        preview_scroll.set_min_content_height(200);
        preview_scroll.set_child(Some(&preview));
        preview_scroll.set_visible(false);
        editor.append(&preview_scroll);
        editor.append(&label("Markdown: # heading, **bold**, - list, - [ ] to do", "row-sub"));
        stack.add_named(&editor, Some("edit"));
        stack.set_visible_child_name("list");
        root.append(&stack);

        let card = Rc::new(NotesCard {
            ctx,
            root,
            scope_tag,
            toast,
            count,
            stack,
            list,
            list_scroll,
            title,
            text,
            edit_scroll,
            preview,
            preview_scroll,
            mode,
            editing: RefCell::default(),
            save_soon: RefCell::default(),
            filling: Cell::new(false),
        });

        let c = card.clone();
        add.connect_clicked(move |_| {
            c.close();
            c.open(Note::new(now()));
            c.title.grab_focus();
        });
        let c = card.clone();
        back.connect_clicked(move |_| c.close());
        let c = card.clone();
        delete.connect_clicked(move |_| c.delete());
        let c = card.clone();
        card.mode.connect_clicked(move |_| c.toggle_preview());
        let c = card.clone();
        card.title.connect_changed(move |_| c.changed());
        let c = card.clone();
        card.text.buffer().connect_changed(move |_| c.changed());
        card.refresh();
        card
    }

    /// The list again, for the notespace shown.
    pub fn refresh(self: &Rc<Self>) {
        clear(&self.list);
        let notes = self.ctx.store.notes(&self.ctx.scope());
        self.count.set_label(&match notes.len() {
            0 => String::new(),
            n => n.to_string(),
        });
        if notes.is_empty() {
            let empty = label("No notes here yet: + starts one.", "empty-note");
            self.list.append(&empty);
        }
        for n in notes {
            let row = gtk::Button::new();
            row.add_css_class("row");
            let inner = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            let words = gtk::Box::new(gtk::Orientation::Vertical, 1);
            words.set_hexpand(true);
            words.append(&line(if n.title.is_empty() { "Untitled" } else { &n.title }, "row-title"));
            let snippet = n.snippet(70);
            if !snippet.is_empty() {
                words.append(&line(&snippet, "row-sub"));
            }
            inner.append(&words);
            let when = label(&age(&n), "when");
            when.set_valign(gtk::Align::Start);
            inner.append(&when);
            row.set_child(Some(&inner));
            let c = self.clone();
            row.connect_clicked(move |_| c.open(n.clone()));
            self.list.append(&row);
        }
        fit(&self.list_scroll, LIST_MAX);
        self.ctx.relayout();
    }

    /// A note is open (the card is wider while it is).
    pub fn is_editing(&self) -> bool {
        self.editing.borrow().is_some()
    }

    /// Refreshes unless a note is open (what you're typing stays put).
    pub fn refresh_if_idle(self: &Rc<Self>) {
        if self.editing.borrow().is_none() {
            self.refresh();
        }
    }

    fn open(&self, note: Note) {
        self.filling.set(true);
        self.title.set_text(&note.title);
        self.text.buffer().set_text(&note.body);
        self.filling.set(false);
        self.editing.replace(Some((self.ctx.scope(), note)));
        self.show_preview(false);
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

    /// Saves what's typed (if anything changed; an empty new note isn't kept).
    fn save(&self) {
        let mut editing = self.editing.borrow_mut();
        let Some((scope, note)) = editing.as_mut() else { return };
        let (title, body) = (self.title.text().trim().to_string(), text_of(&self.text));
        if title == note.title && body == note.body {
            return;
        }
        if note.id.is_empty() && title.is_empty() && body.trim().is_empty() {
            return;
        }
        let mut next = Note { title, body, ..note.clone() };
        match self.ctx.store.save_note(scope, &mut next, now()) {
            Ok(()) => *note = next,
            Err(e) => eprintln!("wadnotes: saving a note: {e}"),
        }
    }

    /// Saves now, whatever's waiting.
    pub fn flush(&self) {
        if let Some(id) = self.save_soon.take() {
            id.remove();
        }
        self.save();
    }

    /// Back to the list (saved first).
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
        let Some((scope, note)) = self.editing.take() else { return };
        self.stack.set_visible_child_name("list");
        if !note.id.is_empty() {
            match self.ctx.store.trash_note(&scope, &note.id) {
                Ok(t) => {
                    let name = if note.title.is_empty() { "a note".into() } else { format!("“{}”", note.title) };
                    let c = self.clone();
                    self.toast.offer(name, t, Rc::new(move || c.refresh()));
                }
                Err(e) => eprintln!("wadnotes: deleting a note: {e}"),
            }
        }
        self.refresh();
    }

    fn show_preview(&self, on: bool) {
        if on {
            self.preview.set_markup(&markup::to_pango(&text_of(&self.text)));
        }
        self.preview_scroll.set_visible(on);
        self.edit_scroll.set_visible(!on);
        self.title.set_sensitive(!on);
        self.mode.set_label(if on { "Edit" } else { "Preview" });
        self.ctx.relayout();
    }

    fn toggle_preview(&self) {
        self.show_preview(!self.preview_scroll.is_visible());
    }

    /// For the snapshots: the first note, open (in preview if `preview`).
    pub fn open_first(self: &Rc<Self>, preview: bool) {
        if let Some(n) = self.ctx.store.notes(&self.ctx.scope()).into_iter().next() {
            self.open(n);
            self.show_preview(preview);
        }
    }
}
