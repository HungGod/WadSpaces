//! Resizing a frameless window from its edges. The window has no border of
//! its own, so the views at its edges (the chrome and the pages) take the
//! pointer in the outer few pixels and start the compositor's resize there
//! (after tauri-runtime-wry's undecorated_resizing, which only covers the
//! one view Tauri knows of).

use gtk::gdk::{self, WindowEdge};
use gtk::glib::Propagation;
use gtk::prelude::*;

const INSET: f64 = 5.0;

pub fn attach(widget: &gtk::Widget) {
    widget.add_events(
        gdk::EventMask::POINTER_MOTION_MASK | gdk::EventMask::BUTTON_PRESS_MASK | gdk::EventMask::LEAVE_NOTIFY_MASK,
    );
    widget.connect_motion_notify_event(|w, e| {
        let Some((win, edge)) = edge_at(w, e.position()) else {
            reset_cursor(w);
            return Propagation::Proceed;
        };
        let cursor = gdk::Cursor::for_display(&win.display(), cursor_for(edge));
        if let Some(gw) = w.window() {
            gw.set_cursor(cursor.as_ref());
        }
        Propagation::Stop
    });
    widget.connect_leave_notify_event(|w, _| {
        reset_cursor(w);
        Propagation::Proceed
    });
    widget.connect_button_press_event(|w, e| {
        if e.button() != 1 {
            return Propagation::Proceed;
        }
        let Some((win, edge)) = edge_at(w, e.position()) else { return Propagation::Proceed };
        let (rx, ry) = e.root();
        if let Some(gw) = win.window() {
            gw.begin_resize_drag(edge, 1, rx as i32, ry as i32, e.time());
        }
        Propagation::Stop
    });
}

fn reset_cursor(w: &gtk::Widget) {
    if let Some(gw) = w.window() {
        gw.set_cursor(None);
    }
}

/// The window edge under (x, y) of `w`, if the window can be resized there.
fn edge_at(w: &gtk::Widget, (x, y): (f64, f64)) -> Option<(gtk::Window, WindowEdge)> {
    let win = w.toplevel()?.downcast::<gtk::Window>().ok()?;
    if win.is_maximized()
        || !win.is_resizable()
        || win.window().is_some_and(|g| g.state().contains(gdk::WindowState::FULLSCREEN))
    {
        return None;
    }
    let (wx, wy) = w.translate_coordinates(&win, x as i32, y as i32)?;
    let (ww, wh) = (win.allocated_width() as f64, win.allocated_height() as f64);
    let (left, right) = ((wx as f64) < INSET, (wx as f64) > ww - INSET);
    let (top, bottom) = ((wy as f64) < INSET, (wy as f64) > wh - INSET);
    let edge = match (top, bottom, left, right) {
        (true, _, true, _) => WindowEdge::NorthWest,
        (true, _, _, true) => WindowEdge::NorthEast,
        (_, true, true, _) => WindowEdge::SouthWest,
        (_, true, _, true) => WindowEdge::SouthEast,
        (true, ..) => WindowEdge::North,
        (_, true, ..) => WindowEdge::South,
        (_, _, true, _) => WindowEdge::West,
        (_, _, _, true) => WindowEdge::East,
        _ => return None,
    };
    Some((win, edge))
}

fn cursor_for(edge: WindowEdge) -> gdk::CursorType {
    match edge {
        WindowEdge::NorthWest => gdk::CursorType::TopLeftCorner,
        WindowEdge::NorthEast => gdk::CursorType::TopRightCorner,
        WindowEdge::SouthWest => gdk::CursorType::BottomLeftCorner,
        WindowEdge::SouthEast => gdk::CursorType::BottomRightCorner,
        WindowEdge::North => gdk::CursorType::TopSide,
        WindowEdge::South => gdk::CursorType::BottomSide,
        WindowEdge::West => gdk::CursorType::LeftSide,
        _ => gdk::CursorType::RightSide,
    }
}
