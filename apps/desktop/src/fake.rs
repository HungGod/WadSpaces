//! A made-up machine and account (WADSPACES_FAKE=fixtures/desktop/sample.json):
//! the app's pages with something in them, for snapshots and trying the UI
//! without a wadd or a sign-in.

use serde_json::Value;

use crate::store::{ProfileState, Topic, store};

pub fn load(path: &std::path::Path) {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("{}: {e}", path.display());
            return;
        }
    };
    let v: Value = serde_json::from_str(&text).unwrap_or_default();
    fn take<T: serde::de::DeserializeOwned>(v: &Value, k: &str) -> Result<T, serde_json::Error> {
        serde_json::from_value(v[k].clone())
    }
    store().update(|s| {
        s.connected = true;
        s.machine = take(&v, "machine").ok();
        s.workspaces = take(&v, "workspaces").unwrap_or_default();
        let states: Vec<wad_proto::v1::WorkspaceState> = take(&v, "states").unwrap_or_default();
        s.states = states.into_iter().map(|st| (st.id.clone(), st)).collect();
        s.library = take(&v, "library").ok();
        s.account.checked = true;
        s.account.user = take(&v, "user").ok();
        s.account.github = Some(true);
        let p = &v["profile"];
        s.account.profile = ProfileState::Have(wad_account::Profile {
            username: p["username"].as_str().unwrap_or("me").into(),
            display_name: p["displayName"].as_str().unwrap_or("Me").into(),
            color: p["color"].as_str().unwrap_or("#c6ff1f").into(),
            photo_url: None,
            onboarded: true,
            starters_created: true,
            last_session: v.get("lastSession").cloned(),
        });
        Topic::ACCOUNT | Topic::LIBRARY | Topic::MACHINE | Topic::WORKSPACES | Topic::STATES | Topic::WADD
    });
}
