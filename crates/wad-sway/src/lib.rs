//! A small client for sway's IPC (the i3 protocol), and the bits of /proc
//! that tie a window to the workspace container that drew it.
//!
//! Wire format: `i3-ipc` + u32 payload length + u32 type + JSON payload, in
//! native byte order. Events come back with the high bit of the type set.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

const MAGIC: &[u8; 6] = b"i3-ipc";
const HEADER: usize = 14;
pub const RUN_COMMAND: u32 = 0;
pub const SUBSCRIBE: u32 = 2;
pub const GET_TREE: u32 = 4;
pub const EVENT_WINDOW: u32 = 0x8000_0000 | 3;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no running sway in {0}")]
    NoSway(PathBuf),
    #[error("sway: {0}")]
    Io(#[from] std::io::Error),
    #[error("sway: {0}")]
    Protocol(String),
    #[error("sway didn't answer in time")]
    Timeout,
}

pub fn pack(msg_type: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    out.extend_from_slice(&msg_type.to_ne_bytes());
    out.extend_from_slice(payload);
    out
}

/// One message: its type and JSON body.
pub async fn read_message<R: AsyncReadExt + Unpin>(r: &mut R) -> Result<(u32, Value), Error> {
    let mut head = [0u8; HEADER];
    r.read_exact(&mut head).await?;
    if &head[..6] != MAGIC {
        return Err(Error::Protocol("not an i3-ipc reply".into()));
    }
    let len = u32::from_ne_bytes(head[6..10].try_into().unwrap()) as usize;
    let msg_type = u32::from_ne_bytes(head[10..14].try_into().unwrap());
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    let v = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).map_err(|e| Error::Protocol(e.to_string()))?
    };
    Ok((msg_type, v))
}

/// The socket of a sway that is still running (stale ones from an earlier
/// session stay behind in the runtime dir), newest first.
pub fn find_socket(runtime_dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(runtime_dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // sway-ipc.<uid>.<pid>.sock
        let Some(pid) =
            name.strip_prefix("sway-ipc.").and_then(|r| r.strip_suffix(".sock")).and_then(|r| r.split('.').nth(1))
        else {
            continue;
        };
        if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) || !Path::new("/proc").join(pid).exists() {
            continue;
        }
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
            best = Some((mtime, entry.path()));
        }
    }
    best.map(|(_, p)| p)
}

/// Where to reach sway: a fixed socket, or the newest live one in a runtime dir.
#[derive(Debug, Clone)]
pub enum Locate {
    Socket(PathBuf),
    RuntimeDir(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Sway {
    locate: Locate,
}

/// A window event subscription.
pub struct Events {
    stream: UnixStream,
}

impl Events {
    /// The next event: (type, body). An error means sway went away.
    pub async fn next(&mut self) -> Result<(u32, Value), Error> {
        read_message(&mut self.stream).await
    }
}

impl Sway {
    pub fn new(locate: Locate) -> Self {
        Self { locate }
    }

    fn path(&self) -> Result<PathBuf, Error> {
        match &self.locate {
            Locate::Socket(p) => Ok(p.clone()),
            Locate::RuntimeDir(d) => find_socket(d).ok_or_else(|| Error::NoSway(d.clone())),
        }
    }

    async fn open(&self) -> Result<UnixStream, Error> {
        Ok(UnixStream::connect(self.path()?).await?)
    }

    pub async fn request(&self, msg_type: u32, payload: &str) -> Result<Value, Error> {
        let mut s = self.open().await?;
        let go = async {
            s.write_all(&pack(msg_type, payload.as_bytes())).await?;
            read_message(&mut s).await.map(|(_, v)| v)
        };
        tokio::time::timeout(Duration::from_secs(5), go).await.map_err(|_| Error::Timeout)?
    }

    /// Runs a command; true if every part of it succeeded.
    pub async fn command(&self, cmd: &str) -> Result<bool, Error> {
        let reply = self.request(RUN_COMMAND, cmd).await?;
        let parts = reply.as_array().cloned().unwrap_or_default();
        Ok(!parts.is_empty() && parts.iter().all(|r| r.get("success").and_then(Value::as_bool) == Some(true)))
    }

    pub async fn tree(&self) -> Result<Value, Error> {
        self.request(GET_TREE, "").await
    }

    pub async fn subscribe(&self, kinds: &[&str]) -> Result<Events, Error> {
        let mut stream = self.open().await?;
        let body = serde_json::to_string(kinds).expect("strings serialize");
        stream.write_all(&pack(SUBSCRIBE, body.as_bytes())).await?;
        let (_, ok) = tokio::time::timeout(Duration::from_secs(5), read_message(&mut stream))
            .await
            .map_err(|_| Error::Timeout)??;
        if ok.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(Error::Protocol(format!("subscribe refused: {ok}")));
        }
        Ok(Events { stream })
    }
}

/// Every client window (a node with a pid) in a tree, tiled or floating.
pub fn windows(node: &Value) -> Vec<&Value> {
    let mut out = vec![];
    walk(node, &mut out);
    out
}

fn walk<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    let kind = node.get("type").and_then(Value::as_str);
    if node.get("pid").and_then(Value::as_i64).is_some_and(|p| p > 0) && matches!(kind, Some("con" | "floating_con")) {
        out.push(node);
    }
    for key in ["nodes", "floating_nodes"] {
        for child in node.get(key).and_then(Value::as_array).into_iter().flatten() {
            walk(child, out);
        }
    }
}

/// Who drew a window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// A quadlet's container: its unit is wad-<id>.service.
    Workspace(String),
    /// Some other container (plain `podman run`): its full id.
    Container(String),
    /// A program in the session itself.
    Exe(PathBuf),
}

/// The workspace or container a /proc/<pid>/cgroup text belongs to. A
/// quadlet's container lives in its unit's cgroup
/// (…/wad-writing.service/libpod-payload-<id>); a plain `podman run` in a
/// libpod-<id>.scope.
pub fn cgroup_owner(cgroup: &str) -> Option<Owner> {
    for part in cgroup.split(['/', '\n']) {
        if let Some(id) = part.strip_prefix("wad-").and_then(|r| r.strip_suffix(".service"))
            && valid_id(id)
        {
            return Some(Owner::Workspace(id.into()));
        }
    }
    for part in cgroup.split(['/', '\n']) {
        let rest = part.strip_prefix("libpod-payload-").or_else(|| part.strip_prefix("libpod-"));
        if let Some(rest) = rest {
            let id: String = rest.chars().take_while(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()).collect();
            if id.len() == 64 {
                return Some(Owner::Container(id));
            }
        }
    }
    None
}

/// [a-z0-9][a-z0-9-]*
fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Who drew the window of process `pid`: its container, else its executable.
pub fn pid_owner(pid: i64, proc: &Path) -> Option<Owner> {
    let dir = proc.join(pid.to_string());
    let cgroup = std::fs::read_to_string(dir.join("cgroup")).ok()?;
    cgroup_owner(&cgroup).or_else(|| std::fs::read_link(dir.join("exe")).ok().map(Owner::Exe))
}

#[cfg(test)]
mod tests;
