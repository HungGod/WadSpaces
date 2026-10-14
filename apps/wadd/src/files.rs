//! What's saved on the machine's disk outside the images, to look through
//! and tidy (GET/DELETE /v1/files, GET/PUT /v1/files/text): your files on
//! the machine (the kiosk user's home: WadBrowser's downloads, and so on),
//! each wadspace's home (its /config), and the files copied in for
//! wadspaces. Secrets stay out of it: the saved sign-ins, WadBrowser's
//! profiles (signed-in sessions), and the usual places keys and tokens live
//! (.ssh, .gnupg, keyrings, git and cloud credentials) are neither listed
//! nor opened.

use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
use crate::registry::Registry;

/// Text files open up to this size.
pub const MAX_TEXT: u64 = 1 << 20;

/// Names that hold keys or tokens, wherever they are.
const SECRET_NAMES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".password-store",
    ".git-credentials",
    ".netrc",
    ".aws",
    ".kube",
    ".docker",
    ".pki",
    "keyrings",
    "secrets",
];
/// Paths under a home that hold signed-in sessions or credentials.
const SECRET_PATHS: &[&str] =
    &[".local/share/wadbrowser/profiles", ".config/gh", ".config/gcloud", ".local/share/keyrings"];

/// A place to look through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRoot {
    /// "home", "ws:<id>" or "copy:<id>".
    pub id: String,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub dir: bool,
    /// A file's size; a folder's is left out (it'd mean counting it all).
    pub bytes: u64,
    /// Unix seconds.
    pub modified: f64,
    /// Small enough, and text: it opens to read and edit.
    pub text: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub root: String,
    /// Inside the root, "" at its top.
    pub path: String,
    pub entries: Vec<FileEntry>,
}

pub struct Files {
    state_dir: PathBuf,
    signins_dir: PathBuf,
    /// The kiosk user's home on a machine; yours on a laptop.
    home: Option<PathBuf>,
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::BadRequest, msg)
}

fn not_found(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::NotFound, msg)
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(ErrorCode::Internal, e.to_string())
}

impl Files {
    /// `machine`: the machine's own wadd, whose people's files are the kiosk user's (`wad`).
    pub fn new(state_dir: &Path, signins_dir: &Path, machine: bool) -> Self {
        let user = if machine {
            nix::unistd::User::from_name("wad").ok().flatten()
        } else {
            nix::unistd::User::from_uid(nix::unistd::getuid()).ok().flatten()
        };
        Self { state_dir: state_dir.into(), signins_dir: signins_dir.into(), home: user.map(|u| u.dir) }
    }

    /// With `home` as the people's files (tests).
    pub fn with_home(state_dir: &Path, signins_dir: &Path, home: Option<PathBuf>) -> Self {
        Self { state_dir: state_dir.into(), signins_dir: signins_dir.into(), home }
    }

    /// The places, as they are now.
    pub async fn roots(&self, registry: &Registry) -> Vec<FileRoot> {
        let mut out = vec![];
        if self.home.as_ref().is_some_and(|h| h.is_dir()) {
            out.push(FileRoot {
                id: "home".into(),
                label: "Your files".into(),
                detail: "On the machine itself: WadBrowser's downloads, and what else is saved there.".into(),
            });
        }
        for w in registry.workspaces().into_iter().filter(|w| w.kind == wad_proto::v1::Kind::Container) {
            out.push(FileRoot {
                id: format!("ws:{}", w.id),
                label: format!("{}'s home", w.name),
                detail: "Its files (/config inside it): its desktop, projects, downloads, settings.".into(),
            });
        }
        for e in std::fs::read_dir(self.state_dir.join("copies")).into_iter().flatten().flatten() {
            let Some(id) = e.file_name().to_str().map(String::from) else { continue };
            if e.path().join("files").is_dir() {
                out.push(FileRoot {
                    id: format!("copy:{id}"),
                    label: format!("Copied in ({id})"),
                    detail: "Files copied in for wadspaces from this machine.".into(),
                });
            }
        }
        out
    }

    /// Where a root is on the disk.
    async fn root_dir(&self, root: &str, registry: &Registry, backend: &dyn Backend) -> Result<PathBuf, ApiError> {
        let dir = match root.split_once(':') {
            None if root == "home" => self.home.clone(),
            Some(("ws", id)) => {
                let w = registry
                    .workspaces()
                    .into_iter()
                    .find(|w| w.id == id)
                    .ok_or_else(|| not_found(format!("no wadspace {id:?} here")))?;
                backend.volume_mountpoint(&format!("wad-{}-config", w.id)).await.map(PathBuf::from)
            }
            Some(("copy", id)) if wad_core::projects::is_project_id(id) => {
                Some(self.state_dir.join("copies").join(id).join("files"))
            }
            _ => None,
        };
        dir.filter(|d| d.is_dir()).ok_or_else(|| not_found(format!("{root:?} isn't a place here")))
    }

    /// `path` inside the root: plain names only (no "..", no leading "/"),
    /// not a secret, and still inside once links are followed.
    async fn resolve(
        &self,
        root: &str,
        path: &str,
        registry: &Registry,
        backend: &dyn Backend,
    ) -> Result<(PathBuf, PathBuf), ApiError> {
        let base = self.root_dir(root, registry, backend).await?;
        let rel = Path::new(path.trim_start_matches('/'));
        if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err(bad(format!("{path:?} isn't a path inside the place")));
        }
        if self.secret(root, rel) {
            return Err(ApiError::new(ErrorCode::Forbidden, "that's where secrets are kept: it stays out of Files"));
        }
        let full = base.join(rel);
        let real_base = base.canonicalize().map_err(internal)?;
        let real = match full.canonicalize() {
            Ok(r) => r,
            Err(_) => return Err(not_found(format!("no {path:?}"))),
        };
        if !real.starts_with(&real_base) || real.starts_with(&self.signins_dir) {
            return Err(ApiError::new(ErrorCode::Forbidden, "that leads outside the place"));
        }
        Ok((real_base, real))
    }

    fn secret(&self, root: &str, rel: &Path) -> bool {
        if rel.as_os_str().is_empty() {
            return false;
        }
        if rel.components().filter_map(|c| c.as_os_str().to_str()).any(|n| SECRET_NAMES.contains(&n)) {
            return true;
        }
        // The home's (and a wadspace's home's) known places for sessions and credentials.
        (root == "home" || root.starts_with("ws:")) && SECRET_PATHS.iter().any(|p| rel.starts_with(p))
    }

    pub async fn list(
        &self,
        root: &str,
        path: &str,
        registry: &Registry,
        backend: &dyn Backend,
    ) -> Result<FileList, ApiError> {
        let (_, dir) = self.resolve(root, path, registry, backend).await?;
        if !dir.is_dir() {
            return Err(bad(format!("{path:?} is a file")));
        }
        let rel = Path::new(path.trim_start_matches('/'));
        let mut entries: Vec<FileEntry> = std::fs::read_dir(&dir)
            .map_err(internal)?
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                if self.secret(root, &rel.join(&name)) {
                    return None;
                }
                let m = e.path().symlink_metadata().ok()?;
                let dir = m.is_dir();
                let modified = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0);
                Some(FileEntry {
                    text: !dir && m.is_file() && m.len() <= MAX_TEXT && looks_text(&e.path()),
                    name,
                    dir,
                    bytes: if dir { 0 } else { m.len() },
                    modified,
                })
            })
            .collect();
        entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(FileList { root: root.into(), path: rel.to_string_lossy().into_owned(), entries })
    }

    pub async fn read_text(
        &self,
        root: &str,
        path: &str,
        registry: &Registry,
        backend: &dyn Backend,
    ) -> Result<String, ApiError> {
        let (_, file) = self.resolve(root, path, registry, backend).await?;
        let m = file.metadata().map_err(internal)?;
        if !m.is_file() || m.len() > MAX_TEXT {
            return Err(bad("only a text file up to 1 MB opens here"));
        }
        String::from_utf8(std::fs::read(&file).map_err(internal)?).map_err(|_| bad("that isn't text"))
    }

    /// Saves a text file (a new one, or over one), owned as its folder is.
    pub async fn write_text(
        &self,
        root: &str,
        path: &str,
        text: &str,
        registry: &Registry,
        backend: &dyn Backend,
    ) -> Result<(), ApiError> {
        if text.len() as u64 > MAX_TEXT {
            return Err(bad("text files here are 1 MB at most"));
        }
        let rel = Path::new(path.trim_start_matches('/'));
        let name = rel.file_name().ok_or_else(|| bad("a file needs a name"))?;
        let parent = rel.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let (_, dir) = self.resolve(root, &parent, registry, backend).await?;
        if self.secret(root, rel) {
            return Err(ApiError::new(ErrorCode::Forbidden, "that's where secrets are kept: it stays out of Files"));
        }
        let file = dir.join(name);
        if file.symlink_metadata().is_ok_and(|m| !m.is_file()) {
            return Err(bad(format!("{path:?} isn't a file")));
        }
        let owner = dir.metadata().map_err(internal)?;
        let tmp = dir.join(format!(".{}.wadspaces-tmp", name.to_string_lossy()));
        std::fs::write(&tmp, text).map_err(internal)?;
        let _ = std::os::unix::fs::chown(&tmp, Some(owner.uid()), Some(owner.gid()));
        std::fs::rename(&tmp, &file).map_err(internal)
    }

    /// Deletes a file, or a folder and all in it. Not a place's top.
    pub async fn delete(
        &self,
        root: &str,
        path: &str,
        registry: &Registry,
        backend: &dyn Backend,
    ) -> Result<(), ApiError> {
        if path.trim_matches('/').is_empty() {
            return Err(bad("a place itself isn't deleted here"));
        }
        let (_, target) = self.resolve(root, path, registry, backend).await?;
        let m = target.symlink_metadata().map_err(internal)?;
        if m.is_dir() { std::fs::remove_dir_all(&target) } else { std::fs::remove_file(&target) }.map_err(internal)?;
        tracing::info!("files: deleted {root}/{path}");
        Ok(())
    }
}

/// Text by its name, or by its first bytes having no NULs.
fn looks_text(path: &Path) -> bool {
    const TEXT: &[&str] = &[
        "txt", "md", "json", "toml", "yaml", "yml", "ini", "conf", "cfg", "sh", "py", "js", "ts", "tsx", "jsx", "rs",
        "go", "c", "h", "css", "html", "xml", "csv", "log", "env",
    ];
    if path.extension().and_then(|e| e.to_str()).is_some_and(|e| TEXT.contains(&e.to_lowercase().as_str())) {
        return true;
    }
    let mut head = [0u8; 512];
    match std::fs::File::open(path).and_then(|mut f| std::io::Read::read(&mut f, &mut head)) {
        Ok(n) => n > 0 && !head[..n].contains(&0) && std::str::from_utf8(&head[..n]).is_ok(),
        Err(_) => false,
    }
}
