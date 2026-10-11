//! The folders on disk: reading, saving (atomically) and deleting (into a
//! trash folder, so it can be undone).

use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDateTime};

use crate::calendar::Reminders;
use crate::colors::Colors;
use crate::model::{Event, Note, Task};
use crate::{DEFAULT, Error, is_scope};

const NOTES: &str = "notes";
const TASKS: &str = "tasks";
const CALENDAR: &str = "calendar";
const TRASH: &str = ".trash";
const COLORS: &str = "colors.toml";

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

/// Something deleted, and where it went: `Store::restore` puts it back.
#[derive(Debug, Clone, PartialEq)]
pub struct Trashed {
    pub from: PathBuf,
    pub to: PathBuf,
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |e| Error::Io(path.display().to_string(), e)
}

/// Writes a file whole or not at all.
fn write(path: &Path, text: &str) -> Result<(), Error> {
    let dir = path.parent().expect("a file in a folder");
    std::fs::create_dir_all(dir).map_err(io(dir))?;
    let tmp = dir.join(format!(".{}.tmp", path.file_name().unwrap().to_string_lossy()));
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path)).map_err(io(path))
}

fn modified(path: &Path) -> NaiveDateTime {
    let t = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    t.map(|t| chrono::DateTime::<Local>::from(t).naive_local()).unwrap_or_default()
}

/// The .md files in a folder: (stem, path, text). Unreadable ones are skipped.
fn markdown(dir: &Path) -> Vec<(String, PathBuf, String)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .filter_map(|p| {
            let stem = p.file_stem()?.to_str()?.to_string();
            if stem.starts_with('.') {
                return None;
            }
            let text = std::fs::read_to_string(&p).ok()?;
            Some((stem, p, text))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// A new file name: the time, and a few letters so two in a minute differ.
fn new_id(now: NaiveDateTime, taken: impl Fn(&str) -> bool) -> String {
    let base = now.format("%Y%m%d-%H%M").to_string();
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    (0u128..)
        .map(|i| format!("{base}-{:04x}", (seed.wrapping_mul(2654435761).wrapping_add(i * 7919) >> 7) & 0xffff))
        .find(|id| !taken(id))
        .expect("a free name")
}

/// A scope's task prefix: its first three letters or digits, upper case
/// (the machine's own: WAD).
pub fn task_prefix(scope: &str) -> String {
    if scope == DEFAULT {
        return "WAD".into();
    }
    let p: String = scope.chars().filter(char::is_ascii_alphanumeric).take(3).collect::<String>().to_uppercase();
    if p.is_empty() { "WS".into() } else { p }
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `$WADNOTES_DIR`, else `$XDG_DATA_HOME/wadspaces/notes` (~/.local/share/…).
    pub fn default_root() -> PathBuf {
        if let Some(d) = std::env::var_os("WADNOTES_DIR").filter(|d| !d.is_empty()) {
            return d.into();
        }
        let data = std::env::var_os("XDG_DATA_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|| "/tmp".into());
        data.join("wadspaces/notes")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn scope_dir(&self, scope: &str, kind: &str) -> Result<PathBuf, Error> {
        if !is_scope(scope) || scope == CALENDAR {
            return Err(Error::Scope(scope.into()));
        }
        Ok(self.root.join(scope).join(kind))
    }

    fn file(dir: &Path, stem: &str) -> Result<PathBuf, Error> {
        // Names come from the folder or from here: never a path.
        if stem.is_empty() || stem.contains(['/', '\\']) || stem.starts_with('.') {
            return Err(Error::Bad(stem.into(), "not a file name".into()));
        }
        Ok(dir.join(format!("{stem}.md")))
    }

    // ---------------------------------------------------------------- notes
    /// A scope's notes, the latest changed first. Files that don't parse are left out.
    pub fn notes(&self, scope: &str) -> Vec<Note> {
        let Ok(dir) = self.scope_dir(scope, NOTES) else { return vec![] };
        let mut out: Vec<Note> =
            markdown(&dir).into_iter().filter_map(|(id, p, text)| Note::parse(&id, &text, modified(&p)).ok()).collect();
        out.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// Saves a note (a new one gets its id), stamped `now`.
    pub fn save_note(&self, scope: &str, note: &mut Note, now: NaiveDateTime) -> Result<(), Error> {
        let dir = self.scope_dir(scope, NOTES)?;
        if note.id.is_empty() {
            note.id = new_id(now, |id| dir.join(format!("{id}.md")).exists());
        }
        note.updated = now;
        write(&Self::file(&dir, &note.id)?, &note.render())
    }

    pub fn trash_note(&self, scope: &str, id: &str) -> Result<Trashed, Error> {
        let path = Self::file(&self.scope_dir(scope, NOTES)?, id)?;
        self.trash(path)
    }

    // ---------------------------------------------------------------- tasks
    /// A scope's tasks: open ones first (in progress, then to do), then by
    /// priority, due day and key; done ones last, the latest first.
    pub fn tasks(&self, scope: &str) -> Vec<Task> {
        use crate::model::Status;
        let Ok(dir) = self.scope_dir(scope, TASKS) else { return vec![] };
        let mut out: Vec<Task> =
            markdown(&dir).into_iter().filter_map(|(k, p, text)| Task::parse(&k, &text, modified(&p)).ok()).collect();
        let rank = |s: Status| match s {
            Status::Doing => 0,
            Status::Todo => 1,
            Status::Done => 2,
        };
        out.sort_by(|a, b| {
            rank(a.status).cmp(&rank(b.status)).then_with(|| {
                if a.status == Status::Done {
                    b.number().cmp(&a.number())
                } else {
                    b.priority
                        .cmp(&a.priority)
                        .then_with(|| a.due.is_none().cmp(&b.due.is_none()))
                        .then_with(|| a.due.cmp(&b.due))
                        .then_with(|| a.number().cmp(&b.number()))
                }
            })
        });
        out
    }

    /// Saves a task; a new one gets the scope's next key (WRI-4).
    pub fn save_task(&self, scope: &str, task: &mut Task) -> Result<(), Error> {
        let dir = self.scope_dir(scope, TASKS)?;
        if task.key.is_empty() {
            let prefix = task_prefix(scope);
            let next = markdown(&dir)
                .iter()
                .filter_map(|(k, _, _)| k.strip_prefix(&format!("{prefix}-"))?.parse::<u32>().ok())
                .max()
                .unwrap_or(0)
                + 1;
            task.key = format!("{prefix}-{next}");
        }
        write(&Self::file(&dir, &task.key)?, &task.render())
    }

    pub fn trash_task(&self, scope: &str, key: &str) -> Result<Trashed, Error> {
        let path = Self::file(&self.scope_dir(scope, TASKS)?, key)?;
        self.trash(path)
    }

    // ------------------------------------------------------------- calendar
    /// Every event, by start.
    pub fn events(&self) -> Vec<Event> {
        let mut out: Vec<Event> = markdown(&self.root.join(CALENDAR))
            .into_iter()
            .filter_map(|(id, _, text)| Event::parse(&id, &text).ok())
            .collect();
        out.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.id.cmp(&b.id)));
        out
    }

    pub fn save_event(&self, event: &mut Event, now: NaiveDateTime) -> Result<(), Error> {
        let dir = self.root.join(CALENDAR);
        if event.id.is_empty() {
            event.id = new_id(now, |id| dir.join(format!("{id}.md")).exists());
        }
        write(&Self::file(&dir, &event.id)?, &event.render())
    }

    pub fn trash_event(&self, id: &str) -> Result<Trashed, Error> {
        let path = Self::file(&self.root.join(CALENDAR), id)?;
        self.trash(path)
    }

    // ---------------------------------------------------------------- trash
    fn trash(&self, path: PathBuf) -> Result<Trashed, Error> {
        if !path.is_file() {
            return Err(Error::Io(path.display().to_string(), std::io::ErrorKind::NotFound.into()));
        }
        let rel = path.strip_prefix(&self.root).unwrap_or(&path);
        let flat = rel.to_string_lossy().replace('/', "~");
        let stamp = Local::now().format("%Y%m%d-%H%M%S%3f");
        let to = self.root.join(TRASH).join(format!("{stamp}~{flat}"));
        std::fs::create_dir_all(to.parent().unwrap()).map_err(io(&to))?;
        std::fs::rename(&path, &to).map_err(io(&path))?;
        Ok(Trashed { from: path, to })
    }

    /// Undoes a delete (unless something took its place meanwhile).
    pub fn restore(&self, t: &Trashed) -> Result<(), Error> {
        if t.from.exists() {
            return Err(Error::Bad(t.from.display().to_string(), "there's another one there now".into()));
        }
        std::fs::create_dir_all(t.from.parent().unwrap()).map_err(io(&t.from))?;
        std::fs::rename(&t.to, &t.from).map_err(io(&t.to))
    }

    // --------------------------------------------------------------- colours
    pub fn colors(&self) -> Colors {
        std::fs::read_to_string(self.root.join(COLORS)).map(|t| Colors::parse(&t)).unwrap_or_default()
    }

    pub fn save_colors(&self, c: &Colors) -> Result<(), Error> {
        write(&self.root.join(COLORS), &c.render())
    }

    /// These scopes' colours, handing out (and saving) any that are new.
    pub fn colors_for<'a>(&self, scopes: impl IntoIterator<Item = &'a str>) -> Colors {
        let mut c = self.colors();
        let mut changed = false;
        for s in scopes {
            changed |= c.assign(s).1;
        }
        if changed && let Err(e) = self.save_colors(&c) {
            eprintln!("wadnotes: {e}");
        }
        c
    }
}

/// Reminders dealt with: `$XDG_STATE_HOME/wadspaces/wadnotes.json` (machine
/// state, not notes: it isn't in the notes folder).
pub struct ReminderFile(pub PathBuf);

impl ReminderFile {
    pub fn default_path() -> PathBuf {
        if let Some(d) = std::env::var_os("WADNOTES_DIR").filter(|d| !d.is_empty()) {
            return PathBuf::from(d).join(".reminders.json");
        }
        let state = std::env::var_os("XDG_STATE_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
            .unwrap_or_else(|| "/tmp".into());
        state.join("wadspaces/wadnotes.json")
    }

    pub fn load(&self) -> Reminders {
        std::fs::read(&self.0).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, r: &Reminders) -> Result<(), Error> {
        write(&self.0, &(serde_json::to_string_pretty(r).expect("json") + "\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Priority, Status, parse_date, parse_time};

    fn t(s: &str) -> NaiveDateTime {
        parse_time(s).unwrap()
    }

    #[test]
    fn notes_are_saved_listed_and_trashed() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path());
        let mut a = Note { title: "First".into(), body: "one".into(), ..Note::new(t("2026-10-09T09:00")) };
        s.save_note("writing", &mut a, t("2026-10-09T09:00")).unwrap();
        let mut b = Note { title: "Second".into(), ..Note::new(t("2026-10-09T09:00")) };
        s.save_note("writing", &mut b, t("2026-10-09T10:00")).unwrap();
        assert_ne!(a.id, b.id);
        assert!(a.id.starts_with("20261009-0900-"), "{}", a.id);
        assert!(d.path().join(format!("writing/notes/{}.md", a.id)).is_file());
        let titles = |scope: &str| s.notes(scope).into_iter().map(|n| n.title).collect::<Vec<_>>();
        assert_eq!(titles("writing"), ["Second", "First"]);
        assert!(titles("default").is_empty()); // each scope its own
        // A file dropped in by hand counts; a broken one doesn't stop the rest.
        std::fs::write(d.path().join("writing/notes/by-hand.md"), "# By hand\n").unwrap();
        std::fs::write(d.path().join("writing/notes/broken.md"), "+++\ntitle = [\n+++\n").unwrap();
        assert_eq!(s.notes("writing").len(), 3);
        // Deleted, then undone.
        let gone = s.trash_note("writing", &a.id).unwrap();
        assert_eq!(s.notes("writing").len(), 2);
        assert!(gone.to.starts_with(d.path().join(".trash")));
        s.restore(&gone).unwrap();
        assert_eq!(s.notes("writing").len(), 3);
        // No escaping the folder.
        assert!(s.save_note("../x", &mut Note::new(t("2026-10-09T09:00")), t("2026-10-09T09:00")).is_err());
        assert!(s.save_note("calendar", &mut Note::new(t("2026-10-09T09:00")), t("2026-10-09T09:00")).is_err());
        assert!(s.trash_note("writing", "../../colors").is_err());
        assert!(s.notes("../etc").is_empty());
    }

    #[test]
    fn tasks_get_keys_and_sort_like_a_board() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path());
        let mk = |title: &str, status: Status, priority: Priority, due: Option<&str>| Task {
            title: title.into(),
            status,
            priority,
            due: due.and_then(parse_date),
            ..Task::new(t("2026-10-09T09:00"))
        };
        for mut k in [
            mk("low", Status::Todo, Priority::Low, None),
            mk("high late", Status::Todo, Priority::High, Some("2026-10-20")),
            mk("high soon", Status::Todo, Priority::High, Some("2026-10-10")),
            mk("doing", Status::Doing, Priority::Low, None),
            mk("done", Status::Done, Priority::High, None),
        ] {
            s.save_task("kale-b", &mut k).unwrap();
        }
        let keys: Vec<(String, String)> = s.tasks("kale-b").into_iter().map(|k| (k.key, k.title)).collect();
        let titles: Vec<&str> = keys.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(titles, ["doing", "high soon", "high late", "low", "done"]);
        assert_eq!(keys[0].0, "KAL-4");
        let mut more = mk("more", Status::Todo, Priority::Low, None);
        s.save_task("default", &mut more).unwrap();
        assert_eq!(more.key, "WAD-1");
        // Saving again keeps the key; the next new one counts on.
        more.status = Status::Done;
        s.save_task("default", &mut more).unwrap();
        let mut next = mk("next", Status::Todo, Priority::Low, None);
        s.save_task("default", &mut next).unwrap();
        assert_eq!(next.key, "WAD-2");
        assert_eq!(task_prefix("iq-dev"), "IQD");
        s.trash_task("default", "WAD-1").unwrap();
        assert_eq!(s.tasks("default").len(), 1);
    }

    #[test]
    fn events_colors_and_reminders() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path());
        let mut late = Event { title: "Late".into(), ..Event::new(t("2026-10-12T15:00"), Some("writing".into())) };
        let mut early = Event { title: "Early".into(), ..Event::new(t("2026-10-12T09:00"), None) };
        s.save_event(&mut late, t("2026-10-09T09:00")).unwrap();
        s.save_event(&mut early, t("2026-10-09T09:00")).unwrap();
        let all = s.events();
        assert_eq!(all.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), ["Early", "Late"]);
        s.trash_event(&early.id).unwrap();
        assert_eq!(s.events().len(), 1);

        let c = s.colors_for(["default", "writing"]);
        assert_eq!((c.get("default"), c.get("writing")), (Some(0), Some(1)));
        assert_eq!(s.colors(), c); // saved

        let f = ReminderFile(d.path().join("state/wadnotes.json"));
        let mut r = f.load();
        r.dismiss(&late);
        f.save(&r).unwrap();
        assert_eq!(f.load(), r);
    }
}
