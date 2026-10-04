//! Each window's Wayland app_id (its X11 WM_CLASS under Xwayland).
//!
//! The desktop matches a window to its launcher by app_id, so every web app's
//! windows carry `wadspaces-webapp-<id>`, while one process hosts them all.
//! GTK 3 takes the app_id from the program name when it makes a window's
//! xdg_toplevel (as the window is first shown), so the name is swapped for that
//! moment; `gdk_wayland_window_set_application_id`
//! then keeps it right if the surface is ever made again.

use gtk::glib;
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use std::ffi::{CString, c_char};

/// The browser's own app_id, and the program name between windows.
pub const DEFAULT: &str = "wadbrowser";

unsafe extern "C" {
    fn gdk_wayland_window_set_application_id(window: *mut gtk::gdk::ffi::GdkWindow, application_id: *const c_char);
}

pub fn init() {
    glib::set_prgname(Some(DEFAULT));
}

/// Shows `win` for the first time, as `app_id`.
pub fn show_as(win: &gtk::ApplicationWindow, app_id: &str) {
    glib::set_prgname(Some(app_id));
    win.show_all();
    glib::set_prgname(Some(DEFAULT));
    set(win, app_id);
}

/// Sets the app_id of a window that's already shown (Wayland only).
pub fn set(win: &gtk::ApplicationWindow, app_id: &str) {
    let Some(gdk_window) = win.window() else { return };
    let Some(wayland) = glib::Type::from_name("GdkWaylandWindow") else { return };
    if !gdk_window.type_().is_a(wayland) {
        return;
    }
    let Ok(id) = CString::new(app_id) else { return };
    // SAFETY: a realized GdkWaylandWindow, and a NUL-terminated string GDK copies.
    unsafe { gdk_wayland_window_set_application_id(gdk_window.to_glib_none().0, id.as_ptr()) };
}

/// Whether `id` is fit to be an app_id (and a .desktop file's name).
pub fn valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    #[test]
    fn valid_ids() {
        assert!(super::valid("wadspaces-webapp-claude"));
        assert!(super::valid("io.wadspaces.x_1"));
        assert!(!super::valid(""));
        assert!(!super::valid("two words"));
        assert!(!super::valid("a/b"));
    }
}
