//! Building the Builder's layers on this machine: a template's image FROM
//! the base, a customization's FROM its template's, each from wad-core's
//! build folder (with its web apps' icons made here first, icons.rs: nothing
//! is fetched inside the build). Each image is labelled with the sha of its
//! build folder and the id of the image it was built on, which is how
//! WadSpaces tells a built layer from a changed one. A customization whose
//! template image is missing, or older than the template, builds the
//! template first in the same job. Neither adds a workspace: a wadspace
//! installs on its layer's image (images.rs, with `merged`).
//!
//! One build runs at a time; bases are never downloaded (they reach a
//! machine on the update drive), and a build needs some free disk. Progress
//! goes out as `build` events: the job, plus the log lines since the last
//! event.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use wad_proto::v1::{Build, BuildLog, BuildStatus, Event, LayerBuildRequest, Workspace};
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
use crate::events::Bus;
use crate::icons::{IconJob, Icons};
use crate::joblog::Lines;

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

/// The workspace list with `fresh` added, or merged into the one already
/// there (which keeps its icon, its extra volumes and its projects); checked
/// as a whole. Also: whether it replaced one.
pub fn merged(current: &[Workspace], fresh: &Value) -> Result<(Vec<Workspace>, bool), String> {
    let id = fresh.get("id").and_then(Value::as_str).unwrap_or_default();
    if let Some(app) = current.iter().find(|w| w.id == id && w.kind == wad_proto::v1::Kind::App) {
        return Err(format!("{id:?} is {}, one of this machine's own apps: give the wadspace another id", app.name));
    }
    let mut list: Vec<Value> = current.iter().map(wad_store::workspaces::to_yaml).collect();
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
            // Its sign-ins are the design's: none left means none.
            if fresh.get("signins").is_none() {
                new.as_object_mut().expect("an object").remove("signins");
            }
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
    wad_store::workspaces::check_workspaces(list).map(|l| (l, updated)).map_err(|e| e.to_string())
}

/// The label a layer's image carries: its build folder's sha.
pub const SHA_LABEL: &str = "io.wadspaces.dockerfile-sha256";
/// The id of the image it was built FROM.
pub const FROM_LABEL: &str = "io.wadspaces.from";
/// "template:<id>" or "custom:<id>" (its Dockerfile's own LABEL).
pub const LAYER_LABEL: &str = "io.wadspaces.layer";

/// One layer's image to build.
pub struct LayerStep {
    pub key: String,
    pub name: String,
    pub tag: String,
    /// The image it's built FROM.
    pub from: String,
    pub files: Vec<(String, String)>,
    pub sha: String,
    pub icons: Vec<IconJob>,
    /// A customization's template: built only when its image is missing or
    /// was built from another build folder.
    pub if_needed: bool,
}

fn layer_step(layer: &Value, name: &str, icons: Vec<IconJob>, if_needed: bool) -> LayerStep {
    let files = layer["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| {
            (f["path"].as_str().unwrap_or_default().to_string(), f["content"].as_str().unwrap_or_default().to_string())
        })
        .collect();
    LayerStep {
        key: layer["key"].as_str().unwrap_or_default().into(),
        name: name.into(),
        tag: layer["ref"].as_str().unwrap_or_default().into(),
        from: layer["from"].as_str().unwrap_or_default().into(),
        files,
        sha: layer["sha"].as_str().unwrap_or_default().into(),
        icons,
        if_needed,
    }
}

/// What a layer build makes, in order: the template (if it's a
/// customization's, only when needed), then the customization.
pub fn layer_steps(req: &LayerBuildRequest) -> Result<Vec<LayerStep>, ApiError> {
    let t = &req.template;
    let str_of = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let tid = str_of(t, "id");
    if !wad_core::spec::is_id(&tid) {
        return Err(bad(format!("{tid:?} isn't a template id")));
    }
    let apps = t.get("apps").and_then(Value::as_array).cloned().unwrap_or_default();
    if apps.is_empty() || apps.iter().any(|a| a.as_str().and_then(wad_core::catalog::app).is_none()) {
        return Err(bad(format!("{}: a template's apps are catalog apps, at least one", str_of(t, "name"))));
    }
    let template =
        layer_step(&wad_core::layers::template_layer(t, &serde_json::Value::Null), &str_of(t, "name"), vec![], false);
    match req.layer.split_once(':') {
        Some(("template", id)) if id == tid => Ok(vec![template]),
        Some(("custom", id)) => {
            let c = req.customization.as_ref().ok_or_else(|| bad("a customization's build needs the customization"))?;
            if str_of(c, "id") != id || !wad_core::spec::is_id(id) {
                return Err(bad(format!("{id:?} isn't the customization sent")));
            }
            if str_of(c, "templateId") != tid {
                return Err(bad(format!("{} isn't built on {}", str_of(c, "name"), str_of(t, "name"))));
            }
            let has_browser = apps.iter().any(|a| a == "wadbrowser");
            let icons = icon_jobs(
                &serde_json::json!({ "webapps": if has_browser { c["webapps"].clone() } else { Value::Null } }),
            );
            let custom = layer_step(&wad_core::layers::extensions_layer(c, t), &str_of(c, "name"), icons, false);
            Ok(vec![LayerStep { if_needed: true, ..template }, custom])
        }
        _ => Err(bad(format!("{:?} isn't this template's layer or a customization's", req.layer))),
    }
}

/// A layer's build folder as a tar, with its web apps' icons.
fn layer_context(step: &LayerStep, icons: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut entries: Vec<wad_core::tar::Entry> =
        step.files.iter().map(|(p, c)| wad_core::tar::Entry { path: p, content: c.as_bytes() }).collect();
    let paths: Vec<String> = icons
        .iter()
        .map(|(id, _)| format!("root/usr/share/icons/hicolor/512x512/apps/wadspaces-webapp-{id}.png"))
        .collect();
    for ((_, png), path) in icons.iter().zip(&paths) {
        entries.push(wad_core::tar::Entry { path, content: png });
    }
    let context = wad_core::tar::tar(&entries)?;
    if context.len() > MAX_CONTEXT_BYTES {
        return Err("build folder too big (64 MB max)".into());
    }
    Ok(context)
}

struct Job {
    build: Build,
    log: Lines,
    /// The images to build, in order; taken when it starts.
    work: Option<Vec<LayerStep>>,
    /// Which of how many images is building now (for the progress bar).
    group: u32,
    groups: u32,
}

pub struct Builds {
    me: Weak<Builds>,
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
    pub fn new(backend: Arc<dyn Backend>, bus: Bus, state_dir: &Path, min_free_gb: u64) -> Arc<Self> {
        Self::with_icons(backend, bus, state_dir, min_free_gb, Icons::new(&state_dir.join("webapp-icons")))
    }

    pub fn with_icons(
        backend: Arc<dyn Backend>,
        bus: Bus,
        state_dir: &Path,
        min_free_gb: u64,
        icons: Arc<Icons>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
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

    /// Builds a layer's image (a customization's, its template's first when
    /// needed); it waits its turn behind another build.
    pub fn create_layer(&self, req: &LayerBuildRequest) -> Result<Build, ApiError> {
        let steps = layer_steps(req)?;
        let last = steps.last().expect("a step at least");
        let key = last.key.clone();
        let busy = |j: &Job| j.build.ws_id == key && !j.build.status.finished();
        if self.jobs.lock().unwrap().iter().any(busy) {
            return Err(ApiError::new(ErrorCode::Conflict, format!("{} is already building", last.name)));
        }
        let id = wad_store::projects::new_id()[..12].to_lowercase();
        let build = Build {
            id: id.clone(),
            ws_id: key.clone(),
            name: last.name.clone(),
            status: BuildStatus::Queued,
            progress: 0.0,
            error: None,
            image: last.tag.clone(),
            base_image: steps[0].from.clone(),
            created: now(),
            started: None,
            finished: None,
            updated: false,
            restart_required: false,
            skipped: vec![],
            line_count: 0,
            layer: Some(key),
        };
        let log = Lines::new(&self.log_dir, &id, MAX_LINES);
        let groups = steps.len() as u32;
        self.jobs.lock().unwrap().push(Job { build: build.clone(), log, work: Some(steps), group: 0, groups });
        self.trim();
        self.publish(&id, true);
        let me = self.me.upgrade().expect("builds outlive their calls");
        let task_id = id.clone();
        self.tasks.lock().unwrap().insert(id, tokio::spawn(async move { me.run(task_id).await }));
        Ok(build)
    }

    /// Whether a layer's image is building (or waiting to) now.
    pub fn building(&self, key: &str) -> bool {
        self.jobs.lock().unwrap().iter().any(|j| j.build.ws_id == key && !j.build.status.finished())
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
                // Each image of the job is its share of the bar.
                let done = f64::from(j.group) + f64::from(n - 1) / f64::from(of);
                j.build.progress = j.build.progress.max(done / f64::from(j.groups.max(1)) * 0.95);
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

    /// The build; the last image's tag when it's done.
    async fn go(&self, id: &str) -> Result<String, String> {
        let steps = {
            let mut jobs = self.jobs.lock().unwrap();
            let j = jobs.iter_mut().find(|j| j.build.id == id).ok_or("the build is gone")?;
            j.build.status = BuildStatus::Building;
            j.build.started = Some(now());
            j.work.take().ok_or("the build already ran")?
        };
        self.publish(id, true);
        if let Some(free) = self.backend.free_gb().await
            && free < self.min_free_gb as f64
        {
            return Err(format!("only {free:.1} GB free; building needs at least {} GB", self.min_free_gb));
        }
        self.go_layers(id, steps).await
    }

    /// A layer build: each image in turn (a template only when needed),
    /// labelled with its sha and what it was built on.
    async fn go_layers(&self, id: &str, steps: Vec<LayerStep>) -> Result<String, String> {
        let mut last = String::new();
        for (i, step) in steps.into_iter().enumerate() {
            self.jobs.lock().unwrap().iter_mut().filter(|j| j.build.id == id).for_each(|j| j.group = i as u32);
            if step.if_needed {
                let have = self.backend.image_info(&step.tag).await?;
                if have.is_some_and(|h| h.labels.get(SHA_LABEL).and_then(Value::as_str) == Some(&step.sha)) {
                    self.line(id, &format!("» the {} template is built already", step.name));
                    continue;
                }
                self.line(id, &format!("» Building the {} template first", step.name));
            }
            let Some(from) = self.backend.image_info(&step.from).await? else {
                let hint = if is_local_base(&step.from) && !step.from.contains("-template-") {
                    " — update the drive with host/build.sh update --bases"
                } else {
                    ""
                };
                return Err(format!("{} is not on this machine{hint}", step.from));
            };
            let icons = if step.icons.is_empty() {
                vec![]
            } else {
                let (icons, how) = self.icons.for_build(&step.icons).await;
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
            let context = layer_context(&step, &icons)?;
            let mut labels = serde_json::Map::new();
            labels.insert(SHA_LABEL.into(), step.sha.clone().into());
            labels.insert(FROM_LABEL.into(), from.id.clone().into());
            labels.insert(LAYER_LABEL.into(), step.key.clone().into());
            self.line(id, &format!("» building {} on {}", step.tag, step.from));
            let me = self.me.upgrade().ok_or("wadd is stopping")?;
            let line_id = id.to_string();
            self.backend.build(context, &step.tag, &step.from, labels, Box::new(move |l| me.line(&line_id, l))).await?;
            self.line(id, &format!("✓ built {}", step.tag));
            last = step.tag;
        }
        Ok(last)
    }
}

fn no_build(id: &str) -> ApiError {
    ApiError::new(ErrorCode::NotFound, format!("no build {id:?}"))
}
