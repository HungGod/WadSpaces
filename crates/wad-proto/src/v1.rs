//! wadd's `/v1` API (the Rust wadd, over /run/wadd/wadd.sock): the types its
//! endpoints and events carry. More arrive with each milestone.

use serde::{Deserialize, Serialize};
use specta::Type;

/// GET /v1/health
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub version: String,
}

/// How wadd runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Profile {
    /// A WadSpaces machine.
    System,
    /// A laptop (`wadd serve --user`).
    User,
}

/// GET /v1/machine
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MachineInfo {
    pub name: String,
    pub version: String,
    pub profile: Profile,
    /// When this wadd started (Unix seconds).
    pub started_at: u64,
}

/// GET /v1/logs: one line of wadd's own log (redacted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Unix milliseconds.
    pub time: u64,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// GET /v1/events: server-sent events, named by `type`, with `data` as JSON.
/// The stream starts with the current state of each kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum Event {
    Machine(MachineInfo),
    /// Something to tell whoever is watching.
    Notice {
        text: String,
    },
}

impl Event {
    /// The SSE event name.
    pub fn name(&self) -> &'static str {
        match self {
            Event::Machine(_) => "machine",
            Event::Notice { .. } => "notice",
        }
    }
}
