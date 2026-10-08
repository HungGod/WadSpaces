//! What's copied, and what of it travels: the rules, without a compositor
//! (so they're tested).
//!
//! A copy offers its data in several types (text in four spellings, HTML, an
//! image as PNG and BMP and TIFF…). Only some are worth carrying between
//! wadspaces: text of every kind, one image (PNG if there's one), a file
//! manager's copied files, and KDE's password-manager hint (so a password
//! stays out of the history). Each copy made here also offers a marker type
//! naming who made it, which is how a bridge knows its own copies when they
//! come back (and doesn't send them round again).

use std::hash::{Hash, Hasher};

/// A copy made by `<me>` offers `MARKER<me>` too.
pub const MARKER: &str = "application/x-wadspaces-from-";
/// KeePassXC and others offer "secret" in this for a password.
pub const PASSWORD_HINT: &str = "x-kde-passwordManagerHint";
/// One type's data at most (a screenshot is a few MB).
pub const MAX_ITEM: usize = 32 << 20;
/// All of a copy's data at most.
pub const MAX_TOTAL: usize = 64 << 20;
/// Types carried per copy at most.
pub const MAX_TYPES: usize = 12;

/// Text's types, best first.
const TEXT: [&str; 5] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING", "TEXT"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub mime: String,
    pub data: Vec<u8>,
}

/// A copy: its data in each type carried.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Content {
    pub items: Vec<Item>,
}

pub fn marker(me: &str) -> String {
    format!("{MARKER}{me}")
}

/// Who made a copy, from its marker type (None: an app did).
pub fn origin(mimes: &[String]) -> Option<&str> {
    mimes.iter().find_map(|m| m.strip_prefix(MARKER))
}

/// The types worth carrying, in the order offered.
pub fn wanted(offered: &[String]) -> Vec<String> {
    let image = offered.iter().find(|m| *m == "image/png").or_else(|| offered.iter().find(|m| m.starts_with("image/")));
    let mut out: Vec<String> = Vec::new();
    for m in offered {
        if out.len() == MAX_TYPES {
            break;
        }
        let keep = m.starts_with("text/")
            || matches!(
                m.as_str(),
                "UTF8_STRING" | "STRING" | "TEXT" | "COMPOUND_TEXT" | "x-special/gnome-copied-files" | PASSWORD_HINT
            )
            || Some(m) == image;
        if keep && !m.starts_with(MARKER) && !out.contains(m) {
            out.push(m.clone());
        }
    }
    out
}

impl Content {
    pub fn get(&self, mime: &str) -> Option<&[u8]> {
        self.items.iter().find(|i| i.mime == mime).map(|i| i.data.as_slice())
    }

    pub fn size(&self) -> usize {
        self.items.iter().map(|i| i.data.len()).sum()
    }

    /// The same copy (the same types with the same data).
    pub fn digest(&self) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.items.hash(&mut h);
        h.finish()
    }

    /// A password manager's copy: carried between wadspaces, never kept.
    pub fn secret(&self) -> bool {
        self.get(PASSWORD_HINT).is_some_and(|d| d.trim_ascii() == b"secret")
    }

    pub fn text(&self) -> Option<String> {
        TEXT.iter().find_map(|t| self.get(t)).map(|d| String::from_utf8_lossy(d).into_owned())
    }

    /// The image carried, if any: its type and data.
    pub fn image(&self) -> Option<(&str, &[u8])> {
        self.items.iter().find(|i| i.mime.starts_with("image/")).map(|i| (i.mime.as_str(), i.data.as_slice()))
    }
}

impl Hash for Item {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.mime.hash(state);
        self.data.hash(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn content(items: &[(&str, &str)]) -> Content {
        Content {
            items: items.iter().map(|(m, d)| Item { mime: m.to_string(), data: d.as_bytes().to_vec() }).collect(),
        }
    }

    #[test]
    fn text_html_and_one_image_travel() {
        let offered = strs(&[
            "text/html",
            "text/plain;charset=utf-8",
            "UTF8_STRING",
            "image/bmp",
            "image/png",
            "application/x-libreoffice-tsvc",
            "SAVE_TARGETS",
            "TARGETS",
            "x-kde-passwordManagerHint",
        ]);
        assert_eq!(
            wanted(&offered),
            strs(&["text/html", "text/plain;charset=utf-8", "UTF8_STRING", "image/png", "x-kde-passwordManagerHint"])
        );
        // No PNG: the first image.
        assert_eq!(wanted(&strs(&["image/tiff", "image/bmp"])), strs(&["image/tiff"]));
        // Only an app's own format: nothing to carry.
        assert!(wanted(&strs(&["application/x-qt-image-thing"])).is_empty());
        let many: Vec<String> = (0..40).map(|i| format!("text/x-{i}")).collect();
        assert_eq!(wanted(&many).len(), MAX_TYPES);
    }

    #[test]
    fn markers_name_who_copied() {
        let mut offered = strs(&["text/plain"]);
        assert_eq!(origin(&offered), None);
        offered.push(marker("hud"));
        assert_eq!(origin(&offered), Some("hud"));
        // The marker itself never travels.
        assert_eq!(wanted(&offered), strs(&["text/plain"]));
    }

    #[test]
    fn text_secrets_and_sameness() {
        let c = content(&[("text/html", "<b>hi</b>"), ("UTF8_STRING", "hi"), ("text/plain", "plain")]);
        assert_eq!(c.text().as_deref(), Some("hi"));
        assert!(!c.secret());
        assert_eq!(c.image(), None);
        assert!(content(&[("text/plain", "pw"), (PASSWORD_HINT, "secret\n")]).secret());
        assert!(!content(&[("text/plain", "pw"), (PASSWORD_HINT, "public")]).secret());
        assert_eq!(c.digest(), c.clone().digest());
        assert_ne!(c.digest(), content(&[("text/plain", "plain")]).digest());
        assert_eq!(c.size(), 9 + 2 + 5);
    }
}
