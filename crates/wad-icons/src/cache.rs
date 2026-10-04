//! Icons kept on disk, so a design built again (or another design with the
//! same web app) doesn't ask the site again.
//!
//! `<dir>/v1/<sha256 of the key>/` holds `icon.png` (what the image gets) and
//! `meta.json` (when, and whether it was a site icon, a picture or the text
//! card). An icon is good for 30 days; a site that gave nothing is asked again
//! after a day. The folder is kept under a size by dropping the least
//! recently used.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Bumped when the icons' look changes, so old ones are made again.
const VERSION: &str = "v1";
const GOOD_FOR: Duration = Duration::from_secs(30 * 24 * 3600);
const FAILED_FOR: Duration = Duration::from_secs(24 * 3600);
pub const MAX_BYTES: u64 = 50 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// The site's own icon, styled.
    Site,
    /// A picture the user chose.
    Custom,
    /// The text card: the site gave nothing (asked again sooner).
    Fallback,
}

#[derive(Serialize, Deserialize)]
struct Meta {
    key: String,
    kind: Kind,
    /// Seconds since the epoch.
    at: u64,
}

pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    pub fn new(dir: impl Into<PathBuf>) -> Cache {
        Cache { dir: dir.into().join(VERSION) }
    }

    fn entry(&self, key: &str) -> PathBuf {
        let hash = Sha256::digest(key.as_bytes());
        self.dir.join(hash.iter().map(|b| format!("{b:02x}")).collect::<String>())
    }

    /// The icon kept for `key`, unless it's too old.
    pub fn get(&self, key: &str) -> Option<(Vec<u8>, Kind)> {
        let dir = self.entry(key);
        let meta: Meta = serde_json::from_slice(&std::fs::read(dir.join("meta.json")).ok()?).ok()?;
        if meta.key != key {
            return None;
        }
        let ttl = if meta.kind == Kind::Fallback { FAILED_FOR } else { GOOD_FOR };
        if now().saturating_sub(meta.at) > ttl.as_secs() {
            return None;
        }
        let png = std::fs::read(dir.join("icon.png")).ok()?;
        // Its use keeps it: touched, it's the newest for the size limit.
        let _ = std::fs::File::options()
            .append(true)
            .open(dir.join("meta.json"))
            .and_then(|f| f.set_modified(SystemTime::now()));
        Some((png, meta.kind))
    }

    /// Keeps `png` for `key` (written aside, then moved in, so a reader never
    /// sees half an icon).
    pub fn put(&self, key: &str, png: &[u8], kind: Kind) -> std::io::Result<()> {
        let dir = self.entry(key);
        std::fs::create_dir_all(&dir)?;
        let meta = serde_json::to_vec(&Meta { key: key.to_owned(), kind, at: now() }).map_err(std::io::Error::other)?;
        write_atomic(&dir.join("icon.png"), png)?;
        write_atomic(&dir.join("meta.json"), &meta)?;
        self.prune(MAX_BYTES);
        Ok(())
    }

    /// Drops the least recently used icons until the folder is under `max`.
    pub fn prune(&self, max: u64) {
        let Ok(read) = std::fs::read_dir(&self.dir) else { return };
        let mut entries: Vec<(SystemTime, u64, PathBuf)> = read
            .flatten()
            .filter_map(|e| {
                let used = e.path().join("meta.json").metadata().and_then(|m| m.modified()).ok()?;
                let size = std::fs::read_dir(e.path())
                    .ok()?
                    .flatten()
                    .filter_map(|f| f.metadata().ok())
                    .map(|m| m.len())
                    .sum();
                Some((used, size, e.path()))
            })
            .collect();
        let mut total: u64 = entries.iter().map(|e| e.1).sum();
        entries.sort_by_key(|e| e.0);
        for (_, size, path) in entries {
            if total <= max {
                break;
            }
            if std::fs::remove_dir_all(&path).is_ok() {
                total -= size;
            }
        }
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_and_expires() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = Cache::new(tmp.path());
        assert!(cache.get("https://a.example").is_none());
        cache.put("https://a.example", b"png-a", Kind::Site).unwrap();
        assert_eq!(cache.get("https://a.example"), Some((b"png-a".to_vec(), Kind::Site)));
        assert!(cache.get("https://b.example").is_none());

        // A failure from two days ago is asked again; an icon isn't.
        for (key, kind) in [("https://old-fail.example", Kind::Fallback), ("https://old-ok.example", Kind::Site)] {
            cache.put(key, b"x", kind).unwrap();
            let meta = cache.entry(key).join("meta.json");
            let stale = Meta { key: key.into(), kind, at: now() - 2 * 24 * 3600 };
            std::fs::write(meta, serde_json::to_vec(&stale).unwrap()).unwrap();
        }
        assert!(cache.get("https://old-fail.example").is_none());
        assert!(cache.get("https://old-ok.example").is_some());
    }

    #[test]
    fn prunes_least_recently_used() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = Cache::new(tmp.path());
        for k in ["a", "b", "c"] {
            cache.put(k, &[0u8; 1000], Kind::Site).unwrap();
            let old = SystemTime::now()
                - Duration::from_secs(match k {
                    "a" => 300,
                    "b" => 200,
                    _ => 100,
                });
            std::fs::File::options()
                .append(true)
                .open(cache.entry(k).join("meta.json"))
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        assert!(cache.get("a").is_some(), "using a makes it the newest");
        cache.prune(2500);
        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none(), "b was the least recently used");
        assert!(cache.get("c").is_some());
    }
}
