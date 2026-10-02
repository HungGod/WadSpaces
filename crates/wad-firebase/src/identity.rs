//! Signing in with Firebase Auth's REST API: a custom token (a machine's, from
//! enrollMachine) for an ID token and a refresh token, and refreshing.

use serde_json::{Value, json};

use crate::Error;

const IDENTITY: &str = "https://identitytoolkit.googleapis.com/v1";
const SECURETOKEN: &str = "https://securetoken.googleapis.com/v1";

#[derive(Debug, Clone)]
pub struct Identity {
    http: reqwest::Client,
    identity: String,
    securetoken: String,
}

/// An ID token, how long it lasts, and the refresh token to get the next one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    pub id_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

impl Identity {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, identity: IDENTITY.into(), securetoken: SECURETOKEN.into() }
    }

    /// Against the Auth emulator (`127.0.0.1:9099`).
    pub fn emulator(http: reqwest::Client, host: &str) -> Self {
        Self {
            http,
            identity: format!("http://{host}/identitytoolkit.googleapis.com/v1"),
            securetoken: format!("http://{host}/securetoken.googleapis.com/v1"),
        }
    }

    /// Against a test server (both APIs under it).
    pub fn with_base(http: reqwest::Client, base: &str) -> Self {
        let b = base.trim_end_matches('/');
        Self { http, identity: format!("{b}/identitytoolkit"), securetoken: format!("{b}/securetoken") }
    }

    async fn answer(res: reqwest::Response) -> Result<Value, Error> {
        let status = res.status().as_u16();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status == 200 {
            return Ok(body);
        }
        let message = body.pointer("/error/message").and_then(Value::as_str).unwrap_or("no reason given").to_string();
        Err(Error::Auth { status, message })
    }

    pub async fn sign_in_with_custom_token(&self, api_key: &str, token: &str) -> Result<Tokens, Error> {
        let res = self
            .http
            .post(format!("{}/accounts:signInWithCustomToken", self.identity))
            .query(&[("key", api_key)])
            .json(&json!({"token": token, "returnSecureToken": true}))
            .send()
            .await
            .map_err(Error::Network)?;
        let b = Self::answer(res).await?;
        Ok(Tokens {
            id_token: b["idToken"].as_str().unwrap_or_default().into(),
            refresh_token: b["refreshToken"].as_str().unwrap_or_default().into(),
            expires_in: b["expiresIn"].as_str().and_then(|s| s.parse().ok()).unwrap_or(3600),
        })
    }

    pub async fn refresh(&self, api_key: &str, refresh_token: &str) -> Result<Tokens, Error> {
        let res = self
            .http
            .post(format!("{}/token", self.securetoken))
            .query(&[("key", api_key)])
            .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)])
            .send()
            .await
            .map_err(Error::Network)?;
        let b = Self::answer(res).await?;
        Ok(Tokens {
            id_token: b["id_token"].as_str().unwrap_or_default().into(),
            refresh_token: b["refresh_token"].as_str().unwrap_or(refresh_token).into(),
            expires_in: b["expires_in"].as_str().and_then(|s| s.parse().ok()).unwrap_or(3600),
        })
    }
}
