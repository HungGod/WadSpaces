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
