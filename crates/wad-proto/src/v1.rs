//! wadd's `/v1` API (the Rust wadd, over /run/wadd/wadd.sock): the types its
//! endpoints and events carry. More arrive with each milestone.

use serde::{Deserialize, Serialize};
use specta::Type;

/// GET /v1/health
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub version: String,
}

/// How wadd runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Profile {
    /// A WadSpaces machine.
    System,
    /// A laptop (`wadd serve --user`).
    User,
}

/// GET /v1/machine
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MachineInfo {
    pub name: String,
    pub version: String,
    pub profile: Profile,
    /// When this wadd started (Unix seconds).
    pub started_at: u64,
}

/// GET /v1/logs: one line of wadd's own log (redacted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Unix milliseconds.
    pub time: u64,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// GET /v1/events: server-sent events, named by `type`, with `data` as JSON.
/// The stream starts with the current state of each kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum Event {
    Machine(MachineInfo),
    /// A workspace's state changed.
    WorkspaceState(WorkspaceState),
    /// What's on screen changed (or what's about to be).
    View(ViewState),
    /// The Super+Tab switcher opened, moved or closed.
    Carousel(Carousel),
    /// A session began, its clock started, its time ran out, or it ended.
    Session(Option<Session>),
    /// Something to tell whoever is watching.
    Notice {
        text: String,
    },
}

impl Event {
    /// The SSE event name.
    pub fn name(&self) -> &'static str {
        match self {
            Event::Machine(_) => "machine",
            Event::WorkspaceState(_) => "workspaceState",
            Event::View(_) => "view",
            Event::Carousel(_) => "carousel",
            Event::Session(_) => "session",
            Event::Notice { .. } => "notice",
        }
    }
}

/// What the machine shows: Wad Creator (the app's own window, "home"), or a
/// workspace.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "id", rename_all = "camelCase")]
pub enum View {
    Home,
    Workspace(String),
}

/// GET /v1/view
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    pub view: View,
    /// A workspace that's coming up and is shown once it's ready (until
    /// then the screen stays where it is).
    pub pending: Option<String>,
    /// There's a compositor to show native workspaces in.
    pub native_display: bool,
}

/// The Super+Tab switcher, most recently used first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Carousel {
    pub open: bool,
    pub items: Vec<CarouselItem>,
    /// The selected item.
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CarouselItem {
    pub view: View,
    pub name: String,
    /// The workspace's icon (a /v1 path), if it has one.
    pub icon: Option<String>,
    pub running: bool,
}

/// POST /v1/session
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub workspaces: Vec<String>,
    /// A focus session's length; none: no timer (a free session).
    pub minutes: Option<u32>,
}

/// GET /v1/keys: the keyboard proxy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeysStatus {
    pub enabled: bool,
    /// The keyboards are grabbed (Super never reaches a workspace), not just watched.
    pub grabbing: bool,
    pub keyboards: Vec<String>,
    pub note: Option<String>,
}

/// How a workspace is shown on its machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Display {
    /// A lean image whose desktop is a window on the machine's own screen.
    Host,
    /// An all-in-one Selkies image, streamed (legacy).
    Stream,
}

/// A project folder a workspace mounts at ~/Desktop/<mount> (set by a launch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MountedProject {
    pub id: String,
    pub mount: String,
    /// A folder or drive project's own path (a git project's is wadd's clone).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// GET /v1/workspaces: a workspace on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub image: String,
    pub display: Display,
    /// The stream's port (streamed workspaces).
    pub port: Option<u16>,
    /// Super+N.
    pub hotkey: Option<u8>,
    pub icon: Option<String>,
    pub enabled: bool,
    /// Started once the machine is up, instead of on first use.
    pub autostart: bool,
    pub container_name: String,
    pub container_port: u16,
    /// In the order the file has them.
    pub env: Vec<(String, String)>,
    pub secrets: Vec<String>,
    pub volumes: Vec<String>,
    pub devices: Vec<String>,
    pub shm_size: Option<String>,
    pub projects: Vec<MountedProject>,
}

/// Where a project's files are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProjectSource {
    /// A GitHub repository, cloned on each machine that opens it.
    Git {
        url: String,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
    },
    /// A directory on one machine.
    Folder { machine_id: String, machine_name: String, path: String },
    /// A filesystem by UUID, on whichever machine it's plugged into.
    Drive { uuid: String, label: String, fstype: String, subpath: String },
}

/// GET /v1/projects
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub mount_name: String,
    /// None for a project from before sources (legacy).
    pub source: Option<ProjectSource>,
    pub setup: String,
    /// A tombstone: deletions sync.
    pub deleted: bool,
    /// Epoch milliseconds.
    pub created_at: i64,
    pub updated_at: i64,
    /// The account has seen it (local bookkeeping).
    pub synced: bool,
    /// Made before projects had sources: opens where its folder is, can't be edited.
    pub legacy: bool,
}

/// GET /v1/runs: when a workspace ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub wadspace_id: String,
    pub wadspace_name: String,
    /// "local" or "stream".
    pub mode: String,
    pub user: String,
    pub projects: Vec<String>,
    /// Unix seconds.
    pub started_at: f64,
    pub ended_at: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionMode {
    /// Locked to its workspaces until the time is up.
    Focus,
    /// No timer.
    Free,
}

/// GET /v1/session: the session in progress, if any.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub mode: SessionMode,
    pub workspaces: Vec<String>,
    pub minutes: Option<u32>,
    /// Unix seconds.
    pub started_at: f64,
    /// When the focus time ends; None until it starts (or with no timer).
    pub ends_at: Option<f64>,
    pub expired: bool,
}

/// GET /v1/cloud: whether (and to whom) this machine is linked. No tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudLink {
    pub linked: bool,
    pub machine_id: Option<String>,
    pub owner_uid: Option<String>,
    pub project_id: Option<String>,
    pub linked_at: Option<String>,
}

/// Where a workspace is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Not running (or unknown); nothing in progress.
    Idle,
    /// Downloading its image.
    Pulling,
    /// Its unit is starting.
    Starting,
    /// Up, waiting for the desktop (its window, or its stream answering).
    Waiting,
    Ready,
    Stopping,
    Error,
}

impl Phase {
    /// Something is in progress.
    pub fn busy(self) -> bool {
        matches!(self, Phase::Pulling | Phase::Starting | Phase::Waiting | Phase::Stopping)
    }
}

/// An image download's progress (bytes measured on the machine's network).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    /// Still to download; None when the registry's sizes aren't known.
    pub total_bytes: Option<u64>,
    pub done_bytes: u64,
    pub layers: u32,
    pub rate_bps: u64,
    pub eta_s: Option<u64>,
    /// Downloaded; podman is unpacking the layers.
    pub unpacking: bool,
}

/// A workspace's state on this machine (GET /v1/states, `workspaceState` events).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub id: String,
    /// The container: running, exited, missing, ... ("unknown": podman didn't say).
    pub container: String,
    pub phase: Phase,
    /// 0..100 while something is in progress, when it can tell.
    pub progress: Option<u8>,
    pub message: Option<String>,
    pub error: Option<String>,
    /// Is its image here? None: unknown.
    pub image_present: Option<bool>,
    pub download: Option<Download>,
    /// When the phase last changed (Unix seconds).
    pub since: f64,
}
