//! wadd's keyboard proxy. Nothing above wadd can reserve a key while a
//! workspace has focus (it gets every key), so wadd owns the keyboards: it
//! grabs each one, keeps Super and its chords (router.rs), and re-types the
//! rest into a virtual keyboard, `wadspaces-kbd`, that the compositor reads
//! like any other.

pub mod keys;
pub mod proxy;
pub mod router;
pub mod uinput;

pub use keys::Chord;
pub use proxy::{Proxy, Status};
pub use router::{Action, KeyRouter};

/// The virtual keyboard's name (never grabbed: it's our own output).
pub const VIRTUAL_NAME: &str = "wadspaces-kbd";
