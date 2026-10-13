//! The app's theme for the HUD (apps/hud): written to
//! ~/.config/wadspaces/theme, which the HUD follows, so the bar, menus and
//! switcher are dark or light with the app.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;
use wad_proto::{ApiError, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Dark,
    Light,
}

fn file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    config.join("wadspaces/theme")
}

/// Tells the HUD which theme the app shows.
#[tauri::command]
#[specta::specta]
pub fn set_theme(theme: Theme) -> Result<(), ApiError> {
    let path = file();
    let text = match theme {
        Theme::Dark => "dark\n",
        Theme::Light => "light\n",
    };
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().expect("has a parent"))?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &path)
    };
    write().map_err(|e| ApiError::new(ErrorCode::Internal, format!("{}: {e}", path.display())))
}

/// Whether this is the machine's own app (`--kiosk`), under the HUD.
pub struct Kiosk(pub bool);

/// Whether the HUD's bar is out along the bottom (not tucked behind its
/// arrow), so the app keeps what's at its bottom edge clear of it. Only the
/// machine's app has the HUD over it; the HUD remembers its bar in
/// ~/.config/wadspaces/hud.json (no file yet: it's out).
#[tauri::command]
#[specta::specta]
pub fn hud_bar_open(kiosk: tauri::State<'_, Kiosk>) -> bool {
    #[derive(Deserialize)]
    struct Hud {
        #[serde(default)]
        collapsed: bool,
    }
    kiosk.0
        && std::fs::read(file().with_file_name("hud.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Hud>(&b).ok())
            .is_none_or(|h| !h.collapsed)
}
