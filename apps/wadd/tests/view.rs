//! What's on screen: switching, Wad Creator, Super+Tab, sessions and native
//! windows, against a fake machine and a fake display, with time paused.

mod common;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use common::{Fake, ws};
use wad_input::Action;
use wad_proto::ErrorCode;
use wad_proto::v1::{Display, Phase, SessionMode, View as V, Workspace};
use wadd::display::{Display as Screen, WindowSink};
use wadd::events::Bus;
use wadd::registry::{Registry, Settings};
use wadd::view::View;

#[derive(Default)]
struct FakeScreen {
    calls: Mutex<Vec<String>>,
    windows: Mutex<HashSet<String>>,
}

impl FakeScreen {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn last(&self) -> Option<String> {
        self.calls().last().cloned()
    }
    fn clear(&self) {
        self.calls.lock().unwrap().clear();
    }
}

#[async_trait]
impl Screen for FakeScreen {
    async fn show_shell(&self) {
        self.calls.lock().unwrap().push("shell".into());
    }
    async fn show_native(&self, id: &str) -> bool {
        self.calls.lock().unwrap().push(format!("native:{id}"));
        self.windows.lock().unwrap().contains(id)
    }
}

struct Setup {
    view: Arc<View>,
    reg: Arc<Registry>,
    fake: Fake,
    screen: Arc<FakeScreen>,
    dir: Arc<tempfile::TempDir>,
}

fn stream(id: &str, port: u16, hotkey: u8) -> Workspace {
    let mut w = ws(id, &format!("ghcr.io/o/{id}:1"), Display::Stream, Some(port));
    w.hotkey = Some(hotkey);
    w
}

fn native(id: &str) -> Workspace {
    ws(id, &format!("ghcr.io/o/{id}:1"), Display::Host, None)
}

async fn setup_in(dir: Arc<tempfile::TempDir>, list: Vec<Workspace>, fake: Fake) -> Setup {
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
            max_parallel_pulls: 3,
            projects_dir: "/p".into(),
            state_dir: dir.path().into(),
            rootless_uid: Some(1000),
            poll: Duration::from_secs(1),
        },
    );
    for w in &list {
        let image = w.image.clone();
        let port = w.port;
        fake.with(|m| {
            m.images.insert(image);
            if let Some(p) = port {
                m.answering.insert(format!("http://127.0.0.1:{p}/"));
            }
        });
    }
    reg.load(list).await.unwrap();
    let screen = Arc::new(FakeScreen::default());
    let view = View::new(reg.clone(), Arc::new(fake.clone()), screen.clone(), bus, dir.path().into());
    Setup { view, reg, fake, screen, dir }
}

async fn setup(list: Vec<Workspace>) -> Setup {
    setup_in(Arc::new(tempfile::tempdir().unwrap()), list, Fake::default()).await
}

async fn abc() -> Setup {
    setup(vec![stream("a", 3100, 1), stream("b", 3101, 2), stream("c", 3102, 3)]).await
}

/// Lets spawned work (placing windows, bring-ups) run.
async fn settle(s: &Setup) {
    for id in ["a", "b", "c", "n", "s"] {
        s.reg.settled(id).await;
    }
    tokio::time::sleep(Duration::from_millis(5)).await;
}

fn wsv(id: &str) -> V {
    V::Workspace(id.into())
}

fn items(s: &Setup) -> Vec<V> {
    s.view.carousel_items().into_iter().map(|i| i.view).collect()
}

fn sorted(mut v: Vec<V>) -> Vec<V> {
    v.sort_by_key(|v| format!("{v:?}"));
    v
}

#[tokio::test(start_paused = true)]
async fn a_cold_switch_stays_put_until_ready() {
    let s = abc().await;
    s.fake.with(|m| m.answer_after = 3);
    s.view.switch("a").unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let st = s.view.state();
    assert_eq!((st.view, st.pending.as_deref()), (V::Home, Some("a"))); // no loading screen in between
    settle(&s).await;
    let st = s.view.state();
    assert_eq!((st.view, st.pending), (wsv("a"), None));
    assert_eq!(s.reg.state("a").unwrap().phase, Phase::Ready);
    assert_eq!(s.screen.last().as_deref(), Some("shell")); // a stream is shown by the app
}

#[tokio::test(start_paused = true)]
async fn a_warm_switch_is_instant() {
    let s = abc().await;
    s.view.switch("a").unwrap();
    settle(&s).await;
    s.view.home(false).unwrap();
    assert_eq!(s.view.current(), V::Home);
    s.view.switch("a").unwrap();
    assert_eq!(s.view.current(), wsv("a")); // no waiting on a bring-up
    assert_eq!(s.fake.calls().iter().filter(|c| c.starts_with("start")).count(), 1);
}

#[tokio::test(start_paused = true)]
async fn leaving_before_ready_doesnt_steal_the_screen() {
    let s = abc().await;
    s.fake.with(|m| m.answer_after = 3);
    s.view.switch("a").unwrap();
    s.view.home(false).unwrap(); // gave up waiting
    settle(&s).await;
    assert_eq!(s.view.current(), V::Home);
    assert_eq!(s.reg.state("a").unwrap().phase, Phase::Ready);
}

#[tokio::test(start_paused = true)]
async fn the_switcher_without_a_session_is_wad_creator_and_what_runs() {
    let s = abc().await;
    assert_eq!(items(&s), [V::Home]);
    s.view.carousel_step(true);
    assert_eq!(s.view.state().view, V::Home); // nothing to switch between: it doesn't open
    s.view.switch("a").unwrap();
    settle(&s).await;
    assert_eq!(items(&s), [wsv("a"), V::Home]);
    s.view.carousel_step(true); // lands on where you came from
    s.view.carousel_commit();
    assert_eq!(s.view.current(), V::Home);
}

#[tokio::test(start_paused = true)]
async fn the_switcher_starts_on_the_view_before_and_commits() {
    let s = abc().await;
    s.view.session_begin(&["a".into(), "b".into()], None).unwrap();
    for id in ["a", "b"] {
        s.view.switch(id).unwrap();
        settle(&s).await;
    }
    assert_eq!(s.view.current(), wsv("b"));
    let its = items(&s);
    assert_eq!(its[..2], [wsv("b"), wsv("a")]);
    s.view.carousel_step(true);
    s.view.carousel_step(true);
    s.view.carousel_step(false);
    s.view.carousel_commit();
    assert_eq!(s.view.current(), wsv("a"));
}

#[tokio::test(start_paused = true)]
async fn cancel_and_stopped_ones_last() {
    let s = abc().await;
    s.view.session_begin(&["a".into(), "b".into()], None).unwrap();
    settle(&s).await;
    s.view.stop("b").await.unwrap();
    s.view.switch("a").unwrap();
    settle(&s).await;
    let its = s.view.carousel_items();
    assert_eq!(its.last().map(|i| (i.view.clone(), i.running)), Some((wsv("b"), false)));
    s.view.carousel_step(false); // Shift+Tab: from the end
    s.view.carousel_cancel();
    assert_eq!(s.view.current(), wsv("a"));
}

#[tokio::test(start_paused = true)]
async fn stopping_whats_shown_returns_to_wad_creator() {
    let s = abc().await;
    s.view.switch("a").unwrap();
    settle(&s).await;
    s.view.stop("a").await.unwrap();
    assert_eq!(s.reg.state("a").unwrap().phase, Phase::Idle);
    assert_eq!(s.view.current(), V::Home);
}

#[tokio::test(start_paused = true)]
async fn a_focus_session_narrows_the_switcher_and_locks_the_rest() {
    let s = abc().await;
    s.view.session_begin(&["b".into(), "a".into()], Some(25)).unwrap();
    settle(&s).await;
    assert_eq!(s.view.current(), V::Home); // the landing page; picks are a Tab away
    assert_eq!(s.fake.calls().iter().filter(|c| c.starts_with("start")).count(), 2);
    assert_eq!(sorted(items(&s)), [wsv("a"), wsv("b")]); // no Wad Creator, no c
    s.view.switch("b").unwrap();
    assert_eq!(s.view.home(false).unwrap_err().code, ErrorCode::Conflict);
    assert_eq!(s.view.session_end(false).unwrap_err().code, ErrorCode::Conflict);
    // New: only the picks, until the time is up.
    assert_eq!(s.view.switch("c").unwrap_err().code, ErrorCode::Conflict);
    s.view.on_key(Action::Bound("home".into())); // swallowed
    s.view.on_key(Action::Bound("switch:c".into()));
    assert_eq!(s.view.current(), wsv("b"));
    s.view.expire_session();
    assert!(items(&s).contains(&V::Home) && !items(&s).contains(&wsv("c")));
    s.view.home(false).unwrap(); // allowed now; the picks stay until a new session
    assert!(s.view.session().is_some());
    s.view.session_end(false).unwrap();
    // No session: Wad Creator and whatever still runs.
    assert_eq!(sorted(items(&s)), sorted(vec![V::Home, wsv("a"), wsv("b")]));
}

#[tokio::test(start_paused = true)]
async fn a_focus_session_ends_early_when_asked() {
    let s = abc().await;
    s.view.session_begin(&["a".into()], Some(25)).unwrap();
    s.view.switch("a").unwrap();
    settle(&s).await;
    assert!(s.view.locked());
    s.view.session_end(true).unwrap();
    assert!(s.view.session().is_none() && !s.view.locked());
    s.view.home(false).unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_free_session_keeps_wad_creator_in_reach() {
    let s = abc().await;
    let sess = s.view.session_begin(&["a".into()], None).unwrap();
    settle(&s).await;
    assert_eq!((sess.mode, sess.ends_at), (SessionMode::Free, None));
    assert!(!s.view.locked());
    assert_eq!(sorted(items(&s)), [V::Home, wsv("a")]);
    s.view.switch("a").unwrap();
    s.view.home(false).unwrap();
    assert_eq!(s.view.tick_session(), None); // nothing to time
    assert!(!s.view.session().unwrap().expired);
    s.view.session_end(false).unwrap();
}

#[tokio::test(start_paused = true)]
async fn sessions_refuse_bad_input() {
    let s = abc().await;
    assert_eq!(s.view.session_begin(&[], Some(25)).unwrap_err().code, ErrorCode::BadRequest);
    assert_eq!(s.view.session_begin(&["a".into()], Some(0)).unwrap_err().code, ErrorCode::BadRequest);
    assert_eq!(s.view.session_begin(&["nope".into()], Some(25)).unwrap_err().code, ErrorCode::NotFound);
    s.view.session_begin(&["a".into(), "a".into()], Some(25)).unwrap();
    assert_eq!(s.view.session().unwrap().workspaces, ["a"]);
    assert_eq!(s.view.session_begin(&["b".into()], Some(25)).unwrap_err().code, ErrorCode::Conflict);
    settle(&s).await;
}

#[tokio::test(start_paused = true)]
async fn stopping_the_shown_pick_moves_to_the_next() {
    let s = abc().await;
    s.view.session_begin(&["a".into(), "b".into()], Some(25)).unwrap();
    settle(&s).await;
    s.view.switch("a").unwrap();
    s.view.stop("a").await.unwrap();
    settle(&s).await;
    assert_eq!(s.view.current(), wsv("b"));
    s.view.stop("b").await.unwrap(); // nothing left: Wad Creator, though locked
    assert_eq!(s.view.current(), V::Home);
    assert!(s.view.locked());
}

#[tokio::test(start_paused = true)]
async fn the_focus_clock_starts_when_a_pick_is_first_shown() {
    let s = abc().await;
    s.view.session_begin(&["a".into()], Some(25)).unwrap();
    settle(&s).await;
    assert_eq!(s.view.session().unwrap().ends_at, None);
    assert!(s.view.locked());
    assert_eq!(s.view.tick_session(), None);
    s.view.switch("a").unwrap();
    let left = s.view.tick_session().unwrap();
    assert!(left > Duration::from_secs(24 * 60) && left <= Duration::from_secs(25 * 60), "{left:?}");
    let first = s.view.session().unwrap().ends_at;
    s.view.home(true).unwrap();
    s.view.switch("a").unwrap();
    assert_eq!(s.view.session().unwrap().ends_at, first); // only the first time counts
}

#[tokio::test(start_paused = true)]
async fn sessions_survive_a_restart() {
    let s = abc().await;
    s.view.session_begin(&["a".into()], Some(30)).unwrap();
    settle(&s).await;
    // Saved in the Python wadd's format.
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(s.dir.path().join("session.json")).unwrap()).unwrap();
    assert_eq!(
        (saved["mode"].as_str(), saved["minutes"].as_u64(), saved["ends_at"].is_null()),
        (Some("focus"), Some(30), true)
    );
    // Before the clock starts, a restart keeps it unstarted.
    let again = setup_in(s.dir.clone(), vec![stream("a", 3100, 1)], Fake::default()).await;
    again.view.restore_session();
    assert!(again.view.locked() && again.view.session().unwrap().ends_at.is_none());
    s.view.switch("a").unwrap(); // the clock starts
    let again = setup_in(s.dir.clone(), vec![stream("a", 3100, 1)], Fake::default()).await;
    again.view.restore_session();
    assert!(again.view.locked());
    assert!(again.view.tick_session().unwrap() > Duration::from_secs(29 * 60));
    // Time ran out while it was off.
    let mut late = saved.clone();
    late["ends_at"] = serde_json::json!(1.0);
    std::fs::write(s.dir.path().join("session.json"), late.to_string()).unwrap();
    let late = setup_in(s.dir.clone(), vec![stream("a", 3100, 1)], Fake::default()).await;
    late.view.restore_session();
    assert!(late.view.session().unwrap().expired && !late.view.locked());
    // A session whose workspaces are all gone is dropped.
    let gone = setup_in(s.dir.clone(), vec![stream("z", 3109, 9)], Fake::default()).await;
    gone.view.restore_session();
    assert!(gone.view.session().is_none() && !s.dir.path().join("session.json").exists());
}

#[tokio::test(start_paused = true)]
async fn time_running_out_says_so() {
    let s = abc().await;
    s.view.session_begin(&["a".into()], Some(1)).unwrap();
    s.view.switch("a").unwrap();
    settle(&s).await;
    s.view.expire_session();
    assert!(s.view.session().unwrap().expired && !s.view.locked());
}

#[tokio::test(start_paused = true)]
async fn super_keys_are_bound_to_hotkeys_and_home() {
    let s = abc().await;
    let b = s.view.bindings(&["KEY_0".into(), "KEY_SPACE".into()]);
    assert_eq!(b[&2], "switch:a");
    assert_eq!(b[&3], "switch:b");
    assert_eq!(b[&11], "home");
    assert_eq!(b[&57], "home");
}

// ------------------------------------------------------ native workspaces
async fn with_native() -> Setup {
    let s = setup(vec![native("n"), stream("s", 3100, 2)]).await;
    s.reg.windows().set_available(true);
    s
}

fn window(s: &Setup, id: &str, present: bool) {
    if present {
        s.screen.windows.lock().unwrap().insert(id.into());
    } else {
        s.screen.windows.lock().unwrap().remove(id);
    }
    s.view.on_window(id, present);
}

#[tokio::test(start_paused = true)]
async fn a_native_workspace_is_ready_when_its_window_appears() {
    let s = with_native().await;
    s.view.switch("n").unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(s.reg.state("n").unwrap().phase, Phase::Waiting);
    assert_eq!(s.view.current(), V::Home);
    window(&s, "n", true);
    settle(&s).await;
    assert_eq!((s.reg.state("n").unwrap().phase, s.view.current()), (Phase::Ready, wsv("n")));
    assert_eq!(s.screen.last().as_deref(), Some("native:n"));
    window(&s, "n", false);
    assert_eq!(s.reg.state("n").unwrap().phase, Phase::Waiting);
    // It comes back (the desktop restarted): ready, and put back on screen.
    s.screen.clear();
    window(&s, "n", true);
    settle(&s).await;
    assert_eq!(s.reg.state("n").unwrap().phase, Phase::Ready);
    assert_eq!(s.screen.calls(), ["native:n"]);
}

#[tokio::test(start_paused = true)]
async fn a_window_that_never_comes_is_an_error() {
    let s = with_native().await;
    s.view.switch("n").unwrap();
    settle(&s).await;
    let st = s.reg.state("n").unwrap();
    assert_eq!(st.phase, Phase::Error);
    assert_eq!(st.error.as_deref(), Some("N's desktop didn't open a window within 30 s"));
    assert_eq!(s.view.current(), V::Home);
}

#[tokio::test(start_paused = true)]
async fn the_switcher_over_a_native_window_leaves_it_on_screen() {
    let s = with_native().await;
    window(&s, "n", true);
    s.view.session_begin(&["n".into(), "s".into()], None).unwrap();
    settle(&s).await;
    s.view.switch("s").unwrap();
    settle(&s).await;
    s.view.switch("n").unwrap();
    settle(&s).await;
    s.screen.clear();
    s.view.carousel_step(true);
    settle(&s).await;
    assert!(s.screen.calls().is_empty()); // the HUD draws the switcher over it
    s.view.carousel_cancel();
    settle(&s).await;
    assert_eq!(s.screen.last().as_deref(), Some("native:n")); // back where it was
    s.view.carousel_step(true);
    s.view.carousel_commit(); // onto the streamed one
    settle(&s).await;
    assert_eq!((s.view.current(), s.screen.last().as_deref()), (wsv("s"), Some("shell")));
}

#[tokio::test(start_paused = true)]
async fn windows_are_matched_to_workspaces() {
    let s = with_native().await;
    use wad_sway::Owner;
    assert_eq!(s.view.resolve(Owner::Workspace("n".into())).await.as_deref(), Some("n"));
    assert_eq!(s.view.resolve(Owner::Workspace("other".into())).await, None);
    assert_eq!(s.view.resolve(Owner::Exe("/usr/bin/wadcreator".into())).await, None); // the app stays on the shell
    s.fake.with(|m| {
        m.labels.insert("c0ffee".into(), "n".into());
    });
    assert_eq!(s.view.resolve(Owner::Container("c0ffee".into())).await.as_deref(), Some("n"));
}
