//! Builds (builds.py's tests, with the build folder made from the design):
//! a fake podman builds, the real registry installs.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Fake, ws};
use serde_json::{Value, json};
use wad_proto::ErrorCode;
use wad_proto::v1::{BuildLog, BuildRequest, BuildStatus, Display, MountedProject, Wallpaper};
use wadd::builds::Builds;
use wadd::events::Bus;
use wadd::registry::{Registry, Settings};

const BASE: &str = "localhost/wadspaces-base:trixie";

struct Env {
    _d: tempfile::TempDir,
    state: std::path::PathBuf,
    fake: Fake,
    reg: Arc<Registry>,
    builds: Arc<Builds>,
}

async fn env() -> Env {
    let d = tempfile::tempdir().unwrap();
    let state = d.path().join("state");
    let fake = Fake::default();
    fake.with(|m| {
        m.images.insert(BASE.into());
        m.free_gb = 100.0;
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
            ready_timeout: Duration::from_secs(10),
            max_parallel_pulls: 3,
            projects_dir: "/p".into(),
            state_dir: state.clone(),
            rootless_uid: Some(1000),
            poll: Duration::from_millis(10),
        },
    );
    let mut writing = ws("writing", "ghcr.io/o/writing:1", Display::Stream, Some(3100));
    writing.hotkey = Some(1);
    reg.load(vec![writing]).await.unwrap();
    let builds = Builds::new(reg.clone(), Arc::new(fake.clone()), bus, &state, 8);
    Env { _d: d, state, fake, reg, builds }
}

/// A design as Wad Creator keeps it: no apps, a colour wallpaper.
fn design(id: &str) -> Value {
    json!({"id": id, "name": "Try build", "description": "", "layout": {"wallpaper": {"type": "color", "value": "#000"}, "icons": [], "grid": true},
        "advanced": {"display": "host", "port": null, "hotkey": 2, "tools": ["git"], "projects": [], "kaleResources": [],
            "env": {"PUID": "1000", "PGID": "1000", "TZ": "Pacific/Fiji"}, "secrets": [], "devices": ["/dev/dri"], "shmSize": "1g",
            "persistConfig": true, "autostart": false}})
}

fn request(design: Value) -> BuildRequest {
    BuildRequest {
        design,
        wallpaper: Some(Wallpaper { file_name: "wallpaper.png".into(), data: "iVBORw0KGgo=".into() }),
        projects: vec![],
    }
}

async fn wait(e: &Env, id: &str) -> BuildLog {
    for _ in 0..500 {
        let l = e.builds.log(id, 0).unwrap();
        if l.build.status.finished() {
            return l;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("build stuck: {:?}", e.builds.log(id, 0).unwrap());
}

/// The file names in a tar.
fn names(tar: &[u8]) -> Vec<String> {
    let mut out = vec![];
    let mut at = 0;
    while at + 512 <= tar.len() && tar[at] != 0 {
        let head = &tar[at..at + 512];
        let name = String::from_utf8_lossy(&head[..100]).trim_end_matches('\0').to_string();
        let size =
            usize::from_str_radix(String::from_utf8_lossy(&head[124..135]).trim_matches(['\0', ' ']), 8).unwrap_or(0);
        out.push(name);
        at += 512 + size.div_ceil(512) * 512;
    }
    out
}

#[tokio::test]
async fn a_design_is_built_and_becomes_a_workspace() {
    let e = env().await;
    let b = e.builds.create(&request(design("trybuild"))).unwrap();
    assert_eq!(
        (b.status, b.image.as_str(), b.base_image.as_str(), b.updated),
        (BuildStatus::Queued, "localhost/wadspaces-trybuild:latest", BASE, false)
    );
    let l = wait(&e, &b.id).await;
    assert_eq!(l.build.status, BuildStatus::Done, "{l:?}");
    assert_eq!(l.build.progress, 1.0);
    assert!(
        l.lines.iter().any(|x| x == &format!("» building localhost/wadspaces-trybuild:latest on {BASE}")),
        "{:?}",
        l.lines
    );
    assert_eq!(l.lines.last().map(String::as_str), Some("✓ built localhost/wadspaces-trybuild:latest"));
    // podman got the build folder wad-core made from the design.
    let (tag, base, context) = e.fake.0.lock().unwrap().builds[0].clone();
    assert_eq!((tag.as_str(), base.as_str()), ("localhost/wadspaces-trybuild:latest", BASE));
    let files = names(&context);
    assert!(
        files.contains(&"Dockerfile".to_string())
            && files.contains(&"root/usr/share/backgrounds/wallpaper.png".to_string()),
        "{files:?}"
    );
    // It's a workspace now: saved, with its unit, its hotkey and its image here.
    let w = e.reg.workspace("trybuild").unwrap();
    assert_eq!(
        (w.image.as_str(), w.display, w.hotkey),
        ("localhost/wadspaces-trybuild:latest", Display::Host, Some(2))
    );
    assert!(std::fs::read_to_string(e.state.join("workspaces.json")).unwrap().contains("trybuild"));
    assert!(e.fake.0.lock().unwrap().units.iter().any(|(n, _)| n == "wad-trybuild.container"));
    assert_eq!(e.reg.state("trybuild").unwrap().image_present, Some(true));
    assert!(std::fs::read_to_string(e.state.join(format!("builds/{}.log", b.id))).unwrap().contains("STEP 2/2"));
}

#[tokio::test]
async fn a_rebuild_keeps_what_the_machine_added() {
    let e = env().await;
    wait(&e, &e.builds.create(&request(design("trybuild"))).unwrap().id).await;
    // Here, it has gained an icon, a volume and a project.
    let mut list = e.reg.workspaces();
    let w = list.iter_mut().find(|w| w.id == "trybuild").unwrap();
    w.icon = Some("/usr/share/wadspaces/icons/t.png".into());
    w.volumes.push("wad-extra:/data:z".into());
    w.projects = vec![MountedProject { id: "p1".into(), mount: "Notes".into(), path: None }];
    e.reg.set_workspaces(list).await.unwrap();
    e.fake.with(|m| {
        m.containers.insert("wad-trybuild".into(), "running".into());
    });
    e.reg.reconcile().await;
    let mut d = design("trybuild");
    d["name"] = "Renamed".into();
    let l = wait(&e, &e.builds.create(&request(d)).unwrap().id).await;
    assert_eq!(l.build.status, BuildStatus::Done, "{l:?}");
    assert!(l.build.updated && l.build.restart_required); // it runs the old image
    let w = e.reg.workspace("trybuild").unwrap();
    assert_eq!(w.name, "Renamed");
    assert_eq!(w.icon.as_deref(), Some("/usr/share/wadspaces/icons/t.png"));
    assert!(
        w.volumes.contains(&"wad-extra:/data:z".to_string()) && w.volumes.iter().any(|v| v.contains("/config")),
        "{:?}",
        w.volumes
    );
    assert_eq!(w.projects.len(), 1);
}

#[tokio::test]
async fn a_missing_base_says_how_to_get_it() {
    let e = env().await;
    e.fake.with(|m| {
        m.images.clear();
    });
    let l = wait(&e, &e.builds.create(&request(design("trybuild"))).unwrap().id).await;
    assert_eq!(l.build.status, BuildStatus::Error);
    assert_eq!(
        l.build.error.as_deref(),
        Some(
            "base image localhost/wadspaces-base:trixie is not on this machine — update the drive with host/build.sh update --bases"
        )
    );
    assert!(e.reg.workspace("trybuild").is_err() && e.fake.0.lock().unwrap().builds.is_empty());
}

#[tokio::test]
async fn short_on_disk_and_failed_builds() {
    let e = env().await;
    e.fake.with(|m| m.free_gb = 3.0);
    let l = wait(&e, &e.builds.create(&request(design("trybuild"))).unwrap().id).await;
    assert_eq!(l.build.error.as_deref(), Some("only 3.0 GB free; building needs at least 8 GB"));
    e.fake.with(|m| {
        m.free_gb = 100.0;
        m.build_fails = Some("RUN apt-get install: exit status 100".into());
    });
    let l = wait(&e, &e.builds.create(&request(design("trybuild"))).unwrap().id).await;
    assert_eq!(
        (l.build.status, l.build.error.as_deref()),
        (BuildStatus::Error, Some("RUN apt-get install: exit status 100"))
    );
    assert!(l.build.progress < 1.0); // STEP n/m counts what came before n
    assert!(e.reg.workspace("trybuild").is_err());
}

#[tokio::test]
async fn bad_designs_are_refused_before_anything_is_built() {
    let e = env().await;
    // A streamed one on the port another workspace has.
    let mut d = design("clash");
    d["advanced"]["display"] = "stream".into();
    d["advanced"]["port"] = 3100.into();
    let err = e.builds.create(&request(d)).unwrap_err();
    assert_eq!(err.code, ErrorCode::BadRequest);
    assert!(err.message.contains("port 3100 already used"), "{}", err.message);
    // Hotkey 1 is writing's.
    let mut d = design("clash");
    d["advanced"]["hotkey"] = 1.into();
    assert!(e.builds.create(&request(d)).unwrap_err().message.contains("hotkey 1 already used"));
    let mut d = design("Not An Id");
    d["name"] = "".into();
    assert_eq!(e.builds.create(&request(d)).unwrap_err().code, ErrorCode::BadRequest);
    assert_eq!(
        e.builds.create(&BuildRequest { design: json!([]), wallpaper: None, projects: vec![] }).unwrap_err().code,
        ErrorCode::BadRequest
    );
    assert!(e.fake.0.lock().unwrap().builds.is_empty());
}

#[tokio::test]
async fn one_build_at_a_time_and_cancelling() {
    let e = env().await;
    e.fake.with(|m| m.build_slow = true);
    let first = e.builds.create(&request(design("one"))).unwrap();
    let err = e.builds.create(&request(design("one"))).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict); // the same one: once
    let mut other = design("two");
    other["advanced"]["hotkey"] = 3.into();
    let second = e.builds.create(&request(other)).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(e.builds.log(&first.id, 0).unwrap().build.status, BuildStatus::Building);
    assert_eq!(e.builds.log(&second.id, 0).unwrap().build.status, BuildStatus::Queued); // waits its turn
    assert_eq!(e.builds.cancel(&first.id).unwrap().status, BuildStatus::Cancelled);
    assert_eq!(e.builds.log(&first.id, 0).unwrap().lines.last().map(String::as_str), Some("✗ cancelled"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(e.builds.log(&second.id, 0).unwrap().build.status, BuildStatus::Building); // its turn now
    e.builds.cancel(&second.id).unwrap();
    assert!(e.reg.workspace("one").is_err());
    assert_eq!(e.builds.list().len(), 2);
    assert_eq!(e.builds.log("nope", 0).unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn what_the_build_leaves_out_is_logged() {
    let e = env().await;
    let mut d = design("trybuild");
    // An app of your own (custom-...) has no recipe yet.
    d["layout"]["icons"] = json!([{"id": "i1", "appId": "custom-x1", "name": "Mystery", "x": 0, "y": 0}]);
    let b = e.builds.create(&request(d)).unwrap();
    assert_eq!(b.skipped.len(), 1, "{b:?}");
    let l = wait(&e, &b.id).await;
    assert!(l.lines[0].starts_with("⚠ left out "), "{:?}", l.lines);
    assert_eq!(l.build.status, BuildStatus::Done);
}
