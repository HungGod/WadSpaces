//! Instances: several WadBrowsers at once, each set up its own way.
//!
//! Without `--instance` there's one WadBrowser per user, as before. With
//! `--instance <id>` (wadd's WadBrowser setups on the machine), the control
//! socket, the session and the profiles' data are that instance's own:
//!
//! ```text
//! $XDG_RUNTIME_DIR/wadbrowser/<id>/ctl.sock
//! $XDG_STATE_HOME/wadbrowser/instances/<id>/session.json
//! $XDG_DATA_HOME/wadbrowser/instances/<id>/profiles/<profile>/
//! $XDG_CACHE_HOME/wadbrowser/instances/<id>/<profile>/
//! ```
//!
//! A later launch with the same id still hands its request to that
//! instance's process, so links keep working. An instance may also be
//! ephemeral (a throwaway run's setup): every profile in it keeps nothing.

use std::path::PathBuf;
use std::sync::OnceLock;

static ID: OnceLock<Option<String>> = OnceLock::new();
static EPHEMERAL: OnceLock<bool> = OnceLock::new();

/// Settles which instance this process is (once, before anything else looks).
pub fn init(id: Option<String>, ephemeral: bool) {
    let _ = ID.set(id);
    let _ = EPHEMERAL.set(ephemeral);
}

/// This process's instance id, if it has one.
pub fn id() -> Option<&'static str> {
    ID.get().and_then(|i| i.as_deref())
}

/// Whether nothing of this instance may be kept (no session, no profile data).
pub fn ephemeral() -> bool {
    EPHEMERAL.get().copied().unwrap_or(false)
}

/// `base/wadbrowser`, or `base/wadbrowser/instances/<id>` for an instance.
pub fn under(base: PathBuf) -> PathBuf {
    match id() {
        Some(id) => base.join("wadbrowser/instances").join(id),
        None => base.join("wadbrowser"),
    }
}

/// An XDG base folder, with its usual place under $HOME as the fallback.
pub fn xdg(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into())).join(fallback),
    }
}
