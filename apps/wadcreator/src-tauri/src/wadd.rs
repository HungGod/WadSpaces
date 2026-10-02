//! The app's link to today's (Python) wadd on 127.0.0.1:8080, until the Rust
//! wadd replaces it (stage 2). Requests come from here rather than from the
//! page, so they carry no Origin header and there's no CORS between the two.
//!
//! The UI keeps its Python-shaped types (`src/lib/wadd.ts`) and calls
//! [`wadd_request`] where it used to `fetch`; wadd's event stream arrives as
//! [`WaddEvent`]s. Secrets are left out: the app sets those itself (the GitHub
//! token never passes through the page).

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};
use tauri_specta::Event;

const DEFAULT_URL: &str = "http://127.0.0.1:8080";
/// Python wadd's own limit on a build folder.
const MAX_CONTEXT: usize = 64 << 20;
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
    fn new(status: u16, message: impl Into<String>) -> Self {
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
    http: reqwest::Client,
    base: String,
    /// The last `state` event, for a page that starts listening late.
    last_state: Mutex<Option<Json>>,
}

impl Wadd {
    pub fn new() -> Self {
        let base = std::env::var("WADD_URL").unwrap_or_else(|_| DEFAULT_URL.into());
        Self { http: reqwest::Client::new(), base: base.trim_end_matches('/').into(), last_state: Mutex::default() }
    }

    fn unreachable(&self) -> WaddFailure {
        WaddFailure::new(0, format!("Cannot reach wadd at {}. Is this a WadSpaces machine?", self.base))
    }

    async fn finish(&self, res: Result<reqwest::Response, reqwest::Error>) -> Result<Json, WaddFailure> {
        let res = res.map_err(|_| self.unreachable())?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or_else(|_| Value::Object(Default::default()));
        if status.is_success() {
            return Ok(Json(body));
        }
        let message = match body.get("detail") {
            Some(Value::String(s)) => s.clone(),
            _ => status.canonical_reason().unwrap_or("error").to_string(),
        };
        Err(WaddFailure::new(status.as_u16(), message))
    }
}

/// Whether the page may make this call: wadd's API, minus secrets.
fn allowed(method: Method, path: &str) -> Result<(), WaddFailure> {
    let path_only = path.split('?').next().unwrap_or("");
    let ok = path.starts_with("/api/")
        && path.len() <= 2048
        && !path_only.split('/').any(|s| s == ".." || s == ".")
        && !path.contains(['#', '\\'])
        && !path.chars().any(char::is_control);
    if !ok {
        return Err(WaddFailure::new(400, format!("not a wadd API path: {path:?}")));
    }
    if path_only.starts_with("/api/secrets") && !matches!(method, Method::Get) {
        return Err(WaddFailure::new(403, "secrets are set by the app, not the page"));
    }
    Ok(())
}

/// Calls wadd's HTTP API: `path` is like `/api/projects?x=1`.
#[tauri::command]
#[specta::specta]
pub async fn wadd_request(
    wadd: State<'_, Wadd>,
    method: Method,
    path: String,
    body: Option<Json>,
) -> Result<Json, WaddFailure> {
    allowed(method, &path)?;
    let url = format!("{}{path}", wadd.base);
    let req = match method {
        Method::Get => wadd.http.get(url),
        Method::Post => wadd.http.post(url),
        Method::Put => wadd.http.put(url),
        Method::Delete => wadd.http.delete(url),
    };
    let req = match body {
        Some(Json(b)) => req.json(&b),
        None => req,
    };
    wadd.finish(req.send().await).await
}

/// The last `state` event (wadd's snapshot), if one has arrived.
#[tauri::command]
#[specta::specta]
pub fn wadd_last_state(wadd: State<'_, Wadd>) -> Option<Json> {
    wadd.last_state.lock().unwrap().clone()
}

/// Uploads a build folder (a tar) for build `x-build-id`. Called with a raw
/// body, so it's outside the generated bindings: see `src/lib/wadd.ts`.
#[tauri::command]
pub async fn wadd_build_context(wadd: State<'_, Wadd>, request: Request<'_>) -> Result<Json, WaddFailure> {
    let InvokeBody::Raw(tar) = request.body() else {
        return Err(WaddFailure::new(400, "expected the tar as a raw body"));
    };
    if tar.len() > MAX_CONTEXT {
        return Err(WaddFailure::new(413, "build folder too big (64 MB max)"));
    }
    let id = request
        .headers()
        .get("x-build-id")
        .and_then(|v| v.to_str().ok())
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .ok_or_else(|| WaddFailure::new(400, "missing or bad x-build-id"))?;
    let url = format!("{}/api/builds/{id}/context", wadd.base);
    let res = wadd.http.put(url).header("content-type", "application/x-tar").body(tar.clone()).send().await;
    wadd.finish(res).await
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
    let mut res = wadd
        .http
        .get(format!("{}/api/events", wadd.base))
        .header("accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("status {}", res.status()));
    }
    let mut parser = SseParser::default();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        for (event, data) in parser.push(&chunk) {
            let data = Json(serde_json::from_str(&data).unwrap_or(Value::String(data)));
            if event == "state" {
                *wadd.last_state.lock().unwrap() = Some(data.clone());
            }
            let _ = WaddEvent { event, data }.emit(app);
        }
    }
    Ok(())
}

/// Server-sent events, as wadd writes them: `event:` and `data:` lines, a
/// blank line to end each one, `:` comments for keepalives.
#[derive(Default)]
struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<(String, String)> {
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
