//! Hardware acceleration: WebKit composites and decodes video on the GPU when
//! the container has one (/dev/dri), and falls back to the CPU cleanly when
//! it doesn't. Decided once at start, before GTK or any thread is up.

use std::sync::OnceLock;
use webkit2gtk::HardwareAccelerationPolicy;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gpu {
    On,
    Off,
}

static CHOSEN: OnceLock<Gpu> = OnceLock::new();

/// `WADBROWSER_GPU=auto|on|off` (or `--gpu`), else auto: on when a render node
/// opens and the driver isn't NVIDIA's proprietary one (its DMA-BUF path is
/// the usual cause of blank WebKit windows).
pub fn init(wanted: Option<&str>) -> Gpu {
    let wanted = wanted.map(str::to_owned).or_else(|| std::env::var("WADBROWSER_GPU").ok());
    let gpu = match wanted.as_deref() {
        Some("on") => Gpu::On,
        Some("off") => Gpu::Off,
        _ if usable_render_node() && !nvidia() => Gpu::On,
        _ => Gpu::Off,
    };
    if gpu == Gpu::Off && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: called first thing in main, before any other thread exists.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    let _ = CHOSEN.set(gpu);
    gpu
}

pub fn policy() -> HardwareAccelerationPolicy {
    match CHOSEN.get() {
        Some(Gpu::Off) => HardwareAccelerationPolicy::Never,
        _ => HardwareAccelerationPolicy::Always,
    }
}

fn usable_render_node() -> bool {
    let Ok(dir) = std::fs::read_dir("/dev/dri") else { return false };
    dir.flatten().any(|e| {
        e.file_name().to_string_lossy().starts_with("renderD")
            && std::fs::OpenOptions::new().read(true).write(true).open(e.path()).is_ok()
    })
}

fn nvidia() -> bool {
    std::path::Path::new("/proc/driver/nvidia/version").exists()
}
