use serde_json::json;

use super::*;

#[tokio::test]
async fn messages_round_trip() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    b.write_all(&pack(RUN_COMMAND, br#"[{"success": true}]"#)).await.unwrap();
    let (t, v) = read_message(&mut a).await.unwrap();
    assert_eq!((t, v), (RUN_COMMAND, json!([{"success": true}])));
}

#[test]
fn owners_from_cgroups() {
    let a = "a".repeat(64);
    let quadlet = format!("0::/system.slice/wad-writing.service/libpod-payload-{a}\n");
    assert_eq!(cgroup_owner(&quadlet), Some(Owner::Workspace("writing".into())));
    let rootless =
        format!("0::/user.slice/user-1000.slice/user@1000.service/app.slice/wad-iq-dev.service/libpod-payload-{a}\n");
    assert_eq!(cgroup_owner(&rootless), Some(Owner::Workspace("iq-dev".into())));
    let b = "b".repeat(64);
    let plain = format!("0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-{b}.scope/container\n");
    assert_eq!(cgroup_owner(&plain), Some(Owner::Container(b)));
    assert_eq!(cgroup_owner("0::/user.slice/user-1000.slice/session-2.scope\n"), None);
    assert_eq!(cgroup_owner("0::/system.slice/wad-.service\n"), None);
}

#[test]
fn windows_tiled_and_floating() {
    let tree = json!({"type": "root", "nodes": [{"type": "output", "nodes": [{"type": "workspace", "nodes": [
        {"type": "con", "id": 5, "pid": 100, "nodes": []},
        {"type": "con", "id": 6, "nodes": [{"type": "con", "id": 7, "pid": 101}]},
    ], "floating_nodes": [{"type": "floating_con", "id": 8, "pid": 102}]}]}]});
    let ids: Vec<i64> = windows(&tree).iter().map(|w| w["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, [5, 7, 8]);
}

#[test]
fn only_live_sways() {
    let d = tempfile::tempdir().unwrap();
    let live = d.path().join(format!("sway-ipc.1000.{}.sock", std::process::id()));
    let dead = d.path().join("sway-ipc.1000.999999999.sock");
    std::fs::write(&live, "").unwrap();
    std::fs::write(&dead, "").unwrap();
    assert_eq!(find_socket(d.path()), Some(live.clone()));
    std::fs::remove_file(&live).unwrap();
    assert_eq!(find_socket(d.path()), None);
}

#[test]
fn owner_falls_back_to_the_executable() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("42");
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(p.join("cgroup"), "0::/user.slice/user-1000.slice/session-1.scope\n").unwrap();
    std::os::unix::fs::symlink("/usr/bin/client", p.join("exe")).unwrap();
    assert_eq!(pid_owner(42, d.path()), Some(Owner::Exe("/usr/bin/client".into())));
    let q = d.path().join("43");
    std::fs::create_dir_all(&q).unwrap();
    std::fs::write(
        q.join("cgroup"),
        format!("0::/system.slice/wad-writing.service/libpod-payload-{}\n", "a".repeat(64)),
    )
    .unwrap();
    assert_eq!(pid_owner(43, d.path()), Some(Owner::Workspace("writing".into())));
    assert_eq!(pid_owner(44, d.path()), None);
}

#[tokio::test]
async fn commands_and_events_over_a_socket() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("ipc.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let (t, body) = read_message(&mut s).await.unwrap();
                match t {
                    SUBSCRIBE => {
                        assert_eq!(body, json!(["window"]));
                        s.write_all(&pack(SUBSCRIBE, br#"{"success": true}"#)).await.unwrap();
                        let ev = json!({"change": "new", "container": {"id": 9, "pid": 100}}).to_string();
                        s.write_all(&pack(EVENT_WINDOW, ev.as_bytes())).await.unwrap();
                    }
                    _ => {
                        let reply = json!([{"success": true, "echo": body}]).to_string();
                        s.write_all(&pack(t, reply.as_bytes())).await.unwrap();
                    }
                }
            });
        }
    });
    // Commands aren't JSON; the fake parses its body, so send something that is.
    let sway = Sway::new(Locate::Socket(path));
    assert!(sway.command("1").await.unwrap());
    let mut events = sway.subscribe(&["window"]).await.unwrap();
    let (t, ev) = events.next().await.unwrap();
    assert_eq!(t, EVENT_WINDOW);
    assert_eq!(ev["container"]["id"], 9);
    assert!(events.next().await.is_err()); // the fake hung up: sway went away
}

#[test]
fn screens_are_pinned_at_their_scale() {
    let outputs = json!([
        {"name": "eDP-1", "active": true, "scale": 2.0},
        {"name": "HDMI-A-1", "active": true, "scale": 1.5},
        {"name": "DP-2", "active": false, "scale": -1.0},
        {"name": "bad; exec x", "active": true, "scale": 1.0},
    ]);
    assert_eq!(scale_pins(&outputs), ["output eDP-1 scale 2", "output HDMI-A-1 scale 1.5"]);
    assert!(scale_pins(&json!(null)).is_empty());
}

#[test]
fn the_session_comes_from_sways_environment() {
    let env = b"HOME=/var/home/wad\0WAYLAND_DISPLAY=wayland-1\0A=b=c\0junk\0";
    assert_eq!(
        parse_environ(env),
        [("HOME", "/var/home/wad"), ("WAYLAND_DISPLAY", "wayland-1"), ("A", "b=c")]
            .map(|(k, v)| (k.to_string(), v.to_string()))
    );
    assert_eq!(socket_ids(Path::new("/run/user/1000/sway-ipc.1000.4242.sock")), Some((1000, 4242)));
    assert_eq!(socket_ids(Path::new("/run/user/1000/wayland-1")), None);

    // This process stands in for sway: its socket names our pid.
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join(format!("sway-ipc.1000.{}.sock", std::process::id()));
    std::fs::write(&socket, "").unwrap();
    let s = Sway::new(Locate::RuntimeDir(dir.path().into())).session().unwrap();
    assert_eq!((s.uid, s.runtime_dir.as_path()), (1000, dir.path()));
    let ours = std::env::var("WAYLAND_DISPLAY").ok().filter(|d| !d.is_empty() && !d.contains('/'));
    assert_eq!(s.wayland_display, ours.clone().unwrap_or_else(|| "wayland-1".into()));
    // Not in its environment: the Wayland socket beside it.
    if ours.is_none() {
        let _l = std::os::unix::net::UnixListener::bind(dir.path().join("wayland-3")).unwrap();
        std::fs::write(dir.path().join("wayland-3.lock"), "").unwrap();
        let s = Sway::new(Locate::RuntimeDir(dir.path().into())).session().unwrap();
        assert_eq!(s.wayland_display, "wayland-3");
    }
    assert!(s.env.iter().all(|(k, _)| PASSED_ON.contains(&k.as_str()) || k.starts_with("LC_")));
    assert!(!s.env.iter().any(|(k, _)| k == "PATH" || k == "HOME"));
}
