//! The volume: the kiosk session's PipeWire, through wireplumber's wpctl
//! (the HUD runs as the session's user, so no wadd in between).

use std::process::Command;

const SINK: &str = "@DEFAULT_AUDIO_SINK@";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Volume {
    /// 0 to 100 (wpctl allows more; the slider stops at 100).
    pub percent: u8,
    pub muted: bool,
}

fn wpctl(args: &[&str]) -> Result<String, String> {
    let out = Command::new("wpctl").args(args).output().map_err(|e| format!("wpctl: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "no sound output".into() } else { err })
    }
}

/// wpctl's `Volume: 0.40 [MUTED]`.
pub fn parse(out: &str) -> Option<Volume> {
    let rest = out.trim().strip_prefix("Volume:")?.trim();
    let level: f64 = rest.split_whitespace().next()?.parse().ok()?;
    Some(Volume { percent: (level * 100.0).round().clamp(0.0, 100.0) as u8, muted: rest.contains("[MUTED]") })
}

/// The default output's volume (Err: no sound here).
pub fn get() -> Result<Volume, String> {
    parse(&wpctl(&["get-volume", SINK])?).ok_or_else(|| "no sound output".into())
}

/// Sets the volume; turning it up or down unmutes.
pub fn set(percent: u8) -> Result<(), String> {
    let level = format!("{:.2}", percent.min(100) as f64 / 100.0);
    wpctl(&["set-volume", "-l", "1.0", SINK, &level])?;
    wpctl(&["set-mute", SINK, "0"]).map(|_| ())
}

pub fn set_muted(muted: bool) -> Result<(), String> {
    wpctl(&["set-mute", SINK, if muted { "1" } else { "0" }]).map(|_| ())
}

/// Up or down by `delta` points (the volume keys); up unmutes. The volume after.
pub fn step(delta: i32) -> Result<Volume, String> {
    let by = format!("{}%{}", delta.unsigned_abs(), if delta < 0 { "-" } else { "+" });
    wpctl(&["set-volume", "-l", "1.0", SINK, &by])?;
    if delta > 0 {
        wpctl(&["set-mute", SINK, "0"])?;
    }
    get()
}

/// The mute key. The volume after.
pub fn toggle_mute() -> Result<Volume, String> {
    wpctl(&["set-mute", SINK, "toggle"])?;
    get()
}

/// The icon for a volume (Adwaita's symbolic ones, coloured by the theme).
pub fn icon(v: Option<Volume>) -> &'static str {
    match v {
        None => "audio-volume-muted-symbolic",
        Some(v) if v.muted || v.percent == 0 => "audio-volume-muted-symbolic",
        Some(v) if v.percent < 34 => "audio-volume-low-symbolic",
        Some(v) if v.percent < 67 => "audio-volume-medium-symbolic",
        Some(_) => "audio-volume-high-symbolic",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wpctls_answer() {
        assert_eq!(parse("Volume: 0.40\n"), Some(Volume { percent: 40, muted: false }));
        assert_eq!(parse("Volume: 0.07 [MUTED]\n"), Some(Volume { percent: 7, muted: true }));
        // Boosted past 100% elsewhere: the slider shows its end.
        assert_eq!(parse("Volume: 1.35"), Some(Volume { percent: 100, muted: false }));
        assert_eq!(parse("Translate ID error: '@DEFAULT_AUDIO_SINK@' is not a valid ID"), None);
    }

    #[test]
    fn icons_follow_the_level() {
        let v = |percent, muted| Some(Volume { percent, muted });
        assert_eq!(icon(None), "audio-volume-muted-symbolic");
        assert_eq!(icon(v(80, true)), "audio-volume-muted-symbolic");
        assert_eq!(icon(v(0, false)), "audio-volume-muted-symbolic");
        assert_eq!(icon(v(20, false)), "audio-volume-low-symbolic");
        assert_eq!(icon(v(50, false)), "audio-volume-medium-symbolic");
        assert_eq!(icon(v(90, false)), "audio-volume-high-symbolic");
    }
}
