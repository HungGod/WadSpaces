//! Signing in with GitHub, which is also how you sign in to WadSpaces.
//! Firebase runs GitHub's sign-in (it holds the OAuth App's secret) on a page
//! of the web portal, `/machine-signin.html` (src/signin), shown in a window
//! over the app (window::open_sign_in). The page hands the GitHub token back as
//! the address of a page that doesn't exist; the window catches it before
//! anything loads. The token then:
//! - signs the app's own Firebase in. JavaScript gets it once, for
//!   `signInWithCredential`, and keeps nothing;
//! - once the machine is this user's (github_save_token), goes to wadd (the
//!   `github_token` secret, for git, `gh`, packages and the repo list) and to
//!   the account (`users/{uid}/secrets/github_token`, which the owner's other
//!   machines sync).

use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, Url};
use tokio::sync::oneshot;
use wad_firebase::Firestore;
use wad_github::{AppConfig, Github, Token};
use wad_proto::github::GithubAccount;
use wad_proto::{ApiError, ErrorCode};

use crate::wadd::Wadd;

/// Where the sign-in page sends its result: never loaded (window.rs catches it).
pub const REPLY_HOST: &str = "signed-in.client.invalid";
/// How long a sign-in may take before it's given up.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct GithubState {
    gh: Github,
    http: reqwest::Client,
    /// The last sign-in's token, until github_save_token puts it in place.
    pending: Mutex<Option<(Token, GithubPending)>>,
    /// The sign-in in progress (by its nonce): where its window's reply goes.
    waiting: Mutex<Option<(String, oneshot::Sender<Reply>)>>,
}

impl GithubState {
    pub fn new() -> Self {
        let http = reqwest::Client::new();
        Self { gh: Github::new(http.clone()), http, pending: Mutex::default(), waiting: Mutex::default() }
    }
}

/// What the sign-in window ended with.
#[derive(Debug, PartialEq)]
enum Reply {
    Signed {
        token: String,
        github_id: String,
    },
    Failed(String),
    /// The window closed without an answer.
    Closed,
}

/// The sign-in page's answer, from its reply address (None: not for this
/// sign-in).
fn parse_reply(url: &Url, nonce: &str) -> Option<Reply> {
    let q: std::collections::HashMap<_, _> = url.query_pairs().collect();
    if q.get("n").map(|n| n.as_ref()) != Some(nonce) {
        return None;
    }
    if let Some(e) = q.get("error") {
        return Some(Reply::Failed(e.to_string()));
    }
    let token = q.get("token").filter(|t| !t.is_empty())?.to_string();
    Some(Reply::Signed { token, github_id: q.get("id").map(|s| s.to_string()).unwrap_or_default() })
}

/// The result of a sign-in, for the page's Firebase.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubCredential {
    pub account: GithubAccount,
    /// GitHub's numeric user id (Firebase's `providerData` uid for github.com).
    pub github_id: String,
    /// For `GithubAuthProvider.credential` only: don't keep it.
    pub access_token: String,
}

/// Whose token waits for github_save_token.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPending {
    pub account: GithubAccount,
    /// GitHub's numeric user id, to match against the signed-in user's.
    pub github_id: String,
}

/// The signed-in WadSpaces user, so the token can be saved to their account
/// with their own credentials (Firestore's rules apply as for the page).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountRef {
    pub uid: String,
    pub id_token: String,
    pub project_id: String,
}

/// What became of the token, as well as whose it is.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubSignedIn {
    pub account: GithubAccount,
    /// Saved to the account, for your other machines (false: this machine only).
    pub saved_to_account: bool,
}

/// The OAuth App settings: the image's, or (developing on a laptop) the repo's.
fn app_config() -> Result<AppConfig, ApiError> {
    let mut path = PathBuf::from(AppConfig::PATH);
    if cfg!(debug_assertions) && !path.exists() {
        path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../host/usr/lib/wadspaces/github.toml").into();
    }
    AppConfig::load(&path).map_err(|e| ApiError::new(ErrorCode::Internal, e))
}

/// The sign-in page on the portal's Firebase auth domain (the one GitHub's
/// callback address names), or None for anything that isn't one.
fn sign_in_page(auth_domain: &str, nonce: &str, scopes: &[String]) -> Option<Url> {
    let host_ok = |h: &str| {
        h.strip_suffix(".firebaseapp.com").or_else(|| h.strip_suffix(".web.app")).is_some_and(|p| {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
    };
    if !host_ok(auth_domain) {
        return None;
    }
    let mut url = Url::parse(&format!("https://{auth_domain}/machine-signin.html")).ok()?;
    url.query_pairs_mut().append_pair("n", nonce).append_pair("scopes", &scopes.join(","));
    Some(url)
}

fn nonce() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Signs in with GitHub in a window over the app, on the portal's page at
/// `auth_domain` (the Firebase config's). The token waits here for
/// github_save_token; the page gets it back for Firebase.
#[tauri::command]
#[specta::specta]
pub async fn github_sign_in(
    app: AppHandle,
    state: State<'_, GithubState>,
    auth_domain: String,
) -> Result<GithubCredential, ApiError> {
    let config = app_config()?;
    let nonce = nonce().map_err(|e| ApiError::new(ErrorCode::Internal, format!("no randomness: {e}")))?;
    let page = sign_in_page(&auth_domain, &nonce, &config.scopes)
        .ok_or_else(|| ApiError::new(ErrorCode::BadRequest, format!("not a Firebase auth domain: {auth_domain}")))?;

    let (tx, rx) = oneshot::channel();
    // A sign-in still waiting is over: its window goes too.
    *state.waiting.lock().unwrap() = Some((nonce.clone(), tx));
    let handle = app.clone();
    let on_reply = Arc::new(move |url: Option<&Url>| {
        let reply = match url {
            Some(u) => match parse_reply(u, &nonce) {
                Some(r) => r,
                None => return,
            },
            None => Reply::Closed,
        };
        // Only to this sign-in: an old window closing doesn't end a new one.
        let state = handle.state::<GithubState>();
        let mut waiting = state.waiting.lock().unwrap();
        if waiting.as_ref().is_some_and(|(n, _)| *n == nonce) {
            let (_, tx) = waiting.take().unwrap();
            let _ = tx.send(reply);
        }
    });
    crate::window::open_sign_in(&app, page, on_reply)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("couldn't open the sign-in window: {e}")))?;

    let reply = tokio::time::timeout(SIGN_IN_TIMEOUT, rx).await;
    crate::window::close_sign_in(&app);
    let (token, github_id) = match reply {
        Ok(Ok(Reply::Signed { token, github_id })) => (Token::new(token), github_id),
        Ok(Ok(Reply::Failed(e))) => return Err(ApiError::new(ErrorCode::Upstream, e)),
        Ok(Ok(Reply::Closed)) | Ok(Err(_)) => return Err(ApiError::new(ErrorCode::Cancelled, "sign-in cancelled")),
        Err(_) => return Err(ApiError::new(ErrorCode::Cancelled, "the sign-in took too long")),
    };
    let account = state.gh.user(&token).await?;
    let access_token = token.expose().to_owned();
    let pending = GithubPending { account: account.clone(), github_id: github_id.clone() };
    *state.pending.lock().unwrap() = Some((token, pending));
    tracing::info!(login = %account.login, "signed in with GitHub");
    Ok(GithubCredential { account, github_id, access_token })
}

/// Stops a sign-in in progress (its window closes).
#[tauri::command]
#[specta::specta]
pub fn github_sign_in_cancel(app: AppHandle, state: State<'_, GithubState>) {
    state.waiting.lock().unwrap().take();
    crate::window::close_sign_in(&app);
}

/// Whose token waits for github_save_token, if any.
#[tauri::command]
#[specta::specta]
pub fn github_pending(state: State<'_, GithubState>) -> Option<GithubPending> {
    state.pending.lock().unwrap().as_ref().map(|(_, p)| p.clone())
}

/// Puts the last sign-in's token in place, once the machine is the account's:
/// in wadd, and (with `account`) in the account for your other machines.
#[tauri::command]
#[specta::specta]
pub async fn github_save_token(
    state: State<'_, GithubState>,
    wadd: State<'_, Wadd>,
    account: Option<AccountRef>,
) -> Result<GithubSignedIn, ApiError> {
    let (token, who) = state
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| ApiError::new(ErrorCode::BadRequest, "no GitHub sign-in to save"))?;
    wadd.put_secret("github_token", token.expose())
        .await
        .map_err(|e| ApiError::new(ErrorCode::Upstream, format!("couldn't give wadd the token: {}", e.message)))?;
    let saved_to_account = match account {
        Some(a) => save_to_account(&state.http, &a, &token).await.map(|()| true).unwrap_or_else(|e| {
            tracing::warn!("GitHub token not saved to the account: {e}");
            false
        }),
        None => false,
    };
    // Unless a newer sign-in came in meanwhile.
    let mut pending = state.pending.lock().unwrap();
    if pending.as_ref().is_some_and(|(t, _)| *t == token) {
        pending.take();
    }
    tracing::info!(login = %who.account.login, saved_to_account, "GitHub token saved");
    Ok(GithubSignedIn { account: who.account, saved_to_account })
}

async fn save_to_account(http: &reqwest::Client, a: &AccountRef, token: &Token) -> Result<(), wad_firebase::Error> {
    let fs = match std::env::var("FIRESTORE_EMULATOR_HOST") {
        Ok(host) => Firestore::with_base(http.clone(), &format!("http://{host}"), &a.project_id)?,
        Err(_) => Firestore::new(http.clone(), &a.project_id)?,
    };
    fs.set_strings(&a.id_token, &format!("users/{}/secrets/github_token", a.uid), &[("value", token.expose())]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_is_on_a_firebase_domain() {
        let scopes = vec!["repo".to_string(), "write:packages".to_string()];
        let url = sign_in_page("wad-spaces.firebaseapp.com", "abc", &scopes).unwrap();
        assert_eq!(
            url.as_str(),
            "https://wad-spaces.firebaseapp.com/machine-signin.html?n=abc&scopes=repo%2Cwrite%3Apackages"
        );
        assert!(sign_in_page("wad-spaces.web.app", "abc", &scopes).is_some());
        for bad in [
            "evil.com",
            "firebaseapp.com",
            ".firebaseapp.com",
            "a.b.firebaseapp.com",
            "x.firebaseapp.com/",
            "x.firebaseapp.com.evil.com",
        ] {
            assert!(sign_in_page(bad, "abc", &scopes).is_none(), "{bad}");
        }
    }

    #[test]
    fn replies_carry_the_nonce() {
        let url = |q: &str| Url::parse(&format!("https://{REPLY_HOST}/?{q}")).unwrap();
        assert_eq!(
            parse_reply(&url("n=abc&token=gho_x&id=42"), "abc"),
            Some(Reply::Signed { token: "gho_x".into(), github_id: "42".into() })
        );
        assert_eq!(
            parse_reply(&url("n=abc&error=Sign-ups%20are%20closed"), "abc"),
            Some(Reply::Failed("Sign-ups are closed".into()))
        );
        assert_eq!(parse_reply(&url("n=other&token=gho_x"), "abc"), None);
        assert_eq!(parse_reply(&url("token=gho_x"), "abc"), None);
        assert_eq!(parse_reply(&url("n=abc&token="), "abc"), None);
    }

    #[test]
    fn nonces_differ() {
        let (a, b) = (nonce().unwrap(), nonce().unwrap());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
