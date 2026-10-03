//! Viewing this machine's workspaces from other devices on the local
//! network: another machine's Wad Creator (remote.rs over there) or a phone.
//!
//! A streamed workspace draws on its `_stream` sidecar (Selkies) instead of
//! the screen; the sidecar is published on every address, on its own port,
//! and its nginx asks for the stream user and password on every path (pages
//! and the websocket), over TLS with this machine's certificate (tls.rs)
//! only. It fails closed:
//!
//! - **allowed here first**: off until someone at the machine turns it on
//!   (the API is the machine's own socket; the account can't), and turning
//!   it off ends every stream;
//! - **a stream password** (the account's `stream_password` secret, at least
//!   `min_password` long), or nothing starts; when it changes or goes, the
//!   streams using the old one end;
//! - the person at the machine wins: switching to a streamed workspace there
//!   brings it back to the screen (registry.to_screen).
//!
//! The sidecar gets the password as `wad_stream_password` (a copy, trimmed:
//! nginx would take a trailing newline as part of it); it never leaves wadd
//! and podman otherwise.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use wad_proto::v1::{Display, Event, StreamInfo, StreamsStatus};
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
use crate::events::Bus;
use crate::registry::Registry;
use crate::tls::StreamCert;

/// The account's stream password (synced like any secret).
pub const PASSWORD: &str = "stream_password";
/// The sidecar's copy.
pub const SIDECAR_PASSWORD: &str = "wad_stream_password";
/// The stream user when the owner's username isn't known.
const DEFAULT_USER: &str = "wadspaces";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Book {
    #[serde(default)]
    allow_remote: bool,
    /// Each streamed workspace keeps its port (links stay the same).
    #[serde(default)]
    ports: BTreeMap<String, u16>,
    /// The owner's WadSpaces username, as last heard from the account.
    #[serde(default)]
    user: Option<String>,
}

pub struct Streams {
    cfg: wad_config::Streams,
    registry: Arc<Registry>,
    backend: Arc<dyn Backend>,
    bus: Bus,
    file: PathBuf,
    pub cert: StreamCert,
    machine: String,
    book: Mutex<Book>,
    /// One start or stop at a time.
    lock: tokio::sync::Mutex<()>,
    /// The password the running streams were started with (its digest).
    started_with: Mutex<Option<String>>,
}

fn digest(s: &str) -> String {
    crate::tls::sha256_hex(s.as_bytes())
}

impl Streams {
    pub fn new(
        cfg: wad_config::Streams,
        registry: Arc<Registry>,
        backend: Arc<dyn Backend>,
        bus: Bus,
        state_dir: &std::path::Path,
        machine: &str,
    ) -> Arc<Self> {
        let dir = state_dir.join("streams");
        let file = dir.join("streams.json");
        let book = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(Self {
            cfg,
            registry,
            backend,
            bus,
            file,
            cert: StreamCert::new(dir.join("tls")),
            machine: machine.into(),
            book: Mutex::new(book),
            lock: tokio::sync::Mutex::new(()),
            started_with: Mutex::default(),
        })
    }

    fn save(&self) -> Result<(), ApiError> {
        let text = serde_json::to_vec_pretty(&*self.book.lock().unwrap()).expect("json");
        let internal = |e: std::io::Error| ApiError::new(ErrorCode::Internal, format!("{}: {e}", self.file.display()));
        if let Some(d) = self.file.parent() {
            std::fs::create_dir_all(d).map_err(internal)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &self.file)).map_err(internal)
    }

    pub fn allow_remote(&self) -> bool {
        self.cfg.enabled && self.book.lock().unwrap().allow_remote
    }

    pub fn user(&self) -> String {
        self.book.lock().unwrap().user.clone().unwrap_or_else(|| DEFAULT_USER.into())
    }

    /// The owner's username (the relay reads it from the account).
    pub fn set_user(&self, user: Option<String>) {
        let user = user.filter(|u| !u.is_empty() && u.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c)));
        let changed = {
            let mut b = self.book.lock().unwrap();
            let changed = b.user != user;
            b.user = user;
            changed
        };
        if changed && let Err(e) = self.save() {
            tracing::warn!("streams: {}", e.message);
        }
    }

    /// The stream password, checked: Ok(it), or why it can't be used.
    async fn password(&self) -> Result<String, String> {
        let value = self
            .backend
            .secret_value(PASSWORD)
            .await
            .map_err(|e| format!("the stream password can't be read: {e}"))?
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if value.is_empty() {
            return Err("there's no stream password: set one in Wad Creator's Settings".into());
        }
        if value.chars().count() < self.cfg.min_password {
            return Err(format!(
                "the stream password is too short: it needs {} characters or more (Wad Creator's Settings)",
                self.cfg.min_password
            ));
        }
        Ok(value)
    }

    /// Why a stream can't start now, if it can't.
    async fn problem(&self) -> Option<String> {
        if !self.cfg.enabled {
            return Some("streams are switched off on this machine (wadd.toml)".into());
        }
        if !self.allow_remote() {
            return Some(format!(
                "viewing from other devices is off on {}: turn it on in Wad Creator's Settings there",
                self.machine
            ));
        }
        if let Err(e) = self.password().await {
            return Some(e);
        }
        match self.backend.image_exists(&self.cfg.image).await {
            Ok(true) => None,
            Ok(false) => Some(format!("the stream image ({}) isn't on this machine", self.cfg.image)),
            Err(e) => Some(format!("podman: {e}")),
        }
    }

    pub async fn status(&self) -> StreamsStatus {
        let problem = self.problem().await;
        StreamsStatus {
            allow_remote: self.allow_remote(),
            password_set: self.password().await.is_ok(),
            problem,
            user: self.user(),
            sha256: self.cert.info().map(|i| i.sha256),
            streams: self.list(),
        }
    }

    async fn publish(&self) {
        let st = self.status().await;
        self.bus.publish(Event::Streams(st));
    }

    /// The streams running now.
    pub fn list(&self) -> Vec<StreamInfo> {
        let Some(cert) = self.cert.info() else { return vec![] };
        let addrs = crate::tls::lan_addresses();
        let mut out = vec![];
        for id in self.registry.streamed() {
            let (Ok(ws), Some(stream)) = (self.registry.workspace(&id), self.registry.stream_of(&id)) else { continue };
            let Some(st) = self.registry.state(&id).filter(|s| s.container == "running") else { continue };
            let port = stream.get("port").and_then(serde_json::Value::as_u64).unwrap_or(0) as u16;
            out.push(StreamInfo {
                ws_id: id,
                name: ws.name,
                port,
                urls: addrs.iter().map(|a| format!("https://{a}:{port}/")).collect(),
                user: stream.get("user").and_then(serde_json::Value::as_str).unwrap_or(DEFAULT_USER).into(),
                sha256: cert.sha256.clone(),
                ready: st.phase == wad_proto::v1::Phase::Ready,
            });
        }
        out.sort_by(|a, b| a.ws_id.cmp(&b.ws_id));
        out
    }

    /// Allows (or stops allowing) viewing from other devices. Off ends every
    /// stream now.
    pub async fn set_allow_remote(&self, on: bool) -> Result<StreamsStatus, ApiError> {
        if on && !self.cfg.enabled {
            return Err(ApiError::new(ErrorCode::Conflict, "streams are switched off on this machine (wadd.toml)"));
        }
        {
            let _one = self.lock.lock().await;
            self.book.lock().unwrap().allow_remote = on;
            self.save()?;
            tracing::info!("viewing from other devices {}", if on { "allowed" } else { "not allowed" });
            if !on {
                self.end_all("viewing from other devices was turned off").await;
            }
        }
        self.publish().await;
        Ok(self.status().await)
    }

    async fn end_all(&self, why: &str) {
        for id in self.registry.streamed() {
            tracing::info!("{id}: its stream ends ({why})");
            if let Err(e) = self.registry.to_screen(&id).await {
                tracing::warn!("{id}: ending its stream: {}", e.message);
            }
        }
    }

    /// A port for a workspace's stream: the one it had, else the first free.
    fn port_for(&self, id: &str) -> Result<u16, ApiError> {
        let mut book = self.book.lock().unwrap();
        if let Some(p) = book.ports.get(id) {
            return Ok(*p);
        }
        let taken: Vec<u16> =
            book.ports.values().copied().chain(self.registry.workspaces().iter().filter_map(|w| w.port)).collect();
        let end = self.cfg.first_port.saturating_add(self.cfg.ports);
        let port = (self.cfg.first_port..end)
            .find(|p| !taken.contains(p))
            .ok_or_else(|| ApiError::new(ErrorCode::Conflict, "no stream ports left"))?;
        book.ports.insert(id.into(), port);
        Ok(port)
    }

    /// Draws a workspace on its stream sidecar, ready to start (a launch
    /// starts it). Refused unless everything above is in place. `takeover`:
    /// it's open on the screen; take it off.
    pub async fn prepare(&self, id: &str, takeover: bool) -> Result<u16, ApiError> {
        let _one = self.lock.lock().await;
        let ws = self.registry.workspace(id)?;
        let refuse = |m: String| ApiError::new(ErrorCode::Conflict, m);
        if let Some(p) = self.problem().await {
            return Err(refuse(p));
        }
        if ws.display != Display::Host {
            return Err(ApiError::new(ErrorCode::BadRequest, format!("{} isn't a native workspace", ws.name)));
        }
        let password = self.password().await.map_err(refuse)?;
        let running = self.registry.state(id).is_some_and(|s| s.container == "running");
        let streamed = self.registry.stream_of(id).is_some();
        if running && !streamed {
            if !takeover {
                return Err(refuse(format!("{} is open on {}'s screen", ws.name, self.machine)));
            }
            tracing::info!("{id}: off the screen, to be viewed elsewhere");
            self.registry.stop(id).await?;
        }
        let cert = self.cert.ensure(&self.machine).map_err(|e| ApiError::new(ErrorCode::Internal, e))?;
        self.backend
            .create_secret(SIDECAR_PASSWORD, password.as_bytes())
            .await
            .map_err(|e| ApiError::new(ErrorCode::Internal, format!("the stream password: {e}")))?;
        *self.started_with.lock().unwrap() = Some(digest(&password));
        let port = self.port_for(id)?;
        self.save()?;
        let stream = json!({
            "port": port,
            "user": self.user(),
            "image": self.cfg.image,
            "tls_dir": self.cert.dir.to_string_lossy(),
        });
        if self.registry.stream_of(id).as_ref() != Some(&stream) {
            if running && streamed {
                self.registry.stop(id).await?;
            }
            self.registry.set_stream(id, Some(stream)).await.map_err(|e| ApiError::new(ErrorCode::Internal, e))?;
        }
        tracing::info!("{id}: streamed on port {port} (certificate sha256 {})", cert.sha256);
        Ok(port)
    }

    /// Starts streaming a workspace (from this machine: "show it on my phone").
    pub async fn start(&self, id: &str, takeover: bool) -> Result<StreamsStatus, ApiError> {
        self.prepare(id, takeover).await?;
        self.registry.start(id)?;
        self.publish().await;
        Ok(self.status().await)
    }

    /// Ends a workspace's stream: stopped, and on the screen from its next start.
    pub async fn stop(&self, id: &str) -> Result<StreamsStatus, ApiError> {
        self.registry.workspace(id)?;
        {
            let _one = self.lock.lock().await;
            self.registry.to_screen(id).await?;
        }
        self.publish().await;
        Ok(self.status().await)
    }

    /// At start: streams left from before (wadd restarted) end, since what
    /// they were started with isn't known any more.
    pub async fn end_leftovers(&self) {
        for ws in self.registry.workspaces() {
            let display = format!("wad-{}-display", ws.id);
            if self.backend.container(&display).await.unwrap_or_default() == "running" {
                tracing::info!("{}: a stream left from before ends", ws.id);
                let _ = self.backend.stop(&format!("wad-{}.service", ws.id)).await;
                let _ = self.backend.stop(&format!("{display}.service")).await;
            }
        }
    }

    /// Keeps the streams honest: none without permission or with a password
    /// that's no longer the account's (it changed, or went). Every `every`.
    pub async fn run(self: Arc<Self>, every: Duration) {
        let mut last: Option<StreamsStatus> = None;
        loop {
            tokio::time::sleep(every).await;
            if !self.registry.streamed().is_empty() {
                let current = self.password().await.ok().map(|p| digest(&p));
                let started = self.started_with.lock().unwrap().clone();
                let why = if !self.allow_remote() {
                    Some("viewing from other devices isn't allowed")
                } else if current.is_none() {
                    Some("there's no stream password now")
                } else if started.is_some() && current != started {
                    Some("the stream password changed")
                } else {
                    None
                };
                if let Some(why) = why {
                    let _one = self.lock.lock().await;
                    self.end_all(why).await;
                }
            }
            let st = self.status().await;
            if last.as_ref() != Some(&st) {
                self.bus.publish(Event::Streams(st.clone()));
                last = Some(st);
            }
        }
    }
}
