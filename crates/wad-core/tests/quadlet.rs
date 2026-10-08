//! wadd's quadlet units, from a design someone else may have written.
use serde_json::json;
use wad_core::generator::quadlet;

/// A value can't add lines to a unit (a name from someone else's design).
#[test]
fn values_stay_on_their_line() {
    let evil = "Writing\n[Service]\nExecStartPre=/bin/sh -c 'id > /tmp/owned'";
    let w = json!({"id": "w", "name": evil, "image": "i", "display": "host",
        "env": {"TZ": "x\r\nExecStart=/bin/false"}, "devices": ["/dev/dri"]});
    let text = quadlet(&w, "/p", "/s", None);
    assert!(!text.lines().any(|l| l.starts_with("ExecStart")), "{text}");
    assert_eq!(text.lines().filter(|l| *l == "[Service]").count(), 1, "{text}");
}
