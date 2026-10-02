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
use axum::routing::get;
use axum::{Json, Router};
use futures_util::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use tokio::net::UnixListener;
use tokio_stream::wrappers::BroadcastStream;
use wad_proto::v1::{CloudLink, Event, Health, LogLine, MachineInfo, Project, Run, Session, Workspace};
use wad_proto::{ApiError, ErrorCode};

use crate::access::{Peer, Policy};
use crate::events::Bus;
use crate::logbuf::LogBuffer;

pub struct AppState {
    pub bus: Bus,
    pub logs: LogBuffer,
    pub policy: Policy,
    /// What's on disk (the Python wadd's formats).
    pub store: wad_store::State,
    /// The Python wadd's workspaces.yaml, and the image's cloud.yaml.
    pub legacy_config: std::path::PathBuf,
    pub vendor_cloud: std::path::PathBuf,
}

impl AppState {
    fn workspaces(&self) -> Result<Vec<Workspace>, Failure> {
        wad_store::legacy::read(&self.legacy_config, Some(&self.vendor_cloud))
            .map(|c| c.workspaces)
            .map_err(|e| Failure(ApiError::new(ErrorCode::Internal, e.to_string())))
    }
}

/// An ApiError as an HTTP response.
pub struct Failure(pub ApiError);

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
        .route("/v1/projects", get(projects))
        .route("/v1/runs", get(runs))
        .route("/v1/session", get(session))
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

async fn workspaces(State(app): State<Arc<AppState>>) -> Result<Json<Vec<Workspace>>, Failure> {
    app.workspaces().map(Json)
}

async fn workspace(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<Workspace>, Failure> {
    app.workspaces()?
        .into_iter()
        .find(|w| w.id == id)
        .map(Json)
        .ok_or_else(|| Failure(ApiError::new(ErrorCode::NotFound, format!("no workspace {id:?}"))))
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

async fn session(State(app): State<Arc<AppState>>) -> Json<Option<Session>> {
    let known: Vec<String> = app.workspaces().map(|ws| ws.into_iter().map(|w| w.id).collect()).unwrap_or_default();
    Json(app.store.session(&known))
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
