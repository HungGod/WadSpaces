//! How busy the machine is (metrics.py), for Wad Creator's Manager: CPU,
//! memory, disk, load and the GPU, from /proc and /sys. CPU is the share of
//! busy time since the last look (or over a short sample the first time).

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use wad_proto::v1::Metrics;

/// (busy, total) jiffies from /proc/stat's first line.
pub fn cpu_times(stat: &str) -> Option<(u64, u64)> {
    let vals: Vec<u64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    if vals.len() < 4 {
        return None;
    }
    let idle = vals[3] + vals.get(4).copied().unwrap_or(0); // idle + iowait
    let total: u64 = vals.iter().take(8).sum(); // guest time is in user/nice already
    Some((total - idle, total))
}

/// (total, used) bytes from /proc/meminfo.
pub fn memory(meminfo: &str) -> (u64, u64) {
    let kb = |key: &str| {
        meminfo
            .lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix(':')?.split_whitespace().next()?.parse::<u64>().ok())
            .map(|v| v * 1024)
    };
    let total = kb("MemTotal").unwrap_or(0);
    let avail = kb("MemAvailable").or_else(|| kb("MemFree")).unwrap_or(0);
    (total, total.saturating_sub(avail))
}

/// The first GPU's driver, with its vendor: "Intel (i915)".
pub fn gpu_name(drm: &Path) -> String {
    let mut cards: Vec<_> = std::fs::read_dir(drm)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("card") && n[4..].bytes().all(|b| b.is_ascii_digit()) && n.len() > 4)
        .collect();
    cards.sort();
    for card in cards {
        let dev = drm.join(card).join("device");
        let Ok(driver) = std::fs::read_link(dev.join("driver")) else { continue };
        let driver = driver.file_name().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        let vendor = match std::fs::read_to_string(dev.join("vendor")).unwrap_or_default().trim() {
            "0x8086" => "Intel",
            "0x1002" => "AMD",
            "0x10de" => "NVIDIA",
            _ => "",
        };
        return if vendor.is_empty() { driver } else { format!("{vendor} ({driver})") };
    }
    String::new()
}

pub struct Meter {
    last: Mutex<Option<(u64, u64)>>,
}

impl Default for Meter {
    fn default() -> Self {
        Self { last: Mutex::new(None) }
    }
}

impl Meter {
    async fn cpu(&self) -> f64 {
        let read = || std::fs::read_to_string("/proc/stat").ok().and_then(|s| cpu_times(&s));
        let Some(mut now) = read() else { return 0.0 };
        let last = *self.last.lock().unwrap();
        let before = match last {
            Some(b) => b,
            None => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let b = now;
                now = read().unwrap_or(b);
                b
            }
        };
        *self.last.lock().unwrap() = Some(now);
        let (busy, total) = (now.0.saturating_sub(before.0), now.1.saturating_sub(before.1));
        if total == 0 { 0.0 } else { (1000.0 * busy as f64 / total as f64).round() / 10.0 }
    }

    /// Now, with the disk the images are on.
    pub async fn snapshot(&self, disk: &Path) -> Metrics {
        let (mem_total, mem_used) = memory(&std::fs::read_to_string("/proc/meminfo").unwrap_or_default());
        let disk = if disk.exists() { disk } else { Path::new("/") };
        let (disk_free, disk_total) = match nix::sys::statvfs::statvfs(disk) {
            Ok(s) => (s.blocks_available() * s.fragment_size(), s.blocks() * s.fragment_size()),
            Err(_) => (0, 0),
        };
        let load = std::fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|l| l.split_whitespace().next()?.parse().ok())
            .unwrap_or(0.0);
        Metrics {
            cpu: self.cpu().await,
            mem: if mem_total == 0 { 0.0 } else { (1000.0 * mem_used as f64 / mem_total as f64).round() / 10.0 },
            mem_used,
            mem_total,
            disk_free,
            disk_total,
            load,
            gpu: gpu_name(Path::new("/sys/class/drm")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_proc() {
        assert_eq!(cpu_times("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n"), Some((150, 1000)));
        assert_eq!(cpu_times("garbage"), None);
        assert_eq!(
            memory("MemTotal:       8000 kB\nMemFree:  1000 kB\nMemAvailable:   2000 kB\n"),
            (8_192_000, 6_144_000)
        );
        assert_eq!(memory("MemTotal: 1000 kB\nMemFree: 250 kB\n"), (1_024_000, 768_000));
        let d = tempfile::tempdir().unwrap();
        let dev = d.path().join("card0/device");
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(dev.join("vendor"), "0x8086\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/i915", dev.join("driver")).unwrap();
        std::fs::create_dir_all(d.path().join("card0-eDP-1")).unwrap();
        assert_eq!(gpu_name(d.path()), "Intel (i915)");
        assert_eq!(gpu_name(&d.path().join("none")), "");
    }

    #[tokio::test]
    async fn a_snapshot_of_this_machine() {
        let m = Meter::default();
        let s = m.snapshot(Path::new("/")).await;
        assert!(s.mem_total > 0 && s.disk_total > 0 && (0.0..=100.0).contains(&s.cpu));
    }
}
