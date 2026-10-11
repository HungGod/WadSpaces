//! wadd's state on disk:
//!
//! ```text
//! <state_dir>/enrollment.json          the account link
//! <state_dir>/projects/<id>.json       project documents
//! <state_dir>/extra/<ws>/projects.json what a launch mounted
//! <state_dir>/runs.jsonl               when each workspace ran
//! <state_dir>/session.json             the session in progress
//! <state_dir>/library/<coll>/<id>.json WadSpaces Client's library
//! <state_dir>/seeded-secrets.json      secrets seeded from the image
//! ```
//!
//! The workspace list is state, `<state_dir>/workspaces.json`, checked
//! (workspaces.rs) before it's taken on, and the image's own workspaces come
//! in as updates to it (vendor.rs).

pub mod folders;
pub mod projects;
pub mod runs;
pub mod state;
pub mod vendor;
pub mod workspaces;

pub use state::State;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: {1}")]
    Io(String, #[source] std::io::Error),
    #[error("{0}: {1}")]
    Yaml(String, String),
    /// The file is readable but not a valid configuration.
    #[error("{0}")]
    Config(String),
}
