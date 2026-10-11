//! GitHub for WadSpaces machines. Signing in is Firebase's (the WadSpaces
//! Client runs it); a token is a [`Token`] here, which never prints and never
//! serializes.
//!
//! [`Github::repos`] and [`Github::create_repo`] are the REST calls projects
//! need (github.py): the repos the owner can use, every page, and a new one
//! with a first commit so it can be cloned straight away.

use std::fmt;

use serde::Deserialize;
use wad_proto::github::{GithubAccount, Repo};
use wad_proto::{ApiError, ErrorCode};

const API: &str = "https://api.github.com";
const USER_AGENT: &str = concat!("WadSpaces/", env!("CARGO_PKG_VERSION"));

/// The machine's settings for the OAuth App (`/usr/lib/wadspaces/github.toml`):
/// what the WadSpaces Client asks a sign-in's token to be able to do.
#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub scopes: Vec<String>,
}

impl AppConfig {
    pub const PATH: &str = "/usr/lib/wadspaces/github.toml";

    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// A GitHub access token. Debug and Display are redacted; use
/// [`Token::expose`] where the value really has to go somewhere.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(…)")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the GitHub token was rejected (it may have been revoked)")]
    BadToken,
    #[error("couldn't reach GitHub: {0}")]
    Network(#[source] reqwest::Error),
    /// GitHub refused what was asked (a repo by that name exists, ...).
    #[error("{0}")]
    Invalid(String),
    #[error("GitHub answered {status}: {message}")]
    Upstream { status: u16, message: String },
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        match e.status() {
            Some(s) => Error::Upstream { status: s.as_u16(), message: e.to_string() },
            None => Error::Network(e),
        }
    }
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        let code = match e {
            Error::BadToken => ErrorCode::Unauthorized,
            Error::Invalid(_) => ErrorCode::BadRequest,
            Error::Network(_) => ErrorCode::Offline,
            Error::Upstream { .. } => ErrorCode::Upstream,
        };
        ApiError::new(code, e.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct Github {
    http: reqwest::Client,
    api: String,
}

impl Github {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base(http, API)
    }

    /// Against another server (tests).
    pub fn with_base(http: reqwest::Client, api: &str) -> Self {
        Self { http, api: api.trim_end_matches('/').into() }
    }

    /// The account a token belongs to.
    pub async fn user(&self, token: &Token) -> Result<GithubAccount, Error> {
        #[derive(Deserialize)]
        struct User {
            login: String,
            name: Option<String>,
            avatar_url: Option<String>,
        }
        let res = self
            .http
            .get(format!("{}/user", self.api))
            .header("accept", "application/vnd.github+json")
            .header("user-agent", USER_AGENT)
            .bearer_auth(token.expose())
            .send()
            .await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(Error::BadToken);
        }
        let u: User = read_json(res).await?;
        Ok(GithubAccount { login: u.login, name: u.name, avatar_url: u.avatar_url })
    }
}

async fn read_json<T: serde::de::DeserializeOwned>(res: reqwest::Response) -> Result<T, Error> {
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(Error::Upstream { status: status.as_u16(), message: text.chars().take(200).collect() });
    }
    res.json().await.map_err(Error::from)
}

/// What the repo list asks for: what `gh repo list` shows, plus
/// collaborations and organisations, most recently pushed first.
const REPOS_QUERY: &str = "per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member";

/// A GitHub repo as WadSpaces Client sees it.
fn repo_of(r: &serde_json::Value) -> Repo {
    let s = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    Repo {
        full_name: s("full_name"),
        name: s("name"),
        private: r.get("private").and_then(|v| v.as_bool()).unwrap_or(false),
        url: s("clone_url"),
        default_branch: s("default_branch"),
        pushed_at: r.get("pushed_at").and_then(|v| v.as_str()).map(String::from),
        description: s("description"),
    }
}

/// What GitHub said went wrong: its field errors when there are any ("name
/// already exists on this account"), else its message.
fn message_of(body: &serde_json::Value, status: u16) -> String {
    let fields: Vec<String> = body
        .get("errors")
        .and_then(|e| e.as_array())
        .into_iter()
        .flatten()
        .filter_map(|e| {
            e.get("message").and_then(|m| m.as_str()).map(String::from).or_else(|| {
                let f = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
                e.is_object().then(|| format!("{} {}", f("field"), f("code")))
            })
        })
        .collect();
    if !fields.is_empty() {
        return fields.join("; ");
    }
    body.get("message").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| format!("HTTP {status}"))
}

/// The `rel="next"` URL of a Link header.
fn next_link(res: &reqwest::Response) -> Option<String> {
    let link = res.headers().get("link")?.to_str().ok()?;
    link.split(',').find_map(|part| {
        let (url, rel) = part.split_once(';')?;
        rel.contains("rel=\"next\"").then(|| url.trim().trim_start_matches('<').trim_end_matches('>').to_string())
    })
}

impl Github {
    async fn api_call(&self, req: reqwest::RequestBuilder, token: &Token) -> Result<reqwest::Response, Error> {
        let res = req
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .header("user-agent", USER_AGENT)
            .bearer_auth(token.expose())
            .send()
            .await
            .map_err(Error::Network)?;
        let status = res.status().as_u16();
        match status {
            200..=299 => Ok(res),
            401 => Err(Error::BadToken),
            _ => {
                let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
                let message = message_of(&body, status);
                Err(if status == 422 { Error::Invalid(message) } else { Error::Upstream { status, message } })
            }
        }
    }

    /// The owner's login and every repo they can use (every page).
    pub async fn repos(&self, token: &Token) -> Result<(String, Vec<Repo>), Error> {
        let login = self.user(token).await?.login;
        let mut out = vec![];
        let mut url = Some(format!("{}/user/repos?{REPOS_QUERY}", self.api));
        while let Some(u) = url {
            let res = self.api_call(self.http.get(&u), token).await?;
            url = next_link(&res);
            let page: serde_json::Value = res.json().await.map_err(Error::Network)?;
            out.extend(page.as_array().into_iter().flatten().filter(|r| r.is_object()).map(repo_of));
        }
        Ok((login, out))
    }

    /// A new repo, private unless asked, with a first commit (auto_init).
    pub async fn create_repo(
        &self,
        token: &Token,
        name: &str,
        private: bool,
        description: &str,
    ) -> Result<Repo, Error> {
        let body = serde_json::json!({"name": name, "private": private, "description": description, "auto_init": true});
        let res = self.api_call(self.http.post(format!("{}/user/repos", self.api)).json(&body), token).await?;
        let r: serde_json::Value = res.json().await.map_err(Error::Network)?;
        Ok(repo_of(&r))
    }
}

#[cfg(test)]
mod tests;
