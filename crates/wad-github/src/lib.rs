//! GitHub for WadSpaces machines.
//!
//! [`Github::device_start`] and [`Github::device_wait`] sign a machine in with
//! the OAuth device flow
//! (<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow>):
//! no client secret and no browser on the machine. The token comes back as a
//! [`Token`], which never prints and never serializes.
//!
//! [`Github::repos`] and [`Github::create_repo`] are the REST calls projects
//! need (github.py): the repos the owner can use, every page, and a new one
//! with a first commit so it can be cloned straight away.

use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use tokio::time::Instant;
use wad_proto::github::{DeviceCode, GithubAccount, Repo};
use wad_proto::{ApiError, ErrorCode};

const WEB: &str = "https://github.com";
const API: &str = "https://api.github.com";
const USER_AGENT: &str = concat!("WadSpaces/", env!("CARGO_PKG_VERSION"));
/// GitHub's rule for `slow_down` without an interval: wait 5 s longer.
const SLOW_DOWN: Duration = Duration::from_secs(5);

/// The machine's settings for the OAuth App (`/usr/lib/wadspaces/github.toml`).
#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub client_id: String,
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
    #[error("the code expired before it was entered")]
    Expired,
    #[error("the sign-in was cancelled on GitHub")]
    Denied,
    #[error("device sign-in isn't enabled for the WadSpaces app on GitHub")]
    DeviceFlowDisabled,
    #[error("GitHub doesn't recognise this app (check client_id in github.toml)")]
    BadClient,
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
            Error::Expired | Error::Denied => ErrorCode::Cancelled,
            Error::BadToken => ErrorCode::Unauthorized,
            Error::Invalid(_) => ErrorCode::BadRequest,
            Error::Network(_) => ErrorCode::Offline,
            Error::DeviceFlowDisabled | Error::BadClient | Error::Upstream { .. } => ErrorCode::Upstream,
        };
        ApiError::new(code, e.to_string())
    }
}

/// A device-flow sign-in in progress.
#[derive(Debug, Clone)]
pub struct DeviceStart {
    /// What to show the user.
    pub code: DeviceCode,
    device_code: String,
    interval: Duration,
    expires_at: Instant,
}

/// One answer to [`Github::device_poll`].
#[derive(Debug)]
pub enum Poll {
    /// Not entered yet.
    Pending,
    /// Polled too often: wait this long between polls from now on.
    SlowDown(Duration),
    Done(Token),
}

#[derive(Debug, Clone)]
pub struct Github {
    http: reqwest::Client,
    web: String,
    api: String,
}

impl Github {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_base(http, WEB, API)
    }

    /// Against another server (tests).
    pub fn with_base(http: reqwest::Client, web: &str, api: &str) -> Self {
        Self { http, web: web.trim_end_matches('/').into(), api: api.trim_end_matches('/').into() }
    }

    /// Asks GitHub for a code for the user to enter.
    pub async fn device_start(&self, app: &AppConfig) -> Result<DeviceStart, Error> {
        #[derive(Deserialize)]
        struct Resp {
            device_code: String,
            user_code: String,
            verification_uri: String,
            expires_in: u32,
            interval: u64,
        }
        let scope = app.scopes.join(" ");
        let res = self
            .http
            .post(format!("{}/login/device/code", self.web))
            .header("accept", "application/json")
            .header("user-agent", USER_AGENT)
            .form(&[("client_id", app.client_id.as_str()), ("scope", scope.as_str())])
            .send()
            .await?;
        let body: serde_json::Value = read_json(res).await?;
        if let Some(err) = oauth_error(&body) {
            return Err(err);
        }
        let r: Resp = serde_json::from_value(body).map_err(unexpected)?;
        Ok(DeviceStart {
            code: DeviceCode { user_code: r.user_code, verification_uri: r.verification_uri, expires_in: r.expires_in },
            device_code: r.device_code,
            interval: Duration::from_secs(r.interval),
            expires_at: Instant::now() + Duration::from_secs(r.expires_in.into()),
        })
    }

    /// Asks once whether the user has entered the code.
    pub async fn device_poll(&self, app: &AppConfig, start: &DeviceStart) -> Result<Poll, Error> {
        let res = self
            .http
            .post(format!("{}/login/oauth/access_token", self.web))
            .header("accept", "application/json")
            .header("user-agent", USER_AGENT)
            .form(&[
                ("client_id", app.client_id.as_str()),
                ("device_code", start.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?;
        let body: serde_json::Value = read_json(res).await?;
        match body.get("error").and_then(|e| e.as_str()) {
            Some("authorization_pending") => Ok(Poll::Pending),
            Some("slow_down") => {
                let secs = body.get("interval").and_then(|i| i.as_u64());
                Ok(Poll::SlowDown(secs.map_or(start.interval + SLOW_DOWN, Duration::from_secs)))
            }
            Some(_) => Err(oauth_error(&body).expect("has an error")),
            None => match body.get("access_token").and_then(|t| t.as_str()) {
                Some(t) if !t.is_empty() => Ok(Poll::Done(Token::new(t))),
                _ => Err(unexpected("no access_token in GitHub's answer")),
            },
        }
    }

    /// Polls until the user enters the code (or it expires, or they say no).
    /// Drop the future to stop waiting.
    pub async fn device_wait(&self, app: &AppConfig, start: &DeviceStart) -> Result<Token, Error> {
        let mut interval = start.interval;
        loop {
            tokio::time::sleep(interval).await;
            if Instant::now() >= start.expires_at {
                return Err(Error::Expired);
            }
            match self.device_poll(app, start).await? {
                Poll::Pending => {}
                Poll::SlowDown(next) => interval = next,
                Poll::Done(token) => return Ok(token),
            }
        }
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

/// A GitHub repo as Wad Creator sees it.
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

/// A QR code of `text` (a sign-in address), as an SVG document, for a phone
/// to scan.
pub fn qr_svg(text: &str) -> String {
    use qrcode::render::svg;
    qrcode::QrCode::new(text.as_bytes())
        .map(|q| q.render::<svg::Color>().min_dimensions(200, 200).quiet_zone(true).build())
        .unwrap_or_default()
}

/// The OAuth `error` in a body, as an [`Error`].
fn oauth_error(body: &serde_json::Value) -> Option<Error> {
    let code = body.get("error")?.as_str()?;
    Some(match code {
        "expired_token" | "token_expired" => Error::Expired,
        "access_denied" => Error::Denied,
        "device_flow_disabled" => Error::DeviceFlowDisabled,
        "incorrect_client_credentials" | "unauthorized_client" => Error::BadClient,
        other => {
            let desc = body.get("error_description").and_then(|d| d.as_str()).unwrap_or("");
            Error::Upstream { status: 200, message: format!("{other}: {desc}") }
        }
    })
}

fn unexpected(e: impl fmt::Display) -> Error {
    Error::Upstream { status: 200, message: format!("unexpected answer: {e}") }
}

#[cfg(test)]
mod tests;
