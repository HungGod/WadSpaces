//! A native workspace, streamed: three units that fit together.

use serde_json::json;
use wad_core::generator::{quadlet, stream_quadlets};

#[test]
fn a_streamed_workspace_draws_on_its_sidecar() {
    let w = json!({"id": "writing", "name": "Writing", "image": "ghcr.io/o/writing:latest", "display": "host",
        "env": {"PUID": "1000", "PGID": "1000", "TZ": "Pacific/Fiji", "GIT_USER_NAME": "x"},
        "secrets": ["github_token"], "devices": ["/dev/dri"], "shm_size": "1g",
        "projects": [{"id": "p1", "mount": "notes"}]});
    let stream = json!({"port": 47801, "user": "hunggod", "image": "localhost/wadspaces-stream:trixie",
        "tls_dir": "/var/lib/wadspaces/streams/tls"});
    let units = stream_quadlets(&w, &stream, "/p", "/s", None);
    let names: Vec<&str> = units.iter().map(|u| u.0.as_str()).collect();
    assert_eq!(names, ["wad-writing.container", "wad-writing-display.container", "wad-writing-display.volume"]);
    let (ws, display, volume) = (&units[0].1, &units[1].1, &units[2].1);

    // The workspace: on the sidecar's display, never the screen; its own
    // settings as on the screen.
    assert!(ws.contains("Requires=wad-writing-display.service\nAfter=wad-writing-display.service"));
    assert!(ws.contains("Volume=wad-writing-display.volume:/run/wadspaces-display:z"));
    assert!(!ws.contains("/run/user/1000") && !ws.contains("SecurityLabelDisable"));
    assert!(!ws.contains("PublishPort"));
    for l in [
        "Secret=github_token",
        "Environment=GIT_USER_NAME=x",
        "Volume=/p/p1:/config/Desktop/notes:rw,z",
        "AddDevice=/dev/dri",
    ] {
        assert!(ws.contains(l), "{l}");
    }
    // Everything but the display lines is the screen unit's.
    let screen = quadlet(&w, "/p", "/s", None);
    let strip = |u: &str| {
        u.lines()
            .filter(|l| !l.contains("display") && !l.contains("SecurityLabel"))
            .map(String::from)
            .collect::<Vec<_>>()
    };
    assert_eq!(strip(ws), strip(&screen));

    // The sidecar: HTTPS only, the password from a secret, our certificate.
    for l in [
        "Image=localhost/wadspaces-stream:trixie",
        "ContainerName=wad-writing-display",
        "Label=wadspaces.id=writing",
        "Environment=CUSTOM_USER=hunggod",
        "Environment=PUID=1000",
        "Environment=SELKIES_FILE_TRANSFERS=none",
        "Secret=wad_stream_password,type=env,target=PASSWORD",
        "Volume=wad-writing-display.volume:/run/wadspaces-display:z",
        "Volume=/var/lib/wadspaces/streams/tls/cert.pem:/config/ssl/cert.pem:ro,z",
        "Volume=/var/lib/wadspaces/streams/tls/key.pem:/config/ssl/cert.key:ro,z",
        "PublishPort=47801:3001",
        "AddDevice=/dev/dri",
        "ShmSize=1g",
        "Pull=never",
    ] {
        assert!(display.contains(l), "{l}\n{display}");
    }
    assert_eq!(display.matches("PublishPort").count(), 1);
    assert!(!display.contains("GIT_USER_NAME") && !display.contains("github_token"));
    assert!(!display.contains("[Install]"));
    assert!(volume.contains("VolumeName=wad-writing-display\nUser=1000\nGroup=1000"));

    // Rootless: both containers mapped the same way.
    let units = stream_quadlets(&w, &stream, "/p", "/s", Some(1000));
    assert!(units[0].1.contains("UIDMap=") && units[1].1.contains("UIDMap="));
}

/// A value can't add lines to a unit (a name from someone else's design).
#[test]
fn values_stay_on_their_line() {
    let evil = "Writing\n[Service]\nExecStartPre=/bin/sh -c 'id > /tmp/owned'";
    let w = json!({"id": "w", "name": evil, "image": "i", "display": "host",
        "env": {"TZ": "x\r\nExecStart=/bin/false"}, "devices": ["/dev/dri"]});
    let stream = json!({"port": 47801, "user": "u", "image": "s", "tls_dir": "/t"});
    let mut units = vec![("q".to_string(), quadlet(&w, "/p", "/s", None))];
    units.extend(stream_quadlets(&w, &stream, "/p", "/s", None));
    for (name, text) in units {
        assert!(!text.lines().any(|l| l.starts_with("ExecStart")), "{name}:\n{text}");
        assert_eq!(
            text.lines().filter(|l| *l == "[Service]").count(),
            usize::from(!name.ends_with(".volume")),
            "{name}:\n{text}"
        );
    }
}
