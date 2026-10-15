//! Keys picked per slot, in the launcher's runs and WadBrowser setups (the
//! web app's components/launcher/slots.ts): a new saved sign-in (named
//! after the run or setup unless a name is typed), one already saved of the
//! same kind (by its id), or none. Using them makes the new ones first and
//! keeps a SignInRef ({id, name, kind}) per slot.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use wad_core::layers;

use crate::signins;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    None,
    New,
    Existing,
}

/// What a slot keeps: nothing, a new secret (empty name: the default), one
/// already saved (its id), or new for another slot here (its name, no id).
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub mode: Mode,
    pub name: String,
    pub id: Option<String>,
}

impl Choice {
    pub fn new(name: &str) -> Choice {
        Choice { mode: Mode::New, name: name.into(), id: None }
    }
}

/// What the choices hang off: a name (for new secrets' default names) and a
/// choice per slot; a WadBrowser setup's new secrets are named its way.
#[derive(Debug, Clone, Default)]
pub struct Draft {
    pub name: String,
    pub secrets: HashMap<String, Choice>,
    pub browser: bool,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

impl Draft {
    /// A slot's choice: the draft's, else a new secret.
    pub fn choice(&self, slot: &Value) -> Choice {
        self.secrets.get(s(slot, "key")).cloned().unwrap_or_else(|| Choice::new(""))
    }

    /// What a new secret's called when no name is typed.
    pub fn default_name(&self, slot: &Value) -> String {
        if self.browser {
            layers::default_browser_secret_name(&self.name, slot)
        } else {
            layers::new_secret_name(&self.name, slot)
        }
    }

    /// The secret a slot ends up with, or None.
    pub fn resolved_name(&self, slot: &Value) -> Option<String> {
        let c = self.choice(slot);
        match c.mode {
            Mode::None => None,
            Mode::Existing => Some(c.name).filter(|n| !n.is_empty()),
            Mode::New => {
                Some(if c.name.trim().is_empty() { self.default_name(slot) } else { c.name.trim().to_string() })
            }
        }
    }
}

/// A slot's secret once resolved: a saved one (its id) or one to make.
#[derive(Debug, Clone, PartialEq)]
pub struct Ref {
    pub name: String,
    pub kind: String,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resolved {
    /// By slot key.
    pub refs: Vec<(String, Ref)>,
    /// New ones to make: (name, kind).
    pub fresh: Vec<(String, String)>,
    pub problems: Vec<String>,
}

/// Each slot's secret, the new ones to make, and what's wrong (an unknown
/// pick, one name for two kinds). `saved`: (id, name, kind) that can be picked.
pub fn resolve(d: &Draft, slots: &[Value], saved: &[(String, String, String)]) -> Resolved {
    let mut r = Resolved::default();
    let by_name: HashMap<String, &(String, String, String)> = saved.iter().map(|x| (x.1.to_lowercase(), x)).collect();
    let by_id: HashMap<&str, &(String, String, String)> = saved.iter().map(|x| (x.0.as_str(), x)).collect();
    let fresh_names: Vec<String> = slots
        .iter()
        .filter(|sl| d.choice(sl).mode == Mode::New)
        .filter_map(|sl| d.resolved_name(sl))
        .map(|n| n.to_lowercase())
        .collect();
    let mut kinds: HashMap<String, String> = saved.iter().map(|x| (x.1.to_lowercase(), x.2.clone())).collect();
    for sl in slots {
        let c = d.choice(sl);
        // A saved one has its id; a pick by name is one this draft is about
        // to save for another slot.
        if c.mode == Mode::Existing && c.id.is_none() && !fresh_names.contains(&c.name.to_lowercase()) {
            r.problems.push(format!("Pick a secret for {}, or save a new one.", s(sl, "label")));
        }
    }
    for sl in slots {
        let c = d.choice(sl);
        let Some(name) = d.resolved_name(sl) else { continue };
        let key = name.to_lowercase();
        let kind = s(sl, "kind").to_string();
        if let Some(k) = kinds.get(&key).filter(|k| **k != kind) {
            r.problems.push(format!(
                "\"{name}\" is a {}; {} needs a {}.",
                signins::kind_label(k).to_lowercase(),
                s(sl, "label"),
                signins::kind_label(&kind).to_lowercase()
            ));
            continue;
        }
        kinds.insert(key.clone(), kind.clone());
        let known =
            c.id.as_deref()
                .filter(|_| c.mode == Mode::Existing)
                .and_then(|id| by_id.get(id))
                .or_else(|| by_name.get(&key));
        let slot_key = s(sl, "key").to_string();
        match (c.mode, &c.id, known) {
            (Mode::Existing, Some(id), None) => {
                r.refs.push((slot_key, Ref { name, kind, id: Some(id.clone()) }));
            }
            (_, _, Some(k)) => r.refs.push((slot_key, Ref { name: k.1.clone(), kind, id: Some(k.0.clone()) })),
            _ => {
                if !r.fresh.iter().any(|(n, _)| n.to_lowercase() == key) {
                    r.fresh.push((name.clone(), kind.clone()));
                }
                r.refs.push((slot_key, Ref { name, kind, id: None }));
            }
        }
    }
    r
}

/// Makes the new sign-ins a draft names (once each) and gives every slot its
/// ref: `{<slot>: {id, name, kind}}`.
pub async fn refs(r: &Resolved) -> Result<Map<String, Value>, String> {
    let mut made: HashMap<String, (String, String)> = HashMap::new();
    for (name, kind) in &r.fresh {
        let x = signins::create(name.clone(), kind.clone()).await?;
        made.insert(name.to_lowercase(), (x.id, x.name));
    }
    let mut out = Map::new();
    for (key, x) in &r.refs {
        let (id, name) = match &x.id {
            Some(id) => (id.clone(), x.name.clone()),
            None => match made.get(&x.name.to_lowercase()) {
                Some((id, name)) => (id.clone(), name.clone()),
                None => continue,
            },
        };
        out.insert(key.clone(), json!({ "id": id, "name": name, "kind": x.kind }));
    }
    Ok(out)
}

/// Saved secrets (`{<slot>: {id, name}}`) as choices.
pub fn as_choices(secrets: &Value) -> HashMap<String, Choice> {
    secrets
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, r)| {
            (k.clone(), Choice { mode: Mode::Existing, name: s(r, "name").into(), id: Some(s(r, "id").into()) })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(key: &str, kind: &str, label: &str, app: &str) -> Value {
        json!({ "key": key, "kind": kind, "label": label, "appId": app, "iconUrl": "" })
    }

    #[test]
    fn new_keys_are_named_after_the_run_and_shared_by_name() {
        let slots = vec![
            slot("web:gh", "web", "GitHub (web app)", "WadBrowser-GitHub"),
            slot("web:gm", "web", "Gmail (web app)", "WadBrowser-Gmail"),
        ];
        let mut d = Draft { name: "My Run".into(), ..Default::default() };
        let r = resolve(&d, &slots, &[]);
        assert_eq!(
            r.fresh.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            vec!["MyRun-WadBrowser-GitHub", "MyRun-WadBrowser-Gmail"]
        );
        // One name for both: one sign-in, made once.
        d.secrets
            .insert("web:gm".into(), Choice { mode: Mode::Existing, name: "MyRun-WadBrowser-GitHub".into(), id: None });
        let r = resolve(&d, &slots, &[]);
        assert!(r.problems.is_empty(), "{:?}", r.problems);
        assert_eq!(r.fresh.len(), 1);
        assert_eq!(r.refs.len(), 2);
    }

    #[test]
    fn unnamed_setups_name_new_keys_the_wadbrowser_way() {
        let slots = [slot("web:gh", "web", "GitHub", "WadBrowser-GitHub")];
        let d = Draft { browser: true, ..Default::default() };
        assert_eq!(d.resolved_name(&slots[0]).as_deref(), Some("WadSpaces-WadBrowser.GitHub"));
    }

    #[test]
    fn saved_keys_are_found_and_kinds_must_match() {
        let slots = vec![slot("ext:anthropic.claude-code", "vscode-claude-code", "Claude Code (VS Code)", "Claude")];
        let saved = vec![("k1".to_string(), "Work".to_string(), "web".to_string())];
        let mut d = Draft { name: "X".into(), ..Default::default() };
        d.secrets.insert("ext:anthropic.claude-code".into(), Choice::new("Work"));
        let r = resolve(&d, &slots, &saved);
        assert_eq!(r.problems.len(), 1, "a web sign-in can't be Claude Code's");
        d.secrets
            .insert("ext:anthropic.claude-code".into(), Choice { mode: Mode::Existing, name: String::new(), id: None });
        let r = resolve(&d, &slots, &saved);
        assert_eq!(r.problems, vec!["Pick a secret for Claude Code (VS Code), or save a new one.".to_string()]);
        let mut d = Draft { name: "X".into(), ..Default::default() };
        d.secrets
            .insert("ext:anthropic.claude-code".into(), Choice { mode: Mode::None, name: String::new(), id: None });
        assert!(resolve(&d, &slots, &saved).refs.is_empty());
    }
}
