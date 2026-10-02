//! The Rust wadd behind the UI's calls: every call `src/lib/wadd.ts` makes
//! is answered (the parity checklist), and the answers have the shapes the
//! UI reads. A real Rust wadd runs in-process on a temporary socket, with no
//! machine under it (no podman), as wadd's own API tests do.

use std::sync::Arc;

use serde_json::{Value, json};
use wad_config::{Config, Profile};
use wad_proto::v1::{Display, Workspace};
use wadd::logbuf::LogBuffer;
use wadd::{Listen, Server};

use super::*;

struct Env {
    _d: tempfile::TempDir,
    rs: RsWadd,
    _stop: tokio::sync::oneshot::Sender<()>,
}

fn workspace(id: &str, display: Display, port: Option<u16>, hotkey: u8) -> Workspace {
    Workspace {
        id: id.into(),
        name: id.to_uppercase(),
        image: format!("ghcr.io/o/{id}:1"),
        display,
        port,
        hotkey: Some(hotkey),
        icon: None,
        enabled: true,
        autostart: false,
        container_name: format!("wad-{id}"),
        container_port: 3000,
        env: vec![("PUID".into(), "1000".into())],
        secrets: vec![],
        volumes: vec![],
        devices: vec![],
        shm_size: Some("1g".into()),
        projects: vec![],
    }
}

async fn env() -> Env {
    let d = tempfile::tempdir().unwrap();
    let sock = d.path().join("wadd.sock");
    let mut cfg = Config::defaults(Profile::User);
    cfg.machine.name = "parity".into();
    cfg.daemon.state_dir = d.path().join("state");
    cfg.daemon.legacy_config = d.path().join("none.yaml");
    cfg.daemon.projects_dir = d.path().join("projects");
    cfg.display.enabled = false;
    cfg.cloud.enabled = false;
    std::fs::create_dir_all(&cfg.daemon.state_dir).unwrap();
    let list = vec![workspace("writing", Display::Host, None, 1), workspace("stream", Display::Stream, Some(3100), 2)];
    std::fs::write(cfg.daemon.state_dir.join("workspaces.json"), serde_json::to_string(&list).unwrap()).unwrap();
    let offline = Arc::new(wadd::backend::Offline("no machine in tests".into()));
    let server = Server::new(&cfg, Profile::User, Listen::Path(sock.clone()), LogBuffer::new(100), offline).unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(server.run(async move {
        let _ = rx.await;
    }));
    for _ in 0..100 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Env { _d: d, rs: RsWadd::new(sock), _stop: tx }
}

/// Every call in src/lib/wadd.ts: (method, path) with sample values for the
/// template's `${...}` parts.
fn ui_calls() -> Vec<(String, String)> {
    let src = include_str!("../../../src/lib/wadd.ts");
    let sample = |expr: &str| -> &str {
        match expr {
            e if e.contains("action") => "switch",
            e if e.contains("(id)") => "writing",
            e if e.contains("collection") => "drafts",
            e if e.contains("(unit)") => "wadd",
            "since" => "0",
            "limit" => "5",
            "lines" => "10",
            _ => "",
        }
    };
    let mut out = vec![];
    for (i, _) in src.match_indices("call<") {
        let rest = &src[i..];
        // A call: `call<T>("METHOD", path ...)` (not call's own definition).
        let Some(open) = rest.find(">(\"").filter(|o| *o < 120) else { continue };
        let args = &rest[open + 3..];
        let method = &args[..args.find('"').unwrap()];
        let after = &args[method.len() + 1..];
        let after = after.trim_start_matches([',', ' ']);
        let quote = after.chars().next().unwrap();
        // The literal, with each `${expr}` (which may hold templates of its
        // own) swapped for a sample value.
        let mut path = String::new();
        let mut expr = String::new();
        let mut depth = 0;
        let mut chars = after[1..].chars().peekable();
        while let Some(c) = chars.next() {
            match (depth, c) {
                (0, c) if c == quote => break,
                (0, '$') if quote == '`' && chars.peek() == Some(&'{') => {
                    chars.next();
                    depth = 1;
                }
                (0, c) => path.push(c),
                (_, '{') => {
                    depth += 1;
                    expr.push(c);
                }
                (1, '}') => {
                    depth = 0;
                    path.push_str(sample(&std::mem::take(&mut expr)));
                }
                (_, c) => {
                    if c == '}' {
                        depth -= 1;
                    }
                    expr.push(c);
                }
            }
        }
        out.push((method.to_string(), path));
    }
    out
}

fn method(m: &str) -> Method {
    match m {
        "GET" => Method::Get,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        _ => Method::Delete,
    }
}

/// What the UI might send with each call (enough to get past the router).
fn body_for(m: &str, path: &str) -> Option<Value> {
    Some(match (m, path) {
        ("POST", "/api/session") => json!({"workspaces": ["writing"], "minutes": 25}),
        ("POST", "/api/enroll") => json!({"code": "ABC123"}),
        ("POST", "/api/workspaces") | ("PUT", "/api/workspaces/writing") => {
            json!({"id": "writing", "name": "W", "image": "i", "display": "host"})
        }
        ("POST", "/api/network/wifi/connect") | ("POST", "/api/network/wifi/forget") => json!({"ssid": "Home"}),
        ("POST", "/api/power") => json!({"action": "reboot"}),
        ("POST", "/api/builds") => json!({"workspace": {}, "base_image": "x"}),
        ("POST", "/api/projects") | ("PUT", "/api/projects/writing") => {
            json!({"name": "N", "mountName": "N", "source": {"kind": "git", "url": "https://github.com/o/n"}})
        }
        ("POST", "/api/github/repos") => json!({"name": "n"}),
        ("POST", "/api/launches") => json!({"workspace": "writing", "projects": []}),
        ("PUT", p) if p.starts_with("/api/library/") => json!({"name": "doc"}),
        _ => return None,
    })
}

/// Parked on purpose (the plan): the UI hides what needs them.
const NOT_HERE: [&str; 1] = ["/api/tailnet"];

#[tokio::test]
async fn every_call_the_ui_makes_is_answered() {
    let e = env().await;
    let calls = ui_calls();
    assert!(calls.len() >= 44, "only {} calls found in lib/wadd.ts", calls.len());
    let mut gaps = vec![];
    for (m, path) in &calls {
        // Not power: that would ask logind (there's none here, but still).
        let r = e.rs.request(method(m), path, body_for(m, path)).await;
        if let Err(f) = &r {
            let parked = NOT_HERE.iter().any(|p| path.starts_with(p));
            if f.message.contains("on this machine's wadd") && !f.message.contains("builds from the design") && !parked
            {
                gaps.push(format!("{m} {path}: {}", f.message));
            }
        }
    }
    assert!(gaps.is_empty(), "calls the Rust wadd doesn't answer:\n{}", gaps.join("\n"));
}

#[tokio::test]
async fn the_snapshot_has_the_python_shape() {
    let e = env().await;
    let mut got = vec![];
    // One turn of the stream: the snapshot it starts with.
    let rs = &e.rs;
    let _ =
        tokio::time::timeout(std::time::Duration::from_millis(500), rs.stream_once(|ev, d| got.push((ev, d)))).await;
    let (ev, snap) = got.first().cloned().unwrap();
    assert_eq!(ev, "state");
    assert_eq!(
        (snap["machine"].as_str(), snap["view"].as_str(), snap["enrolled"].as_bool()),
        (Some("parity"), Some("launcher"), Some(false))
    );
    let ws = snap["workspaces"].as_array().unwrap();
    assert_eq!(ws.len(), 2);
    assert_eq!(
        (ws[0]["id"].as_str(), ws[0]["display"].as_str(), &ws[0]["url"]),
        (Some("writing"), Some("host"), &Value::Null)
    );
    assert_eq!(ws[1]["url"], "http://127.0.0.1:3100/");
    let st = &ws[0]["state"];
    for k in ["container", "phase", "progress", "message", "error", "image_present", "download", "since"] {
        assert!(st.get(k).is_some(), "state has no {k}: {st}");
    }
    assert!(snap["network"].is_object() && snap.get("session").is_some() && snap.get("pending").is_some());
    // A session event comes through as a new snapshot with the Python session.
    let out = e.rs.translate("session", &json!({"mode": "focus", "workspaces": ["writing"], "minutes": 25, "startedAt": 1.0, "endsAt": null, "expired": false}));
    assert_eq!(out[0].1["session"]["started_at"], 1.0);
    assert_eq!(out[0].1["session"]["remaining_s"], Value::Null);
    // Builds and launches flattened, as the Python wadd sent them.
    let b = e.rs.translate(
        "build",
        &json!({"build": {"id": "b1", "wsId": "w", "status": "building", "updated": true}, "from": 3, "lines": ["x"]}),
    );
    assert_eq!(
        (b[0].0.as_str(), &b[0].1["installed"], &b[0].1["from"], &b[0].1["lines"]),
        ("build", &json!(true), &json!(3), &json!(["x"]))
    );
    assert!(e.rs.translate("carousel", &json!({})).is_empty()); // the HUD's
}

#[tokio::test]
async fn shapes_the_ui_reads() {
    let e = env().await;
    let r = |m: Method, p: &'static str, b: Option<Value>| e.rs.request(m, p, b);
    // Specs: workspaces.yaml's shape.
    let specs = r(Method::Get, "/api/specs", None).await.unwrap();
    assert_eq!(specs[0]["container_name"], "wad-writing");
    assert_eq!(specs[0]["env"]["PUID"], "1000");
    // A session, then ending it (forced: it's a focus one).
    let sess = r(Method::Post, "/api/session", Some(json!({"workspaces": ["writing"], "minutes": 25}))).await.unwrap();
    assert_eq!((sess["mode"].as_str(), sess["minutes"].as_u64()), (Some("focus"), Some(25)));
    assert_eq!(r(Method::Post, "/api/session/end", None).await.unwrap_err().status, 409);
    r(Method::Post, "/api/session/end", Some(json!({"force": true}))).await.unwrap();
    // A workspace edited as a spec, answered as one.
    let up = r(
        Method::Put,
        "/api/workspaces/writing",
        Some(json!({"id": "writing", "name": "Writing 2", "image": "i", "display": "host", "hotkey": 1})),
    )
    .await
    .unwrap();
    assert_eq!((up["workspace"]["name"].as_str(), up["restart_required"].as_bool()), (Some("Writing 2"), Some(false)));
    assert_eq!(
        r(
            Method::Put,
            "/api/workspaces/writing",
            Some(json!({"id": "writing", "name": "W", "image": "i", "display": "host", "hotkey": 2}))
        )
        .await
        .unwrap_err()
        .status,
        422
    ); // stream has hotkey 2
    // Projects and their status.
    let p = r(Method::Post, "/api/projects", Some(json!({"name": "Notes", "mountName": "Notes", "source": {"kind": "git", "url": "https://github.com/o/notes"}}))).await.unwrap();
    let id = p["id"].as_str().unwrap().to_string();
    let st = e.rs.request(Method::Get, &format!("/api/projects/{id}/status"), None).await.unwrap();
    assert_eq!((st["exists_on_disk"].as_bool(), st["available"].as_bool()), (Some(false), Some(true)));
    let gone = e.rs.request(Method::Delete, &format!("/api/projects/{id}?purge=1"), None).await.unwrap();
    assert_eq!((gone["deleted"].as_bool(), gone["purged"].as_bool()), (Some(true), Some(false)));
    // Builds: the Rust wadd builds from the design.
    assert_eq!(r(Method::Post, "/api/builds", Some(json!({}))).await.unwrap_err().status, 409);
    let b = r(Method::Post, "/api/builds/design", Some(json!({"design": {"id": "trybuild", "name": "T", "layout": {"wallpaper": {"type": "color", "value": "#000"}, "icons": []}, "advanced": {"display": "host", "hotkey": 3}}}))).await.unwrap();
    assert_eq!((b["wsId"].as_str(), b["installed"].as_bool()), (Some("trybuild"), Some(false)));
    // Diagnostics, logs, secrets: the Python names.
    let d = r(Method::Get, "/api/diagnostics", None).await.unwrap();
    assert_eq!(d["kiosk"]["view"], "launcher");
    assert!(d["disk"]["free_bytes"].as_u64().is_some() && d["podman"]["error"] == "no machine in tests");
    assert!(r(Method::Get, "/api/logs/daemon?lines=5", None).await.unwrap()["lines"].is_array());
    assert_eq!(r(Method::Get, "/api/secrets", None).await.unwrap_err().status, 503);
    // Tailscale is parked.
    assert_eq!(r(Method::Get, "/api/tailnet", None).await.unwrap_err().status, 404);
}
