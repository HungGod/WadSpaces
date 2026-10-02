//! wadd's configuration, layered:
//!
//! - **system** (a WadSpaces machine): `/usr/lib/wadspaces/wadd.toml` from
//!   the image, then `/etc/wadspaces/wadd.toml` if the admin has one. wadd
//!   never writes either (what it changes at run time is state, under
//!   `state_dir`), so an image update can't be held back by an edited copy.
//! - **user** (`wadd serve --user`, a laptop): the same vendor file if there
//!   is one, then `~/.config/wadspaces/wadd.toml`; rootless podman, paths under
//!   your home and runtime dir.
//!
//! Later files override earlier ones key by key (tables merge). Unknown keys
//! are ignored, so an older wadd reads a newer file.

use std::path::PathBuf;

use serde::Deserialize;

pub const VENDOR: &str = "/usr/lib/wadspaces/wadd.toml";
pub const ADMIN: &str = "/etc/wadspaces/wadd.toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// A WadSpaces machine: root, rootful podman, system paths.
    System,
    /// A laptop or desktop: your user, rootless podman, your paths.
    User,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Config {
    pub machine: Machine,
    pub daemon: Daemon,
    pub log: Log,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Machine {
    /// What the machine is called (the kiosk and the account show it).
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Daemon {
    /// The API's Unix socket (when systemd doesn't hand one over).
    pub socket: PathBuf,
    /// Where wadd keeps its state (enrollment, projects, runs, ...).
    pub state_dir: PathBuf,
    /// Who may use the API, besides root and wadd's own user: these users...
    pub allow_users: Vec<String>,
    /// ...and members of these groups.
    pub allow_groups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Log {
    /// `tracing` filter, e.g. "info" or "wadd=debug,info".
    pub level: String,
    /// Lines kept in memory for /v1/logs.
    pub buffer_lines: usize,
}

impl Default for Machine {
    fn default() -> Self {
        Self { name: hostname().unwrap_or_else(|| "wadspaces".into()) }
    }
}

impl Default for Log {
    fn default() -> Self {
        Self { level: "info".into(), buffer_lines: 2000 }
    }
}

impl Default for Daemon {
    fn default() -> Self {
        Self::for_profile(Profile::System)
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::defaults(Profile::System)
    }
}

impl Daemon {
    pub fn for_profile(profile: Profile) -> Self {
        match profile {
            Profile::System => Self {
                socket: "/run/wadd/wadd.sock".into(),
                state_dir: "/var/lib/wadspaces".into(),
                // The kiosk user, and anyone an admin adds to group wad.
                allow_users: vec!["wad".into()],
                allow_groups: vec!["wad".into(), "wheel".into()],
            },
            Profile::User => Self {
                socket: runtime_dir().join("wadd/wadd.sock"),
                state_dir: home().join(".local/state/wadspaces"),
                allow_users: vec![],
                allow_groups: vec![],
            },
        }
    }
}

impl Config {
    pub fn defaults(profile: Profile) -> Self {
        Self { machine: Machine::default(), daemon: Daemon::for_profile(profile), log: Log::default() }
    }

    /// The files read for a profile, in order (missing ones are skipped).
    pub fn files(profile: Profile) -> Vec<PathBuf> {
        match profile {
            Profile::System => vec![VENDOR.into(), ADMIN.into()],
            Profile::User => vec![VENDOR.into(), config_home().join("wadspaces/wadd.toml")],
        }
    }

    /// The profile's defaults, then each file that exists, merged in order.
    pub fn load(profile: Profile, files: &[PathBuf]) -> Result<Self, Error> {
        let mut merged = toml::Table::new();
        for f in files {
            match std::fs::read_to_string(f) {
                Ok(text) => {
                    let t: toml::Table = text.parse().map_err(|e| Error::Parse(f.clone(), Box::new(e)))?;
                    merge(&mut merged, t);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(Error::Read(f.clone(), e)),
            }
        }
        Self::from_table(profile, merged).map_err(|e| Error::Invalid(Box::new(e)))
    }

    /// Defaults overlaid with a (merged) table.
    pub fn from_table(profile: Profile, table: toml::Table) -> Result<Self, toml::de::Error> {
        let defaults = Self::defaults(profile);
        let mut base = toml::Table::try_from(Raw::from(&defaults)).expect("defaults serialize");
        merge(&mut base, table);
        base.try_into()
    }
}

/// `over` into `base`: tables merge, anything else replaces.
fn merge(base: &mut toml::Table, over: toml::Table) {
    for (k, v) in over {
        match (base.get_mut(&k), v) {
            (Some(toml::Value::Table(b)), toml::Value::Table(o)) => merge(b, o),
            (_, v) => {
                base.insert(k, v);
            }
        }
    }
}

/// The defaults as a table to merge onto (Config itself only deserializes).
#[derive(serde::Serialize)]
struct Raw {
    machine: RawMachine,
    daemon: RawDaemon,
    log: RawLog,
}
#[derive(serde::Serialize)]
struct RawMachine {
    name: String,
}
#[derive(serde::Serialize)]
struct RawDaemon {
    socket: PathBuf,
    state_dir: PathBuf,
    allow_users: Vec<String>,
    allow_groups: Vec<String>,
}
#[derive(serde::Serialize)]
struct RawLog {
    level: String,
    buffer_lines: usize,
}

impl From<&Config> for Raw {
    fn from(c: &Config) -> Self {
        Self {
            machine: RawMachine { name: c.machine.name.clone() },
            daemon: RawDaemon {
                socket: c.daemon.socket.clone(),
                state_dir: c.daemon.state_dir.clone(),
                allow_users: c.daemon.allow_users.clone(),
                allow_groups: c.daemon.allow_groups.clone(),
            },
            log: RawLog { level: c.log.level.clone(), buffer_lines: c.log.buffer_lines },
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: {1}")]
    Read(PathBuf, #[source] std::io::Error),
    #[error("{0}: {1}")]
    Parse(PathBuf, #[source] Box<toml::de::Error>),
    #[error("configuration: {0}")]
    Invalid(#[source] Box<toml::de::Error>),
}

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn home() -> PathBuf {
    env_path("HOME").unwrap_or_else(|| "/".into())
}

fn runtime_dir() -> PathBuf {
    env_path("XDG_RUNTIME_DIR").unwrap_or_else(std::env::temp_dir)
}

fn config_home() -> PathBuf {
    env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config"))
}

/// The configured hostname, else the kernel's (a transient one has no file).
fn hostname() -> Option<String> {
    ["/etc/hostname", "/proc/sys/kernel/hostname"]
        .iter()
        .find_map(|f| std::fs::read_to_string(f).ok().map(|h| h.trim().to_string()).filter(|h| !h.is_empty()))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, text).unwrap();
        p
    }

    #[test]
    fn defaults_per_profile() {
        let c = Config::load(Profile::System, &[]).unwrap();
        assert_eq!(c.daemon.socket, PathBuf::from("/run/wadd/wadd.sock"));
        assert_eq!(c.daemon.allow_groups, ["wad", "wheel"]);
        let u = Config::load(Profile::User, &[]).unwrap();
        assert!(u.daemon.socket.ends_with("wadd/wadd.sock"));
        assert!(u.daemon.allow_users.is_empty());
    }

    #[test]
    fn later_files_override_key_by_key_and_unknown_keys_are_ignored() {
        let d = tempfile::tempdir().unwrap();
        let vendor = write(
            d.path(),
            "vendor.toml",
            "[machine]\nname = \"Surface\"\n[log]\nlevel = \"debug\"\nbuffer_lines = 10\n[future]\nthing = 1\n",
        );
        let admin = write(d.path(), "admin.toml", "[log]\nlevel = \"warn\"\n[daemon]\nnew_key = true\n");
        let missing = d.path().join("nope.toml");
        let c = Config::load(Profile::System, &[vendor, admin, missing]).unwrap();
        assert_eq!(c.machine.name, "Surface");
        assert_eq!(c.log.level, "warn");
        assert_eq!(c.log.buffer_lines, 10);
        assert_eq!(c.daemon.state_dir, PathBuf::from("/var/lib/wadspaces"));
    }

    #[test]
    fn bad_files_say_which() {
        let d = tempfile::tempdir().unwrap();
        let bad = write(d.path(), "bad.toml", "[log\n");
        let e = Config::load(Profile::System, std::slice::from_ref(&bad)).unwrap_err();
        assert!(e.to_string().starts_with(&bad.display().to_string()), "{e}");
        let wrong = write(d.path(), "wrong.toml", "[log]\nbuffer_lines = \"many\"\n");
        assert!(matches!(Config::load(Profile::System, &[wrong]), Err(Error::Invalid(_))));
    }
}
