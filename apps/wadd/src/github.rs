//! GitHub, where projects live (github.py, and the app's device sign-in).
//!
//! - The device sign-in: start() asks GitHub for a code (shown with a QR code
//!   of where to enter it) and waits in the background; the token becomes the
//!   machine's github_token secret (git, `gh` and the repo list use it) and,
//!   when the app passes the signed-in user, goes to their account too, for
//!   their other machines. It never leaves wadd and podman otherwise.
//! - The repos the owner can use, every page, kept for a minute (the UI asks
//!   often) under a hash of the token, so a new token sees fresh ones.
//! - A new repo (private unless asked, with a first commit) and its project.
//!
//! The cloud relay writes the repo list to the account (users/{uid}/github/
//! repos) for the online app, which has no token: `repos_due` asks it to.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;
use wad_github::{AppConfig, Github, Token};
use wad_proto::github::{AccountRef, GithubStatus, NewRepo, Repo, Repos, SignIn, SignInState};
use wad_proto::v1::{Event, Project};
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
use crate::events::Bus;
use crate::projects::Projects;
use crate::secrets::Secrets;

const CACHE: Duration = Duration::from_secs(60);
pub const TOKEN_SECRET: &str = "github_token";
const NO_TOKEN: &str = "no GitHub token on this machine (sign in to GitHub first)";

fn key(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// (hash of the token, when, login, repos)
type Cached = (String, Instant, String, Vec<Repo>);

pub struct Parts {
    pub backend: Arc<dyn Backend>,
    pub secrets: Arc<Secrets>,
    pub projects: Arc<Projects>,
    pub bus: Bus,
}

pub struct GithubService {
    me: Weak<GithubService>,
    gh: Github,
    app_file: PathBuf,
    http: reqwest::Client,
    /// Where the account's Firestore is (Google's, or the emulator).
    firestore_base: String,
    parts: Parts,
    /// (hash of the token, when, login, repos)
    cache: Mutex<Option<Cached>>,
    /// The repo list changed here: the relay writes it to the account.
    pub repos_due: AtomicBool,
    sign_in: Mutex<Option<SignIn>>,
    waiting: Mutex<Option<JoinHandle<()>>>,
}

impl GithubService {
    pub fn new(
        gh: Github,
        app_file: PathBuf,
        http: reqwest::Client,
        firestore_base: String,
        parts: Parts,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            gh,
            app_file,
            http,
            firestore_base,
            parts,
            cache: Mutex::default(),
            repos_due: AtomicBool::new(false),
            sign_in: Mutex::default(),
            waiting: Mutex::default(),
        })
    }

    async fn token(&self) -> Result<Token, ApiError> {
        self.parts
            .backend
            .github_token()
            .await
            .map(Token::new)
            .ok_or_else(|| ApiError::new(ErrorCode::Conflict, NO_TOKEN))
    }

    fn invalidate(&self) {
        *self.cache.lock().unwrap() = None;
    }

    /// Is there a token here, and whose (and the sign-in, if one's going).
    pub async fn status(&self) -> GithubStatus {
        let sign_in = self.sign_in.lock().unwrap().clone();
        let Some(tok) = self.parts.backend.github_token().await else {
            return GithubStatus { token: false, login: None, error: None, sign_in };
        };
        let cached = self
            .cache
            .lock()
            .unwrap()
            .as_ref()
            .filter(|c| c.0 == key(&tok) && c.1.elapsed() < CACHE)
            .map(|c| c.2.clone());
        if let Some(login) = cached {
            return GithubStatus { token: true, login: Some(login), error: None, sign_in };
        }
        match self.gh.user(&Token::new(tok)).await {
            Ok(u) => GithubStatus { token: true, login: Some(u.login), error: None, sign_in },
            Err(e) => GithubStatus { token: true, login: None, error: Some(e.to_string()), sign_in },
        }
    }

    /// (login, repos): every page, from the last minute's unless `fresh`.
    /// None without a token.
    pub async fn repos(&self, fresh: bool) -> Result<Option<Repos>, ApiError> {
        let Some(tok) = self.parts.backend.github_token().await else { return Ok(None) };
        let k = key(&tok);
        if !fresh && let Some(c) = self.cache.lock().unwrap().as_ref().filter(|c| c.0 == k && c.1.elapsed() < CACHE) {
            return Ok(Some(Repos { login: c.2.clone(), repos: c.3.clone() }));
        }
        let (login, repos) = self.gh.repos(&Token::new(tok)).await?;
        *self.cache.lock().unwrap() = Some((k, Instant::now(), login.clone(), repos.clone()));
        Ok(Some(Repos { login, repos }))
    }

    /// A new repo on GitHub, then a project for it. Everything that could
    /// refuse the project is checked before the repo exists.
    pub async fn create_repo(&self, req: &NewRepo) -> Result<Project, ApiError> {
        let name = req.name.trim();
        if !wad_core::projects::is_repo_name(name) || name == "." || name == ".." {
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                format!("repo name {name:?} may only use letters, digits, '.', '-' and '_'"),
            ));
        }
        let pid = wad_store::projects::new_id();
        let mount =
            req.mount_name.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| wad_store::projects::mount_for(name));
        let mut draft = serde_json::json!({"name": name, "mountName": mount, "setup": req.setup,
            "source": {"kind": "git", "url": format!("https://github.com/o/{name}.git")}});
        self.parts.projects.store.check(&pid, &draft).map_err(crate::projects::api_error)?;
        let tok = self.token().await?;
        let repo = self.gh.create_repo(&tok, name, req.private, &req.description).await?;
        tracing::info!("created GitHub repo {}", repo.full_name);
        self.invalidate();
        self.repos_due.store(true, Ordering::Relaxed);
        draft["source"]["url"] = repo.url.into();
        self.parts.projects.save(&pid, &draft)
    }

    /// Forgets the token here (the account keeps its copy).
    pub async fn sign_out(&self) -> Result<(), ApiError> {
        self.parts.secrets.delete(TOKEN_SECRET).await?;
        self.invalidate();
        Ok(())
    }

    // ------------------------------------------------------ device sign-in
    fn set(&self, s: SignIn) {
        *self.sign_in.lock().unwrap() = Some(s.clone());
        self.parts.bus.publish(Event::Github(s));
    }

    /// Starts a device sign-in (replacing one in progress): the code to show.
    /// With `account`, the token is saved to that account too.
    pub async fn start(&self, account: Option<AccountRef>) -> Result<SignIn, ApiError> {
        let app = AppConfig::load(&self.app_file)
            .map_err(|e| ApiError::new(ErrorCode::Internal, format!("GitHub app settings: {e}")))?;
        self.cancel();
        let flow = self.gh.device_start(&app).await?;
        let s = SignIn {
            state: SignInState::Waiting,
            qr_svg: wad_github::qr_svg(&flow.code.verification_uri),
            code: flow.code.clone(),
            login: None,
            saved_to_account: false,
            error: None,
        };
        self.set(s.clone());
        let me = self.me.upgrade().expect("alive");
        let task = tokio::spawn(async move {
            let r = me.finish(&app, &flow, account).await;
            let mut s = me.sign_in.lock().unwrap().clone().expect("a sign-in");
            match r {
                Ok((login, saved)) => {
                    tracing::info!(%login, saved_to_account = saved, "signed in to GitHub");
                    s.state = SignInState::Done;
                    s.login = Some(login);
                    s.saved_to_account = saved;
                }
                Err(e) => {
                    tracing::info!("GitHub sign-in: {}", e.message);
                    s.state = if e.code == ErrorCode::Cancelled { SignInState::Cancelled } else { SignInState::Failed };
                    s.error = Some(e.message);
                }
            }
            me.set(s);
        });
        *self.waiting.lock().unwrap() = Some(task);
        Ok(s)
    }

    /// Waits for the code to be entered; saves the token here and (with
    /// `account`) to the account. (login, saved to the account)
    async fn finish(
        &self,
        app: &AppConfig,
        flow: &wad_github::DeviceStart,
        account: Option<AccountRef>,
    ) -> Result<(String, bool), ApiError> {
        let token = self.gh.device_wait(app, flow).await?;
        let login = self.gh.user(&token).await?.login;
        self.parts.secrets.set(TOKEN_SECRET, token.expose().as_bytes()).await?;
        self.invalidate();
        self.repos_due.store(true, Ordering::Relaxed);
        let saved = match account {
            Some(a) => match self.save_to_account(&a, &token).await {
                Ok(()) => true,
                Err(e) => {
                    tracing::warn!("GitHub token not saved to the account: {e}");
                    false
                }
            },
            None => false,
        };
        Ok((login, saved))
    }

    async fn save_to_account(&self, a: &AccountRef, token: &Token) -> Result<(), wad_firebase::Error> {
        let fs = wad_firebase::Firestore::with_base(self.http.clone(), &self.firestore_base, &a.project_id)?;
        fs.set_strings(&a.id_token, &format!("users/{}/secrets/{TOKEN_SECRET}", a.uid), &[("value", token.expose())])
            .await
    }

    /// Stops waiting for a sign-in.
    pub fn cancel(&self) {
        if let Some(t) = self.waiting.lock().unwrap().take() {
            t.abort();
        }
        let waiting = self.sign_in.lock().unwrap().clone().filter(|s| s.state == SignInState::Waiting);
        if let Some(mut s) = waiting {
            s.state = SignInState::Cancelled;
            self.set(s);
        }
    }
}
