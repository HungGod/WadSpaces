//! Building a design's image on this machine (builds.py, with the build
//! folder made here): Wad Creator sends the design and its wallpaper (the
//! app draws it); wad-core turns that into the build folder (Dockerfile,
//! root/), with its web apps' icons made here first (icons.rs: nothing is
//! fetched inside the build), which podman builds as
//! localhost/wadspaces-<id>:latest on the design's base. The workspace is then added, or the one already here
//! updated: it keeps its own icon, extra volumes and projects, and takes the
//! design's settings for the rest.
//!
//! The merged workspace list is checked as a whole before anything is built
//! (ids, ports, hotkeys), and again when it's installed. One build runs at a
//! time; bases are never downloaded (they reach a machine on the update
//! drive), and a build needs some free disk. Progress goes out as `build`
//! events: the job, plus the log lines since the last event.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use wad_core::generator::Content;
use wad_proto::v1::{Build, BuildLog, BuildRequest, BuildStatus, Event, Skipped, Workspace};
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
use crate::events::Bus;
use crate::icons::{IconJob, Icons};
use crate::joblog::Lines;
use crate::registry::Registry;

pub const MAX_CONTEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_LINES: usize = 4000;
const PUBLISH_EVERY: Duration = Duration::from_millis(250);
const KEEP_FINISHED: usize = 20;

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::BadRequest, msg)
}

/// localhost/wadspaces-<name>:<tag>: one of the bases the update drive brings.
pub fn is_local_base(image: &str) -> bool {
    let Some(rest) = image.strip_prefix("localhost/wadspaces-") else { return false };
    let Some((name, tag)) = rest.split_once(':') else { return false };
    !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !tag.is_empty()
        && tag.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// "STEP 3/7: RUN ..." -> (3, 7)
fn step(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("STEP ")?;
    let (frac, _) = rest.split_once(':')?;
    let (a, b) = frac.split_once('/')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

/// What a design makes: its build spec (the build folder's makings), the
/// workspace entry (workspaces.yaml's shape), what it left out, and the
/// icons its web apps need.
pub struct Made {
    pub spec: Value,
    wallpaper: Option<Vec<u8>>,
    dockerfile: Option<String>,
    pub workspace: Value,
    pub base_image: String,
    pub skipped: Vec<Skipped>,
    pub icons: Vec<IconJob>,
}

impl Made {
    /// The build folder as a tar, with the web apps' icons (PNG, by app id).
    pub fn context(&self, icons: &[(String, Vec<u8>)]) -> Result<Vec<u8>, ApiError> {
        let files =
            wad_core::generator::bundle_files(&self.spec, self.wallpaper.as_deref(), self.dockerfile.as_deref(), icons);
        let entries: Vec<wad_core::tar::Entry> = files
            .iter()
            .map(|(path, c)| wad_core::tar::Entry {
                path,
                content: match c {
                    Content::Text(t) => t.as_bytes(),
                    Content::Bytes(b) => b,
                },
            })
            .collect();
        let context = wad_core::tar::tar(&entries).map_err(bad)?;
        if context.len() > MAX_CONTEXT_BYTES {
            return Err(bad("build folder too big (64 MB max)"));
        }
        Ok(context)
    }
}

/// The icons a spec's web apps need: their sites, and the user's pictures.
fn icon_jobs(spec: &Value) -> Vec<IconJob> {
    spec["webapps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| {
            let id = w["id"].as_str().filter(|i| wad_core::spec::is_id(i))?;
            let site = w["url"].as_str()?;
            Some(IconJob {
                id: id.to_string(),
                site: site.to_string(),
                custom: w["iconUrl"].as_str().map(String::from),
            })
        })
        .collect()
}

/// The build folder and workspace entry for a design (the app's
/// buildRequest, done here).
pub fn make(req: &BuildRequest) -> Result<Made, ApiError> {
    if !req.design.is_object() {
        return Err(bad("the design is a JSON object"));
    }
    let wallpaper = match &req.wallpaper {
        Some(w) => Some((
            w.file_name.clone(),
            base64::engine::general_purpose::STANDARD.decode(&w.data).map_err(|e| bad(format!("wallpaper: {e}")))?,
        )),
        None => None,
    };
    let opts = json!({
        "wallpaperFile": wallpaper.as_ref().map(|(n, _)| n.clone()),
        "projects": req.projects,
    });
    let built = wad_core::build::to_build_spec(&req.design, &opts);
    let spec = &built["spec"];
    let problems = wad_core::spec::validate(spec);
    if !problems.is_empty() {
        return Err(bad(problems.join(" ")));
    }
    let skipped = built["skipped"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| Skipped {
            label: s.get("label").and_then(Value::as_str).unwrap_or_default().into(),
            reason: s.get("reason").and_then(Value::as_str).unwrap_or_default().into(),
        })
        .collect();
    let base_image = spec.get("baseImage").and_then(Value::as_str).unwrap_or_default().to_string();
    if !is_local_base(&base_image) && !base_image.contains('/') {
        return Err(bad(format!("bad base image {base_image:?}")));
    }
    let dockerfile =
        req.design.get("dockerfile").and_then(Value::as_str).filter(|d| !d.trim().is_empty()).map(String::from);
    let mut workspace = wad_core::spec::to_wadd_spec(spec);
    let id = workspace.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    workspace["image"] = format!("localhost/wadspaces-{id}:latest").into();
    let made = Made {
        icons: icon_jobs(spec),
        spec: spec.clone(),
        wallpaper: wallpaper.map(|(_, b)| b),
        dockerfile,
        workspace,
        base_image,
        skipped,
    };
    // Too big already without its icons: say so now, not when it runs.
    made.context(&[])?;
    Ok(made)
}

/// The workspace list with `fresh` added, or merged into the one already
/// there (which keeps its icon, its extra volumes and its projects); checked
/// as a whole. Also: whether it replaced one.
pub fn merged(current: &[Workspace], fresh: &Value) -> Result<(Vec<Workspace>, bool), String> {
    let id = fresh.get("id").and_then(Value::as_str).unwrap_or_default();
    let mut list: Vec<Value> = current.iter().map(wad_store::legacy::to_yaml).collect();
    let updated = match list.iter_mut().find(|w| w["id"] == id) {
        Some(old) => {
            let mut new = old.clone();
            for (k, v) in fresh.as_object().into_iter().flatten() {
                new[k] = v.clone();
            }
            let mut volumes: Vec<Value> = old["volumes"].as_array().cloned().unwrap_or_default();
            for v in fresh["volumes"].as_array().into_iter().flatten() {
                if !volumes.contains(v) {
                    volumes.push(v.clone());
                }
            }
            new["volumes"] = volumes.into();
            new["icon"] = old.get("icon").cloned().unwrap_or(Value::Null);
            new["projects"] = old["projects"].clone();
            if new["icon"].is_null() {
                new.as_object_mut().expect("an object").remove("icon");
            }
            *old = new;
            true
        }
        None => {
            list.push(fresh.clone());
            false
        }
    };
    wad_store::legacy::check_workspaces(list).map(|l| (l, updated)).map_err(|e| e.to_string())
}

struct Job {
    build: Build,
    log: Lines,
    /// Taken when it starts.
    made: Option<Made>,
    workspace: Value,
}

pub struct Builds {
    me: Weak<Builds>,
    registry: Arc<Registry>,
    backend: Arc<dyn Backend>,
    bus: Bus,
    icons: Arc<Icons>,
    log_dir: PathBuf,
    min_free_gb: u64,
    jobs: Mutex<Vec<Job>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    sent: Mutex<HashMap<String, u64>>,
    last_publish: Mutex<Option<Instant>>,
    one_at_a_time: tokio::sync::Mutex<()>,
}

impl Builds {
    pub fn new(
        registry: Arc<Registry>,
        backend: Arc<dyn Backend>,
        bus: Bus,
        state_dir: &Path,
        min_free_gb: u64,
    ) -> Arc<Self> {
        Self::with_icons(registry, backend, bus, state_dir, min_free_gb, Icons::new(&state_dir.join("webapp-icons")))
    }

    pub fn with_icons(
        registry: Arc<Registry>,
        backend: Arc<dyn Backend>,
        bus: Bus,
        state_dir: &Path,
        min_free_gb: u64,
        icons: Arc<Icons>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            registry,
            backend,
            bus,
            icons,
            log_dir: state_dir.join("builds"),
            min_free_gb,
            jobs: Mutex::default(),
            tasks: Mutex::default(),
            sent: Mutex::default(),
            last_publish: Mutex::default(),
            one_at_a_time: tokio::sync::Mutex::new(()),
        })
    }

    /// Web apps' icons (the API's prefetch and preview use them too).
    pub fn icons(&self) -> Arc<Icons> {
        self.icons.clone()
    }

    /// Makes the build folder and checks the workspace it would add, then
    /// starts (it waits its turn behind another build).
    pub fn create(&self, req: &BuildRequest) -> Result<Build, ApiError> {
        let made = make(req)?;
        let ws_id = made.workspace["id"].as_str().unwrap_or_default().to_string();
        let busy = |j: &Job| j.build.ws_id == ws_id && !j.build.status.finished();
        if self.jobs.lock().unwrap().iter().any(busy) {
            return Err(ApiError::new(ErrorCode::Conflict, format!("{ws_id} is already building")));
        }
        let (_, updated) = merged(&self.registry.workspaces(), &made.workspace).map_err(bad)?;
        let id = wad_store::projects::new_id()[..12].to_lowercase();
        let build = Build {
            id: id.clone(),
            ws_id: ws_id.clone(),
            name: made.workspace["name"].as_str().unwrap_or(&ws_id).to_string(),
            status: BuildStatus::Queued,
            progress: 0.0,
            error: None,
            image: made.workspace["image"].as_str().unwrap_or_default().to_string(),
            base_image: made.base_image.clone(),
            created: now(),
            started: None,
            finished: None,
            updated,
            restart_required: false,
            skipped: made.skipped.clone(),
            line_count: 0,
        };
        let mut log = Lines::new(&self.log_dir, &id, MAX_LINES);
        for s in &build.skipped {
            log.push(&format!("⚠ left out {}: {}", s.label, s.reason));
        }
        let workspace = made.workspace.clone();
        let job = Job { build: build.clone(), log, made: Some(made), workspace };
        self.jobs.lock().unwrap().push(job);
        self.trim();
        self.publish(&id, true);
        let me = self.me.upgrade().expect("builds outlive their calls");
        let task_id = id.clone();
        self.tasks.lock().unwrap().insert(id, tokio::spawn(async move { me.run(task_id).await }));
        Ok(build)
    }

    /// Keeps the last KEEP_FINISHED finished jobs.
    fn trim(&self) {
        let mut jobs = self.jobs.lock().unwrap();
        let finished: Vec<String> =
            jobs.iter().filter(|j| j.build.status.finished()).map(|j| j.build.id.clone()).collect();
        let cut = finished.len().saturating_sub(KEEP_FINISHED);
        for id in &finished[..cut] {
            jobs.retain(|j| &j.build.id != id);
            self.sent.lock().unwrap().remove(id);
        }
    }

    fn build_of(j: &Job) -> Build {
        Build { line_count: j.log.total(), ..j.build.clone() }
    }

    pub fn list(&self) -> Vec<Build> {
        self.jobs.lock().unwrap().iter().rev().map(Self::build_of).collect()
    }

    pub fn log(&self, id: &str, since: u64) -> Result<BuildLog, ApiError> {
        let jobs = self.jobs.lock().unwrap();
        let j = jobs.iter().find(|j| j.build.id == id).ok_or_else(|| no_build(id))?;
        Ok(BuildLog { build: Self::build_of(j), from: since, lines: j.log.since(since) })
    }

    pub fn cancel(&self, id: &str) -> Result<Build, ApiError> {
        let running = !self.log(id, 0)?.build.status.finished();
        if running {
            // Dropping the build closes podman's stream, which stops it.
            if let Some(t) = self.tasks.lock().unwrap().remove(id) {
                t.abort();
            }
            self.with(id, |b| {
                b.status = BuildStatus::Cancelled;
                b.finished = Some(now());
            });
            self.line(id, "✗ cancelled");
            self.publish(id, true);
        }
        self.log(id, 0).map(|l| l.build)
    }

    // ------------------------------------------------------------ output
    fn with<T>(&self, id: &str, f: impl FnOnce(&mut Build) -> T) -> Option<T> {
        self.jobs.lock().unwrap().iter_mut().find(|j| j.build.id == id).map(|j| f(&mut j.build))
    }

    fn line(&self, id: &str, text: &str) {
        if let Some(j) = self.jobs.lock().unwrap().iter_mut().find(|j| j.build.id == id) {
            j.log.push(text);
            if let Some((n, of)) = step(text).filter(|(_, of)| *of > 0) {
                j.build.progress = j.build.progress.max(f64::from(n - 1) / f64::from(of) * 0.95);
            }
        }
        self.publish(id, false);
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
        let out: Vec<BuildLog> = {
            let jobs = self.jobs.lock().unwrap();
            let mut sent = self.sent.lock().unwrap();
            jobs.iter()
                .filter_map(|j| {
                    let from = sent.get(&j.build.id).copied().unwrap_or(0);
                    if j.build.id != id && from == j.log.total() {
                        return None;
                    }
                    sent.insert(j.build.id.clone(), j.log.total());
                    Some(BuildLog { build: Self::build_of(j), from, lines: j.log.since(from) })
                })
                .collect()
        };
        for l in out {
            self.bus.publish(Event::Build(l));
        }
    }

    // ----------------------------------------------------------- running
    async fn run(self: Arc<Self>, id: String) {
        let r = {
            let _turn = self.one_at_a_time.lock().await;
            self.go(&id).await
        };
        match r {
            Ok(tag) => {
                self.with(&id, |b| {
                    b.progress = 1.0;
                    b.status = BuildStatus::Done;
                });
                self.line(&id, &format!("✓ built {tag}"));
            }
            Err(e) => {
                tracing::warn!("build {id} failed: {e}");
                self.with(&id, |b| {
                    b.status = BuildStatus::Error;
                    b.error = Some(e.clone());
                });
                self.line(&id, &format!("✗ {e}"));
            }
        }
        self.with(&id, |b| b.finished = Some(now()));
        self.tasks.lock().unwrap().remove(&id);
        self.publish(&id, true);
    }

    /// The build and its install; the image's tag when it's done.
    async fn go(&self, id: &str) -> Result<String, String> {
        let (made, workspace, tag, base) = {
            let mut jobs = self.jobs.lock().unwrap();
            let j = jobs.iter_mut().find(|j| j.build.id == id).ok_or("the build is gone")?;
            j.build.status = BuildStatus::Building;
            j.build.started = Some(now());
            (
                j.made.take().ok_or("the build already ran")?,
                j.workspace.clone(),
                j.build.image.clone(),
                j.build.base_image.clone(),
            )
        };
        self.publish(id, true);
        if let Some(free) = self.backend.free_gb().await
            && free < self.min_free_gb as f64
        {
            return Err(format!("only {free:.1} GB free; building needs at least {} GB", self.min_free_gb));
        }
        // Bases aren't downloaded: they come on the update drive.
        if !self.backend.image_exists(&base).await? {
            let hint =
                if is_local_base(&base) { " — update the drive with host/build.sh update --bases" } else { "" };
            return Err(format!("base image {base} is not on this machine{hint}"));
        }
        let icons = if made.icons.is_empty() {
            vec![]
        } else {
            let (icons, how) = self.icons.for_build(&made.icons).await;
            self.line(
                id,
                &format!(
                    "» icons for {} web apps: {} from their sites, {} chosen, {} with their names",
                    icons.len(),
                    how.site,
                    how.custom,
                    how.fallback
                ),
            );
            icons
        };
        let context = made.context(&icons).map_err(|e| e.message)?;
        self.line(id, &format!("» building {tag} on {base}"));
        let me = self.me.upgrade().ok_or("wadd is stopping")?;
        let line_id = id.to_string();
        self.backend.build(context, &tag, &base, Box::new(move |l| me.line(&line_id, l))).await?;
        // Install: the list may have changed while it built, so merge again.
        let ws_id = workspace["id"].as_str().unwrap_or_default().to_string();
        let (list, updated) = merged(&self.registry.workspaces(), &workspace)?;
        self.registry.set_workspaces(list).await?;
        self.registry.image_here(&ws_id);
        // The image changed under the same name: a running container has the
        // old one until it restarts.
        let running = self.registry.state(&ws_id).is_some_and(|s| s.container == "running");
        self.with(id, |b| {
            b.updated = updated;
            b.restart_required = updated && running;
        });
        let what = if updated { "updated" } else { "added" };
        self.line(id, &format!("{what} the workspace {ws_id}"));
        Ok(tag)
    }
}

fn no_build(id: &str) -> ApiError {
    ApiError::new(ErrorCode::NotFound, format!("no build {id:?}"))
}
