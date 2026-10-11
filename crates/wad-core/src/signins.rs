//! Saved sign-ins: kept on the host, mounted into each wadspace that uses
//! them, so signing in once covers all of them.
//!
//! A web sign-in is a WadBrowser profile (any web app can use it). An app's
//! is the files it keeps its sign-in in, under the home folder (/config):
//! known here for catalog apps, named by the user for any other. A path
//! ending in `/` is a folder, any other a file (the image's init links
//! each to the sign-in, and has to know which to make when neither has it).

/// A web app's kind of sign-in.
pub const WEB: &str = "web";

/// Where a wadspace sees each sign-in it mounts: `<MOUNT_ROOT>/<id>`.
pub const MOUNT_ROOT: &str = "/run/wadspaces-signins";

/// Where a catalog app keeps its sign-in, under the home folder. Folders
/// rather than files where an app replaces its files whole (a link to a
/// file wouldn't survive that).
pub fn paths_for(app: &str) -> Option<&'static [&'static str]> {
    Some(match app {
        // Accounts (GitHub, Microsoft) and extensions' sign-ins: Electron's
        // safe storage in state.vscdb, readable anywhere since the images
        // run it with --password-store=basic.
        "vscode" => &[".config/Code/User/globalStorage/"],
        "cursor" => &[".config/Cursor/User/globalStorage/"],
        // The Obsidian account (Sync, Publish) is in the app's local storage.
        "obsidian" => &[".config/obsidian/Local Storage/"],
        "claude-code" => &[".claude/.credentials.json", ".claude.json"],
        _ => return None,
    })
}

/// A path a sign-in may keep: relative to the home folder, inside it, and
/// not the Desktop (projects are mounted there); a folder's ends in `/`.
pub fn is_path(p: &str) -> bool {
    let parts: Vec<&str> = p.strip_suffix('/').unwrap_or(p).split('/').collect();
    !p.is_empty()
        && p.len() <= 200
        && !p.starts_with('/')
        && parts.iter().all(|s| !s.is_empty() && *s != "." && *s != "..")
        && !matches!(parts[0], "Desktop" | ".XDG" | ".wadspaces")
        && p.chars().all(|c| c.is_ascii_alphanumeric() || " ._-/".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        for ok in [".config/Code/User/globalStorage/", ".claude.json", ".config/obsidian/Local Storage/", ".config/x"] {
            assert!(is_path(ok), "{ok}");
        }
        for bad in [
            "",
            "/",
            "/etc/passwd",
            "../x",
            "a/../b",
            "a//b",
            "a//",
            "Desktop/x",
            "Desktop/",
            ".XDG",
            "a:b",
            "a\nb",
            ".",
        ] {
            assert!(!is_path(bad), "{bad:?}");
        }
        for app in ["vscode", "cursor", "obsidian", "claude-code"] {
            assert!(paths_for(app).unwrap().iter().all(|p| is_path(p)), "{app}");
        }
        assert!(paths_for("github").is_none());
    }
}
