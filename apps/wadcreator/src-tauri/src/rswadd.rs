//! The Rust wadd, behind the same calls the UI makes of the Python one
//! (`src/lib/wadd.ts`): each `/api/...` request is answered by the Rust
//! wadd's `/v1` API on its Unix socket, and its answers and events are put
//! back in the Python wadd's shapes, so the UI doesn't change. Its events
//! (the machine, what's on screen, each workspace's state, the session, the
//! account link, the network, the workspace list) are mirrored into the
//! `state` snapshot the UI reads.
//!
//! Two flows differ, and the UI asks which wadd it has (`wadd_kind`):
//! builds (the Rust wadd builds from the design: POST /api/builds/design)
//! and secrets (set by the app, not the page).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Value, json};

use crate::wadd::{Method, WaddFailure};

/// Where the Rust wadd listens: WADD_SOCKET, the machine's, or a laptop's
/// (`wadd serve --user`).
pub fn socket() -> PathBuf {
    if let Some(s) = std::env::var_os("WADD_SOCKET") {
        return s.into();
    }
    let system = PathBuf::from("/run/wadd/wadd.sock");
    if system.exists() {
        return system;
    }
    std::env::var_os("XDG_RUNTIME_DIR").map(|r| PathBuf::from(r).join("wadd/wadd.sock")).unwrap_or(system)
}

pub struct RsWadd {
    http: reqwest::Client,
    sock: PathBuf,
    /// What the snapshot is made of, as the events tell it.
    mirror: Mutex<Mirror>,
}

#[derive(Default)]
struct Mirror {
    machine: Value,
    view: Value,
    workspaces: Vec<Value>,
    states: HashMap<String, Value>,
    session: Value,
    cloud: Value,
    network: Value,
    keyboards: usize,
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}

// ------------------------------------------------------- shapes, v1 -> py
/// "launcher" or "workspace:<id>", as the Python wadd said what's on screen.
pub fn view_str(view: &Value) -> String {
    match s(view, "kind").as_str() {
        Some("workspace") => format!("workspace:{}", s(view, "id").as_str().unwrap_or_default()),
        _ => "launcher".into(),
    }
}

pub fn state_py(st: &Value) -> Value {
    let d = s(st, "download");
    let download = if d.is_null() {
        Value::Null
    } else {
        json!({"total_bytes": s(d, "totalBytes"), "done_bytes": s(d, "doneBytes"), "layers": s(d, "layers"),
               "rate_bps": s(d, "rateBps"), "eta_s": s(d, "etaS"), "unpacking": s(d, "unpacking")})
    };
    json!({"container": s(st, "container"), "phase": s(st, "phase"), "progress": s(st, "progress"), "message": s(st, "message"),
           "error": s(st, "error"), "image_present": s(st, "imagePresent"), "download": download, "since": s(st, "since")})
}

pub fn session_py(sess: &Value) -> Value {
    if sess.is_null() {
        return Value::Null;
    }
    let ends = s(sess, "endsAt").as_f64();
    let remaining = ends.map(|e| (e - now()).max(0.0) as i64);
    json!({"workspaces": s(sess, "workspaces"), "mode": s(sess, "mode"), "started_at": s(sess, "startedAt"),
           "minutes": s(sess, "minutes"), "ends_at": s(sess, "endsAt"), "expired": s(sess, "expired"), "remaining_s": remaining})
}

fn machine_ws(ws: &Value, state: Option<&Value>) -> Value {
    let stream = s(ws, "display") == "stream";
    let url = match s(ws, "port").as_u64() {
        Some(p) if stream => json!(format!("http://127.0.0.1:{p}/")),
        _ => Value::Null,
    };
    let idle = json!({"container": "unknown", "phase": "idle", "progress": null, "message": null, "error": null, "image_present": null, "download": null, "since": 0});
    json!({"id": s(ws, "id"), "name": s(ws, "name"), "port": s(ws, "port"), "url": url, "display": s(ws, "display"), "hotkey": s(ws, "hotkey"),
           "icon": null, "enabled": s(ws, "enabled"), "image": s(ws, "image"), "state": state.map(state_py).unwrap_or(idle)})
}

impl Mirror {
    /// The Python wadd's `state` snapshot.
    fn snapshot(&self) -> Value {
        let workspaces: Vec<Value> = self
            .workspaces
            .iter()
            .filter(|w| s(w, "enabled") != false)
            .map(|w| machine_ws(w, w["id"].as_str().and_then(|id| self.states.get(id))))
            .collect();
        let linked = s(&self.cloud, "linked").as_bool().unwrap_or(false);
        json!({
            "machine": s(&self.machine, "name"), "version": s(&self.machine, "version"),
            "view": view_str(s(&self.view, "view")), "pending": s(&self.view, "pending"),
            "enrolled": linked, "machine_id": if linked { s(&self.cloud, "machineId").clone() } else { Value::Null },
            "owner_uid": if linked { s(&self.cloud, "ownerUid").clone() } else { Value::Null },
            "cloud_enabled": !self.cloud.is_null(),
            "kiosk_connected": false, "backend": "podman", "backend_connected": true,
            "hotkey_devices": self.keyboards, "network": self.network, "session": session_py(&self.session),
            "native_display": s(&self.view, "nativeDisplay").as_bool().unwrap_or(false),
            "workspaces": workspaces,
        })
    }

    /// Takes in an event; whether the snapshot changed.
    fn take(&mut self, event: &str, data: &Value) -> bool {
        match event {
            "machine" => self.machine = data.clone(),
            "view" => self.view = data.clone(),
            "session" => self.session = data.clone(),
            "cloud" => self.cloud = data.clone(),
            "network" => self.network = data.clone(),
            "workspaces" => self.workspaces = data.as_array().cloned().unwrap_or_default(),
            "workspaceState" => {
                let id = s(data, "id").as_str().unwrap_or_default().to_string();
                self.states.insert(id, data.clone());
            }
            _ => return false,
        }
        true
    }
}

fn build_py(b: &Value) -> Value {
    json!({"id": s(b, "id"), "wsId": s(b, "wsId"), "name": s(b, "name"), "status": s(b, "status"), "progress": s(b, "progress"),
           "error": s(b, "error"), "image": s(b, "image"), "created": s(b, "created"), "started": s(b, "started"), "finished": s(b, "finished"),
           "installed": s(b, "updated"), "restartRequired": s(b, "restartRequired"), "lineCount": s(b, "lineCount")})
}

fn launch_py(l: &Value) -> Value {
    let mut out = l.clone();
    if let Value::Object(o) = &mut out {
        o.insert("view".into(), "screen".into());
    }
    out
}

/// A job event or log ({build|launch, from, lines}) flattened, as the
/// Python wadd sent them.
fn flatten(job: Value, log: &Value) -> Value {
    let mut out = job;
    if let Value::Object(o) = &mut out {
        o.insert("from".into(), s(log, "from").clone());
        o.insert("lines".into(), s(log, "lines").clone());
    }
    out
}

fn log_line_py(l: &Value) -> Value {
    json!({"time": s(l, "time").as_f64().map(|t| t / 1000.0), "level": s(l, "level"), "logger": s(l, "target"), "message": s(l, "message")})
}

/// A workspace in workspaces.yaml's shape (what the UI calls a WaddSpec).
fn spec_of(ws: &Value) -> Value {
    match serde_json::from_value::<wad_proto::v1::Workspace>(ws.clone()) {
        Ok(w) => wad_store::legacy::to_yaml(&w),
        Err(_) => Value::Null,
    }
}

/// A WaddSpec as the Rust wadd's Workspace, checked as workspaces.yaml would be.
fn workspace_of(spec: &Value) -> Result<Value, WaddFailure> {
    let ws = wad_store::legacy::check_workspaces(vec![spec.clone()])
        .map_err(|e| WaddFailure { status: 422, message: e.to_string() })?;
    Ok(serde_json::to_value(&ws[0]).expect("json"))
}

fn diagnostics_py(d: &Value) -> Value {
    let p = s(d, "podman");
    let disk = s(d, "disk");
    let view = s(d, "view");
    let workspaces: Vec<Value> = s(d, "workspaces")
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| {
            let mut st = state_py(w);
            st["id"] = s(w, "id").clone();
            st
        })
        .collect();
    json!({
        "wadd": {"version": s(s(d, "wadd"), "version"), "uptime_s": s(s(d, "wadd"), "uptimeS"), "pid": s(s(d, "wadd"), "pid"), "config": null, "backend": "podman"},
        "podman": {"connected": s(p, "connected"), "version": s(p, "version"), "graph_root": s(p, "graphRoot"), "storage_driver": s(p, "storageDriver"),
                   "images": s(p, "images"), "error": s(p, "error")},
        "disk": {"path": s(disk, "path"), "free_bytes": s(disk, "freeBytes"), "total_bytes": s(disk, "totalBytes")},
        "network": s(d, "network"),
        "kiosk": {"connected": false, "view": view_str(s(view, "view")), "pending": s(view, "pending")},
        "keyboards": s(s(d, "keys"), "keyboards"),
        "secrets": s(d, "secrets").as_array().into_iter().flatten().map(|x| s(x, "name").clone()).collect::<Vec<_>>(),
        "log_units": s(d, "logUnits"),
        "workspaces": workspaces,
        "recent_problems": s(d, "recentProblems").as_array().into_iter().flatten().map(log_line_py).collect::<Vec<_>>(),
    })
}

fn ok() -> Value {
    json!({"ok": true})
}

fn not_here(what: &str) -> WaddFailure {
    WaddFailure { status: 404, message: format!("{what} isn't on this machine's wadd") }
}

fn query(path: &str) -> (String, HashMap<String, String>) {
    let (p, q) = path.split_once('?').unwrap_or((path, ""));
    let q = q.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
    (p.to_string(), q)
}

impl RsWadd {
    pub fn new(sock: PathBuf) -> Self {
        let http = reqwest::Client::builder().unix_socket(sock.clone()).build().expect("a client");
        Self { http, sock, mirror: Mutex::default() }
    }

    /// One /v1 call: its JSON, or the failure as the UI's WaddError has it.
    pub async fn v1(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value, WaddFailure> {
        let url = format!("http://wadd{path}");
        let req = match method {
            Method::Get => self.http.get(url),
            Method::Post => self.http.post(url),
            Method::Put => self.http.put(url),
            Method::Delete => self.http.delete(url),
        };
        let req = match body {
            Some(b) => req.json(b),
            None => req,
        };
        let res = req.send().await.map_err(|_| WaddFailure {
            status: 0,
            message: format!("Cannot reach wadd at {}. Is this a WadSpaces machine?", self.sock.display()),
        })?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let body: Value =
            if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) };
        if status.is_success() {
            return Ok(body);
        }
        let message = s(&body, "message")
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").into());
        // The Python wadd's statuses where the UI looks at them.
        let code = match (status.as_u16(), s(&body, "code").as_str()) {
            (400, _) => 422,
            (n, _) => n,
        };
        Err(WaddFailure { status: code, message })
    }

    /// Sets a podman secret (the app's GitHub sign-in).
    pub async fn put_secret(&self, name: &str, value: &str) -> Result<(), WaddFailure> {
        self.v1(Method::Put, &format!("/v1/secrets/{name}"), Some(&json!({"value": value}))).await.map(drop)
    }

    /// The UI's call, answered by the Rust wadd.
    pub async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, WaddFailure> {
        use Method::*;
        let (p, q) = query(path);
        let seg: Vec<&str> = p.trim_start_matches('/').split('/').collect();
        let b = body.unwrap_or(Value::Null);
        let enc = |x: &str| x.to_string(); // segments arrive already encoded
        Ok(match (method, seg.as_slice()) {
            (Get, ["api", "specs"]) => {
                let list = self.v1(Get, "/v1/workspaces", None).await?;
                Value::Array(list.as_array().into_iter().flatten().map(spec_of).collect())
            }
            (Post, ["api", "workspaces"]) => {
                let w = self.v1(Post, "/v1/workspaces", Some(&workspace_of(&b)?)).await?;
                spec_of(&w)
            }
            (Put, ["api", "workspaces", id]) => {
                let mut w = workspace_of(&b)?;
                w["id"] = Value::String(id.to_string());
                let r = self.v1(Put, &format!("/v1/workspaces/{}", enc(id)), Some(&w)).await?;
                json!({"workspace": spec_of(s(&r, "workspace")), "restart_required": s(&r, "restartRequired")})
            }
            (Delete, ["api", "workspaces", id]) => {
                self.v1(Delete, &format!("/v1/workspaces/{}", enc(id)), None).await?;
                ok()
            }
            (Post, ["api", "workspaces", id, action @ ("switch" | "start" | "stop" | "restart" | "download")]) => {
                self.v1(Post, &format!("/v1/workspaces/{}/{action}", enc(id)), None).await?;
                ok()
            }
            (Post, ["api", "launcher"]) => {
                self.v1(Post, "/v1/view/home", None).await?;
                ok()
            }
            (Post, ["api", "session"]) => session_py(
                &self
                    .v1(
                        Post,
                        "/v1/session",
                        Some(&json!({"workspaces": s(&b, "workspaces"), "minutes": s(&b, "minutes")})),
                    )
                    .await?,
            ),
            (Post, ["api", "session", "end"]) => {
                let force = s(&b, "force").as_bool().unwrap_or(false);
                self.v1(Delete, &format!("/v1/session?force={force}"), None).await?;
                ok()
            }
            (Post, ["api", "enroll"]) => {
                let l = self.v1(Post, "/v1/cloud/link", Some(&json!({"code": s(&b, "code")}))).await?;
                json!({"ok": true, "machineId": s(&l, "machineId")})
            }
            (Get, ["api", "diagnostics"]) => diagnostics_py(&self.v1(Get, "/v1/diagnostics", None).await?),
            (Get, ["api", "network"]) => self.v1(Get, "/v1/network", None).await?,
            (Get, ["api", "network", "wifi"]) => self.v1(Get, "/v1/network/wifi?rescan=true", None).await?,
            (Post, ["api", "network", "wifi", what @ ("connect" | "disconnect" | "forget")]) => {
                let body = (*what != "disconnect").then_some(&b);
                self.v1(Post, &format!("/v1/network/wifi/{what}"), body).await?;
                ok()
            }
            (Post, ["api", "power"]) => {
                self.v1(Post, "/v1/power", Some(&json!({"action": s(&b, "action")}))).await?;
                ok()
            }
            // Streams (the Rust wadd's own; the UI reads its shapes as they are).
            (Get, ["api", "streams"]) => self.v1(Get, "/v1/streams", None).await?,
            (Put, ["api", "streams", "settings"]) => self.v1(Put, "/v1/streams/settings", Some(&b)).await?,
            (Post, ["api", "workspaces", id, "stream"]) => {
                self.v1(Post, &format!("/v1/workspaces/{}/stream", enc(id)), Some(&b)).await?
            }
            (Delete, ["api", "workspaces", id, "stream"]) => {
                self.v1(Delete, &format!("/v1/workspaces/{}/stream", enc(id)), None).await?
            }
            (Post, ["api", "remote-views"]) => self.v1(Post, "/v1/remote-views", Some(&b)).await?,
            (Delete, ["api", "remote-views", id]) => {
                self.v1(Delete, &format!("/v1/remote-views/{}", enc(id)), None).await?;
                ok()
            }
            // The HUD draws its own menus over the screen: nothing to put back.
            (Post, ["api", "hud", "closed"]) => ok(),
            (Get, ["api", "builds"]) => Value::Array(
                self.v1(Get, "/v1/builds", None).await?.as_array().into_iter().flatten().map(build_py).collect(),
            ),
            (Post, ["api", "builds"]) | (Put, ["api", "builds", _, "context"]) => {
                return Err(WaddFailure {
                    status: 409,
                    message: "this machine's wadd builds from the design (POST /api/builds/design)".into(),
                });
            }
            (Post, ["api", "builds", "design"]) => build_py(&self.v1(Post, "/v1/builds", Some(&b)).await?),
            (Get, ["api", "builds", id]) => {
                let since = q.get("since").cloned().unwrap_or_else(|| "0".into());
                let l = self.v1(Get, &format!("/v1/builds/{}?since={since}", enc(id)), None).await?;
                flatten(build_py(s(&l, "build")), &l)
            }
            (Delete, ["api", "builds", id]) => {
                build_py(&self.v1(Delete, &format!("/v1/builds/{}", enc(id)), None).await?)
            }
            (Get, ["api", "projects"]) => {
                self.v1(
                    Get,
                    &format!("/v1/projects{}", if q.contains_key("deleted") { "?deleted=true" } else { "" }),
                    None,
                )
                .await?
            }
            (Post, ["api", "projects"]) => self.v1(Post, "/v1/projects", Some(&b)).await?,
            (Get, ["api", "projects", id]) => self.v1(Get, &format!("/v1/projects/{}", enc(id)), None).await?,
            (Put, ["api", "projects", id]) => self.v1(Put, &format!("/v1/projects/{}", enc(id)), Some(&b)).await?,
            (Delete, ["api", "projects", id]) => {
                let purge = q.get("purge").is_some_and(|v| v == "1" || v == "true");
                let r = self.v1(Delete, &format!("/v1/projects/{}?purge={purge}", enc(id)), None).await?;
                let mut out = s(&r, "project").clone();
                out["purged"] = s(&r, "purged").clone();
                out
            }
            (Get, ["api", "projects", id, "status"]) => {
                let st = self.v1(Get, &format!("/v1/projects/{}/status", enc(id)), None).await?;
                let mut out = json!({"exists_on_disk": s(&st, "existsOnDisk"), "path": s(&st, "path"), "bytes": null,
                    "mounted_in": s(&st, "mountedIn"), "git": s(&st, "git"), "available": s(&st, "available")});
                if let Some(r) = s(&st, "reason").as_str() {
                    out["reason"] = r.into();
                }
                out
            }
            (Get, ["api", "github"]) => {
                let g = self.v1(Get, "/v1/github", None).await?;
                let mut out = json!({"token": s(&g, "token"), "login": s(&g, "login")});
                if let Some(e) = s(&g, "error").as_str() {
                    out["error"] = e.into();
                }
                out
            }
            (Get, ["api", "github", "repos"]) => self.v1(Get, "/v1/github/repos", None).await?,
            (Post, ["api", "github", "repos"]) => self.v1(Post, "/v1/github/repos", Some(&b)).await?,
            (Get, ["api", "drives"]) => self.v1(Get, "/v1/drives", None).await?,
            (Get, ["api", "fs", "browse"]) => {
                let qs: Vec<String> =
                    ["path", "drive"].iter().filter_map(|k| q.get(*k).map(|v| format!("{k}={v}"))).collect();
                self.v1(
                    Get,
                    &format!("/v1/browse{}", if qs.is_empty() { String::new() } else { format!("?{}", qs.join("&")) }),
                    None,
                )
                .await?
            }
            (Get, ["api", "launches"]) => Value::Array(
                self.v1(Get, "/v1/launches", None).await?.as_array().into_iter().flatten().map(launch_py).collect(),
            ),
            (Post, ["api", "launches"]) => {
                let body = json!({"workspace": s(&b, "workspace"), "projects": s(&b, "projects"), "restart": s(&b, "restart").as_bool().unwrap_or(false)});
                launch_py(&self.v1(Post, "/v1/launches", Some(&body)).await?)
            }
            (Get, ["api", "launches", id]) => {
                let since = q.get("since").cloned().unwrap_or_else(|| "0".into());
                let l = self.v1(Get, &format!("/v1/launches/{}?since={since}", enc(id)), None).await?;
                flatten(launch_py(s(&l, "launch")), &l)
            }
            (Delete, ["api", "launches", id]) => {
                launch_py(&self.v1(Delete, &format!("/v1/launches/{}", enc(id)), None).await?)
            }
            (Get, ["api", "library", c]) => self.v1(Get, &format!("/v1/library/{}", enc(c)), None).await?,
            (Get, ["api", "library", c, id]) => {
                self.v1(Get, &format!("/v1/library/{}/{}", enc(c), enc(id)), None).await?
            }
            (Put, ["api", "library", c, id]) => {
                self.v1(Put, &format!("/v1/library/{}/{}", enc(c), enc(id)), Some(&b)).await?
            }
            (Delete, ["api", "library", c, id]) => {
                self.v1(Delete, &format!("/v1/library/{}/{}", enc(c), enc(id)), None).await?;
                ok()
            }
            (Get, ["api", "metrics"]) => self.v1(Get, "/v1/metrics", None).await?,
            (Get, ["api", "runs"]) => {
                let limit = q.get("limit").cloned().unwrap_or_else(|| "200".into());
                let ws = q.get("workspace").map(|w| format!("&workspace={w}")).unwrap_or_default();
                self.v1(Get, &format!("/v1/runs?limit={limit}{ws}"), None).await?
            }
            (Get, ["api", "secrets"]) => {
                let list = self.v1(Get, "/v1/secrets", None).await?;
                Value::Array(list.as_array().into_iter().flatten().map(|x| s(x, "name").clone()).collect())
            }
            (Get, ["api", "logs", "daemon"]) => {
                let lines = q.get("lines").cloned().unwrap_or_else(|| "200".into());
                let l = self.v1(Get, &format!("/v1/logs?lines={lines}"), None).await?;
                json!({"lines": l.as_array().into_iter().flatten().map(log_line_py).collect::<Vec<_>>()})
            }
            (Get, ["api", "logs", "unit", unit]) => {
                self.v1(
                    Get,
                    &format!(
                        "/v1/logs/unit/{}?lines={}",
                        enc(unit),
                        q.get("lines").map(String::as_str).unwrap_or("200")
                    ),
                    None,
                )
                .await?
            }
            (Get, ["api", "logs", "workspace", id]) => {
                self.v1(
                    Get,
                    &format!(
                        "/v1/logs/workspace/{}?lines={}",
                        enc(id),
                        q.get("lines").map(String::as_str).unwrap_or("200")
                    ),
                    None,
                )
                .await?
            }
            // Tailscale is parked: the UI hides its card when this isn't there.
            (_, ["api", "tailnet", ..]) => return Err(not_here("Tailscale")),
            _ => return Err(WaddFailure { status: 404, message: format!("no {path} on this machine's wadd") }),
        })
    }

    /// Fills the mirror from the API (when the event stream starts).
    async fn prime(&self) {
        let get = |p: &'static str| async move { self.v1(Method::Get, p, None).await.unwrap_or(Value::Null) };
        let (machine, view, workspaces, states, session, cloud, network, keys) = tokio::join!(
            get("/v1/machine"),
            get("/v1/view"),
            get("/v1/workspaces"),
            get("/v1/states"),
            get("/v1/session"),
            get("/v1/cloud"),
            get("/v1/network"),
            get("/v1/keys"),
        );
        let mut m = self.mirror.lock().unwrap();
        m.machine = machine;
        m.view = view;
        m.workspaces = workspaces.as_array().cloned().unwrap_or_default();
        m.states = states
            .as_array()
            .into_iter()
            .flatten()
            .map(|st| (s(st, "id").as_str().unwrap_or_default().to_string(), st.clone()))
            .collect();
        m.session = session;
        m.cloud = cloud;
        m.network = network;
        m.keyboards = s(&keys, "keyboards").as_array().map(Vec::len).unwrap_or(0);
    }

    pub fn snapshot(&self) -> Value {
        self.mirror.lock().unwrap().snapshot()
    }

    /// One of the Rust wadd's events, as the Python wadd's events it stands
    /// for (none, or several).
    pub fn translate(&self, event: &str, data: &Value) -> Vec<(String, Value)> {
        let mut m = self.mirror.lock().unwrap();
        if m.take(event, data) {
            return vec![("state".into(), m.snapshot())];
        }
        drop(m);
        match event {
            "build" => vec![("build".into(), flatten(build_py(s(data, "build")), data))],
            "launch" => vec![("launch".into(), flatten(launch_py(s(data, "launch")), data))],
            "projects" | "notice" | "streams" => vec![(event.into(), data.clone())],
            _ => vec![],
        }
    }

    /// Follows /v1/events until it drops; `emit` gets the Python-shaped
    /// events, a snapshot first.
    pub async fn stream_once(&self, mut emit: impl FnMut(String, Value)) -> Result<(), String> {
        self.prime().await;
        emit("state".into(), self.snapshot());
        let mut res = self
            .http
            .get("http://wadd/v1/events")
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("status {}", res.status()));
        }
        let mut parser = crate::wadd::SseParser::default();
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            for (event, data) in parser.push(&chunk) {
                let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                for (e, d) in self.translate(&event, &data) {
                    emit(e, d);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
