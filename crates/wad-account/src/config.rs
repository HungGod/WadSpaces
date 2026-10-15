//! Which Firebase project the account is in: the web app's config (its API
//! key is public; Firebase's rules guard the data). On a machine,
//! /usr/lib/wadspaces/firebase.toml (host/build.sh writes it); a laptop's
//! build reads apps/client/.env.local, as the web app does.

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Config {
    pub api_key: String,
    pub project_id: String,
    /// Where the sign-in page is (`<project>.firebaseapp.com`).
    #[serde(default)]
    pub auth_domain: String,
    #[serde(default)]
    pub functions_region: String,
    /// The Firebase emulators on this host (firebase.json's ports) instead.
    #[serde(default)]
    pub emulator: Option<String>,
}

pub const MACHINE: &str = "/usr/lib/wadspaces/firebase.toml";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("no Firebase settings for the account ({MACHINE}, or apps/client/.env.local on a laptop)")]
    Missing,
    #[error("{0}: {1}")]
    Bad(String, String),
}

impl Config {
    /// The machine's, else (a laptop's build) the web app's .env.local.
    pub fn load() -> Result<Config, ConfigError> {
        if let Some(p) = std::env::var_os("WADSPACES_FIREBASE") {
            return Self::from_toml(Path::new(&p));
        }
        if Path::new(MACHINE).exists() {
            return Self::from_toml(Path::new(MACHINE));
        }
        let env = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/client/.env.local");
        if cfg!(debug_assertions) && env.exists() {
            return Self::from_env_file(&env);
        }
        Err(ConfigError::Missing)
    }

    pub fn from_toml(path: &Path) -> Result<Config, ConfigError> {
        let bad = |e: String| ConfigError::Bad(path.display().to_string(), e);
        let text = std::fs::read_to_string(path).map_err(|e| bad(e.to_string()))?;
        toml::from_str::<Config>(&text).map_err(|e| bad(e.to_string()))?.checked(path)
    }

    /// The web app's `VITE_FIREBASE_*` lines.
    pub fn from_env_file(path: &Path) -> Result<Config, ConfigError> {
        let text =
            std::fs::read_to_string(path).map_err(|e| ConfigError::Bad(path.display().to_string(), e.to_string()))?;
        let get = |k: &str| {
            text.lines()
                .filter_map(|l| l.trim().split_once('='))
                .find(|(key, _)| key.trim() == k)
                .map(|(_, v)| v.trim().trim_matches('"').to_string())
                .unwrap_or_default()
        };
        let emulator = (get("VITE_USE_EMULATORS") == "1").then(|| match get("VITE_EMULATOR_HOST") {
            h if h.is_empty() => "127.0.0.1".to_string(),
            h => h,
        });
        Config {
            api_key: get("VITE_FIREBASE_API_KEY"),
            project_id: get("VITE_FIREBASE_PROJECT_ID"),
            auth_domain: get("VITE_FIREBASE_AUTH_DOMAIN"),
            functions_region: get("VITE_FUNCTIONS_REGION"),
            emulator,
        }
        .checked(path)
    }

    fn checked(mut self, path: &Path) -> Result<Config, ConfigError> {
        if self.api_key.is_empty() || self.project_id.is_empty() {
            return Err(ConfigError::Bad(path.display().to_string(), "needs an API key and a project id".into()));
        }
        if self.auth_domain.is_empty() {
            self.auth_domain = format!("{}.firebaseapp.com", self.project_id);
        }
        Ok(self)
    }

    /// Where the signed-in session is kept for this boot (gone at the next:
    /// every boot starts signed out, as the machine app always has).
    pub fn session_file() -> Option<PathBuf> {
        std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|d| !d.is_empty())
            .map(|d| PathBuf::from(d).join("io.wadspaces.client/session.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_web_apps_env_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(".env.local");
        std::fs::write(
            &p,
            "# x\nVITE_FIREBASE_API_KEY=AIza-k\nVITE_FIREBASE_PROJECT_ID=wad-spaces\nVITE_USE_EMULATORS=0\n",
        )
        .unwrap();
        let c = Config::from_env_file(&p).unwrap();
        assert_eq!(
            (c.api_key.as_str(), c.auth_domain.as_str(), c.emulator),
            ("AIza-k", "wad-spaces.firebaseapp.com", None)
        );
        std::fs::write(&p, "VITE_FIREBASE_API_KEY=k\nVITE_FIREBASE_PROJECT_ID=demo\nVITE_USE_EMULATORS=1\n").unwrap();
        assert_eq!(Config::from_env_file(&p).unwrap().emulator.as_deref(), Some("127.0.0.1"));
        std::fs::write(&p, "VITE_FIREBASE_PROJECT_ID=demo\n").unwrap();
        assert!(Config::from_env_file(&p).is_err());
    }

    #[test]
    fn reads_the_machines_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("firebase.toml");
        std::fs::write(&p, "api_key = \"k\"\nproject_id = \"wad-spaces\"\nauth_domain = \"wad-spaces.web.app\"\n")
            .unwrap();
        assert_eq!(Config::from_toml(&p).unwrap().auth_domain, "wad-spaces.web.app");
    }
}
