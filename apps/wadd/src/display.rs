//! Putting things on screen. Wad Creator is the app's own window on sway's
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
    /// Workspace id -> sway con_id.
    cons: Mutex<HashMap<String, i64>>,
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
            if cons.get(&id) == Some(&con_id) {
                return;
            }
            // One window per workspace: its desktop. A second one (it
            // restarted before the old window went) replaces it.
            cons.insert(id.clone(), con_id);
        }
        self.cmd(&format!("[con_id={con_id}] move container to workspace ws-{id}, fullscreen enable")).await;
        tracing::info!("native window for {id} (con {con_id})");
        sink.on_window(&id, true);
    }

    fn drop_con(&self, con_id: i64, sink: &dyn WindowSink) {
        let gone: Vec<String> = {
            let mut cons = self.cons.lock().unwrap();
            let ids: Vec<String> = cons.iter().filter(|(_, c)| **c == con_id).map(|(id, _)| id.clone()).collect();
            for id in &ids {
                cons.remove(id);
            }
            ids
        };
        for id in gone {
            tracing::info!("native window for {id} closed");
            sink.on_window(&id, false);
        }
    }

    fn drop_all(&self, sink: &dyn WindowSink) {
        let all: Vec<i64> = self.cons.lock().unwrap().values().copied().collect();
        for con in all {
            self.drop_con(con, sink);
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
                self.drop_all(sink.as_ref());
            }
            tokio::time::sleep(self.retry).await;
        }
    }

    async fn watch(&self, sink: &dyn WindowSink) -> Result<(), wad_sway::Error> {
        let mut events = self.sway.subscribe(&["window"]).await?;
        let tree = self.sway.tree().await?;
        if !self.windows.available() {
            tracing::info!("sway is up");
        }
        self.windows.set_available(true);
        let mut seen = vec![];
        for con in wad_sway::windows(&tree) {
            seen.extend(con.get("id").and_then(Value::as_i64));
            self.adopt(con, sink).await;
        }
        let stale: Vec<i64> = self.cons.lock().unwrap().values().copied().filter(|c| !seen.contains(c)).collect();
        for con in stale {
            self.drop_con(con, sink);
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
                        self.drop_con(id, sink);
                    }
                }
                _ => {}
            }
        }
    }
}

#[async_trait]
impl Display for SwayDisplay {
    async fn show_shell(&self) {
        self.cmd(&format!("workspace {SHELL}")).await;
    }

    async fn show_native(&self, id: &str) -> bool {
        let con = self.cons.lock().unwrap().get(id).copied();
        match con {
            Some(c) => self.cmd(&format!("[con_id={c}] focus")).await,
            None => false,
        }
    }
}
