//! wadd's HTTP API, `/v1`, on its Unix socket. JSON in and out; failures are
//! wad_proto's ApiError with a matching status. Every request is checked
//! against the caller's credentials first (access.rs).

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use tokio::net::UnixListener;
use tokio_stream::wrappers::BroadcastStream;
use wad_proto::v1::{
    Browse, Build, BuildLog, BuildRequest, CloudLink, Drive, Event, Health, KeysStatus, Launch, LaunchLog,
    LaunchRequest, LogLine, MachineInfo, Project, ProjectDeleted, ProjectStatus, Run, Session, SessionRequest,
    ViewState, Workspace, WorkspaceState,
};
use wad_proto::{ApiError, ErrorCode};

use crate::access::{Peer, Policy};
use crate::events::Bus;
use crate::logbuf::LogBuffer;
use crate::registry::Registry;
use crate::view::View;

pub struct AppState {
    pub bus: Bus,
    pub registry: Arc<Registry>,
    pub view: Arc<View>,
    pub projects: Arc<crate::projects::Projects>,
    pub launches: Arc<crate::launches::Launches>,
    pub builds: Arc<crate::builds::Builds>,
    pub secrets: Arc<crate::secrets::Secrets>,
    pub github: Arc<crate::github::GithubService>,
    pub network: Arc<crate::network::Network>,
    /// The machine the registry manages (podman), for diagnostics.
    pub registry_backend: Arc<dyn crate::backend::Backend>,
    pub meter: crate::metrics::Meter,
    /// Power off and restart (logind); None without the system bus.
    pub power: Option<wad_systemd::Power>,
    /// The account link; None without cloud settings.
    pub cloud: Option<Arc<crate::cloud::CloudRelay>>,
    /// The keyboard proxy, while it runs.
    pub keys: std::sync::Mutex<Option<wad_input::Proxy>>,
    pub keys_enabled: bool,
    pub logs: LogBuffer,
    pub policy: Policy,
    /// What's on disk (the Python wadd's formats).
    pub store: wad_store::State,
}

/// An ApiError as an HTTP response.
pub struct Failure(pub ApiError);

impl From<ApiError> for Failure {
    fn from(e: ApiError) -> Self {
        Self(e)
    }
}

fn no_workspace(id: &str) -> Failure {
    Failure(ApiError::new(ErrorCode::NotFound, format!("no workspace {id:?}")))
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let status = match self.0.code {
            ErrorCode::BadRequest => StatusCode::BAD_REQUEST,
            ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
            ErrorCode::Forbidden => StatusCode::FORBIDDEN,
            ErrorCode::NotFound => StatusCode::NOT_FOUND,
            ErrorCode::Conflict => StatusCode::CONFLICT,
            ErrorCode::Offline => StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Upstream => StatusCode::BAD_GATEWAY,
            ErrorCode::Timeout => StatusCode::GATEWAY_TIMEOUT,
            ErrorCode::Cancelled => StatusCode::CONFLICT,
            ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self.0)).into_response()
    }
}

impl Connected<axum::serve::IncomingStream<'_, UnixListener>> for Peer {
    fn connect_info(stream: axum::serve::IncomingStream<'_, UnixListener>) -> Self {
        match stream.io().peer_cred() {
            Ok(c) => Peer { uid: c.uid(), gid: c.gid(), pid: c.pid() },
            Err(_) => Peer::UNKNOWN,
        }
    }
}

async fn check_peer(
    State(app): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    req: Request,
    next: Next,
) -> Response {
    if !app.policy.allows(&peer) {
        tracing::warn!(uid = peer.uid, pid = ?peer.pid, path = %req.uri().path(), "refused a caller");
        return Failure(ApiError::new(ErrorCode::Forbidden, "not allowed to use wadd")).into_response();
    }
    next.run(req).await
}

pub fn router(app: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/machine", get(machine))
        .route("/v1/logs", get(logs))
        .route("/v1/events", get(events))
        .route("/v1/workspaces", get(workspaces).post(workspace_create))
        .route("/v1/workspaces/{id}", get(workspace).put(workspace_put).delete(workspace_delete))
        .route("/v1/workspaces/{id}/state", get(workspace_state))
        .route("/v1/workspaces/{id}/start", post(start))
        .route("/v1/workspaces/{id}/stop", post(stop))
        .route("/v1/workspaces/{id}/restart", post(restart))
        .route("/v1/workspaces/{id}/download", post(download))
        .route("/v1/workspaces/{id}/switch", post(switch))
        .route("/v1/states", get(states))
        .route("/v1/view", get(view))
        .route("/v1/view/home", post(home))
        .route("/v1/carousel/{step}", post(carousel))
        .route("/v1/keys", get(keys))
        .route("/v1/projects", get(projects).post(project_create))
        .route("/v1/projects/{id}", get(project).put(project_put).delete(project_delete))
        .route("/v1/projects/{id}/status", get(project_status))
        .route("/v1/drives", get(drives))
        .route("/v1/browse", get(browse))
        .route("/v1/launches", get(launches).post(launch_create))
        .route("/v1/launches/{id}", get(launch).delete(launch_cancel))
        // A design and its wallpaper (base64): more than axum's default 2 MB.
        .route(
            "/v1/builds",
            get(builds).post(build_create).layer(axum::extract::DefaultBodyLimit::max(96 * 1024 * 1024)),
        )
        .route("/v1/builds/{id}", get(build).delete(build_cancel))
        .route("/v1/runs", get(runs))
        .route("/v1/session", get(session).post(session_begin))
        .route("/v1/session", delete(session_end))
        .route("/v1/cloud", get(cloud).delete(cloud_unlink))
        .route("/v1/cloud/link", post(cloud_link))
        .route("/v1/github", get(github).delete(github_sign_out))
        .route("/v1/github/device", post(github_device).delete(github_device_cancel))
        .route("/v1/github/repos", get(github_repos).post(github_repo_create))
        .route("/v1/network", get(network))
        .route("/v1/network/wifi", get(wifi))
        .route("/v1/network/wifi/connect", post(wifi_connect))
        .route("/v1/network/wifi/disconnect", post(wifi_disconnect))
        .route("/v1/network/wifi/forget", post(wifi_forget))
        .route("/v1/power", post(power))
        .route("/v1/secrets", get(secrets))
        .route("/v1/secrets/{name}", axum::routing::put(secret_put).delete(secret_delete))
        .route("/v1/library/{collection}", get(library))
        .route("/v1/library/{collection}/{id}", get(library_get).put(library_put).delete(library_delete))
        .route("/v1/metrics", get(metrics))
        .route("/v1/diagnostics", get(diagnostics))
        .route("/v1/logs/unit/{unit}", get(unit_log))
        .route("/v1/logs/workspace/{id}", get(workspace_log))
        .fallback(|| async { Failure(ApiError::new(ErrorCode::NotFound, "no such endpoint")) })
        .layer(middleware::from_fn_with_state(app.clone(), check_peer))
        .with_state(app)
}

async fn health() -> Json<Health> {
    Json(Health { ok: true, version: env!("CARGO_PKG_VERSION").into() })
}

async fn machine(State(app): State<Arc<AppState>>) -> Json<MachineInfo> {
    Json(app.bus.machine())
}

#[derive(Deserialize)]
struct LogsQuery {
    lines: Option<usize>,
}

async fn logs(State(app): State<Arc<AppState>>, Query(q): Query<LogsQuery>) -> Json<Vec<LogLine>> {
    Json(app.logs.tail(q.lines.unwrap_or(200).clamp(1, 2000)))
}

async fn workspaces(State(app): State<Arc<AppState>>) -> Json<Vec<Workspace>> {
    Json(app.registry.workspaces())
}

async fn workspace(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<Workspace>, Failure> {
    app.registry.workspaces().into_iter().find(|w| w.id == id).map(Json).ok_or_else(|| no_workspace(&id))
}

/// Adds a workspace (refused if one has that id).
async fn workspace_create(
    State(app): State<Arc<AppState>>,
    Json(ws): Json<Workspace>,
) -> Result<(StatusCode, Json<Workspace>), Failure> {
    if app.registry.workspaces().iter().any(|w| w.id == ws.id) {
        return Err(Failure(ApiError::new(ErrorCode::Conflict, format!("workspace {:?} already exists", ws.id))));
    }
    let id = ws.id.clone();
    app.registry.put_workspace(ws).await?;
    Ok((
        StatusCode::CREATED,
        Json(app.registry.workspaces().into_iter().find(|w| w.id == id).ok_or_else(|| no_workspace(&id))?),
    ))
}

/// Replaces a workspace's settings (its projects stay: a launch sets those).
async fn workspace_put(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(mut ws): Json<Workspace>,
) -> Result<Json<wad_proto::v1::WorkspaceSaved>, Failure> {
    if !app.registry.workspaces().iter().any(|w| w.id == id) {
        return Err(no_workspace(&id));
    }
    ws.id = id.clone();
    let restart_required = app.registry.put_workspace(ws).await?;
    let workspace = app.registry.workspaces().into_iter().find(|w| w.id == id).ok_or_else(|| no_workspace(&id))?;
    Ok(Json(wad_proto::v1::WorkspaceSaved { workspace, restart_required }))
}

/// Removes a workspace, stopping it first if it runs.
async fn workspace_delete(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<StatusCode, Failure> {
    if app.registry.state(&id).is_some_and(|s| s.container == "running") {
        app.view.stop(&id).await?;
    }
    app.registry.remove_workspace(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn states(State(app): State<Arc<AppState>>) -> Json<Vec<WorkspaceState>> {
    Json(app.registry.states())
}

fn state_of(app: &AppState, id: &str) -> Result<Json<WorkspaceState>, Failure> {
    app.registry.state(id).map(Json).ok_or_else(|| no_workspace(id))
}

async fn workspace_state(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<WorkspaceState>, Failure> {
    state_of(&app, &id)
}

/// Starts bringing a workspace up; its progress arrives as workspaceState
/// events.
async fn start(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<WorkspaceState>), Failure> {
    app.registry.start(&id)?;
    Ok((StatusCode::ACCEPTED, state_of(&app, &id)?))
}

/// Stops a workspace; if it was on screen, the next session pick (or Wad
/// Creator) is shown.
async fn stop(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<WorkspaceState>, Failure> {
    app.view.stop(&id).await?;
    state_of(&app, &id)
}

async fn restart(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<WorkspaceState>), Failure> {
    app.view.restart(&id).await?;
    Ok((StatusCode::ACCEPTED, state_of(&app, &id)?))
}

/// Downloads a workspace's image in the background (progress as events).
async fn download(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<WorkspaceState>), Failure> {
    let state = state_of(&app, &id)?;
    let registry = app.registry.clone();
    tokio::spawn(async move {
        if let Err(e) = registry.download(&id).await {
            tracing::warn!("download {id}: {}", e.message);
        }
    });
    Ok((StatusCode::ACCEPTED, state))
}

#[derive(Deserialize)]
struct DeletedQuery {
    #[serde(default)]
    deleted: bool,
}

/// ?deleted=true includes tombstones.
async fn projects(State(app): State<Arc<AppState>>, Query(q): Query<DeletedQuery>) -> Json<Vec<Project>> {
    Json(app.projects.list(q.deleted))
}

async fn project(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<Project>, Failure> {
    Ok(Json(app.projects.get(&id)?))
}

async fn project_create(
    State(app): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<(StatusCode, Json<Project>), Failure> {
    let id = wad_store::projects::new_id();
    Ok((StatusCode::CREATED, Json(app.projects.save(&id, &body)?)))
}

async fn project_put(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Project>, Failure> {
    Ok(Json(app.projects.save(&id, &body)?))
}

#[derive(Deserialize)]
struct PurgeQuery {
    #[serde(default)]
    purge: bool,
}

/// Leaves a tombstone (it syncs); ?purge=true also removes the folder.
async fn project_delete(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<PurgeQuery>,
) -> Result<Json<ProjectDeleted>, Failure> {
    Ok(Json(app.projects.delete(&id, q.purge)?))
}

async fn project_status(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ProjectStatus>, Failure> {
    Ok(Json(app.projects.status(&id).await?))
}

fn drive_failure(e: crate::drives::DriveError) -> Failure {
    use crate::drives::DriveError as D;
    let code = match &e {
        D::Missing(_) => ErrorCode::Conflict,
        D::BadId(_) => ErrorCode::BadRequest,
        D::Failed(_) => ErrorCode::Offline,
    };
    Failure(ApiError::new(code, e.to_string()))
}

/// Filesystems a drive project could be on (not the system's own disk).
async fn drives(State(app): State<Arc<AppState>>) -> Result<Json<Vec<Drive>>, Failure> {
    app.projects.drives.list().await.map(Json).map_err(drive_failure)
}

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<String>,
    drive: Option<String>,
}

/// The folders in `path`, inside the folder roots (no path: those roots).
/// With `drive`, `path` is inside that drive (mounted first if need be).
async fn browse(State(app): State<Arc<AppState>>, Query(q): Query<BrowseQuery>) -> Result<Json<Browse>, Failure> {
    use wad_store::folders::{self, FolderError, MAX_DIRS};
    let r = match q.drive.filter(|d| !d.is_empty()) {
        Some(drive) => {
            let mp = app.projects.drives.mount(&drive, "", "").await.map_err(drive_failure)?;
            let path = q.path.unwrap_or_default();
            tokio::task::spawn_blocking(move || folders::browse_inside(&mp, &path, MAX_DIRS)).await
        }
        None => {
            let roots = app.projects.store.folder_roots().to_vec();
            tokio::task::spawn_blocking(move || folders::browse(q.path.as_deref(), &roots, MAX_DIRS)).await
        }
    };
    match r.map_err(|e| Failure(ApiError::new(ErrorCode::Internal, e.to_string())))? {
        Ok(b) => Ok(Json(b)),
        Err(e @ FolderError::Outside(_)) => Err(Failure(ApiError::new(ErrorCode::Forbidden, e.to_string()))),
        Err(e @ FolderError::Missing(_)) => Err(Failure(ApiError::new(ErrorCode::NotFound, e.to_string()))),
    }
}

async fn launches(State(app): State<Arc<AppState>>) -> Json<Vec<Launch>> {
    Json(app.launches.list())
}

/// Opens a workspace with projects; its progress arrives as launch events.
async fn launch_create(
    State(app): State<Arc<AppState>>,
    Json(req): Json<LaunchRequest>,
) -> Result<(StatusCode, Json<Launch>), Failure> {
    Ok((StatusCode::CREATED, Json(app.launches.create(&req.workspace, &req.projects, req.restart)?)))
}

#[derive(Deserialize)]
struct SinceQuery {
    #[serde(default)]
    since: u64,
}

/// A launch, and its log from line `since`.
async fn launch(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<SinceQuery>,
) -> Result<Json<LaunchLog>, Failure> {
    Ok(Json(app.launches.log(&id, q.since)?))
}

async fn builds(State(app): State<Arc<AppState>>) -> Json<Vec<Build>> {
    Json(app.builds.list())
}

/// Builds a design here and adds it as a workspace (or updates the one
/// here); progress arrives as build events.
async fn build_create(
    State(app): State<Arc<AppState>>,
    Json(req): Json<BuildRequest>,
) -> Result<(StatusCode, Json<Build>), Failure> {
    Ok((StatusCode::CREATED, Json(app.builds.create(&req)?)))
}

/// A build, and its log from line `since`.
async fn build(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<SinceQuery>,
) -> Result<Json<BuildLog>, Failure> {
    Ok(Json(app.builds.log(&id, q.since)?))
}

async fn build_cancel(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<Build>, Failure> {
    Ok(Json(app.builds.cancel(&id)?))
}

async fn launch_cancel(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<Launch>, Failure> {
    Ok(Json(app.launches.cancel(&id)?))
}

#[derive(Deserialize)]
struct RunsQuery {
    workspace: Option<String>,
    limit: Option<usize>,
}

async fn runs(State(app): State<Arc<AppState>>, Query(q): Query<RunsQuery>) -> Json<Vec<Run>> {
    Json(app.store.runs(q.workspace.as_deref(), q.limit.unwrap_or(200).clamp(1, 2000)))
}

async fn view(State(app): State<Arc<AppState>>) -> Json<ViewState> {
    Json(app.view.state())
}

/// Shows a workspace: now if it's ready, else once it is.
async fn switch(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<ViewState>, Failure> {
    app.view.switch(&id)?;
    Ok(Json(app.view.state()))
}

/// Wad Creator (refused during a focus session's time).
async fn home(State(app): State<Arc<AppState>>) -> Result<Json<ViewState>, Failure> {
    app.view.home(false)?;
    Ok(Json(app.view.state()))
}

/// The Super+Tab switcher, by hand: next, prev, commit or cancel.
async fn carousel(State(app): State<Arc<AppState>>, Path(step): Path<String>) -> Result<StatusCode, Failure> {
    match step.as_str() {
        "next" => app.view.carousel_step(true),
        "prev" => app.view.carousel_step(false),
        "commit" => app.view.carousel_commit(),
        "cancel" => app.view.carousel_cancel(),
        _ => return Err(Failure(ApiError::new(ErrorCode::NotFound, "next, prev, commit or cancel"))),
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn keys(State(app): State<Arc<AppState>>) -> Json<KeysStatus> {
    let status = app.keys.lock().unwrap().as_ref().map(|k| k.status()).unwrap_or_default();
    Json(KeysStatus {
        enabled: app.keys_enabled,
        grabbing: status.grabbing,
        keyboards: status.keyboards,
        note: status.note,
    })
}

async fn session(State(app): State<Arc<AppState>>) -> Json<Option<Session>> {
    Json(app.view.session())
}

async fn session_begin(
    State(app): State<Arc<AppState>>,
    Json(req): Json<SessionRequest>,
) -> Result<Json<Session>, Failure> {
    Ok(Json(app.view.session_begin(&req.workspaces, req.minutes)?))
}

#[derive(Deserialize)]
struct EndQuery {
    #[serde(default)]
    force: bool,
}

/// Ends the session; during a focus session's time only with ?force=true
/// (the user chose to end it early).
async fn session_end(State(app): State<Arc<AppState>>, Query(q): Query<EndQuery>) -> Result<StatusCode, Failure> {
    app.view.session_end(q.force)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cloud(State(app): State<Arc<AppState>>) -> Json<CloudLink> {
    Json(app.cloud.as_ref().map(|c| c.link_state()).unwrap_or_else(|| app.store.cloud()))
}

fn relay(app: &AppState) -> Result<&Arc<crate::cloud::CloudRelay>, Failure> {
    app.cloud
        .as_ref()
        .ok_or_else(|| Failure(ApiError::new(ErrorCode::Conflict, "this machine has no account settings to link with")))
}

#[derive(Deserialize)]
struct LinkBody {
    code: String,
}

/// Links this machine to the account that made the code.
async fn cloud_link(State(app): State<Arc<AppState>>, Json(b): Json<LinkBody>) -> Result<Json<CloudLink>, Failure> {
    Ok(Json(relay(&app)?.link(&b.code).await?))
}

async fn cloud_unlink(State(app): State<Arc<AppState>>) -> Result<StatusCode, Failure> {
    relay(&app)?.unlink().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn github(State(app): State<Arc<AppState>>) -> Json<wad_proto::github::GithubStatus> {
    Json(app.github.status().await)
}

/// Forgets the GitHub token here (the account keeps its copy).
async fn github_sign_out(State(app): State<Arc<AppState>>) -> Result<StatusCode, Failure> {
    app.github.sign_out().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DeviceBody {
    #[serde(default)]
    account: Option<wad_proto::github::AccountRef>,
}

/// Starts a GitHub device sign-in: the code to show. How it ends arrives
/// as github events (and in GET /v1/github).
async fn github_device(
    State(app): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Json<wad_proto::github::SignIn>, Failure> {
    // The body is optional: {"account": ...} saves the token to that account too.
    let b: DeviceBody = if body.iter().all(u8::is_ascii_whitespace) {
        DeviceBody::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| Failure(ApiError::new(ErrorCode::BadRequest, e.to_string())))?
    };
    Ok(Json(app.github.start(b.account).await?))
}

async fn github_device_cancel(State(app): State<Arc<AppState>>) -> StatusCode {
    app.github.cancel();
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct FreshQuery {
    #[serde(default)]
    fresh: bool,
}

/// The repos the owner can use (from the last minute's unless ?fresh=true).
async fn github_repos(
    State(app): State<Arc<AppState>>,
    Query(q): Query<FreshQuery>,
) -> Result<Json<wad_proto::github::Repos>, Failure> {
    match app.github.repos(q.fresh).await? {
        Some(r) => Ok(Json(r)),
        None => Err(Failure(ApiError::new(
            ErrorCode::Conflict,
            "no GitHub token on this machine (sign in to GitHub first)",
        ))),
    }
}

/// A new repo on GitHub, and a project for it.
async fn github_repo_create(
    State(app): State<Arc<AppState>>,
    Json(req): Json<wad_proto::github::NewRepo>,
) -> Result<(StatusCode, Json<Project>), Failure> {
    Ok((StatusCode::CREATED, Json(app.github.create_repo(&req).await?)))
}

async fn network(State(app): State<Arc<AppState>>) -> Json<wad_proto::v1::NetworkStatus> {
    Json(app.network.status().await)
}

#[derive(Deserialize)]
struct RescanQuery {
    #[serde(default)]
    rescan: bool,
}

/// The networks in range (?rescan=true looks again first).
async fn wifi(
    State(app): State<Arc<AppState>>,
    Query(q): Query<RescanQuery>,
) -> Result<Json<Vec<wad_proto::v1::WifiNetwork>>, Failure> {
    Ok(Json(app.network.wifi(q.rescan).await?))
}

/// Joins a network; the password goes to NetworkManager over D-Bus only.
async fn wifi_connect(
    State(app): State<Arc<AppState>>,
    Json(b): Json<wad_proto::v1::WifiJoin>,
) -> Result<Json<wad_proto::v1::NetworkStatus>, Failure> {
    Ok(Json(app.network.connect(&b.ssid, b.password.as_deref()).await?))
}

async fn wifi_disconnect(State(app): State<Arc<AppState>>) -> Result<Json<wad_proto::v1::NetworkStatus>, Failure> {
    Ok(Json(app.network.disconnect().await?))
}

#[derive(Deserialize)]
struct ForgetBody {
    ssid: String,
}

async fn wifi_forget(State(app): State<Arc<AppState>>, Json(b): Json<ForgetBody>) -> Result<StatusCode, Failure> {
    if app.network.forget(&b.ssid).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(Failure(ApiError::new(ErrorCode::NotFound, format!("no saved network {:?}", b.ssid))))
    }
}

/// Powers the machine off or restarts it.
async fn power(
    State(app): State<Arc<AppState>>,
    Json(b): Json<wad_proto::v1::PowerRequest>,
) -> Result<StatusCode, Failure> {
    let p = app.power.as_ref().ok_or_else(|| Failure(ApiError::new(ErrorCode::Offline, "logind isn't reachable")))?;
    tracing::info!("{:?} asked for", b.action);
    let r = match b.action {
        wad_proto::v1::PowerAction::Poweroff => p.power_off().await,
        wad_proto::v1::PowerAction::Reboot => p.reboot().await,
    };
    r.map_err(|e| Failure(ApiError::new(ErrorCode::Internal, e.to_string())))?;
    Ok(StatusCode::ACCEPTED)
}

/// The secrets' names and where they came from; never their values.
async fn secrets(State(app): State<Arc<AppState>>) -> Result<Json<Vec<wad_proto::v1::SecretInfo>>, Failure> {
    Ok(Json(app.secrets.list().await?))
}

#[derive(Deserialize)]
struct SecretBody {
    value: String,
}

async fn secret_put(
    State(app): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(b): Json<SecretBody>,
) -> Result<StatusCode, Failure> {
    app.secrets.set(&name, b.value.as_bytes()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn secret_delete(State(app): State<Arc<AppState>>, Path(name): Path<String>) -> Result<StatusCode, Failure> {
    if app.secrets.delete(&name).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(Failure(ApiError::new(ErrorCode::NotFound, format!("no secret {name:?}"))))
    }
}

fn lib_failure(e: String) -> Failure {
    Failure(ApiError::new(if e.starts_with("no collection") { ErrorCode::NotFound } else { ErrorCode::BadRequest }, e))
}

async fn library_get(
    State(app): State<Arc<AppState>>,
    Path((collection, id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, Failure> {
    match app.store.library_get(&collection, &id).map_err(lib_failure)? {
        Some(d) => Ok(Json(d)),
        None => Err(Failure(ApiError::new(ErrorCode::NotFound, format!("no {id:?} in {collection}")))),
    }
}

/// Saves one of Wad Creator's documents (opaque to wadd).
async fn library_put(
    State(app): State<Arc<AppState>>,
    Path((collection, id)): Path<(String, String)>,
    Json(doc): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, Failure> {
    app.store.library_put(&collection, &id, &doc).map_err(lib_failure)?;
    Ok(Json(doc))
}

async fn library_delete(
    State(app): State<Arc<AppState>>,
    Path((collection, id)): Path<(String, String)>,
) -> Result<StatusCode, Failure> {
    if app.store.library_delete(&collection, &id).map_err(lib_failure)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(Failure(ApiError::new(ErrorCode::NotFound, format!("no {id:?} in {collection}"))))
    }
}

async fn metrics(State(app): State<Arc<AppState>>) -> Json<wad_proto::v1::Metrics> {
    let root = app
        .registry_backend
        .podman_info()
        .await
        .ok()
        .and_then(|i| i.pointer("/store/graphRoot").and_then(|v| v.as_str()).map(String::from));
    Json(app.meter.snapshot(std::path::Path::new(root.as_deref().unwrap_or("/"))).await)
}

async fn diagnostics(State(app): State<Arc<AppState>>) -> Json<wad_proto::v1::Diagnostics> {
    Json(crate::diagnostics::diagnostics(&app).await)
}

#[derive(Deserialize)]
struct LinesQuery {
    lines: Option<usize>,
}

/// A unit's journal (wadd, greetd, a workspace's), redacted.
async fn unit_log(
    State(app): State<Arc<AppState>>,
    Path(unit): Path<String>,
    Query(q): Query<LinesQuery>,
) -> Result<Json<wad_proto::v1::LogText>, Failure> {
    Ok(Json(crate::diagnostics::unit_log(&app, &unit, q.lines.unwrap_or(200).clamp(1, 2000)).await?))
}

/// A workspace container's output, redacted.
async fn workspace_log(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<LinesQuery>,
) -> Result<Json<wad_proto::v1::LogText>, Failure> {
    Ok(Json(crate::diagnostics::workspace_log(&app, &id, q.lines.unwrap_or(200).clamp(1, 2000)).await?))
}

async fn library(
    State(app): State<Arc<AppState>>,
    Path(collection): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, Failure> {
    app.store
        .library(&collection)
        .map(Json)
        .ok_or_else(|| Failure(ApiError::new(ErrorCode::NotFound, format!("no collection {collection:?}"))))
}

fn sse(e: &Event) -> SseEvent {
    let data = match serde_json::to_value(e) {
        Ok(serde_json::Value::Object(mut o)) => o.remove("data").unwrap_or(serde_json::Value::Null),
        _ => serde_json::Value::Null,
    };
    SseEvent::default().event(e.name()).data(data.to_string())
}

async fn events(State(app): State<Arc<AppState>>) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let (current, rx) = app.bus.subscribe();
    let first = stream::iter(current.into_iter().map(|e| Ok(sse(&e))));
    // A watcher that falls behind skips ahead (it gets the next events).
    let next = BroadcastStream::new(rx).filter_map(|e| async move { e.ok().map(|e| Ok(sse(&e))) });
    Sse::new(first.chain(next)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
