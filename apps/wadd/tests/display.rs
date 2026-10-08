//! The sway watcher against a fake sway (its IPC socket) and a fake /proc:
//! workspace windows are found, moved to their own sway workspace, focused,
//! and forgotten when they close or sway goes away.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use wad_sway::{EVENT_WINDOW, GET_TREE, Locate, Owner, RUN_COMMAND, SUBSCRIBE, Sway, pack};
use wadd::display::{Display, SwayDisplay, WindowSink};
use wadd::registry::Windows;

#[derive(Default)]
struct Sink {
    seen: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl WindowSink for Sink {
    async fn resolve(&self, owner: Owner) -> Option<String> {
        match owner {
            Owner::Workspace(id) => Some(id),
            _ => None,
        }
    }
    fn on_window(&self, id: &str, present: bool) {
        self.seen.lock().unwrap().push((id.into(), present));
    }
}

/// A sway that serves `tree`, records commands, and sends the events the
/// test pushes (dropping the sender hangs up, as sway going away would).
fn fake_sway(path: std::path::PathBuf, tree: Value, commands: Arc<Mutex<Vec<String>>>) -> mpsc::UnboundedSender<Value> {
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let rx = Arc::new(tokio::sync::Mutex::new(rx));
    let listener = tokio::net::UnixListener::bind(path).unwrap();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = listener.accept().await.unwrap();
            let (tree, commands, rx) = (tree.clone(), commands.clone(), rx.clone());
            tokio::spawn(async move {
                let mut head = [0u8; 14];
                use tokio::io::AsyncReadExt;
                // Commands aren't JSON: read the frame by hand.
                s.read_exact(&mut head).await.unwrap();
                let len = u32::from_ne_bytes(head[6..10].try_into().unwrap()) as usize;
                let t = u32::from_ne_bytes(head[10..14].try_into().unwrap());
                let mut body = vec![0u8; len];
                s.read_exact(&mut body).await.unwrap();
                match t {
                    SUBSCRIBE => {
                        s.write_all(&pack(SUBSCRIBE, br#"{"success": true}"#)).await.unwrap();
                        let mut rx = rx.lock().await;
                        while let Some(ev) = rx.recv().await {
                            s.write_all(&pack(EVENT_WINDOW, ev.to_string().as_bytes())).await.unwrap();
                        }
                    }
                    GET_TREE => s.write_all(&pack(GET_TREE, tree.to_string().as_bytes())).await.unwrap(),
                    RUN_COMMAND => {
                        commands.lock().unwrap().push(String::from_utf8(body).unwrap());
                        s.write_all(&pack(RUN_COMMAND, br#"[{"success": true}]"#)).await.unwrap();
                    }
                    _ => {}
                }
            });
        }
    });
    tx
}

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never: {what}");
}

#[tokio::test]
async fn workspace_windows_are_adopted_focused_and_dropped() {
    let d = tempfile::tempdir().unwrap();
    // The app (pid 200) and a workspace's desktop (pid 100).
    let proc = d.path().join("proc");
    std::fs::create_dir_all(proc.join("100")).unwrap();
    std::fs::write(
        proc.join("100/cgroup"),
        format!("0::/system.slice/wad-n.service/libpod-payload-{}\n", "a".repeat(64)),
    )
    .unwrap();
    std::fs::create_dir_all(proc.join("200")).unwrap();
    std::fs::write(proc.join("200/cgroup"), "0::/user.slice/user-1000.slice/session-1.scope\n").unwrap();
    std::os::unix::fs::symlink("/usr/bin/client", proc.join("200/exe")).unwrap();
    let tree = json!({"type": "root", "nodes": [{"type": "workspace", "nodes": [
        {"type": "con", "id": 1, "pid": 200}, {"type": "con", "id": 5, "pid": 100}]}]});
    let commands = Arc::new(Mutex::new(vec![]));
    let sock = d.path().join("sway.sock");
    let events = fake_sway(sock.clone(), tree, commands.clone());

    let windows = Arc::new(Windows::default());
    let display = Arc::new(
        SwayDisplay::new(Sway::new(Locate::Socket(sock)), windows.clone())
            .proc_dir(proc)
            .retry(Duration::from_secs(60)),
    );
    let sink = Arc::new(Sink::default());
    let watcher = tokio::spawn(display.clone().run(sink.clone()));
    let cmds = || commands.lock().unwrap().clone();

    until("the open window is adopted", || sink.seen.lock().unwrap().len() == 1).await;
    assert!(windows.available());
    assert_eq!(cmds(), ["[con_id=5] move container to workspace ws-n, fullscreen enable"]);
    assert!(display.show_native("n").await);
    assert_eq!(cmds().last().map(String::as_str), Some("[con_id=5] focus"));
    display.show_shell().await;
    assert_eq!(cmds().last().map(String::as_str), Some("workspace shell"));

    // It restarts: a new window replaces the old one; the old one closing changes nothing.
    events.send(json!({"change": "new", "container": {"id": 9, "pid": 100}})).unwrap();
    until("the new window is adopted", || sink.seen.lock().unwrap().len() == 2).await;
    events.send(json!({"change": "close", "container": {"id": 5}})).unwrap();
    events.send(json!({"change": "close", "container": {"id": 9}})).unwrap();
    until("the window closes", || sink.seen.lock().unwrap().len() == 3).await;
    assert_eq!(*sink.seen.lock().unwrap(), [("n".into(), true), ("n".into(), true), ("n".into(), false)]);
    assert!(!display.show_native("n").await);

    // sway goes away.
    events.send(json!({"change": "new", "container": {"id": 10, "pid": 100}})).unwrap();
    until("adopted again", || sink.seen.lock().unwrap().len() == 4).await;
    drop(events);
    until("sway is gone", || !windows.available()).await;
    assert_eq!(sink.seen.lock().unwrap().last(), Some(&("n".to_string(), false)));
    watcher.abort();
}
