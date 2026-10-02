use serde::{Deserialize, Serialize};
use specta::Type;

/// What kind of failure an error is. The UI picks its wording and whether to
/// offer a retry from this; `message` is for people.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request was wrong (a bad id, a missing field).
    BadRequest,
    /// Needs a sign-in that isn't there (no GitHub token, no account).
    Unauthorized,
    /// Signed in, but not allowed.
    Forbidden,
    NotFound,
    /// Already running, already exists, or busy with something else.
    Conflict,
    /// The machine is offline, or a service it needs can't be reached.
    Offline,
    /// A service answered with an error (GitHub, Firebase).
    Upstream,
    /// Gave up waiting.
    Timeout,
    /// The user stopped it (or let it expire).
    Cancelled,
    /// A bug or something unexpected; the message has details.
    Internal,
}

/// The one error shape: wadd's API returns it as the body of a failed
/// request, and Tauri commands reject with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shape() {
        let e = ApiError::new(ErrorCode::BadRequest, "no such workspace");
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"code":"bad_request","message":"no such workspace"}"#);
    }
}
