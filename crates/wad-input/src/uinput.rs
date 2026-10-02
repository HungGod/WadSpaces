//! The virtual keyboard wadd types into (`wadspaces-kbd`): every key, plus
//! the Num/Caps/Scroll Lock LEDs so the compositor's lock state comes back
//! to us (and on to the real keyboards). evdev's builder can't declare LEDs,
//! hence these few ioctls.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd};
use std::os::unix::fs::OpenOptionsExt;

pub const EV_SYN: u16 = 0;
pub const EV_KEY: u16 = 1;
pub const EV_LED: u16 = 17;
const BUS_VIRTUAL: u16 = 0x06;

#[repr(C)]
struct UinputSetup {
    id: libc::input_id,
    name: [libc::c_char; 80],
    ff_effects_max: u32,
}

nix::ioctl_write_int!(ui_set_evbit, b'U', 100);
nix::ioctl_write_int!(ui_set_keybit, b'U', 101);
nix::ioctl_write_int!(ui_set_ledbit, b'U', 105);
nix::ioctl_write_ptr!(ui_dev_setup, b'U', 3, UinputSetup);
nix::ioctl_none!(ui_dev_create, b'U', 1);
nix::ioctl_none!(ui_dev_destroy, b'U', 2);

pub struct VirtualKeyboard {
    file: File,
}

impl VirtualKeyboard {
    pub fn create(name: &str) -> std::io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK).open("/dev/uinput")?;
        let fd = file.as_raw_fd();
        let mut setup = UinputSetup {
            id: libc::input_id { bustype: BUS_VIRTUAL, vendor: 0x1209, product: 0x3a77, version: 1 },
            name: [0; 80],
            ff_effects_max: 0,
        };
        for (d, s) in setup.name.iter_mut().zip(name.bytes().take(79)) {
            *d = s as libc::c_char;
        }
        // SAFETY: fd is an open uinput device; the arguments are what the
        // kernel's uinput ioctls take.
        unsafe {
            ui_set_evbit(fd, EV_KEY as _)?;
            ui_set_evbit(fd, EV_LED as _)?;
            for key in 1..256 {
                ui_set_keybit(fd, key)?;
            }
            for led in 0..3 {
                ui_set_ledbit(fd, led)?;
            }
            ui_dev_setup(fd, &setup)?;
            ui_dev_create(fd)?;
        }
        Ok(Self { file })
    }

    fn event(type_: u16, code: u16, value: i32) -> [u8; size_of::<libc::input_event>()] {
        let ev = libc::input_event { time: libc::timeval { tv_sec: 0, tv_usec: 0 }, type_, code, value };
        // SAFETY: input_event is plain old data.
        unsafe { std::mem::transmute(ev) }
    }

    /// Writes key events and a SYN_REPORT.
    pub fn keys(&mut self, keys: &[(u16, i32)]) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity((keys.len() + 1) * size_of::<libc::input_event>());
        for (code, value) in keys {
            buf.extend_from_slice(&Self::event(EV_KEY, *code, *value));
        }
        buf.extend_from_slice(&Self::event(EV_SYN, 0, 0));
        self.file.write_all(&buf)
    }

    /// LED changes the compositor made: (led, on).
    pub fn leds(&mut self) -> Vec<(u16, i32)> {
        let mut out = vec![];
        let mut buf = [0u8; size_of::<libc::input_event>()];
        while let Ok(n) = self.file.read(&mut buf) {
            if n != buf.len() {
                break;
            }
            // SAFETY: the kernel wrote a whole input_event.
            let ev: libc::input_event = unsafe { std::mem::transmute(buf) };
            if ev.type_ == EV_LED {
                out.push((ev.code, ev.value));
            }
        }
        out
    }
}

impl AsFd for VirtualKeyboard {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.file.as_fd()
    }
}

impl Drop for VirtualKeyboard {
    fn drop(&mut self) {
        // SAFETY: as in create.
        let _ = unsafe { ui_dev_destroy(self.file.as_raw_fd()) };
    }
}
