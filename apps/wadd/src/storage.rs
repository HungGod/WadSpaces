//! What WadSpaces takes on this machine's disk (GET /v1/storage): the base
//! image, each layer's image and its own share of it (what it adds to the
//! image under it: layers are shared, so that's what one costs), each
//! wadspace's home (its /config volume), and the files copied in for
//! wadspaces; with the disk's size and what's free. And everything else on
//! the disk, part by part: the system, the copy a stick update left, every
//! other image (older bases, images from before layers, build steps), what
//! older images share, running containers' changes, volumes no wadspace has,
//! logs, wadd's own files, people's files, and what's left over. Counting
//! files takes a moment, so a report is kept for a minute.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;

use serde_json::Value;
use wad_proto::v1::{CopyBytes, DiagDisk, HomeBytes, ImageBytes, LayerBytes, OtherItem, OtherPart, Storage as Report};

use crate::backend::Backend;
use crate::registry::Registry;

const FRESH: Duration = Duration::from_secs(60);

pub struct Storage {
    state: PathBuf,
    copies: PathBuf,
    /// The machine's own wadd (not one on a laptop): the system, the logs
    /// and people's files are its to count.
    machine: bool,
    last: tokio::sync::Mutex<Option<(Instant, Report)>>,
}

/// The copy a stick update leaves (host/build.sh, import-updates).
pub const UPDATE_COPY: &str = "incoming";

impl Storage {
    pub fn new(state_dir: &Path) -> Self {
        Self::with(state_dir, false)
    }

    /// `machine`: the machine's own wadd, which counts the whole disk.
    pub fn with(state_dir: &Path, machine: bool) -> Self {
        Self { state: state_dir.into(), copies: state_dir.join("copies"), machine, last: tokio::sync::Mutex::default() }
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

    /// What changed on the disk (images removed): measured again next time.
    pub async fn forget(&self) {
        *self.last.lock().await = None;
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
        let mut leftovers = Vec::new();
        for (layer, i) in crate::images::leftovers(backend.as_ref()).await.unwrap_or_default() {
            let from = i.labels.get(crate::builds::FROM_LABEL).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let under = match backend.image_info(&from).await {
                Ok(Some(u)) => u.size,
                _ => 0,
            };
            leftovers.push(LayerBytes {
                layer,
                id: i.id,
                from,
                bytes: i.size,
                own_bytes: i.size.saturating_sub(under),
            });
        }
        let df = backend.system_df().await.ok();
        let sizes: Vec<(String, u64)> =
            df.as_ref().map(|d| d.volumes.iter().map(|v| (v.name.clone(), v.size)).collect()).unwrap_or_default();
        let homes: Vec<HomeBytes> = registry
            .workspaces()
            .iter()
            .filter_map(|w| {
                let volume = format!("wad-{}-config", w.id);
                let (_, bytes) = sizes.iter().find(|(name, _)| *name == volume)?;
                Some(HomeBytes { workspace_id: w.id.clone(), volume, bytes: *bytes })
            })
            .collect();
        let copies: Vec<CopyBytes> = std::fs::read_dir(&self.copies)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Some(CopyBytes { id: e.file_name().into_string().ok()?, bytes: dir_bytes(&e.path()) }))
            .collect();
        let disk = disk_of(backend).await;
        let all = backend.images_all().await.unwrap_or_default();
        let mut r = Report { disk, base, layers, leftovers, homes, copies, other: vec![], measured_at: now() };
        r.other = self.other(&r, df.as_ref(), &all).await;
        r
    }

    /// Everything else, part by part.
    async fn other(
        &self,
        r: &Report,
        df: Option<&crate::backend::Df>,
        all: &[crate::backend::ImageInfo],
    ) -> Vec<OtherPart> {
        let mut parts = vec![];
        let part = |key: &str, label: &str, detail: &str, bytes: u64| OtherPart {
            key: key.into(),
            label: label.into(),
            detail: detail.into(),
            bytes,
            items: vec![],
            deletable: false,
        };
        let short = |id: &str| id.trim_start_matches("sha256:").to_string();
        // Folders, counted off the async threads (some hold many files).
        let state = self.state.clone();
        let machine = self.machine;
        let (system, update, wadd, logs, people) = tokio::task::spawn_blocking(move || {
            let update = disk_bytes(&state.join(UPDATE_COPY), &mut HashSet::new());
            let mut seen = HashSet::new();
            let wadd = disk_bytes(&state, &mut seen)
                .saturating_sub(update)
                .saturating_sub(disk_bytes(&state.join("copies"), &mut HashSet::new()));
            let at = |p: &str| if machine { disk_bytes(Path::new(p), &mut HashSet::new()) } else { 0 };
            (at("/sysroot/ostree"), update, wadd, at("/var/log"), at("/var/home"))
        })
        .await
        .unwrap_or_default();
        if system > 0 {
            let versions = std::fs::read_dir("/sysroot/ostree/deploy")
                .into_iter()
                .flatten()
                .flatten()
                .map(|d| {
                    std::fs::read_dir(d.path().join("deploy"))
                        .into_iter()
                        .flatten()
                        .flatten()
                        .filter(|e| e.path().is_dir())
                        .count()
                })
                .sum::<usize>();
            parts.push(part("system", "The WadSpaces system", &format!("The system itself: {versions} version{} kept, this one and the one before it (to go back to). It stays.", if versions == 1 { "" } else { "s" }), system));
        }
        if update > 0 {
            let waiting = self.state.join(UPDATE_COPY).join("pending").exists();
            parts.push(OtherPart {
                deletable: !waiting,
                ..part(
                    "update-copy",
                    "The last stick update's copy",
                    if waiting {
                        "Copied in by a stick update that's waiting to be applied at the next start."
                    } else {
                        "What the last stick update copied in, already applied: nothing needs it."
                    },
                    update,
                )
            });
        }
        // Images: what the layers above don't count, image by image.
        if let Some(df) = df {
            let mut counted: HashSet<String> = r.layers.iter().chain(&r.leftovers).map(|l| short(&l.id)).collect();
            if let Some(b) = &r.base {
                counted.insert(short(&b.id));
            }
            let mut items = vec![];
            for i in df.images.iter().filter(|i| !counted.contains(&short(&i.id))) {
                let info = all.iter().find(|a| short(&a.id) == short(&i.id));
                let (label, detail, deletable) = classify(i, info);
                items.push(OtherItem {
                    id: short(&i.id),
                    label,
                    detail,
                    bytes: i.unique,
                    deletable: deletable && i.containers == 0,
                });
            }
            items.sort_by_key(|i| std::cmp::Reverse(i.bytes));
            let others: u64 = items.iter().map(|i| i.bytes).sum();
            if !items.is_empty() {
                parts.push(OtherPart { items, ..part("images", "Other images", "Images the wadspaces' layers don't count: older bases, images from before layers, steps builds left.", others) });
            }
            let ours = r.base.as_ref().map(|b| b.bytes).unwrap_or(0)
                + r.layers.iter().chain(&r.leftovers).map(|l| l.own_bytes).sum::<u64>();
            let shared = df.images_size.saturating_sub(ours + others);
            if shared > 0 {
                parts.push(part("shared", "Shared by older images", "Image layers older images still hold in common, such as an older base that templates built before the last base update still stand on. Update those templates and it goes.", shared));
            }
            let changes: u64 = df.containers.iter().map(|(_, b)| b).sum();
            if changes > 0 {
                parts.push(part(
                    "containers",
                    "Running wadspaces' changes",
                    "What running wadspaces changed outside their homes since they started: gone when they stop.",
                    changes,
                ));
            }
            let homes: HashSet<&str> = r.homes.iter().map(|h| h.volume.as_str()).collect();
            let mut vols: Vec<OtherItem> = df
                .volumes
                .iter()
                .filter(|v| !homes.contains(v.name.as_str()))
                .map(|v| {
                    let of = v.name.strip_prefix("wad-").and_then(|n| n.strip_suffix("-config"));
                    OtherItem {
                        id: v.name.clone(),
                        label: of.map(|id| format!("{id}'s home")).unwrap_or_else(|| v.name.clone()),
                        detail: if of.is_some() {
                            "A home whose wadspace isn't on this machine any more.".into()
                        } else {
                            "A volume no wadspace here has.".into()
                        },
                        bytes: v.size,
                        deletable: v.links == 0,
                    }
                })
                .collect();
            vols.sort_by_key(|i| std::cmp::Reverse(i.bytes));
            if !vols.is_empty() {
                let bytes = vols.iter().map(|v| v.bytes).sum();
                parts.push(OtherPart { items: vols, ..part("volumes", "Homes left behind", "Files of wadspaces no longer on this machine (built again, a wadspace with the same id gets its home back).", bytes) });
            }
        }
        if logs > 0 {
            parts.push(part("logs", "Logs", "The system's logs (/var/log), kept and trimmed by the system.", logs));
        }
        parts.push(part(
            "wadd",
            "WadSpaces' own files",
            "wadd's records: build and launch logs, web apps' icons, saved sign-ins.",
            wadd,
        ));
        if people > 0 {
            parts.push(part(
                "people",
                "Your files",
                "Your files on the machine (/var/home): WadBrowser's downloads and profiles, the WadSpaces app's data.",
                people,
            ));
        }
        let used = r.disk.total_bytes.saturating_sub(r.disk.free_bytes);
        let listed = df.map(|d| d.images_size).unwrap_or(0)
            + r.homes.iter().map(|h| h.bytes).sum::<u64>()
            + r.copies.iter().map(|c| c.bytes).sum::<u64>()
            + parts.iter().filter(|p| !matches!(p.key.as_str(), "images" | "shared")).map(|p| p.bytes).sum::<u64>();
        let rest = used.saturating_sub(listed);
        if self.machine && rest > 0 {
            parts.push(part(
                "unaccounted",
                "Not listed above",
                "The disk's own bookkeeping, and files outside the folders above.",
                rest,
            ));
        }
        parts
    }
}

/// What an image the layers don't count is, and whether it can go.
fn classify(i: &crate::backend::DfImage, info: Option<&crate::backend::ImageInfo>) -> (String, String, bool) {
    let label = |k: &str| info.and_then(|x| x.labels.get(k)).and_then(Value::as_str).unwrap_or_default().to_string();
    let layer = label(crate::builds::LAYER_LABEL);
    if !layer.is_empty() {
        return (
            format!("An older build of {layer}"),
            "Something here is still built on it: it goes when that's updated or deleted.".into(),
            false,
        );
    }
    if label("build_version").contains("WadSpaces base") || i.name.starts_with("localhost/wadspaces-base") {
        return (
            "An older base".into(),
            "Templates built before the last base update still stand on it: update them, and it can go.".into(),
            true,
        );
    }
    if let Some(name) = i.name.strip_prefix("localhost/wadspaces-") {
        return (
            name.split(':').next().unwrap_or(name).to_string(),
            "From before the Builder's layers: nothing uses it.".into(),
            true,
        );
    }
    if !i.name.is_empty() {
        return (i.name.clone(), "An image podman fetched, to build or run something.".into(), true);
    }
    ("A build step".into(), "Left by a build; nothing names it.".into(), true)
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

/// What the files under `dir` take on the disk (their blocks, a file
/// hard-linked in several places counted once; links not followed).
fn disk_bytes(dir: &Path, seen: &mut HashSet<(u64, u64)>) -> u64 {
    let mut total = 0;
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let Ok(m) = e.path().symlink_metadata() else { continue };
            if m.is_dir() {
                todo.push(e.path());
            } else if m.nlink() <= 1 || seen.insert((m.dev(), m.ino())) {
                total += m.blocks() * 512;
            }
        }
    }
    total
}

/// The bytes of the files under `dir` (links not followed).
pub fn dir_bytes(dir: &Path) -> u64 {
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
