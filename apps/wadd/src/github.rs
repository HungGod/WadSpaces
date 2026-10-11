//! GitHub, where projects live (github.py).
//!
//! The token is the machine's github_token secret, from the WadSpaces Client's
//! GitHub sign-in (PUT /v1/secrets/github_token) or the account's copy (the
//! relay's sync-secrets). git, `gh` and the repo list use it; it never leaves
//! wadd and podman otherwise.
//!
//! - Whose token it is.
//! - The repos the owner can use, every page, kept for a minute (the UI asks
//!   often) under a hash of the token, so a new token sees fresh ones.
//! - A new repo (private unless asked, with a first commit) and its project.
//!
//! The cloud relay writes the repo list to the account (users/{uid}/github/
//! repos) for the online app, which has no token: `repos_due` asks it to.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use wad_github::{Github, Token};
use wad_proto::github::{GithubStatus, NewRepo, Repo, Repos};
use wad_proto::v1::Project;
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
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
}

pub struct GithubService {
    gh: Github,
    parts: Parts,
    /// (hash of the token, when, login, repos)
    cache: Mutex<Option<Cached>>,
    /// The repo list changed here: the relay writes it to the account.
    pub repos_due: AtomicBool,
}

impl GithubService {
    pub fn new(gh: Github, parts: Parts) -> Arc<Self> {
        Arc::new(Self { gh, parts, cache: Mutex::default(), repos_due: AtomicBool::new(false) })
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

    /// Is there a token here, and whose.
    pub async fn status(&self) -> GithubStatus {
        let Some(tok) = self.parts.backend.github_token().await else {
            return GithubStatus { token: false, login: None, error: None };
        };
        let cached = self
            .cache
            .lock()
            .unwrap()
            .as_ref()
            .filter(|c| c.0 == key(&tok) && c.1.elapsed() < CACHE)
            .map(|c| c.2.clone());
        if let Some(login) = cached {
            return GithubStatus { token: true, login: Some(login), error: None };
        }
        match self.gh.user(&Token::new(tok)).await {
            Ok(u) => GithubStatus { token: true, login: Some(u.login), error: None },
            Err(e) => GithubStatus { token: true, login: None, error: Some(e.to_string()) },
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
}
