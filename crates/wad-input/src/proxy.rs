//! The keyboard proxy's thread: grabs every keyboard (EVIOCGRAB), runs what
//! it reads through the KeyRouter, and types what passes into the virtual
//! keyboard the compositor reads. Its own thread, so a busy daemon can never
//! stall typing.
//!
//! If the grab isn't possible (no /dev/uinput, not root: a laptop), it falls
//! back to reading the keyboards without grabbing: chords still act but
//! nothing is filtered. If wadd dies, the kernel drops the grab and the
//! keyboards go straight to the compositor again.

use std::collections::HashMap;
use std::os::fd::AsFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use evdev::{Device, EventType, InputEvent, KeyCode};
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

use crate::router::{Action, KeyRouter};
use crate::uinput::{EV_LED, VirtualKeyboard};
use crate::{VIRTUAL_NAME, keys};

/// Where key events go once routed: the virtual keyboard, or a test's list.
pub trait Sink {
    fn keys(&mut self, keys: &[(u16, i32)]);
}

impl Sink for VirtualKeyboard {
    fn keys(&mut self, keys: &[(u16, i32)]) {
        if let Err(e) = VirtualKeyboard::keys(self, keys) {
            tracing::warn!("virtual keyboard: {e}");
        }
    }
}

/// One event from a real keyboard: forwards what the router lets through
/// and returns its action. Only key events count (SYN and MSC are
/// regenerated for what's forwarded).
pub fn route(
    router: &Mutex<KeyRouter>,
    sink: Option<&mut dyn Sink>,
    type_: u16,
    code: u16,
    value: i32,
) -> Option<Action> {
    if type_ != crate::uinput::EV_KEY {
        return None;
    }
    let (out, action) = router.lock().unwrap().feed(code, value);
    if let Some(sink) = sink
        && !out.is_empty()
    {
        sink.keys(&out);
    }
    action
}

/// A keyboard, not a button pad or our own virtual keyboard.
pub fn is_keyboard(name: &str, has_a_and_1: bool) -> bool {
    name != VIRTUAL_NAME && has_a_and_1
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    /// Keys are filtered (the keyboards are grabbed), not just watched.
    pub grabbing: bool,
    pub keyboards: Vec<String>,
    /// Why it isn't grabbing, if it isn't.
    pub note: Option<String>,
}

pub struct Proxy {
    router: Arc<Mutex<KeyRouter>>,
    status: Arc<Mutex<Status>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Proxy {
    /// Starts the thread. `on_action` is called (on that thread) for each
    /// action; it should hand off, not block.
    pub fn start(router: KeyRouter, grab: bool, on_action: impl Fn(Action) + Send + 'static) -> Self {
        let router = Arc::new(Mutex::new(router));
        let status = Arc::new(Mutex::new(Status::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let mut worker = Worker {
            router: router.clone(),
            status: status.clone(),
            stop: stop.clone(),
            on_action: Box::new(on_action),
            devices: HashMap::new(),
            ui: None,
        };
        let thread = std::thread::Builder::new()
            .name("keys".into())
            .spawn(move || worker.run(grab))
            .expect("a thread for the keyboards");
        Self { router, status, stop, thread: Some(thread) }
    }

    pub fn router(&self) -> Arc<Mutex<KeyRouter>> {
        self.router.clone()
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
}

impl Drop for Proxy {
    /// Lets every key go, ungrabs and removes the virtual keyboard.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Worker {
    router: Arc<Mutex<KeyRouter>>,
    status: Arc<Mutex<Status>>,
    stop: Arc<AtomicBool>,
    on_action: Box<dyn Fn(Action) + Send>,
    devices: HashMap<PathBuf, Device>,
    ui: Option<VirtualKeyboard>,
}

const RESCAN: Duration = Duration::from_secs(2);

impl Worker {
    fn run(&mut self, grab: bool) {
        if grab {
            match VirtualKeyboard::create(VIRTUAL_NAME) {
                Ok(ui) => self.ui = Some(ui),
                Err(e) => {
                    tracing::warn!("keyboard grab unavailable ({e}); hotkeys work but nothing is filtered");
                    self.status.lock().unwrap().note = Some(format!("not grabbing: /dev/uinput: {e}"));
                }
            }
        } else {
            self.status.lock().unwrap().note = Some("not grabbing (keys.grab = false)".into());
        }
        self.status.lock().unwrap().grabbing = self.ui.is_some();
        let mut next_scan = Instant::now();
        while !self.stop.load(Ordering::Relaxed) {
            if Instant::now() >= next_scan {
                self.scan();
                next_scan = Instant::now() + RESCAN;
            }
            self.wait_and_read();
        }
        self.shutdown();
    }

    fn scan(&mut self) {
        let grabbing = self.ui.is_some();
        let mut changed = false;
        for (path, mut dev) in evdev::enumerate() {
            if self.devices.contains_key(&path) {
                continue;
            }
            let name = dev.name().unwrap_or("").to_string();
            let keys = dev.supported_keys();
            let has =
                keys.is_some_and(|k| k.contains(KeyCode::new(keys::KEY_A)) && k.contains(KeyCode::new(keys::KEY_1)));
            if !is_keyboard(&name, has) {
                continue;
            }
            if grabbing {
                if dev.get_key_state().is_ok_and(|s| s.iter().next().is_some()) {
                    continue; // a key is down right now: grab it next scan
                }
                if let Err(e) = dev.grab() {
                    tracing::warn!("couldn't grab {} ({name}): {e}", path.display());
                    continue;
                }
            }
            if let Err(e) = dev.set_nonblocking(true) {
                tracing::warn!("{}: {e}", path.display());
                continue;
            }
            tracing::info!("keyboard {}: {} ({name})", if grabbing { "grabbed" } else { "watching" }, path.display());
            self.devices.insert(path, dev);
            changed = true;
        }
        if changed {
            let mut names: Vec<String> = self.devices.keys().map(|p| p.display().to_string()).collect();
            names.sort();
            self.status.lock().unwrap().keyboards = names;
        }
    }

    fn wait_and_read(&mut self) {
        let paths: Vec<PathBuf> = self.devices.keys().cloned().collect();
        let ready: Vec<bool> = {
            let mut fds: Vec<PollFd> =
                paths.iter().map(|p| PollFd::new(self.devices[p].as_fd(), PollFlags::POLLIN)).collect();
            if let Some(ui) = &self.ui {
                fds.push(PollFd::new(ui.as_fd(), PollFlags::POLLIN));
            }
            if poll(&mut fds, PollTimeout::from(500u16)).unwrap_or(0) <= 0 {
                return;
            }
            fds.iter().map(|f| f.revents().is_some_and(|r| !r.is_empty())).collect()
        };
        if self.ui.is_some() && ready.last() == Some(&true) {
            self.mirror_leds();
        }
        for (path, _) in paths.iter().zip(&ready).filter(|(_, r)| **r) {
            let events: Result<Vec<InputEvent>, _> = match self.devices.get_mut(path) {
                Some(d) => d.fetch_events().map(|e| e.collect()),
                None => continue,
            };
            match events {
                Ok(events) => {
                    for ev in events {
                        self.handle(ev);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    tracing::info!("keyboard {} went away", path.display());
                    self.devices.remove(path);
                    let mut names: Vec<String> = self.devices.keys().map(|p| p.display().to_string()).collect();
                    names.sort();
                    self.status.lock().unwrap().keyboards = names;
                }
            }
        }
    }

    fn handle(&mut self, ev: InputEvent) {
        if ev.event_type() != EventType::KEY {
            return;
        }
        let sink = self.ui.as_mut().map(|u| u as &mut dyn Sink);
        if let Some(action) = route(&self.router, sink, EventType::KEY.0, ev.code(), ev.value()) {
            tracing::info!("key action: {action:?}");
            (self.on_action)(action);
        }
    }

    /// Caps/Num Lock are set on the virtual keyboard: show them on the real ones.
    fn mirror_leds(&mut self) {
        let Some(ui) = self.ui.as_mut() else { return };
        for (led, on) in ui.leds() {
            for dev in self.devices.values_mut() {
                let _ = dev.send_events(&[InputEvent::new(EV_LED, led, on)]);
            }
        }
    }

    fn shutdown(&mut self) {
        let ups = self.router.lock().unwrap().release_all();
        if let Some(ui) = self.ui.as_mut()
            && !ups.is_empty()
        {
            Sink::keys(ui, &ups);
        }
        for (_, mut dev) in self.devices.drain() {
            if self.ui.is_some() {
                let _ = dev.ungrab();
            }
        }
        self.ui = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{Chord, code};

    #[derive(Default)]
    struct Written(Vec<Vec<(u16, i32)>>);
    impl Sink for Written {
        fn keys(&mut self, keys: &[(u16, i32)]) {
            self.0.push(keys.to_vec());
        }
    }

    #[test]
    fn routing_forwards_keys_and_returns_actions() {
        let bindings = HashMap::from([(code("0").unwrap(), "home".to_string())]);
        let router = Mutex::new(KeyRouter::new(bindings, vec![Chord::parse("alt+f4").unwrap()], false));
        let mut sink = Written::default();
        let (a, sup, zero) = (code("a").unwrap(), code("leftmeta").unwrap(), code("0").unwrap());
        let mut actions = vec![];
        for (t, c, v) in [(1, a, 1), (4, 4, 30), (1, a, 0), (1, sup, 1), (1, zero, 1), (1, sup, 0)] {
            actions.extend(route(&router, Some(&mut sink), t, c, v));
        }
        assert_eq!(sink.0, [vec![(a, 1)], vec![(a, 0)]]); // MSC dropped, Super swallowed
        assert_eq!(actions, [Action::Bound("home".into())]);
    }

    #[test]
    fn keyboards() {
        assert!(is_keyboard("Surface Keyboard", true));
        assert!(!is_keyboard("Surface Button", false)); // volume/power
        assert!(!is_keyboard(VIRTUAL_NAME, true)); // our own output
    }
}
