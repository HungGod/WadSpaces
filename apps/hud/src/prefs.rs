//! What the HUD remembers between runs (beside WadSpaces Client's theme file):
//! ~/.config/wadspaces/hud.json.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Prefs {
    /// The bar is tucked away: only its arrow shows.
    #[serde(default)]
    pub collapsed: bool,
    /// WadNotes' sections shown on the right (the bar's toggles).
    #[serde(default)]
    pub notes: bool,
    #[serde(default)]
    pub tasks: bool,
    #[serde(default)]
    pub calendar: bool,
    /// WadNotes put away (its button on the bar), the sections kept as they are.
    #[serde(default)]
    pub notes_away: bool,
}

/// Changes what's remembered (and keeps the rest).
pub fn update(f: impl FnOnce(&mut Prefs)) {
    let path = file();
    let mut p = load_from(&path);
    f(&mut p);
    save_to(&path, &p);
}

pub fn file() -> PathBuf {
    crate::theme::file().with_file_name("hud.json")
}

pub fn load_from(path: &Path) -> Prefs {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_to(path: &Path, p: &Prefs) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    let ok = serde_json::to_vec(p).ok().is_some_and(|b| std::fs::write(&tmp, b).is_ok());
    if !ok || std::fs::rename(&tmp, path).is_err() {
        eprintln!("hud: couldn't save {}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembered() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("wadspaces/hud.json");
        assert_eq!(load_from(&f), Prefs::default());
        save_to(&f, &Prefs { collapsed: true, calendar: true, ..Prefs::default() });
        assert!(load_from(&f).collapsed && load_from(&f).calendar);
        // An older file, without WadNotes: its sections off.
        std::fs::write(&f, r#"{"collapsed":true}"#).unwrap();
        assert_eq!(load_from(&f), Prefs { collapsed: true, ..Prefs::default() });
        std::fs::write(&f, "not json").unwrap();
        assert_eq!(load_from(&f), Prefs::default());
    }
}
