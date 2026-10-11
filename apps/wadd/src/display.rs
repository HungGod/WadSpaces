//! Putting things on screen. WadSpaces Client is the app's own window on sway's
//! "shell" workspace; a native workspace (display: host) is its own window
//! too, which wadd moves to a workspace of its own (`ws-<id>`) and focuses
//! to show it. Streamed workspaces are shown by the app.
//!
//! The host's sway config sends every new window except the app's to a
//! hidden "pending" workspace, so a desktop never grabs the screen while it
//! starts; the watcher here adopts it once it's known whose it is.
//!
//! Without sway (a laptop, tests) NullDisplay stands in: nothing native can
//! be shown, and workspaces count as ready once they run.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use wad_sway::{EVENT_WINDOW, Owner, Sway};

use crate::registry::Windows;

pub const SHELL: &str = "shell";

#[async_trait]
pub trait Display: Send + Sync + 'static {
    async fn show_shell(&self);
    /// Focuses a native workspace's window; false if it has none.
    async fn show_native(&self, id: &str) -> bool;
    /// The screen's logical size; None without a compositor.
    async fn screen(&self) -> Option<wad_proto::v1::Screen> {
        None
    }
}

/// The first active output's logical size and scale (sway's get_outputs).
pub fn screen_of(outputs: &serde_json::Value) -> Option<wad_proto::v1::Screen> {
    let o = outputs.as_array()?.iter().find(|o| o["active"] == true)?;
    let (w, h) = (o["rect"]["width"].as_u64()?, o["rect"]["height"].as_u64()?);
    Some(wad_proto::v1::Screen { width: w as u32, height: h as u32, scale: o["scale"].as_f64().unwrap_or(1.0) })
}

/// Who a window belongs to, and what to do when one comes or goes (the view).
#[async_trait]
pub trait WindowSink: Send + Sync + 'static {
    async fn resolve(&self, owner: Owner) -> Option<String>;
    fn on_window(&self, id: &str, present: bool);
}

pub struct NullDisplay;

#[async_trait]
impl Display for NullDisplay {
    async fn show_shell(&self) {}
    async fn show_native(&self, _: &str) -> bool {
        false
    }
}

pub struct SwayDisplay {
    sway: Sway,
    windows: Arc<Windows>,
    /// Workspace id -> its windows' sway con_ids, the newest (the one shown) last.
    cons: Mutex<HashMap<String, Vec<i64>>>,
    proc: PathBuf,
    retry: Duration,
}

impl SwayDisplay {
    pub fn new(sway: Sway, windows: Arc<Windows>) -> Self {
        Self { sway, windows, cons: Mutex::default(), proc: "/proc".into(), retry: Duration::from_secs(2) }
    }

    /// Reads windows' owners from another /proc (tests).
    pub fn proc_dir(mut self, proc: PathBuf) -> Self {
        self.proc = proc;
        self
    }

    /// How long to wait before looking for sway again.
    pub fn retry(mut self, retry: Duration) -> Self {
        self.retry = retry;
        self
    }

    async fn cmd(&self, cmd: &str) -> bool {
        match self.sway.command(cmd).await {
            Ok(true) => true,
            Ok(false) => {
                tracing::warn!("sway {cmd:?} failed");
                false
            }
            Err(e) => {
                tracing::debug!("sway {cmd:?}: {e}");
                false
            }
        }
    }

    async fn adopt(&self, con: &Value, sink: &dyn WindowSink) {
        let (Some(pid), Some(con_id)) = (con.get("pid").and_then(Value::as_i64), con.get("id").and_then(Value::as_i64))
        else {
            return;
        };
        let Some(owner) = wad_sway::pid_owner(pid, &self.proc) else { return };
        let Some(id) = sink.resolve(owner).await else { return };
        {
            let mut cons = self.cons.lock().unwrap();
            let list = cons.entry(id.clone()).or_default();
            if list.contains(&con_id) {
                return;
            }
            // A workspace's desktop is one window, and a second one (it
            // restarted before the old window went) takes over; an app (the
            // browser) can have several. The newest is the one shown.
            list.push(con_id);
        }
        self.cmd(&format!("[con_id={con_id}] move container to workspace ws-{id}, fullscreen enable")).await;
        tracing::info!("native window for {id} (con {con_id})");
        sink.on_window(&id, true);
    }

    async fn drop_con(&self, con_id: i64, sink: &dyn WindowSink) {
        let mut gone = vec![];
        let mut next = vec![];
        {
            let mut cons = self.cons.lock().unwrap();
            for (id, list) in cons.iter_mut() {
                if list.contains(&con_id) {
                    list.retain(|c| *c != con_id);
                    match list.last() {
                        Some(c) => next.push(*c),
                        None => gone.push(id.clone()),
                    }
                }
            }
            cons.retain(|_, list| !list.is_empty());
        }
        // Another of its windows is left: that one fills the screen now
        // (sway only lets one window per workspace be fullscreen).
        for c in next {
            self.cmd(&format!("[con_id={c}] fullscreen enable")).await;
        }
        for id in gone {
            tracing::info!("native window for {id} closed");
            sink.on_window(&id, false);
        }
    }

    async fn drop_all(&self, sink: &dyn WindowSink) {
        let all: Vec<i64> = self.cons.lock().unwrap().values().flatten().copied().collect();
        for con in all {
            self.drop_con(con, sink).await;
        }
    }

    /// Follows sway for as long as wadd runs, reconnecting when the session
    /// (and so sway) restarts.
    pub async fn run(self: Arc<Self>, sink: Arc<dyn WindowSink>) {
        loop {
            if let Err(e) = self.watch(sink.as_ref()).await {
                if self.windows.available() {
                    tracing::info!("lost sway: {e}");
                }
                self.windows.set_available(false);
                self.drop_all(sink.as_ref()).await;
            }
            tokio::time::sleep(self.retry).await;
        }
    }

    async fn watch(&self, sink: &dyn WindowSink) -> Result<(), wad_sway::Error> {
        let mut events = self.sway.subscribe(&["window"]).await?;
        let tree = self.sway.tree().await?;
        if !self.windows.available() {
            tracing::info!("sway is up");
            // Keep each screen at the scale sway chose now (wad_sway::scale_pins).
            match self.sway.outputs().await {
                Ok(outputs) => {
                    for cmd in wad_sway::scale_pins(&outputs) {
                        tracing::info!("sway: {cmd}");
                        self.cmd(&cmd).await;
                    }
                }
                Err(e) => tracing::warn!("sway's outputs: {e}"),
            }
        }
        self.windows.set_available(true);
        let mut seen = vec![];
        for con in wad_sway::windows(&tree) {
            seen.extend(con.get("id").and_then(Value::as_i64));
            self.adopt(con, sink).await;
        }
        let stale: Vec<i64> =
            self.cons.lock().unwrap().values().flatten().copied().filter(|c| !seen.contains(c)).collect();
        for con in stale {
            self.drop_con(con, sink).await;
        }
        loop {
            let (t, ev) = events.next().await?;
            if t != EVENT_WINDOW {
                continue;
            }
            let con = ev.get("container").cloned().unwrap_or(Value::Null);
            match ev.get("change").and_then(Value::as_str) {
                Some("new") => self.adopt(&con, sink).await,
                Some("close") => {
                    if let Some(id) = con.get("id").and_then(Value::as_i64) {
                        self.drop_con(id, sink).await;
                    }
                }
                _ => {}
            }
        }
    }
}

#[async_trait]
impl Display for SwayDisplay {
    async fn screen(&self) -> Option<wad_proto::v1::Screen> {
        screen_of(&self.sway.outputs().await.ok()?)
    }

    async fn show_shell(&self) {
        self.cmd(&format!("workspace {SHELL}")).await;
    }

    async fn show_native(&self, id: &str) -> bool {
        let con = self.cons.lock().unwrap().get(id).and_then(|l| l.last()).copied();
        match con {
            Some(c) => self.cmd(&format!("[con_id={c}] focus")).await,
            None => false,
        }
    }
}

#[cfg(test)]
mod screen_tests {
    #[test]
    fn the_screen_is_the_first_active_outputs_logical_size() {
        let outputs = serde_json::json!([
            {"name": "eDP-1", "active": false, "rect": {"width": 1, "height": 1}, "scale": 1.0},
            {"name": "eDP-2", "active": true, "rect": {"width": 1500, "height": 1000}, "scale": 2.0},
        ]);
        let s = super::screen_of(&outputs).unwrap();
        assert_eq!((s.width, s.height, s.scale), (1500, 1000, 2.0));
        assert!(super::screen_of(&serde_json::json!([])).is_none());
    }
}
