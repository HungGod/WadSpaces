//! Streams (viewing a workspace from another device): they fail closed, and
//! the person at the machine wins.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Fake, ws};
use wad_proto::ErrorCode;
use wad_proto::v1::{Display, Phase};
use wadd::display::NullDisplay;
use wadd::events::Bus;
use wadd::registry::{Registry, Settings};
use wadd::streams::{SIDECAR_PASSWORD, Streams};
use wadd::view::View;

const IMAGE: &str = "localhost/wadspaces-writing:latest";
const SIDECAR: &str = "localhost/wadspaces-stream:trixie";
const PORT: u16 = 47800;

struct Env {
    _d: tempfile::TempDir,
    fake: Fake,
    reg: Arc<Registry>,
    view: Arc<View>,
    streams: Arc<Streams>,
}

async fn env() -> Env {
    let d = tempfile::tempdir().unwrap();
    let state = d.path().join("state");
    let fake = Fake::default();
    fake.with(|m| {
        m.images.insert(IMAGE.into());
        m.images.insert(SIDECAR.into());
    });
    let bus = Bus::new(wad_proto::v1::MachineInfo {
        name: "t".into(),
        version: "0".into(),
        profile: wad_proto::v1::Profile::User,
        started_at: 0,
    });
    let reg = Registry::new(
        Arc::new(fake.clone()),
        bus.clone(),
        Settings {
            ready_timeout: Duration::from_secs(5),
            max_parallel_pulls: 1,
            projects_dir: "/p".into(),
            state_dir: state.clone(),
            rootless_uid: None,
            poll: Duration::from_millis(10),
        },
    );
    let mut writing = ws("writing", IMAGE, Display::Host, None);
    writing.devices = vec!["/dev/dri".into()];
    let streamed_old = ws("old", "localhost/wadspaces-selkies-x:1", Display::Stream, Some(3100));
    reg.load(vec![writing, streamed_old]).await.unwrap();
    let view = View::new(reg.clone(), Arc::new(fake.clone()), Arc::new(NullDisplay), bus.clone(), state.clone());
    let streams =
        Streams::new(wad_config::Streams::default(), reg.clone(), Arc::new(fake.clone()), bus, &state, "Surface");
    Env { _d: d, fake, reg, view, streams }
}

fn set_password(e: &Env, pw: &str) {
    e.fake.with(|m| {
        m.secrets.insert("stream_password".into(), pw.as_bytes().to_vec());
    });
}

fn unit_names(e: &Env) -> Vec<String> {
    let mut n: Vec<String> = e.fake.0.lock().unwrap().units.iter().map(|u| u.0.clone()).collect();
    n.sort();
    n
}

async fn ready(e: &Env, id: &str) {
    for _ in 0..300 {
        if e.reg.state(id).is_some_and(|s| s.phase == Phase::Ready) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{id} never got ready: {:?}", e.reg.state(id));
}

#[tokio::test]
async fn nothing_streams_until_its_allowed_here_with_a_good_password() {
    let e = env().await;
    let refused = |r: Result<u16, wad_proto::ApiError>| r.unwrap_err();
    // Not allowed here (the default).
    set_password(&e, "a long enough password");
    let err = refused(e.streams.prepare("writing", false).await);
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(err.message.contains("off on Surface"), "{}", err.message);
    let st = e.streams.status().await;
    assert!(!st.allow_remote && st.problem.is_some());

    e.streams.set_allow_remote(true).await.unwrap();
    // No password, a placeholder, a short one.
    for pw in [None, Some("\n"), Some("short pw")] {
        e.fake.with(|m| {
            m.secrets.remove("stream_password");
        });
        if let Some(p) = pw {
            set_password(&e, p);
        }
        let err = refused(e.streams.prepare("writing", false).await);
        assert!(err.message.contains("stream password"), "{pw:?}: {}", err.message);
        assert!(!e.streams.status().await.password_set);
    }
    set_password(&e, "a long enough password");
    // Without the sidecar's image.
    e.fake.with(|m| {
        m.images.remove(SIDECAR);
    });
    assert!(refused(e.streams.prepare("writing", false).await).message.contains("isn't on this machine"));
    e.fake.with(|m| {
        m.images.insert(SIDECAR.into());
    });
    // Only native workspaces (the old all-in-one Selkies ones stay local).
    assert_eq!(refused(e.streams.prepare("old", false).await).code, ErrorCode::BadRequest);
    // Nothing was drawn anywhere else meanwhile.
    assert!(e.reg.streamed().is_empty());
    assert!(!unit_names(&e).iter().any(|n| n.contains("display")));
}

#[tokio::test]
async fn a_stream_runs_on_its_sidecar_with_a_copy_of_the_password() {
    let e = env().await;
    e.streams.set_allow_remote(true).await.unwrap();
    set_password(&e, "correct horse battery staple\n");
    e.streams.set_user(Some("hunggod".into()));
    e.fake.with(|m| {
        m.open_ports.insert(PORT);
    });
    let st = e.streams.start("writing", false).await.unwrap();
    assert!(st.allow_remote && st.password_set && st.problem.is_none());
    ready(&e, "writing").await;
    assert_eq!(
        unit_names(&e),
        ["wad-old.container", "wad-writing-display.container", "wad-writing-display.volume", "wad-writing.container"]
    );
    let units = e.fake.0.lock().unwrap().units.clone();
    let display = &units.iter().find(|u| u.0 == "wad-writing-display.container").unwrap().1;
    assert!(display.contains(&format!("PublishPort={PORT}:3001")) && display.contains("CUSTOM_USER=hunggod"));
    // The sidecar's copy is trimmed (nginx would take the newline as part of it).
    let copy = e.fake.0.lock().unwrap().secrets.get(SIDECAR_PASSWORD).cloned().unwrap();
    assert_eq!(copy, b"correct horse battery staple");
    // Listed, with the certificate to pin, and never the password.
    let s = &e.streams.list()[0];
    assert_eq!((s.ws_id.as_str(), s.port, s.user.as_str(), s.ready), ("writing", PORT, "hunggod", true));
    assert_eq!(Some(s.sha256.clone()), e.streams.cert.info().map(|i| i.sha256));
    assert!(s.urls.iter().all(|u| u.starts_with("https://") && u.ends_with(&format!(":{PORT}/"))));
    assert!(!serde_json::to_string(&e.streams.status().await).unwrap().contains("battery"));

    // Ended: stopped (both containers), and drawn on the screen again.
    e.streams.stop("writing").await.unwrap();
    let calls = e.fake.0.lock().unwrap().calls.clone();
    assert!(calls.contains(&"stop wad-writing.service".to_string()));
    assert!(calls.contains(&"stop wad-writing-display.service".to_string()));
    assert_eq!(unit_names(&e), ["wad-old.container", "wad-writing.container"]);
    assert!(e.streams.list().is_empty());
    // The port is kept for next time.
    e.streams.start("writing", false).await.unwrap();
    ready(&e, "writing").await;
    assert_eq!(e.streams.list()[0].port, PORT);
}

#[tokio::test]
async fn the_person_at_the_machine_wins() {
    let e = env().await;
    e.streams.set_allow_remote(true).await.unwrap();
    set_password(&e, "a long enough password");
    e.fake.with(|m| {
        m.open_ports.insert(PORT);
    });
    // Open on the screen: a stream only takes it off when asked to.
    e.fake.with(|m| {
        m.containers.insert("wad-writing".into(), "running".into());
    });
    e.reg.reconcile().await;
    let err = e.streams.prepare("writing", false).await.unwrap_err();
    assert!(err.message.contains("open on Surface's screen"), "{}", err.message);
    e.streams.start("writing", true).await.unwrap();
    ready(&e, "writing").await;
    assert_eq!(e.reg.streamed(), ["writing"]);
    // Switching to it at the machine brings it back to the screen.
    e.view.switch("writing").unwrap();
    for _ in 0..300 {
        if e.reg.streamed().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(e.reg.streamed().is_empty());
    assert!(!unit_names(&e).iter().any(|n| n.contains("display")));
}

#[tokio::test]
async fn turning_it_off_or_changing_the_password_ends_streams() {
    let e = env().await;
    e.streams.set_allow_remote(true).await.unwrap();
    set_password(&e, "a long enough password");
    e.fake.with(|m| {
        m.open_ports.insert(PORT);
    });
    e.streams.start("writing", false).await.unwrap();
    e.streams.set_allow_remote(false).await.unwrap();
    assert!(e.reg.streamed().is_empty());
    assert!(e.streams.prepare("writing", false).await.is_err());

    // The watchdog: a changed (or removed) password ends the streams.
    e.streams.set_allow_remote(true).await.unwrap();
    e.streams.start("writing", false).await.unwrap();
    tokio::spawn(e.streams.clone().run(Duration::from_millis(20)));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(e.reg.streamed(), ["writing"]); // unchanged: kept
    set_password(&e, "a different long password");
    for _ in 0..100 {
        if e.reg.streamed().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(e.reg.streamed().is_empty());
}
