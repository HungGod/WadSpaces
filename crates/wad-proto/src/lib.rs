//! The types wadd and its clients (WadSpaces Client, the HUD) share: wadd's
//! `/v1` API over its socket, and GitHub's sign-in. JSON is camelCase.

pub mod error;
pub mod github;
pub mod v1;

pub use error::{ApiError, ErrorCode};
