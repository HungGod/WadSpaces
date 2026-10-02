//! The few Firebase REST calls WadSpaces makes from Rust. The UI uses the
//! Firebase JS SDK for everything else; these are the writes whose values must
//! not pass through JavaScript (a GitHub token), made with the signed-in
//! user's ID token, so Firestore's rules apply exactly as they do to the SDK.

use wad_proto::{ApiError, ErrorCode};

const FIRESTORE: &str = "https://firestore.googleapis.com";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not a valid Firebase project id: {0:?}")]
    BadProject(String),
    #[error("not a valid document path: {0:?}")]
    BadPath(String),
    #[error("signed out, or the sign-in expired")]
    Unauthenticated,
    #[error("Firestore refused the write (rules)")]
    Denied,
    #[error("couldn't reach Firestore: {0}")]
    Network(#[source] reqwest::Error),
    #[error("Firestore answered {status}: {message}")]
    Upstream { status: u16, message: String },
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        let code = match e {
            Error::BadProject(_) | Error::BadPath(_) => ErrorCode::BadRequest,
            Error::Unauthenticated => ErrorCode::Unauthorized,
            Error::Denied => ErrorCode::Forbidden,
            Error::Network(_) => ErrorCode::Offline,
            Error::Upstream { .. } => ErrorCode::Upstream,
        };
        ApiError::new(code, e.to_string())
    }
}

/// Firestore's REST API for one project.
#[derive(Debug, Clone)]
pub struct Firestore {
    http: reqwest::Client,
    base: String,
    project: String,
}

impl Firestore {
    pub fn new(http: reqwest::Client, project: &str) -> Result<Self, Error> {
        Self::with_base(http, FIRESTORE, project)
    }

    /// Against the emulator (`http://127.0.0.1:8090`) or a test server.
    pub fn with_base(http: reqwest::Client, base: &str, project: &str) -> Result<Self, Error> {
        let ok = !project.is_empty()
            && project.len() <= 64
            && project.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !ok {
            return Err(Error::BadProject(project.into()));
        }
        Ok(Self { http, base: base.trim_end_matches('/').into(), project: project.into() })
    }

    /// Writes a document whose fields are all strings, replacing what was
    /// there. `path` is like `users/<uid>/secrets/github_token`.
    pub async fn set_strings(&self, id_token: &str, path: &str, fields: &[(&str, &str)]) -> Result<(), Error> {
        let segments: Vec<&str> = path.split('/').collect();
        let ok = segments.len().is_multiple_of(2)
            && segments.iter().all(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            });
        if !ok {
            return Err(Error::BadPath(path.into()));
        }
        let body = serde_json::json!({
            "fields": fields
                .iter()
                .map(|(k, v)| (k.to_string(), serde_json::json!({ "stringValue": v })))
                .collect::<serde_json::Map<_, _>>(),
        });
        let url = format!("{}/v1/projects/{}/databases/(default)/documents/{path}", self.base, self.project);
        let res = self.http.patch(url).bearer_auth(id_token).json(&body).send().await.map_err(Error::Network)?;
        match res.status().as_u16() {
            200..=299 => Ok(()),
            401 => Err(Error::Unauthenticated),
            403 => Err(Error::Denied),
            status => {
                let text = res.text().await.unwrap_or_default();
                Err(Error::Upstream { status, message: text.chars().take(200).collect() })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn writes_a_secret() {
        let s = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/v1/projects/wad-spaces/databases/(default)/documents/users/u1/secrets/github_token"))
            .and(header("authorization", "Bearer idtok"))
            .and(body_json(json!({"fields": {"value": {"stringValue": "gho_abc"}}})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&s)
            .await;
        Mock::given(method("PATCH")).respond_with(ResponseTemplate::new(403)).mount(&s).await;
        let fs = Firestore::with_base(reqwest::Client::new(), &s.uri(), "wad-spaces").unwrap();
        fs.set_strings("idtok", "users/u1/secrets/github_token", &[("value", "gho_abc")]).await.unwrap();
        let denied = fs.set_strings("idtok", "users/u2/secrets/github_token", &[("value", "x")]).await;
        assert!(matches!(denied, Err(Error::Denied)));
    }

    #[tokio::test]
    async fn refuses_odd_paths_and_projects() {
        let http = reqwest::Client::new();
        assert!(Firestore::new(http.clone(), "Wad Spaces").is_err());
        // Nothing listens here: a path that got past the check would fail differently.
        let fs = Firestore::with_base(http, "http://127.0.0.1:9", "wad-spaces").unwrap();
        for p in ["users", "users/u1/secrets", "users/../x/y", "users//secrets/x", "users/u1/secrets/a?b=c"] {
            assert!(matches!(fs.set_strings("t", p, &[]).await, Err(Error::BadPath(_))), "{p}");
        }
    }
}
