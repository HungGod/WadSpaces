//! What moving a machine from the Python wadd to the Rust one does, worked
//! out from what's there (`wadd migrate --dry-run` prints it; `wadd migrate`,
//! which wadd.service runs before it starts, does it: wadd's migrate.rs). Most state stays exactly as it is, so the
//! Python wadd can still read it after a rollback.

use std::path::Path;

use serde::Serialize;

use crate::State;
use crate::legacy::{self, LegacyConfig};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    /// Left as it is.
    Keep,
    /// Converted into a new place or form.
    Convert,
    /// Taken out.
    Remove,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Step {
    pub action: Action,
    pub what: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// Things to look at by hand before the cutover.
    pub warnings: Vec<String>,
}

fn step(action: Action, what: &str, detail: impl Into<String>) -> Step {
    Step { action, what: what.into(), detail: detail.into() }
}

fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The plan for this machine: `yaml` is /etc/wadspaces/workspaces.yaml.
pub fn plan(yaml: &Path, vendor_cloud: Option<&Path>) -> Plan {
    let mut steps = Vec::new();
    let mut warnings = Vec::new();
    let cfg: Option<LegacyConfig> = match legacy::read(yaml, vendor_cloud) {
        Ok(c) => Some(c),
        Err(e) => {
            warnings.push(format!("{}: {e}", yaml.display()));
            None
        }
    };
    let state = State::new(cfg.as_ref().map(LegacyConfig::state_dir).unwrap_or_else(|| "/var/lib/wadspaces".into()));

    if let Some(c) = &cfg {
        let ids: Vec<&str> = c.workspaces.iter().map(|w| w.id.as_str()).collect();
        steps.push(step(
            Action::Convert,
            "workspaces",
            format!(
                "{} from {} become state: {}/workspaces.json ({}), with the image's workspaces (workspaces.d) applied over them. The YAML stays, unused.",
                count(c.workspaces.len(), "workspace", "workspaces"),
                yaml.display(),
                state.dir.display(),
                ids.join(", ")
            ),
        ));
        let quadlets = std::fs::read_dir(c.quadlet_dir())
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| {
                        let n = e.file_name().to_string_lossy().into_owned();
                        n.starts_with("wad-") && n.ends_with(".container")
                    })
                    .count()
            })
            .unwrap_or(0);
        steps.push(step(
            Action::Remove,
            "units",
            format!(
                "{} in {}: the Rust wadd writes them to /run/containers/systemd each time it starts, so they're never stale",
                count(quadlets, "wad-*.container", "wad-*.container files"),
                c.quadlet_dir()
            ),
        ));
        for w in &c.workspaces {
            if w.volumes.iter().any(|v| v.starts_with('/')) {
                warnings.push(format!(
                    "workspace {} binds a host path ({:?}): the Rust wadd refuses those; make it a folder project",
                    w.id, w.volumes
                ));
            }
        }
        let unknown_mounts: Vec<String> = c
            .workspaces
            .iter()
            .flat_map(|w| w.projects.iter().map(move |p| (w.id.clone(), p.id.clone())))
            .filter(|(_, pid)| !state.dir.join("projects").join(format!("{pid}.json")).exists())
            .map(|(w, p)| format!("{w}:{p}"))
            .collect();
        if !unknown_mounts.is_empty() {
            warnings.push(format!("workspaces mount projects that have no document: {}", unknown_mounts.join(", ")));
        }
    }

    let projects = state.projects();
    let live = projects.iter().filter(|p| !p.deleted).count();
    let legacy = projects.iter().filter(|p| p.legacy && !p.deleted).count();
    steps.push(step(
        Action::Keep,
        "projects",
        format!(
            "{} ({} live, {} deleted{}) in {}/projects",
            count(projects.len(), "document", "documents"),
            live,
            projects.len() - live,
            if legacy > 0 { format!(", {legacy} from before sources") } else { String::new() },
            state.dir.display()
        ),
    ));
    if let Some(c) = &cfg {
        steps.push(step(Action::Keep, "project folders", format!("clones in {}, as they are", c.projects_dir())));
    }

    let link = state.cloud();
    steps.push(step(
        Action::Keep,
        "account link",
        if link.linked {
            format!(
                "linked as machine {} of {} (enrollment.json, refresh token included)",
                link.machine_id.as_deref().unwrap_or("?"),
                link.owner_uid.as_deref().unwrap_or("?")
            )
        } else {
            "not linked".into()
        },
    ));

    let runs = state.runs(None, usize::MAX);
    steps.push(step(Action::Keep, "run history", format!("{} in runs.jsonl", count(runs.len(), "run", "runs"))));

    let known: Vec<String> =
        cfg.as_ref().map(|c| c.workspaces.iter().map(|w| w.id.clone()).collect()).unwrap_or_default();
    steps.push(step(
        Action::Keep,
        "session",
        match state.session(&known) {
            Some(s) => format!(
                "{:?} session with {} (session.json){}",
                s.mode,
                s.workspaces.join(", "),
                if s.expired { ", time up" } else { "" }
            ),
            None => "none".into(),
        },
    ));

    let lib: Vec<String> = crate::state::COLLECTIONS
        .iter()
        .map(|c| format!("{} {c}", state.library(c).map(|d| d.len()).unwrap_or(0)))
        .collect();
    steps.push(step(Action::Keep, "library", format!("{} (library/)", lib.join(", "))));

    let seeded = state.seeded_secrets();
    if seeded.iter().any(|s| s == "github_token") {
        steps.push(step(
            Action::Convert,
            "secrets",
            "github_token goes from podman if it's still the token old images baked in (it's revoked: machines sign in to GitHub now); one the machine signed in for stays. seeded-secrets.json stays, for the Python wadd",
        ));
    } else {
        steps.push(step(
            Action::Keep,
            "secrets",
            format!("{} seeded from the image", count(seeded.len(), "secret", "secrets")),
        ));
    }
    Plan { steps, warnings }
}

impl Plan {
    /// For people: one line per step, then warnings.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for s in &self.steps {
            let verb = match s.action {
                Action::Keep => "keep   ",
                Action::Convert => "convert",
                Action::Remove => "remove ",
            };
            out.push_str(&format!("{verb}  {:<15} {}\n", s.what, s.detail));
        }
        for w in &self.warnings {
            out.push_str(&format!("warning  {w}\n"));
        }
        out
    }
}
