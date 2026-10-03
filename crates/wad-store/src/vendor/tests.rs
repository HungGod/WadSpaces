use wad_proto::v1::{Display, MountedProject};

use super::*;

fn write(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

const WRITING: &str = r#"
name = "Writing"
image = "ghcr.io/hunggod/wadspaces-cosmic-bodybuilding:latest"
display = "host"
hotkey = 1
secrets = ["github_token"]
devices = ["/dev/dri"]
[env]
PUID = "1000"
TZ = "Pacific/Fiji"
"#;

#[test]
fn reads_the_images_workspaces_with_the_yaml_defaults() {
    let d = tempfile::tempdir().unwrap();
    assert!(read(&d.path().join("none")).unwrap().is_empty());
    write(d.path(), "writing.toml", WRITING);
    write(d.path(), "notes.txt", "ignored");
    let v = read(d.path()).unwrap();
    let w = &v[0].workspace;
    assert_eq!(
        (w.id.as_str(), w.display, w.hotkey, w.container_name.as_str()),
        ("writing", Display::Host, Some(1), "wad-writing")
    );
    assert_eq!(w.env, [("PUID".to_string(), "1000".to_string()), ("TZ".into(), "Pacific/Fiji".into())]);
    assert_eq!((w.enabled, w.shm_size.as_deref()), (true, Some("1g")));
    // The same workspace, the same digest; a change, another.
    assert_eq!(read(d.path()).unwrap()[0].digest, v[0].digest);
    write(d.path(), "writing.toml", &WRITING.replace("hotkey = 1", "hotkey = 2"));
    assert_ne!(read(d.path()).unwrap()[0].digest, v[0].digest);
}

#[test]
fn refuses_a_bad_set() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "writing.toml", &format!("id = \"other\"\n{WRITING}"));
    assert!(read(d.path()).unwrap_err().to_string().contains("isn't the file's name"));
    write(d.path(), "writing.toml", WRITING);
    write(d.path(), "second.toml", &WRITING.replace("Writing", "Second")); // hotkey 1 twice
    assert!(read(d.path()).is_err());
}

#[test]
fn applies_what_is_new_or_changed_and_keeps_the_machines_projects() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "writing.toml", WRITING);
    let vendor = read(d.path()).unwrap();
    let (mut list, mut book) = (vec![], Book::new());
    assert_eq!(apply(&mut list, &mut book, &vendor).changed, ["writing"]);
    assert_eq!(list.len(), 1);
    // Applied once: the machine's changes stay.
    list[0].name = "My writing".into();
    list[0].projects = vec![MountedProject { id: "p1".into(), mount: "notes".into(), path: None }];
    assert_eq!(apply(&mut list, &mut book, &vendor), Applied::default());
    assert_eq!(list[0].name, "My writing");
    // Deleted here: stays deleted.
    let kept = list.clone();
    list.clear();
    assert_eq!(apply(&mut list, &mut book, &vendor), Applied::default());
    assert!(list.is_empty());
    // The image changes it: applied over the machine's, keeping its projects.
    list = kept;
    write(d.path(), "writing.toml", &WRITING.replace("cosmic-bodybuilding:latest", "cosmic-bodybuilding:v2"));
    let vendor = read(d.path()).unwrap();
    assert_eq!(apply(&mut list, &mut book, &vendor).changed, ["writing"]);
    assert_eq!(
        (list[0].name.as_str(), list[0].image.as_str()),
        ("Writing", "ghcr.io/hunggod/wadspaces-cosmic-bodybuilding:v2")
    );
    assert_eq!(list[0].projects[0].id, "p1");
    // Saved and read back.
    write_book(d.path(), &book).unwrap();
    assert_eq!(read_book(d.path()), book);
}

#[test]
fn a_clash_with_the_machines_workspaces_is_left_out_and_retried() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "writing.toml", WRITING);
    let vendor = read(d.path()).unwrap();
    // A workspace built here already has Super+1.
    let mut mine = vendor[0].workspace.clone();
    mine.id = "mine".into();
    mine.container_name = "wad-mine".into();
    mine.name = "Mine".into();
    let (mut list, mut book) = (vec![mine], Book::new());
    let a = apply(&mut list, &mut book, &vendor);
    assert_eq!((a.changed.len(), a.refused.len()), (0, 1));
    assert!(book.is_empty() && list.len() == 1);
    list[0].hotkey = Some(5);
    assert_eq!(apply(&mut list, &mut book, &vendor).changed, ["writing"]);
}

/// The image's own workspaces (host/usr/lib/wadspaces/workspaces.d) read
/// and check, and are the ones the Python wadd's last image had.
#[test]
fn the_images_workspaces_are_valid() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../host/usr/lib/wadspaces/workspaces.d");
    let v = read(&dir).unwrap();
    let ids: Vec<&str> = v.iter().map(|w| w.workspace.id.as_str()).collect();
    assert_eq!(ids, ["iq-dev", "kale-b", "kale-p", "vanua-academy", "wad-c", "writing"]);
    for w in &v {
        let w = &w.workspace;
        assert_eq!(w.display, Display::Host, "{}", w.id);
        let icon = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../host")
            .join(w.icon.as_deref().unwrap().trim_start_matches('/'));
        assert!(icon.is_file(), "{}", icon.display());
    }
    let yaml = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../legacy/wadd-py/host/workspaces.yaml");
    let mut old = crate::legacy::read(&yaml, None).unwrap().workspaces;
    old.sort_by(|a, b| a.id.cmp(&b.id));
    let new: Vec<_> = v.into_iter().map(|w| w.workspace).collect();
    assert_eq!(new, old);
}

#[test]
fn a_line_break_in_a_value_is_refused() {
    for raw in [
        serde_json::json!({"id": "w", "name": "W\n[Service]", "image": "i", "display": "host"}),
        serde_json::json!({"id": "w", "name": "W", "image": "i", "display": "host", "env": {"A": "1\nB=2"}}),
        serde_json::json!({"id": "w", "name": "W", "image": "i", "display": "host", "volumes": ["a:/b\r"]}),
    ] {
        let e = crate::legacy::check_workspaces(vec![raw]).unwrap_err().to_string();
        assert!(e.contains("control character"), "{e}");
    }
    let ok = serde_json::json!({"id": "w", "name": "Wad Creator – dev", "image": "i", "display": "host"});
    assert!(crate::legacy::check_workspaces(vec![ok]).is_ok());
}
