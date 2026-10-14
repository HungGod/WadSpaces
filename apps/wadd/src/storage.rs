//! What WadSpaces takes on this machine's disk (GET /v1/storage): the base
//! image, each layer's image and its own share of it (what it adds to the
//! image under it: layers are shared, so that's what one costs), each
//! wadspace's home (its /config volume), and the files copied in for
//! wadspaces; with the disk's size and what's free. Counting files takes a
//! moment, so a report is kept for a minute.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use wad_proto::v1::{CopyBytes, DiagDisk, HomeBytes, ImageBytes, LayerBytes, Storage as Report};

use crate::backend::Backend;
use crate::registry::Registry;

const FRESH: Duration = Duration::from_secs(60);

pub struct Storage {
    copies: PathBuf,
    last: tokio::sync::Mutex<Option<(Instant, Report)>>,
}

impl Storage {
    pub fn new(state_dir: &Path) -> Self {
        Self { copies: state_dir.join("copies"), last: tokio::sync::Mutex::default() }
    }

    /// The report: the last one if it's under a minute old (`fresh` measures again).
    pub async fn report(&self, backend: &Arc<dyn Backend>, registry: &Registry, fresh: bool) -> Report {
        let mut last = self.last.lock().await;
        if !fresh
            && let Some((at, r)) = last.as_ref()
            && at.elapsed() < FRESH
        {
            return r.clone();
        }
        let r = self.measure(backend, registry).await;
        *last = Some((Instant::now(), r.clone()));
        r
    }

    async fn measure(&self, backend: &Arc<dyn Backend>, registry: &Registry) -> Report {
        let base_ref = wad_core::spec::DEFAULT_BASE_IMAGE;
        let base = match backend.image_info(base_ref).await {
            Ok(Some(i)) => Some(ImageBytes { image_ref: base_ref.into(), id: i.id, bytes: i.size }),
            _ => None,
        };
        let mut layers = Vec::new();
        for row in
            crate::images::list(backend.as_ref()).await.unwrap_or_default().into_iter().filter(|r| r.layer != "base")
        {
            let Ok(Some(me)) = backend.image_info(&row.image_ref).await else { continue };
            // What it adds to the image it's built on (that one as it was then).
            let under = match backend.image_info(&row.from).await {
                Ok(Some(u)) => u.size,
                _ => 0,
            };
            layers.push(LayerBytes {
                layer: row.layer,
                id: me.id,
                from: row.from,
                bytes: me.size,
                own_bytes: me.size.saturating_sub(under),
            });
        }
        let sizes = backend.volume_sizes().await.unwrap_or_default();
        let homes = registry
            .workspaces()
            .iter()
            .filter_map(|w| {
                let volume = format!("wad-{}-config", w.id);
                let (_, bytes) = sizes.iter().find(|(name, _)| *name == volume)?;
                Some(HomeBytes { workspace_id: w.id.clone(), volume, bytes: *bytes })
            })
            .collect();
        let copies = std::fs::read_dir(&self.copies)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Some(CopyBytes { id: e.file_name().into_string().ok()?, bytes: dir_bytes(&e.path()) }))
            .collect();
        let disk = disk_of(backend).await;
        Report { disk, base, layers, homes, copies, measured_at: now() }
    }
}

/// The disk podman keeps its images on (else /).
async fn disk_of(backend: &Arc<dyn Backend>) -> DiagDisk {
    let root = backend
        .podman_info()
        .await
        .ok()
        .and_then(|i| i.pointer("/store/graphRoot").and_then(|v| v.as_str()).map(String::from))
        .filter(|p| Path::new(p).is_dir())
        .unwrap_or_else(|| "/".into());
    let (free, total) = match nix::sys::statvfs::statvfs(root.as_str()) {
        Ok(s) => (s.blocks_available() * s.fragment_size(), s.blocks() * s.fragment_size()),
        Err(_) => (0, 0),
    };
    DiagDisk { path: root, free_bytes: free, total_bytes: total }
}

/// The bytes of the files under `dir` (links not followed).
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            match e.file_type() {
                Ok(t) if t.is_dir() => todo.push(e.path()),
                Ok(t) if t.is_file() => total += e.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    total
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}
