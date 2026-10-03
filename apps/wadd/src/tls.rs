//! The certificate a machine's streams are served with: self-signed, made
//! here, one per machine (every stream sidecar mounts it). Nothing vouches
//! for it, so the account does: its SHA-256 fingerprint goes in the
//! heartbeat, and the other machines' viewers accept exactly that
//! certificate (pinned). A phone's browser warns once; the fingerprint is in
//! Wad Creator to compare.
//!
//! 397 days at most (what browsers accept for a server certificate), made
//! anew a month before it runs out.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const LIFETIME_DAYS: i64 = 397;
const RENEW_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// SHA-256 of the certificate (DER), lowercase hex.
    pub sha256: String,
    /// Unix seconds.
    pub not_after: i64,
}

pub struct StreamCert {
    pub dir: PathBuf,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn sha256_hex(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02x}")).collect()
}

/// The DER of the first certificate in a PEM file.
pub fn pem_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN CERTIFICATE-----"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END"))
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

impl StreamCert {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn info_file(&self) -> PathBuf {
        self.dir.join("cert.json")
    }

    /// The certificate as it is (None: not made yet, or unreadable).
    pub fn info(&self) -> Option<CertInfo> {
        let info: CertInfo = serde_json::from_slice(&std::fs::read(self.info_file()).ok()?).ok()?;
        // The files must still be the ones described.
        let der = pem_der(&std::fs::read_to_string(self.dir.join("cert.pem")).ok()?)?;
        (sha256_hex(&der) == info.sha256 && self.dir.join("key.pem").exists()).then_some(info)
    }

    /// The certificate, made (or made anew) if it's missing or ending.
    /// `name`: the machine's, for people looking at it.
    pub fn ensure(&self, name: &str) -> Result<CertInfo, String> {
        if let Some(i) = self.info()
            && i.not_after - now() > RENEW_DAYS * 86400
        {
            return Ok(i);
        }
        self.make(name)
    }

    fn make(&self, name: &str) -> Result<CertInfo, String> {
        let err = |e: &dyn std::fmt::Display| format!("the stream certificate: {e}");
        let mut params =
            rcgen::CertificateParams::new(vec![name_for_dns(name), "localhost".into()]).map_err(|e| err(&e))?;
        let mut dn = rcgen::DistinguishedName::new();
        dn.push(rcgen::DnType::CommonName, format!("WadSpaces stream: {name}"));
        dn.push(rcgen::DnType::OrganizationName, "WadSpaces");
        params.distinguished_name = dn;
        let start = SystemTime::now() - Duration::from_secs(86400);
        let end = start + Duration::from_secs(LIFETIME_DAYS as u64 * 86400);
        params.not_before = start.into();
        params.not_after = end.into();
        let key = rcgen::KeyPair::generate().map_err(|e| err(&e))?;
        let cert = params.self_signed(&key).map_err(|e| err(&e))?;
        let info = CertInfo {
            sha256: sha256_hex(cert.der()),
            not_after: end.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0),
        };
        std::fs::create_dir_all(&self.dir).map_err(|e| err(&e))?;
        write(&self.dir.join("key.pem"), key.serialize_pem().as_bytes(), 0o600)?;
        write(&self.dir.join("cert.pem"), cert.pem().as_bytes(), 0o644)?;
        write(&self.info_file(), &serde_json::to_vec_pretty(&info).expect("json"), 0o644)?;
        tracing::info!("made the stream certificate (sha256 {})", info.sha256);
        Ok(info)
    }
}

/// A name a certificate can hold: letters, digits and '-' (the rest become '-').
fn name_for_dns(name: &str) -> String {
    let n: String =
        name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' }).collect();
    if n.trim_matches(['-', '.']).is_empty() { "wadspaces".into() } else { n.to_ascii_lowercase() }
}

fn write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(&tmp)
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// This machine's addresses on local networks (private IPv4), for stream
/// links: not loopback, nor podman's or VPNs' own interfaces.
pub fn lan_addresses() -> Vec<String> {
    const NOT_LAN: [&str; 8] = ["lo", "podman", "veth", "cni", "docker", "virbr", "tailscale", "wg"];
    let Ok(addrs) = nix::ifaddrs::getifaddrs() else { return vec![] };
    let mut out: Vec<String> = addrs
        .filter(|a| !NOT_LAN.iter().any(|p| a.interface_name.starts_with(p)))
        .filter_map(|a| a.address.and_then(|s| s.as_sockaddr_in().map(|v4| v4.ip())))
        .filter(|ip| ip.is_private())
        .map(|ip| ip.to_string())
        .collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn made_once_and_kept() {
        let d = tempfile::tempdir().unwrap();
        let c = StreamCert::new(d.path().join("tls"));
        assert!(c.info().is_none());
        let a = c.ensure("Surface Pro").unwrap();
        assert_eq!(a.sha256.len(), 64);
        assert!(a.not_after - now() > 390 * 86400);
        // The fingerprint is the certificate's.
        let pem = std::fs::read_to_string(d.path().join("tls/cert.pem")).unwrap();
        assert_eq!(sha256_hex(&pem_der(&pem).unwrap()), a.sha256);
        assert_eq!(c.ensure("Surface Pro").unwrap(), a); // kept
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(d.path().join("tls/key.pem")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // Ending soon, or changed under it: made anew.
        let soon = CertInfo { sha256: a.sha256.clone(), not_after: now() + 86400 };
        std::fs::write(d.path().join("tls/cert.json"), serde_json::to_vec(&soon).unwrap()).unwrap();
        let b = c.ensure("Surface Pro").unwrap();
        assert_ne!(b.sha256, a.sha256);
        std::fs::write(d.path().join("tls/cert.pem"), "junk").unwrap();
        assert!(c.info().is_none());
    }

    #[test]
    fn names_for_certificates() {
        assert_eq!(name_for_dns("Surface Pro"), "surface-pro");
        assert_eq!(name_for_dns("  "), "wadspaces");
    }
}
