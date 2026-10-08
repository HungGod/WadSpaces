//! The screen's backlight, for the HUD's brightness slider: sysfs
//! (/sys/class/backlight/<device>/{brightness,max_brightness}), which only
//! root may write. systemd-backlight saves it at shutdown and puts it back at
//! boot, so nothing is kept here.

use std::path::{Path, PathBuf};

use wad_proto::v1::Brightness;

/// Below this the screen is too dark to find the slider again.
pub const FLOOR: u8 = 5;

pub struct Backlight {
    /// /sys/class/backlight, or a test's folder shaped like it.
    dir: PathBuf,
}

impl Default for Backlight {
    fn default() -> Self {
        Self::new("/sys/class/backlight")
    }
}

fn read_number(path: &Path) -> Option<u64> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

impl Backlight {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The device to drive, as the kernel advises: firmware (ACPI) before
    /// platform before raw (the GPU's own, e.g. intel_backlight); by name
    /// within a kind, so it's always the same one.
    fn device(&self) -> Option<(PathBuf, u64)> {
        let mut found: Vec<(u8, String, PathBuf, u64)> = std::fs::read_dir(&self.dir)
            .ok()?
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let max = read_number(&path.join("max_brightness")).filter(|m| *m > 0)?;
                let rank = match std::fs::read_to_string(path.join("type")).unwrap_or_default().trim() {
                    "firmware" => 0,
                    "platform" => 1,
                    _ => 2,
                };
                Some((rank, e.file_name().to_string_lossy().into_owned(), path, max))
            })
            .collect();
        found.sort();
        found.into_iter().next().map(|(_, _, path, max)| (path, max))
    }

    pub fn get(&self) -> Brightness {
        let Some((path, max)) = self.device() else { return Brightness { available: false, percent: 0 } };
        let now = read_number(&path.join("brightness")).unwrap_or(max);
        Brightness { available: true, percent: ((now.min(max) * 100 + max / 2) / max) as u8 }
    }

    /// Sets it to `percent` (FLOOR at least), and says what it is now.
    pub fn set(&self, percent: u8) -> Result<Brightness, String> {
        let (path, max) = self.device().ok_or("this screen's brightness can't be set")?;
        let percent = percent.clamp(FLOOR, 100) as u64;
        let raw = (max * percent).div_ceil(100).max(1);
        std::fs::write(path.join("brightness"), raw.to_string())
            .map_err(|e| format!("couldn't set the brightness: {e}"))?;
        Ok(self.get())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(root: &Path, name: &str, kind: &str, max: u64, now: u64) {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("type"), format!("{kind}\n")).unwrap();
        std::fs::write(d.join("max_brightness"), format!("{max}\n")).unwrap();
        std::fs::write(d.join("brightness"), format!("{now}\n")).unwrap();
    }

    #[test]
    fn no_backlight_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let b = Backlight::new(dir.path().join("missing"));
        assert_eq!(b.get(), Brightness { available: false, percent: 0 });
        assert!(b.set(50).is_err());
    }

    #[test]
    fn firmware_before_raw_and_a_floor() {
        let dir = tempfile::tempdir().unwrap();
        device(dir.path(), "intel_backlight", "raw", 7500, 7500);
        device(dir.path(), "acpi_video0", "firmware", 100, 40);
        let b = Backlight::new(dir.path());
        assert_eq!(b.get(), Brightness { available: true, percent: 40 });
        assert_eq!(b.set(73).unwrap().percent, 73);
        assert_eq!(std::fs::read_to_string(dir.path().join("acpi_video0/brightness")).unwrap(), "73");
        // Never black.
        assert_eq!(b.set(0).unwrap().percent, FLOOR);
        // The raw one was left alone.
        assert_eq!(std::fs::read_to_string(dir.path().join("intel_backlight/brightness")).unwrap(), "7500\n");
    }

    #[test]
    fn a_fine_grained_raw_device() {
        let dir = tempfile::tempdir().unwrap();
        device(dir.path(), "intel_backlight", "raw", 7500, 1875);
        let b = Backlight::new(dir.path());
        assert_eq!(b.get().percent, 25);
        b.set(60).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("intel_backlight/brightness")).unwrap(), "4500");
    }
}
