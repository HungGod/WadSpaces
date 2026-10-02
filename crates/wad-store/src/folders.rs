//! Folders on the machine, for projects that aren't GitHub repos (drives.py's
//! folder half): anything strictly inside the folder roots (home folders,
//! where drives are mounted), symlinks resolved; and the folder picker.

use std::path::{Component, Path, PathBuf};

use wad_proto::v1::{Browse, Dir};

pub const MAX_DIRS: usize = 500;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FolderError {
    /// Outside the roots (or the drive): 403.
    #[error("{0}")]
    Outside(String),
    #[error("{0} doesn't exist")]
    Missing(String),
}

/// os.path.realpath: symlinks resolved as far as the path exists, the rest
/// taken as written ('.' and '..' handled).
pub fn realpath(p: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => {
                out.push(n);
                if let Ok(real) = std::fs::canonicalize(&out) {
                    out = real;
                }
            }
        }
    }
    out
}

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn inside(path: &Path, root: &Path, strictly: bool) -> bool {
    let root = realpath(root);
    if path == root {
        return !strictly;
    }
    path.starts_with(&root) && path != root
}

/// `path` with symlinks resolved, when it's inside one of the roots (and not
/// a root itself, when `strictly`).
pub fn resolve_folder(path: &str, roots: &[PathBuf], strictly: bool) -> Result<String, FolderError> {
    if !path.starts_with('/') {
        return Err(FolderError::Outside(format!("{path:?} isn't an absolute path")));
    }
    let real = realpath(Path::new(path));
    if !roots.iter().any(|r| inside(&real, r, strictly)) {
        let names: Vec<String> = roots.iter().map(|r| text(r)).collect();
        return Err(FolderError::Outside(format!("{path} isn't inside {}", names.join(", "))));
    }
    Ok(text(&real))
}

/// A path inside a drive, relative to its root ("" is the root): no '..', no
/// doubled or outer slashes.
pub fn clean_subpath(subpath: &str) -> Result<String, FolderError> {
    let parts: Vec<&str> = subpath.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.contains(&"..") {
        return Err(FolderError::Outside(format!("subpath {subpath:?} must stay inside the drive (no '..')")));
    }
    Ok(parts.join("/"))
}

/// The folders in `path` (not hidden ones), sorted; at most `most`. With
/// `rel_to`, paths relative to it.
fn dirs(path: &Path, rel_to: Option<&Path>, most: usize) -> (Vec<Dir>, bool) {
    let mut out = vec![];
    for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // is_dir follows symlinks, as Python's DirEntry.is_dir does.
        if name.starts_with('.') || !e.path().is_dir() {
            continue;
        }
        let full = path.join(&name);
        let shown = match rel_to {
            Some(r) => text(full.strip_prefix(r).unwrap_or(&full)),
            None => text(&full),
        };
        out.push(Dir { name, path: shown });
    }
    out.sort_by(|a, b| (a.name.to_lowercase(), &a.name).cmp(&(b.name.to_lowercase(), &b.name)));
    let more = out.len() > most;
    out.truncate(most);
    (out, more)
}

/// The folders in `path`, which must be one of the roots or inside one. No
/// path: the roots there are.
pub fn browse(path: Option<&str>, roots: &[PathBuf], most: usize) -> Result<Browse, FolderError> {
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        let dirs = roots.iter().filter(|r| r.is_dir()).map(|r| Dir { name: text(r), path: text(r) }).collect();
        return Ok(Browse { path: None, parent: None, dirs, truncated: false });
    };
    let real = PathBuf::from(resolve_folder(path, roots, false)?);
    if !real.is_dir() {
        return Err(FolderError::Missing(path.into()));
    }
    let (dirs, truncated) = dirs(&real, None, most);
    let is_root = roots.iter().any(|r| realpath(r) == real);
    let parent = (!is_root).then(|| real.parent().map(text)).flatten();
    Ok(Browse { path: Some(text(&real)), parent, dirs, truncated })
}

/// browse() inside a drive: paths relative to its root ("" is the root).
pub fn browse_inside(mountpoint: &str, subpath: &str, most: usize) -> Result<Browse, FolderError> {
    let sub = clean_subpath(subpath)?;
    let root = realpath(Path::new(mountpoint));
    let real = if sub.is_empty() { root.clone() } else { realpath(&root.join(&sub)) };
    if real != root && !real.starts_with(&root) {
        return Err(FolderError::Outside(format!("{subpath} is outside the drive")));
    }
    if !real.is_dir() {
        return Err(FolderError::Missing(subpath.into()));
    }
    let (dirs, truncated) = dirs(&real, Some(&root), most);
    let rel = text(real.strip_prefix(&root).unwrap_or(Path::new("")));
    let parent = (!rel.is_empty()).then(|| Path::new(&rel).parent().map(text).unwrap_or_default());
    Ok(Browse { path: Some(rel), parent, dirs, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Roots {
        _d: tempfile::TempDir,
        tmp: PathBuf,
        home: PathBuf,
        roots: Vec<PathBuf>,
    }

    fn roots() -> Roots {
        let d = tempfile::tempdir().unwrap();
        let tmp = realpath(d.path());
        let (home, media) = (tmp.join("home"), tmp.join("media"));
        for x in ["wad/Notes/drafts", "wad/Notes/.git", "wad/Code", "wad/.cache", "other"] {
            std::fs::create_dir_all(home.join(x)).unwrap();
        }
        std::fs::write(home.join("wad/file.txt"), "x").unwrap();
        std::fs::create_dir(&media).unwrap();
        std::os::unix::fs::symlink(&tmp, home.join("wad/escape")).unwrap();
        let roots = vec![home.clone(), media, tmp.join("absent")];
        Roots { _d: d, tmp, home, roots }
    }

    #[test]
    fn folders_must_be_inside_a_root() {
        let r = roots();
        let h = text(&r.home);
        assert_eq!(resolve_folder(&format!("{h}/wad/Notes"), &r.roots, true), Ok(format!("{h}/wad/Notes")));
        assert_eq!(resolve_folder(&format!("{h}/wad/../wad/Notes"), &r.roots, true), Ok(format!("{h}/wad/Notes")));
        assert!(resolve_folder(&h, &r.roots, true).is_err()); // a root itself
        assert_eq!(resolve_folder(&h, &r.roots, false), Ok(h.clone()));
        for bad in
            ["/etc".to_string(), format!("{h}/wad/escape"), format!("{h}/../"), "relative".into(), format!("{h}x/y")]
        {
            assert!(matches!(resolve_folder(&bad, &r.roots, true), Err(FolderError::Outside(_))), "{bad}");
        }
    }

    #[test]
    fn browsing() {
        let r = roots();
        let h = text(&r.home);
        let top = browse(None, &r.roots, MAX_DIRS).unwrap();
        let names: Vec<&str> = top.dirs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(names, [text(&r.roots[0]), text(&r.roots[1])]); // not the absent one
        let b = browse(Some(&format!("{h}/wad")), &r.roots, MAX_DIRS).unwrap();
        // Folders only, no hidden ones, sorted; the symlink out is listed but can't be opened.
        let names: Vec<&str> = b.dirs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["Code", "escape", "Notes"]);
        assert_eq!(b.dirs[2].path, format!("{h}/wad/Notes"));
        assert_eq!(
            (b.path.as_deref(), b.parent.as_deref(), b.truncated),
            (Some(&*format!("{h}/wad")), Some(&*h), false)
        );
        assert_eq!(browse(Some(&h), &r.roots, MAX_DIRS).unwrap().parent, None);
        assert!(matches!(browse(Some(&format!("{h}/wad/escape")), &r.roots, MAX_DIRS), Err(FolderError::Outside(_))));
        assert!(matches!(browse(Some(&format!("{h}/wad/nope")), &r.roots, MAX_DIRS), Err(FolderError::Missing(_))));
        let few = browse(Some(&format!("{h}/wad")), &r.roots, 2).unwrap();
        assert_eq!((few.dirs.len(), few.truncated), (2, true));
        let _ = &r.tmp;
    }

    #[test]
    fn browsing_a_drive() {
        let d = tempfile::tempdir().unwrap();
        let drive = d.path().join("drive");
        std::fs::create_dir_all(drive.join("Books/Novel")).unwrap();
        std::fs::create_dir_all(drive.join("Music")).unwrap();
        let drive = text(&drive);
        let b = browse_inside(&drive, "", MAX_DIRS).unwrap();
        assert_eq!((b.path.as_deref(), b.parent.as_deref()), (Some(""), None));
        assert_eq!(
            b.dirs,
            [Dir { name: "Books".into(), path: "Books".into() }, Dir { name: "Music".into(), path: "Music".into() }]
        );
        let b = browse_inside(&drive, "/Books/", MAX_DIRS).unwrap();
        assert_eq!((b.path.as_deref(), b.parent.as_deref()), (Some("Books"), Some("")));
        assert_eq!(b.dirs, [Dir { name: "Novel".into(), path: "Books/Novel".into() }]);
        assert_eq!(browse_inside(&drive, "Books/Novel", MAX_DIRS).unwrap().parent.as_deref(), Some("Books"));
        assert!(browse_inside(&drive, "../..", MAX_DIRS).is_err());
        assert_eq!(clean_subpath("a//b/./c/"), Ok("a/b/c".into()));
        assert_eq!(clean_subpath(""), Ok(String::new()));
    }
}
