//! Writing the run history (runs.jsonl) as the Python wadd does: a line when
//! a workspace's container starts, another when it stops.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use serde_json::json;

pub struct RunLog {
    path: PathBuf,
    /// Workspace id → the run in progress.
    open: HashMap<String, String>,
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn new_id() -> String {
    // 12 hex digits, like Python's uuid4().hex[:12]: unique enough for a history.
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:012x}", (t ^ (std::process::id() as u128) << 40) & 0xffff_ffff_ffff)
}

impl RunLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), open: HashMap::new() }
    }

    fn append(&self, rec: serde_json::Value) -> std::io::Result<()> {
        if let Some(d) = self.path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
        writeln!(f, "{rec}")
    }

    pub fn is_open(&self, ws: &str) -> bool {
        self.open.contains_key(ws)
    }

    /// `mode`: "local" (on this screen) or "stream"; `projects`: the ids it mounts.
    pub fn start(&mut self, ws: &str, name: &str, mode: &str, projects: &[String]) -> std::io::Result<()> {
        if self.is_open(ws) {
            self.end(ws)?;
        }
        let id = new_id();
        self.append(json!({"event": "start", "id": id, "wadspaceId": ws, "wadspaceName": name, "mode": mode,
            "user": "local", "projects": projects, "startedAt": now(), "endedAt": null}))?;
        self.open.insert(ws.into(), id);
        Ok(())
    }

    pub fn end(&mut self, ws: &str) -> std::io::Result<()> {
        match self.open.remove(ws) {
            Some(id) => self.append(json!({"event": "end", "id": id, "endedAt": now()})),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_read_back_as_the_reader_expects() {
        let d = tempfile::tempdir().unwrap();
        let mut log = RunLog::new(d.path().join("runs.jsonl"));
        log.start("a", "A", "local", &["p1".into()]).unwrap();
        log.end("a").unwrap();
        log.start("b", "B", "stream", &[]).unwrap();
        let runs = crate::State::new(d.path()).runs(None, 10);
        assert_eq!(runs.len(), 2);
        let a = runs.iter().find(|r| r.wadspace_id == "a").unwrap();
        assert_eq!(a.projects, ["p1"]);
        assert!(a.ended_at.unwrap() >= a.started_at);
        assert!(log.is_open("b"));
    }
}
