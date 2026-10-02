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
    CloudLink, Event, Health, KeysStatus, LogLine, MachineInfo, Project, Run, Session, SessionRequest, ViewState,
    Workspace, WorkspaceState,
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
        .route("/v1/workspaces", get(workspaces))
        .route("/v1/workspaces/{id}", get(workspace))
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
        .route("/v1/projects", get(projects))
        .route("/v1/runs", get(runs))
        .route("/v1/session", get(session).post(session_begin))
        .route("/v1/session", delete(session_end))
        .route("/v1/cloud", get(cloud))
        .route("/v1/library/{collection}", get(library))
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

async fn projects(State(app): State<Arc<AppState>>) -> Json<Vec<Project>> {
    Json(app.store.projects())
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
    Json(app.store.cloud())
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
