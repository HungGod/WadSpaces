//! Launching a workspace with projects (launches.py): its image, plus the
//! projects' folders on disk.
//!
//! Step 1 does everything that may take a while at once:
//!   - the image: it must be here (a localhost/ image is built, never
//!     pulled; a registry image is downloaded, with its progress), and, when
//!     projects are mounted, labelled io.wadspaces.projects=1. Older images
//!     clone their repos over ~/Desktop at every start and would wreck a
//!     mounted folder, so they're refused.
//!   - each project's folder:
//!     - a GitHub repo, at <projects_dir>/<id>. Already here: fetched, and
//!       fast-forwarded when that's safe, else left as it is with the reason
//!       in the log (not being able to fetch is a warning). Not here: the
//!       copy an older image cloned into the workspace's /config volume
//!       (Desktop/<mount>, maybe with uncommitted work) is moved over, else
//!       it's cloned (a failed clone fails the launch).
//!     - a folder: it must be this machine's, and there. Never touched.
//!     - a drive: plugged in here; mounted if it isn't yet, and the folder on
//!       it must be there. Never touched either.
//!
//! The first failure cancels the rest (a clone in progress stops and leaves
//! nothing behind).
//!
//! Step 2 writes <state_dir>/extra/<ws>/projects.json, points the workspace
//! at the projects (its unit is rewritten) and brings it up as a switch
//! does. A container running with other projects has to stop for that: the
//! caller says so with `restart` (the UI asks first).
//!
//! One launch per workspace at a time; different workspaces launch in
//! parallel. Progress goes out as `launch` events: the job, plus the log
//! lines since the last event.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use wad_git::Update;
use wad_proto::v1::{Event, Launch, LaunchLog, LaunchPart, LaunchStatus, MountedProject, PartState, Phase, Workspace};
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
use crate::events::Bus;
use crate::joblog::Lines;
use crate::projects::{NOT_HERE, Projects, relabel};
use crate::registry::Registry;
use crate::view::View;

const MAX_LINES: usize = 2000;
const PUBLISH_EVERY: Duration = Duration::from_millis(250);
const PROJECTS_LABEL: &str = "io.wadspaces.projects";
/// Of the progress bar; starting the workspace is the rest.
const STEP1_SHARE: f64 = 0.9;
const KEEP_FINISHED: usize = 20;
pub const OLD_BASE: &str = "this image was built on an older base; rebuild it to use projects";

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The named volume a workspace keeps /config in (wad-<id>-config), if any.
pub fn config_volume(volumes: &[String]) -> Option<String> {
    volumes.iter().find_map(|v| {
        let parts: Vec<&str> = v.split(':').collect();
        (parts.len() >= 2 && parts[1].trim_end_matches('/') == "/config" && !parts[0].contains('/'))
            .then(|| parts[0].to_string())
    })
}

fn project_set(projects: &[MountedProject], paths: bool) -> BTreeSet<(String, String, Option<String>)> {
    projects.iter().map(|p| (p.id.clone(), p.mount.clone(), if paths { p.path.clone() } else { None })).collect()
}

fn commits(n: u32) -> &'static str {
    if n == 1 { "commit" } else { "commits" }
}

struct Job {
    launch: Launch,
    log: Lines,
    /// Started, not switched to on the screen: opened in the background
    /// (one of several the UI opens at once).
    background: bool,
}

/// Where else a project is open: the owner's other machines (the cloud
/// relay knows them).
#[async_trait::async_trait]
pub trait Elsewhere: Send + Sync + 'static {
    /// For each project open in a running workspace on another machine
    /// that's on: its id and those machines' names.
    async fn open_elsewhere(&self, pids: &[String]) -> Vec<(String, Vec<String>)>;
}

pub struct Launches {
    me: Weak<Launches>,
    elsewhere: Mutex<Option<Weak<dyn Elsewhere>>>,
    registry: Arc<Registry>,
    view: Arc<View>,
    backend: Arc<dyn Backend>,
    projects: Arc<Projects>,
    bus: Bus,
    log_dir: PathBuf,
    state_dir: PathBuf,
    jobs: Mutex<Vec<Job>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    /// Lines each job's events have carried so far.
    sent: Mutex<HashMap<String, u64>>,
    last_publish: Mutex<Option<Instant>>,
    /// One stop per launch (two projects may both need the workspace stopped).
    stopping: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Launches {
    pub fn new(
        registry: Arc<Registry>,
        view: Arc<View>,
        backend: Arc<dyn Backend>,
        projects: Arc<Projects>,
        bus: Bus,
        state_dir: &Path,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            elsewhere: Mutex::default(),
            registry,
            view,
            backend,
            projects,
            bus,
            log_dir: state_dir.join("launches"),
            state_dir: state_dir.into(),
            jobs: Mutex::default(),
            tasks: Mutex::default(),
            sent: Mutex::default(),
            last_publish: Mutex::default(),
            stopping: Mutex::default(),
        })
    }

    /// Who to ask where else projects are open (the cloud relay).
    pub fn set_elsewhere(&self, e: Weak<dyn Elsewhere>) {
        *self.elsewhere.lock().unwrap() = Some(e);
    }

    // ------------------------------------------------------------- jobs
    /// Checks what can be checked up front, then starts.
    pub fn create(&self, ws_id: &str, project_ids: &[String], restart: bool) -> Result<Launch, ApiError> {
        self.create_as(ws_id, project_ids, restart, false)
    }

    /// `background`: started, not switched to.
    pub fn create_as(
        &self,
        ws_id: &str,
        project_ids: &[String],
        restart: bool,
        background: bool,
    ) -> Result<Launch, ApiError> {
        let ws = self.registry.workspace(ws_id)?;
        let busy = |j: &Job| j.launch.ws_id == ws.id && !j.launch.status.finished();
        if self.jobs.lock().unwrap().iter().any(busy) {
            return Err(ApiError::new(ErrorCode::Conflict, format!("{} is already launching", ws.name)));
        }
        let mut ids: Vec<String> = vec![];
        for p in project_ids {
            if !ids.contains(p) {
                ids.push(p.clone());
            }
        }
        let mut wanted = vec![];
        let mut names = vec![];
        for pid in &ids {
            let doc = self
                .projects
                .store
                .get_or_none(pid)
                .filter(|d| !d.get("deleted").and_then(Value::as_bool).unwrap_or(false));
            let Some(doc) = doc else {
                return Err(ApiError::new(ErrorCode::BadRequest, format!("no project {pid:?}")));
            };
            wanted.push(MountedProject { id: pid.clone(), mount: text(&doc, "mountName"), path: None });
            names.push(text(&doc, "name"));
        }
        let mounts: BTreeSet<&String> = wanted.iter().map(|p| &p.mount).collect();
        if mounts.len() != wanted.len() {
            return Err(ApiError::new(ErrorCode::BadRequest, "two of these projects use the same folder name"));
        }
        // A drive's path is only known once it's mounted: start() checks the paths again.
        let running = self.registry.state(&ws.id).is_some_and(|s| s.container == "running");
        if running && project_set(&ws.projects, false) != project_set(&wanted, false) && !restart {
            return Err(ApiError::new(
                ErrorCode::Conflict,
                format!("{} is running with other projects; pass restart to restart it", ws.name),
            ));
        }
        let mut parts = vec![LaunchPart {
            key: "image".into(),
            kind: "image".into(),
            name: ws.image.clone(),
            state: PartState::Waiting,
            progress: None,
            message: None,
        }];
        for (pid, name) in ids.iter().zip(&names) {
            parts.push(LaunchPart {
                key: pid.clone(),
                kind: "project".into(),
                name: name.clone(),
                state: PartState::Waiting,
                progress: None,
                message: None,
            });
        }
        let id = wad_store::projects::new_id()[..12].to_lowercase();
        let launch = Launch {
            id: id.clone(),
            ws_id: ws.id.clone(),
            name: ws.name.clone(),
            projects: ids,
            restart,
            status: LaunchStatus::Queued,
            progress: 0.0,
            phase: "waiting to start".into(),
            error: None,
            parts,
            created: now(),
            started: None,
            finished: None,
            line_count: 0,
        };
        let log = Lines::new(&self.log_dir, &launch.id, MAX_LINES);
        self.jobs.lock().unwrap().push(Job { launch: launch.clone(), log, background });
        self.trim();
        self.publish(&id, true);
        let me = self.me.upgrade().expect("launches outlive their calls");
        let task_id = id.clone();
        self.tasks.lock().unwrap().insert(id, tokio::spawn(async move { me.run(task_id).await }));
        Ok(launch)
    }

    /// Keeps the last KEEP_FINISHED finished jobs.
    fn trim(&self) {
        let mut jobs = self.jobs.lock().unwrap();
        let finished: Vec<String> =
            jobs.iter().filter(|j| j.launch.status.finished()).map(|j| j.launch.id.clone()).collect();
        let cut = finished.len().saturating_sub(KEEP_FINISHED);
        for id in &finished[..cut] {
            jobs.retain(|j| &j.launch.id != id);
            self.sent.lock().unwrap().remove(id);
        }
    }

    fn launch_of(&self, j: &Job) -> Launch {
        Launch { line_count: j.log.total(), ..j.launch.clone() }
    }

    pub fn list(&self) -> Vec<Launch> {
        let jobs = self.jobs.lock().unwrap();
        jobs.iter().rev().map(|j| self.launch_of(j)).collect()
    }

    pub fn log(&self, id: &str, since: u64) -> Result<LaunchLog, ApiError> {
        let jobs = self.jobs.lock().unwrap();
        let j = jobs.iter().find(|j| j.launch.id == id).ok_or_else(|| no_launch(id))?;
        Ok(LaunchLog { launch: self.launch_of(j), from: since, lines: j.log.since(since) })
    }

    pub fn cancel(&self, id: &str) -> Result<Launch, ApiError> {
        let running = {
            let jobs = self.jobs.lock().unwrap();
            let j = jobs.iter().find(|j| j.launch.id == id).ok_or_else(|| no_launch(id))?;
            !j.launch.status.finished()
        };
        if running {
            // Dropping the work stops a clone in progress, which removes its .part.
            if let Some(t) = self.tasks.lock().unwrap().remove(id) {
                t.abort();
            }
            self.with(id, |l| {
                l.status = LaunchStatus::Cancelled;
                l.finished = Some(now());
            });
            self.stopping.lock().unwrap().remove(id);
            self.line(id, "✗ cancelled");
            self.publish(id, true);
        }
        self.log(id, 0).map(|l| l.launch)
    }

    // ------------------------------------------------------------ output
    fn with<T>(&self, id: &str, f: impl FnOnce(&mut Launch) -> T) -> Option<T> {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.iter_mut().find(|j| j.launch.id == id).map(|j| f(&mut j.launch))
    }

    fn line(&self, id: &str, text: &str) {
        if let Some(j) = self.jobs.lock().unwrap().iter_mut().find(|j| j.launch.id == id) {
            j.log.push(text);
        }
        self.publish(id, false);
    }

    fn part(&self, id: &str, key: &str, state: Option<PartState>, progress: Option<f64>, message: Option<&str>) {
        self.with(id, |l| {
            if let Some(p) = l.parts.iter_mut().find(|p| p.key == key) {
                if let Some(s) = state {
                    p.state = s;
                }
                if progress.is_some() {
                    p.progress = progress;
                }
                if let Some(m) = message {
                    p.message = Some(m.into());
                }
            }
            let done: f64 =
                l.parts.iter().map(|p| p.progress.unwrap_or(if p.state == PartState::Done { 1.0 } else { 0.0 })).sum();
            l.progress = l.progress.max(STEP1_SHARE * done / l.parts.len() as f64);
        });
        self.publish(id, state.is_some());
    }

    /// Events for this job (and any other with lines not sent yet), at most
    /// every PUBLISH_EVERY unless `force`.
    fn publish(&self, id: &str, force: bool) {
        {
            let mut last = self.last_publish.lock().unwrap();
            let now = Instant::now();
            if !force && last.is_some_and(|t| now - t < PUBLISH_EVERY) {
                return;
            }
            *last = Some(now);
        }
        let out: Vec<LaunchLog> = {
            let jobs = self.jobs.lock().unwrap();
            let mut sent = self.sent.lock().unwrap();
            jobs.iter()
                .filter_map(|j| {
                    let from = sent.get(&j.launch.id).copied().unwrap_or(0);
                    if j.launch.id != id && from == j.log.total() {
                        return None;
                    }
                    sent.insert(j.launch.id.clone(), j.log.total());
                    Some(LaunchLog { launch: self.launch_of(j), from, lines: j.log.since(from) })
                })
                .collect()
        };
        for l in out {
            self.bus.publish(Event::Launch(l));
        }
    }

    // ----------------------------------------------------------- running
    async fn run(self: Arc<Self>, id: String) {
        let r = self.go(&id).await;
        match r {
            Ok(name) => {
                self.with(&id, |l| {
                    l.progress = 1.0;
                    l.status = LaunchStatus::Done;
                    l.phase = "running".into();
                });
                self.line(&id, &format!("✓ {name} is up"));
            }
            Err(e) => {
                tracing::warn!("launch {id} failed: {e}");
                self.with(&id, |l| {
                    l.status = LaunchStatus::Error;
                    l.error = Some(e.clone());
                });
                self.line(&id, &format!("✗ {e}"));
            }
        }
        self.with(&id, |l| l.finished = Some(now()));
        self.tasks.lock().unwrap().remove(&id);
        self.stopping.lock().unwrap().remove(&id);
        self.publish(&id, true);
    }

    /// The whole launch; its workspace's name when it's up.
    async fn go(&self, id: &str) -> Result<String, String> {
        let (ws_id, pids) = self
            .with(id, |l| {
                l.status = LaunchStatus::Running;
                l.started = Some(now());
                l.phase = "getting the image and projects".into();
                (l.ws_id.clone(), l.projects.clone())
            })
            .ok_or("the launch is gone")?;
        let ws = self.registry.workspace(&ws_id).map_err(|e| e.message)?;
        let docs: Vec<Value> =
            pids.iter().map(|p| self.projects.store.get(p).map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
        let with = if docs.is_empty() {
            String::new()
        } else {
            format!(" with {}", docs.iter().map(|d| text(d, "name")).collect::<Vec<_>>().join(", "))
        };
        self.line(id, &format!("» launching {}{with}", ws.name));
        // Open on another machine too: two copies edited at once end in git
        // conflicts. A warning, not a refusal.
        let elsewhere = self.elsewhere.lock().unwrap().as_ref().and_then(Weak::upgrade);
        if let Some(e) = elsewhere {
            for (pid, machines) in e.open_elsewhere(&pids).await {
                let mount = docs.iter().find(|d| text(d, "id") == pid).map(|d| text(d, "mountName")).unwrap_or(pid);
                self.line(
                    id,
                    &format!("⚠ {mount} is open on {}: stop it there first to avoid conflicts", machines.join(", ")),
                );
            }
        }
        let paths: Mutex<HashMap<String, String>> = Mutex::default();
        let mut step1: Vec<BoxFuture<'_, Result<(), String>>> = vec![self.image(id, &ws, !docs.is_empty()).boxed()];
        for d in &docs {
            step1.push(self.project(id, &ws, d, &paths).boxed());
        }
        // The first failure drops the rest: no clone carries on for a launch that failed.
        futures_util::future::try_join_all(step1).await?;
        self.with(id, |l| {
            l.progress = l.progress.max(STEP1_SHARE);
            l.phase = "starting".into();
        });
        self.publish(id, true);
        let paths = paths.into_inner().unwrap();
        self.start(id, &ws, &docs, &paths).await?;
        Ok(ws.name)
    }

    async fn image(&self, id: &str, ws: &Workspace, need_label: bool) -> Result<(), String> {
        self.part(id, "image", Some(PartState::Working), None, Some("checking the image"));
        let r = async {
            let mut labels = self.backend.image_labels(&ws.image).await?;
            if labels.is_none() {
                if ws.image.starts_with("localhost/") {
                    return Err(format!("{} isn't on this machine; build {} in WadSpaces first", ws.image, ws.name));
                }
                self.line(id, &format!("downloading {}", ws.image));
                // The download's progress, onto the image's line.
                let me = self.me.upgrade().expect("alive");
                let (jid, wid) = (id.to_string(), ws.id.clone());
                let mirror = tokio::spawn(async move {
                    loop {
                        if let Some(st) = me.registry.state(&wid).filter(|s| s.progress.is_some()) {
                            me.part(
                                &jid,
                                "image",
                                None,
                                st.progress.map(|p| f64::from(p) / 100.0),
                                st.message.as_deref(),
                            );
                        }
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                });
                let r = self.registry.download(&ws.id).await;
                mirror.abort();
                if r.is_err() {
                    let why = self.registry.state(&ws.id).and_then(|s| s.error).unwrap_or_default();
                    return Err(format!("downloading {} failed: {why}", ws.image));
                }
                labels = Some(self.backend.image_labels(&ws.image).await?.unwrap_or_default());
            }
            let labelled = labels.as_ref().and_then(|l| l.get(PROJECTS_LABEL)).and_then(Value::as_str) == Some("1");
            if need_label && !labelled {
                return Err(OLD_BASE.to_string());
            }
            Ok(())
        }
        .await;
        match &r {
            Ok(()) => self.part(id, "image", Some(PartState::Done), Some(1.0), Some("ready")),
            Err(e) => self.part(id, "image", Some(PartState::Error), None, Some(e)),
        }
        r
    }

    async fn project(
        &self,
        id: &str,
        ws: &Workspace,
        doc: &Value,
        paths: &Mutex<HashMap<String, String>>,
    ) -> Result<(), String> {
        let pid = text(doc, "id");
        self.part(id, &pid, Some(PartState::Working), None, Some("checking"));
        let r = self.project_inner(id, ws, doc, paths).await;
        match &r {
            Ok(msg) => self.part(id, &pid, Some(PartState::Done), Some(1.0), Some(msg)),
            Err(e) => self.part(id, &pid, Some(PartState::Error), None, Some(e)),
        }
        r.map(drop)
    }

    /// A project's folder, ready; the message for its line.
    async fn project_inner(
        &self,
        id: &str,
        ws: &Workspace,
        doc: &Value,
        paths: &Mutex<HashMap<String, String>>,
    ) -> Result<String, String> {
        let pid = text(doc, "id");
        let mount = text(doc, "mountName");
        let dest = self.projects.projects_dir.join(&pid);
        let source = doc.get("source").cloned().unwrap_or(Value::Null);
        let kind = text(&source, "kind");
        if kind == "folder" || kind == "drive" {
            let (path, msg) = self.host_folder(id, doc).await?;
            paths.lock().unwrap().insert(pid, path);
            return Ok(msg);
        }
        if dest.is_dir() {
            self.part(id, &pid, None, None, Some("fetching"));
            return Ok(self.update(id, doc, &dest).await);
        }
        std::fs::create_dir_all(&self.projects.projects_dir)
            .map_err(|e| format!("{}: {e}", self.projects.projects_dir.display()))?;
        if let Some(old) = self.old_clone(ws, &mount).await {
            self.stop_for(id, ws, &format!("to move {mount} out of it")).await?;
            self.part(id, &pid, None, None, Some(&format!("moving the copy in {} over", ws.name)));
            move_dir(&old, &dest).await?;
            let d = dest.clone();
            let _ = tokio::task::spawn_blocking(move || relabel(&d, true)).await;
            self.line(
                id,
                &format!("{mount}: moved the copy {} had in ~/Desktop (changes kept) to {}", ws.name, dest.display()),
            );
        } else if kind == "git" && !text(&source, "url").is_empty() {
            self.clone(id, doc, &dest).await?;
        } else {
            return Err(format!("{}: {NOT_HERE}", text(doc, "name")));
        }
        Ok("on this machine".into())
    }

    /// A folder or drive project: (its path here, its line's message).
    async fn host_folder(&self, id: &str, doc: &Value) -> Result<(String, String), String> {
        let src = &doc["source"];
        let (name, mount) = (text(doc, "name"), text(doc, "mountName"));
        if text(src, "kind") == "folder" {
            if !self.projects.folder_here(src) {
                let on =
                    Some(text(src, "machineName")).filter(|n| !n.is_empty()).unwrap_or_else(|| text(src, "machineId"));
                return Err(format!("{name} is a folder on {on}"));
            }
            let path = wad_store::folders::resolve_folder(&text(src, "path"), self.projects.store.folder_roots(), true)
                .map_err(|e| format!("{name}: {e}"))?;
            if !Path::new(&path).is_dir() {
                return Err(format!("folder {} is missing", text(src, "path")));
            }
            self.line(id, &format!("{mount}: the folder {path}"));
            return Ok((path, "folder on this machine".into()));
        }
        let label = Some(text(src, "label")).filter(|l| !l.is_empty()).unwrap_or_else(|| text(src, "uuid"));
        self.part(id, &text(doc, "id"), None, None, Some(&format!("looking for the drive {label}")));
        let mountpoint = self
            .projects
            .drives
            .mount(&text(src, "uuid"), &label, &text(src, "fstype"))
            .await
            .map_err(|e| e.to_string())?;
        let sub = text(src, "subpath");
        let path =
            crate::drives::folder_on(&mountpoint, &sub).ok_or_else(|| format!("{name}: {sub} is outside the drive"))?;
        if !path.is_dir() {
            let shown = if sub.is_empty() { "/" } else { sub.as_str() };
            return Err(format!("folder {shown} is missing on {label}"));
        }
        let path = path.to_string_lossy().into_owned();
        self.line(id, &format!("{mount}: {path} on the drive {label}"));
        Ok((path, format!("on the drive {label}")))
    }

    /// Brings a copy that's here up to date when that's safe; the log says
    /// what happened and why. Returns its line's message.
    async fn update(&self, id: &str, doc: &Value, dest: &Path) -> String {
        let mount = text(doc, "mountName");
        let github = wad_store::projects::check_source(&doc["source"])
            .is_ok_and(|s| matches!(s, wad_proto::v1::ProjectSource::Git { .. }));
        let token = if github { self.backend.github_token().await } else { None };
        let up = self.projects.git.update(dest, token.as_deref(), self.projects.uid).await;
        let (line, message) = match &up {
            Update::Updated(n) => {
                (format!("{mount}: updated ({n} new {})", commits(*n)), format!("updated ({n} new {})", commits(*n)))
            }
            Update::Current => (format!("{mount} is up to date"), "up to date".into()),
            Update::Dirty => {
                (format!("{mount} has uncommitted changes; not updated"), "uncommitted changes — left as is".into())
            }
            Update::Ahead(n) => (
                format!("{mount} has {n} unpushed {}; not updated", commits(*n)),
                format!("{n} unpushed {} — left as is", commits(*n)),
            ),
            Update::NoUpstream => {
                (format!("{mount} has no upstream branch; not updated"), "no upstream branch — left as is".into())
            }
            Update::NotGit => {
                (format!("{mount} is not a git repository; not updated"), "not a git repo — left as is".into())
            }
            Update::Offline(e) => {
                (format!("⚠ {mount}: couldn't fetch ({e}); not updated"), "couldn't fetch — left as is".into())
            }
            Update::Stuck(e) => (
                format!("⚠ {mount}: couldn't fast-forward ({e}); not updated"),
                "couldn't fast-forward — left as is".into(),
            ),
        };
        self.line(id, &line);
        message
    }

    async fn clone(&self, id: &str, doc: &Value, dest: &Path) -> Result<(), String> {
        let (pid, mount) = (text(doc, "id"), text(doc, "mountName"));
        let src = &doc["source"];
        let (url, git_ref) = (text(src, "url"), src.get("ref").and_then(Value::as_str).map(String::from));
        let token = if wad_git::is_github(&url) { self.backend.github_token().await } else { None };
        let at = git_ref.as_ref().map(|r| format!(" ({r})")).unwrap_or_default();
        self.line(id, &format!("{mount}: cloning {url}{at}"));
        self.part(id, &pid, None, Some(0.0), Some("cloning"));
        let mut on_line = |t: &str, fraction: Option<f64>| match fraction {
            None => self.line(id, &format!("  {t}")),
            Some(f) => {
                self.part(id, &pid, None, Some(f), Some(t));
                if f >= 1.0 && t.contains("done") {
                    self.line(id, &format!("  {t}"));
                }
            }
        };
        self.projects
            .git
            .clone_repo(&url, git_ref.as_deref(), dest, token.as_deref(), &mut on_line, self.projects.uid)
            .await
    }

    /// Desktop/<mount> in the workspace's /config volume, if it has files:
    /// what an image from before projects cloned there.
    async fn old_clone(&self, ws: &Workspace, mount: &str) -> Option<PathBuf> {
        let vol = config_volume(&ws.volumes)?;
        let src = PathBuf::from(self.backend.volume_mountpoint(&vol).await?).join("Desktop").join(mount);
        let is_dir = std::fs::symlink_metadata(&src).is_ok_and(|m| m.is_dir());
        let has_files = std::fs::read_dir(&src).is_ok_and(|mut d| d.next().is_some());
        (is_dir && has_files).then_some(src)
    }

    /// Stops the workspace (once per launch) when it's running.
    async fn stop_for(&self, id: &str, ws: &Workspace, why: &str) -> Result<(), String> {
        let lock = self.stopping.lock().unwrap().entry(id.into()).or_default().clone();
        let _one = lock.lock().await;
        if self.registry.state(&ws.id).is_none_or(|s| s.container != "running") {
            return Ok(());
        }
        if !self.with(id, |l| l.restart).unwrap_or(false) {
            return Err(format!("{} is running; pass restart to stop it {why}", ws.name));
        }
        self.line(id, &format!("stopping {} {why}", ws.name));
        self.view.stop(&ws.id).await.map_err(|e| e.message)
    }

    async fn start(
        &self,
        id: &str,
        ws: &Workspace,
        docs: &[Value],
        paths: &HashMap<String, String>,
    ) -> Result<(), String> {
        let wanted: Vec<MountedProject> = docs
            .iter()
            .map(|d| MountedProject {
                id: text(d, "id"),
                mount: text(d, "mountName"),
                path: paths.get(&text(d, "id")).cloned(),
            })
            .collect();
        if !wanted.is_empty() {
            let entries: Vec<(String, String, String, String)> =
                docs.iter().map(|d| (text(d, "id"), text(d, "name"), text(d, "mountName"), text(d, "setup"))).collect();
            let manifest: Vec<wad_store::projects::ManifestEntry> = entries
                .iter()
                .map(|(i, n, m, s)| wad_store::projects::ManifestEntry { id: i, name: n, mount: m, setup: s })
                .collect();
            wad_store::projects::write_manifest(&self.state_dir, &ws.id, &manifest)
                .map_err(|e| format!("projects.json: {e}"))?;
        }
        if project_set(&ws.projects, true) != project_set(&wanted, true) {
            self.stop_for(id, ws, "to change its projects").await?;
            self.registry.set_projects(&ws.id, wanted.clone()).await?;
            let mounts: Vec<&str> = wanted.iter().map(|p| p.mount.as_str()).collect();
            let what = if mounts.is_empty() { "no projects".to_string() } else { mounts.join(", ") };
            self.line(id, &format!("{} now mounts {what}", ws.name));
        }
        let background = self.jobs.lock().unwrap().iter().any(|j| j.launch.id == id && j.background);
        if background {
            self.line(id, &format!("starting {} in the background", ws.name));
            self.registry.start(&ws.id).map_err(|e| e.message)?;
        } else {
            self.line(id, &format!("starting {}", ws.name));
            self.view.switch(&ws.id).map_err(|e| e.message)?;
        }
        self.registry.settled(&ws.id).await;
        match self.registry.state(&ws.id) {
            Some(st) if st.phase == Phase::Error => {
                Err(st.error.unwrap_or_else(|| format!("{} didn't start", ws.name)))
            }
            _ => Ok(()),
        }
    }
}

fn no_launch(id: &str) -> ApiError {
    ApiError::new(ErrorCode::NotFound, format!("no launch {id:?}"))
}

/// rename, or (across filesystems) mv.
async fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc_exdev()) => {
            let out = tokio::process::Command::new("mv")
                .arg("--")
                .arg(from)
                .arg(to)
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(())
            } else {
                Err(format!("moving {}: {}", from.display(), String::from_utf8_lossy(&out.stderr).trim()))
            }
        }
        Err(e) => Err(format!("moving {}: {e}", from.display())),
    }
}

fn libc_exdev() -> i32 {
    nix::errno::Errno::EXDEV as i32
}
