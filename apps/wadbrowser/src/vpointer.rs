//! The spike's pointer: a wlroots virtual pointer on the compositor
//! (headless sway has no input devices, so its `seat cursor` commands reach
//! no client). Spike builds only.

use std::time::Instant;
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_pointer, wl_registry};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle, delegate_noop};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1, zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
};

struct State;

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
delegate_noop!(State: ignore ZwlrVirtualPointerManagerV1);
delegate_noop!(State: ignore ZwlrVirtualPointerV1);

pub struct VPointer {
    conn: Connection,
    queue: EventQueue<State>,
    ptr: ZwlrVirtualPointerV1,
    start: Instant,
    size: (u32, u32),
}

const BTN_LEFT: u32 = 0x110;

impl VPointer {
    /// On the compositor in WAYLAND_DISPLAY, an output of `size`.
    pub fn new(size: (u32, u32)) -> Option<VPointer> {
        let conn = Connection::connect_to_env().ok()?;
        let (globals, mut queue) = registry_queue_init::<State>(&conn).ok()?;
        let qh = queue.handle();
        let mgr: ZwlrVirtualPointerManagerV1 = globals.bind(&qh, 1..=2, ()).ok()?;
        let ptr = mgr.create_virtual_pointer(None, &qh, ());
        queue.roundtrip(&mut State).ok()?;
        Some(VPointer { conn, queue, ptr, start: Instant::now(), size })
    }

    fn time(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }

    fn flush(&mut self) {
        self.ptr.frame();
        let _ = self.queue.roundtrip(&mut State);
        let _ = self.conn.flush();
    }

    pub fn move_to(&mut self, x: i32, y: i32) {
        self.ptr.motion_absolute(self.time(), x.max(0) as u32, y.max(0) as u32, self.size.0, self.size.1);
        self.flush();
    }

    pub fn button(&mut self, pressed: bool) {
        let state = if pressed { wl_pointer::ButtonState::Pressed } else { wl_pointer::ButtonState::Released };
        self.ptr.button(self.time(), BTN_LEFT, state);
        self.flush();
    }
}
