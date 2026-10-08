//! The clipboard history (Super+V): the machine's copies, newest first, kept
//! in memory only (never on disk), without password managers' copies.

use std::sync::Arc;

use wad_clip::Content;

/// At most this many copies…
pub const MAX_ENTRIES: usize = 25;
/// …holding at most this much (a screenshot is a few MB).
pub const MAX_BYTES: usize = 96 << 20;

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: u64,
    pub content: Arc<Content>,
    digest: u64,
    /// When it was copied (Unix seconds).
    pub at: f64,
    /// A small PNG of an image copy, made off the GTK loop.
    pub thumb: Option<Vec<u8>>,
}

impl Entry {
    /// What the row says: the text (tidied), or what kind of copy it is.
    pub fn label(&self) -> String {
        match (self.content.text(), self.content.image()) {
            (Some(t), _) if !t.trim().is_empty() => preview(&t),
            (_, Some(_)) => "Image".into(),
            _ => self.content.items.first().map(|i| i.mime.clone()).unwrap_or_default(),
        }
    }
}

#[derive(Debug, Default)]
pub struct History {
    entries: Vec<Entry>,
    next_id: u64,
}

impl History {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn latest(&self) -> Option<&Entry> {
        self.entries.first()
    }

    /// A new copy, on top (a repeat moves up). False: not kept (a secret).
    pub fn add(&mut self, content: Content, thumb: Option<Vec<u8>>, now: f64) -> bool {
        if content.secret() {
            return false;
        }
        let digest = content.digest();
        if let Some(i) = self.entries.iter().position(|e| e.digest == digest) {
            let mut e = self.entries.remove(i);
            e.at = now;
            self.entries.insert(0, e);
            return true;
        }
        self.next_id += 1;
        let entry = Entry { id: self.next_id, content: Arc::new(content), digest, at: now, thumb };
        self.entries.insert(0, entry);
        self.trim();
        true
    }

    /// Picked: on top again, as the clipboard now.
    pub fn promote(&mut self, id: u64) -> Option<Arc<Content>> {
        let i = self.entries.iter().position(|e| e.id == id)?;
        let e = self.entries.remove(i);
        let c = e.content.clone();
        self.entries.insert(0, e);
        Some(c)
    }

    pub fn remove(&mut self, id: u64) {
        self.entries.retain(|e| e.id != id);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn trim(&mut self) {
        self.entries.truncate(MAX_ENTRIES);
        let mut total = 0;
        // The newest always stays, however big.
        let keep = self
            .entries
            .iter()
            .position(|e| {
                total += e.content.size();
                total > MAX_BYTES
            })
            .map(|i| i.max(1))
            .unwrap_or(self.entries.len());
        self.entries.truncate(keep);
    }
}

/// Text for a row: its first lines that aren't blank (indents kept, for
/// code), not too long.
pub fn preview(text: &str) -> String {
    let lines: Vec<String> =
        text.lines().map(|l| l.trim_end().replace('\t', "    ")).filter(|l| !l.is_empty()).take(3).collect();
    let joined = lines.join("\n");
    match joined.char_indices().nth(240) {
        Some((i, _)) => format!("{}…", &joined[..i]),
        None => joined,
    }
}

/// How long ago, in words.
pub fn ago(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    match s {
        0..60 => "just now".into(),
        60..3600 => format!("{} min ago", s / 60),
        3600..86400 => format!("{} h ago", s / 3600),
        _ => format!("{} d ago", s / 86400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wad_clip::Item;

    fn text(t: &str) -> Content {
        Content { items: vec![Item { mime: "text/plain;charset=utf-8".into(), data: t.as_bytes().to_vec() }] }
    }

    #[test]
    fn newest_first_repeats_move_up() {
        let mut h = History::default();
        assert!(h.add(text("one"), None, 1.0));
        assert!(h.add(text("two"), None, 2.0));
        assert!(h.add(text("one"), None, 3.0));
        let labels: Vec<String> = h.entries().iter().map(Entry::label).collect();
        assert_eq!(labels, ["one", "two"]);
        assert_eq!(h.latest().unwrap().at, 3.0);
        let two = h.entries()[1].id;
        assert_eq!(h.promote(two).unwrap().text().as_deref(), Some("two"));
        assert_eq!(h.latest().unwrap().id, two);
        h.remove(two);
        assert_eq!(h.entries().len(), 1);
        h.clear();
        assert!(h.latest().is_none());
    }

    #[test]
    fn passwords_are_never_kept() {
        let mut h = History::default();
        let mut pw = text("hunter2");
        pw.items.push(Item { mime: wad_clip::content::PASSWORD_HINT.into(), data: b"secret".to_vec() });
        assert!(!h.add(pw, None, 1.0));
        assert!(h.entries().is_empty());
    }

    #[test]
    fn bounded_by_count_and_size() {
        let mut h = History::default();
        for i in 0..40 {
            h.add(text(&format!("copy {i}")), None, i as f64);
        }
        assert_eq!(h.entries().len(), MAX_ENTRIES);
        assert_eq!(h.latest().unwrap().label(), "copy 39");
        let big = |b: u8| Content { items: vec![Item { mime: "image/png".into(), data: vec![b; 40 << 20] }] };
        h.add(big(1), None, 50.0);
        h.add(big(2), None, 51.0);
        h.add(big(3), None, 52.0);
        // Two 40 MB images fit in 96 MB, a third doesn't: the oldest goes, with what's under it.
        assert_eq!(h.entries().len(), 2);
        assert_eq!(h.latest().unwrap().label(), "Image");
        // The newest stays even alone over the limit.
        h.add(Content { items: vec![Item { mime: "image/png".into(), data: vec![9; 100 << 20] }] }, None, 53.0);
        assert_eq!(h.entries().len(), 1);
    }

    #[test]
    fn rows_in_words() {
        assert_eq!(preview("fn main() {\n\n\tprintln!(\"hi\");  \n}\nmore\n"), "fn main() {\n    println!(\"hi\");\n}");
        assert_eq!(preview(&"x".repeat(300)).chars().count(), 241);
        assert_eq!(ago(5.0), "just now");
        assert_eq!(ago(125.0), "2 min ago");
        assert_eq!(ago(7300.0), "2 h ago");
        assert_eq!(ago(200000.0), "2 d ago");
    }
}
