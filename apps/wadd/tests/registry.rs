//! The workspace lifecycle against a fake machine, with time paused.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Fake, ws};
use wad_config::Prefetch;
use wad_proto::v1::{Display, Event, Phase, Workspace};
use wadd::events::Bus;
use wadd::registry::{Registry, Settings};

struct Setup {
    reg: Arc<Registry>,
    fake: Fake,
    bus: Bus,
    _dir: tempfile::TempDir,
}

async fn setup(list: Vec<Workspace>, pulls: usize) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::default();
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
            ready_timeout: Duration::from_secs(30),
            max_parallel_pulls: pulls,
            projects_dir: "/p".into(),
            state_dir: dir.path().into(),
            rootless_uid: Some(1000),
            poll: Duration::from_secs(1),
        },
    );
    reg.load(list).await.unwrap();
    Setup { reg, fake, bus, _dir: dir }
}

fn phase(s: &Setup, id: &str) -> Phase {
    s.reg.state(id).unwrap().phase
}

#[tokio::test(start_paused = true)]
async fn a_cold_start_pulls_starts_and_waits_for_the_stream() {
    let s = setup(vec![ws("a", "ghcr.io/o/a:1", Display::Stream, Some(3100))], 3).await;
    s.fake.with(|m| {
        m.answering.insert("http://127.0.0.1:3100/".into());
        m.answer_after = 2;
    });
    let (_, mut rx) = s.bus.subscribe();
    s.reg.start("a").unwrap();
    s.reg.settled("a").await;
    let st = s.reg.state("a").unwrap();
    assert_eq!(st.phase, Phase::Ready, "{st:?}");
    assert_eq!(st.container, "running");
    assert_eq!(st.image_present, Some(true));
    assert_eq!(s.fake.calls(), ["pull ghcr.io/o/a:1", "start wad-a.service"]);
    // On the way: the download, with progress.
    let mut phases = vec![];
    let mut saw_progress = false;
    while let Ok(Event::WorkspaceState(e)) = rx.try_recv() {
        if phases.last() != Some(&e.phase) {
            phases.push(e.phase);
        }
        saw_progress |= e.download.is_some();
    }
    assert_eq!(phases, [Phase::Pulling, Phase::Starting, Phase::Waiting, Phase::Ready]);
    assert!(saw_progress);
    // A run opened with the container.
    let runs = wad_store::State::new(s._dir.path()).runs(None, 10);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].mode, "stream");
}

#[tokio::test(start_paused = true)]
async fn a_warm_start_neither_pulls_nor_starts() {
    let s = setup(vec![ws("b", "ghcr.io/o/b:1", Display::Host, None)], 3).await;
    s.fake.with(|m| {
        m.images.insert("ghcr.io/o/b:1".into());
        m.containers.insert("wad-b".into(), "running".into());
    });
    s.reg.start("b").unwrap();
    s.reg.settled("b").await;
    assert_eq!(phase(&s, "b"), Phase::Ready);
    assert!(s.fake.calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn failures_say_why() {
    let s = setup(
        vec![
            ws("local", "localhost/wadspaces-local:latest", Display::Host, None),
            ws("bad", "ghcr.io/o/bad:1", Display::Host, None),
            ws("slow", "ghcr.io/o/slow:1", Display::Stream, Some(3101)),
        ],
        3,
    )
    .await;
    s.reg.start("local").unwrap();
    s.reg.settled("local").await;
    let st = s.reg.state("local").unwrap();
    assert_eq!(st.phase, Phase::Error);
    assert!(st.error.unwrap().contains("local-only"));

    s.fake.with(|m| m.pull_fails = Some("manifest unknown".into()));
    s.reg.start("bad").unwrap();
    s.reg.settled("bad").await;
    assert_eq!(s.reg.state("bad").unwrap().error.as_deref(), Some("manifest unknown"));

    s.fake.with(|m| {
        m.pull_fails = None;
        m.images.insert("ghcr.io/o/slow:1".into());
    });
    s.reg.start("slow").unwrap();
    s.reg.settled("slow").await;
    let st = s.reg.state("slow").unwrap();
    assert_eq!(st.phase, Phase::Error);
    assert_eq!(st.error.as_deref(), Some("SLOW didn't answer within 30 s"));
    // A new phase clears the old error.
    s.fake.with(|m| {
        m.answering.insert("http://127.0.0.1:3101/".into());
    });
    s.reg.start("slow").unwrap();
    s.reg.settled("slow").await;
    let st = s.reg.state("slow").unwrap();
    assert_eq!((st.phase, st.error), (Phase::Ready, None));
}

#[tokio::test(start_paused = true)]
async fn stop_and_restart() {
    let s = setup(vec![ws("c", "ghcr.io/o/c:1", Display::Host, None)], 3).await;
    s.fake.with(|m| {
        m.images.insert("ghcr.io/o/c:1".into());
    });
    s.reg.start("c").unwrap();
    s.reg.settled("c").await;
    s.reg.stop("c").await.unwrap();
    let st = s.reg.state("c").unwrap();
    assert_eq!((st.phase, st.container.as_str()), (Phase::Idle, "missing"));
    s.reg.restart("c").await.unwrap();
    s.reg.settled("c").await;
    assert_eq!(phase(&s, "c"), Phase::Ready);
    assert_eq!(s.fake.calls(), ["start wad-c.service", "stop wad-c.service", "restart wad-c.service"]);
    let runs = wad_store::State::new(s._dir.path()).runs(None, 10);
    assert_eq!(runs.len(), 2); // stopped, then running again
    assert!(s.reg.stop("nope").await.is_err());
}

#[tokio::test(start_paused = true)]
async fn reconcile_sees_what_happened_elsewhere() {
    let s = setup(vec![ws("d", "ghcr.io/o/d:1", Display::Stream, Some(3102))], 3).await;
    s.fake.with(|m| {
        m.images.insert("ghcr.io/o/d:1".into());
        m.containers.insert("wad-d".into(), "running".into());
        m.answering.insert("http://127.0.0.1:3102/".into());
    });
    s.reg.reconcile().await;
    let st = s.reg.state("d").unwrap();
    assert_eq!((st.phase, st.image_present), (Phase::Ready, Some(true)));
    s.fake.with(|m| {
        m.containers.insert("wad-d".into(), "exited".into());
    });
    s.reg.reconcile().await;
    let st = s.reg.state("d").unwrap();
    assert_eq!((st.phase, st.container.as_str()), (Phase::Idle, "exited"));
}

#[tokio::test(start_paused = true)]
async fn downloads_wait_their_turn() {
    let s =
        setup(vec![ws("e", "ghcr.io/o/e:1", Display::Host, None), ws("f", "ghcr.io/o/f:1", Display::Host, None)], 1)
            .await;
    let (r1, r2) = (s.reg.clone(), s.reg.clone());
    let first = tokio::spawn(async move { r1.download("e").await });
    tokio::time::sleep(Duration::from_millis(10)).await;
    let second = tokio::spawn(async move { r2.download("f").await });
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(s.reg.state("f").unwrap().message.as_deref(), Some("waiting for another download to finish"));
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    for id in ["e", "f"] {
        let st = s.reg.state(id).unwrap();
        assert_eq!((st.phase, st.image_present), (Phase::Idle, Some(true)), "{id}");
    }
}

#[tokio::test(start_paused = true)]
async fn units_are_written_for_every_workspace() {
    let s = setup(vec![ws("g", "ghcr.io/o/g:1", Display::Host, None)], 3).await;
    let units = s.fake.0.lock().unwrap().units.clone();
    assert_eq!(units.len(), 1);
    assert_eq!(units[0].0, "wad-g.container");
    assert!(
        units[0].1.contains("UIDMap=1000:0:1") && units[0].1.contains("Volume=/run/user/1000:/run/wadspaces-display")
    );
}

#[tokio::test(start_paused = true)]
async fn prefetch_starts_autostart_first_then_downloads_while_disk_allows() {
    let mut boot = ws("boot", "ghcr.io/o/boot:1", Display::Host, None);
    boot.autostart = true;
    let s = setup(
        vec![
            ws("big", "ghcr.io/o/big:1", Display::Host, None),
            boot,
            ws("off", "ghcr.io/o/off:1", Display::Host, None),
        ],
        3,
    )
    .await;
    s.fake.with(|m| m.free_gb = 100.0);
    {
        let mut list = s.reg.workspaces();
        list[2].enabled = false;
        s.reg.load(list).await.unwrap();
    }
    s.reg.clone().prefetch(Prefetch::All, 15, Duration::from_secs(300)).await;
    assert_eq!(s.fake.calls(), ["pull ghcr.io/o/boot:1", "start wad-boot.service", "pull ghcr.io/o/big:1"]);
    assert_eq!(phase(&s, "boot"), Phase::Ready);
    assert_eq!(phase(&s, "big"), Phase::Idle);

    // Short on disk: only what starts at boot.
    let s = setup(vec![ws("big", "ghcr.io/o/big:1", Display::Host, None)], 3).await;
    s.fake.with(|m| m.free_gb = 10.0);
    s.reg.clone().prefetch(Prefetch::All, 15, Duration::from_secs(300)).await;
    assert!(s.fake.calls().is_empty());
    s.reg.clone().prefetch(Prefetch::Autostart, 15, Duration::from_secs(300)).await;
    assert!(s.fake.calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn prefetch_retries_what_failed() {
    let s = setup(vec![ws("flaky", "ghcr.io/o/flaky:1", Display::Host, None)], 3).await;
    s.fake.with(|m| {
        m.free_gb = 100.0;
        m.pull_fails = Some("network down".into());
    });
    let task = tokio::spawn(s.reg.clone().prefetch(Prefetch::All, 15, Duration::from_secs(300)));
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(s.reg.state("flaky").unwrap().error.as_deref(), Some("download failed: network down"));
    s.fake.with(|m| m.pull_fails = None);
    task.await.unwrap();
    assert_eq!(s.reg.state("flaky").unwrap().image_present, Some(true));
    assert_eq!(s.fake.calls().len(), 2);
}
