//! WadNotes' files, kept on the machine (the HUD shows them; nothing here
//! draws). Markdown with TOML front matter, one file each, so they stay
//! readable and editable by hand:
//!
//! ```text
//! <root>/default/notes/<id>.md     notes: the machine's own (Client, Terminal, WadBrowser)
//! <root>/default/tasks/WAD-3.md    tasks
//! <root>/<wadspace>/notes/…        a wadspace's notes and tasks
//! <root>/calendar/<id>.md          events: one calendar, each event tagged with a wadspace
//! <root>/colors.toml               each wadspace's colour (an index into PALETTE)
//! <root>/.trash/…                  what was deleted (deleting is undoable)
//! ```
//!
//! Times are the machine's local time, without a zone (the calendar is the
//! machine's).

pub mod calendar;
pub mod colors;
pub mod doc;
pub mod model;
pub mod store;

pub use calendar::{Reminders, due_reminders, month_grid, on_day, remind_at, upcoming};
pub use colors::{Colors, PALETTE};
pub use model::{Event, Note, Priority, Status, Task};
pub use store::{ReminderFile, Store, Trashed, task_prefix};

/// The machine's own notespace: notes and tasks outside any wadspace.
pub const DEFAULT: &str = "default";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: {1}")]
    Io(String, std::io::Error),
    #[error("{0}: {1}")]
    Bad(String, String),
    #[error("{0:?} isn't a wadspace id")]
    Scope(String),
}

/// A scope is "default" or a wadspace's id (^[a-z0-9][a-z0-9-]{0,62}$), so
/// it's always one plain folder name.
pub fn is_scope(s: &str) -> bool {
    let mut cs = s.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() <= 63
        && cs.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
