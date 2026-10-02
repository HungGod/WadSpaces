//! Signing this machine in to GitHub with the device flow. The UI shows the
//! code (and a QR code of the address, for a phone) and waits. The token stays
//! here: it goes to wadd (the machine's `github_token` secret, for git, `gh`
//! and the repo list) and to the account (`users/{uid}/secrets/github_token`,
//! which the owner's other machines sync), never to JavaScript.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tokio::sync::watch;
use wad_firebase::Firestore;
use wad_github::{AppConfig, DeviceStart, Github, Token};
use wad_proto::github::{DeviceCode, GithubAccount};
use wad_proto::{ApiError, ErrorCode};

use crate::wadd::Wadd;

pub struct GithubState {
    gh: Github,
    http: reqwest::Client,
    flow: Mutex<Option<DeviceStart>>,
    /// Bumped to stop a `github_device_wait` in progress.
    cancel: watch::Sender<u64>,
}

impl GithubState {
    pub fn new() -> Self {
        let http = reqwest::Client::new();
        Self { gh: Github::new(http.clone()), http, flow: Mutex::default(), cancel: watch::channel(0).0 }
    }
}

/// What the sign-in screen shows.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevicePrompt {
    pub code: DeviceCode,
    /// A QR code of `code.verificationUri`, as an SVG document.
    pub qr_svg: String,
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

fn qr_svg(text: &str) -> String {
    use qrcode::render::svg;
    qrcode::QrCode::new(text.as_bytes())
        .map(|q| q.render::<svg::Color>().min_dimensions(200, 200).quiet_zone(true).build())
        .unwrap_or_default()
}

/// Starts a sign-in: the code for the user to enter at github.com/login/device.
#[tauri::command]
#[specta::specta]
pub async fn github_device_start(state: State<'_, GithubState>) -> Result<DevicePrompt, ApiError> {
    let start = state.gh.device_start(&app_config()?).await?;
    let code = start.code.clone();
    state.cancel.send_modify(|n| *n += 1);
    *state.flow.lock().unwrap() = Some(start);
    Ok(DevicePrompt { qr_svg: qr_svg(&code.verification_uri), code })
}

/// Waits until the user has entered the code, then saves the token on this
/// machine and (with `account`) to the account.
#[tauri::command]
#[specta::specta]
pub async fn github_device_wait(
    state: State<'_, GithubState>,
    wadd: State<'_, Wadd>,
    account: Option<AccountRef>,
) -> Result<GithubSignedIn, ApiError> {
    let app = app_config()?;
    let start = state
        .flow
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| ApiError::new(ErrorCode::BadRequest, "no GitHub sign-in in progress"))?;
    let mut cancel = state.cancel.subscribe();
    cancel.mark_unchanged();
    let token = tokio::select! {
        r = state.gh.device_wait(&app, &start) => r?,
        _ = cancel.changed() => return Err(ApiError::new(ErrorCode::Cancelled, "GitHub sign-in cancelled")),
    };
    state.flow.lock().unwrap().take();
    let account_info = state.gh.user(&token).await?;
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
    tracing::info!(login = %account_info.login, saved_to_account, "signed in to GitHub");
    Ok(GithubSignedIn { account: account_info, saved_to_account })
}

async fn save_to_account(http: &reqwest::Client, a: &AccountRef, token: &Token) -> Result<(), wad_firebase::Error> {
    let fs = match std::env::var("FIRESTORE_EMULATOR_HOST") {
        Ok(host) => Firestore::with_base(http.clone(), &format!("http://{host}"), &a.project_id)?,
        Err(_) => Firestore::new(http.clone(), &a.project_id)?,
    };
    fs.set_strings(&a.id_token, &format!("users/{}/secrets/github_token", a.uid), &[("value", token.expose())]).await
}

/// Stops waiting for a sign-in.
#[tauri::command]
#[specta::specta]
pub fn github_device_cancel(state: State<'_, GithubState>) {
    state.flow.lock().unwrap().take();
    state.cancel.send_modify(|n| *n += 1);
}

#[cfg(test)]
mod tests {
    #[test]
    fn qr_is_an_svg() {
        let svg = super::qr_svg("https://github.com/login/device");
        assert!(svg.starts_with("<?xml") && svg.contains("<svg"), "{}", &svg[..60.min(svg.len())]);
    }
}
