//! Wi-Fi through NetworkManager over D-Bus (network.py, without nmcli).
//!
//! A network is joined with AddAndActivateConnection: the password goes to
//! NetworkManager inside the D-Bus call, so it's never on a command line
//! (other users can read /proc/*/cmdline) or in a file, and NetworkManager
//! keeps it with the profile, which reconnects at boot. A join that fails
//! (a wrong password) deletes the profile it made, so it doesn't sit there
//! retrying. Enterprise (802.1X) and WEP networks can't be joined here.
//!
//! wadd runs as root on a machine, so there are no polkit prompts; on a
//! laptop (`wadd serve --user`) reading works, and changes ask polkit.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

mod proxies;
use proxies::*;

/// NM80211ApFlags / NM80211ApSecurityFlags.
const AP_PRIVACY: u32 = 0x1;
const KEY_MGMT_PSK: u32 = 0x100;
const KEY_MGMT_802_1X: u32 = 0x200;
const KEY_MGMT_SAE: u32 = 0x400;
const KEY_MGMT_OWE: u32 = 0x800 | 0x1000;
const DEVICE_WIFI: u32 = 2;
/// NMActiveConnectionState.
const ACTIVATED: u32 = 2;
const DEACTIVATED: u32 = 4;
const JOIN_TIMEOUT: Duration = Duration::from_secs(60);
/// Properties are read when they're asked for (some are polled).
const NO_CACHE: zbus::proxy::CacheProperties = zbus::proxy::CacheProperties::No;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("NetworkManager: {0}")]
    Bus(#[from] zbus::Error),
    #[error("{0}")]
    Refused(String),
    #[error("this machine has no Wi-Fi")]
    NoWifi,
}

impl From<zbus::fdo::Error> for Error {
    fn from(e: zbus::fdo::Error) -> Self {
        Error::Bus(e.into())
    }
}

/// What a network's security is, as nmcli shows it: "WPA2", "WPA1 WPA2",
/// "WPA3", "WPA2 802.1X", "WEP", "" (open).
pub fn security(flags: u32, wpa: u32, rsn: u32) -> String {
    let mut parts: Vec<&str> = vec![];
    if flags & AP_PRIVACY != 0 && wpa == 0 && rsn == 0 {
        parts.push("WEP");
    }
    if wpa != 0 {
        parts.push("WPA1");
    }
    if rsn & (KEY_MGMT_PSK | KEY_MGMT_802_1X) != 0 {
        parts.push("WPA2");
    }
    if rsn & KEY_MGMT_SAE != 0 {
        parts.push("WPA3");
    }
    if (wpa | rsn) & KEY_MGMT_OWE != 0 {
        parts.push("OWE");
    }
    if (wpa | rsn) & KEY_MGMT_802_1X != 0 {
        parts.push("802.1X");
    }
    parts.join(" ")
}

/// The key management to join with: "" (open), "owe", "wpa-psk" or "sae";
/// None for what this can't join (enterprise, WEP).
pub fn key_mgmt(flags: u32, wpa: u32, rsn: u32) -> Option<&'static str> {
    let both = wpa | rsn;
    if both & KEY_MGMT_802_1X != 0 || (flags & AP_PRIVACY != 0 && both == 0) {
        return None;
    }
    if both & KEY_MGMT_PSK != 0 {
        return Some("wpa-psk");
    }
    if rsn & KEY_MGMT_SAE != 0 {
        return Some("sae");
    }
    if both & KEY_MGMT_OWE != 0 {
        return Some("owe");
    }
    Some("")
}

/// A WPA password: 8 to 63 characters, or 64 hex digits (the key itself).
pub fn valid_psk(p: &str) -> bool {
    (8..=63).contains(&p.chars().count()) || (p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A network in range (the strongest access point of each name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wifi {
    pub ssid: String,
    /// 0..100
    pub signal: u8,
    pub security: String,
    pub secure: bool,
    /// Can be joined here (not enterprise or WEP).
    pub supported: bool,
    pub active: bool,
    /// There's a saved profile for it.
    pub known: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    /// connected, connecting, disconnected, ... (as nmcli says it)
    pub state: String,
    /// full | limited | portal | none | unknown
    pub connectivity: String,
    pub wifi_enabled: bool,
    pub wifi_device: Option<String>,
    pub ssid: Option<String>,
    pub signal: Option<u8>,
}

impl Status {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            state: "unknown".into(),
            connectivity: "unknown".into(),
            wifi_enabled: false,
            wifi_device: None,
            ssid: None,
            signal: None,
        }
    }
}

fn state_name(s: u32) -> &'static str {
    match s {
        10 => "asleep",
        20 => "disconnected",
        30 => "disconnecting",
        40 => "connecting",
        50 => "connected (local only)",
        60 => "connected (site only)",
        70 => "connected",
        _ => "unknown",
    }
}

pub fn connectivity_name(c: u32) -> &'static str {
    match c {
        1 => "none",
        2 => "portal",
        3 => "limited",
        4 => "full",
        _ => "unknown",
    }
}

struct Ap {
    path: OwnedObjectPath,
    ssid: String,
    signal: u8,
    flags: u32,
    wpa: u32,
    rsn: u32,
}

pub struct NetworkManager {
    conn: zbus::Connection,
    /// One change at a time.
    lock: tokio::sync::Mutex<()>,
}

impl NetworkManager {
    /// The system's NetworkManager.
    pub async fn system() -> Result<Self, Error> {
        Ok(Self::on(zbus::Connection::system().await?))
    }

    /// On this bus (tests: a private one).
    pub fn on(conn: zbus::Connection) -> Self {
        Self { conn, lock: tokio::sync::Mutex::new(()) }
    }

    async fn nm(&self) -> Result<NmProxy<'_>, Error> {
        Ok(NmProxy::builder(&self.conn).cache_properties(NO_CACHE).build().await?)
    }

    /// The Wi-Fi device: (its path, its interface name).
    async fn wifi_device(&self) -> Result<Option<(OwnedObjectPath, String)>, Error> {
        for path in self.nm().await?.get_devices().await? {
            let dev = DeviceProxy::builder(&self.conn).path(path.clone())?.cache_properties(NO_CACHE).build().await?;
            if dev.device_type().await? == DEVICE_WIFI {
                return Ok(Some((path, dev.interface().await?)));
            }
        }
        Ok(None)
    }

    /// none | portal | limited | full | unknown ("unknown" without NetworkManager too).
    pub async fn connectivity(&self) -> String {
        match self.nm().await {
            Ok(nm) => connectivity_name(nm.connectivity().await.unwrap_or(0)).into(),
            Err(_) => "unknown".into(),
        }
    }

    pub async fn status(&self) -> Status {
        match self.try_status().await {
            Ok(s) => s,
            Err(e) => {
                tracing::debug!("network status: {e}");
                Status::unavailable()
            }
        }
    }

    async fn try_status(&self) -> Result<Status, Error> {
        let nm = self.nm().await?;
        let mut s = Status {
            available: true,
            state: state_name(nm.state().await?).into(),
            connectivity: connectivity_name(nm.connectivity().await?).into(),
            wifi_enabled: nm.wireless_enabled().await?,
            wifi_device: None,
            ssid: None,
            signal: None,
        };
        if let Some((path, iface)) = self.wifi_device().await? {
            s.wifi_device = Some(iface);
            let w = WirelessProxy::builder(&self.conn).path(path)?.cache_properties(NO_CACHE).build().await?;
            let ap = w.active_access_point().await?;
            if ap.as_str() != "/" {
                let a = self.ap(ap).await?;
                s.ssid = Some(a.ssid);
                s.signal = Some(a.signal);
            }
        }
        Ok(s)
    }

    async fn ap(&self, path: OwnedObjectPath) -> Result<Ap, Error> {
        let p = AccessPointProxy::builder(&self.conn).path(path.clone())?.cache_properties(NO_CACHE).build().await?;
        Ok(Ap {
            ssid: String::from_utf8_lossy(&p.ssid().await?).into_owned(),
            signal: p.strength().await?,
            flags: p.flags().await?,
            wpa: p.wpa_flags().await?,
            rsn: p.rsn_flags().await?,
            path,
        })
    }

    /// The saved Wi-Fi profiles: (their path, their SSID).
    async fn profiles(&self) -> Result<Vec<(OwnedObjectPath, String)>, Error> {
        let settings = SettingsProxy::builder(&self.conn).cache_properties(NO_CACHE).build().await?;
        let mut out = vec![];
        for path in settings.list_connections().await? {
            let c = ConnectionProxy::builder(&self.conn).path(path.clone())?.cache_properties(NO_CACHE).build().await?;
            let Ok(s) = c.get_settings().await else { continue };
            let ssid =
                s.get("802-11-wireless").and_then(|w| w.get("ssid")).and_then(|v| Vec::<u8>::try_from(v.clone()).ok());
            if let Some(ssid) = ssid {
                out.push((path, String::from_utf8_lossy(&ssid).into_owned()));
            }
        }
        Ok(out)
    }

    async fn access_points(&self, rescan: bool) -> Result<(OwnedObjectPath, Vec<Ap>), Error> {
        let (dev, _) = self.wifi_device().await?.ok_or(Error::NoWifi)?;
        let w = WirelessProxy::builder(&self.conn).path(dev.clone())?.cache_properties(NO_CACHE).build().await?;
        if rescan {
            let before = w.last_scan().await.unwrap_or(0);
            // Refused when it scanned a moment ago: the list it has is fresh.
            if w.request_scan(HashMap::new()).await.is_ok() {
                for _ in 0..40 {
                    if w.last_scan().await.unwrap_or(0) != before {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
        let mut aps = vec![];
        for p in w.get_all_access_points().await? {
            if let Ok(a) = self.ap(p).await {
                aps.push(a);
            }
        }
        Ok((dev, aps))
    }

    /// The networks in range, the joined one first, then by signal; one per
    /// name (the strongest); hidden ones left out.
    pub async fn scan(&self, rescan: bool) -> Result<Vec<Wifi>, Error> {
        let (dev, aps) = self.access_points(rescan).await?;
        let w = WirelessProxy::builder(&self.conn).path(dev)?.cache_properties(NO_CACHE).build().await?;
        let active = w.active_access_point().await.ok();
        let known: Vec<String> = self.profiles().await?.into_iter().map(|(_, s)| s).collect();
        let mut best: Vec<Wifi> = vec![];
        for a in aps.iter().filter(|a| !a.ssid.is_empty()) {
            let is_active = active.as_ref() == Some(&a.path);
            let sec = security(a.flags, a.wpa, a.rsn);
            let net = Wifi {
                ssid: a.ssid.clone(),
                signal: a.signal,
                secure: !sec.is_empty() && sec != "OWE",
                supported: key_mgmt(a.flags, a.wpa, a.rsn).is_some(),
                security: sec,
                active: is_active,
                known: known.contains(&a.ssid),
            };
            match best.iter_mut().find(|b| b.ssid == net.ssid) {
                Some(b) if b.signal >= net.signal && !is_active => b.active |= is_active,
                Some(b) => {
                    let was_active = b.active;
                    *b = net;
                    b.active |= was_active;
                }
                None => best.push(net),
            }
        }
        best.sort_by(|a, b| {
            (!a.active, std::cmp::Reverse(a.signal), a.ssid.to_lowercase()).cmp(&(
                !b.active,
                std::cmp::Reverse(b.signal),
                b.ssid.to_lowercase(),
            ))
        });
        Ok(best)
    }

    /// Joins a network: a saved one with its saved password (or a new one), a
    /// new one with `password` (none for an open network).
    pub async fn connect(&self, ssid: &str, password: Option<&str>) -> Result<(), Error> {
        let _one = self.lock.lock().await;
        let password = password.filter(|p| !p.is_empty());
        let (dev, aps) = self.access_points(true).await?;
        let ap = aps
            .iter()
            .filter(|a| a.ssid == ssid)
            .max_by_key(|a| a.signal)
            .ok_or_else(|| Error::Refused(format!("network {ssid:?} isn't in range")))?;
        let Some(mgmt) = key_mgmt(ap.flags, ap.wpa, ap.rsn) else {
            return Err(Error::Refused(format!(
                "{ssid}: {} networks can't be joined here",
                security(ap.flags, ap.wpa, ap.rsn)
            )));
        };
        let needs_password = mgmt == "wpa-psk" || mgmt == "sae";
        let saved: Vec<OwnedObjectPath> =
            self.profiles().await?.into_iter().filter(|(_, s)| s == ssid).map(|(p, _)| p).collect();
        let nm = self.nm().await?;
        if needs_password && password.is_none() {
            let Some(profile) = saved.first() else {
                return Err(Error::Refused("this network needs its password".into()));
            };
            let active = nm.activate_connection(profile, &dev, &ap.path).await?;
            return self.wait_activated(&active, ssid).await;
        }
        if let Some(p) = password
            && needs_password
            && !valid_psk(p)
        {
            return Err(Error::Refused("a Wi-Fi password is 8 to 63 characters".into()));
        }
        // A new password (or an open network): a fresh profile.
        for p in &saved {
            ConnectionProxy::builder(&self.conn)
                .path(p.clone())?
                .cache_properties(NO_CACHE)
                .build()
                .await?
                .delete()
                .await?;
        }
        let mut connection: HashMap<&str, Value> = HashMap::new();
        connection.insert("id", Value::from(ssid));
        connection.insert("type", Value::from("802-11-wireless"));
        connection.insert("autoconnect", Value::from(true));
        let mut wireless: HashMap<&str, Value> = HashMap::new();
        wireless.insert("ssid", Value::from(ssid.as_bytes().to_vec()));
        wireless.insert("mode", Value::from("infrastructure"));
        let mut settings: HashMap<&str, HashMap<&str, Value>> = HashMap::new();
        settings.insert("connection", connection);
        settings.insert("802-11-wireless", wireless);
        if !mgmt.is_empty() {
            let mut sec: HashMap<&str, Value> = HashMap::new();
            sec.insert("key-mgmt", Value::from(mgmt));
            if let Some(p) = password.filter(|_| needs_password) {
                sec.insert("psk", Value::from(p));
                // Kept with the profile (system-owned), so it reconnects at boot.
                sec.insert("psk-flags", Value::from(0u32));
            }
            settings.insert("802-11-wireless-security", sec);
        }
        let (profile, active) = nm.add_and_activate_connection(settings, &dev, &ap.path).await?;
        if let Err(e) = self.wait_activated(&active, ssid).await {
            // Don't leave a profile with a wrong password retrying.
            if let Ok(c) = ConnectionProxy::builder(&self.conn).path(profile)?.cache_properties(NO_CACHE).build().await
            {
                let _ = c.delete().await;
            }
            return Err(e);
        }
        Ok(())
    }

    async fn wait_activated(&self, active: &OwnedObjectPath, ssid: &str) -> Result<(), Error> {
        let a = ActiveProxy::builder(&self.conn).path(active.clone())?.cache_properties(NO_CACHE).build().await?;
        let end = tokio::time::Instant::now() + JOIN_TIMEOUT;
        loop {
            match a.state().await {
                Ok(ACTIVATED) => return Ok(()),
                Ok(DEACTIVATED) | Err(_) => {
                    return Err(Error::Refused(format!("couldn't join {ssid} (is the password right?)")));
                }
                Ok(_) => {}
            }
            if tokio::time::Instant::now() > end {
                return Err(Error::Refused(format!("{ssid} didn't answer within {} s", JOIN_TIMEOUT.as_secs())));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Leaves the Wi-Fi network (the profile stays; it rejoins at boot).
    pub async fn disconnect(&self) -> Result<(), Error> {
        let _one = self.lock.lock().await;
        let (dev, _) = self.wifi_device().await?.ok_or(Error::NoWifi)?;
        DeviceProxy::builder(&self.conn).path(dev)?.cache_properties(NO_CACHE).build().await?.disconnect().await?;
        Ok(())
    }

    /// Forgets a saved network. False if there was none.
    pub async fn forget(&self, ssid: &str) -> Result<bool, Error> {
        let _one = self.lock.lock().await;
        let mut any = false;
        for (p, s) in self.profiles().await? {
            if s == ssid {
                ConnectionProxy::builder(&self.conn)
                    .path(p)?
                    .cache_properties(NO_CACHE)
                    .build()
                    .await?
                    .delete()
                    .await?;
                any = true;
            }
        }
        Ok(any)
    }
}

/// For proxies built from a settings value.
#[allow(dead_code)]
type Settings = HashMap<String, HashMap<String, OwnedValue>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn security_like_nmcli() {
        assert_eq!(security(1, 0, 0x188), "WPA2"); // a home router
        assert_eq!(security(1, 0x148, 0x188), "WPA1 WPA2");
        assert_eq!(security(1, 0, 0x588), "WPA2 WPA3"); // PSK + SAE
        assert_eq!(security(1, 0, 0x408), "WPA3");
        assert_eq!(security(1, 0, 0x288), "WPA2 802.1X");
        assert_eq!(security(1, 0, 0), "WEP");
        assert_eq!(security(0, 0, 0), "");
    }

    #[test]
    fn what_can_be_joined() {
        assert_eq!(key_mgmt(1, 0, 0x188), Some("wpa-psk"));
        assert_eq!(key_mgmt(1, 0, 0x588), Some("wpa-psk")); // PSK and SAE: PSK works for both
        assert_eq!(key_mgmt(1, 0, 0x408), Some("sae"));
        assert_eq!(key_mgmt(0, 0, 0), Some(""));
        assert_eq!(key_mgmt(0, 0, 0x808), Some("owe"));
        assert_eq!(key_mgmt(1, 0, 0x288), None); // enterprise
        assert_eq!(key_mgmt(1, 0, 0), None); // WEP
        assert!(valid_psk("12345678") && valid_psk(&"a".repeat(63)) && valid_psk(&"0f".repeat(32)));
        assert!(!valid_psk("short") && !valid_psk(&"z".repeat(64)));
    }
}

/// Reads the real NetworkManager (status and the networks it last saw;
/// changes nothing): cargo test -p wad-net -- --ignored --nocapture
#[cfg(test)]
mod real {
    #[tokio::test]
    #[ignore]
    async fn reads_the_real_network_manager() {
        let nm = super::NetworkManager::system().await.unwrap();
        let st = nm.status().await;
        eprintln!("{st:?}");
        assert!(st.available && st.wifi_device.is_some());
        let nets = nm.scan(false).await.unwrap();
        for n in nets.iter().take(8) {
            eprintln!(
                "{:>3} {:<10} {:<5} {:<6} {}",
                n.signal,
                n.security,
                if n.active { "*" } else { "" },
                if n.known { "saved" } else { "" },
                n.ssid
            );
        }
        assert!(!nets.is_empty());
        assert_eq!(nets[0].active, st.ssid.is_some());
    }
}
