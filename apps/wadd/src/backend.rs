//! What the Registry asks of the machine: podman (containers, images,
//! pulls), systemd (the workspaces' units) and a few probes. A trait, so the
//! lifecycle is tested against a fake (tests/registry.rs).

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use wad_podman::Podman;
use wad_systemd::Systemd;

use crate::pull;

/// Lines from a pull, as they come.
pub type OnLine = Box<dyn FnMut(&str) + Send>;

#[async_trait]
pub trait Backend: Send + Sync + 'static {
    /// Podman answers.
    async fn available(&self) -> bool;
    /// A container's status: running, exited, ... ("missing": there's none).
    async fn container(&self, name: &str) -> Result<String, String>;
    async fn image_exists(&self, image: &str) -> Result<bool, String>;
    async fn pull(&self, image: &str, on_line: OnLine) -> Result<(), String>;
    async fn start(&self, unit: &str) -> Result<(), String>;
    async fn stop(&self, unit: &str) -> Result<(), String>;
    async fn restart(&self, unit: &str) -> Result<(), String>;
    /// Makes the units directory hold exactly these wad-*.container files
    /// (name, text), and reloads systemd when anything changed. True if it did.
    async fn install_units(&self, units: Vec<(String, String)>) -> Result<bool, String>;
    /// A stream answers (any status under 500).
    async fn http_ok(&self, url: &str) -> bool;
    /// What a pull of `image` has to download: (bytes, layers). None: unknown.
    async fn download_size(&self, image: &str) -> Option<(u64, u32)>;
    /// Bytes received on the machine's real network interfaces so far.
    fn rx_bytes(&self) -> u64;
    /// Free space where images are kept, in GB (None: unknown).
    async fn free_gb(&self) -> Option<f64>;
    /// The workspace a container belongs to (its wadspaces.id label).
    async fn workspace_of(&self, _container: &str) -> Option<String> {
        None
    }
    /// An image's labels; None if it isn't here.
    async fn image_labels(&self, _image: &str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        Err("no podman".into())
    }
    /// Where a named volume's files are; None if there's no such volume.
    async fn volume_mountpoint(&self, _name: &str) -> Option<String> {
        None
    }
    /// The github_token secret (git's credentials for github.com).
    async fn github_token(&self) -> Option<String> {
        None
    }
    /// The names of podman's secrets.
    async fn secret_names(&self) -> Result<Vec<String>, String> {
        Err("no podman".into())
    }
    /// podman's own description.
    async fn podman_info(&self) -> Result<serde_json::Value, String> {
        Err("no podman".into())
    }
    /// A container's last lines of output; None if there's no container.
    async fn container_logs(&self, _name: &str, _lines: usize) -> Result<Option<String>, String> {
        Err("no podman".into())
    }
    /// Creates (replacing) a secret. Its value only ever goes to podman.
    async fn create_secret(&self, _name: &str, _value: &[u8]) -> Result<(), String> {
        Err("no podman".into())
    }
    /// False if there was none.
    async fn delete_secret(&self, _name: &str) -> Result<bool, String> {
        Err("no podman".into())
    }
    /// Builds an image from a tar build context on `base` (its BASE_IMAGE
    /// build argument). Dropping the future stops the build.
    async fn build(&self, _context: Vec<u8>, _tag: &str, _base: &str, _on_line: OnLine) -> Result<(), String> {
        Err("no podman".into())
    }
}

/// The machine as wadd's config describes it: podman's socket, systemd (the
/// system manager, or yours with --user) and where units go.
pub async fn connect(daemon: &wad_config::Daemon, profile: wad_config::Profile) -> Result<Real, String> {
    let systemd = match profile {
        wad_config::Profile::System => Systemd::system().await,
        wad_config::Profile::User => Systemd::user().await,
    }
    .map_err(|e| format!("systemd: {e}"))?;
    Ok(Real {
        podman: Podman::new(&daemon.podman_socket),
        systemd,
        units_dir: daemon.units_dir.clone(),
        http: reqwest::Client::new(),
        start_timeout: Duration::from_secs(daemon.ready_timeout_s),
    })
}

/// No machine to manage (systemd unreachable, or a test): everything
/// workspaces need fails with why, and the rest of wadd still answers.
pub struct Offline(pub String);

#[async_trait]
impl Backend for Offline {
    async fn available(&self) -> bool {
        false
    }
    async fn container(&self, _: &str) -> Result<String, String> {
        Err(self.0.clone())
    }
    async fn image_exists(&self, _: &str) -> Result<bool, String> {
        Err(self.0.clone())
    }
    async fn pull(&self, _: &str, _: OnLine) -> Result<(), String> {
        Err(self.0.clone())
    }
    async fn start(&self, _: &str) -> Result<(), String> {
        Err(self.0.clone())
    }
    async fn stop(&self, _: &str) -> Result<(), String> {
        Err(self.0.clone())
    }
    async fn restart(&self, _: &str) -> Result<(), String> {
        Err(self.0.clone())
    }
    async fn install_units(&self, _: Vec<(String, String)>) -> Result<bool, String> {
        Err(self.0.clone())
    }
    async fn http_ok(&self, _: &str) -> bool {
        false
    }
    async fn download_size(&self, _: &str) -> Option<(u64, u32)> {
        None
    }
    fn rx_bytes(&self) -> u64 {
        0
    }
    async fn free_gb(&self) -> Option<f64> {
        None
    }
    async fn image_labels(&self, _: &str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        Err(self.0.clone())
    }
    async fn secret_names(&self) -> Result<Vec<String>, String> {
        Err(self.0.clone())
    }
    async fn create_secret(&self, _: &str, _: &[u8]) -> Result<(), String> {
        Err(self.0.clone())
    }
    async fn delete_secret(&self, _: &str) -> Result<bool, String> {
        Err(self.0.clone())
    }
    async fn podman_info(&self) -> Result<serde_json::Value, String> {
        Err(self.0.clone())
    }
    async fn container_logs(&self, _: &str, _: usize) -> Result<Option<String>, String> {
        Err(self.0.clone())
    }
}

pub struct Real {
    pub podman: Podman,
    pub systemd: Systemd,
    pub units_dir: PathBuf,
    pub http: reqwest::Client,
    pub start_timeout: Duration,
}

#[async_trait]
impl Backend for Real {
    async fn available(&self) -> bool {
        self.podman.ping().await
    }

    async fn container(&self, name: &str) -> Result<String, String> {
        self.podman.container_status(name).await.map_err(|e| e.to_string())
    }

    async fn image_exists(&self, image: &str) -> Result<bool, String> {
        self.podman.image_exists(image).await.map_err(|e| e.to_string())
    }

    async fn pull(&self, image: &str, mut on_line: OnLine) -> Result<(), String> {
        self.podman.pull(image, |l| on_line(l)).await.map_err(|e| e.to_string())
    }

    async fn start(&self, unit: &str) -> Result<(), String> {
        self.systemd.start(unit, self.start_timeout).await.map_err(|e| e.to_string())
    }

    async fn stop(&self, unit: &str) -> Result<(), String> {
        self.systemd.stop(unit, Duration::from_secs(120)).await.map_err(|e| e.to_string())
    }

    async fn restart(&self, unit: &str) -> Result<(), String> {
        self.systemd.restart(unit, self.start_timeout).await.map_err(|e| e.to_string())
    }

    async fn install_units(&self, units: Vec<(String, String)>) -> Result<bool, String> {
        let dir = &self.units_dir;
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut changed = false;
        for (name, text) in &units {
            let path = dir.join(name);
            if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
                let tmp = dir.join(format!(".{name}.tmp"));
                std::fs::write(&tmp, text)
                    .and_then(|_| std::fs::rename(&tmp, &path))
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                changed = true;
            }
        }
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("wad-") && name.ends_with(".container") && !units.iter().any(|(n, _)| *n == name) {
                std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
                changed = true;
            }
        }
        if changed {
            self.systemd.reload().await.map_err(|e| e.to_string())?;
        }
        Ok(changed)
    }

    async fn http_ok(&self, url: &str) -> bool {
        matches!(self.http.get(url).timeout(Duration::from_secs(2)).send().await, Ok(r) if r.status().as_u16() < 500)
    }

    async fn download_size(&self, image: &str) -> Option<(u64, u32)> {
        if self.podman.image_exists(image).await.ok()? {
            return None;
        }
        let sizes = tokio::time::timeout(
            Duration::from_secs(15),
            pull::fetch_layer_sizes(&self.http, image, &pull::auth_files(), None),
        )
        .await
        .ok()??;
        let root = self.podman.graph_root().await.ok().flatten().map(PathBuf::from);
        let local = root.map(|r| pull::local_blob_digests(&r)).unwrap_or_default();
        let total = sizes.iter().filter(|(d, _)| !local.contains(*d)).map(|(_, s)| s).sum();
        Some((total, sizes.len() as u32))
    }

    fn rx_bytes(&self) -> u64 {
        pull::rx_bytes(std::path::Path::new("/sys/class/net"))
    }

    async fn image_labels(&self, image: &str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        self.podman.image_labels(image).await.map_err(|e| e.to_string())
    }

    async fn volume_mountpoint(&self, name: &str) -> Option<String> {
        match self.podman.volume_mountpoint(name).await {
            Ok(m) => m,
            Err(e) => {
                tracing::info!("looking in volume {name}: {e}");
                None
            }
        }
    }

    async fn secret_names(&self) -> Result<Vec<String>, String> {
        self.podman.secret_names().await.map_err(|e| e.to_string())
    }

    async fn podman_info(&self) -> Result<serde_json::Value, String> {
        self.podman.info().await.map_err(|e| e.to_string())
    }

    async fn container_logs(&self, name: &str, lines: usize) -> Result<Option<String>, String> {
        self.podman.container_logs(name, lines).await.map_err(|e| e.to_string())
    }

    async fn create_secret(&self, name: &str, value: &[u8]) -> Result<(), String> {
        self.podman.create_secret(name, value).await.map_err(|e| e.to_string())
    }

    async fn delete_secret(&self, name: &str) -> Result<bool, String> {
        self.podman.delete_secret(name).await.map_err(|e| e.to_string())
    }

    async fn build(&self, context: Vec<u8>, tag: &str, base: &str, mut on_line: OnLine) -> Result<(), String> {
        let mut args = serde_json::Map::new();
        args.insert("BASE_IMAGE".into(), base.into());
        self.podman.build(context, tag, &args, |l| on_line(l)).await.map(drop).map_err(|e| e.to_string())
    }

    async fn github_token(&self) -> Option<String> {
        match self.podman.secret_value("github_token").await {
            Ok(v) => v.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
            Err(e) => {
                tracing::debug!("github_token from podman: {e}");
                None
            }
        }
    }

    async fn workspace_of(&self, container: &str) -> Option<String> {
        let info = self.podman.inspect_container(container).await.ok()??;
        info.pointer("/Config/Labels/wadspaces.id").and_then(|v| v.as_str()).map(String::from)
    }

    async fn free_gb(&self) -> Option<f64> {
        let root = self.podman.graph_root().await.ok().flatten().map(PathBuf::from);
        let path = root.filter(|r| r.is_dir()).unwrap_or_else(|| "/".into());
        let st = nix::sys::statvfs::statvfs(&path).ok()?;
        Some(st.blocks_available() as f64 * st.fragment_size() as f64 / 1e9)
    }
}
