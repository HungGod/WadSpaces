//! Which keys wadd keeps and which go on to the session: pure, so every rule
//! is tested without a keyboard.
//!
//! What wadd keeps:
//!   Super              never forwarded, so it can't do anything inside a workspace
//!   Super+Tab          open the switcher / next; Super+Shift+Tab: previous
//!   release Super      switch to the selected item; Esc (while open) cancels
//!   Super+<bound key>  its binding (Super+1..9 a workspace, Super+0 Home)
//!   blocked chords     dropped (default Alt+F4, Ctrl+Shift+Q, Ctrl+Alt+Backspace).
//!                      Modifiers must match exactly, so Ctrl+Alt+F1..F12 still
//!                      reach the console.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::keys::{self, Chord, Mod};

pub const UP: i32 = 0;
pub const DOWN: i32 = 1;
pub const REPEAT: i32 = 2;

/// (code, value) of a key event.
pub type Key = (u16, i32);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    CarouselNext,
    CarouselPrev,
    CarouselCommit,
    CarouselCancel,
    /// A Super+key binding's value ("home", "switch:<id>").
    Bound(String),
}

pub struct KeyRouter {
    bindings: HashMap<u16, String>,
    block: Vec<Chord>,
    pass_super: bool,
    /// Physical keys down right now.
    held: HashSet<u16>,
    /// Keys whose down went out: their up must too.
    forwarded: BTreeSet<u16>,
    carousel: bool,
}

impl KeyRouter {
    pub fn new(bindings: HashMap<u16, String>, block: Vec<Chord>, pass_super: bool) -> Self {
        Self { bindings, block, pass_super, held: HashSet::new(), forwarded: BTreeSet::new(), carousel: false }
    }

    pub fn set_bindings(&mut self, bindings: HashMap<u16, String>) {
        self.bindings = bindings;
    }

    fn mods_held(&self) -> BTreeSet<Mod> {
        Mod::ALL.into_iter().filter(|m| m.codes().iter().any(|c| self.held.contains(c))).collect()
    }

    fn holds(&self, m: Mod) -> bool {
        m.codes().iter().any(|c| self.held.contains(c))
    }

    /// One key event in: what to forward, and what to do.
    pub fn feed(&mut self, code: u16, value: i32) -> (Vec<Key>, Option<Action>) {
        match value {
            UP => {
                self.held.remove(&code);
            }
            DOWN => {
                self.held.insert(code);
            }
            _ => {}
        }

        // Ups and repeats follow whatever happened to their key's down.
        if value != DOWN {
            let mut action = None;
            if Mod::Super.codes().contains(&code) && value == UP && !self.holds(Mod::Super) && self.carousel {
                self.carousel = false;
                action = Some(Action::CarouselCommit);
            }
            if self.forwarded.contains(&code) {
                if value == UP {
                    self.forwarded.remove(&code);
                }
                return (vec![(code, value)], action);
            }
            return (vec![], action);
        }

        // A new key down.
        if Mod::Super.codes().contains(&code) {
            return if self.pass_super { self.forward(code) } else { (vec![], None) };
        }
        if self.holds(Mod::Super) {
            if code == keys::TAB {
                self.carousel = true;
                let back = self.holds(Mod::Shift);
                return (vec![], Some(if back { Action::CarouselPrev } else { Action::CarouselNext }));
            }
            if code == keys::ESC && self.carousel {
                self.carousel = false;
                return (vec![], Some(Action::CarouselCancel));
            }
            if let Some(b) = self.bindings.get(&code) {
                return (vec![], Some(Action::Bound(b.clone())));
            }
            // Super is the host's: other Super chords never reach a workspace.
            return if self.pass_super { self.forward(code) } else { (vec![], None) };
        }
        let mods = self.mods_held();
        if self.block.iter().any(|c| c.key == code && c.mods == mods) {
            tracing::info!("blocked a chord (key {code})");
            return (vec![], None);
        }
        self.forward(code)
    }

    fn forward(&mut self, code: u16) -> (Vec<Key>, Option<Action>) {
        self.forwarded.insert(code);
        (vec![(code, DOWN)], None)
    }

    /// Key-ups for everything forwarded, so nothing stays stuck.
    pub fn release_all(&mut self) -> Vec<Key> {
        let out = self.forwarded.iter().map(|c| (*c, UP)).collect();
        self.forwarded.clear();
        self.held.clear();
        self.carousel = false;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::code;

    fn k(name: &str) -> u16 {
        code(name).unwrap()
    }

    fn router(pass_super: bool) -> KeyRouter {
        let bindings = HashMap::from([(k("KEY_1"), "switch:writing".to_string()), (k("KEY_0"), "home".to_string())]);
        let block = ["alt+f4", "ctrl+shift+q", "ctrl+alt+backspace"].iter().map(|c| Chord::parse(c).unwrap()).collect();
        KeyRouter::new(bindings, block, pass_super)
    }

    /// Runs (code, value) pairs: everything forwarded, and the actions.
    fn feed(r: &mut KeyRouter, events: &[(&str, i32)]) -> (Vec<(String, i32)>, Vec<Action>) {
        let names: HashMap<u16, &str> = events.iter().map(|(n, _)| (k(n), *n)).collect();
        let (mut out, mut actions) = (vec![], vec![]);
        for (name, value) in events {
            let (fwd, action) = r.feed(k(name), *value);
            out.extend(fwd.into_iter().map(|(c, v)| (names[&c].to_string(), v)));
            actions.extend(action);
        }
        (out, actions)
    }

    fn keys(list: &[(&str, i32)]) -> Vec<(String, i32)> {
        list.iter().map(|(n, v)| (n.to_string(), *v)).collect()
    }

    const SUPER: &str = "KEY_LEFTMETA";

    #[test]
    fn plain_typing_passes_through_with_repeats() {
        let ev = [("KEY_A", DOWN), ("KEY_A", REPEAT), ("KEY_A", UP)];
        assert_eq!(feed(&mut router(false), &ev), (keys(&ev), vec![]));
    }

    #[test]
    fn super_is_swallowed_and_super_chords_never_reach_the_workspace() {
        let ev = [(SUPER, DOWN), ("KEY_A", DOWN), ("KEY_A", UP), (SUPER, UP)];
        assert_eq!(feed(&mut router(false), &ev), (vec![], vec![]));
    }

    #[test]
    fn super_number_jumps() {
        let ev = [(SUPER, DOWN), ("KEY_1", DOWN), ("KEY_1", UP), (SUPER, UP)];
        assert_eq!(feed(&mut router(false), &ev), (vec![], vec![Action::Bound("switch:writing".into())]));
    }

    #[test]
    fn super_tab_cycles_then_commits_on_release() {
        let ev = [
            (SUPER, DOWN),
            ("KEY_TAB", DOWN),
            ("KEY_TAB", UP),
            ("KEY_TAB", DOWN),
            ("KEY_TAB", UP),
            ("KEY_LEFTSHIFT", DOWN),
            ("KEY_TAB", DOWN),
            ("KEY_TAB", UP),
            ("KEY_LEFTSHIFT", UP),
            (SUPER, UP),
        ];
        use Action::*;
        assert_eq!(
            feed(&mut router(false), &ev),
            (vec![], vec![CarouselNext, CarouselNext, CarouselPrev, CarouselCommit])
        );
    }

    #[test]
    fn esc_cancels_and_release_then_does_nothing() {
        let ev = [(SUPER, DOWN), ("KEY_TAB", DOWN), ("KEY_TAB", UP), ("KEY_ESC", DOWN), ("KEY_ESC", UP), (SUPER, UP)];
        assert_eq!(feed(&mut router(false), &ev), (vec![], vec![Action::CarouselNext, Action::CarouselCancel]));
    }

    #[test]
    fn esc_without_the_switcher_is_just_swallowed_with_super() {
        assert_eq!(feed(&mut router(false), &[(SUPER, DOWN), ("KEY_ESC", DOWN)]).1, vec![]);
    }

    #[test]
    fn alt_f4_is_blocked_but_alt_still_releases() {
        let ev = [("KEY_LEFTALT", DOWN), ("KEY_F4", DOWN), ("KEY_F4", REPEAT), ("KEY_F4", UP), ("KEY_LEFTALT", UP)];
        // The app sees a lone Alt, never F4.
        assert_eq!(feed(&mut router(false), &ev), (keys(&[("KEY_LEFTALT", DOWN), ("KEY_LEFTALT", UP)]), vec![]));
    }

    #[test]
    fn blocking_needs_the_exact_modifiers() {
        // Ctrl+Alt+F4 switches to a text console: alt+f4 mustn't catch it.
        let (out, _) = feed(
            &mut router(false),
            &[("KEY_LEFTCTRL", DOWN), ("KEY_LEFTALT", DOWN), ("KEY_F4", DOWN), ("KEY_F4", UP)],
        );
        assert!(out.contains(&("KEY_F4".into(), DOWN)) && out.contains(&("KEY_F4".into(), UP)));
        let ev = [("KEY_F4", DOWN), ("KEY_F4", UP)];
        assert_eq!(feed(&mut router(false), &ev).0, keys(&ev)); // plain F4 is fine
    }

    #[test]
    fn console_switch_passes() {
        let (out, _) = feed(&mut router(false), &[("KEY_LEFTCTRL", DOWN), ("KEY_LEFTALT", DOWN), ("KEY_F2", DOWN)]);
        assert_eq!(out.last(), Some(&("KEY_F2".into(), DOWN)));
    }

    #[test]
    fn a_key_held_before_super_still_releases() {
        // Shift went out before Super went down: its up must follow.
        let ev = [("KEY_LEFTSHIFT", DOWN), (SUPER, DOWN), ("KEY_TAB", DOWN), ("KEY_LEFTSHIFT", UP), (SUPER, UP)];
        let (out, actions) = feed(&mut router(false), &ev);
        assert_eq!(out, keys(&[("KEY_LEFTSHIFT", DOWN), ("KEY_LEFTSHIFT", UP)]));
        assert_eq!(actions, [Action::CarouselPrev, Action::CarouselCommit]);
    }

    #[test]
    fn pass_super_forwards_other_super_chords() {
        let ev = [(SUPER, DOWN), ("KEY_A", DOWN), ("KEY_A", UP), (SUPER, UP)];
        assert_eq!(feed(&mut router(true), &ev).0, keys(&ev));
    }

    #[test]
    fn release_all_lifts_forwarded_keys() {
        let mut r = router(false);
        feed(&mut r, &[("KEY_LEFTCTRL", DOWN), ("KEY_A", DOWN)]);
        assert_eq!(r.release_all(), [(k("KEY_LEFTCTRL"), UP), (k("KEY_A"), UP)]); // 29 before 30
        assert!(r.release_all().is_empty());
    }

    #[test]
    fn rebinding() {
        let mut r = router(false);
        r.set_bindings(HashMap::from([(k("KEY_2"), "switch:b".to_string())]));
        assert_eq!(feed(&mut r, &[(SUPER, DOWN), ("KEY_1", DOWN)]).1, vec![]);
        assert_eq!(feed(&mut r, &[("KEY_2", DOWN)]).1, vec![Action::Bound("switch:b".into())]);
    }
}
