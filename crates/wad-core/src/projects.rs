//! Projects: GitHub repositories, folders on one machine, or drives, mounted
//! at ~/Desktop/<mountName> when a wadspace launches (src/core/projects.ts).
//! The same document lives in wadd's project store and in Firestore.

use serde_json::{Value, json};

use crate::js::{self, Obj};

pub const MAX_NAME: usize = 200;
pub const MAX_SETUP: usize = 4000;

fn mount_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// wadd's MOUNT_RE: `/^[A-Za-z0-9._-]{1,64}$/`.
pub fn is_mount(s: &str) -> bool {
    js::all_in(s, 1, 64, mount_char)
}

/// `/^[A-Za-z0-9_-]{1,64}$/`
pub fn is_project_id(s: &str) -> bool {
    js::all_in(s, 1, 64, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// wadd's and firestore.rules' GITHUB_URL_RE:
/// `/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/`.
pub fn is_github_url(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("https://github.com/") else { return false };
    let Some((owner, repo)) = rest.split_once('/') else { return false };
    !owner.is_empty() && !repo.is_empty() && owner.chars().all(mount_char) && repo.chars().all(mount_char)
}

/// A name GitHub takes for a new repository.
pub fn is_repo_name(s: &str) -> bool {
    js::all_in(s, 1, 100, mount_char)
}

/// `/^[\w./-]{1,200}$/`
fn is_ref(s: &str) -> bool {
    js::all_in(s, 1, 200, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

/// firestore.rules' drive uuid: `/^[A-Za-z0-9-]{4,64}$/`.
pub fn is_drive_uuid(s: &str) -> bool {
    js::all_in(s, 4, 64, |c| c.is_ascii_alphanumeric() || c == '-')
}

/// What's wrong with a project, in wadd's terms (it checks the same again).
pub fn validate_project(p: &Value) -> Vec<String> {
    let mut errs = Vec::new();
    let name = js::trim(js::str_or(p, "name", ""));
    if name.is_empty() {
        errs.push("A project needs a name.".into());
    } else if js::len16(name) > MAX_NAME {
        errs.push(format!("Keep the name under {MAX_NAME} characters."));
    }
    // `MOUNT_RE.test(p.mountName)` tests String(value): a missing one is "undefined".
    let mount = js::field(p, "mountName");
    if !is_mount(&mount) || mount == "." || mount == ".." {
        errs.push("The folder name can use letters, digits, dots, dashes and underscores (64 at most).".into());
    }
    let src = p.get("source").cloned().unwrap_or(Value::Null);
    match src.get("kind").and_then(Value::as_str) {
        Some("git") => {
            if !is_github_url(js::str_or(&src, "url", "")) {
                errs.push("The repository must be https://github.com/<owner>/<repo>.".into());
            }
            if let Some(r) = src.get("ref").filter(|r| js::truthy(r)) {
                let r = js::string(r);
                if !is_ref(&r) || r.starts_with('-') || r.contains("..") {
                    errs.push(format!("\"{r}\" isn't a branch or tag name."));
                }
            }
        }
        Some("folder") => {
            if !src.get("path").and_then(Value::as_str).is_some_and(|p| p.starts_with('/')) {
                errs.push("Pick a folder (a full path).".into());
            }
        }
        Some("drive") => {
            if !is_drive_uuid(js::str_or(&src, "uuid", "")) {
                errs.push("Pick a drive.".into());
            }
            match src.get("subpath").and_then(Value::as_str) {
                Some(s) if !s.starts_with('/') && !s.contains("..") => {}
                _ => errs.push("The folder in the drive must be inside it.".into()),
            }
        }
        _ => errs.push("A project is a GitHub repository, a folder or a drive.".into()),
    }
    let setup = p.get("setup").filter(|s| !s.is_null()).map(js::string).unwrap_or_default();
    if js::len16(&setup) > MAX_SETUP {
        errs.push(format!("Keep the setup command under {MAX_SETUP} characters."));
    }
    errs
}

/// `/\/+$/` → "".
fn trim_trailing_slashes(s: &str) -> &str {
    s.trim_end_matches('/')
}

/// "https://github.com/you/Notes.git" → "Notes".
pub fn repo_name(url: &str) -> String {
    let s = trim_trailing_slashes(js::trim(url));
    let s = s.strip_suffix(".git").unwrap_or(s);
    s.rsplit(['/', ':']).next().unwrap_or("").into()
}

/// A GitHub repository's https URL from any way of writing it, or None.
pub fn github_url(url: &str) -> Option<String> {
    let s = trim_trailing_slashes(js::trim(url));
    let mut u = if let Some(r) = s.strip_prefix("git@github.com:") {
        format!("https://github.com/{r}")
    } else if let Some(r) = s.strip_prefix("ssh://git@github.com") {
        // `(:\d+)?/`: an optional port, then the path.
        let after_port = match r.strip_prefix(':') {
            Some(p) => {
                let digits = p.len() - p.trim_start_matches(|c: char| c.is_ascii_digit()).len();
                (digits > 0).then(|| &p[digits..])
            }
            None => Some(r),
        };
        match after_port.and_then(|x| x.strip_prefix('/')) {
            Some(rest) => format!("https://github.com/{rest}"),
            None => s.to_string(),
        }
    } else {
        s.to_string()
    };
    if let Some(r) = u.strip_prefix("http://") {
        u = format!("https://{r}");
    }
    is_github_url(&u).then_some(u)
}

/// The same repository, however its URL is written.
pub fn same_repo(a: &str, b: &str) -> bool {
    let key = |u: &str| {
        let k = github_url(u).unwrap_or_else(|| js::trim(u).to_string());
        k.strip_suffix(".git").unwrap_or(&k).to_lowercase()
    };
    key(a) == key(b)
}

/// A folder name made from anything.
pub fn to_mount_name(s: &str) -> String {
    let spaced = js::replace_runs(js::trim(s), js::is_space, "-");
    let kept: String = spaced.chars().filter(|&c| mount_char(c)).collect();
    let kept = if !kept.is_empty() && kept.chars().all(|c| c == '.') { String::new() } else { kept };
    let m = js::ascii_prefix(&kept, 64);
    if m.is_empty() { "Project".into() } else { m.into() }
}

/// A folder name for `name` that none of these projects uses yet: Notes, Notes-2, ...
pub fn free_mount_name(projects: &[Value], name: &str) -> String {
    let base = to_mount_name(name);
    let taken = |m: &str| {
        projects.iter().any(|p| {
            !js::truthy(p.get("deleted").unwrap_or(&Value::Null))
                && p.get("mountName").and_then(Value::as_str) == Some(m)
        })
    };
    let mut mount = base.clone();
    let mut n = 2;
    while taken(&mount) {
        mount = format!("{}-{n}", js::ascii_prefix(&base, 60));
        n += 1;
    }
    mount
}

/// "https://github.com/you/Notes.git" → "you/Notes"; the URL itself when it isn't GitHub's.
pub fn repo_full_name(url: &str) -> String {
    let t = js::trim(url);
    let full = (|| {
        let rest = t.strip_prefix("https://github.com/")?;
        let (owner, tail) = rest.split_once('/')?;
        let tail = tail.strip_suffix('/').unwrap_or(tail);
        if owner.is_empty() || tail.is_empty() || tail.contains('/') {
            return None;
        }
        let repo = match tail.strip_suffix(".git") {
            Some(r) if !r.is_empty() => r,
            _ => tail,
        };
        Some(format!("{owner}/{repo}"))
    })();
    full.unwrap_or_else(|| url.to_string())
}

/// A source as the stores take it: trimmed, and nothing it doesn't use.
pub fn clean_source(s: &Value) -> Value {
    match s.get("kind").and_then(Value::as_str) {
        Some("git") => {
            let mut o = Obj::new();
            o.insert("kind".into(), "git".into());
            o.insert("url".into(), js::trim(js::str_or(s, "url", "")).into());
            if let Some(r) = s.get("ref").filter(|r| !r.is_null()).map(js::string) {
                let r = js::trim(&r);
                if !r.is_empty() {
                    o.insert("ref".into(), r.into());
                }
            }
            Value::Object(o)
        }
        Some("folder") => json!({
            "kind": "folder",
            "machineId": js::present(s, "machineId").cloned().unwrap_or("".into()),
            "machineName": js::present(s, "machineName").cloned().unwrap_or("".into()),
            "path": js::trim(js::str_or(s, "path", "")),
        }),
        Some("drive") => {
            let mut o = Obj::new();
            o.insert("kind".into(), "drive".into());
            js::put(&mut o, "uuid", s.get("uuid"));
            o.insert("label".into(), js::present(s, "label").cloned().unwrap_or("".into()));
            o.insert("fstype".into(), js::present(s, "fstype").cloned().unwrap_or("".into()));
            o.insert("subpath".into(), js::str_or(s, "subpath", "").trim_matches('/').into());
            Value::Object(o)
        }
        _ => Value::Null,
    }
}

/// A draft as the stores take it: trimmed, with defaults for what's missing.
pub fn clean_draft(p: &Value) -> Value {
    let mut o = Obj::new();
    if let Some(id) = p.get("id").filter(|i| js::truthy(i)) {
        o.insert("id".into(), id.clone());
    }
    o.insert("name".into(), js::trim(js::str_or(p, "name", "")).into());
    o.insert("mountName".into(), js::trim(js::str_or(p, "mountName", "")).into());
    o.insert("source".into(), clean_source(p.get("source").unwrap_or(&Value::Null)));
    let setup = p.get("setup").filter(|s| !s.is_null()).map(js::string).unwrap_or_default();
    o.insert("setup".into(), js::trim(&setup).into());
    Value::Object(o)
}

/// The last part of a path: "/var/home/wad/Notes" → "Notes".
pub fn base_name(path: &str) -> String {
    trim_trailing_slashes(path).rsplit('/').next().unwrap_or("").into()
}

/// Where a project comes from, in a few words.
pub fn source_label(s: &Value) -> Value {
    match s.get("kind").and_then(Value::as_str) {
        Some("git") => repo_full_name(js::str_or(s, "url", "")).into(),
        Some("folder") => match s.get("machineName").filter(|m| js::truthy(m)) {
            Some(m) => format!("Folder on {}", js::string(m)).into(),
            None => "Folder".into(),
        },
        Some("drive") => {
            let label = s.get("label").filter(|l| js::truthy(l)).or_else(|| s.get("uuid"));
            format!("Drive {}", label.map(js::string).unwrap_or_else(|| "undefined".into())).into()
        }
        _ => Value::Null,
    }
}

/// Where on its machine (or drive): a path, or the drive's folder.
pub fn source_path(s: &Value) -> Value {
    match s.get("kind").and_then(Value::as_str) {
        Some("folder") => s.get("path").cloned().unwrap_or(Value::Null),
        Some("drive") => match s.get("subpath").filter(|x| js::truthy(x)) {
            Some(sp) => format!("/{}", js::string(sp)).into(),
            None => "/".into(),
        },
        _ => Value::Null,
    }
}

/// A project for one of your repositories.
pub fn repo_to_draft(repo: &Value) -> Value {
    let name = repo.get("name").cloned().unwrap_or(Value::Null);
    json!({
        "name": name,
        "mountName": to_mount_name(&js::string(&name)),
        "source": { "kind": "git", "url": repo.get("url").cloned().unwrap_or(Value::Null) },
        "setup": "",
    })
}

/// A stored source the app knows, or None (an old kind, or a broken one).
fn known_source(raw: &Value) -> Option<Value> {
    let st = |k: &str| raw.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match raw.get("kind").and_then(Value::as_str) {
        Some("git") if is_github_url(&st("url")) => {
            let mut o = Obj::new();
            o.insert("kind".into(), "git".into());
            o.insert("url".into(), st("url").into());
            if !st("ref").is_empty() {
                o.insert("ref".into(), st("ref").into());
            }
            Some(Value::Object(o))
        }
        Some("folder") if st("path").starts_with('/') => Some(
            json!({ "kind": "folder", "machineId": st("machineId"), "machineName": st("machineName"), "path": st("path") }),
        ),
        Some("drive") if is_drive_uuid(&st("uuid")) => Some(
            json!({ "kind": "drive", "uuid": st("uuid"), "label": st("label"), "fstype": st("fstype"), "subpath": st("subpath") }),
        ),
        _ => None,
    }
}

/// A stored project as the app shows it. Timestamps are numbers already
/// (epoch ms); anything else counts as 0. One whose source the app doesn't
/// know is kept, marked legacy, as a folder with no path.
pub fn to_project_doc(id: &str, d: &Value) -> Value {
    let source = known_source(d.get("source").unwrap_or(&Value::Null));
    let ms = |k: &str| d.get(k).filter(|v| v.is_number()).cloned().unwrap_or(0.into());
    let mut o = Obj::new();
    o.insert("id".into(), id.into());
    o.insert("name".into(), js::present(d, "name").cloned().unwrap_or(id.into()));
    o.insert("mountName".into(), js::present(d, "mountName").cloned().unwrap_or("".into()));
    let legacy = source.is_none() || d.get("legacy") == Some(&Value::Bool(true));
    o.insert(
        "source".into(),
        source.unwrap_or_else(|| json!({ "kind": "folder", "machineId": "", "machineName": "", "path": "" })),
    );
    o.insert("setup".into(), js::present(d, "setup").cloned().unwrap_or("".into()));
    o.insert("deleted".into(), js::truthy(d.get("deleted").unwrap_or(&Value::Null)).into());
    o.insert("createdAt".into(), ms("createdAt"));
    o.insert("updatedAt".into(), ms("updatedAt"));
    if legacy {
        o.insert("legacy".into(), true.into());
    }
    Value::Object(o)
}

/// Legacy `advanced.repos` as project drafts (migration only).
pub fn repos_to_projects(repos: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut mounts: Vec<String> = Vec::new();
    for r in repos {
        let Some(url) = github_url(js::str_or(r, "url", "")) else { continue };
        if out
            .iter()
            .any(|p| p["source"]["kind"] == "git" && same_repo(p["source"]["url"].as_str().unwrap_or(""), &url))
        {
            continue;
        }
        let dest = js::trim(js::str_or(r, "dest", ""));
        let rn = repo_name(&url);
        let name = if !dest.is_empty() {
            dest.to_string()
        } else if !rn.is_empty() {
            rn
        } else {
            "Project".into()
        };
        let mut mount = to_mount_name(&name);
        let mut n = 2;
        while mounts.contains(&mount) {
            mount = format!("{}-{n}", js::ascii_prefix(&to_mount_name(&name), 60));
            n += 1;
        }
        mounts.push(mount.clone());
        let setup = r
            .get("postClone")
            .filter(|s| !s.is_null())
            .map(|s| js::trim(&js::string(s)).to_string())
            .unwrap_or_default();
        out.push(json!({ "name": name, "mountName": mount, "source": { "kind": "git", "url": url }, "setup": setup }));
    }
    out
}

/// The project that's this repository already, if you added it.
pub fn project_for_repo<'a>(projects: &'a [Value], repo: &Value) -> Option<&'a Value> {
    let url = repo.get("url").filter(|u| js::truthy(u)).map(js::string)?;
    projects.iter().find(|p| {
        !js::truthy(p.get("deleted").unwrap_or(&Value::Null))
            && !js::truthy(p.get("legacy").unwrap_or(&Value::Null))
            && p["source"]["kind"] == "git"
            && same_repo(p["source"]["url"].as_str().unwrap_or(""), &url)
    })
}

/// The existing project a draft stands for: the same repository, else the same folder name.
pub fn find_project<'a>(projects: &'a [Value], d: &Value) -> Option<&'a Value> {
    let live: Vec<&Value> = projects.iter().filter(|p| !js::truthy(p.get("deleted").unwrap_or(&Value::Null))).collect();
    let src = d.get("source").cloned().unwrap_or(Value::Null);
    if src.get("kind").and_then(Value::as_str) == Some("git") {
        let owned: Vec<Value> = live.iter().map(|p| (*p).clone()).collect();
        if let Some(found) = project_for_repo(&owned, &src) {
            let id = found.get("id");
            return live.into_iter().find(|p| p.get("id") == id);
        }
    }
    live.into_iter().find(|p| p.get("mountName") == d.get("mountName"))
}
