//! What the HUD shows, worked out from wadd's events (pure, so it's tested
//! without a screen): `session`, `network` and `carousel` (wad_proto's v1
//! types, read leniently).

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default = "focus")]
    pub mode: String,
    #[serde(default)]
    pub minutes: Option<f64>,
    /// When the focus time ends (Unix seconds); None until it starts.
    #[serde(default)]
    pub ends_at: Option<f64>,
    #[serde(default)]
    pub expired: bool,
}

fn focus() -> String {
    "focus".into()
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Network {
    #[serde(default = "yes")]
    pub available: bool,
    #[serde(default)]
    pub connectivity: Option<String>,
    #[serde(default)]
    pub ssid: Option<String>,
}

fn yes() -> bool {
    true
}

/// What the HUD keeps of wadd's state (its `session` and `network` events).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct State {
    #[serde(default)]
    pub session: Option<Session>,
    #[serde(default)]
    pub network: Option<Network>,
}

/// A focus session whose time isn't up: the buttons give way to the timer.
pub fn locked(s: Option<&Session>) -> bool {
    s.is_some_and(|s| s.mode == "focus" && !s.expired)
}

fn minutes_text(m: f64) -> String {
    let m = m.max(0.0) as u64;
    let (h, mm) = (m / 60, m % 60);
    match (h, mm) {
        (0, mm) => format!("{mm} min"),
        (h, 0) => format!("{h} h"),
        (h, mm) => format!("{h} h {mm} min"),
    }
}

/// How long a focus session has left, in words.
pub fn focus_left(s: &Session, now: f64) -> String {
    let Some(ends) = s.ends_at else {
        return format!("{} of focus, starting when you open it", minutes_text(s.minutes.unwrap_or(0.0)));
    };
    let left = (ends - now).max(0.0) as u64;
    if left >= 3600 {
        format!("{} h {} min of focus left", left / 3600, left % 3600 / 60)
    } else if left >= 60 {
        format!("{} min of focus left", left.div_ceil(60))
    } else {
        format!("{left} s of focus left")
    }
}

/// The Wi-Fi button: the network's name, "Wired", or why there's none.
/// None: hide it (no Wi-Fi manager on this machine).
pub fn network_label(n: Option<&Network>) -> Option<(String, bool)> {
    let Some(n) = n else { return Some(("Wi-Fi".into(), true)) };
    if !n.available {
        return None;
    }
    let online = n.connectivity.as_deref() == Some("full");
    let label = match &n.ssid {
        Some(s) if !s.is_empty() => s.clone(),
        _ if online => "Wired".into(),
        _ => "Not connected".into(),
    };
    Some((label, online))
}

/// One switcher entry (wadd's `carousel` event).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct CarouselItem {
    /// "home" (WadSpaces Client), or the workspace's id.
    #[serde(deserialize_with = "view")]
    pub view: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default = "yes")]
    pub running: bool,
}

/// wadd's View: `{"kind":"home"}` or `{"kind":"workspace","id":...}`.
fn view<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    struct V {
        kind: String,
        #[serde(default)]
        id: Option<String>,
    }
    let v = V::deserialize(d)?;
    Ok(if v.kind == "home" { "home".into() } else { v.id.unwrap_or_default() })
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Carousel {
    #[serde(default)]
    pub open: bool,
    #[serde(default)]
    pub items: Vec<CarouselItem>,
    #[serde(default)]
    pub index: usize,
}

/// A network in range (GET /v1/network/wifi).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct WifiNetwork {
    pub ssid: String,
    #[serde(default)]
    pub signal: u8,
    #[serde(default)]
    pub security: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default = "yes")]
    pub supported: bool,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub known: bool,
}

/// The screen's backlight (GET/PUT /v1/screen/brightness).
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq)]
pub struct Brightness {
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub percent: u8,
}

/// What picking a network does.
#[derive(Debug, PartialEq)]
pub enum Pick {
    Nothing,
    Refuse(String),
    AskPassword,
    Join,
}

pub fn pick(n: &WifiNetwork) -> Pick {
    if n.active {
        Pick::Nothing
    } else if !n.supported {
        Pick::Refuse(format!("{} uses {}, which this machine can't join yet.", n.ssid, n.security))
    } else if n.secure && !n.known {
        Pick::AskPassword
    } else {
        Pick::Join
    }
}

/// A failed join, in words.
pub fn join_error(message: &str) -> String {
    let m = message.to_lowercase();
    if m.contains("secrets were required") || m.contains("802-1x") || m.contains("psk") {
        "Wrong password, or the network refused it.".into()
    } else {
        message.to_string()
    }
}

/// Signal as bars, for a label.
pub fn bars(signal: u8) -> &'static str {
    match signal {
        75.. => "▂▄▆█",
        50..=74 => "▂▄▆",
        25..=49 => "▂▄",
        _ => "▂",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn focus_session(minutes: f64, ends_at: Option<f64>, expired: bool) -> Session {
        Session { mode: "focus".into(), minutes: Some(minutes), ends_at, expired }
    }

    #[test]
    fn focus_time_in_words() {
        assert_eq!(focus_left(&focus_session(25.0, None, false), 0.0), "25 min of focus, starting when you open it");
        assert_eq!(
            focus_left(&focus_session(90.0, None, false), 0.0),
            "1 h 30 min of focus, starting when you open it"
        );
        assert_eq!(focus_left(&focus_session(25.0, Some(1000.0 + 1500.0), false), 1000.0), "25 min of focus left");
        assert_eq!(focus_left(&focus_session(25.0, Some(1000.0 + 61.0), false), 1000.0), "2 min of focus left");
        assert_eq!(focus_left(&focus_session(25.0, Some(1000.0 + 5.0), false), 1000.0), "5 s of focus left");
        assert_eq!(focus_left(&focus_session(25.0, Some(1000.0 + 3725.0), false), 1000.0), "1 h 2 min of focus left");
    }

    #[test]
    fn only_running_focus_locks() {
        assert!(locked(Some(&focus_session(25.0, None, false))));
        assert!(!locked(Some(&focus_session(25.0, None, true))));
        assert!(!locked(Some(&Session { mode: "free".into(), ..Default::default() })));
        assert!(!locked(None));
    }

    #[test]
    fn the_wifi_button() {
        assert_eq!(network_label(None), Some(("Wi-Fi".into(), true)));
        let n = |c: &str, ssid: Option<&str>| Network {
            available: true,
            connectivity: Some(c.into()),
            ssid: ssid.map(String::from),
        };
        assert_eq!(network_label(Some(&n("full", Some("Home")))), Some(("Home".into(), true)));
        assert_eq!(network_label(Some(&n("full", None))), Some(("Wired".into(), true)));
        assert_eq!(network_label(Some(&n("none", None))), Some(("Not connected".into(), false)));
        assert_eq!(network_label(Some(&Network { available: false, ..Default::default() })), None);
    }

    #[test]
    fn picking_a_network() {
        let net = |secure, known, supported, active| WifiNetwork {
            ssid: "X".into(),
            signal: 50,
            security: "WPA2 802.1X".into(),
            secure,
            supported,
            active,
            known,
        };
        assert_eq!(pick(&net(true, false, true, false)), Pick::AskPassword);
        assert_eq!(pick(&net(true, true, true, false)), Pick::Join);
        assert_eq!(pick(&net(false, false, true, false)), Pick::Join);
        assert_eq!(pick(&net(true, false, true, true)), Pick::Nothing);
        assert!(matches!(pick(&net(true, false, false, false)), Pick::Refuse(m) if m.contains("802.1X")));
        assert_eq!(join_error("Secrets were required, but not provided"), "Wrong password, or the network refused it.");
        assert_eq!(join_error("network Home is not in range"), "network Home is not in range");
    }

    #[test]
    fn wadds_events_parse() {
        let s: Option<Session> = serde_json::from_str(
            r#"{"mode":"focus","workspaces":["a"],"minutes":25,"startedAt":1.0,"endsAt":1500.0,"expired":false}"#,
        )
        .unwrap();
        assert!(locked(s.as_ref()));
        assert_eq!(s.unwrap().ends_at, Some(1500.0));
        let none: Option<Session> = serde_json::from_str("null").unwrap();
        assert!(!locked(none.as_ref()));
        let n: Network = serde_json::from_str(
            r#"{"available":true,"state":"connected","connectivity":"full","wifiEnabled":true,"wifiDevice":"wlp1s0","ssid":"Home","signal":70}"#,
        )
        .unwrap();
        assert_eq!(network_label(Some(&n)), Some(("Home".into(), true)));
        let c: Carousel = serde_json::from_str(
            r#"{"open":true,"items":[{"view":{"kind":"home"},"name":"WadSpaces","icon":null,"running":true},
                {"view":{"kind":"workspace","id":"writing"},"name":"Writing","icon":"/v1/workspaces/writing/icon","running":false}],"index":1}"#,
        )
        .unwrap();
        assert_eq!((c.items[0].view.as_str(), c.items[1].view.as_str()), ("home", "writing"));
    }
}
