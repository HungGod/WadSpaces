//! The GitHub sign-in page: Firebase runs GitHub's sign-in (it holds the
//! OAuth App's secret) on the web portal's `/machine-signin.html`, shown in
//! a window over the app (the `client-signin` helper). The page hands the
//! GitHub token back as the address of a page that doesn't exist, which the
//! window catches before anything loads.

use std::io::Read;

use url::Url;

/// Where the sign-in page sends its result: never loaded.
pub const REPLY_HOST: &str = "signed-in.client.invalid";
/// Where the window goes to close (Ctrl+W).
pub const CLOSE_URL: &str = "https://close.client.invalid/";

/// The sign-in page on the portal's Firebase auth domain (the one GitHub's
/// callback address names), or None for anything that isn't one.
pub fn page(auth_domain: &str, nonce: &str, scopes: &[String]) -> Option<Url> {
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

/// What the sign-in ended with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Signed { token: String, github_id: String },
    Failed(String),
}

/// The page's answer, from its reply address (None: not one, or not this
/// sign-in's).
pub fn reply(url: &str, nonce: &str) -> Option<Reply> {
    let url = Url::parse(url).ok()?;
    if url.host_str() != Some(REPLY_HOST) {
        return None;
    }
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

/// 32 random hex digits: ties a reply to its sign-in.
pub fn nonce() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The OAuth scopes the token is asked for (host/usr/lib/wadspaces/github.toml).
pub fn scopes() -> Vec<String> {
    let mut path = std::path::PathBuf::from("/usr/lib/wadspaces/github.toml");
    if cfg!(debug_assertions) && !path.exists() {
        path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/usr/lib/wadspaces/github.toml").into();
    }
    #[derive(serde::Deserialize)]
    struct Github {
        scopes: Vec<String>,
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| toml::from_str::<Github>(&t).ok())
        .map(|g| g.scopes)
        .unwrap_or_else(|| ["repo", "workflow", "read:org", "write:packages", "user:email"].map(String::from).to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_is_on_a_firebase_domain() {
        let scopes = vec!["repo".to_string(), "write:packages".to_string()];
        let url = page("wad-spaces.firebaseapp.com", "abc", &scopes).unwrap();
        assert_eq!(
            url.as_str(),
            "https://wad-spaces.firebaseapp.com/machine-signin.html?n=abc&scopes=repo%2Cwrite%3Apackages"
        );
        assert!(page("wad-spaces.web.app", "abc", &scopes).is_some());
        for bad in [
            "evil.com",
            "firebaseapp.com",
            ".firebaseapp.com",
            "a.b.firebaseapp.com",
            "x.firebaseapp.com/",
            "x.firebaseapp.com.evil.com",
        ] {
            assert!(page(bad, "abc", &scopes).is_none(), "{bad}");
        }
    }

    #[test]
    fn replies_carry_the_nonce() {
        let url = |q: &str| format!("https://{REPLY_HOST}/?{q}");
        assert_eq!(
            reply(&url("n=abc&token=gho_x&id=42"), "abc"),
            Some(Reply::Signed { token: "gho_x".into(), github_id: "42".into() })
        );
        assert_eq!(
            reply(&url("n=abc&error=Sign-ups%20are%20closed"), "abc"),
            Some(Reply::Failed("Sign-ups are closed".into()))
        );
        assert_eq!(reply(&url("n=other&token=gho_x"), "abc"), None);
        assert_eq!(reply(&url("n=abc&token="), "abc"), None);
        assert_eq!(reply("https://github.com/?n=abc&token=gho_x", "abc"), None);
        let (a, b) = (nonce().unwrap(), nonce().unwrap());
        assert!(a.len() == 32 && a != b);
        assert!(!scopes().is_empty());
    }
}
