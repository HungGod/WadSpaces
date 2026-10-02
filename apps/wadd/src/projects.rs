//! Projects on this machine: the store (wad-store's ProjectStore), where
//! each one's folder is, and whether a launch can have it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use wad_git::Update;
use wad_proto::v1::{Event, GitStatus, Project, ProjectDeleted, ProjectStatus};
use wad_proto::{ApiError, ErrorCode};
use wad_store::projects::{LOCAL, ProjectError, ProjectStore};
use wad_store::state::project_of;

use crate::drives::{self, Drives};
use crate::events::Bus;
use crate::registry::Registry;

pub const NOT_HERE: &str = "not a GitHub repo and not on this machine";

impl From<ProjectError> for crate::api::Failure {
    fn from(e: ProjectError) -> Self {
        crate::api::Failure(api_error(e))
    }
}

pub fn api_error(e: ProjectError) -> ApiError {
    let code = match &e {
        ProjectError::Invalid(_) => ErrorCode::BadRequest,
        ProjectError::Conflict(_) => ErrorCode::Conflict,
        ProjectError::NotFound(_) => ErrorCode::NotFound,
        ProjectError::Io(_) => ErrorCode::Internal,
    };
    ApiError::new(code, e.to_string())
}

/// The git a launch and the status call use (wad-git's; tests stand in).
#[async_trait]
pub trait ProjectGit: Send + Sync + 'static {
    async fn clone_repo(
        &self,
        url: &str,
        git_ref: Option<&str>,
        dest: &Path,
        token: Option<&str>,
        on_line: &mut (dyn for<'s> FnMut(&'s str, Option<f64>) + Send),
        uid: u32,
    ) -> Result<(), String>;
    async fn update(&self, path: &Path, token: Option<&str>, uid: u32) -> Update;
    async fn status(&self, path: &Path, uid: u32) -> Option<GitStatus>;
}

#[async_trait]
impl ProjectGit for wad_git::Git {
    async fn clone_repo(
        &self,
        url: &str,
        git_ref: Option<&str>,
        dest: &Path,
        token: Option<&str>,
        on_line: &mut (dyn for<'s> FnMut(&'s str, Option<f64>) + Send),
        uid: u32,
    ) -> Result<(), String> {
        wad_git::Git::clone_repo(
            self,
            url,
            git_ref,
            dest,
            token,
            |t: &str, f: Option<f64>| on_line(t, f),
            Some(uid),
            |p| make_owned_dir(p, uid),
        )
        .await
        .map_err(|e| e.to_string())
    }

    async fn update(&self, path: &Path, token: Option<&str>, uid: u32) -> Update {
        wad_git::Git::update(self, path, token, Some(uid), wad_git::FETCH_TIMEOUT).await
    }

    async fn status(&self, path: &Path, uid: u32) -> Option<GitStatus> {
        wad_git::Git::status(self, path, Some(uid)).await
    }
}

/// Best effort: SELinux's container_file_t on a folder, so containers can use
/// it (files made in it afterwards inherit it). Quiet without SELinux.
pub fn relabel(path: &Path, recursive: bool) {
    if !Path::new("/sys/fs/selinux/enforce").exists() {
        return;
    }
    let mut cmd = std::process::Command::new("chcon");
    if recursive {
        cmd.arg("-R");
    }
    match cmd.args(["-t", "container_file_t"]).arg(path).output() {
        Ok(o) if o.status.success() => {}
        Ok(o) => tracing::warn!(
            "labelling {} for containers failed: {}",
            path.display(),
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => tracing::debug!("labelling {} for containers: {e}", path.display()),
    }
}

/// A folder for the projects user: theirs when wadd is root (on a laptop
/// wadd is that user already), and labelled for containers.
pub fn make_owned_dir(path: &Path, uid: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::create_dir_all(path);
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    if nix::unistd::geteuid().is_root() {
        let _ = nix::unistd::chown(path, Some(uid.into()), Some(uid.into()));
    }
    relabel(path, false);
}

/// (id, name) of this machine for folder projects: its linked id, or
/// "local" until it's linked.
pub type MachineRef = Arc<dyn Fn() -> (String, String) + Send + Sync>;

pub struct Projects {
    pub store: ProjectStore,
    pub drives: Arc<Drives>,
    pub git: Arc<dyn ProjectGit>,
    registry: Arc<Registry>,
    bus: Bus,
    pub projects_dir: PathBuf,
    pub uid: u32,
    machine: MachineRef,
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

impl Projects {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        state_dir: &Path,
        projects_dir: PathBuf,
        folder_roots: Vec<PathBuf>,
        uid: u32,
        machine: MachineRef,
        drives: Arc<Drives>,
        git: Arc<dyn ProjectGit>,
        registry: Arc<Registry>,
        bus: Bus,
    ) -> Self {
        let m = machine.clone();
        let store = ProjectStore::new(state_dir.join("projects"), folder_roots, move || m());
        Self { store, drives, git, registry, bus, projects_dir, uid, machine }
    }

    fn publish(&self, ids: Vec<String>) {
        self.bus.publish(Event::Projects { ids });
    }

    pub fn list(&self, deleted: bool) -> Vec<Project> {
        self.store.list(deleted).iter().map(|d| project_of(&text(d, "id"), d)).collect()
    }

    pub fn get(&self, pid: &str) -> Result<Project, ApiError> {
        self.store.get(pid).map(|d| project_of(pid, &d)).map_err(api_error)
    }

    pub fn save(&self, pid: &str, body: &Value) -> Result<Project, ApiError> {
        let doc = self.store.put(pid, body).map_err(api_error)?;
        self.publish(vec![pid.into()]);
        Ok(project_of(pid, &doc))
    }

    /// Whether a folder project's folder is this machine's.
    pub fn folder_here(&self, source: &Value) -> bool {
        let (mid, _) = (self.machine)();
        let theirs = source.get("machineId").and_then(Value::as_str);
        theirs == Some(mid.as_str()) || (mid == LOCAL && theirs == Some(LOCAL))
    }

    /// Workspaces whose unit mounts it.
    pub fn mounted_in(&self, pid: &str) -> Vec<String> {
        self.registry
            .workspaces()
            .into_iter()
            .filter(|w| w.projects.iter().any(|p| p.id == pid))
            .map(|w| w.id)
            .collect()
    }

    /// Where its folder is, whether a launch can have it, who mounts it, and
    /// its git state from the refs here. No fetch and no mounting: quick.
    pub async fn status(&self, pid: &str) -> Result<ProjectStatus, ApiError> {
        let doc = self.store.get(pid).map_err(api_error)?;
        let src = doc.get("source").cloned().unwrap_or(Value::Null);
        let mut reason = None;
        let mut path: Option<PathBuf> = Some(self.projects_dir.join(pid));
        match src.get("kind").and_then(Value::as_str) {
            Some("folder") => {
                let p = text(&src, "path");
                if !self.folder_here(&src) {
                    let on = Some(text(&src, "machineName"))
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| text(&src, "machineId"));
                    path = None;
                    reason = Some(format!("on {on}"));
                } else {
                    if !Path::new(&p).is_dir() {
                        reason = Some(format!("folder {p} is missing"));
                    }
                    path = Some(p.into());
                }
            }
            Some("drive") => {
                let label = Some(text(&src, "label")).filter(|l| !l.is_empty()).unwrap_or_else(|| text(&src, "uuid"));
                let sub = text(&src, "subpath");
                let (drive, mp) = match self.drives.locate(&text(&src, "uuid")).await {
                    Ok(x) => x,
                    Err(e) => {
                        reason = Some(e.to_string());
                        (None, None)
                    }
                };
                path = mp.and_then(|m| drives::folder_on(&m, &sub));
                if drive.is_none() {
                    reason = reason.or(Some(format!("plug in the drive {label}")));
                } else if path.as_ref().is_some_and(|p| !p.is_dir()) {
                    reason = Some(format!("folder {sub} is missing on {label}"));
                }
            }
            _ if wad_store::projects::is_legacy(&doc) && !path.as_ref().is_some_and(|p| p.is_dir()) => {
                reason = Some(NOT_HERE.into())
            }
            _ => {}
        }
        let here = path.as_ref().is_some_and(|p| p.is_dir());
        let git = match (&path, here) {
            (Some(p), true) => self.git.status(p, self.uid).await,
            _ => None,
        };
        Ok(ProjectStatus {
            exists_on_disk: here,
            path: path.map(|p| p.to_string_lossy().into_owned()),
            mounted_in: self.mounted_in(pid),
            git,
            available: reason.is_none(),
            reason,
        })
    }

    /// Tombstones a project; with `purge`, removes its folder too, unless a
    /// workspace still mounts it.
    pub fn delete(&self, pid: &str, purge: bool) -> Result<ProjectDeleted, ApiError> {
        self.store.get(pid).map_err(api_error)?;
        let users = self.mounted_in(pid);
        if purge && !users.is_empty() {
            let them = if users.len() == 1 { "it" } else { "them" };
            return Err(ApiError::new(
                ErrorCode::Conflict,
                format!("still mounted in {}; launch {them} without this project first", users.join(", ")),
            ));
        }
        let doc = self.store.delete(pid).map_err(api_error)?;
        let purged = purge && wad_store::projects::purge_dir(&self.projects_dir, pid).map_err(api_error)?;
        self.publish(vec![pid.into()]);
        Ok(ProjectDeleted { project: project_of(pid, &doc), purged })
    }
}
