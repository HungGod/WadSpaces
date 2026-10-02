//! Launches (launches.py's tests): a fake machine, fake drives, a fake clone,
//! and real git (against a bare repository) for copies already here.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use common::host::FakeHost;
use common::{Fake, TOKEN, ws};
use serde_json::{Value, json};
use wad_git::Update;
use wad_proto::ErrorCode;
use wad_proto::v1::{Display, GitStatus, LaunchLog, LaunchStatus, MountedProject, PartState, Phase, View as V};
use wadd::display::NullDisplay;
use wadd::drives::Drives;
use wadd::events::Bus;
use wadd::launches::{Launches, OLD_BASE};
use wadd::projects::{ProjectGit, Projects};
use wadd::registry::{Registry, Settings};
use wadd::view::View;

const IMAGE: &str = "localhost/wadspaces-a:latest";
const STICK: &str = "5E3F-1A2B";

/// A clone asked for: url, ref, where, token, as whom.
type CloneCall = (String, Option<String>, PathBuf, Option<String>, u32);

#[derive(Default)]
struct GitCalls {
    clones: Vec<CloneCall>,
    slow: bool,
    fail: bool,
}

/// Clones are made up (a README); updates and status are real git.
#[derive(Clone, Default)]
struct FakeGit(Arc<Mutex<GitCalls>>);

#[async_trait]
impl ProjectGit for FakeGit {
    async fn clone_repo(
        &self,
        url: &str,
        git_ref: Option<&str>,
        dest: &Path,
        token: Option<&str>,
        on_line: &mut (dyn for<'s> FnMut(&'s str, Option<f64>) + Send),
        uid: u32,
    ) -> Result<(), String> {
        let (slow, fail) = {
            let mut g = self.0.lock().unwrap();
            g.clones.push((url.into(), git_ref.map(String::from), dest.into(), token.map(String::from), uid));
            (g.slow, g.fail)
        };
        on_line("Cloning into 'x.part'...", None);
        on_line("Receiving objects:  50% (1/2)", Some(0.5));
        if slow {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        if fail {
            return Err(format!("git clone {url} failed: fatal: repository not found"));
        }
        std::fs::create_dir(dest).unwrap();
        std::fs::write(dest.join("README.md"), "cloned").unwrap();
        on_line("Receiving objects: 100% (2/2), done.", Some(1.0));
        Ok(())
    }
    async fn update(&self, path: &Path, token: Option<&str>, uid: u32) -> Update {
        wad_git::Git::default().update(path, token, Some(uid), wad_git::FETCH_TIMEOUT).await
    }
    async fn status(&self, path: &Path, uid: u32) -> Option<GitStatus> {
        wad_git::Git::default().status(path, Some(uid)).await
    }
}

struct Env {
    d: tempfile::TempDir,
    tmp: PathBuf,
    fake: Fake,
    git: FakeGit,
    host: FakeHost,
    reg: Arc<Registry>,
    view: Arc<View>,
    projects: Arc<Projects>,
    launches: Arc<Launches>,
    bus: Bus,
}

impl Env {
    fn home(&self) -> PathBuf {
        self.tmp.join("home")
    }
}

async fn env() -> Env {
    let d = tempfile::tempdir().unwrap();
    let tmp = wad_store::folders::realpath(d.path());
    let fake = Fake::default();
    let mut a = ws("a", IMAGE, Display::Stream, Some(3100));
    a.volumes = vec!["wad-a-config:/config:z".into()];
    let b = ws("b", IMAGE, Display::Stream, Some(3101));
    fake.with(|m| {
        m.images.insert(IMAGE.into());
        m.image_labels.insert(IMAGE.into(), json!({"io.wadspaces.projects": "1"}).as_object().unwrap().clone());
        m.volumes.insert("wad-a-config".into(), tmp.join("volumes/wad-a-config/_data").to_string_lossy().into());
        m.answering.insert("http://127.0.0.1:3100/".into());
        m.answering.insert("http://127.0.0.1:3101/".into());
    });
    let bus = Bus::new(wad_proto::v1::MachineInfo {
        name: "t".into(),
        version: "0".into(),
        profile: wad_proto::v1::Profile::User,
        started_at: 0,
    });
    let state = tmp.join("state");
    let reg = Registry::new(
        Arc::new(fake.clone()),
        bus.clone(),
        Settings {
            ready_timeout: Duration::from_secs(10),
            max_parallel_pulls: 3,
            projects_dir: tmp.join("projects").to_string_lossy().into(),
            state_dir: state.clone(),
            rootless_uid: Some(1000),
            poll: Duration::from_millis(10),
        },
    );
    reg.load(vec![a, b]).await.unwrap();
    let view = View::new(reg.clone(), Arc::new(fake.clone()), Arc::new(NullDisplay), bus.clone(), state.clone());
    let home = tmp.join("home");
    std::fs::create_dir_all(home.join("Notes")).unwrap();
    std::fs::create_dir_all(tmp.join("stick/Books")).unwrap();
    let host = FakeHost::new(Some(&tmp.join("stick").to_string_lossy()));
    let drives = Arc::new(Drives::new(1000, Arc::new(host.clone()), true));
    let git = FakeGit::default();
    let projects = Arc::new(Projects::new(
        &state,
        tmp.join("projects"),
        vec![home],
        1000,
        Arc::new(|| ("local".to_string(), "Surface".to_string())),
        drives,
        Arc::new(git.clone()),
        reg.clone(),
        bus.clone(),
    ));
    projects
        .save(
            "vault",
            &json!({"name": "Vault", "mountName": "Writing", "setup": "npm install",
        "source": {"kind": "git", "url": "https://github.com/o/vault.git", "ref": "main"}}),
        )
        .unwrap();
    projects.save("notes", &json!({"name": "Notes", "mountName": "Notes", "source": {"kind": "git", "url": "https://github.com/o/notes"}})).unwrap();
    let launches =
        Launches::new(reg.clone(), view.clone(), Arc::new(fake.clone()), projects.clone(), bus.clone(), &state);
    Env { d, tmp, fake, git, host, reg, view, projects, launches, bus }
}

async fn wait(e: &Env, id: &str) -> LaunchLog {
    for _ in 0..500 {
        let l = e.launches.log(id, 0).unwrap();
        if l.launch.status.finished() {
            return l;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("launch stuck: {:?}", e.launches.log(id, 0).unwrap());
}

async fn launch(e: &Env, ws: &str, projects: &[&str], restart: bool) -> LaunchLog {
    let ids: Vec<String> = projects.iter().map(|p| p.to_string()).collect();
    let l = e.launches.create(ws, &ids, restart).unwrap();
    wait(e, &l.id).await
}

fn starts(e: &Env, unit: &str) -> usize {
    e.fake.calls().iter().filter(|c| **c == format!("start {unit}")).count()
}

fn projects_of(e: &Env, id: &str) -> Vec<MountedProject> {
    e.reg.workspace(id).unwrap().projects
}

#[tokio::test]
async fn a_launch_with_projects() {
    let e = env().await;
    let (_, mut rx) = e.bus.subscribe();
    let l = launch(&e, "a", &["vault", "notes"], false).await;
    assert_eq!(l.launch.status, LaunchStatus::Done, "{l:?}");
    assert_eq!(l.launch.progress, 1.0);
    let parts: Vec<(&str, PartState)> = l.launch.parts.iter().map(|p| (p.key.as_str(), p.state)).collect();
    assert_eq!(parts, [("image", PartState::Done), ("vault", PartState::Done), ("notes", PartState::Done)]);
    // Both were cloned, with the token, as the projects user.
    let clones = e.git.0.lock().unwrap().clones.clone();
    assert_eq!(
        clones,
        [
            (
                "https://github.com/o/vault.git".into(),
                Some("main".into()),
                e.tmp.join("projects/vault"),
                Some(TOKEN.into()),
                1000
            ),
            ("https://github.com/o/notes".into(), None, e.tmp.join("projects/notes"), Some(TOKEN.into()), 1000),
        ]
    );
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(e.tmp.join("state/extra/a/projects.json")).unwrap()).unwrap();
    assert_eq!(manifest["projects"][0]["setupHash"], wad_store::projects::setup_hash("npm install"));
    assert_eq!(manifest["projects"][1]["mount"], "Notes");
    // The workspace mounts them now (saved; its unit rewritten), and it's up and on screen.
    let mounted = vec![
        MountedProject { id: "vault".into(), mount: "Writing".into(), path: None },
        MountedProject { id: "notes".into(), mount: "Notes".into(), path: None },
    ];
    assert_eq!(projects_of(&e, "a"), mounted);
    assert!(std::fs::read_to_string(e.tmp.join("state/workspaces.json")).unwrap().contains("\"mount\": \"Writing\""));
    let unit = e.fake.0.lock().unwrap().units.iter().find(|(n, _)| n == "wad-a.container").unwrap().1.clone();
    assert!(
        unit.contains(&format!("Volume={}/projects/vault:/config/Desktop/Writing:rw,z", e.tmp.display())),
        "{unit}"
    );
    assert!(unit.contains(&format!("Volume={}/state/extra/a:/run/wadspaces-extra:ro,z", e.tmp.display())), "{unit}");
    assert_eq!(e.view.current(), V::Workspace("a".into()));
    assert_eq!(e.reg.state("a").unwrap().phase, Phase::Ready);
    let runs = wad_store::State::new(e.tmp.join("state")).runs(Some("a"), 5);
    assert_eq!(runs[0].projects, ["vault", "notes"]);
    let log = std::fs::read_to_string(e.tmp.join(format!("state/launches/{}.log", l.launch.id))).unwrap();
    assert!(log.contains("Receiving objects: 100% (2/2), done.") && !log.contains("50%"), "{log}");
    let mut done_event = false;
    while let Ok(ev) = rx.try_recv() {
        done_event |= matches!(ev, wad_proto::v1::Event::Launch(ref l) if l.launch.status == LaunchStatus::Done);
    }
    assert!(done_event);
    // Again with the same projects: no clone, no unit change.
    let installs = e.fake.0.lock().unwrap().installs;
    let again = launch(&e, "a", &["notes", "vault"], false).await;
    assert_eq!(again.launch.status, LaunchStatus::Done, "{again:?}");
    assert_eq!(e.git.0.lock().unwrap().clones.len(), 2);
    assert_eq!(again.launch.parts[1].message.as_deref(), Some("not a git repo — left as is")); // what the fake clone made
    assert_eq!(e.fake.0.lock().unwrap().installs, installs);
}

#[tokio::test]
async fn an_image_from_an_older_base_is_refused() {
    let e = env().await;
    e.fake.with(|m| {
        m.image_labels.clear();
    });
    let l = launch(&e, "a", &["notes"], false).await;
    assert_eq!((l.launch.status, l.launch.error.as_deref()), (LaunchStatus::Error, Some(OLD_BASE)));
    assert!(projects_of(&e, "a").is_empty() && starts(&e, "wad-a.service") == 0);
    // Without projects that image is fine.
    assert_eq!(launch(&e, "a", &[], false).await.launch.status, LaunchStatus::Done);
}

#[tokio::test]
async fn a_missing_local_image_says_build_it() {
    let e = env().await;
    e.fake.with(|m| m.images.clear());
    let l = launch(&e, "a", &["notes"], false).await;
    assert_eq!(l.launch.status, LaunchStatus::Error);
    assert!(l.launch.error.as_deref().unwrap().contains("build A in Wad Creator"), "{l:?}");
    assert_eq!(l.launch.parts[0].state, PartState::Error);
}

#[tokio::test]
async fn an_old_clone_in_the_config_volume_is_moved_over() {
    let e = env().await;
    let old = e.tmp.join("volumes/wad-a-config/_data/Desktop/Writing");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("draft.md"), "uncommitted work").unwrap();
    let l = launch(&e, "a", &["vault"], false).await;
    assert_eq!(l.launch.status, LaunchStatus::Done, "{l:?}");
    assert_eq!(std::fs::read_to_string(e.tmp.join("projects/vault/draft.md")).unwrap(), "uncommitted work");
    assert!(!old.exists() && e.git.0.lock().unwrap().clones.is_empty());
    assert!(l.lines.iter().any(|x| x.contains("changes kept")));
}

#[tokio::test]
async fn cancelling_stops_a_clone() {
    let e = env().await;
    e.git.0.lock().unwrap().slow = true;
    let l = e.launches.create("a", &["vault".into()], false).unwrap();
    while e.git.0.lock().unwrap().clones.is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(e.launches.cancel(&l.id).unwrap().status, LaunchStatus::Cancelled);
    let done = wait(&e, &l.id).await;
    assert_eq!(done.lines.last().map(String::as_str), Some("✗ cancelled"));
    assert!(projects_of(&e, "a").is_empty() && starts(&e, "wad-a.service") == 0);
}

#[tokio::test]
async fn running_with_other_projects_needs_restart() {
    let e = env().await;
    e.view.switch("a").unwrap();
    e.reg.settled("a").await;
    let r = e.launches.create("a", &["notes".into()], false).unwrap_err();
    assert_eq!(r.code, ErrorCode::Conflict);
    assert!(r.message.contains("running with other projects; pass restart"), "{}", r.message);
    let l = launch(&e, "a", &["notes"], true).await;
    assert_eq!(l.launch.status, LaunchStatus::Done, "{l:?}");
    let calls = e.fake.calls();
    let stop = calls.iter().position(|c| c == "stop wad-a.service").unwrap();
    let start = calls.iter().rposition(|c| c == "start wad-a.service").unwrap();
    assert!(stop < start, "{calls:?}");
    // Running with the same projects: no restart needed.
    assert!(e.launches.create("a", &["notes".into()], false).is_ok());
}

#[tokio::test]
async fn bad_requests() {
    let e = env().await;
    assert_eq!(e.launches.create("nope", &[], false).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(e.launches.create("a", &["nope".into()], false).unwrap_err().code, ErrorCode::BadRequest);
    e.projects.delete("notes", false).unwrap();
    assert_eq!(e.launches.create("a", &["notes".into()], false).unwrap_err().code, ErrorCode::BadRequest);
    e.git.0.lock().unwrap().slow = true;
    let first = e.launches.create("a", &["vault".into()], false).unwrap();
    assert_eq!(e.launches.create("a", &[], false).unwrap_err().code, ErrorCode::Conflict); // one at a time
    assert!(e.launches.create("b", &[], false).is_ok()); // others may
    e.launches.cancel(&first.id).unwrap();
    assert_eq!(e.launches.log("nope", 0).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(e.launches.list().len(), 2);
}

// --------------------------------------- a copy that's here: fetch, fast-forward
fn git(cwd: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@example.com",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn commit(repo: &Path, name: &str) {
    std::fs::write(repo.join(name), "x").unwrap();
    git(repo, &["add", name]);
    git(repo, &["commit", "-q", "-m", name]);
}

/// vault already on this machine: a real clone of a bare repository, and a
/// "laptop" that pushes two new commits to it.
fn remote(e: &Env) -> (PathBuf, PathBuf) {
    let root = e.tmp.join("remote");
    std::fs::create_dir_all(&root).unwrap();
    let (bare, laptop, project) = (root.join("origin.git"), root.join("laptop"), e.tmp.join("projects/vault"));
    git(&root, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
    git(&root, &["clone", "-q", bare.to_str().unwrap(), laptop.to_str().unwrap()]);
    commit(&laptop, "README.md");
    git(&laptop, &["push", "-q", "origin", "main"]);
    std::fs::create_dir_all(e.tmp.join("projects")).unwrap();
    git(&root, &["clone", "-q", bare.to_str().unwrap(), project.to_str().unwrap()]);
    commit(&laptop, "new0.md");
    commit(&laptop, "new1.md");
    git(&laptop, &["push", "-q", "origin", "main"]);
    (bare, project)
}

fn vault_message(l: &LaunchLog) -> String {
    l.launch.parts.iter().find(|p| p.key == "vault").unwrap().message.clone().unwrap_or_default()
}

#[tokio::test]
async fn a_copy_here_is_fast_forwarded_only_when_safe() {
    for (change, message, line) in [
        ("behind", "updated (2 new commits)", "Writing: updated (2 new commits)"),
        ("dirty", "uncommitted changes — left as is", "Writing has uncommitted changes; not updated"),
        ("ahead", "1 unpushed commit — left as is", "Writing has 1 unpushed commit; not updated"),
        ("no-upstream", "no upstream branch — left as is", "Writing has no upstream branch; not updated"),
    ] {
        let e = env().await;
        let (_, project) = remote(&e);
        match change {
            "dirty" => std::fs::write(project.join("README.md"), "my edit").unwrap(),
            "ahead" => commit(&project, "mine.md"),
            "no-upstream" => git(&project, &["checkout", "-q", "-b", "local-only"]),
            _ => {}
        }
        let l = launch(&e, "a", &["vault"], false).await;
        assert_eq!(l.launch.status, LaunchStatus::Done, "{change}: {l:?}");
        assert_eq!(vault_message(&l), message, "{change}");
        assert!(l.lines.iter().any(|x| x == line), "{change}: {:?}", l.lines);
        assert!(e.git.0.lock().unwrap().clones.is_empty()); // never re-cloned
        assert_eq!(project.join("new1.md").exists(), change == "behind", "{change}");
    }
}

#[tokio::test]
async fn a_failed_fetch_is_a_warning_not_a_failure() {
    let e = env().await;
    let (bare, _) = remote(&e);
    std::fs::remove_dir_all(bare).unwrap();
    let l = launch(&e, "a", &["vault"], false).await;
    assert_eq!(l.launch.status, LaunchStatus::Done, "{l:?}");
    assert_eq!(vault_message(&l), "couldn't fetch — left as is");
    assert!(l.lines.iter().any(|x| x.starts_with("⚠ Writing: couldn't fetch (")));
}

#[tokio::test]
async fn a_failed_clone_fails_the_launch() {
    let e = env().await;
    e.git.0.lock().unwrap().fail = true;
    let l = launch(&e, "a", &["vault"], false).await;
    assert_eq!(l.launch.status, LaunchStatus::Error);
    assert!(l.launch.error.as_deref().unwrap().contains("repository not found"));
    assert_eq!(l.launch.parts[1].state, PartState::Error);
    assert_eq!(starts(&e, "wad-a.service"), 0);
}

#[tokio::test]
async fn legacy_projects_launch_only_when_here() {
    let e = env().await;
    std::fs::write(
        e.tmp.join("state/projects/old.json"),
        json!({"id": "old", "name": "Old", "mountName": "Old", "source": {"kind": "empty"}, "ignore": [], "deleted": false, "createdAt": 1, "updatedAt": 2}).to_string(),
    )
    .unwrap();
    let l = launch(&e, "a", &["old"], false).await;
    assert_eq!(
        (l.launch.status, l.launch.error.as_deref()),
        (LaunchStatus::Error, Some("Old: not a GitHub repo and not on this machine"))
    );
    std::fs::create_dir_all(e.tmp.join("projects/old")).unwrap();
    let l = launch(&e, "a", &["old"], false).await;
    assert_eq!(l.launch.status, LaunchStatus::Done, "{l:?}");
    assert_eq!(l.launch.parts[1].message.as_deref(), Some("not a git repo — left as is"));
}

// ---------------------------------------------------------- folders and drives
fn folders_and_drives(e: &Env) {
    e.projects.save("folder", &json!({"name": "Home notes", "mountName": "HomeNotes", "source": {"kind": "folder", "path": format!("{}/Notes", e.home().display())}})).unwrap();
    e.projects.save("drive", &json!({"name": "Books", "mountName": "Books", "source": {"kind": "drive", "uuid": STICK, "label": "STICK", "fstype": "exfat", "subpath": "Books"}})).unwrap();
}

#[tokio::test]
async fn folder_and_drive_projects_mount_where_they_are() {
    let e = env().await;
    folders_and_drives(&e);
    std::fs::create_dir(e.home().join("Notes/.git")).unwrap(); // a repository or not, a folder is never fetched
    let l = launch(&e, "a", &["folder", "drive", "vault"], false).await;
    assert_eq!(l.launch.status, LaunchStatus::Done, "{l:?}");
    let msgs: Vec<&str> = l.launch.parts[1..].iter().map(|p| p.message.as_deref().unwrap()).collect();
    assert_eq!(msgs, ["folder on this machine", "on the drive STICK", "on this machine"]);
    assert!(e.host.calls().iter().any(|c| c[0] == "systemd-mount")); // the stick was mounted on the way
    let home = e.home().to_string_lossy().into_owned();
    let stick = e.tmp.join("stick/Books").to_string_lossy().into_owned();
    assert_eq!(
        projects_of(&e, "a"),
        [
            MountedProject { id: "folder".into(), mount: "HomeNotes".into(), path: Some(format!("{home}/Notes")) },
            MountedProject { id: "drive".into(), mount: "Books".into(), path: Some(stick.clone()) },
            MountedProject { id: "vault".into(), mount: "Writing".into(), path: None },
        ]
    );
    let unit = e.fake.0.lock().unwrap().units.iter().find(|(n, _)| n == "wad-a.container").unwrap().1.clone();
    assert!(unit.contains(&format!("Volume={home}/Notes:/config/Desktop/HomeNotes:rw\n")), "{unit}");
    assert!(unit.contains(&format!("Volume={stick}:/config/Desktop/Books:rw\n")), "{unit}");
    assert_eq!(unit.matches("SecurityLabelDisable=true").count(), 1);
    assert_eq!(e.git.0.lock().unwrap().clones.len(), 1); // only the GitHub one
}

#[tokio::test]
async fn folder_and_drive_projects_that_arent_here() {
    for case in ["elsewhere", "missing", "unplugged", "no-subfolder"] {
        let e = env().await;
        folders_and_drives(&e);
        let home = e.home().to_string_lossy().into_owned();
        let (pid, error) = match case {
            "elsewhere" => {
                e.projects.store.merge(&[json!({"id": "desk", "name": "Desk", "mountName": "Desk", "updatedAt": 5,
                    "source": {"kind": "folder", "machineId": "m2", "machineName": "Desk PC", "path": format!("{home}/Notes")}})]);
                ("desk", "Desk is a folder on Desk PC".to_string())
            }
            "missing" => {
                std::fs::remove_dir(e.home().join("Notes")).unwrap();
                ("folder", format!("folder {home}/Notes is missing"))
            }
            "unplugged" => {
                let mut h = e.host.0.lock().unwrap();
                let devs = h.tree["blockdevices"].as_array_mut().unwrap();
                devs.retain(|d| d["name"] != "sdb");
                ("drive", "plug in the drive STICK".to_string())
            }
            _ => {
                std::fs::remove_dir(e.tmp.join("stick/Books")).unwrap();
                ("drive", "folder Books is missing on STICK".to_string())
            }
        };
        let l = launch(&e, "a", &[pid], false).await;
        assert_eq!((l.launch.status, l.launch.error.as_deref()), (LaunchStatus::Error, Some(error.as_str())), "{case}");
        assert_eq!(l.launch.parts[1].state, PartState::Error, "{case}");
        assert_eq!(starts(&e, "wad-a.service"), 0, "{case}");
        let _ = &e.d;
    }
}
