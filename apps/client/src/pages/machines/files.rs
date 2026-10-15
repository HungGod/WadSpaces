//! Files (the web app's MachineFiles): what's saved on this machine's disk
//! outside the images (wadd's /v1/files): your files on the machine, each
//! wadspace's home, what was copied in. Look through them, open a text file
//! to read or edit it, delete what you don't need. Secrets (saved sign-ins,
//! WadBrowser's profiles, keys and tokens) never show here.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use gtk::{gio, glib, prelude::*};
use serde::Deserialize;
use serde_json::{Value, json};
use wad_gtk::Icon;
use wad_wadd_client::Method;

use super::{get, send};
use crate::modal::Modal;
use crate::pages::{now, time_ago};
use crate::ui::{self, Size, Variant, enc};

#[derive(Debug, Clone, Deserialize)]
struct FileRoot {
    id: String,
    label: String,
    detail: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FileEntry {
    name: String,
    dir: bool,
    bytes: u64,
    modified: f64,
    text: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct FileList {
    entries: Vec<FileEntry>,
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

struct Files {
    roots: RefCell<Vec<FileRoot>>,
    root: RefCell<Option<String>>,
    /// Inside the root, "" at its top.
    path: RefCell<String>,
    roots_box: gtk::Box,
    crumbs: gtk::Box,
    /// What the list says: an error, "Looking…", empty, or the list.
    slot: gtk::Box,
    entries: gio::ListStore,
    list: gtk::ScrolledWindow,
    refresh: gtk::Button,
}

pub fn view() -> gtk::Widget {
    let p = ui::panel(
        "Files",
        Some("hard-drive"),
        Some(
            "What's saved on this machine outside the images. Secrets (saved sign-ins, keys, tokens) stay out of here.",
        ),
    );
    let refresh = ui::icon_button("refresh-cw", "Look again", 16);
    p.actions.append(&refresh);
    let cols = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    let roots_box = gtk::Box::new(gtk::Orientation::Vertical, 2);
    roots_box.add_css_class("file-roots");
    // 220 with its padding, whatever its names ask.
    let roots_width = wad_gtk::Width::new(&roots_box, 220);
    roots_width.set_hexpand(false);
    cols.append(&roots_width);
    let right = gtk::Box::new(gtk::Orientation::Vertical, 8);
    right.add_css_class("file-main");
    right.set_hexpand(true);
    let crumbs = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    crumbs.add_css_class("crumbs");
    right.append(&crumbs);
    let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
    right.append(&slot);
    cols.append(&right);
    p.body.append(&cols);

    let entries = gio::ListStore::new::<glib::BoxedAnyObject>();
    let list = gtk::ScrolledWindow::new();
    list.set_hscrollbar_policy(gtk::PolicyType::Never);
    list.set_propagate_natural_height(true);
    list.set_max_content_height(560);
    list.add_css_class("file-list");
    let f = Rc::new(Files {
        roots: RefCell::default(),
        root: RefCell::default(),
        path: RefCell::default(),
        roots_box,
        crumbs,
        slot,
        entries: entries.clone(),
        list: list.clone(),
        refresh: refresh.clone(),
    });
    let view = gtk::ListView::new(Some(gtk::NoSelection::new(Some(entries))), Some(factory(Rc::downgrade(&f))));
    view.add_css_class("file-rows");
    list.set_child(Some(&view));
    let ff = f.clone();
    refresh.connect_clicked(move |_| ff.clone().load());
    let ff = f.clone();
    glib::spawn_future_local(async move {
        match get::<Vec<FileRoot>>("/v1/files/roots".into()).await {
            Ok(r) => {
                if ff.root.borrow().is_none() {
                    ff.root.replace(r.first().map(|x| x.id.clone()));
                }
                ff.roots.replace(r);
                ff.render_roots();
                ff.clone().load();
            }
            Err(e) => ff.show_error(&e),
        }
    });
    f.render_roots();
    p.root.upcast()
}

impl Files {
    fn join(&self, name: &str) -> String {
        let p = self.path.borrow();
        if p.is_empty() { name.to_string() } else { format!("{p}/{name}") }
    }

    fn render_roots(self: &Rc<Self>) {
        ui::clear(&self.roots_box);
        let roots = self.roots.borrow();
        if roots.is_empty() {
            let l = gtk::Label::new(Some("Nothing to look through."));
            l.add_css_class("small-muted");
            l.set_xalign(0.0);
            l.set_margin_start(12);
            l.set_margin_top(8);
            self.roots_box.append(&l);
        }
        for r in roots.iter() {
            let b = gtk::Button::new();
            b.add_css_class("root-item");
            if self.root.borrow().as_deref() == Some(&r.id) {
                b.add_css_class("on");
            }
            let l = gtk::Label::new(Some(&r.label));
            l.set_xalign(0.0);
            l.set_ellipsize(gtk::pango::EllipsizeMode::End);
            b.set_child(Some(&l));
            b.set_tooltip_text(Some(&r.detail));
            let (me, id) = (self.clone(), r.id.clone());
            b.connect_clicked(move |_| {
                me.root.replace(Some(id.clone()));
                me.path.replace(String::new());
                me.render_roots();
                me.clone().load();
            });
            self.roots_box.append(&b);
        }
    }

    fn render_crumbs(self: &Rc<Self>) {
        ui::clear(&self.crumbs);
        let label = {
            let root = self.root.borrow();
            self.roots.borrow().iter().find(|r| Some(&r.id) == root.as_ref()).map(|r| r.label.clone())
        };
        let top = gtk::Button::with_label(&label.unwrap_or_else(|| "…".into()));
        top.add_css_class("crumb");
        top.add_css_class("top");
        let me = self.clone();
        top.connect_clicked(move |_| me.go(String::new()));
        self.crumbs.append(&top);
        let path = self.path.borrow().clone();
        let parts: Vec<&str> = if path.is_empty() { vec![] } else { path.split('/').collect() };
        for (i, c) in parts.iter().enumerate() {
            let chev = Icon::new("chevron-right", 14);
            chev.add_css_class("faint");
            self.crumbs.append(&chev);
            let b = gtk::Button::with_label(c);
            b.add_css_class("crumb");
            let (me, to) = (self.clone(), parts[..=i].join("/"));
            b.connect_clicked(move |_| me.go(to.clone()));
            self.crumbs.append(&b);
        }
    }

    fn go(self: &Rc<Self>, path: String) {
        self.path.replace(path);
        self.clone().load();
    }

    fn show(&self, w: &impl IsA<gtk::Widget>) {
        ui::clear(&self.slot);
        self.slot.append(w);
    }

    fn show_error(&self, e: &str) {
        let n = ui::notice(e, true);
        n.set_margin_top(0);
        self.show(&n);
    }

    fn load(self: Rc<Self>) {
        let Some(root) = self.root.borrow().clone() else { return };
        self.render_crumbs();
        if self.slot.first_child().is_none() {
            let l = gtk::Label::new(Some("Looking…"));
            l.add_css_class("small-muted-14");
            l.set_xalign(0.0);
            self.show(&l);
        }
        self.refresh.set_sensitive(false);
        let path = format!("/v1/files?root={}&path={}", enc(&root), enc(&self.path.borrow()));
        glib::spawn_future_local(async move {
            match get::<FileList>(path).await {
                Ok(l) if l.entries.is_empty() => {
                    self.show(&ui::empty_state("folder", "Empty", Some("Nothing saved here.")));
                }
                Ok(l) => {
                    let items: Vec<glib::BoxedAnyObject> =
                        l.entries.into_iter().map(glib::BoxedAnyObject::new).collect();
                    self.entries.splice(0, self.entries.n_items(), &items);
                    self.show(&self.list);
                }
                Err(e) => self.show_error(&e),
            }
            self.refresh.set_sensitive(true);
        });
    }

    fn open(self: &Rc<Self>, name: &str) {
        let (Some(root), path) = (self.root.borrow().clone(), self.join(name)) else { return };
        let me = self.clone();
        glib::spawn_future_local(async move {
            let at = format!("/v1/files/text?root={}&path={}", enc(&root), enc(&path));
            match get::<Text>(at).await {
                Ok(t) => me.edit(root, path, t.text),
                Err(e) => crate::toast::error("Couldn't open it", &e),
            }
        });
    }

    fn edit(self: &Rc<Self>, root: String, path: String, text: String) {
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let m = Modal::open(&name, Some(&path), 760);
        let scroll = gtk::ScrolledWindow::new();
        scroll.add_css_class("editor-frame");
        scroll.set_min_content_height(420);
        let tv = gtk::TextView::new();
        tv.add_css_class("editor");
        tv.set_monospace(true);
        tv.set_wrap_mode(gtk::WrapMode::WordChar);
        tv.buffer().set_text(&text);
        scroll.set_child(Some(&tv));
        m.body().append(&scroll);
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        row.set_halign(gtk::Align::End);
        row.set_margin_top(16);
        let cancel = ui::button("Cancel", None, Variant::Ghost, Size::Md);
        let mm = m.clone();
        cancel.connect_clicked(move |_| mm.close());
        let save = ui::button("Save", None, Variant::Primary, Size::Md);
        let (mm, me) = (m.clone(), self.clone());
        save.connect_clicked(move |b| {
            let buf = tv.buffer();
            let text = buf.text(&buf.start_iter(), &buf.end_iter(), false).to_string();
            let body = json!({ "root": root, "path": path, "text": text });
            let (mm, me, b, path) = (mm.clone(), me.clone(), b.clone(), path.clone());
            b.set_sensitive(false);
            glib::spawn_future_local(async move {
                match send::<Value>(Method::PUT, "/v1/files/text".into(), Some(body)).await {
                    Ok(_) => {
                        crate::toast::show("Saved", Some(&path), crate::toast::Tone::Success);
                        mm.close();
                        me.load();
                    }
                    Err(e) => crate::toast::error("Couldn't save it", &e),
                }
                b.set_sensitive(true);
            });
        });
        row.append(&cancel);
        row.append(&save);
        m.body().append(&row);
    }

    fn ask_delete(self: &Rc<Self>, name: &str, dir: bool) {
        let Some(root) = self.root.borrow().clone() else { return };
        let path = self.join(name);
        let m = Modal::open(
            &format!("Delete {name}?"),
            Some(if dir {
                "The folder and everything in it, for good."
            } else {
                "For good: it isn't kept anywhere else."
            }),
            520,
        );
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        row.set_halign(gtk::Align::End);
        let cancel = ui::button("Cancel", None, Variant::Ghost, Size::Md);
        let mm = m.clone();
        cancel.connect_clicked(move |_| mm.close());
        let del = ui::button("Delete", Some("trash"), Variant::Danger, Size::Md);
        let (mm, me) = (m.clone(), self.clone());
        del.connect_clicked(move |b| {
            b.set_sensitive(false);
            let at = format!("/v1/files?root={}&path={}", enc(&root), enc(&path));
            let (mm, me, b) = (mm.clone(), me.clone(), b.clone());
            glib::spawn_future_local(async move {
                match send::<Value>(Method::DELETE, at, None).await {
                    Ok(_) => {
                        mm.close();
                        me.load();
                    }
                    Err(e) => crate::toast::error("Couldn't delete it", &e),
                }
                b.set_sensitive(true);
            });
        });
        row.append(&cancel);
        row.append(&del);
        m.body().append(&row);
    }
}

/// The entry a row shows now.
fn entry_of(item: &glib::WeakRef<gtk::ListItem>) -> Option<FileEntry> {
    let obj = item.upgrade()?.item().and_downcast::<glib::BoxedAnyObject>()?;
    let e = obj.borrow::<FileEntry>().clone();
    Some(e)
}

/// The list's rows: the icon, the name (a folder opens, a text file
/// opens to edit), size, when it changed, Edit and Delete.
fn factory(files: Weak<Files>) -> gtk::SignalListItemFactory {
    let f = gtk::SignalListItemFactory::new();
    f.connect_setup(move |_, item| {
        let Some(item) = item.downcast_ref::<gtk::ListItem>() else { return };
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        row.add_css_class("file-row");
        let icon = Icon::new("file", 16);
        row.append(&icon);
        let name = gtk::Button::new();
        name.add_css_class("file-name");
        name.set_hexpand(true);
        let label = gtk::Label::new(None);
        label.set_xalign(0.0);
        label.set_ellipsize(gtk::pango::EllipsizeMode::End);
        name.set_child(Some(&label));
        row.append(&name);
        let size = gtk::Label::new(None);
        size.add_css_class("file-size");
        size.set_xalign(1.0);
        size.set_size_request(96, -1);
        row.append(&size);
        let when = gtk::Label::new(None);
        when.add_css_class("small-faint");
        when.set_xalign(1.0);
        when.set_size_request(96, -1);
        row.append(&when);
        let edit = ui::icon_button("pencil", "Edit", 14);
        row.append(&edit);
        let del = ui::icon_button("trash", "Delete", 14);
        row.append(&del);
        item.set_child(Some(&row));

        let weak = item.downgrade();
        let ff = files.clone();
        let opened = move || {
            let (Some(f), Some(e)) = (ff.upgrade(), entry_of(&weak)) else { return };
            if e.dir {
                f.go(f.join(&e.name));
            } else if e.text {
                f.open(&e.name);
            }
        };
        let o = opened.clone();
        name.connect_clicked(move |_| o());
        edit.connect_clicked(move |_| opened());
        let (weak, ff) = (item.downgrade(), files.clone());
        del.connect_clicked(move |_| {
            if let (Some(f), Some(e)) = (ff.upgrade(), entry_of(&weak)) {
                f.ask_delete(&e.name, e.dir);
            }
        });
    });
    f.connect_bind(|_, item| {
        let Some(item) = item.downcast_ref::<gtk::ListItem>() else { return };
        let Some(e) = item.item().and_downcast::<glib::BoxedAnyObject>().map(|o| o.borrow::<FileEntry>().clone())
        else {
            return;
        };
        let Some(row) = item.child() else { return };
        let kids: Vec<gtk::Widget> = std::iter::successors(row.first_child(), |w| w.next_sibling()).collect();
        if let Some(icon) = kids[0].downcast_ref::<Icon>() {
            icon.set(if e.dir {
                "folder"
            } else if e.text {
                "file-text"
            } else {
                "file"
            });
            if e.dir {
                icon.add_css_class("accent");
                icon.remove_css_class("muted");
            } else {
                icon.add_css_class("muted");
                icon.remove_css_class("accent");
            }
        }
        if let Some(name) = kids[1].downcast_ref::<gtk::Button>() {
            name.set_sensitive(e.dir || e.text);
            if let Some(l) = name.child().and_downcast::<gtk::Label>() {
                l.set_text(&e.name);
            }
        }
        if let Some(l) = kids[2].downcast_ref::<gtk::Label>() {
            l.set_text(&if e.dir { String::new() } else { ui::bytes(e.bytes) });
        }
        if let Some(l) = kids[3].downcast_ref::<gtk::Label>() {
            l.set_text(&if e.modified > 0.0 { time_ago(now() - e.modified) } else { String::new() });
        }
        kids[4].set_visible(e.text);
        kids[4].set_tooltip_text(Some(&format!("Edit {}", e.name)));
        kids[5].set_tooltip_text(Some(&format!("Delete {}", e.name)));
    });
    f
}
