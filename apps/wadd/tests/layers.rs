//! The Builder's layers on a machine: a template's and a customization's
//! images (the template built first when it's missing or out of date), their
//! labels and listing, deleting one, and wadspaces installed on them with
//! their wallpaper. A fake podman builds; the real registry installs.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::Fake;
use serde_json::{Value, json};
use wad_proto::ErrorCode;
use wad_proto::v1::{BuildLog, BuildStatus, LayerBuildRequest, WallpaperUpload};
use wadd::builds::{Builds, FROM_LABEL, SHA_LABEL};
use wadd::events::Bus;
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
            max_parallel_pulls: 3,
            projects_dir: "/p".into(),
            signins_dir: d.path().join("signins"),
            state_dir: state.clone(),
            rootless_uid: Some(1000),
            poll: Duration::from_millis(10),
        },
    );
    reg.load(vec![]).await.unwrap();
    let builds = Builds::new(reg.clone(), Arc::new(fake.clone()), bus, &state, 8);
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
async fn from_before_the_layers_it_runs_its_old_image() {
    let e = env().await;
    let mut old = wadspace("academy");
    old["legacyImage"] = "localhost/wadspaces-academy:latest".into();
    let req = Install { wadspace: old, template: dev(), customization: Some(plus()), tz: None };
    let ws = images::install(&e.reg, &e.fake, "academy", &req).await.unwrap().workspace;
    assert_eq!(ws.image, "localhost/wadspaces-academy:latest");
    assert!(!ws.env.iter().any(|(k, _)| k == "WALLPAPER"), "its wallpaper is in the image");
    // A wadspace that isn't on what's sent is refused.
    let wrong = Install { wadspace: wadspace("academy"), template: dev(), customization: None, tz: None };
    assert_eq!(images::install(&e.reg, &e.fake, "academy", &wrong).await.unwrap_err().code, ErrorCode::BadRequest);
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
