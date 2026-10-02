//! Key names (linux/input-event-codes.h, as "KEY_A" or just "a") and chords
//! like "ctrl+alt+backspace".

use std::collections::BTreeSet;
use std::str::FromStr;

pub const ESC: u16 = 1;
pub const TAB: u16 = 15;
pub const KEY_A: u16 = 30;
pub const KEY_1: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mod {
    Ctrl,
    Shift,
    Alt,
    Super,
}

impl Mod {
    pub const ALL: [Mod; 4] = [Mod::Ctrl, Mod::Shift, Mod::Alt, Mod::Super];

    /// Left and right.
    pub fn codes(self) -> [u16; 2] {
        match self {
            Mod::Ctrl => [29, 97],
            Mod::Shift => [42, 54],
            Mod::Alt => [56, 100],
            Mod::Super => [125, 126],
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "ctrl" => Some(Mod::Ctrl),
            "shift" => Some(Mod::Shift),
            "alt" => Some(Mod::Alt),
            "super" => Some(Mod::Super),
            _ => None,
        }
    }
}

/// A key's code from its name: "KEY_F4", "f4", "0".
pub fn code(name: &str) -> Result<u16, String> {
    let upper = name.trim().to_ascii_uppercase();
    let full = if upper.starts_with("KEY_") { upper } else { format!("KEY_{upper}") };
    evdev::KeyCode::from_str(&full).map(|k| k.code()).map_err(|_| format!("unknown key name {name:?}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub mods: BTreeSet<Mod>,
    pub key: u16,
}

impl Chord {
    /// "alt+f4", "ctrl+shift+q", "ctrl+alt+KEY_BACKSPACE".
    pub fn parse(text: &str) -> Result<Self, String> {
        let parts: Vec<&str> = text.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
        let Some((key, mods)) = parts.split_last() else {
            return Err(format!("empty chord {text:?}"));
        };
        let mods = mods
            .iter()
            .map(|m| {
                Mod::parse(&m.to_ascii_lowercase()).ok_or_else(|| format!("chord {text:?}: unknown modifier {m:?}"))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { mods, key: code(key)? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(code("KEY_0"), Ok(11));
        assert_eq!(code("1"), Ok(KEY_1));
        assert_eq!(code("f4"), Ok(62));
        assert_eq!(code("KEY_SPACE"), Ok(57));
        assert!(code("nosuchkey").is_err());
    }

    #[test]
    fn chords() {
        let c = Chord::parse("Ctrl+Alt+Backspace").unwrap();
        assert_eq!(c, Chord { mods: BTreeSet::from([Mod::Ctrl, Mod::Alt]), key: 14 });
        assert_eq!(Chord::parse("alt+KEY_F4").unwrap().key, 62);
        assert!(Chord::parse("hyper+f4").is_err());
        assert!(Chord::parse("alt+nosuchkey").is_err());
        assert!(Chord::parse("").is_err());
    }
}
