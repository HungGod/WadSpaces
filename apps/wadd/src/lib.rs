//! wadd, the WadSpaces machine daemon, in Rust (stage 2 of the plan). It
//! serves `/v1` on a Unix socket to the callers its policy allows; the rest
//! (workspaces, projects, the account, ...) arrives milestone by milestone.

pub mod access;
pub mod api;
pub mod events;
pub mod logbuf;
pub mod systemd;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::net::UnixListener;
use wad_config::{Config, Profile};
use wad_proto::v1::{self, MachineInfo};

use crate::access::{Peer, Policy};
use crate::api::AppState;
use crate::events::Bus;
use crate::logbuf::LogBuffer;

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
    pub fn new(config: &Config, profile: Profile, listen: Listen, logs: LogBuffer) -> std::io::Result<Self> {
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
        let state = Arc::new(AppState { bus: Bus::new(machine), logs, policy });
        Ok(Self { listener, bound, state })
    }

    /// Serves until `shutdown` resolves.
    pub async fn run(self, shutdown: impl Future<Output = ()> + Send + 'static) -> std::io::Result<()> {
        let app = api::router(self.state.clone()).into_make_service_with_connect_info::<Peer>();
        let res = axum::serve(self.listener, app).with_graceful_shutdown(shutdown).await;
        if let Some(p) = &self.bound {
            let _ = std::fs::remove_file(p);
        }
        res
    }
}
