//! Inside a wadspace: its clipboard (labwc's, $WAYLAND_DISPLAY) and the
//! machine's (sway's, the display labwc draws on) as one. A copy on either
//! side is copied on the other.
//!
//!   wadspaces-clipboard [--host <socket>]    (else $WADSPACES_HOST_WAYLAND)
//!
//! It ends when either side does (labwc, or the display going away); labwc's
//! autostart starts it again with the next labwc.

use std::process::ExitCode;
use std::sync::{Arc, mpsc};

use wad_clip::{Change, wl};

#[derive(Debug, Clone, Copy, PartialEq)]
enum Side {
    Here,
    Machine,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("wadspaces-clipboard {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let host = match args.as_slice() {
        [flag, socket] if flag == "--host" => Some(socket.clone()),
        [] => std::env::var("WADSPACES_HOST_WAYLAND").ok().filter(|s| !s.is_empty()),
        _ => None,
    };
    let Some(host) = host else {
        eprintln!("usage: wadspaces-clipboard [--host <wayland socket>]  (or WADSPACES_HOST_WAYLAND)");
        return ExitCode::from(2);
    };
    // Unique per run: a new bridge doesn't take an old one's copies for its own.
    let name = nix::unistd::gethostname().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    let me = format!("ws-{name}-{}", std::process::id());

    let (tx, rx) = mpsc::channel();
    let watch = |socket: std::path::PathBuf, side: Side| {
        let tx = tx.clone();
        wl::watch(&socket, &me, move |c| {
            let _ = tx.send((side, c));
        })
        .map_err(|e| format!("{side:?}: {e}"))
    };
    let (here, machine) = match (watch(wl::env_socket(), Side::Here), watch(wl::socket_path(&host), Side::Machine)) {
        (Ok(h), Ok(m)) => (h, m),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("wadspaces-clipboard: not shared: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!("wadspaces-clipboard: this wadspace's clipboard is the machine's");

    // The last copy carried either way: it comes back from the other side
    // (another wadspace's bridge, the HUD), and needn't go round again.
    let mut last = 0u64;
    // Where the last copy came from, if it was a password.
    let mut secret_from = None;
    let other = |side| match side {
        Side::Here => &machine,
        Side::Machine => &here,
    };
    for (side, change) in rx {
        match change {
            Change::Copied(c) => {
                let digest = c.digest();
                if digest == last {
                    continue;
                }
                last = digest;
                secret_from = c.secret().then_some(side);
                other(side).set(Arc::new(c));
            }
            // A password manager clearing its copy clears it everywhere.
            Change::Cleared if secret_from == Some(side) => {
                secret_from = None;
                last = 0;
                other(side).clear();
            }
            // Otherwise a copy outlives its app: the other side keeps ours.
            Change::Cleared => {}
            Change::Closed(why) => {
                eprintln!("wadspaces-clipboard: {side:?} ended: {why}");
                return ExitCode::SUCCESS;
            }
        }
    }
    ExitCode::SUCCESS
}
