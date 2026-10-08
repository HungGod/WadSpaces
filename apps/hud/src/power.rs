//! The battery: the kernel's power supplies (/sys/class/power_supply, which
//! anyone may read), so no daemon in between. A Surface Book has two, one in
//! the screen and one in the keyboard base: they're shown as one, by the
//! energy they hold between them.

use std::path::{Path, PathBuf};

/// One power supply's files that matter here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Supply {
    pub kind: String,
    /// "Device" for a mouse's or a pen's battery: not the machine's.
    pub scope: String,
    pub present: bool,
    pub online: bool,
    pub status: String,
    pub capacity: Option<f64>,
    /// µWh, or µAh (charge_*) when that's what the battery reports.
    pub now: Option<f64>,
    pub full: Option<f64>,
    /// µW or µA, as `now`.
    pub rate: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum State {
    Charging,
    Discharging,
    /// Plugged in and not charging (full, or held at a limit).
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Battery {
    pub percent: u8,
    pub state: State,
    /// Until empty (discharging) or full (charging), when the rate is known.
    pub minutes: Option<u32>,
}

/// Where the supplies are (WADSPACES_HUD_POWER_SUPPLY in snapshots and tests).
pub fn dir() -> PathBuf {
    std::env::var_os("WADSPACES_HUD_POWER_SUPPLY")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/sys/class/power_supply".into())
}

fn text(d: &Path, f: &str) -> Option<String> {
    std::fs::read_to_string(d.join(f)).ok().map(|s| s.trim().to_string())
}

fn number(d: &Path, f: &str) -> Option<f64> {
    text(d, f)?.parse().ok()
}

pub fn read(dir: &Path) -> Vec<Supply> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<(String, Supply)> = entries
        .flatten()
        .map(|e| {
            let d = e.path();
            let (now, full, rate) = match number(&d, "energy_full") {
                Some(full) => (number(&d, "energy_now"), Some(full), number(&d, "power_now")),
                None => (number(&d, "charge_now"), number(&d, "charge_full"), number(&d, "current_now")),
            };
            let s = Supply {
                kind: text(&d, "type").unwrap_or_default(),
                scope: text(&d, "scope").unwrap_or_default(),
                present: text(&d, "present").is_none_or(|p| p != "0"),
                online: text(&d, "online").is_some_and(|o| o == "1"),
                status: text(&d, "status").unwrap_or_default(),
                capacity: number(&d, "capacity"),
                now,
                full,
                rate,
            };
            (e.file_name().to_string_lossy().into_owned(), s)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, s)| s).collect()
}

/// The machine's batteries as one (None: it has none, a desktop).
pub fn combine(supplies: &[Supply]) -> Option<Battery> {
    let bats: Vec<&Supply> =
        supplies.iter().filter(|s| s.kind == "Battery" && s.present && s.scope != "Device").collect();
    if bats.is_empty() {
        return None;
    }
    let plugged = supplies.iter().any(|s| s.kind == "Mains" && s.online);
    let energy = bats.iter().all(|b| b.now.is_some() && b.full.is_some_and(|f| f > 0.0));
    let (now, full): (f64, f64) = if energy {
        bats.iter().fold((0.0, 0.0), |(n, f), b| (n + b.now.unwrap_or(0.0), f + b.full.unwrap_or(0.0)))
    } else {
        // Only percentages: their average.
        let caps: Vec<f64> = bats.iter().filter_map(|b| b.capacity).collect();
        if caps.is_empty() {
            return None;
        }
        (caps.iter().sum::<f64>() / caps.len() as f64, 100.0)
    };
    let percent = (now / full * 100.0).round().clamp(0.0, 100.0) as u8;
    let charging = bats.iter().any(|b| b.status == "Charging");
    let discharging = bats.iter().any(|b| b.status == "Discharging");
    let state = if charging {
        State::Charging
    } else if discharging || !plugged {
        State::Discharging
    } else {
        State::Full
    };
    // One battery can feed the other (a Surface Book moves charge between
    // them): only the rates going the machine's way count.
    let rate: f64 = bats
        .iter()
        .filter(|b| match state {
            State::Charging => b.status == "Charging",
            State::Discharging => b.status == "Discharging",
            State::Full => false,
        })
        .filter_map(|b| b.rate)
        .map(f64::abs)
        .sum();
    let minutes = (energy && rate > 0.0)
        .then(|| match state {
            State::Charging => (full - now).max(0.0) / rate,
            State::Discharging => now / rate,
            State::Full => 0.0,
        })
        .filter(|h| *h > 0.0 && *h < 48.0)
        .map(|h| (h * 60.0).round() as u32);
    Some(Battery { percent, state, minutes })
}

/// Adwaita's symbolic icon for it.
pub fn icon(b: &Battery) -> String {
    let level = (b.percent as u32 + 5) / 10 * 10;
    match b.state {
        State::Charging => format!("battery-level-{level}-charging-symbolic"),
        State::Full if b.percent >= 99 => "battery-level-100-charged-symbolic".into(),
        State::Full => format!("battery-level-{level}-plugged-in-symbolic"),
        State::Discharging => format!("battery-level-{level}-symbolic"),
    }
}

/// Low enough to say so (the bubble turns the warning colour).
pub fn low(b: &Battery) -> bool {
    b.state == State::Discharging && b.percent <= 15
}

fn duration(m: u32) -> String {
    match (m / 60, m % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// The tooltip, in words.
pub fn describe(b: &Battery) -> String {
    let p = b.percent;
    match (b.state, b.minutes) {
        (State::Charging, Some(m)) => format!("{p}%, charging: full in {}", duration(m)),
        (State::Charging, None) => format!("{p}%, charging"),
        (State::Discharging, Some(m)) => format!("{p}%: about {} left", duration(m)),
        (State::Discharging, None) => format!("{p}% left"),
        (State::Full, _) if p >= 99 => "Fully charged".into(),
        (State::Full, _) => format!("{p}%, plugged in, not charging"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bat(status: &str, now: f64, full: f64, rate: f64) -> Supply {
        Supply {
            kind: "Battery".into(),
            present: true,
            status: status.into(),
            now: Some(now),
            full: Some(full),
            rate: Some(rate),
            ..Default::default()
        }
    }

    fn mains(online: bool) -> Supply {
        Supply { kind: "Mains".into(), present: true, online, ..Default::default() }
    }

    #[test]
    fn two_batteries_as_one() {
        // A Surface Book 2 on its desk: both full, plugged in.
        let b =
            combine(&[mains(true), bat("Full", 14.93e6, 14.93e6, 8000.0), bat("Full", 45.51e6, 45.51e6, 0.0)]).unwrap();
        assert_eq!(b, Battery { percent: 100, state: State::Full, minutes: None });
        assert_eq!(icon(&b), "battery-level-100-charged-symbolic");
        assert_eq!(describe(&b), "Fully charged");
        // Unplugged: weighted by energy (the base holds three times the screen's).
        let b = combine(&[
            mains(false),
            bat("Discharging", 7.0e6, 15.0e6, 6.0e6),
            bat("Discharging", 38.0e6, 45.0e6, 4.0e6),
        ])
        .unwrap();
        assert_eq!((b.percent, b.state), (75, State::Discharging));
        assert_eq!(b.minutes, Some(270)); // 45 Wh at 10 W
        assert_eq!(icon(&b), "battery-level-80-symbolic");
        assert_eq!(describe(&b), "75%: about 4 h 30 min left");
    }

    #[test]
    fn charging_and_low() {
        let b = combine(&[mains(true), bat("Charging", 30.0e6, 60.0e6, 20.0e6)]).unwrap();
        assert_eq!((b.state, b.minutes), (State::Charging, Some(90)));
        assert_eq!(icon(&b), "battery-level-50-charging-symbolic");
        assert_eq!(describe(&b), "50%, charging: full in 1 h 30 min");
        let b = combine(&[mains(false), bat("Discharging", 6.0e6, 60.0e6, 0.0)]).unwrap();
        assert!(low(&b));
        assert_eq!(b.minutes, None); // no rate yet
        assert_eq!(describe(&b), "10% left");
        assert_eq!(icon(&b), "battery-level-10-symbolic");
        // Held at a limit while plugged in.
        let b = combine(&[mains(true), bat("Not charging", 48.0e6, 60.0e6, 0.0)]).unwrap();
        assert_eq!(describe(&b), "80%, plugged in, not charging");
        assert_eq!(icon(&b), "battery-level-80-plugged-in-symbolic");
    }

    #[test]
    fn what_doesnt_count() {
        assert_eq!(combine(&[mains(true)]), None); // a desktop
        let mouse = Supply { scope: "Device".into(), ..bat("Discharging", 1.0, 2.0, 0.0) };
        assert_eq!(combine(&[mains(true), mouse]), None);
        let gone = Supply { present: false, ..bat("Unknown", 0.0, 0.0, 0.0) };
        assert_eq!(combine(&[gone]), None);
        // Only percentages reported.
        let only = Supply {
            kind: "Battery".into(),
            present: true,
            status: "Discharging".into(),
            capacity: Some(41.0),
            ..Default::default()
        };
        assert_eq!(combine(&[only]).unwrap().percent, 41);
    }

    #[test]
    fn reads_sysfs() {
        let d = tempfile::tempdir().unwrap();
        let w = |dev: &str, f: &str, v: &str| {
            std::fs::create_dir_all(d.path().join(dev)).unwrap();
            std::fs::write(d.path().join(dev).join(f), format!("{v}\n")).unwrap();
        };
        w("ADP1", "type", "Mains");
        w("ADP1", "online", "0");
        for (f, v) in [("type", "Battery"), ("status", "Discharging"), ("present", "1"), ("capacity", "50")] {
            w("BAT1", f, v);
        }
        for (f, v) in [("charge_now", "2000000"), ("charge_full", "4000000"), ("current_now", "1000000")] {
            w("BAT1", f, v);
        }
        let b = combine(&read(d.path())).unwrap();
        assert_eq!(b, Battery { percent: 50, state: State::Discharging, minutes: Some(120) });
        assert!(read(&d.path().join("missing")).is_empty());
    }
}
