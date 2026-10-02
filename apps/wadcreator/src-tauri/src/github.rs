//! Signing this machine in to GitHub with the device flow. The UI shows the
//! code and waits; the token stays here (it's handed to wadd and the account's
//! secrets in S7, never to JavaScript).

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;
use tokio::sync::watch;
use wad_github::{AppConfig, DeviceStart, Github, Token};
use wad_proto::github::{DeviceCode, GithubAccount};
use wad_proto::{ApiError, ErrorCode};

pub struct GithubState {
    gh: Github,
    flow: Mutex<Option<DeviceStart>>,
    /// Bumped to stop a `github_device_wait` in progress.
    cancel: watch::Sender<u64>,
    token: Mutex<Option<Token>>,
}

impl GithubState {
    pub fn new() -> Self {
        Self {
            gh: Github::new(reqwest::Client::new()),
            flow: Mutex::default(),
            cancel: watch::channel(0).0,
            token: Mutex::default(),
        }
    }
}

/// The OAuth App settings: the image's, or (developing on a laptop) the repo's.
fn app_config() -> Result<AppConfig, ApiError> {
    let mut path = PathBuf::from(AppConfig::PATH);
    if cfg!(debug_assertions) && !path.exists() {
        path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../host/usr/lib/wadspaces/github.toml").into();
    }
    AppConfig::load(&path).map_err(|e| ApiError::new(ErrorCode::Internal, e))
}

/// Starts a sign-in: the code for the user to enter at github.com/login/device.
#[tauri::command]
#[specta::specta]
pub async fn github_device_start(state: State<'_, GithubState>) -> Result<DeviceCode, ApiError> {
    let start = state.gh.device_start(&app_config()?).await?;
    let code = start.code.clone();
    state.cancel.send_modify(|n| *n += 1);
    *state.flow.lock().unwrap() = Some(start);
    Ok(code)
}

/// Waits until the user has entered the code, then returns their account.
#[tauri::command]
#[specta::specta]
pub async fn github_device_wait(state: State<'_, GithubState>) -> Result<GithubAccount, ApiError> {
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
    let account = state.gh.user(&token).await?;
    tracing::info!(login = %account.login, "signed in to GitHub");
    *state.token.lock().unwrap() = Some(token);
    state.flow.lock().unwrap().take();
    Ok(account)
}

/// Stops waiting for a sign-in.
#[tauri::command]
#[specta::specta]
pub fn github_device_cancel(state: State<'_, GithubState>) {
    state.flow.lock().unwrap().take();
    state.cancel.send_modify(|n| *n += 1);
}
