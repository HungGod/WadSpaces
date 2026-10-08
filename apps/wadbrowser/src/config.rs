//! The browser's settings: `/etc/wadspaces/wadbrowser.conf` (the image's,
//! written by WadSpaces Client's design), then `~/.config/wadbrowser/wadbrowser.conf`
//! (the user's) over it. `key = value` lines; `#` starts a comment.
//!
//! ```text
//! default = focus            # what links open in: full (URL bar) or focus
//! home = https://example.com # new tabs and the home button (unset: WadBrowser's own page)
//! search = https://duckduckgo.com/?q=%s
//! hibernate_after_minutes = 15   # 0: never
//! gpu = auto                 # auto | on | off
//! ```

use crate::browser::Mode;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const SYSTEM: &str = "/etc/wadspaces/wadbrowser.conf";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub default_mode: Mode,
    /// None: WadBrowser's own page (wadbrowser://home).
    pub home: Option<String>,
    pub search: String,
    pub hibernate_after_minutes: u64,
    pub gpu: Option<String>,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            default_mode: Mode::Focus,
            home: None,
            search: crate::urlbar::DEFAULT_SEARCH.into(),
            hibernate_after_minutes: 15,
            gpu: None,
        }
    }
}

static CONFIG: OnceLock<Config> = OnceLock::new();

/// The settings, read once.
pub fn get() -> &'static Config {
    CONFIG.get_or_init(|| load(&[PathBuf::from(SYSTEM), user_file()]))
}

/// `~/.config/wadbrowser`: the user's settings, zoom levels and permissions.
pub fn user_dir() -> PathBuf {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"),
    };
    base.join("wadbrowser")
}

fn user_file() -> PathBuf {
    user_dir().join("wadbrowser.conf")
}

pub fn load(files: &[PathBuf]) -> Config {
    let mut c = Config::default();
    for f in files {
        if let Ok(text) = std::fs::read_to_string(f) {
            apply(&mut c, &text, f);
        }
    }
    c
}

fn apply(c: &mut Config, text: &str, file: &Path) {
    for (n, line) in text.lines().enumerate() {
        let line = line.split_once('#').map_or(line, |(l, _)| l).trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=').map(|(k, v)| (k.trim(), v.trim())) else {
            tracing::warn!(file = %file.display(), line = n + 1, "not key = value");
            continue;
        };
        match key {
            "default" => match value {
                "full" => c.default_mode = Mode::Full,
                "focus" | "lite" => c.default_mode = Mode::Focus,
                _ => tracing::warn!(value, "default: full or focus"),
            },
            "home" if !value.is_empty() => c.home = Some(crate::urlbar::normalize(value)),
            "search" if value.contains("%s") => c.search = value.to_owned(),
            "hibernate_after_minutes" => match value.parse() {
                Ok(m) => c.hibernate_after_minutes = m,
                Err(_) => tracing::warn!(value, "hibernate_after_minutes: a number"),
            },
            "gpu" if matches!(value, "auto" | "on" | "off") => c.gpu = Some(value.to_owned()),
            _ => tracing::warn!(key, file = %file.display(), "unknown setting"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_files_win() {
        let dir = tempfile::tempdir().unwrap();
        let system = dir.path().join("system.conf");
        let user = dir.path().join("user.conf");
        std::fs::write(&system, "# the image's\ndefault = full\nhome = example.com\nhibernate_after_minutes = 5\n")
            .unwrap();
        std::fs::write(&user, "hibernate_after_minutes = 0  # never\nsearch = https://s.example/?q=%s\nbogus\n")
            .unwrap();
        let c = load(&[system, user, dir.path().join("missing.conf")]);
        assert_eq!(c.default_mode, Mode::Full);
        assert_eq!(c.home.as_deref(), Some("https://example.com"));
        assert_eq!(c.hibernate_after_minutes, 0);
        assert_eq!(c.search, "https://s.example/?q=%s");
    }

    #[test]
    fn defaults() {
        let c = load(&[]);
        assert_eq!(c.default_mode, Mode::Focus);
        assert_eq!(c.hibernate_after_minutes, 15);
        assert_eq!(c.home, None);
    }
}
