//! For dev/try.sh: copies a password the way KeePassXC does (the text plus
//! the password-manager hint), then clears it, like its clipboard timeout.
//!
//!   cargo run -p wad-clip --example password-manager -- <socket> <password> <seconds>

use std::sync::Arc;
use std::time::Duration;

use wad_clip::{Content, Item, content, wl};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [socket, password, seconds] = args.as_slice() else {
        eprintln!("usage: password-manager <socket> <password> <seconds>");
        std::process::exit(2);
    };
    let board = wl::watch(&wl::socket_path(socket), "password-manager", |_| {}).expect("a compositor");
    let item = |mime: &str, data: &str| Item { mime: mime.into(), data: data.as_bytes().to_vec() };
    board.set(Arc::new(Content {
        items: vec![item("text/plain;charset=utf-8", password), item(content::PASSWORD_HINT, "secret")],
    }));
    std::thread::sleep(Duration::from_secs_f64(seconds.parse().unwrap_or(1.0)));
    board.clear();
    std::thread::sleep(Duration::from_millis(300));
}
