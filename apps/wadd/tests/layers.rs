//! The Builder's layers on a machine: a template's and a customization's
//! images (the template built first when it's missing or out of date), their
//! labels and listing, deleting one, and wadspaces installed on them with
//! their wallpaper; and what any build does: one at a time, cancelling, a
//! missing base or too little disk, and web apps' icons made first. A fake
//! podman builds; the real registry installs.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Fake, ws};
use serde_json::{Value, json};
use wad_proto::ErrorCode;
use wad_proto::v1::{BuildLog, BuildStatus, Display, LayerBuildRequest, WallpaperUpload};
use wadd::builds::{Builds, FROM_LABEL, SHA_LABEL};
use wadd::events::Bus;
use wadd::icons::Icons;
use wadd::images::{self, Install};
use wadd::registry::{Registry, Settings};

const BASE: &str = "localhost/wadspaces-base:trixie";
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

struct Env {
    _d: tempfile::TempDir,
    state: std::path::PathBuf,
    fake: Fake,
    reg: Arc<Registry>,
    builds: Arc<Builds>,
}

async fn env() -> Env {
    env_with(None).await
}

async fn env_with(icons: Option<Arc<Icons>>) -> Env {
    let d = tempfile::tempdir().unwrap();
    let state = d.path().join("state");
    let fake = Fake::default();
    fake.with(|m| {
        m.images.insert(BASE.into());
        m.image_labels.insert(BASE.into(), json!({"io.wadspaces.projects": "1"}).as_object().unwrap().clone());
        m.free_gb = 100.0;
    });
    let bus = Bus::new(wad_proto::v1::MachineInfo {
        name: "t".into(),
        version: "0".into(),
        profile: wad_proto::v1::Profile::User,
        started_at: 0,
        screen: None,
    });
    let reg = Registry::new(
        Arc::new(fake.clone()),
        bus.clone(),
        Settings {
            ready_timeout: Duration::from_secs(10),
            projects_dir: "/p".into(),
            signins_dir: d.path().join("signins"),
            state_dir: state.clone(),
            rootless_uid: Some(1000),
            poll: Duration::from_millis(10),
        },
    );
    reg.load(vec![]).await.unwrap();
    let builds = match icons {
        Some(i) => Builds::with_icons(Arc::new(fake.clone()), bus, &state, 8, i),
        None => Builds::new(Arc::new(fake.clone()), bus, &state, 8),
    };
    Env { _d: d, state, fake, reg, builds }
}

fn dev() -> Value {
    json!({"id": "dev", "owner": "me", "name": "Dev", "description": "", "apps": ["wadbrowser", "vscode"], "createdAt": "t", "updatedAt": "t"})
}

fn plus() -> Value {
    json!({"id": "dev-plus", "owner": "me", "name": "Dev plus", "description": "", "templateId": "dev", "browserMode": "focus",
           "webapps": [{"id": "github", "name": "GitHub", "url": "https://github.com"}],
           "extensions": ["anthropic.claude-code"], "tools": ["go"], "autostart": [], "createdAt": "t", "updatedAt": "t"})
}

fn custom(t: Value, c: Value) -> LayerBuildRequest {
    LayerBuildRequest { layer: format!("custom:{}", c["id"].as_str().unwrap()), template: t, customization: Some(c) }
}

/// A build's log once it's finished (in 30 s at most: a loaded CI machine is slow).
async fn wait(e: &Env, id: &str) -> BuildLog {
    for _ in 0..3000 {
        let l = e.builds.log(id, 0).unwrap();
        if l.build.status.finished() {
            return l;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("build stuck: {:?}", e.builds.log(id, 0).unwrap());
}

fn label(e: &Env, image: &str, key: &str) -> Option<String> {
    let m = e.fake.0.lock().unwrap();
    m.image_labels.get(image).and_then(|l| l.get(key)).and_then(Value::as_str).map(String::from)
}

const T_REF: &str = "localhost/wadspaces-template-dev:latest";
const C_REF: &str = "localhost/wadspaces-custom-dev-plus:latest";

#[tokio::test]
async fn a_customization_builds_its_template_first_then_itself() {
    let e = env().await;
    let b = e.builds.create_layer(&custom(dev(), plus())).unwrap();
    assert_eq!((b.layer.as_deref(), b.image.as_str(), b.base_image.as_str()), (Some("custom:dev-plus"), C_REF, BASE));
    let l = wait(&e, &b.id).await;
    assert_eq!(l.build.status, BuildStatus::Done, "{:?}", l.lines);
    assert!(l.lines.iter().any(|x| x == "» Building the Dev template first"), "{:?}", l.lines);
    let built: Vec<(String, String)> =
        e.fake.0.lock().unwrap().builds.iter().map(|(t, b, _)| (t.clone(), b.clone())).collect();
    assert_eq!(built, [(T_REF.into(), BASE.into()), (C_REF.into(), T_REF.into())]);
    // Labelled with their folders' shas and what they were built on.
    let t_layer = wad_core::layers::template_layer(&dev());
    assert_eq!(label(&e, T_REF, SHA_LABEL).as_deref(), t_layer["sha"].as_str());
    let template_id = e.fake.0.lock().unwrap().image_ids[T_REF].clone();
    assert_eq!(label(&e, C_REF, FROM_LABEL), Some(template_id));
    // They keep the base's: projects can be mounted into them.
    assert_eq!(label(&e, C_REF, "io.wadspaces.projects").as_deref(), Some("1"));
    // The customization's folder has its web app's icon (made here first).
    let tar = e.fake.0.lock().unwrap().builds[1].2.clone();
    assert!(String::from_utf8_lossy(&tar).contains("wadspaces-webapp-github.png"));
    assert!(l.build.progress >= 1.0);
}

#[tokio::test]
async fn a_built_template_isnt_built_again_until_it_changes() {
    let e = env().await;
    let b = e
        .builds
        .create_layer(&LayerBuildRequest { layer: "template:dev".into(), template: dev(), customization: None })
        .unwrap();
    wait(&e, &b.id).await;
    let b = e.builds.create_layer(&custom(dev(), plus())).unwrap();
    let l = wait(&e, &b.id).await;
    assert!(l.lines.iter().any(|x| x == "» the Dev template is built already"), "{:?}", l.lines);
    assert_eq!(e.fake.0.lock().unwrap().builds.len(), 2);
    // The template changes: built again, under its customization.
    let mut changed = dev();
    changed["apps"] = json!(["wadbrowser", "vscode", "tiled"]);
    let b = e.builds.create_layer(&custom(changed, plus())).unwrap();
    let l = wait(&e, &b.id).await;
    assert!(l.lines.iter().any(|x| x == "» Building the Dev template first"), "{:?}", l.lines);
    assert_eq!(e.fake.0.lock().unwrap().builds.len(), 4);
}

#[tokio::test]
async fn images_list_with_their_shas_and_a_rebuilt_template_shows() {
    let e = env().await;
    let b = e.builds.create_layer(&custom(dev(), plus())).unwrap();
    wait(&e, &b.id).await;
    let rows = images::list(&e.fake).await.unwrap();
    let layers: Vec<&str> = rows.iter().map(|r| r.layer.as_str()).collect();
    assert_eq!(layers, ["custom:dev-plus", "template:dev"]);
    let (c, t) = (&rows[0], &rows[1]);
    assert_eq!(c.image_ref, C_REF);
    assert_eq!(c.dockerfile_sha, wad_core::layers::customization_layer(&plus(), &dev())["sha"].as_str().unwrap());
    // Built on the template's image as it is: unchanged.
    assert_eq!(c.from, t.id);
    // The template rebuilt: the customization's `from` is an older image now.
    let b = e.builds.create_layer(&LayerBuildRequest {
        layer: "template:dev".into(),
        template: json!({"id": "dev", "name": "Dev", "apps": ["wadbrowser", "vscode", "lmms"]}),
        customization: None,
    });
    wait(&e, &b.unwrap().id).await;
    let rows = images::list(&e.fake).await.unwrap();
    assert_ne!(rows[0].from, rows[1].id, "a customization on an older template build");
}

#[tokio::test]
async fn layer_requests_are_checked() {
    let e = env().await;
    let bad = |r: LayerBuildRequest| e.builds.create_layer(&r).unwrap_err().code;
    assert_eq!(
        bad(LayerBuildRequest { layer: "template:other".into(), template: dev(), customization: None }),
        ErrorCode::BadRequest
    );
    assert_eq!(
        bad(LayerBuildRequest { layer: "custom:dev-plus".into(), template: dev(), customization: None }),
        ErrorCode::BadRequest
    );
    let mut elsewhere = plus();
    elsewhere["templateId"] = "writing".into();
    assert_eq!(bad(custom(dev(), elsewhere)), ErrorCode::BadRequest);
    let mut nothing = dev();
    nothing["apps"] = json!(["brave"]);
    assert_eq!(
        bad(LayerBuildRequest { layer: "template:dev".into(), template: nothing, customization: None }),
        ErrorCode::BadRequest
    );
    // No base here: the build says so.
    e.fake.with(|m| {
        m.images.remove(BASE);
    });
    let b = e
        .builds
        .create_layer(&LayerBuildRequest { layer: "template:dev".into(), template: dev(), customization: None })
        .unwrap();
    let l = wait(&e, &b.id).await;
    assert_eq!(l.build.status, BuildStatus::Error);
    assert!(l.build.error.unwrap().contains("not on this machine"));
}

fn wadspace(id: &str) -> Value {
    json!({"version": 2, "id": id, "owner": "me", "name": "Academy", "description": "",
           "base": {"kind": "customization", "id": "dev-plus"},
           "wallpaper": {"type": "image", "value": "data:image/jpeg;base64,/9j/"},
           "projects": ["p1"],
           "secrets": {"web:github": {"id": "gh-abc123", "name": "GitHub", "kind": "web"},
                       "ext:anthropic.claude-code": {"id": "cc-abc123", "name": "Claude", "kind": "vscode-claude-code"}},
           "createdAt": "t", "updatedAt": "t"})
}

#[tokio::test]
async fn a_wadspace_installs_on_its_layer_with_its_wallpaper_and_sign_ins() {
    let e = env().await;
    e.fake.with(|m| {
        m.secrets.insert("github_token".into(), b"t".to_vec());
    });
    let req = Install {
        wadspace: wadspace("academy"),
        template: dev(),
        customization: Some(plus()),
        tz: Some("Pacific/Fiji".into()),
    };
    let saved = images::install(&e.reg, &e.fake, "academy", &req).await.unwrap();
    let ws = saved.workspace;
    assert_eq!((ws.image.as_str(), ws.hotkey, ws.autostart), (C_REF, None, false));
    let env: Vec<(&str, &str)> = ws.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert!(env.contains(&("WALLPAPER", "/run/wadspaces-extra/wallpaper.jpg")), "{env:?}");
    assert!(env.contains(&("TITLE", "Academy")) && env.contains(&("TZ", "Pacific/Fiji")), "{env:?}");
    assert_eq!(ws.secrets, ["github_token"]);
    assert_eq!(ws.volumes, ["wad-academy-config:/config:z"]);
    let s: Vec<(&str, &str, &str, bool)> =
        ws.signins.iter().map(|s| (s.id.as_str(), s.app.as_str(), s.slot.as_str(), s.web)).collect();
    assert_eq!(
        s,
        [("gh-abc123", "github", "web:github", true), ("cc-abc123", "vscode", "ext:anthropic.claude-code", false)]
    );
    // Its unit mounts the extra folder, where the wallpaper goes.
    let unit = e.reg.unit_text(&ws);
    assert!(unit.contains("/extra/academy:/run/wadspaces-extra:ro,z"), "{unit}");
    images::put_wallpaper(&e.state, &ws, &WallpaperUpload { ext: "png".into(), data: PNG.into() }).unwrap();
    assert!(e.state.join("extra/academy/wallpaper.png").is_file());
    let refused = images::put_wallpaper(&e.state, &ws, &WallpaperUpload { ext: "jpg".into(), data: PNG.into() });
    assert_eq!(refused.unwrap_err().code, ErrorCode::BadRequest, "a PNG isn't a jpg");
    // Installed again (renamed): the same workspace, updated.
    let mut renamed = wadspace("academy");
    renamed["name"] = "Academy 2".into();
    let req = Install { wadspace: renamed, ..req };
    images::install(&e.reg, &e.fake, "academy", &req).await.unwrap();
    assert_eq!(
        e.reg.workspaces().iter().filter(|w| w.id == "academy").map(|w| w.name.clone()).collect::<Vec<_>>(),
        ["Academy 2"]
    );
}

#[tokio::test]
async fn a_wadspace_on_layers_it_doesnt_have_is_refused() {
    let e = env().await;
    // A wadspace that isn't on what's sent is refused.
    let wrong = Install { wadspace: wadspace("academy"), template: dev(), customization: None, tz: None };
    assert_eq!(images::install(&e.reg, &e.fake, "academy", &wrong).await.unwrap_err().code, ErrorCode::BadRequest);
}

#[tokio::test]
async fn wadspaces_from_before_the_layers_go_with_their_images() {
    let e = env().await;
    let req = Install { wadspace: wadspace("academy"), template: dev(), customization: Some(plus()), tz: None };
    images::install(&e.reg, &e.fake, "academy", &req).await.unwrap();
    let mut old = common::ws(
        "writing",
        "ghcr.io/hunggod/wadspaces-cosmic-bodybuilding:latest",
        wad_proto::v1::Display::Host,
        None,
    );
    old.volumes = vec!["wad-writing-obsidian:/config/.config/obsidian:z".into()];
    let mut list = e.reg.workspaces();
    list.push(old);
    e.reg.set_workspaces(list).await.unwrap();
    e.fake.with(|m| {
        m.images.insert("ghcr.io/hunggod/wadspaces-cosmic-bodybuilding:latest".into());
    });
    e.reg.sweep_old().await;
    let ids: Vec<String> = e.reg.workspaces().into_iter().map(|w| w.id).collect();
    assert_eq!(ids, ["academy"]);
    assert!(!e.fake.0.lock().unwrap().images.contains("ghcr.io/hunggod/wadspaces-cosmic-bodybuilding:latest"));
    // Nothing left to do the next time.
    e.reg.sweep_old().await;
    assert_eq!(e.reg.workspaces().len(), 1);
}

#[tokio::test]
async fn an_image_isnt_deleted_while_a_wadspace_runs_on_it() {
    let e = env().await;
    let b = e.builds.create_layer(&custom(dev(), plus())).unwrap();
    wait(&e, &b.id).await;
    let req = Install { wadspace: wadspace("academy"), template: dev(), customization: Some(plus()), tz: None };
    images::install(&e.reg, &e.fake, "academy", &req).await.unwrap();
    let refused = images::delete(&e.reg, &e.builds, &e.fake, "custom:dev-plus").await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Conflict);
    assert!(refused.message.contains("Academy"), "{}", refused.message);
    // The template's image has no workspace of its own: it can go.
    images::delete(&e.reg, &e.builds, &e.fake, "template:dev").await.unwrap();
    e.reg.remove_workspace("academy").await.unwrap();
    images::delete(&e.reg, &e.builds, &e.fake, "custom:dev-plus").await.unwrap();
    assert!(e.fake.calls().contains(&format!("rmi {C_REF}")));
    assert_eq!(
        images::delete(&e.reg, &e.builds, &e.fake, "custom:dev-plus").await.unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(images::delete(&e.reg, &e.builds, &e.fake, "../x").await.unwrap_err().code, ErrorCode::BadRequest);
}

fn template(t: Value) -> LayerBuildRequest {
    LayerBuildRequest { layer: format!("template:{}", t["id"].as_str().unwrap()), template: t, customization: None }
}

#[tokio::test]
async fn a_missing_base_says_how_to_get_it() {
    let e = env().await;
    e.fake.with(|m| m.images.clear());
    let l = wait(&e, &e.builds.create_layer(&template(dev())).unwrap().id).await;
    assert_eq!(l.build.status, BuildStatus::Error);
    assert_eq!(
        l.build.error.as_deref(),
        Some(
            "localhost/wadspaces-base:trixie is not on this machine — update the drive with host/build.sh update --bases"
        )
    );
    assert!(e.fake.0.lock().unwrap().builds.is_empty());
}

#[tokio::test]
async fn short_on_disk_and_failed_builds() {
    let e = env().await;
    e.fake.with(|m| m.free_gb = 3.0);
    let l = wait(&e, &e.builds.create_layer(&template(dev())).unwrap().id).await;
    assert_eq!(l.build.error.as_deref(), Some("only 3.0 GB free; building needs at least 8 GB"));
    e.fake.with(|m| {
        m.free_gb = 100.0;
        m.build_fails = Some("RUN apt-get install: exit status 100".into());
    });
    let l = wait(&e, &e.builds.create_layer(&template(dev())).unwrap().id).await;
    assert_eq!(
        (l.build.status, l.build.error.as_deref()),
        (BuildStatus::Error, Some("RUN apt-get install: exit status 100"))
    );
    assert!(l.build.progress < 1.0); // STEP n/m counts what came before n
}

#[tokio::test]
async fn one_build_at_a_time_and_cancelling() {
    let e = env().await;
    e.fake.with(|m| m.build_slow = true);
    let first = e.builds.create_layer(&template(dev())).unwrap();
    let err = e.builds.create_layer(&template(dev())).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict); // the same one: once
    let mut writing = dev();
    writing["id"] = "writing".into();
    writing["apps"] = json!(["obsidian"]);
    let second = e.builds.create_layer(&template(writing)).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(e.builds.log(&first.id, 0).unwrap().build.status, BuildStatus::Building);
    assert_eq!(e.builds.log(&second.id, 0).unwrap().build.status, BuildStatus::Queued); // waits its turn
    assert_eq!(e.builds.cancel(&first.id).unwrap().status, BuildStatus::Cancelled);
    assert_eq!(e.builds.log(&first.id, 0).unwrap().lines.last().map(String::as_str), Some("✗ cancelled"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(e.builds.log(&second.id, 0).unwrap().build.status, BuildStatus::Building); // its turn now
    e.builds.cancel(&second.id).unwrap();
    assert_eq!(e.builds.list().len(), 2);
    assert_eq!(e.builds.log("nope", 0).unwrap_err().code, ErrorCode::NotFound);
}

const DOT: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

#[tokio::test]
async fn web_apps_get_their_icons_before_the_build() {
    use wiremock::matchers::path;
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let site = MockServer::start().await;
    Mock::given(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html><head></head></html>"))
        .mount(&site)
        .await;
    let favicon = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, DOT).unwrap();
    Mock::given(path("/favicon.ico"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "image/png").set_body_bytes(favicon))
        .mount(&site)
        .await;

    let e = env_with(Some(Icons::for_tests())).await;
    let mut c = plus();
    c["webapps"] = json!([
        {"id": "site", "name": "Site", "url": site.uri()},
        // Nobody answers there: a card with its name.
        {"id": "gone", "name": "Gone", "url": "http://127.0.0.1:9/"},
    ]);
    let l = wait(&e, &e.builds.create_layer(&custom(dev(), c)).unwrap().id).await;
    assert_eq!(l.build.status, BuildStatus::Done, "{l:?}");
    assert!(
        l.lines.iter().any(|x| x == "» icons for 2 web apps: 1 from their sites, 0 chosen, 1 with their names"),
        "{:?}",
        l.lines
    );
    let builds = e.fake.0.lock().unwrap().builds.clone();
    let (_, _, context) = builds.last().unwrap().clone();
    let files = common::tar_names(&context);
    for id in ["site", "gone"] {
        let want = format!("root/usr/share/icons/hicolor/512x512/apps/wadspaces-webapp-{id}.png");
        assert!(files.contains(&want), "{want} not in {files:?}");
    }
}

#[test]
fn a_wadspace_cannot_take_an_apps_id() {
    let current = vec![common::app("terminal", "/usr/bin/foot"), ws("w", "i", Display::Host, None)];
    let fresh =
        json!({"id": "terminal", "name": "T", "image": "localhost/wadspaces-terminal:latest", "display": "host"});
    let e = wadd::builds::merged(&current, &fresh).unwrap_err();
    assert!(e.contains("one of this machine's own apps"), "{e}");
    let other = json!({"id": "w", "name": "W2", "image": "localhost/wadspaces-w:latest", "display": "host"});
    assert!(wadd::builds::merged(&current, &other).unwrap().1);
}
