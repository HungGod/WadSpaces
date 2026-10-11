//! Light or dark. The machine's own WadBrowser (the `host` feature) is as
//! WadSpaces is: the WadSpaces Client writes its theme to
//! `~/.config/wadspaces/theme` ("light" or "dark"), and WadBrowser follows
//! that file, live. Inside a wadspace it's always dark, its own look.
//! The pages say which by `data-theme` on their root: the chrome from its
//! state (`theme` in browser::State), the popup as it opens (menu.rs) and
//! WadBrowser's own pages as they're made (pages.rs). Not WebKit's
//! `prefers-color-scheme`, which follows the desktop's settings portal
//! rather than anything WadBrowser sets. GTK's own prefer-dark follows too,
//! for its widgets.

use gtk::gio;
use gtk::prelude::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static DARK: AtomicBool = AtomicBool::new(true);

/// "dark" or "light", now.
pub fn name() -> &'static str {
    if DARK.load(Ordering::Relaxed) { "dark" } else { "light" }
}

/// One of WadBrowser's own pages, marked with the theme (its first `<html`).
pub fn html(page: &str) -> String {
    page.replacen("<html", &format!("<html data-theme=\"{}\"", name()), 1)
}

fn file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    config.join("wadspaces/theme")
}

/// Dark unless the file says light (WADBROWSER_THEME wins: the spike).
pub fn dark(file_text: Option<&str>) -> bool {
    let chosen = std::env::var("WADBROWSER_THEME").ok();
    chosen.as_deref().or(file_text).map(str::trim) != Some("light")
}

fn apply() {
    // Inside a wadspace: dark, whatever anyone says.
    let dark = !cfg!(feature = "host") || dark(std::fs::read_to_string(file()).ok().as_deref());
    if DARK.swap(dark, Ordering::Relaxed) != dark {
        tracing::info!(dark, "theme");
        crate::browser::each(|_, b| b.retheme());
    }
    let Some(s) = gtk::Settings::default() else { return };
    if s.is_gtk_application_prefer_dark_theme() != dark {
        s.set_gtk_application_prefer_dark_theme(dark);
    }
    // A dark theme by name (the desktop's, through the settings portal)
    // would make WebKit dark whatever prefer-dark says.
    if !dark && s.gtk_theme_name().is_some_and(|n| n.to_lowercase().contains("dark")) {
        s.set_gtk_theme_name(Some("Adwaita"));
    }
}

/// Applies the theme now and (on the machine itself) follows the file from here on.
pub fn follow() {
    apply();
    if !cfg!(feature = "host") {
        return;
    }
    let path = file();
    if let Some(dir) = path.parent()
        && !dir.is_dir()
    {
        return; // not on the machine itself: nothing to follow
    }
    match gio::File::for_path(&path).monitor_file(gio::FileMonitorFlags::WATCH_MOVES, None::<&gio::Cancellable>) {
        Ok(m) => {
            m.connect_changed(|_, _, _, _| apply());
            // Kept for as long as WadBrowser runs.
            std::mem::forget(m);
        }
        Err(e) => tracing::warn!(%e, "can't follow the theme"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn pages_are_marked() {
        let page = super::html("<!doctype html><html lang=\"en\"><body><html>");
        assert!(page.starts_with("<!doctype html><html data-theme=\""), "{page}");
        assert_eq!(page.matches("data-theme").count(), 1);
    }

    #[test]
    fn dark_unless_light() {
        if std::env::var_os("WADBROWSER_THEME").is_some() {
            return;
        }
        assert!(super::dark(None));
        assert!(super::dark(Some("dark\n")));
        assert!(!super::dark(Some("light\n")));
    }
}
