//! Signing a machine in to GitHub with the device flow: the app shows a code
//! (and a QR code of the address), the user enters it on their phone or
//! computer, and the machine gets a token. The token itself stays in Rust: it
//! never appears in these types.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A device-flow sign-in that's waiting for the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    /// What the user types at `verification_uri`, e.g. `WDJB-MJHT`.
    pub user_code: String,
    /// Where to type it (`https://github.com/login/device`).
    pub verification_uri: String,
    /// Seconds until the code expires (GitHub gives 15 minutes).
    pub expires_in: u32,
}

/// The GitHub account a token belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// A GitHub repository, as Wad Creator lists them (and the account keeps at
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

/// The signed-in WadSpaces user, so a GitHub token can be saved to their
/// account with their own credentials (Firestore's rules apply).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountRef {
    pub uid: String,
    pub id_token: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SignInState {
    /// Waiting for the code to be entered.
    Waiting,
    Done,
    Failed,
    Cancelled,
}

/// A device sign-in: the code to enter (and a QR code of where), then how it
/// ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub state: SignInState,
    pub code: DeviceCode,
    /// A QR code of `code.verificationUri`, as an SVG document.
    pub qr_svg: String,
    pub login: Option<String>,
    /// The token went to the account too (for the owner's other machines).
    pub saved_to_account: bool,
    pub error: Option<String>,
}

/// GET /v1/github: is there a token here, and whose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub token: bool,
    pub login: Option<String>,
    /// Why there's no login although there's a token (refused, GitHub down).
    pub error: Option<String>,
    /// The device sign-in in progress (or the last one).
    pub sign_in: Option<SignIn>,
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
