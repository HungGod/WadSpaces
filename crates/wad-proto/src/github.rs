//! GitHub on a machine: whose token wadd has, and the repos it can use. The
//! token itself never appears in these types.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The GitHub account a token belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// A GitHub repository, as WadSpaces Client lists them (and the account keeps at
/// users/{uid}/github/repos for the online app).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    /// owner/name
    pub full_name: String,
    pub name: String,
    pub private: bool,
    /// The https clone URL.
    pub url: String,
    pub default_branch: String,
    pub pushed_at: Option<String>,
    pub description: String,
}

/// GET /v1/github/repos
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Repos {
    pub login: String,
    pub repos: Vec<Repo>,
}

/// GET /v1/github: is there a token here, and whose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub token: bool,
    pub login: Option<String>,
    /// Why there's no login although there's a token (refused, GitHub down).
    pub error: Option<String>,
}

/// POST /v1/github/repos: a new repo, and a project for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewRepo {
    pub name: String,
    #[serde(default = "yes")]
    pub private: bool,
    #[serde(default)]
    pub description: String,
    /// The folder name in workspaces (from the name if none).
    #[serde(default)]
    pub mount_name: Option<String>,
    #[serde(default)]
    pub setup: String,
}

fn yes() -> bool {
    true
}
