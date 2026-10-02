//! wadd's API on a real socket: the right callers get answers, others 403,
//! and events stream.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use wad_config::{Config, Profile};
use wadd::logbuf::LogBuffer;
use wadd::{Listen, Server};

async fn start(allow_self: bool) -> (tempfile::TempDir, std::path::PathBuf, tokio::sync::oneshot::Sender<()>) {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("wadd.sock");
    let mut cfg = Config::defaults(Profile::User);
    cfg.machine.name = "test-machine".into();
    let mut server = Server::new(&cfg, Profile::User, Listen::Path(sock.clone()), LogBuffer::new(100)).unwrap();
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

/// One HTTP/1.1 request over the socket; the status and body.
async fn get(sock: &std::path::Path, path: &str) -> (u16, String) {
    let mut s = UnixStream::connect(sock).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: wadd\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    let status = buf[9..12].parse().unwrap();
    let body = buf.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    (status, body)
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
    let _ = stop.send(());
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
