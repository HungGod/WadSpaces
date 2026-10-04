//! Keyboard shortcuts. The window sees a key before the page or the URL bar
//! does, so these work wherever the focus is; anything else goes on to them.

use crate::actions::{self, Action};
use gtk::gdk;
use gtk::gdk::keys::constants as k;
use gtk::glib::Propagation;
use gtk::prelude::*;
use tauri::AppHandle;

pub fn attach(app: &AppHandle, label: &str, win: &gtk::ApplicationWindow) {
    let (app, label) = (app.clone(), label.to_owned());
    win.connect_key_press_event(move |_, e| {
        let mods = e.state()
            & (gdk::ModifierType::CONTROL_MASK | gdk::ModifierType::SHIFT_MASK | gdk::ModifierType::MOD1_MASK);
        if e.keyval() == k::Escape {
            // Leaves full screen (F11's), else the page gets it.
            let left = crate::browser::with(&label, |b| {
                let on = b.is_fullscreen();
                if on {
                    b.set_fullscreen(false);
                }
                on
            });
            return if left == Some(true) { Propagation::Stop } else { Propagation::Proceed };
        }
        match action(e.keyval().to_lower(), mods) {
            Some(a) => {
                actions::run(&app, &label, a);
                Propagation::Stop
            }
            None => Propagation::Proceed,
        }
    });
}

/// The action for `key` with modifiers `mods` (Ctrl, Shift, Alt only).
pub fn action(key: gdk::keys::Key, mods: gdk::ModifierType) -> Option<Action> {
    use Action::*;
    const C: gdk::ModifierType = gdk::ModifierType::CONTROL_MASK;
    const S: gdk::ModifierType = gdk::ModifierType::SHIFT_MASK;
    const A: gdk::ModifierType = gdk::ModifierType::MOD1_MASK;
    let none = gdk::ModifierType::empty();
    let digit = |key: &gdk::keys::Key| -> Option<usize> {
        let c = key.to_unicode()?;
        c.to_digit(10).map(|d| d as usize).filter(|&d| (1..=9).contains(&d))
    };
    Some(match mods {
        m if m == C => match key {
            k::t => NewTab,
            k::n => NewWindow,
            k::w | k::F4 => CloseTab,
            k::Tab | k::Page_Down => NextTab,
            k::Page_Up => PrevTab,
            k::l => FocusUrl,
            k::r => Reload,
            k::f => Find,
            k::p => Print,
            k::plus | k::equal | k::KP_Add => ZoomIn,
            k::minus | k::KP_Subtract => ZoomOut,
            k::_0 | k::KP_0 => ZoomReset,
            ref d if digit(d).is_some() => match digit(d)? {
                9 => LastTab,
                n => NthTab { index: n - 1 },
            },
            _ => return None,
        },
        m if m == C | S => match key {
            k::t => ReopenTab,
            k::Tab | k::ISO_Left_Tab => PrevTab,
            k::r => ReloadHard,
            k::i if std::env::var_os("WADBROWSER_DEVTOOLS").is_some() => DevTools,
            k::plus | k::equal => ZoomIn,
            _ => return None,
        },
        m if m == A => match key {
            k::Left => Back,
            k::Right => Forward,
            k::d => FocusUrl,
            k::Home => Home,
            _ => return None,
        },
        m if m == S => match key {
            k::F5 => ReloadHard,
            _ => return None,
        },
        m if m == none => match key {
            k::F5 => Reload,
            k::F6 => FocusUrl,
            k::F11 => Fullscreen,
            k::F12 if std::env::var_os("WADBROWSER_DEVTOOLS").is_some() => DevTools,
            k::Back => Back,
            k::Forward => Forward,
            _ => return None,
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts() {
        let c = gdk::ModifierType::CONTROL_MASK;
        let cs = c | gdk::ModifierType::SHIFT_MASK;
        assert_eq!(action(k::t, c), Some(Action::NewTab));
        assert_eq!(action(k::t, cs), Some(Action::ReopenTab));
        assert_eq!(action(k::_3, c), Some(Action::NthTab { index: 2 }));
        assert_eq!(action(k::_9, c), Some(Action::LastTab));
        assert_eq!(action(k::Left, gdk::ModifierType::MOD1_MASK), Some(Action::Back));
        assert_eq!(action(k::F11, gdk::ModifierType::empty()), Some(Action::Fullscreen));
        // Typing, and editing keys, go to the page.
        assert_eq!(action(k::a, gdk::ModifierType::empty()), None);
        assert_eq!(action(k::c, c), None);
        assert_eq!(action(k::v, c), None);
    }
}
