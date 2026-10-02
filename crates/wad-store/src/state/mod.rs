//! Reading what's in the state directory, as the Python wadd wrote it.

use std::path::{Path, PathBuf};

use serde_json::Value;
use wad_proto::v1::{CloudLink, Project, ProjectSource, Run, Session, SessionMode};

/// JS/Python-ish truthiness for JSON values read from the files.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Fields projects had when they were Syncthing folders: dropped on sight.
const OLD_FIELDS: &[&str] = &["holders", "ignore", "folderId"];
pub const COLLECTIONS: &[&str] = &["wadspaces", "drafts"];

#[derive(Debug, Clone)]
pub struct State {
    pub dir: PathBuf,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `*.json` in a directory, sorted by name (a broken file is skipped, as Python does).
fn json_files(dir: &Path) -> Vec<(String, Value)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut names: Vec<PathBuf> =
        rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    names.sort();
    names.into_iter().filter_map(|p| Some((p.file_stem()?.to_string_lossy().into_owned(), read_json(&p)?))).collect()
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// `os.path.normpath(p) == p` for an absolute path.
fn is_normal_abs(p: &str) -> bool {
    p.starts_with('/')
        && !p.ends_with('/')
        && !p.contains("//")
        && !p.split('/').skip(1).any(|seg| seg == "." || seg == "..")
}

fn text_ok(v: Option<&Value>, most: usize) -> Option<String> {
    match v {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(t)) if t.chars().count() <= most && !t.contains('\n') => Some(t.clone()),
        _ => None,
    }
}

/// A project's source, if it's one wadd knows today (projects.py check_source).
pub fn current_source(src: &Value) -> Option<ProjectSource> {
    match src.get("kind").and_then(Value::as_str)? {
        "git" => {
            let url = src
                .get("url")
                .filter(|u| !u.is_null())
                .map(|u| u.as_str().map(String::from).unwrap_or_else(|| u.to_string()))
                .unwrap_or_default();
            let url = url.trim().trim_end_matches('/').to_string();
            if !wad_core::projects::is_github_url(&url) {
                return None;
            }
            let git_ref = match src.get("ref").filter(|r| truthy(r)) {
                Some(r) => {
                    let r = r.as_str().map(String::from).unwrap_or_else(|| r.to_string());
                    let ok = !r.is_empty()
                        && r.len() <= 200
                        && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
                        && !r.starts_with('-')
                        && !r.contains("..");
                    if !ok {
                        return None;
                    }
                    Some(r)
                }
                None => None,
            };
            Some(ProjectSource::Git { url, git_ref })
        }
        "folder" => {
            let mid = src.get("machineId").and_then(Value::as_str)?;
            let mid_ok = (1..=128).contains(&mid.len())
                && mid.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
            let path = src.get("path").and_then(Value::as_str)?;
            let path_ok = path != "/" && path.len() <= 4000 && is_normal_abs(path) && crate::legacy::host_path_ok(path);
            let name = text_ok(src.get("machineName"), 200)?;
            (mid_ok && path_ok).then(|| ProjectSource::Folder {
                machine_id: mid.into(),
                machine_name: name,
                path: path.into(),
            })
        }
        "drive" => {
            let uuid = src.get("uuid").and_then(Value::as_str)?;
            let uuid_ok = (1..=64).contains(&uuid.len()) && uuid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
            let fstype = text_ok(src.get("fstype"), 32)?;
            let fstype_ok = fstype.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
            let sub_raw = match src.get("subpath") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(t)) => t.clone(),
                _ => return None,
            };
            let parts: Vec<&str> = sub_raw.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
            if parts.contains(&"..") {
                return None;
            }
            let subpath = parts.join("/");
            let sub_ok = crate::legacy::host_path_ok(&subpath) && subpath.len() <= 4000;
            let label = text_ok(src.get("label"), 200)?;
            (uuid_ok && fstype_ok && sub_ok).then(|| ProjectSource::Drive { uuid: uuid.into(), label, fstype, subpath })
        }
        _ => None,
    }
}

/// A stored project document as the API shows it.
pub fn project_of(id: &str, d: &Value) -> Project {
    let source = d.get("source").and_then(current_source);
    let ms = |k: &str| d.get(k).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(0);
    Project {
        id: d.get("id").and_then(Value::as_str).unwrap_or(id).to_string(),
        name: s(d, "name"),
        mount_name: s(d, "mountName"),
        legacy: source.is_none(),
        source,
        setup: s(d, "setup"),
        deleted: d.get("deleted").is_some_and(truthy),
        created_at: ms("createdAt"),
        updated_at: ms("updatedAt"),
        synced: d.get("synced").is_some_and(truthy),
    }
}

impl State {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The account link. The refresh token stays in the file: only whether
    /// there is one counts (linked).
    pub fn cloud(&self) -> CloudLink {
        let e = read_json(&self.dir.join("enrollment.json")).unwrap_or(Value::Null);
        let opt = |k: &str| e.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(String::from);
        CloudLink {
            linked: e.get("refresh_token").is_some_and(truthy) && e.get("machine_id").is_some_and(truthy),
            machine_id: opt("machine_id"),
            owner_uid: opt("owner_uid"),
            project_id: opt("project_id"),
            linked_at: opt("enrolled_at"),
        }
    }

    /// Every project document, tombstones too, by name then id.
    pub fn projects(&self) -> Vec<Project> {
        let mut out: Vec<Project> = json_files(&self.dir.join("projects"))
            .into_iter()
            .filter(|(_, d)| d.is_object())
            .map(|(id, mut d)| {
                if let Value::Object(o) = &mut d {
                    for f in OLD_FIELDS {
                        o.remove(*f);
                    }
                }
                project_of(&id, &d)
            })
            .collect();
        out.sort_by(|a, b| (a.name.to_lowercase(), &a.id).cmp(&(b.name.to_lowercase(), &b.id)));
        out
    }

    /// Runs, newest first (runs.py list): a run whose end was never written
    /// ends when it started (wadd went away mid-run).
    pub fn runs(&self, workspace: Option<&str>, limit: usize) -> Vec<Run> {
        let text = std::fs::read_to_string(self.dir.join("runs.jsonl")).unwrap_or_default();
        let mut order: Vec<String> = Vec::new();
        let mut runs: std::collections::HashMap<String, Run> = std::collections::HashMap::new();
        for line in text.lines() {
            let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
            match rec.get("event").and_then(Value::as_str) {
                Some("start") => {
                    let id = s(&rec, "id");
                    if !runs.contains_key(&id) {
                        order.push(id.clone());
                    }
                    runs.insert(
                        id.clone(),
                        Run {
                            id,
                            wadspace_id: s(&rec, "wadspaceId"),
                            wadspace_name: s(&rec, "wadspaceName"),
                            mode: s(&rec, "mode"),
                            user: s(&rec, "user"),
                            projects: rec
                                .get("projects")
                                .and_then(Value::as_array)
                                .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
                                .unwrap_or_default(),
                            started_at: rec.get("startedAt").and_then(Value::as_f64).unwrap_or(0.0),
                            ended_at: rec.get("endedAt").and_then(Value::as_f64),
                        },
                    );
                }
                Some("end") => {
                    if let Some(r) = runs.get_mut(&s(&rec, "id")) {
                        r.ended_at = rec.get("endedAt").and_then(Value::as_f64);
                    }
                }
                _ => {}
            }
        }
        let mut out: Vec<Run> = order
            .into_iter()
            .filter_map(|id| runs.remove(&id))
            .filter(|r| workspace.is_none_or(|w| r.wadspace_id == w))
            .map(|mut r| {
                r.ended_at = r.ended_at.or(Some(r.started_at));
                r
            })
            .collect();
        out.sort_by(|a, b| b.started_at.total_cmp(&a.started_at));
        out.truncate(limit);
        out
    }

    /// The session in progress (session.json), if any. `known`: the
    /// workspaces there are now; others drop out, and with none left, no session.
    pub fn session(&self, known: &[String]) -> Option<Session> {
        let d = read_json(&self.dir.join("session.json"))?;
        let ids: Vec<String> = d
            .get("workspaces")?
            .as_array()?
            .iter()
            .filter_map(|w| w.as_str().map(String::from))
            .filter(|w| known.contains(w))
            .collect();
        if ids.is_empty() {
            return None;
        }
        let mode = match d.get("mode").and_then(Value::as_str) {
            Some("free") => SessionMode::Free,
            _ => SessionMode::Focus,
        };
        let ends_at = d.get("ends_at").and_then(Value::as_f64);
        let now =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_secs_f64()).unwrap_or(0.0);
        Some(Session {
            mode,
            workspaces: ids,
            minutes: d.get("minutes").and_then(Value::as_u64).map(|m| m as u32),
            started_at: d.get("started_at").and_then(Value::as_f64).unwrap_or(0.0),
            ends_at,
            expired: d.get("expired").is_some_and(truthy) || ends_at.is_some_and(|e| now >= e),
        })
    }

    /// Wad Creator's library: a collection's documents (opaque to wadd).
    pub fn library(&self, collection: &str) -> Option<Vec<Value>> {
        COLLECTIONS
            .contains(&collection)
            .then(|| json_files(&self.dir.join("library").join(collection)).into_iter().map(|(_, d)| d).collect())
    }

    /// What a launch mounted into a workspace (extra/<ws>/projects.json).
    pub fn manifest(&self, ws: &str) -> Option<Value> {
        read_json(&self.dir.join("extra").join(ws).join("projects.json"))
    }

    /// Secrets seeded from the image, by name (seeded-secrets.json).
    pub fn seeded_secrets(&self) -> Vec<String> {
        read_json(&self.dir.join("seeded-secrets.json"))
            .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect()))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests;
