//! The machine's secrets: account sync by digest, placeholders, local ones,
//! and forgetting an old owner's.

mod common;

use std::sync::Arc;

use common::Fake;
use wad_proto::v1::SecretOrigin;
use wadd::secrets::{PLACEHOLDER, Secrets};

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

fn value(f: &Fake, name: &str) -> Option<Vec<u8>> {
    f.0.lock().unwrap().secrets.get(name).cloned()
}

#[tokio::test]
async fn the_account_is_synced_by_digest() {
    let d = tempfile::tempdir().unwrap();
    let fake = Fake::default();
    let s = Secrets::new(Arc::new(fake.clone()), d.path());
    let r = s.sync_account(&pairs(&[("github_token", "ghp_one"), ("api_key", "k1")])).await.unwrap();
    assert_eq!((r.added.len(), r.updated.len(), r.unchanged.len()), (2, 0, 0));
    assert_eq!(value(&fake, "github_token").as_deref(), Some(&b"ghp_one"[..]));
    // Again, unchanged: nothing written.
    fake.with(|m| {
        m.secrets.insert("api_key".into(), b"changed here".to_vec());
    });
    let r = s.sync_account(&pairs(&[("github_token", "ghp_one"), ("api_key", "k1")])).await.unwrap();
    assert_eq!(r.unchanged.len(), 2);
    assert_eq!(value(&fake, "api_key").as_deref(), Some(&b"changed here"[..])); // only account changes propagate
    // Changed in the account, and one deleted there.
    let r = s.sync_account(&pairs(&[("github_token", "ghp_two")])).await.unwrap();
    assert_eq!((r.updated, r.removed), (vec!["github_token".to_string()], vec!["api_key".to_string()]));
    assert_eq!(value(&fake, "github_token").as_deref(), Some(&b"ghp_two"[..]));
    assert!(value(&fake, "api_key").is_none());
    // The book holds digests, never values.
    let book = std::fs::read_to_string(d.path().join("secrets.json")).unwrap();
    assert!(!book.contains("ghp_two"), "{book}");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(d.path().join("secrets.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[tokio::test]
async fn placeholders_until_a_real_value_comes() {
    let d = tempfile::tempdir().unwrap();
    let fake = Fake::default();
    let s = Secrets::new(Arc::new(fake.clone()), d.path());
    fake.with(|m| {
        m.secrets.insert("mine".into(), b"x".to_vec());
    });
    let made = s.ensure(&["github_token".into(), "mine".into(), "Bad Name".into()]).await.unwrap();
    assert_eq!(made, ["github_token"]);
    assert_eq!(value(&fake, "github_token").as_deref(), Some(PLACEHOLDER));
    let list = s.list().await.unwrap();
    let origin = |n: &str| list.iter().find(|i| i.name == n).map(|i| i.origin);
    assert_eq!((origin("github_token"), origin("mine")), (Some(SecretOrigin::Placeholder), Some(SecretOrigin::Local)));
    // A real value replaces it, from the account...
    s.sync_account(&pairs(&[("github_token", "ghp_real")])).await.unwrap();
    assert_eq!(value(&fake, "github_token").as_deref(), Some(&b"ghp_real"[..]));
    assert_eq!(
        s.list().await.unwrap().iter().find(|i| i.name == "github_token").unwrap().origin,
        SecretOrigin::Account
    );
    // ...or set here.
    s.ensure(&["other".into()]).await.unwrap();
    s.set("other", b"set here").await.unwrap();
    assert_eq!(s.list().await.unwrap().iter().find(|i| i.name == "other").unwrap().origin, SecretOrigin::Local);
    assert!(s.set("Bad Name", b"x").await.is_err() && s.set("ok", b"").await.is_err());
}

#[tokio::test]
async fn a_new_owner_gets_none_of_the_last_ones() {
    let d = tempfile::tempdir().unwrap();
    let fake = Fake::default();
    let s = Secrets::new(Arc::new(fake.clone()), d.path());
    s.sync_account(&pairs(&[("api_key", "theirs")])).await.unwrap();
    s.set("github_token", b"theirs too").await.unwrap(); // the app's sign-in: local, still theirs
    fake.with(|m| {
        m.secrets.insert("unrelated".into(), b"x".to_vec());
    });
    let mut gone = s.forget_account().await.unwrap();
    gone.sort();
    assert_eq!(gone, ["api_key", "github_token"]);
    assert!(value(&fake, "unrelated").is_some());
    assert!(s.delete("unrelated").await.unwrap() && !s.delete("unrelated").await.unwrap());
}
