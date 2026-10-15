//! The account against the Firebase emulators, with the real firestore.rules
//! (apps/client/dev/try-account.sh runs it): two people sign in, the
//! first gets their GitHub login as username, the second can't take it,
//! linking codes and the GitHub token go in as the rules allow, and a
//! restarted app is still signed in.

use wad_account::{Account, Config, Error};

fn cfg() -> Config {
    Config {
        api_key: "fake-api-key".into(),
        project_id: "demo-client".into(),
        auth_domain: "demo-client.firebaseapp.com".into(),
        functions_region: String::new(),
        emulator: Some("127.0.0.1".into()),
    }
}

#[tokio::main]
async fn main() {
    let dir = std::env::temp_dir().join(format!("wad-account-try-{}", std::process::id()));
    let file = dir.join("session.json");
    let a = Account::new(cfg(), Some(file.clone())).unwrap();
    let u = a.sign_in_emulated("Octo-Cat", "4242").await.unwrap();
    println!("signed in: {} ({}, GitHub {})", u.uid, u.login.as_deref().unwrap_or("?"), u.github_id);
    assert_eq!(u.github_id, "4242");
    let p = a.ensure_profile().await.unwrap().expect("a profile with the GitHub login");
    println!("profile: @{} ({}), onboarded {}", p.username, p.display_name, p.onboarded);
    assert_eq!(p.username, "octo-cat");
    assert_eq!(a.profile().await.unwrap().map(|p| p.username), Some("octo-cat".into()));

    // Someone else, whose GitHub login is the same name: they pick another.
    let b = Account::new(cfg(), None).unwrap();
    b.sign_in_emulated("octo-cat", "777").await.unwrap();
    assert!(b.ensure_profile().await.unwrap().is_none(), "the name is taken: they're asked for one");
    assert!(b.username_taken("octo-cat").await.unwrap());
    assert!(matches!(b.claim_username("octo-cat", "Imposter").await, Err(Error::Taken)));
    let pb = b.claim_username("octo-two", "Two").await.unwrap();
    println!("second: @{}", pb.username);

    let code = a.create_enroll_code("Surface").await.unwrap();
    println!("link code: {code}");
    a.save_github_token("gho_fake").await.unwrap();
    println!("GitHub token saved to the account");

    // The app restarts this boot: still signed in.
    let again = Account::new(cfg(), Some(file.clone())).unwrap();
    assert_eq!(again.restore().await.map(|u| u.uid), Some(u.uid.clone()));
    assert_eq!(again.profile().await.unwrap().map(|p| p.username), Some("octo-cat".into()));
    again.sign_out();
    assert!(!file.exists());
    let _ = std::fs::remove_dir_all(dir);
    println!("account: all as expected");
}
