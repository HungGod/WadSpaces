//! Each wadspace's colour on the calendar: handed out from PALETTE the first
//! time a wadspace is seen (the first one nobody has yet), then kept in
//! colors.toml so it never changes on its own. You can pick another.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// (name, #rrggbb): readable on the dark and the light theme alike.
pub const PALETTE: [(&str, &str); 12] = [
    ("Slate", "#8b93a7"),
    ("Violet", "#7c5cff"),
    ("Pink", "#ff3d81"),
    ("Teal", "#14b8a6"),
    ("Amber", "#f59e0b"),
    ("Blue", "#3b82f6"),
    ("Lime", "#84cc16"),
    ("Red", "#ef4444"),
    ("Purple", "#a855f7"),
    ("Cyan", "#06b6d4"),
    ("Orange", "#f97316"),
    ("Green", "#10b981"),
];

/// scope -> its index in PALETTE.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Colors {
    #[serde(default)]
    pub scopes: BTreeMap<String, usize>,
}

impl Colors {
    pub fn parse(text: &str) -> Self {
        let mut c: Colors = toml::from_str(text).unwrap_or_default();
        c.scopes.retain(|_, i| *i < PALETTE.len());
        c
    }

    pub fn render(&self) -> String {
        toml::to_string(self).expect("colours serialize")
    }

    /// A scope's colour, if it has one yet.
    pub fn get(&self, scope: &str) -> Option<usize> {
        self.scopes.get(scope).copied()
    }

    /// A scope's colour, handing one out if it has none (true: it's new, so
    /// save). The machine's own (default) starts out Slate; a wadspace gets
    /// the first colour nobody has, or the least used once all are taken.
    pub fn assign(&mut self, scope: &str) -> (usize, bool) {
        if let Some(i) = self.get(scope) {
            return (i, false);
        }
        let i = if scope == crate::DEFAULT {
            0
        } else {
            let mut uses = [0usize; PALETTE.len()];
            for &i in self.scopes.values() {
                uses[i] += 1;
            }
            // Slate is the default's: wadspaces take it last.
            (1..PALETTE.len()).chain([0]).min_by_key(|&i| (uses[i], i == 0)).unwrap_or(1)
        };
        self.scopes.insert(scope.into(), i);
        (i, true)
    }

    pub fn set(&mut self, scope: &str, index: usize) {
        if index < PALETTE.len() {
            self.scopes.insert(scope.into(), index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_handed_out_once_and_kept() {
        let mut c = Colors::default();
        assert_eq!(c.assign("default"), (0, true));
        assert_eq!(c.assign("writing"), (1, true));
        assert_eq!(c.assign("iq-dev"), (2, true));
        assert_eq!(c.assign("writing"), (1, false));
        c.set("writing", 5);
        assert_eq!(c.assign("kale-b"), (1, true)); // freed by the change
        let again = Colors::parse(&c.render());
        assert_eq!(again, c);
        // Every colour taken: the least used, never Slate before the rest.
        let mut full = Colors::default();
        for n in 0..14 {
            full.assign(&format!("w{n}"));
        }
        assert_eq!(full.get("w10"), Some(11));
        assert_eq!(full.get("w11"), Some(0));
        assert_eq!(full.get("w12"), Some(1));
        // A broken or out-of-range file is no colours rather than a failure.
        assert_eq!(Colors::parse("scopes = 3"), Colors::default());
        assert_eq!(Colors::parse("[scopes]\na = 99\n").get("a"), None);
    }
}
