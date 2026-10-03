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

use serde::{Deserialize, Serialize};

pub const VENDOR: &str = "/usr/lib/wadspaces/wadd.toml";
pub const ADMIN: &str = "/etc/wadspaces/wadd.toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// A WadSpaces machine: root, rootful podman, system paths.
    System,
    /// A laptop or desktop: your user, rootless podman, your paths.
    User,
}

/// What wadd downloads on its own once podman is up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Prefetch {
    /// Nothing: images download from the launcher or on first use.
    None,
    /// The workspaces that start at boot (which it then starts).
    Autostart,
    /// Those, then every other workspace's image while disk allows.
    All,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Config {
    pub machine: Machine,
    pub daemon: Daemon,
    pub log: Log,
    pub keys: Keys,
    pub display: Display,
    pub cloud: Cloud,
    pub github: Github,
}

/// GitHub (where projects live).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Github {
    /// The OAuth App's settings (client_id, scopes) for the device sign-in.
    pub app: PathBuf,
}

impl Default for Github {
    fn default() -> Self {
        Self { app: "/usr/lib/wadspaces/github.toml".into() }
    }
}

/// The account link (the cloud relay). An empty project_id takes the image's
/// cloud.yaml (the Python wadd's) until the cutover moves it here.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Cloud {
    pub enabled: bool,
    pub project_id: String,
    /// Where enrollMachine runs.
    pub functions_region: String,
    /// The web API key (linking hands one over too).
    pub api_key: String,
    pub heartbeat_s: u64,
    /// How often pending commands are looked for.
    pub poll_s: u64,
    /// Use the Firebase emulators on this host (firebase.json's ports)
    /// instead of Google's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emulator: Option<String>,
}

impl Default for Cloud {
    fn default() -> Self {
        Self {
            enabled: true,
            project_id: String::new(),
            functions_region: "australia-southeast2".into(),
            api_key: String::new(),
            heartbeat_s: 30,
            poll_s: 3,
            emulator: None,
        }
    }
}

/// The keyboard proxy: wadd grabs the keyboards and keeps Super for itself
/// (Super+Tab switcher, Super+1..9 workspaces, Super+`home` Wad Creator).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Keys {
    /// Off on a laptop: your keyboard stays yours.
    pub enabled: bool,
    /// False: only watch for chords, filter nothing.
    pub grab: bool,
    /// With Super: back to Wad Creator.
    /// (The Python wadd called it `launcher`; that's read too.)
    pub home: Vec<String>,
    /// Chords dropped before they reach a workspace (modifiers must match exactly).
    pub block: Vec<String>,
    /// Also send other Super chords on to the workspace.
    pub pass_super: bool,
}

/// Where the screen is: the kiosk session's sway.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Display {
    pub enabled: bool,
    /// Where sway's IPC socket is looked for (the newest live one).
    pub runtime_dir: PathBuf,
    /// A fixed socket instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket: Option<PathBuf>,
}

impl Keys {
    pub fn for_profile(profile: Profile) -> Self {
        Self {
            enabled: profile == Profile::System,
            grab: true,
            home: vec!["KEY_0".into(), "KEY_SPACE".into()],
            block: vec!["alt+f4".into(), "ctrl+shift+q".into(), "ctrl+alt+backspace".into()],
            pass_super: false,
        }
    }
}

impl Default for Keys {
    fn default() -> Self {
        Self::for_profile(Profile::System)
    }
}

impl Display {
    pub fn for_profile(profile: Profile) -> Self {
        Self {
            enabled: true,
            // The kiosk user (uid 1000, host/etc/sysusers.d); on a laptop, yours.
            runtime_dir: match profile {
                Profile::System => "/run/user/1000".into(),
                Profile::User => runtime_dir(),
            },
            socket: None,
        }
    }
}

impl Default for Display {
    fn default() -> Self {
        Self::for_profile(Profile::System)
    }
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
    /// The Python wadd's workspace list, read until the cutover moves it into state.
    pub legacy_config: PathBuf,
    /// The image's cloud settings (its keys win over the legacy file's).
    pub vendor_cloud: PathBuf,
    /// The image's workspaces, one `<id>.toml` each: applied to the
    /// machine's list when they're new or the image changes them.
    pub vendor_workspaces: PathBuf,
    /// Podman's API socket.
    pub podman_socket: PathBuf,
    /// Where wadd writes the workspaces' quadlet units (rewritten at every
    /// start, so they're never stale; quadlet reads this directory).
    pub units_dir: PathBuf,
    /// Project folders, one per project.
    pub projects_dir: PathBuf,
    /// How long a workspace may take to come up.
    pub ready_timeout_s: u64,
    /// Images downloaded at once.
    pub max_parallel_pulls: usize,
    /// How often wadd checks the workspaces against podman.
    pub reconcile_s: u64,
    pub prefetch: Prefetch,
    /// With prefetch, skip an image (not an autostart one) when less than
    /// this is free, so small disks don't fill up.
    pub prefetch_min_free_gb: u64,
    /// Who owns project folders: the user inside the images (abc). git runs
    /// as them when wadd is root.
    pub projects_uid: u32,
    /// Folder projects and the folder browser stay inside these.
    pub folder_roots: Vec<PathBuf>,
    /// A build won't start with less free disk than this.
    pub build_min_free_gb: u64,
}

/// Home folders, and where drives get mounted.
pub const FOLDER_ROOTS: [&str; 6] = ["/var/home", "/home", "/mnt", "/media", "/run/media", "/run/wadspaces-drives"];

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
                legacy_config: "/etc/wadspaces/workspaces.yaml".into(),
                vendor_cloud: "/usr/lib/wadspaces/cloud.yaml".into(),
                vendor_workspaces: "/usr/lib/wadspaces/workspaces.d".into(),
                podman_socket: "/run/podman/podman.sock".into(),
                units_dir: "/run/containers/systemd".into(),
                projects_dir: "/var/lib/wadspaces-projects".into(),
                ready_timeout_s: 900,
                max_parallel_pulls: 3,
                reconcile_s: 5,
                prefetch: Prefetch::None,
                prefetch_min_free_gb: 15,
                projects_uid: 1000,
                folder_roots: FOLDER_ROOTS.iter().map(PathBuf::from).collect(),
                build_min_free_gb: 8,
            },
            Profile::User => Self {
                socket: runtime_dir().join("wadd/wadd.sock"),
                state_dir: home().join(".local/state/wadspaces"),
                allow_users: vec![],
                allow_groups: vec![],
                legacy_config: config_home().join("wadspaces/workspaces.yaml"),
                vendor_cloud: "/usr/lib/wadspaces/cloud.yaml".into(),
                vendor_workspaces: "/usr/lib/wadspaces/workspaces.d".into(),
                podman_socket: runtime_dir().join("podman/podman.sock"),
                units_dir: runtime_dir().join("containers/systemd"),
                projects_dir: home().join(".local/share/wadspaces-projects"),
                ready_timeout_s: 900,
                max_parallel_pulls: 3,
                reconcile_s: 5,
                prefetch: Prefetch::None,
                prefetch_min_free_gb: 15,
                projects_uid: 1000,
                folder_roots: FOLDER_ROOTS.iter().map(PathBuf::from).collect(),
                build_min_free_gb: 8,
            },
        }
    }
}

impl Config {
    pub fn defaults(profile: Profile) -> Self {
        Self {
            machine: Machine::default(),
            daemon: Daemon::for_profile(profile),
            log: Log::default(),
            keys: Keys::for_profile(profile),
            display: Display::for_profile(profile),
            cloud: Cloud::default(),
            github: Github::default(),
        }
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
    pub fn from_table(profile: Profile, mut table: toml::Table) -> Result<Self, toml::de::Error> {
        if let Some(toml::Value::Table(keys)) = table.get_mut("keys")
            && let Some(old) = keys.remove("launcher")
        {
            keys.entry("home").or_insert(old);
        }
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
    keys: Keys,
    display: Display,
    cloud: Cloud,
    github: Github,
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
    legacy_config: PathBuf,
    vendor_cloud: PathBuf,
    podman_socket: PathBuf,
    units_dir: PathBuf,
    projects_dir: PathBuf,
    ready_timeout_s: u64,
    max_parallel_pulls: usize,
    reconcile_s: u64,
    prefetch: Prefetch,
    prefetch_min_free_gb: u64,
    projects_uid: u32,
    folder_roots: Vec<PathBuf>,
    build_min_free_gb: u64,
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
                legacy_config: c.daemon.legacy_config.clone(),
                vendor_cloud: c.daemon.vendor_cloud.clone(),
                podman_socket: c.daemon.podman_socket.clone(),
                units_dir: c.daemon.units_dir.clone(),
                projects_dir: c.daemon.projects_dir.clone(),
                ready_timeout_s: c.daemon.ready_timeout_s,
                max_parallel_pulls: c.daemon.max_parallel_pulls,
                reconcile_s: c.daemon.reconcile_s,
                prefetch: c.daemon.prefetch,
                prefetch_min_free_gb: c.daemon.prefetch_min_free_gb,
                projects_uid: c.daemon.projects_uid,
                folder_roots: c.daemon.folder_roots.clone(),
                build_min_free_gb: c.daemon.build_min_free_gb,
            },
            log: RawLog { level: c.log.level.clone(), buffer_lines: c.log.buffer_lines },
            keys: c.keys.clone(),
            display: c.display.clone(),
            cloud: c.cloud.clone(),
            github: c.github.clone(),
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

    /// The image's own file (host/usr/lib/wadspaces/wadd.toml).
    #[test]
    fn the_images_settings() {
        let f = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../host/usr/lib/wadspaces/wadd.toml");
        let c = Config::load(Profile::System, &[f]).unwrap();
        assert_eq!(c.machine.name, "wadspaces");
        assert_eq!((c.daemon.prefetch, c.daemon.prefetch_min_free_gb), (Prefetch::None, 5));
        assert_eq!(c.daemon.socket, Path::new("/run/wadd/wadd.sock"));
        assert_eq!(c.daemon.vendor_workspaces, Path::new("/usr/lib/wadspaces/workspaces.d"));
        assert_eq!(
            (c.cloud.project_id.as_str(), c.cloud.functions_region.as_str()),
            ("wad-spaces", "australia-southeast2")
        );
        assert!(c.keys.enabled && c.keys.home == ["KEY_0", "KEY_SPACE"]);
    }

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
        assert_eq!(c.daemon.prefetch, Prefetch::None);
        assert!(c.keys.enabled && c.keys.home == ["KEY_0", "KEY_SPACE"]);
        assert!(!Config::load(Profile::User, &[]).unwrap().keys.enabled);
        let old = write(d.path(), "old.toml", "[keys]\nlauncher = [\"KEY_HOME\"]\n[display]\nsocket = \"/tmp/s\"\n");
        let c = Config::load(Profile::System, &[old]).unwrap();
        assert_eq!((c.keys.home, c.keys.grab), (vec!["KEY_HOME".to_string()], true));
        assert_eq!(c.display.socket, Some(PathBuf::from("/tmp/s")));
        let all = write(d.path(), "all.toml", "[daemon]\nprefetch = \"all\"\n");
        assert_eq!(Config::load(Profile::System, &[all]).unwrap().daemon.prefetch, Prefetch::All);
        let bad = write(d.path(), "some.toml", "[daemon]\nprefetch = \"some\"\n");
        assert!(Config::load(Profile::System, &[bad]).is_err());
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
