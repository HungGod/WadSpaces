//! wadd's API on a real socket: the right callers get answers, others 403,
//! and events stream.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use wad_config::{Config, Profile};
use wad_proto::v1::{Display, Workspace};
use wadd::logbuf::LogBuffer;
use wadd::{Listen, Server};

async fn start(allow_self: bool) -> (tempfile::TempDir, std::path::PathBuf, tokio::sync::oneshot::Sender<()>) {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("wadd.sock");
    let mut cfg = Config::defaults(Profile::User);
    cfg.machine.name = "test-machine".into();
    cfg.daemon.state_dir = dir.path().join("state");
    std::fs::create_dir_all(&cfg.daemon.state_dir).unwrap();
    let list = vec![workspace("writing")];
    std::fs::write(cfg.daemon.state_dir.join("workspaces.json"), serde_json::to_string(&list).unwrap()).unwrap();
    cfg.daemon.legacy_config = dir.path().join("none.yaml");
    let offline = Arc::new(wadd::backend::Offline("no machine in tests".into()));
    let mut server =
        Server::new(&cfg, Profile::User, Listen::Path(sock.clone()), LogBuffer::new(100), offline).unwrap();
    if !allow_self {
        // As if wadd ran as someone else: this test's user isn't allowed.
        let state = Arc::get_mut(&mut server.state).unwrap();
        state.policy.own_uid = u32::MAX - 1;
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(server.run(async move {
        let _ = rx.await;
    }));
    (dir, sock, tx)
}

fn workspace(id: &str) -> Workspace {
    Workspace {
        id: id.into(),
        name: "Writing".into(),
        image: "ghcr.io/o/writing:1".into(),
        display: Display::Host,
        port: None,
        hotkey: None,
        icon: None,
        enabled: true,
        autostart: false,
        container_name: format!("wad-{id}"),
        container_port: 3000,
        env: vec![],
        secrets: vec![],
        volumes: vec![],
        devices: vec![],
        shm_size: None,
        projects: vec![],
    }
}

/// One HTTP/1.1 request over the socket; the status and body.
async fn request(sock: &std::path::Path, method: &str, path: &str) -> (u16, String) {
    let mut s = UnixStream::connect(sock).await.unwrap();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: wadd\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    let status = buf[9..12].parse().unwrap();
    let body = buf.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    (status, body)
}

async fn get(sock: &std::path::Path, path: &str) -> (u16, String) {
    request(sock, "GET", path).await
}

#[tokio::test]
async fn allowed_callers_get_answers() {
    let (_d, sock, stop) = start(true).await;
    let (status, body) = get(&sock, "/v1/health").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(r#""ok":true"#), "{body}");
    let (status, body) = get(&sock, "/v1/machine").await;
    assert_eq!(status, 200);
    assert!(body.contains(r#""name":"test-machine""#) && body.contains(r#""profile":"user""#), "{body}");
    let (status, body) = get(&sock, "/v1/nope").await;
    assert_eq!(status, 404);
    assert!(body.contains(r#""code":"not_found""#), "{body}");
    let _ = stop.send(());
}

#[tokio::test]
async fn others_are_refused() {
    let (_d, sock, stop) = start(false).await;
    let (status, body) = get(&sock, "/v1/health").await;
    assert_eq!(status, 403, "{body}");
    assert!(body.contains(r#""code":"forbidden""#), "{body}");
    let _ = stop.send(());
}

#[tokio::test]
async fn events_start_with_the_current_state() {
    let (_d, sock, stop) = start(true).await;
    let mut s = UnixStream::connect(&sock).await.unwrap();
    s.write_all(b"GET /v1/events HTTP/1.1\r\nHost: wadd\r\n\r\n").await.unwrap();
    let mut got = String::new();
    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !got.contains("\n\n") || !got.contains("event: machine") {
        let n = tokio::time::timeout_at(deadline, s.read(&mut buf)).await.expect("no event in time").unwrap();
        assert!(n > 0, "closed: {got}");
        got.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    assert!(got.contains("text/event-stream"), "{got}");
    assert!(got.contains(r#"data: {"name":"test-machine""#), "{got}");
    while !got.contains("event: workspaceState") {
        let n = tokio::time::timeout_at(deadline, s.read(&mut buf)).await.expect("no state in time").unwrap();
        assert!(n > 0, "closed: {got}");
        got.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    assert!(got.contains(r#""id":"writing""#), "{got}");
    let _ = stop.send(());
}

#[tokio::test]
async fn workspaces_start_and_say_why_they_failed() {
    let (_d, sock, stop) = start(true).await;
    let (status, body) = get(&sock, "/v1/workspaces").await;
    assert_eq!(status, 200);
    assert!(body.contains(r#""id":"writing""#), "{body}");
    let (status, body) = get(&sock, "/v1/states").await;
    assert_eq!(status, 200);
    assert!(body.contains(r#""phase":"idle""#), "{body}");
    let (status, body) = request(&sock, "POST", "/v1/workspaces/nope/start").await;
    assert_eq!(status, 404, "{body}");
    let (status, body) = request(&sock, "POST", "/v1/workspaces/writing/start").await;
    assert_eq!(status, 202, "{body}");
    // No machine here: the bring-up fails, and the state says so.
    for _ in 0..100 {
        let (_, body) = get(&sock, "/v1/workspaces/writing/state").await;
        if body.contains(r#""phase":"error""#) {
            assert!(body.contains("no machine in tests"), "{body}");
            let _ = stop.send(());
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never failed");
}

#[tokio::test]
async fn the_socket_is_private_on_a_laptop_and_removed_on_exit() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, sock, stop) = start(true).await;
    let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let _ = stop.send(());
    for _ in 0..50 {
        if !sock.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("socket left behind");
}
