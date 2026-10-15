use std::time::Duration;

use serde_json::json;
use wad_proto::v1::{Event, ViewState};

use super::*;

#[test]
fn events_arrive_whole_however_the_body_is_cut() {
    let mut p = SseParser::default();
    assert!(p.push(b"event: session\nda").is_empty());
    assert_eq!(
        p.push(b"ta: null\n\n: keepalive\n\ndata: {\"a\"\r\ndata: :1}\n\n"),
        [("session".to_string(), "null".to_string()), ("message".to_string(), "{\"a\"\n:1}".to_string())]
    );
}

#[test]
fn known_events_are_typed_and_others_kept() {
    assert!(matches!(decode("session".into(), "null"), Incoming::Event(Event::Session(None))));
    assert!(
        matches!(decode("storage".into(), r#"{"measuredAt": 3.0}"#), Incoming::Event(Event::Storage { measured_at }) if measured_at == 3.0)
    );
    match decode("someday".into(), r#"{"x":1}"#) {
        Incoming::Other(name, v) => assert_eq!((name.as_str(), v), ("someday", json!({"x": 1}))),
        other => panic!("{other:?}"),
    }
}

#[test]
fn failures_say_what_wadd_said() {
    let f = Failure::from_body(404, br#"{"code":"not_found","message":"no workspace \"x\""}"#);
    assert_eq!((f.status, f.code.as_str(), f.to_string()), (404, "not_found", "no workspace \"x\"".to_string()));
    assert_eq!(Failure::from_body(502, b"").to_string(), "wadd answered 502");
}

/// Against a real wadd (no machine under it), on a temporary socket.
#[tokio::test(flavor = "multi_thread")]
async fn against_wadd() {
    use wad_config::{Config, Profile};
    let d = tempfile::tempdir().unwrap();
    let sock = d.path().join("wadd.sock");
    let mut cfg = Config::defaults(Profile::User);
    cfg.daemon.state_dir = d.path().join("state");
    cfg.daemon.vendor_workspaces = d.path().join("vendor");
    cfg.daemon.projects_dir = d.path().join("projects");
    cfg.display.enabled = false;
    cfg.cloud.enabled = false;
    std::fs::create_dir_all(&cfg.daemon.state_dir).unwrap();
    let offline = std::sync::Arc::new(wadd::backend::Offline("no machine in tests".into()));
    let server = wadd::Server::new(
        &cfg,
        Profile::User,
        wadd::Listen::Path(sock.clone()),
        wadd::logbuf::LogBuffer::new(100),
        offline,
    )
    .unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(server.run(async move {
        let _ = stopped.await;
    }));
    for _ in 0..100 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let w = Wadd::new(&sock);
    let machine: wad_proto::v1::MachineInfo = w.get("/v1/machine").await.unwrap();
    assert_eq!(machine.profile, wad_proto::v1::Profile::User);
    let missing = w.get::<Value>("/v1/workspaces/nope").await.unwrap_err();
    assert_eq!((missing.status, missing.code.as_str()), (404, "not_found"));
    assert!(w.bytes("/v1/workspaces/nope/icon").await.is_err());

    // The stream starts with the current state; a change follows.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    w.follow(move |i| tx.send(i).is_ok());
    let view = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<Incoming>| {
        let mut seen = vec![];
        while let Ok(i) = rx.try_recv() {
            if let Incoming::Event(Event::View(ViewState { view, .. })) = i {
                seen.push(view);
            }
        }
        seen
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!view(&mut rx).is_empty(), "the stream starts with the view");
    w.act(reqwest::Method::POST, "/v1/view/home", Some(&json!({}))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = view(&mut rx);
    drop(stop);
    // No wadd there: the follower says it's not connected (and keeps trying).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let nobody = Wadd::new(d.path().join("nobody.sock"));
    let h = nobody.follow(move |i| tx.send(i).is_ok());
    let first = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    assert!(matches!(first, Incoming::Disconnected), "{first:?}");
    h.abort();
}
