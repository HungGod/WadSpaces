//! Diagnostics (manager.py diagnostics and logs), for WadSpaces Client's
//! Diagnostics page: enough to see where a download is and why something
//! failed, without a shell. Everything is redacted: it's meant to be pasted
//! into a chat or an issue. Unit logs are read only for an allow-list (wadd,
//! greetd and the workspaces' own units).

use wad_proto::v1::{DiagDisk, DiagPodman, DiagWadd, Diagnostics, LogText, Profile};
use wad_proto::{ApiError, ErrorCode};

use crate::api::AppState;
use crate::logbuf::redact;

/// The units whose logs can be read.
pub fn log_units(app: &AppState) -> Vec<String> {
    let mut u = vec!["wadd".to_string(), "greetd".to_string()];
    u.extend(app.registry.workspaces().into_iter().map(|w| format!("wad-{}", w.id)));
    u
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The last 30 warnings and errors in wadd's log.
fn recent_problems(app: &AppState) -> Vec<wad_proto::v1::LogLine> {
    let mut p: Vec<_> = app
        .logs
        .tail(2000)
        .into_iter()
        .filter(|l| matches!(l.level.to_lowercase().as_str(), "warn" | "error"))
        .collect();
    let cut = p.len().saturating_sub(30);
    p.drain(..cut);
    p
}

pub async fn diagnostics(app: &AppState) -> Diagnostics {
    let machine = app.bus.machine();
    let b = &app.registry_backend;
    let mut podman = DiagPodman {
        connected: b.available().await,
        version: None,
        graph_root: None,
        storage_driver: None,
        images: None,
        error: None,
    };
    match b.podman_info().await {
        Ok(info) => {
            let s = |p: &str| info.pointer(p).and_then(|v| v.as_str()).map(String::from);
            podman.version = s("/version/Version");
            podman.graph_root = s("/store/graphRoot");
            podman.storage_driver = s("/store/graphDriverName");
            podman.images = info.pointer("/store/imageStore/number").and_then(|v| v.as_u64());
        }
        Err(e) => podman.error = Some(e),
    }
    let disk_path =
        podman.graph_root.clone().filter(|p| std::path::Path::new(p).is_dir()).unwrap_or_else(|| "/".into());
    let (free, total) = match nix::sys::statvfs::statvfs(disk_path.as_str()) {
        Ok(s) => (s.blocks_available() * s.fragment_size(), s.blocks() * s.fragment_size()),
        Err(_) => (0, 0),
    };
    let keys = app.keys.lock().unwrap().as_ref().map(|k| k.status()).unwrap_or_default();
    let d = Diagnostics {
        wadd: DiagWadd {
            version: machine.version.clone(),
            uptime_s: now().saturating_sub(machine.started_at),
            pid: std::process::id(),
            profile: machine.profile,
        },
        podman,
        disk: DiagDisk { path: disk_path, free_bytes: free, total_bytes: total },
        network: app.network.status().await,
        view: app.view.state(),
        keys: wad_proto::v1::KeysStatus {
            enabled: app.keys_enabled,
            grabbing: keys.grabbing,
            keyboards: keys.keyboards,
            note: keys.note,
        },
        secrets: app.secrets.list().await.unwrap_or_default(),
        log_units: log_units(app),
        workspaces: app.registry.states(),
        recent_problems: recent_problems(app),
    };
    // Redacted as a whole, like the Python wadd did.
    let text = redact(&serde_json::to_string(&d).expect("json"));
    serde_json::from_str(&text).unwrap_or(d)
}

/// A unit's journal (allow-listed), redacted.
pub async fn unit_log(app: &AppState, unit: &str, lines: usize) -> Result<LogText, ApiError> {
    let unit = unit.trim_end_matches(".service");
    if !log_units(app).iter().any(|u| u == unit) {
        return Err(ApiError::new(ErrorCode::NotFound, format!("no logs for {unit:?} here")));
    }
    let mut cmd = tokio::process::Command::new("journalctl");
    if app.bus.machine().profile == Profile::User && unit != "greetd" {
        cmd.arg("--user");
    }
    cmd.args(["--no-pager", "-o", "short-iso", "-n", &lines.to_string(), "-u", &format!("{unit}.service")])
        .kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| ApiError::new(ErrorCode::Timeout, "journalctl took too long"))?
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("journalctl: {e}")))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(LogText { text: redact(&text) })
}

/// A workspace container's output, redacted.
pub async fn workspace_log(app: &AppState, id: &str, lines: usize) -> Result<LogText, ApiError> {
    let ws = app.registry.workspace(id)?;
    let text = app
        .registry_backend
        .container_logs(&ws.container_name, lines)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Offline, e))?
        .unwrap_or_else(|| format!("{} isn't running (no container)", ws.container_name));
    Ok(LogText { text: redact(&text) })
}
