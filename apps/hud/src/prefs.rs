//! What the HUD remembers between runs (beside WadSpaces Client's theme file):
//! ~/.config/wadspaces/hud.json.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Prefs {
    /// The bar is tucked away: only its arrow shows.
    #[serde(default)]
    pub collapsed: bool,
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
        save_to(&f, &Prefs { collapsed: true });
        assert!(load_from(&f).collapsed);
        std::fs::write(&f, "not json").unwrap();
        assert_eq!(load_from(&f), Prefs::default());
    }
}
