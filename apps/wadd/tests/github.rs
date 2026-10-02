//! GitHub in wadd (github.py's tests, and the device sign-in the app had):
//! a mock GitHub, the fake machine's secrets, and the fake account.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::Fake;
use common::firebase::FakeFirebase;
use serde_json::json;
use wad_proto::ErrorCode;
use wad_proto::github::{AccountRef, NewRepo, SignInState};
use wad_proto::v1::Event;
use wadd::drives::Drives;
use wadd::events::Bus;
use wadd::github::{GithubService, Parts};
use wadd::projects::Projects;
use wadd::registry::{Registry, Settings};
use wadd::secrets::Secrets;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct Env {
    _d: tempfile::TempDir,
    gh: MockServer,
    fb: FakeFirebase,
    fake: Fake,
    bus: Bus,
    projects: Arc<Projects>,
    svc: Arc<GithubService>,
}

async fn env() -> Env {
    let d = tempfile::tempdir().unwrap();
    let state = d.path().join("state");
    let app = d.path().join("github.toml");
    std::fs::write(&app, "client_id = \"Ov23test\"\nscopes = [\"repo\"]\n").unwrap();
    let gh = MockServer::start().await;
    let fb = FakeFirebase::default();
    let fb_base = fb.serve().await;
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
            ready_timeout: Duration::from_secs(5),
            max_parallel_pulls: 1,
            projects_dir: "/p".into(),
            state_dir: state.clone(),
            rootless_uid: None,
            poll: Duration::from_millis(10),
        },
    );
    let projects = Arc::new(Projects::new(
        &state,
        d.path().join("projects"),
        vec![],
        1000,
        Arc::new(|| ("local".into(), "Surface".into())),
        Arc::new(Drives::new(1000, Arc::new(wadd::drives::System), false)),
        Arc::new(wad_git::Git::default()),
        reg,
        bus.clone(),
    ));
    let secrets = Arc::new(Secrets::new(Arc::new(fake.clone()), &state));
    let svc = GithubService::new(
        wad_github::Github::with_base(reqwest::Client::new(), &gh.uri(), &format!("{}/api", gh.uri())),
        app,
        reqwest::Client::new(),
        fb_base,
        Parts { backend: Arc::new(fake.clone()), secrets, projects: projects.clone(), bus: bus.clone() },
    );
    Mock::given(path("/api/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"login": "HungGod"})))
        .mount(&gh)
        .await;
    Env { _d: d, gh, fb, fake, bus, projects, svc }
}

async fn device_code(e: &Env) {
    Mock::given(method("POST"))
        .and(path("/login/device/code"))
        .and(body_string_contains("client_id=Ov23test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "device_code": "dev123", "user_code": "WDJB-MJHT", "verification_uri": "https://github.com/login/device",
            "expires_in": 900, "interval": 0})))
        .mount(&e.gh)
        .await;
}

async fn until_done(e: &Env) -> wad_proto::github::SignIn {
    for _ in 0..200 {
        let s = e.svc.status().await.sign_in.unwrap();
        if s.state != SignInState::Waiting {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the sign-in never ended");
}

fn token_here(e: &Env) -> Option<String> {
    e.fake.0.lock().unwrap().secrets.get("github_token").map(|v| String::from_utf8_lossy(v).into_owned())
}

#[tokio::test]
async fn signing_in_saves_the_token_here_and_to_the_account() {
    let e = env().await;
    device_code(&e).await;
    // Not entered yet once, then done.
    Mock::given(path("/login/oauth/access_token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"error": "authorization_pending"})))
        .up_to_n_times(1)
        .mount(&e.gh)
        .await;
    Mock::given(path("/login/oauth/access_token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"access_token": "gho_new", "token_type": "bearer"})),
        )
        .mount(&e.gh)
        .await;
    let (_, mut rx) = e.bus.subscribe();
    let account = AccountRef { uid: "u1".into(), id_token: "id:u1:x:0".into(), project_id: "demo".into() };
    let s = e.svc.start(Some(account)).await.unwrap();
    assert_eq!((s.state, s.code.user_code.as_str()), (SignInState::Waiting, "WDJB-MJHT"));
    assert!(s.qr_svg.contains("<svg"));
    let done = until_done(&e).await;
    assert_eq!((done.state, done.login.as_deref(), done.saved_to_account), (SignInState::Done, Some("HungGod"), true));
    assert_eq!(token_here(&e).as_deref(), Some("gho_new"));
    assert_eq!(e.fb.doc("users/u1/secrets/github_token").unwrap()["value"], "gho_new");
    assert!(e.svc.repos_due.load(std::sync::atomic::Ordering::Relaxed)); // the relay writes the list
    let st = e.svc.status().await;
    assert_eq!((st.token, st.login.as_deref()), (true, Some("HungGod")));
    // The events told the story (and never the token).
    let mut states = vec![];
    while let Ok(ev) = rx.try_recv() {
        if let Event::Github(s) = ev {
            assert!(!serde_json::to_string(&s).unwrap().contains("gho_new"));
            states.push(s.state);
        }
    }
    assert_eq!(states, [SignInState::Waiting, SignInState::Done]);
    e.svc.sign_out().await.unwrap();
    assert!(token_here(&e).is_none() && !e.svc.status().await.token);
}

#[tokio::test]
async fn a_refused_or_cancelled_sign_in_says_so() {
    let e = env().await;
    device_code(&e).await;
    Mock::given(path("/login/oauth/access_token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"error": "access_denied"})))
        .mount(&e.gh)
        .await;
    e.svc.start(None).await.unwrap();
    let s = until_done(&e).await;
    assert_eq!((s.state, s.error.as_deref()), (SignInState::Cancelled, Some("the sign-in was cancelled on GitHub")));
    assert!(token_here(&e).is_none());
}

#[tokio::test]
async fn cancelling_stops_the_wait() {
    let e = env().await;
    device_code(&e).await;
    Mock::given(path("/login/oauth/access_token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"error": "authorization_pending"})))
        .mount(&e.gh)
        .await;
    e.svc.start(None).await.unwrap();
    e.svc.cancel();
    assert_eq!(e.svc.status().await.sign_in.unwrap().state, SignInState::Cancelled);
}

#[tokio::test]
async fn repos_are_kept_a_minute_per_token() {
    let e = env().await;
    assert!(e.svc.repos(false).await.unwrap().is_none()); // no token
    Mock::given(path("/api/user/repos"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{"full_name": "HungGod/notes", "name": "notes", "clone_url": "https://github.com/HungGod/notes.git"}])))
        .mount(&e.gh)
        .await;
    e.fake.with(|m| {
        m.secrets.insert("github_token".into(), b"gho_a".to_vec());
    });
    let calls = || async {
        e.gh.received_requests().await.unwrap().iter().filter(|r| r.url.path() == "/api/user/repos").count()
    };
    let r = e.svc.repos(false).await.unwrap().unwrap();
    assert_eq!((r.login.as_str(), r.repos[0].name.as_str()), ("HungGod", "notes"));
    e.svc.repos(false).await.unwrap();
    assert_eq!(calls().await, 1); // from the last minute's
    e.svc.repos(true).await.unwrap();
    assert_eq!(calls().await, 2); // fresh when asked
    e.fake.with(|m| {
        m.secrets.insert("github_token".into(), b"gho_b".to_vec());
    });
    e.svc.repos(false).await.unwrap();
    assert_eq!(calls().await, 3); // another token: its own list
}

#[tokio::test]
async fn a_new_repo_and_its_project() {
    let e = env().await;
    e.fake.with(|m| {
        m.secrets.insert("github_token".into(), b"gho_a".to_vec());
    });
    Mock::given(method("POST"))
        .and(path("/api/user/repos"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"full_name": "HungGod/notes", "name": "notes", "private": true, "clone_url": "https://github.com/HungGod/notes.git", "default_branch": "main"})))
        .mount(&e.gh)
        .await;
    let req = |name: &str, mount: Option<&str>| NewRepo {
        name: name.into(),
        private: true,
        description: String::new(),
        mount_name: mount.map(String::from),
        setup: String::new(),
    };
    let p = e.svc.create_repo(&req("notes", None)).await.unwrap();
    assert_eq!(p.mount_name, "notes");
    assert!(
        matches!(&p.source, Some(wad_proto::v1::ProjectSource::Git { url, .. }) if url == "https://github.com/HungGod/notes.git")
    );
    // Refused before anything is made on GitHub: a bad name, a folder name in use.
    assert_eq!(e.svc.create_repo(&req("no spaces", None)).await.unwrap_err().code, ErrorCode::BadRequest);
    assert_eq!(e.svc.create_repo(&req("other", Some("notes"))).await.unwrap_err().code, ErrorCode::Conflict);
    let posts = e.gh.received_requests().await.unwrap().iter().filter(|r| r.method.as_str() == "POST").count();
    assert_eq!(posts, 1);
    assert_eq!(e.projects.list(false).len(), 1);
    // No token: say so.
    e.fake.with(|m| {
        m.secrets.clear();
    });
    assert_eq!(e.svc.create_repo(&req("third", None)).await.unwrap_err().code, ErrorCode::Conflict);
}
