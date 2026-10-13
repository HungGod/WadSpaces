//! The app's link to wadd, on its Unix socket (rswadd.rs). Requests come from
//! here rather than from the page, so they carry no Origin header and there's
//! no CORS between the two.
//!
//! The UI calls [`wadd_request`] (`src/lib/wadd.ts`): its older calls in the
//! `/api` shapes, which rswadd.rs answers from `/v1`, and the newer ones as
//! `/v1` itself; wadd's event stream arrives as
//! [`WaddEvent`]s. Secrets are left out: the app sets those itself (the GitHub
//! token never passes through the page).

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_specta::Event;

const RECONNECT: Duration = Duration::from_secs(3);

/// A failed call: wadd's status (0 when it couldn't be reached) and its
/// `detail`, as the UI's `WaddError` has them.
#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error)]
#[error("{message}")]
pub struct WaddFailure {
    pub status: u16,
    pub message: String,
}

impl WaddFailure {
    pub(crate) fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
}

/// JSON as wadd sends it: typed on the TypeScript side (`src/lib/wadd.ts`).
/// (`unknown` there; specta can't describe `serde_json::Value` itself.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Json(#[specta(type = specta_typescript::Unknown)] pub Value);

/// One event from wadd's stream (`state`, `build`, `launch`, `projects`, …),
/// or `disconnected` (data null) when the stream drops.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct WaddEvent {
    pub event: String,
    pub data: Json,
}

pub struct Wadd {
    rs: crate::rswadd::RsWadd,
    /// The last `state` event, for a page that starts listening late.
    last_state: Mutex<Option<Json>>,
}

impl Wadd {
    pub fn new() -> Self {
        let sock = crate::rswadd::socket();
        tracing::info!("wadd: at {}", sock.display());
        Self { rs: crate::rswadd::RsWadd::new(sock), last_state: Mutex::default() }
    }

    /// A call of the app's own (not the page's).
    pub async fn request(&self, method: Method, path: &str) -> Result<Value, WaddFailure> {
        self.rs.request(method, path, None).await
    }

    /// Sets a podman secret on this machine.
    pub async fn put_secret(&self, name: &str, value: &str) -> Result<(), WaddFailure> {
        self.rs.put_secret(name, value).await
    }
}

/// Whether the page may make this call: wadd's API (the older /api calls
/// rswadd translates, and /v1 as it is), minus setting secrets and remote
/// views (the app's own, never the page's).
fn allowed(method: Method, path: &str) -> Result<(), WaddFailure> {
    let path_only = path.split('?').next().unwrap_or("");
    let ok = (path.starts_with("/api/") || path.starts_with("/v1/"))
        && path.len() <= 2048
        && !path_only.split('/').any(|s| s == ".." || s == ".")
        && !path.contains(['#', '\\'])
        && !path.chars().any(char::is_control);
    if !ok {
        return Err(WaddFailure::new(400, format!("not a wadd API path: {path:?}")));
    }
    let secrets = path_only.starts_with("/api/secrets") || path_only.starts_with("/v1/secrets");
    if secrets && !matches!(method, Method::Get) {
        return Err(WaddFailure::new(403, "secrets are set by the app, not the page"));
    }
    if path_only.starts_with("/v1/remote-views") || path_only.starts_with("/v1/cloud/link") {
        return Err(WaddFailure::new(403, "the app does that itself, not the page"));
    }
    Ok(())
}

/// Calls wadd's API: `path` is like `/api/projects?x=1` or `/v1/images`.
#[tauri::command]
#[specta::specta]
pub async fn wadd_request(
    wadd: State<'_, Wadd>,
    method: Method,
    path: String,
    body: Option<Json>,
) -> Result<Json, WaddFailure> {
    allowed(method, &path)?;
    wadd.rs.request(method, &path, body.map(|Json(b)| b)).await.map(Json)
}

/// The last `state` event (wadd's snapshot), if one has arrived.
#[tauri::command]
#[specta::specta]
pub fn wadd_last_state(wadd: State<'_, Wadd>) -> Option<Json> {
    wadd.last_state.lock().unwrap().clone()
}

/// Follows wadd's event stream for as long as the app runs, reconnecting
/// after a drop.
pub fn follow_events(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let ended = stream_once(&app).await;
            tracing::debug!(?ended, "wadd event stream ended");
            let _ = WaddEvent { event: "disconnected".into(), data: Json(Value::Null) }.emit(&app);
            tokio::time::sleep(RECONNECT).await;
        }
    });
}

async fn stream_once(app: &AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let wadd = app.state::<Wadd>();
    wadd.rs
        .stream_once(|event, data| {
            let data = Json(data);
            if event == "state" {
                *wadd.last_state.lock().unwrap() = Some(data.clone());
            }
            let _ = WaddEvent { event, data }.emit(app);
        })
        .await
}

/// Server-sent events, as wadd writes them: `event:` and `data:` lines, a
/// blank line to end each one, `:` comments for keepalives.
#[derive(Default)]
pub(crate) struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<(String, String)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let event = std::mem::take(&mut self.event);
                    let event = if event.is_empty() { "message".into() } else { event };
                    out.push((event, self.data.join("\n")));
                }
                self.event.clear();
                self.data.clear();
            } else if line.starts_with(':') {
            } else {
                let (field, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "event" => self.event = value.into(),
                    "data" => self.data.push(value.into()),
                    _ => {}
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert!(allowed(Method::Get, "/api/projects?x=1").is_ok());
        assert!(allowed(Method::Post, "/api/workspaces/writing/switch").is_ok());
        assert!(allowed(Method::Get, "/api/secrets").is_ok());
        assert_eq!(allowed(Method::Put, "/api/secrets/github_token").unwrap_err().status, 403);
        // /v1 as it is (the Builder's routes), minus the app's own.
        assert!(allowed(Method::Post, "/v1/images/build").is_ok());
        assert!(allowed(Method::Put, "/v1/workspaces/academy/wallpaper").is_ok());
        assert_eq!(allowed(Method::Put, "/v1/secrets/github_token").unwrap_err().status, 403);
        assert_eq!(allowed(Method::Post, "/v1/remote-views").unwrap_err().status, 403);
        assert_eq!(allowed(Method::Get, "/v1/../etc").unwrap_err().status, 400);
        for bad in ["/", "api/x", "/api/../etc", "/api/./x", "/api/x#y", "/api/a\\b", "/api/a\nb", "http://evil/api/x"]
        {
            assert_eq!(allowed(Method::Get, bad).unwrap_err().status, 400, "{bad:?}");
        }
    }

    #[test]
    fn sse_in_pieces() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: state\ndata: {\"a\"").is_empty());
        let got = p.push(b":1}\n\n: keepalive\n\nevent: build\r\ndata: 1\r\ndata: 2\r\n\r\ndata: x\n\n");
        assert_eq!(
            got,
            vec![("state".into(), "{\"a\":1}".into()), ("build".into(), "1\n2".into()), ("message".into(), "x".into())]
        );
    }
}
