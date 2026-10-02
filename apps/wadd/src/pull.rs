//! Download progress for image pulls (the Python wadd's registry.py).
//!
//! Podman's pull API can't drive a progress bar: it prints "Copying blob"
//! for every layer when the parallel downloads *start*, then nothing until
//! the pull ends. So wadd measures it itself:
//!
//! - total = the sizes of the image's layers, from the registry's manifest,
//!   minus layers podman already has (overlay-layers/layers.json records each
//!   local layer's compressed digest, which matches the manifest's)
//! - done = bytes received on the machine's real network interfaces since the
//!   pull started (/sys/class/net/*/statistics/rx_bytes)
//!
//! "done" counts other traffic too, so it's capped below 100% until podman
//! says the pull finished. Any failure here only loses the bar, never the pull.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use serde_json::Value;
use wad_proto::v1::Download;

const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, \
     application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";
const INDEX_TYPES: &[&str] =
    &["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
/// "done" includes other traffic: never claim 100% early.
const DONE_CAP: f64 = 0.99;
/// The first seconds' rate means little: no estimate before 2%.
const ETA_AFTER: f64 = 0.02;
/// Bytes stopped arriving near the end: podman is unpacking.
const UNPACK_IDLE_S: f64 = 3.0;

/// "ghcr.io/o/n:tag" → ("ghcr.io", "o/n", "tag"); Docker Hub short names too.
pub fn parse_ref(r: &str) -> (String, String, String) {
    let (mut name, mut reference) = (r.to_string(), "latest".to_string());
    if let Some((n, d)) = r.split_once('@') {
        name = n.into();
        reference = d.into();
    } else {
        let last = name.rsplit('/').next().unwrap_or("").to_string();
        if let Some((_, tag)) = last.rsplit_once(':') {
            reference = tag.into();
            name = name[..name.len() - tag.len() - 1].into();
        }
    }
    let first = name.split('/').next().unwrap_or("");
    let (registry, mut repo) =
        if name.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost") {
            let (reg, rest) = name.split_once('/').unwrap();
            (reg.to_string(), rest.to_string())
        } else {
            ("docker.io".to_string(), name.clone())
        };
    if registry == "docker.io" && !repo.contains('/') {
        repo = format!("library/{repo}");
    }
    (registry, repo, reference)
}

/// `Bearer realm="...",service="...",scope="..."` → its parameters.
pub fn parse_challenge(header: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = header;
    while let Some(eq) = rest.find("=\"") {
        let key_start = rest[..eq].rfind(|c: char| !(c.is_alphanumeric() || c == '_')).map_or(0, |i| i + 1);
        let key = rest[key_start..eq].to_lowercase();
        let after = &rest[eq + 2..];
        let Some(end) = after.find('"') else { break };
        if !key.is_empty() {
            out.insert(key, after[..end].to_string());
        }
        rest = &after[end + 1..];
    }
    out
}

/// Where podman and docker keep registry logins.
pub fn auth_files() -> Vec<String> {
    let uid = nix::unistd::getuid().as_raw();
    let home = std::env::var("HOME").unwrap_or_default();
    [
        std::env::var("REGISTRY_AUTH_FILE").unwrap_or_default(),
        format!("/run/containers/{uid}/auth.json"),
        format!("/run/user/{uid}/containers/auth.json"),
        format!("{home}/.config/containers/auth.json"),
        format!("{home}/.docker/config.json"),
    ]
    .into_iter()
    .filter(|p| !p.is_empty())
    .collect()
}

/// A saved login for a registry: (user, password).
pub fn registry_credentials(registry: &str, files: &[String]) -> Option<(String, String)> {
    for path in files {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let auths = v.get("auths")?;
        let hub = if registry == "docker.io" { "https://index.docker.io/v1/" } else { "" };
        for key in [registry.to_string(), format!("https://{registry}"), hub.to_string()] {
            if key.is_empty() {
                continue;
            }
            if let Some(auth) = auths.get(&key).and_then(|e| e.get("auth")).and_then(Value::as_str)
                && let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(auth)
            {
                let s = String::from_utf8_lossy(&raw);
                let (u, p) = s.split_once(':').unwrap_or((&s, ""));
                return Some((u.to_string(), p.to_string()));
            }
        }
    }
    None
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// {blob digest: compressed size} for an image's layers, or None. `base`
/// overrides the registry's https://<host> (tests).
pub async fn fetch_layer_sizes(
    http: &reqwest::Client,
    image: &str,
    auth_files: &[String],
    base: Option<&str>,
) -> Option<HashMap<String, u64>> {
    let (registry, repo, reference) = parse_ref(image);
    let host = if registry == "docker.io" { "registry-1.docker.io".to_string() } else { registry.clone() };
    let root = format!("{}/v2/{repo}", base.map(String::from).unwrap_or_else(|| format!("https://{host}")));
    let mut bearer: Option<String> = None;

    let mut get = async |url: String| -> Option<Value> {
        let send = |bearer: &Option<String>| {
            let mut req = http.get(&url).header("accept", MANIFEST_TYPES).timeout(Duration::from_secs(10));
            if let Some(b) = bearer {
                req = req.bearer_auth(b);
            }
            req.send()
        };
        let mut res = send(&bearer).await.ok()?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED && bearer.is_none() {
            let ch = parse_challenge(res.headers().get("www-authenticate").and_then(|h| h.to_str().ok()).unwrap_or(""));
            let realm = ch.get("realm")?;
            let mut params: Vec<(String, String)> =
                ["service", "scope"].iter().filter_map(|k| ch.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
            if !params.iter().any(|(k, _)| k == "scope") {
                params.push(("scope".into(), format!("repository:{repo}:pull")));
            }
            let mut treq = http.get(realm).query(&params).timeout(Duration::from_secs(10));
            if let Some((u, p)) = registry_credentials(&registry, auth_files) {
                treq = treq.basic_auth(u, Some(p));
            }
            let t: Value = treq.send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
            bearer = t.get("token").or_else(|| t.get("access_token")).and_then(Value::as_str).map(String::from);
            res = send(&bearer).await.ok()?;
        }
        res.error_for_status().ok()?.json::<Value>().await.ok()
    };

    let mut manifest = get(format!("{root}/manifests/{reference}")).await?;
    let is_index = manifest.get("mediaType").and_then(Value::as_str).is_some_and(|m| INDEX_TYPES.contains(&m))
        || manifest.get("manifests").is_some();
    if is_index {
        let pick = manifest.get("manifests")?.as_array()?.iter().find(|m| {
            m.pointer("/platform/architecture").and_then(Value::as_str) == Some(arch())
                && m.pointer("/platform/os").and_then(Value::as_str).unwrap_or("linux") == "linux"
        })?;
        let digest = pick.get("digest")?.as_str()?.to_string();
        manifest = get(format!("{root}/manifests/{digest}")).await?;
    }
    manifest
        .get("layers")?
        .as_array()?
        .iter()
        .map(|l| Some((l.get("digest")?.as_str()?.to_string(), l.get("size")?.as_u64()?)))
        .collect()
}

/// Compressed digests of the layers podman already has.
pub fn local_blob_digests(graph_root: &Path) -> HashSet<String> {
    let Ok(text) = std::fs::read_to_string(graph_root.join("overlay-layers/layers.json")) else {
        return HashSet::new();
    };
    serde_json::from_str::<Vec<Value>>(&text)
        .unwrap_or_default()
        .iter()
        .filter_map(|l| l.get("compressed-diff-digest").and_then(Value::as_str).map(String::from))
        .collect()
}

/// Interfaces whose traffic isn't the pull (or counts it twice).
fn virtual_interface(name: &str) -> bool {
    ["lo", "veth", "podman", "cni", "virbr", "docker", "br-", "tun", "tap", "wg", "vnet"]
        .iter()
        .any(|p| name.starts_with(p))
}

/// Bytes received on the real interfaces.
pub fn rx_bytes(net_dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(net_dir) else { return 0 };
    rd.filter_map(|e| e.ok())
        .filter(|e| !virtual_interface(&e.file_name().to_string_lossy()))
        .filter_map(|e| std::fs::read_to_string(e.path().join("statistics/rx_bytes")).ok()?.trim().parse::<u64>().ok())
        .sum()
}

/// Turns counter samples into what the UI shows. Pure: feed it numbers.
#[derive(Debug, Clone)]
pub struct Progress {
    /// Still to download; None: sizes unknown.
    pub total_bytes: Option<u64>,
    pub layers: u32,
    pub rx_start: u64,
    pub done_bytes: u64,
    /// This pull's share of the received bytes so far.
    pub received: u64,
    pub rate_bps: f64,
    pub unpacking: bool,
    last: Option<(f64, u64)>,
    moved_at: Option<f64>,
}

impl Progress {
    pub fn new(total_bytes: Option<u64>, layers: u32, rx_start: u64) -> Self {
        Self {
            total_bytes,
            layers,
            rx_start,
            done_bytes: 0,
            received: 0,
            rate_bps: 0.0,
            unpacking: false,
            last: None,
            moved_at: None,
        }
    }

    /// The counter read `rx` at `now` (seconds, any monotonic origin).
    pub fn sample(&mut self, rx: u64, now: f64) {
        let mut got = rx.saturating_sub(self.rx_start);
        if let Some(total) = self.total_bytes {
            got = got.min((total as f64 * DONE_CAP) as u64);
        }
        if let Some((t, b)) = self.last {
            let dt = now - t;
            if dt > 0.0 {
                let inst = got.saturating_sub(b) as f64 / dt;
                // ~10 s smoothing at one sample a second
                self.rate_bps = if self.rate_bps == 0.0 { inst } else { 0.9 * self.rate_bps + 0.1 * inst };
            }
        }
        if self.last.is_none_or(|(_, b)| got > b) {
            self.moved_at = Some(now);
        }
        self.last = Some((now, got));
        self.done_bytes = got;
        // Downloads done, layers being unpacked: rate and ETA stop meaning much.
        let near_end = self.total_bytes.is_some_and(|t| got as f64 >= 0.9 * t as f64);
        self.unpacking = near_end && self.moved_at.is_some_and(|m| now - m >= UNPACK_IDLE_S);
    }

    pub fn percent(&self) -> Option<u8> {
        let total = self.total_bytes.filter(|t| *t > 0)?;
        Some((100 * self.done_bytes / total).min(100) as u8)
    }

    pub fn eta_s(&self) -> Option<u64> {
        let total = self.total_bytes.filter(|t| *t > 0)?;
        if self.rate_bps < 1.0 || self.unpacking || (self.done_bytes as f64) < ETA_AFTER * total as f64 {
            return None;
        }
        Some(((total - self.done_bytes) as f64 / self.rate_bps) as u64)
    }

    pub fn finish(&mut self) {
        if let Some(t) = self.total_bytes {
            self.done_bytes = t;
        }
    }

    pub fn download(&self) -> Download {
        Download {
            total_bytes: self.total_bytes,
            done_bytes: self.done_bytes,
            layers: self.layers,
            rate_bps: if self.unpacking { 0 } else { self.rate_bps as u64 },
            eta_s: self.eta_s(),
            unpacking: self.unpacking,
        }
    }

    /// "1.9 GB of 5.3 GB · 12.0 MB/s · about 4 min left"
    pub fn describe(&self) -> String {
        let Some(total) = self.total_bytes else {
            return if self.layers > 0 { format!("downloading {} layers", self.layers) } else { "downloading".into() };
        };
        if total == 0 {
            return "already downloaded, unpacking".into();
        }
        if self.unpacking {
            return format!("downloaded {}, unpacking", human_bytes(self.done_bytes as f64));
        }
        let mut bits = vec![format!("{} of {}", human_bytes(self.done_bytes as f64), human_bytes(total as f64))];
        if self.rate_bps >= 1000.0 && self.done_bytes as f64 >= ETA_AFTER * total as f64 {
            bits.push(format!("{}/s", human_bytes(self.rate_bps)));
        }
        if let Some(eta) = self.eta_s() {
            bits.push(if eta >= 90 {
                format!("about {} min left", eta / 60)
            } else {
                format!("about {} s left", eta.max(1))
            });
        }
        bits.join(" · ")
    }
}

pub fn human_bytes(mut n: f64) -> String {
    for unit in ["B", "KB", "MB", "GB"] {
        if n < 1000.0 || unit == "GB" {
            return if matches!(unit, "B" | "KB") { format!("{n:.0} {unit}") } else { format!("{n:.1} {unit}") };
        }
        n /= 1000.0;
    }
    format!("{n:.1} GB")
}

#[cfg(test)]
mod tests;
