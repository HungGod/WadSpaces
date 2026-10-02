//! wadd's state on disk. The Rust wadd keeps the Python wadd's file formats
//! wherever they work (so `bootc rollback` to the Python wadd still reads
//! them):
//!
//! ```text
//! <state_dir>/enrollment.json          the account link (cloud.py)
//! <state_dir>/projects/<id>.json       project documents (projects.py)
//! <state_dir>/extra/<ws>/projects.json what a launch mounted (projects.py write_manifest)
//! <state_dir>/runs.jsonl               when each workspace ran (runs.py)
//! <state_dir>/session.json             the session in progress (manager.py)
//! <state_dir>/library/<coll>/<id>.json Wad Creator's library (library.py)
//! <state_dir>/seeded-secrets.json      secrets seeded from the image (manager.py)
//! ```
//!
//! The one that moves is the workspace list: /etc/wadspaces/workspaces.yaml
//! (legacy.rs reads it) becomes state, `<state_dir>/workspaces.json`, at the
//! cutover (migrate.rs plans that).

pub mod folders;
pub mod legacy;
pub mod migrate;
pub mod projects;
pub mod runs;
pub mod state;

pub use state::State;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: {1}")]
    Io(String, #[source] std::io::Error),
    #[error("{0}: {1}")]
    Yaml(String, String),
    /// The file is readable but not a valid configuration (Python's ConfigError).
    #[error("{0}")]
    Config(String),
}
