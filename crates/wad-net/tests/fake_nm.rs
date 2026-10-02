//! Joining and forgetting networks against a fake NetworkManager on a private
//! D-Bus (its own dbus-daemon): it knows each network's password, keeps
//! profiles (without their secrets, as the real one shows them), and records
//! what it was sent.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use wad_net::NetworkManager;
use zbus::object_server::ObjectServer;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

type Settings = HashMap<String, HashMap<String, OwnedValue>>;

struct ApDef {
    ssid: &'static str,
    strength: u8,
    flags: u32,
    rsn: u32,
}

#[derive(Default)]
struct World {
    aps: Vec<ApDef>,
    passwords: HashMap<String, String>,
    /// Profile number -> its settings (with the psk, which get_settings hides).
    profiles: BTreeMap<u32, Settings>,
    actives: HashMap<u32, u32>,
    next: u32,
    active_ap: Option<usize>,
    /// What AddAndActivateConnection was sent.
    added: Vec<Settings>,
    last_scan: i64,
}

type W = Arc<Mutex<World>>;

fn path(p: String) -> OwnedObjectPath {
    OwnedObjectPath::try_from(p).unwrap()
}

fn get_str(s: &Settings, a: &str, k: &str) -> Option<String> {
    s.get(a)?.get(k).and_then(|v| String::try_from(v.try_clone().ok()?).ok())
}

fn ssid_of(s: &Settings) -> String {
    let v = s.get("802-11-wireless").and_then(|w| w.get("ssid")).map(|v| v.try_clone().unwrap());
    String::from_utf8(v.map(|v| Vec::<u8>::try_from(v).unwrap()).unwrap_or_default()).unwrap()
}

struct Nm(W);

impl Nm {
    /// Starts an "activation": activated if the password fits, else not.
    async fn activate(&self, settings: &Settings, server: &ObjectServer, ap: &OwnedObjectPath) -> OwnedObjectPath {
        let ssid = ssid_of(settings);
        let psk = get_str(settings, "802-11-wireless-security", "psk");
        let (n, ok) = {
            let mut w = self.0.lock().unwrap();
            let ok = match w.passwords.get(&ssid) {
                Some(p) => psk.as_deref() == Some(p.as_str()),
                None => true,
            };
            w.next += 1;
            let n = w.next;
            w.actives.insert(n, if ok { 2 } else { 4 });
            if ok {
                w.active_ap = ap.as_str().rsplit('/').next().and_then(|i| i.parse().ok());
            }
            (n, ok)
        };
        let _ = ok;
        let p = path(format!("/org/freedesktop/NetworkManager/ActiveConnection/{n}"));
        server.at(p.clone(), Active(self.0.clone(), n)).await.unwrap();
        p
    }
}

#[zbus::interface(name = "org.freedesktop.NetworkManager")]
impl Nm {
    fn get_devices(&self) -> Vec<OwnedObjectPath> {
        vec![path("/org/freedesktop/NetworkManager/Devices/1".into())]
    }

    async fn activate_connection(
        &self,
        connection: OwnedObjectPath,
        _device: OwnedObjectPath,
        specific_object: OwnedObjectPath,
        #[zbus(object_server)] server: &ObjectServer,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        let n: u32 = connection.as_str().rsplit('/').next().unwrap().parse().unwrap();
        let settings = self.0.lock().unwrap().profiles.get(&n).map(|s| {
            s.iter()
                .map(|(k, v)| (k.clone(), v.iter().map(|(a, b)| (a.clone(), b.try_clone().unwrap())).collect()))
                .collect()
        });
        let settings: Settings = settings.ok_or_else(|| zbus::fdo::Error::UnknownObject("no such profile".into()))?;
        Ok(self.activate(&settings, server, &specific_object).await)
    }

    async fn add_and_activate_connection(
        &self,
        connection: Settings,
        _device: OwnedObjectPath,
        specific_object: OwnedObjectPath,
        #[zbus(object_server)] server: &ObjectServer,
    ) -> zbus::fdo::Result<(OwnedObjectPath, OwnedObjectPath)> {
        let n = {
            let mut w = self.0.lock().unwrap();
            w.next += 1;
            let n = w.next;
            let copy: Settings = connection
                .iter()
                .map(|(k, v)| (k.clone(), v.iter().map(|(a, b)| (a.clone(), b.try_clone().unwrap())).collect()))
                .collect();
            w.added.push(copy);
            let copy: Settings = connection
                .iter()
                .map(|(k, v)| (k.clone(), v.iter().map(|(a, b)| (a.clone(), b.try_clone().unwrap())).collect()))
                .collect();
            w.profiles.insert(n, copy);
            n
        };
        let profile = path(format!("/org/freedesktop/NetworkManager/Settings/{n}"));
        server.at(profile.clone(), Profile(self.0.clone(), n)).await.unwrap();
        let active = self.activate(&connection, server, &specific_object).await;
        Ok((profile, active))
    }

    #[zbus(property)]
    fn state(&self) -> u32 {
        if self.0.lock().unwrap().active_ap.is_some() { 70 } else { 20 }
    }
    #[zbus(property)]
    fn connectivity(&self) -> u32 {
        if self.0.lock().unwrap().active_ap.is_some() { 4 } else { 1 }
    }
    #[zbus(property)]
    fn wireless_enabled(&self) -> bool {
        true
    }
}

struct Device(W);

#[zbus::interface(name = "org.freedesktop.NetworkManager.Device")]
impl Device {
    fn disconnect(&self) {
        self.0.lock().unwrap().active_ap = None;
    }
    #[zbus(property)]
    fn device_type(&self) -> u32 {
        2
    }
    #[zbus(property)]
    fn interface(&self) -> String {
        "wlan0".into()
    }
}

struct Wireless(W);

#[zbus::interface(name = "org.freedesktop.NetworkManager.Device.Wireless")]
impl Wireless {
    fn get_all_access_points(&self) -> Vec<OwnedObjectPath> {
        (0..self.0.lock().unwrap().aps.len())
            .map(|i| path(format!("/org/freedesktop/NetworkManager/AccessPoint/{i}")))
            .collect()
    }
    fn request_scan(&self, _options: HashMap<String, OwnedValue>) {
        self.0.lock().unwrap().last_scan += 1;
    }
    #[zbus(property)]
    fn active_access_point(&self) -> OwnedObjectPath {
        match self.0.lock().unwrap().active_ap {
            Some(i) => path(format!("/org/freedesktop/NetworkManager/AccessPoint/{i}")),
            None => path("/".into()),
        }
    }
    #[zbus(property)]
    fn last_scan(&self) -> i64 {
        self.0.lock().unwrap().last_scan
    }
}

struct Ap(W, usize);

#[zbus::interface(name = "org.freedesktop.NetworkManager.AccessPoint")]
impl Ap {
    #[zbus(property)]
    fn ssid(&self) -> Vec<u8> {
        self.0.lock().unwrap().aps[self.1].ssid.as_bytes().to_vec()
    }
    #[zbus(property)]
    fn strength(&self) -> u8 {
        self.0.lock().unwrap().aps[self.1].strength
    }
    #[zbus(property)]
    fn flags(&self) -> u32 {
        self.0.lock().unwrap().aps[self.1].flags
    }
    #[zbus(property)]
    fn wpa_flags(&self) -> u32 {
        0
    }
    #[zbus(property)]
    fn rsn_flags(&self) -> u32 {
        self.0.lock().unwrap().aps[self.1].rsn
    }
}

struct SettingsIface(W);

#[zbus::interface(name = "org.freedesktop.NetworkManager.Settings")]
impl SettingsIface {
    fn list_connections(&self) -> Vec<OwnedObjectPath> {
        self.0
            .lock()
            .unwrap()
            .profiles
            .keys()
            .map(|n| path(format!("/org/freedesktop/NetworkManager/Settings/{n}")))
            .collect()
    }
}

struct Profile(W, u32);

#[zbus::interface(name = "org.freedesktop.NetworkManager.Settings.Connection")]
impl Profile {
    fn get_settings(&self) -> zbus::fdo::Result<Settings> {
        let w = self.0.lock().unwrap();
        let s = w.profiles.get(&self.1).ok_or_else(|| zbus::fdo::Error::UnknownObject("deleted".into()))?;
        // Secrets aren't in GetSettings.
        Ok(s.iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.iter()
                        .filter(|(a, _)| a.as_str() != "psk")
                        .map(|(a, b)| (a.clone(), b.try_clone().unwrap()))
                        .collect(),
                )
            })
            .collect())
    }
    fn delete(&self) {
        self.0.lock().unwrap().profiles.remove(&self.1);
    }
}

struct Active(W, u32);

#[zbus::interface(name = "org.freedesktop.NetworkManager.Connection.Active")]
impl Active {
    #[zbus(property)]
    fn state(&self) -> u32 {
        self.0.lock().unwrap().actives.get(&self.1).copied().unwrap_or(4)
    }
}

struct Bus {
    _d: tempfile::TempDir,
    _daemon: tokio::process::Child,
    _server: zbus::Connection,
    world: W,
    nm: NetworkManager,
}

/// A private bus with the fake NetworkManager on it, and a client.
async fn bus(aps: Vec<ApDef>, passwords: &[(&str, &str)]) -> Bus {
    let d = tempfile::tempdir().unwrap();
    let sock = d.path().join("bus");
    let addr = format!("unix:path={}", sock.display());
    let daemon = tokio::process::Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--address", &addr])
        .kill_on_drop(true)
        .spawn()
        .expect("dbus-daemon");
    for _ in 0..100 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let n = aps.len();
    let world: W = Arc::new(Mutex::new(World {
        aps,
        passwords: passwords.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
        next: 100,
        ..Default::default()
    }));
    let mut b = zbus::connection::Builder::address(addr.as_str())
        .unwrap()
        .name("org.freedesktop.NetworkManager")
        .unwrap()
        .serve_at("/org/freedesktop/NetworkManager", Nm(world.clone()))
        .unwrap()
        .serve_at("/org/freedesktop/NetworkManager/Devices/1", Device(world.clone()))
        .unwrap()
        .serve_at("/org/freedesktop/NetworkManager/Devices/1", Wireless(world.clone()))
        .unwrap()
        .serve_at("/org/freedesktop/NetworkManager/Settings", SettingsIface(world.clone()))
        .unwrap();
    for i in 0..n {
        b = b.serve_at(format!("/org/freedesktop/NetworkManager/AccessPoint/{i}"), Ap(world.clone(), i)).unwrap();
    }
    let server = b.build().await.unwrap();
    let client = zbus::connection::Builder::address(addr.as_str()).unwrap().build().await.unwrap();
    Bus { _d: d, _daemon: daemon, _server: server, world, nm: NetworkManager::on(client) }
}

fn home() -> Vec<ApDef> {
    vec![
        ApDef { ssid: "Home", strength: 40, flags: 1, rsn: 0x188 },
        ApDef { ssid: "Home", strength: 70, flags: 1, rsn: 0x188 },
        ApDef { ssid: "Cafe", strength: 90, flags: 0, rsn: 0 },
        ApDef { ssid: "Uni", strength: 60, flags: 1, rsn: 0x288 },
        ApDef { ssid: "", strength: 80, flags: 1, rsn: 0x188 },
    ]
}

#[tokio::test]
async fn networks_in_range() {
    let b = bus(home(), &[]).await;
    let nets = b.nm.scan(true).await.unwrap();
    let names: Vec<&str> = nets.iter().map(|n| n.ssid.as_str()).collect();
    assert_eq!(names, ["Cafe", "Home", "Uni"]); // by signal; one Home; no hidden one
    let home = &nets[1];
    assert_eq!((home.signal, home.secure, home.supported, home.known), (70, true, true, false));
    assert!(!nets[0].secure && nets[0].supported);
    assert!(!nets[2].supported); // enterprise
    assert!(b.world.lock().unwrap().last_scan > 0); // it asked for a fresh scan
    let st = b.nm.status().await;
    assert_eq!(
        (st.available, st.connectivity.as_str(), st.wifi_device.as_deref(), st.ssid),
        (true, "none", Some("wlan0"), None)
    );
}

#[tokio::test]
async fn joining_with_the_password_over_dbus() {
    let b = bus(home(), &[("Home", "correct horse")]).await;
    b.nm.connect("Home", Some("correct horse")).await.unwrap();
    let st = b.nm.status().await;
    assert_eq!((st.ssid.as_deref(), st.signal, st.connectivity.as_str()), (Some("Home"), Some(70), "full"));
    {
        let w = b.world.lock().unwrap();
        let sent = &w.added[0];
        assert_eq!(get_str(sent, "802-11-wireless-security", "psk").as_deref(), Some("correct horse"));
        assert_eq!(get_str(sent, "802-11-wireless-security", "key-mgmt").as_deref(), Some("wpa-psk"));
        assert_eq!(ssid_of(sent), "Home");
    }
    let nets = b.nm.scan(false).await.unwrap();
    assert!(nets[0].active && nets[0].known && nets[0].ssid == "Home"); // joined first
    // Later: the saved one, without its password again.
    b.nm.disconnect().await.unwrap();
    assert_eq!(b.nm.status().await.ssid, None);
    b.nm.connect("Home", None).await.unwrap();
    assert_eq!(b.nm.status().await.ssid.as_deref(), Some("Home"));
    assert_eq!(b.world.lock().unwrap().profiles.len(), 1);
}

#[tokio::test]
async fn a_wrong_password_leaves_no_profile() {
    let b = bus(home(), &[("Home", "correct horse")]).await;
    let e = b.nm.connect("Home", Some("wrong pass")).await.unwrap_err();
    assert_eq!(e.to_string(), "couldn't join Home (is the password right?)");
    assert!(b.world.lock().unwrap().profiles.is_empty());
    assert_eq!(b.nm.status().await.ssid, None);
}

#[tokio::test]
async fn what_cant_be_joined_says_why() {
    let b = bus(home(), &[("Home", "correct horse")]).await;
    let msg = |e: wad_net::Error| e.to_string();
    assert_eq!(
        msg(b.nm.connect("Uni", Some("whatever1")).await.unwrap_err()),
        "Uni: WPA2 802.1X networks can't be joined here"
    );
    assert_eq!(msg(b.nm.connect("Home", None).await.unwrap_err()), "this network needs its password");
    assert_eq!(msg(b.nm.connect("Home", Some("short")).await.unwrap_err()), "a Wi-Fi password is 8 to 63 characters");
    assert_eq!(msg(b.nm.connect("Elsewhere", None).await.unwrap_err()), "network \"Elsewhere\" isn't in range");
    assert!(b.world.lock().unwrap().added.is_empty()); // nothing reached NetworkManager
    // An open one needs nothing.
    b.nm.connect("Cafe", None).await.unwrap();
    assert!(!b.world.lock().unwrap().added[0].contains_key("802-11-wireless-security"));
}

#[tokio::test]
async fn forgetting_and_a_new_password() {
    let b = bus(home(), &[("Home", "correct horse")]).await;
    b.nm.connect("Home", Some("correct horse")).await.unwrap();
    // A new password replaces the old profile.
    b.nm.connect("Home", Some("correct horse")).await.unwrap();
    assert_eq!(b.world.lock().unwrap().profiles.len(), 1);
    assert!(b.nm.forget("Home").await.unwrap());
    assert!(b.world.lock().unwrap().profiles.is_empty());
    assert!(!b.nm.forget("Home").await.unwrap());
}
