//! What's in the files: notes, tasks and events, and their front matter.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::doc;

/// Times as the files have them: local, to the minute.
const TIME: &str = "%Y-%m-%dT%H:%M";
const DATE: &str = "%Y-%m-%d";

pub fn fmt_time(t: NaiveDateTime) -> String {
    t.format(TIME).to_string()
}

pub fn parse_time(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    NaiveDateTime::parse_from_str(s, TIME)
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M"))
        .ok()
        .or_else(|| parse_date(s).map(|d| d.and_time(NaiveTime::MIN)))
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), DATE).ok()
}

/// A plain note: a title and markdown.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    /// The file's name, without .md (empty until it's first saved).
    pub id: String,
    pub title: String,
    pub body: String,
    pub updated: NaiveDateTime,
}

#[derive(Serialize, Deserialize, Default)]
struct NoteHead {
    #[serde(default)]
    title: String,
    #[serde(default)]
    updated: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Todo,
    Doing,
    Done,
}

impl Status {
    pub const ALL: [Status; 3] = [Status::Todo, Status::Doing, Status::Done];

    pub fn label(self) -> &'static str {
        match self {
            Status::Todo => "To do",
            Status::Doing => "In progress",
            Status::Done => "Done",
        }
    }

    /// The next one round (a tap on a task's status).
    pub fn next(self) -> Status {
        match self {
            Status::Todo => Status::Doing,
            Status::Doing => Status::Done,
            Status::Done => Status::Todo,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    #[default]
    Medium,
    High,
}

impl Priority {
    pub const ALL: [Priority; 3] = [Priority::Low, Priority::Medium, Priority::High];

    pub fn label(self) -> &'static str {
        match self {
            Priority::Low => "Low",
            Priority::Medium => "Medium",
            Priority::High => "High",
        }
    }
}

/// A task, Jira-style: a key (WRI-3), a status, a priority, maybe a due day.
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    /// PREFIX-n, the file's name (empty until it's first saved).
    pub key: String,
    pub title: String,
    pub status: Status,
    pub priority: Priority,
    pub due: Option<NaiveDate>,
    pub created: NaiveDateTime,
    pub body: String,
}

#[derive(Serialize, Deserialize, Default)]
struct TaskHead {
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: Status,
    #[serde(default)]
    priority: Priority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    due: Option<String>,
    #[serde(default)]
    created: String,
}

/// An event on the shared calendar, tagged with the wadspace it's for.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub id: String,
    pub title: String,
    /// All day: the day, at midnight.
    pub start: NaiveDateTime,
    /// All day: the last day, at midnight (None: the same day).
    pub end: Option<NaiveDateTime>,
    pub all_day: bool,
    /// The wadspace it's for; None is the machine's own (default).
    pub scope: Option<String>,
    /// Minutes before the start to remind you (all day: before 9:00).
    pub remind: Option<u32>,
    pub body: String,
}

#[derive(Serialize, Deserialize, Default)]
struct EventHead {
    #[serde(default)]
    title: String,
    #[serde(default)]
    start: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    end: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    all_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remind: Option<u32>,
}

fn head<T: for<'de> Deserialize<'de> + Default>(front: &str) -> Result<T, String> {
    if front.trim().is_empty() { Ok(T::default()) } else { toml::from_str(front).map_err(|e| e.message().to_string()) }
}

fn front<T: Serialize>(h: &T) -> String {
    toml::to_string(h).expect("front matter serializes")
}

impl Note {
    pub fn new(now: NaiveDateTime) -> Self {
        Self { id: String::new(), title: String::new(), body: String::new(), updated: now }
    }

    /// `modified`: the file's time, for a note whose front matter has none.
    pub fn parse(id: &str, text: &str, modified: NaiveDateTime) -> Result<Self, String> {
        let (f, body) = doc::split(text);
        let h: NoteHead = head(f)?;
        let title = Some(h.title).filter(|t| !t.trim().is_empty()).or_else(|| doc::title_of(body)).unwrap_or_default();
        Ok(Self { id: id.into(), title, body: body.into(), updated: parse_time(&h.updated).unwrap_or(modified) })
    }

    pub fn render(&self) -> String {
        doc::join(&front(&NoteHead { title: self.title.clone(), updated: fmt_time(self.updated) }), &self.body)
    }

    /// What a list shows under the title: the start of the text, without
    /// its markdown.
    pub fn snippet(&self, chars: usize) -> String {
        let text: Vec<String> = self
            .body
            .lines()
            .map(|l| {
                let l = l.trim().trim_start_matches(['#', '-', '*', '+', '>', ' ']);
                let l = l.strip_prefix("[ ] ").or_else(|| l.strip_prefix("[x] ")).unwrap_or(l);
                l.replace(['*', '`'], "").replace("~~", "")
            })
            .filter(|l| !l.is_empty() && *l != self.title)
            .collect();
        let joined = text.join(" ");
        match joined.char_indices().nth(chars) {
            Some((at, _)) => format!("{}…", joined[..at].trim_end()),
            None => joined,
        }
    }
}

impl Task {
    pub fn new(now: NaiveDateTime) -> Self {
        Self {
            key: String::new(),
            title: String::new(),
            status: Status::Todo,
            priority: Priority::Medium,
            due: None,
            created: now,
            body: String::new(),
        }
    }

    pub fn parse(key: &str, text: &str, modified: NaiveDateTime) -> Result<Self, String> {
        let (f, body) = doc::split(text);
        let h: TaskHead = head(f)?;
        let title = Some(h.title).filter(|t| !t.trim().is_empty()).or_else(|| doc::title_of(body)).unwrap_or_default();
        Ok(Self {
            key: key.into(),
            title,
            status: h.status,
            priority: h.priority,
            due: h.due.as_deref().and_then(parse_date),
            created: parse_time(&h.created).unwrap_or(modified),
            body: body.into(),
        })
    }

    pub fn render(&self) -> String {
        let h = TaskHead {
            title: self.title.clone(),
            status: self.status,
            priority: self.priority,
            due: self.due.map(|d| d.format(DATE).to_string()),
            created: fmt_time(self.created),
        };
        doc::join(&front(&h), &self.body)
    }

    /// Past its due day and not done.
    pub fn overdue(&self, today: NaiveDate) -> bool {
        self.status != Status::Done && self.due.is_some_and(|d| d < today)
    }

    /// The n of PREFIX-n (0 when it has none).
    pub fn number(&self) -> u32 {
        self.key.rsplit_once('-').and_then(|(_, n)| n.parse().ok()).unwrap_or(0)
    }
}

impl Event {
    pub fn new(start: NaiveDateTime, scope: Option<String>) -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            start,
            end: None,
            all_day: false,
            scope,
            remind: Some(15),
            body: String::new(),
        }
    }

    pub fn parse(id: &str, text: &str) -> Result<Self, String> {
        let (f, body) = doc::split(text);
        let h: EventHead = head(f)?;
        let start = parse_time(&h.start).ok_or_else(|| format!("start {:?} isn't a time", h.start))?;
        let title = Some(h.title).filter(|t| !t.trim().is_empty()).or_else(|| doc::title_of(body)).unwrap_or_default();
        Ok(Self {
            id: id.into(),
            title,
            start,
            end: h.end.as_deref().and_then(parse_time).filter(|e| *e >= start),
            all_day: h.all_day,
            scope: h.scope.filter(|s| crate::is_scope(s) && s != crate::DEFAULT),
            remind: h.remind,
            body: body.into(),
        })
    }

    pub fn render(&self) -> String {
        let when = |t: NaiveDateTime| if self.all_day { t.date().format(DATE).to_string() } else { fmt_time(t) };
        let h = EventHead {
            title: self.title.clone(),
            start: when(self.start),
            end: self.end.map(when),
            all_day: self.all_day,
            scope: self.scope.clone(),
            remind: self.remind,
        };
        doc::join(&front(&h), &self.body)
    }

    /// The scope it belongs to ("default" when it has none).
    pub fn scope_or_default(&self) -> &str {
        self.scope.as_deref().unwrap_or(crate::DEFAULT)
    }

    /// The first and last day it's on.
    pub fn days(&self) -> (NaiveDate, NaiveDate) {
        let first = self.start.date();
        let last = self.end.map(|e| {
            // A timed event ending at midnight ends the day before.
            if !self.all_day && e.time() == NaiveTime::MIN && e.date() > first { e.date().pred_opt().unwrap() } else { e.date() }
        });
        (first, last.unwrap_or(first).max(first))
    }

    /// When it's over: its end, else its start (timed) or the end of its day.
    pub fn over_at(&self) -> NaiveDateTime {
        if self.all_day {
            self.days().1.succ_opt().unwrap_or(self.days().1).and_time(NaiveTime::MIN)
        } else {
            self.end.unwrap_or(self.start)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> NaiveDateTime {
        parse_time(s).unwrap()
    }

    #[test]
    fn a_note_round_trips() {
        let n = Note { id: "a".into(), title: "Plan".into(), body: "# Plan\n\n- one\n".into(), updated: t("2026-10-09T14:30") };
        let text = n.render();
        assert!(text.starts_with("+++\ntitle = \"Plan\"\nupdated = \"2026-10-09T14:30\"\n+++\n\n# Plan"), "{text}");
        assert_eq!(Note::parse("a", &text, t("2000-01-01")).unwrap(), n);
        // By hand, no front matter: the heading names it, the file's time dates it.
        let raw = Note::parse("b", "# Shopping\n\nmilk", t("2026-10-01T08:00")).unwrap();
        assert_eq!((raw.title.as_str(), raw.updated), ("Shopping", t("2026-10-01T08:00")));
        assert_eq!(raw.snippet(80), "milk");
        let marked = Note { body: "# Plan\n\nThe **storm** `code` ~~x~~\n- [ ] Ana\n".into(), ..n.clone() };
        assert_eq!(marked.snippet(80), "The storm code x Ana");
        let long = Note { body: "word ".repeat(40), ..n };
        assert_eq!(long.snippet(9), "word word…");
        assert!(Note::parse("c", "+++\ntitle = [\n+++\n", t("2026-10-01")).is_err());
    }

    #[test]
    fn a_task_round_trips() {
        let k = Task {
            key: "WRI-12".into(),
            title: "Draft chapter 3".into(),
            status: Status::Doing,
            priority: Priority::High,
            due: parse_date("2026-10-15"),
            created: t("2026-10-09T09:00"),
            body: "Notes.\n".into(),
        };
        let text = k.render();
        assert!(text.contains("status = \"doing\"") && text.contains("due = \"2026-10-15\""), "{text}");
        assert_eq!(Task::parse("WRI-12", &text, t("2000-01-01")).unwrap(), k);
        assert_eq!(k.number(), 12);
        assert!(k.overdue(parse_date("2026-10-16").unwrap()));
        assert!(!k.overdue(parse_date("2026-10-15").unwrap()));
        assert!(!Task { status: Status::Done, ..k.clone() }.overdue(parse_date("2026-11-01").unwrap()));
        assert_eq!(Status::Done.next(), Status::Todo);
        // Defaults for what's missing.
        let bare = Task::parse("WAD-1", "+++\ntitle = \"x\"\n+++\n", t("2026-10-01T08:00")).unwrap();
        assert_eq!((bare.status, bare.priority, bare.due), (Status::Todo, Priority::Medium, None));
    }

    #[test]
    fn an_event_round_trips() {
        let e = Event {
            id: "e1".into(),
            title: "Standup".into(),
            start: t("2026-10-12T09:30"),
            end: Some(t("2026-10-12T10:00")),
            all_day: false,
            scope: Some("writing".into()),
            remind: Some(10),
            body: String::new(),
        };
        assert_eq!(Event::parse("e1", &e.render()).unwrap(), e);
        let day = Event { all_day: true, start: t("2026-10-14"), end: Some(t("2026-10-16")), scope: None, ..e.clone() };
        let text = day.render();
        assert!(text.contains("start = \"2026-10-14\"") && !text.contains("scope"), "{text}");
        assert_eq!(Event::parse("e1", &text).unwrap(), day);
        assert_eq!(day.days(), (parse_date("2026-10-14").unwrap(), parse_date("2026-10-16").unwrap()));
        assert_eq!(day.over_at(), t("2026-10-17T00:00"));
        assert_eq!(day.scope_or_default(), "default");
        // A bad scope (a path) is dropped; a start is needed.
        let sneaky = "+++\nstart = \"2026-10-12T09:00\"\nscope = \"../etc\"\n+++\n";
        assert_eq!(Event::parse("x", sneaky).unwrap().scope, None);
        assert!(Event::parse("x", "+++\ntitle = \"no start\"\n+++\n").is_err());
        // Ending at midnight: the day before is its last.
        let late = Event { start: t("2026-10-12T22:00"), end: Some(t("2026-10-13T00:00")), ..e };
        assert_eq!(late.days().1, parse_date("2026-10-12").unwrap());
    }
}
