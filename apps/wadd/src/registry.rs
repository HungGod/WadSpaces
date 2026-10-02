//! The workspaces on this machine and their lives: bringing one up (its
//! image, its unit, until its desktop answers), stopping and restarting it,
//! downloading images with progress, and checking every few seconds that
//! what wadd thinks matches what podman says (reconcile).
//!
//! The rules are the Python wadd's (manager.py), kept on purpose: one thing
//! at a time per workspace (its lock), images never pulled for localhost/
//! names, a limit on downloads at once, progress capped at 99% until podman
//! says done, run history opened and closed with the container.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use wad_config::Prefetch;
use wad_proto::v1::{Display, Event, Phase, Workspace, WorkspaceState};
use wad_proto::{ApiError, ErrorCode};
use wad_store::runs::RunLog;

use crate::backend::Backend;
use crate::events::Bus;
use crate::pull::Progress;

/// Pull progress reaches watchers at most this often (a pull's lines come
/// hundreds a second); phase changes always do.
const PUBLISH_EVERY: Duration = Duration::from_millis(700);
const RUNNING: &str = "running";

pub struct Settings {
    pub ready_timeout: Duration,
    pub max_parallel_pulls: usize,
    pub projects_dir: String,
    pub state_dir: PathBuf,
    /// Rootless podman: the uid inside a container the host user maps to.
    pub rootless_uid: Option<u32>,
    /// Between readiness checks.
    pub poll: Duration,
}

pub struct Registry {
    backend: Arc<dyn Backend>,
    bus: Bus,
    settings: Settings,
    workspaces: Mutex<Vec<Workspace>>,
    states: Mutex<HashMap<String, WorkspaceState>>,
    published: Mutex<HashMap<String, Instant>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    pull_slots: Arc<Semaphore>,
    pulls: Mutex<HashMap<String, Progress>>,
    tracking: Mutex<bool>,
    runs: Mutex<RunLog>,
    epoch: Instant,
    /// Itself, for the tasks it starts.
    me: std::sync::Weak<Registry>,
}

fn wall() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn not_found(id: &str) -> ApiError {
    ApiError::new(ErrorCode::NotFound, format!("no workspace {id:?}"))
}

/// A workspace as wad-core's unit renderer takes it (wadd's YAML shape).
pub fn wadd_spec(ws: &Workspace) -> Value {
    let env: serde_json::Map<String, Value> =
        ws.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    let projects: Vec<Value> = ws
        .projects
        .iter()
        .map(|p| match &p.path {
            Some(path) => json!({"id": p.id, "mount": p.mount, "path": path}),
            None => json!({"id": p.id, "mount": p.mount}),
        })
        .collect();
    json!({
        "id": ws.id, "name": ws.name, "image": ws.image,
        "display": if ws.display == Display::Host { "host" } else { "stream" },
        "port": ws.port, "container_name": ws.container_name, "container_port": ws.container_port,
        "env": env, "secrets": ws.secrets, "volumes": ws.volumes, "devices": ws.devices,
        "shm_size": ws.shm_size, "projects": projects,
    })
}

pub fn unit_name(ws: &Workspace) -> String {
    format!("wad-{}.service", ws.id)
}

fn stream_url(ws: &Workspace) -> Option<String> {
    (ws.display == Display::Stream).then(|| ws.port.map(|p| format!("http://127.0.0.1:{p}/"))).flatten()
}

impl Registry {
    pub fn new(backend: Arc<dyn Backend>, bus: Bus, settings: Settings) -> Arc<Self> {
        let runs = RunLog::new(settings.state_dir.join("runs.jsonl"));
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            backend,
            bus,
            pull_slots: Arc::new(Semaphore::new(settings.max_parallel_pulls.max(1))),
            settings,
            workspaces: Mutex::default(),
            states: Mutex::default(),
            published: Mutex::default(),
            locks: Mutex::default(),
            tasks: Mutex::default(),
            pulls: Mutex::default(),
            tracking: Mutex::new(false),
            runs: Mutex::new(runs),
            epoch: Instant::now(),
        })
    }

    /// The unit wadd writes for a workspace.
    pub fn unit_text(&self, ws: &Workspace) -> String {
        wad_core::generator::quadlet(
            &wadd_spec(ws),
            &self.settings.projects_dir,
            &self.settings.state_dir.to_string_lossy(),
            self.settings.rootless_uid,
        )
    }

    /// Takes on a list of workspaces: writes their units (and reloads systemd
    /// if any changed) and starts tracking their state.
    pub async fn load(&self, list: Vec<Workspace>) -> Result<(), String> {
        let units = list.iter().map(|w| (format!("wad-{}.container", w.id), self.unit_text(w))).collect();
        {
            let mut states = self.states.lock().unwrap();
            states.retain(|id, _| list.iter().any(|w| &w.id == id));
            for w in &list {
                states.entry(w.id.clone()).or_insert_with(|| WorkspaceState {
                    id: w.id.clone(),
                    container: "unknown".into(),
                    phase: Phase::Idle,
                    progress: None,
                    message: None,
                    error: None,
                    image_present: None,
                    download: None,
                    since: wall(),
                });
            }
        }
        *self.workspaces.lock().unwrap() = list;
        self.bus.set_states(self.states());
        self.backend.install_units(units).await.map(drop)
    }

    pub fn workspaces(&self) -> Vec<Workspace> {
        self.workspaces.lock().unwrap().clone()
    }

    pub fn states(&self) -> Vec<WorkspaceState> {
        let order = self.workspaces();
        let states = self.states.lock().unwrap();
        order.iter().filter_map(|w| states.get(&w.id).cloned()).collect()
    }

    pub fn state(&self, id: &str) -> Option<WorkspaceState> {
        self.states.lock().unwrap().get(id).cloned()
    }

    fn workspace(&self, id: &str) -> Result<Workspace, ApiError> {
        self.workspaces.lock().unwrap().iter().find(|w| w.id == id && w.enabled).cloned().ok_or_else(|| not_found(id))
    }

    fn lock_for(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().unwrap().entry(id.into()).or_default().clone()
    }

    /// Changes a workspace's state (manager.py _set): a new phase clears the
    /// error, and leaving the busy phases clears progress; a container that
    /// starts or stops opens or closes a run. Progress-only changes are
    /// published at most every PUBLISH_EVERY.
    fn update(&self, ws: &Workspace, f: impl FnOnce(&mut WorkspaceState)) {
        let (state, publish) = {
            let mut states = self.states.lock().unwrap();
            let Some(st) = states.get_mut(&ws.id) else { return };
            let before = st.clone();
            f(st);
            if st.phase != before.phase {
                st.since = wall();
                if st.phase != Phase::Error {
                    st.error = None;
                }
                if !st.phase.busy() {
                    st.progress = None;
                    st.message = None;
                    st.download = None;
                }
            }
            if st.container != before.container {
                self.track_run(ws, &st.container);
            }
            let only_progress = st.phase == before.phase
                && st.container == before.container
                && st.error == before.error
                && st.image_present == before.image_present;
            if *st == before {
                return;
            }
            let now = Instant::now();
            let mut published = self.published.lock().unwrap();
            let due = published.get(&ws.id).is_none_or(|t| now - *t >= PUBLISH_EVERY);
            let publish = !only_progress || due;
            if publish {
                published.insert(ws.id.clone(), now);
            }
            (st.clone(), publish)
        };
        if publish {
            self.bus.publish(Event::WorkspaceState(state));
        }
    }

    /// Run history: a run opens when a container starts and closes when it
    /// stops ("unknown" means podman didn't answer: the run stays open).
    fn track_run(&self, ws: &Workspace, container: &str) {
        let mut runs = self.runs.lock().unwrap();
        let r = if container == RUNNING && !runs.is_open(&ws.id) {
            let mode = if ws.display == Display::Host { "local" } else { "stream" };
            let projects: Vec<String> = ws.projects.iter().map(|p| p.id.clone()).collect();
            runs.start(&ws.id, &ws.name, mode, &projects)
        } else if container != RUNNING && container != "unknown" && runs.is_open(&ws.id) {
            runs.end(&ws.id)
        } else {
            Ok(())
        };
        if let Err(e) = r {
            tracing::debug!("run history {}: {e}", ws.id);
        }
    }

    // ----------------------------------------------------------- bring up
    /// Brings a workspace up in the background (a no-op while it's already coming up).
    pub fn start(self: &Arc<Self>, id: &str) -> Result<(), ApiError> {
        let ws = self.workspace(id)?;
        let mut tasks = self.tasks.lock().unwrap();
        if tasks.get(id).is_some_and(|t| !t.is_finished()) {
            return Ok(());
        }
        let me = self.clone();
        tasks.insert(id.into(), tokio::spawn(async move { me.bring_up(ws).await }));
        Ok(())
    }

    /// Waits for a workspace's bring-up (if one is running).
    pub async fn settled(&self, id: &str) {
        let task = self.tasks.lock().unwrap().remove(id);
        if let Some(t) = task {
            let _ = t.await;
        }
    }

    async fn bring_up(self: Arc<Self>, ws: Workspace) {
        let lock = self.lock_for(&ws.id);
        let _held = lock.lock().await;
        if let Err(e) = self.bring_up_locked(&ws).await {
            tracing::warn!("bringing up {} failed: {e}", ws.id);
            self.update(&ws, |st| {
                st.phase = Phase::Error;
                st.error = Some(e);
            });
        }
    }

    async fn bring_up_locked(&self, ws: &Workspace) -> Result<(), String> {
        self.pull(ws).await?;
        if self.backend.container(&ws.container_name).await.unwrap_or_default() != RUNNING {
            self.update(ws, |st| {
                st.phase = Phase::Starting;
                st.message = Some("starting container".into());
            });
            self.backend.start(&unit_name(ws)).await?;
        }
        self.update(ws, |st| {
            st.phase = Phase::Waiting;
            st.container = RUNNING.into();
            st.message = Some("waiting for the desktop".into());
        });
        // A native workspace is ready when its window appears: that's the
        // display's to say (M3); until then, once it runs.
        if let Some(url) = stream_url(ws) {
            self.wait_http(ws, &url).await?;
        }
        self.update(ws, |st| st.phase = Phase::Ready);
        tracing::info!("{} ready", ws.id);
        Ok(())
    }

    async fn wait_http(&self, ws: &Workspace, url: &str) -> Result<(), String> {
        let deadline = Instant::now() + self.settings.ready_timeout;
        loop {
            if self.backend.http_ok(url).await {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("{} didn't answer within {} s", ws.name, self.settings.ready_timeout.as_secs()));
            }
            tokio::time::sleep(self.settings.poll).await;
        }
    }

    /// Makes sure the image is here. Callers hold the workspace's lock.
    async fn pull(&self, ws: &Workspace) -> Result<(), String> {
        self.update(ws, |st| {
            st.phase = Phase::Pulling;
            st.message = Some("checking image".into());
        });
        if self.backend.image_exists(&ws.image).await? {
            self.update(ws, |st| st.image_present = Some(true));
            return Ok(());
        }
        if ws.image.starts_with("localhost/") {
            return Err(format!("image {} is local-only and not here; build it first", ws.image));
        }
        if self.pull_slots.available_permits() == 0 {
            self.update(ws, |st| st.message = Some("waiting for another download to finish".into()));
        }
        let _slot = self.pull_slots.clone().acquire_owned().await.map_err(|e| e.to_string())?;
        let sized = self.backend.download_size(&ws.image).await;
        if let Some((total, layers)) = sized {
            tracing::info!("pulling {}: {} to download", ws.image, crate::pull::human_bytes(total as f64));
            self.pulls
                .lock()
                .unwrap()
                .insert(ws.id.clone(), Progress::new(Some(total), layers, self.backend.rx_bytes()));
            self.track_pulls();
        }
        let id = ws.id.clone();
        let image = ws.image.clone();
        let result = if sized.is_some() {
            self.backend.pull(&image, Box::new(|_| {})).await
        } else {
            // No sizes: podman's own lines are all there is to show.
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let me = ws.clone();
            let lines = async {
                while let Some(l) = rx.recv().await {
                    self.update(&me, |st| st.message = Some(l.chars().take(80).collect()));
                }
            };
            let pull = self.backend.pull(
                &image,
                Box::new(move |l| {
                    let _ = tx.send(l.to_string());
                }),
            );
            let (r, ()) = tokio::join!(pull, lines);
            r
        };
        let progress = self.pulls.lock().unwrap().remove(&id);
        result?;
        let download = progress.map(|mut p| {
            p.finish();
            p.download()
        });
        self.update(ws, |st| {
            st.image_present = Some(true);
            if let Some(d) = download {
                st.progress = Some(100);
                st.download = Some(d);
                st.message = Some("unpacking".into());
            }
        });
        Ok(())
    }

    /// Every second while there are downloads: the bytes that arrived since,
    /// split between them by how much each still has to fetch.
    fn track_pulls(&self) {
        let mut tracking = self.tracking.lock().unwrap();
        if *tracking {
            return;
        }
        *tracking = true;
        let Some(me) = self.me.upgrade() else { return };
        tokio::spawn(async move {
            let mut last = me.backend.rx_bytes();
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let rx = me.backend.rx_bytes();
                let delta = rx.saturating_sub(last);
                last = rx;
                let now = (Instant::now() - me.epoch).as_secs_f64();
                let updates: Vec<(String, Progress)> = {
                    let mut pulls = me.pulls.lock().unwrap();
                    if pulls.is_empty() {
                        *me.tracking.lock().unwrap() = false;
                        return;
                    }
                    let left: HashMap<String, u64> = pulls
                        .iter()
                        .map(|(id, p)| (id.clone(), p.total_bytes.unwrap_or(0).saturating_sub(p.done_bytes).max(1)))
                        .collect();
                    let weight: u64 = left.values().sum();
                    for (id, p) in pulls.iter_mut() {
                        p.received += (delta as u128 * left[id] as u128 / weight.max(1) as u128) as u64;
                        let at = p.rx_start + p.received;
                        p.sample(at, now);
                    }
                    pulls.iter().map(|(id, p)| (id.clone(), p.clone())).collect()
                };
                for (id, p) in updates {
                    if let Ok(ws) = me.workspace(&id) {
                        me.update(&ws, |st| {
                            st.progress = p.percent();
                            st.download = Some(p.download());
                            st.message = Some(p.describe());
                        });
                    }
                }
            }
        });
    }

    // ------------------------------------------------------- stop, restart
    pub async fn stop(self: &Arc<Self>, id: &str) -> Result<(), ApiError> {
        let ws = self.workspace(id)?;
        if let Some(t) = self.tasks.lock().unwrap().remove(id) {
            t.abort();
        }
        let lock = self.lock_for(id);
        let _held = lock.lock().await;
        self.update(&ws, |st| {
            st.phase = Phase::Stopping;
            st.message = Some("stopping".into());
        });
        match self.backend.stop(&unit_name(&ws)).await {
            Ok(()) => {
                let container = self.backend.container(&ws.container_name).await.unwrap_or_else(|_| "unknown".into());
                self.update(&ws, |st| {
                    st.phase = Phase::Idle;
                    st.container = container;
                });
                Ok(())
            }
            Err(e) => {
                self.update(&ws, |st| {
                    st.phase = Phase::Error;
                    st.error = Some(e.clone());
                });
                Err(ApiError::new(ErrorCode::Internal, e))
            }
        }
    }

    pub async fn restart(self: &Arc<Self>, id: &str) -> Result<(), ApiError> {
        let ws = self.workspace(id)?;
        {
            let lock = self.lock_for(id);
            let _held = lock.lock().await;
            self.update(&ws, |st| {
                st.phase = Phase::Starting;
                st.message = Some("restarting".into());
            });
            if let Err(e) = self.backend.restart(&unit_name(&ws)).await {
                self.update(&ws, |st| {
                    st.phase = Phase::Error;
                    st.error = Some(e.clone());
                });
                return Err(ApiError::new(ErrorCode::Internal, e));
            }
            self.update(&ws, |st| st.phase = Phase::Idle);
        }
        self.start(id)
    }

    /// Downloads a workspace's image without starting it.
    pub async fn download(self: &Arc<Self>, id: &str) -> Result<(), ApiError> {
        let ws = self.workspace(id)?;
        self.settled(id).await;
        if self.state(id).is_some_and(|s| s.container == RUNNING) {
            return Ok(());
        }
        let lock = self.lock_for(id);
        let _held = lock.lock().await;
        let before = self.state(id).map(|s| s.phase).unwrap_or(Phase::Idle);
        match self.pull(&ws).await {
            Ok(()) => {
                self.update(&ws, |st| {
                    st.phase = if before.busy() || before == Phase::Error { Phase::Idle } else { before }
                });
                Ok(())
            }
            Err(e) => {
                self.update(&ws, |st| {
                    st.phase = Phase::Error;
                    st.error = Some(format!("download failed: {e}"));
                });
                Err(ApiError::new(ErrorCode::Upstream, e))
            }
        }
    }

    // ----------------------------------------------------------- reconcile
    /// What podman says now, against what wadd thinks (manager.py refresh):
    /// containers started or stopped elsewhere, images that came or went.
    pub async fn reconcile(&self) {
        let up = self.backend.available().await;
        for ws in self.workspaces().into_iter().filter(|w| w.enabled) {
            let lock = self.lock_for(&ws.id);
            let Ok(_held) = lock.try_lock() else { continue }; // busy: it knows
            let container = if up {
                self.backend.container(&ws.container_name).await.unwrap_or_else(|_| "unknown".into())
            } else {
                "unknown".into()
            };
            let present = if up { self.backend.image_exists(&ws.image).await.ok() } else { None };
            let phase = self.state(&ws.id).map(|s| s.phase).unwrap_or(Phase::Idle);
            let ready = if container == RUNNING && phase == Phase::Idle {
                match stream_url(&ws) {
                    Some(url) => self.backend.http_ok(&url).await,
                    None => true,
                }
            } else {
                false
            };
            self.update(&ws, |st| {
                st.container = container.clone();
                st.image_present = present;
                // WAITING too: a native workspace whose window closed stops its own container.
                if container != RUNNING && matches!(st.phase, Phase::Ready | Phase::Waiting) {
                    st.phase = Phase::Idle;
                } else if ready {
                    st.phase = Phase::Ready;
                }
            });
        }
    }

    // ------------------------------------------------------------ prefetch
    /// Once podman answers (manager.py prefetch_loop): starts the autostart
    /// workspaces and, with Prefetch::All, downloads the other images while
    /// at least `min_free_gb` stays free. Failures are retried every `retry`.
    // TODO(M8): wait for the network first, as the Python wadd did.
    pub async fn prefetch(self: Arc<Self>, mode: Prefetch, min_free_gb: u64, retry: Duration) {
        if mode == Prefetch::None {
            return;
        }
        let mut delay = Duration::from_secs(2);
        while !self.backend.available().await {
            tracing::info!("prefetch: waiting for podman");
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(60));
        }
        let everything = mode == Prefetch::All;
        let mut pending: Vec<Workspace> =
            self.workspaces().into_iter().filter(|w| w.enabled && (w.autostart || everything)).collect();
        pending.sort_by_key(|w| !w.autostart);
        while !pending.is_empty() {
            let mut failed = vec![];
            for ws in pending {
                if self.workspace(&ws.id).is_err() {
                    continue; // removed or disabled meanwhile
                }
                if !ws.autostart && self.backend.free_gb().await.is_some_and(|gb| gb < min_free_gb as f64) {
                    tracing::info!(
                        "prefetch: skipping {}, under {min_free_gb} GB free; it downloads on first use",
                        ws.id
                    );
                    continue;
                }
                let ok = if ws.autostart {
                    self.start(&ws.id).is_ok() && {
                        self.settled(&ws.id).await;
                        self.state(&ws.id).is_some_and(|s| s.phase != Phase::Error)
                    }
                } else {
                    self.download(&ws.id).await.is_ok()
                };
                if !ok {
                    failed.push(ws);
                }
            }
            pending = failed;
            if !pending.is_empty() {
                let ids: Vec<&str> = pending.iter().map(|w| w.id.as_str()).collect();
                tracing::info!("prefetch: retrying {ids:?} in {} s", retry.as_secs());
                tokio::time::sleep(retry).await;
            }
        }
        tracing::info!("prefetch: done");
    }

    /// Reconciles every `every`, for as long as wadd runs.
    pub fn spawn_reconcile(self: &Arc<Self>, every: Duration) -> JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                me.reconcile().await;
                tokio::time::sleep(every).await;
            }
        })
    }
}
