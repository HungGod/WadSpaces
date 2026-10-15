//! The board in the app (the web app's builder/store.ts around wad-board):
//! read from the account's library, each change saved behind it (the
//! library changes at once, the account's documents after), a change made
//! elsewhere taken in when none of the board's own writes are out. The
//! images here say what's built.

use std::cell::RefCell;
use std::collections::HashMap;

use gtk::glib;
use serde_json::Value;
use wad_board::board::Note;
use wad_board::{Board, Docs, Module, Stack};
use wad_proto::v1::ImageRow;

use crate::launch::{self, ImageState};
use crate::store::{AppState, Topic, store};

#[derive(Default)]
pub struct State {
    pub board: Board,
    /// The board's been read from the documents.
    pub loaded: bool,
    /// The board while its documents aren't all saved (written again on the
    /// next change, Retry, or the next read); None when they are.
    pub unsaved: Option<Vec<Stack>>,
    /// Why the last save failed, until one goes through.
    pub save_error: Option<String>,
    /// Writes out now.
    pending: u32,
    /// After a failed write, until the library's read back.
    stale: bool,
    /// The layer images here, by layer.
    pub images: HashMap<String, ImageRow>,
    /// The stack just made (to scroll to and light up).
    pub created: Option<String>,
    /// A module's name being typed: the board isn't drawn again under it.
    pub renaming: bool,
    /// The created stack's been brought into view.
    scrolled: bool,
    /// Draws the board again (the page's), when it's changed.
    redraw: Vec<Box<dyn Fn()>>,
    scheduled: bool,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::default();
}

/// What's known now.
pub fn read<T>(f: impl FnOnce(&State) -> T) -> T {
    STATE.with(|s| f(&s.borrow()))
}

fn write<T>(f: impl FnOnce(&mut State) -> T) -> T {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// `f` runs whenever the board changes (one pass per GTK idle).
pub fn on_change(f: impl Fn() + 'static) {
    write(|s| s.redraw.push(Box::new(f)));
}

/// The board changed: drawn again once GTK's idle.
pub fn changed() {
    let first = write(|s| !std::mem::replace(&mut s.scheduled, true));
    if first {
        glib::idle_add_local_once(|| {
            let fs: Vec<Box<dyn Fn()>> = write(|s| {
                s.scheduled = false;
                std::mem::take(&mut s.redraw)
            });
            for f in &fs {
                f();
            }
            write(|s| {
                let mut later = std::mem::take(&mut s.redraw);
                s.redraw = fs;
                s.redraw.append(&mut later);
            });
        });
    }
}

/// An edit of the board; saved, drawn again, and its note shown.
pub fn edit<T>(f: impl FnOnce(&mut Board) -> T) -> T {
    let (out, moved) = write(|s| {
        let v = s.board.version;
        let out = f(&mut s.board);
        (out, s.board.version != v)
    });
    if moved {
        save();
    }
    changed();
    out
}

/// A note from an edit, as a toast (with Undo when it has one).
pub fn tell(n: Option<Note>) {
    let Some(n) = n else { return };
    if n.undo {
        crate::toast::with_action(&n.text, crate::toast::Tone::Info, "Undo", || {
            edit(|b| b.undo());
        });
    } else {
        crate::toast::show(&n.text, None, crate::toast::Tone::Info);
    }
}

/// The documents as the library has them.
pub fn docs(s: &AppState) -> Option<Docs> {
    let l = s.library.as_ref()?;
    let mut extensions = l.extensions.clone();
    extensions.extend(l.customizations.iter().filter(|c| !l.extensions.iter().any(|e| e["id"] == c["id"])).cloned());
    Some(Docs { templates: l.templates.clone(), extensions, wadspaces: l.wadspaces.clone() })
}

/// A stack just made: it lights up and comes into view.
pub fn set_created(id: String) {
    write(|s| {
        s.created = Some(id.clone());
        s.scrolled = false;
    });
    changed();
    glib::timeout_add_local_once(std::time::Duration::from_millis(1800), move || {
        if write(|s| s.created.take_if(|c| *c == id).is_some()) {
            changed();
        }
    });
}

/// The stack to bring into view, once.
pub fn write_created_take() -> Option<String> {
    write(|s| s.created.clone().filter(|_| !std::mem::replace(&mut s.scrolled, true)))
}

/// A name's being typed (or not any more).
pub fn set_renaming(on: bool) {
    write(|s| s.renaming = on);
}

/// The library read (or read again): the board from it, unless the board's
/// own writes are out, or it has work not saved yet.
pub fn take_library(s: &AppState) {
    let Some(docs) = docs(s) else { return };
    let retry = write(|st| {
        if let Some(unsaved) = st.unsaved.clone() {
            if !st.loaded {
                st.board.load(unsaved, false);
                st.loaded = true;
                return true;
            }
            return false;
        }
        if st.pending > 0 || st.stale {
            return false;
        }
        if st.loaded && !wad_board::plan(&st.board.stacks, &docs, "", "").writes() {
            return false;
        }
        let keep = st.loaded;
        st.board.load(wad_board::to_board(&docs), keep);
        st.loaded = true;
        false
    });
    if retry {
        glib::idle_add_local_once(save);
    }
    changed();
}

/// Writes the board's documents: the library at once, the account behind.
/// Until every write is in, the board is kept (`unsaved`).
pub fn save() {
    if read(|s| s.stale) {
        write(|s| s.unsaved = Some(s.board.stacks.clone()));
        return;
    }
    let Some(docs) = store().read_now(docs) else { return };
    let owner = crate::account::uid()
        .unwrap_or_else(|| store().read_now(|s| s.profile().map(|p| p.username.clone())).unwrap_or_default());
    let stacks = read(|s| s.board.stacks.clone());
    let p = wad_board::plan(&stacks, &docs, &owner, &launch::now_iso());
    if !p.writes() {
        write(|s| {
            if s.pending == 0 {
                s.unsaved = None;
                s.save_error = None;
            }
        });
        changed();
        return;
    }
    // The library as it'll be, at once; the board with its documents noted.
    let docs = p.docs.clone();
    store().update(|s| match s.library.as_mut() {
        Some(l) => {
            l.templates = docs.templates.clone();
            l.extensions = docs.extensions.clone();
            l.customizations.retain(|c| !docs.extensions.iter().any(|e| e["id"] == c["id"]));
            l.wadspaces = docs.wadspaces.clone();
            Topic::LIBRARY
        }
        None => Topic::NONE,
    });
    let refs: HashMap<String, String> =
        p.refs.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect();
    write(|s| {
        s.board.stacks = wad_board::with_refs(&s.board.stacks, &refs);
        s.unsaved = Some(s.board.stacks.clone());
        s.pending += 1;
    });
    // A made-up machine (snapshots): nothing to write to.
    if crate::fake::on() {
        write(|s| {
            s.pending = 0;
            s.unsaved = None;
        });
        return;
    }
    glib::spawn_future_local(async move {
        let deleted: Vec<Value> = p
            .deleted
            .iter()
            .filter_map(|id| p.docs.wadspaces.iter().find(|w| w["id"].as_str() == Some(id)).cloned())
            .collect();
        let writes = async {
            for t in &p.templates {
                crate::account::write_doc("templates", t.clone()).await?;
            }
            for e in &p.extensions {
                crate::account::write_doc("extensions", e.clone()).await?;
            }
            for w in p.wadspaces.iter().chain(deleted.iter()) {
                crate::account::write_doc("wadspaces", w.clone()).await?;
            }
            Ok::<(), String>(())
        };
        match writes.await {
            Ok(()) => write(|s| {
                s.pending = s.pending.saturating_sub(1);
                if s.pending == 0 && !s.stale {
                    s.unsaved = None;
                    s.save_error = None;
                }
            }),
            Err(why) => {
                let first = read(|s| s.save_error.is_none());
                if first {
                    crate::toast::error(
                        "Couldn't save the board",
                        &format!("{why} Your changes are kept here and saved when they can be."),
                    );
                }
                write(|s| {
                    s.save_error = Some(why);
                    s.unsaved = Some(s.board.stacks.clone());
                    s.stale = true;
                    s.pending = 0;
                });
                // The library back to what's saved; the board keeps its work.
                crate::account::refresh_library().await;
                write(|s| s.stale = false);
            }
        }
        changed();
    });
    changed();
}

/// Writes what isn't saved yet again.
pub fn retry() {
    if read(|s| s.pending > 0 || s.stale || s.unsaved.is_none()) {
        return;
    }
    save();
}

/// The images here, read again (what's built).
pub fn refresh_images() {
    glib::spawn_future_local(async {
        if let Ok(rows) = crate::pages::machines::get::<Vec<ImageRow>>("/v1/images".into()).await {
            write(|s| s.images = rows.into_iter().map(|r| (r.layer.clone(), r)).collect());
            changed();
        }
    });
}

/// Where a module stands here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    Built,
    Update,
    Unbuilt,
    Building,
}

/// A layer image is building now.
fn building(key: &str, s: &AppState) -> bool {
    s.builds.iter().any(|(b, _)| !b.status.finished() && b.layer.as_deref() == Some(key))
}

/// Where a module stands (a customization has no image: built; a blank
/// one has nothing to build: built).
pub fn built(m: &Module, s: &AppState) -> Standing {
    let blank = match m {
        Module::Customization(_) => return Standing::Built,
        Module::Extensions(e) => e.subs.is_empty(),
        Module::Template(t) => t.apps.is_empty(),
    };
    if blank {
        return Standing::Built;
    }
    let Some(key) = wad_board::board::image_of(m) else { return Standing::Unbuilt };
    if building(&key, s) {
        return Standing::Building;
    }
    let lib = s.library.as_ref().map(|l| l.lib()).unwrap_or_default();
    read(|st| match launch::image_state(&key, &lib, &st.images) {
        ImageState::Built => Standing::Built,
        ImageState::Update => Standing::Update,
        _ => Standing::Unbuilt,
    })
}

/// A stack's image is building.
pub fn stack_building(stack: &Stack, s: &AppState) -> bool {
    stack.modules().iter().any(|m| wad_board::board::image_of(m).is_some_and(|k| building(&k, s)))
}

/// Its modules not built, and those with an update.
pub fn counts(stack: &Stack, s: &AppState) -> (usize, usize) {
    let states: Vec<Standing> = stack.modules().iter().map(|m| built(m, s)).collect();
    (
        states.iter().filter(|b| matches!(b, Standing::Unbuilt | Standing::Building)).count(),
        states.iter().filter(|b| **b == Standing::Update).count(),
    )
}

/// Builds the images a stack doesn't have yet (installing it first).
pub fn build_stack(id: &str) {
    let (stack, why, counts) = store().read_now(|s| {
        let stack = read(|st| st.board.stack(id).cloned());
        let Some(stack) = stack else { return (None, None, (0, 0)) };
        let name = wad_board::stack_name(&stack);
        let why = if stack_building(&stack, s) {
            Some(String::new())
        } else if stack.apps().is_empty() {
            Some(format!("{name} needs a template to build on"))
        } else if !wad_board::catalog::problems_of(&stack).is_empty() {
            Some(format!("{name} needs fixing first"))
        } else if stack.look().is_none_or(|l| l.name.trim().is_empty()) {
            Some(format!("{name} needs a named Customization to be built"))
        } else {
            None
        };
        let c = counts(&stack, s);
        (Some(stack), why, c)
    });
    let Some(stack) = stack else { return };
    match why {
        Some(w) if w.is_empty() => {}
        Some(w) => crate::toast::show(&w, None, crate::toast::Tone::Info),
        None => {
            let name = wad_board::stack_name(&stack);
            let (todo, updates) = counts;
            let plural = |n: usize| format!("{n} image{}", if n == 1 { "" } else { "s" });
            let id = id.to_string();
            glib::spawn_future_local(async move {
                match launch::build_here(id).await {
                    Ok(()) => crate::toast::show(
                        &if todo > 0 {
                            format!("Building {name}: {}", plural(todo))
                        } else if updates > 0 {
                            format!(
                                "Updating {name}: {}, on what's under {} now",
                                plural(updates),
                                if updates == 1 { "it" } else { "them" }
                            )
                        } else {
                            format!("{name} is installed, its images built already")
                        },
                        None,
                        crate::toast::Tone::Info,
                    ),
                    Err(e) => crate::toast::error(&format!("Couldn't build {name}"), &e),
                }
                refresh_images();
            });
        }
    }
}

/// Builds every stack that needs it and can be; says what it skipped.
pub fn build_all(only: Option<Vec<String>>) {
    let stacks = read(|s| s.board.stacks.clone());
    let (waiting, any_building) = store().read_now(|s| {
        let waiting: Vec<Stack> = stacks
            .iter()
            .filter(|st| {
                let (todo, up) = counts(st, s);
                todo + up > 0 && !stack_building(st, s) && only.as_ref().is_none_or(|o| o.contains(&st.id))
            })
            .cloned()
            .collect();
        (waiting, stacks.iter().any(|st| stack_building(st, s)))
    });
    if only.is_some() {
        for st in &waiting {
            build_stack(&st.id);
        }
        return;
    }
    if waiting.is_empty() {
        let t =
            if any_building { "Everything else is built and up to date" } else { "Everything's built and up to date" };
        crate::toast::show(t, None, crate::toast::Tone::Info);
        return;
    }
    let named = |st: &Stack| st.look().is_some_and(|l| !l.name.trim().is_empty());
    let fixed = |st: &Stack| wad_board::catalog::problems_of(st).is_empty();
    let no_template: Vec<&Stack> = waiting.iter().filter(|st| st.apps().is_empty()).collect();
    let broken: Vec<&Stack> = waiting.iter().filter(|st| !st.apps().is_empty() && !fixed(st)).collect();
    let unnamed: Vec<&Stack> = waiting.iter().filter(|st| !st.apps().is_empty() && fixed(st) && !named(st)).collect();
    let ready: Vec<&Stack> = waiting.iter().filter(|st| !st.apps().is_empty() && fixed(st) && named(st)).collect();
    for st in &ready {
        build_stack(&st.id);
    }
    let list = |xs: &[&Stack], what: &str| {
        if xs.is_empty() {
            None
        } else {
            Some(format!(
                "{} need{} {what}",
                xs.iter().map(|s| wad_board::stack_name(s)).collect::<Vec<_>>().join(", "),
                if xs.len() == 1 { "s" } else { "" }
            ))
        }
    };
    let skipped: Vec<String> =
        [list(&broken, "fixing"), list(&no_template, "a template"), list(&unnamed, "a named Customization")]
            .into_iter()
            .flatten()
            .collect();
    let updating = store().read_now(|s| ready.iter().filter(|st| counts(st, s).0 == 0).count());
    crate::toast::show(
        &format!(
            "Building {} wadspace{}{}{}",
            ready.len(),
            if ready.len() == 1 { "" } else { "s" },
            if updating > 0 { format!(" ({updating} an update)") } else { String::new() },
            if skipped.is_empty() { String::new() } else { format!("; skipped: {}", skipped.join("; ")) }
        ),
        None,
        crate::toast::Tone::Info,
    );
}
