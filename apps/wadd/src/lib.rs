//! wadd, the WadSpaces machine daemon, in Rust (stage 2 of the plan). It
//! serves `/v1` on a Unix socket to the callers its policy allows, and runs
//! the machine's workspaces (registry.rs); the rest (projects, the account,
//! ...) arrives milestone by milestone.

pub mod access;
pub mod api;
pub mod backend;
pub mod events;
pub mod logbuf;
pub mod pull;
pub mod registry;
pub mod systemd;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::net::UnixListener;
use wad_config::{Config, Profile};
use wad_proto::v1::{self, MachineInfo, Workspace};

use crate::access::{Peer, Policy};
use crate::api::AppState;
use crate::backend::Backend;
use crate::events::Bus;
use crate::logbuf::LogBuffer;
use crate::registry::{Registry, Settings};

/// Where the API listens.
pub enum Listen {
    /// The socket systemd handed over (wadd.socket).
    Activated(std::os::unix::net::UnixListener),
    /// A path to bind (and remove on exit).
    Path(PathBuf),
}

pub struct Server {
    pub listener: UnixListener,
    /// The path we bound, to clean up; None when systemd owns the socket.
    pub bound: Option<PathBuf>,
    pub state: Arc<AppState>,
    /// The workspaces to take on when serving starts.
    workspaces: Vec<Workspace>,
    reconcile_every: Duration,
    prefetch: (wad_config::Prefetch, u64),
}

/// The machine's workspaces: `workspaces.json` in the state directory (the
/// Rust wadd's own list) if there is one, else the Python wadd's
/// workspaces.yaml.
pub fn read_workspaces(daemon: &wad_config::Daemon) -> Result<Vec<Workspace>, String> {
    let own = daemon.state_dir.join("workspaces.json");
    match std::fs::read_to_string(&own) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", own.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            wad_store::legacy::read(&daemon.legacy_config, Some(&daemon.vendor_cloud))
                .map(|c| c.workspaces)
                .map_err(|e| e.to_string())
        }
        Err(e) => Err(format!("{}: {e}", own.display())),
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Binds `path`: its directory made if needed, a stale socket replaced. On a
/// machine the socket is 0660 and group `wad`'s (so the kiosk can connect);
/// on a laptop, yours alone.
fn bind(path: &Path, profile: Profile) -> std::io::Result<UnixListener> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let l = UnixListener::bind(path)?;
    let mode = if profile == Profile::System { 0o660 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    if profile == Profile::System
        && let Ok(Some(g)) = nix::unistd::Group::from_name("wad")
    {
        nix::unistd::chown(path, None, Some(g.gid))?;
    }
    Ok(l)
}

impl Server {
    /// A server for `config`, managing workspaces through `backend`.
    pub fn new(
        config: &Config,
        profile: Profile,
        listen: Listen,
        logs: LogBuffer,
        backend: Arc<dyn Backend>,
    ) -> std::io::Result<Self> {
        let (listener, bound) = match listen {
            Listen::Activated(std) => {
                std.set_nonblocking(true)?;
                (UnixListener::from_std(std)?, None)
            }
            Listen::Path(p) => (bind(&p, profile)?, Some(p)),
        };
        let machine = MachineInfo {
            name: config.machine.name.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
            profile: match profile {
                Profile::System => v1::Profile::System,
                Profile::User => v1::Profile::User,
            },
            started_at: now_secs(),
        };
        let policy = Policy {
            own_uid: nix::unistd::getuid().as_raw(),
            users: config.daemon.allow_users.clone(),
            groups: config.daemon.allow_groups.clone(),
            directory: Box::new(access::System),
        };
        let d = &config.daemon;
        let bus = Bus::new(machine);
        let uid = nix::unistd::getuid().as_raw();
        let registry = Registry::new(
            backend,
            bus.clone(),
            Settings {
                ready_timeout: Duration::from_secs(d.ready_timeout_s),
                max_parallel_pulls: d.max_parallel_pulls,
                projects_dir: d.projects_dir.to_string_lossy().into_owned(),
                state_dir: d.state_dir.clone(),
                // Rootless podman maps you to this uid inside (PUID 1000).
                rootless_uid: (uid != 0).then_some(uid),
                poll: Duration::from_secs(1),
            },
        );
        let workspaces = read_workspaces(d).unwrap_or_else(|e| {
            tracing::error!("no workspaces: {e}");
            vec![]
        });
        let state =
            Arc::new(AppState { bus, registry, logs, policy, store: wad_store::State::new(&config.daemon.state_dir) });
        Ok(Self {
            listener,
            bound,
            state,
            workspaces,
            reconcile_every: Duration::from_secs(d.reconcile_s.max(1)),
            prefetch: (d.prefetch, d.prefetch_min_free_gb),
        })
    }

    /// Serves until `shutdown` resolves.
    pub async fn run(self, shutdown: impl Future<Output = ()> + Send + 'static) -> std::io::Result<()> {
        let registry = self.state.registry.clone();
        if let Err(e) = registry.load(self.workspaces).await {
            tracing::warn!("workspace units: {e}");
        }
        let reconcile = registry.spawn_reconcile(self.reconcile_every);
        let (mode, min_free_gb) = self.prefetch;
        let prefetch = tokio::spawn(registry.clone().prefetch(mode, min_free_gb, Duration::from_secs(300)));
        let app = api::router(self.state.clone()).into_make_service_with_connect_info::<Peer>();
        let res = axum::serve(self.listener, app).with_graceful_shutdown(shutdown).await;
        reconcile.abort();
        prefetch.abort();
        if let Some(p) = &self.bound {
            let _ = std::fs::remove_file(p);
        }
        res
    }
}
