//! One WadBrowser per user: every window, of every web app, lives in one
//! process (one network process, one cache, live tab moves between windows).
//!
//! The first launch listens on `$XDG_RUNTIME_DIR/wadbrowser/ctl.sock`; a later
//! one hands its request over and exits before GTK even starts, so a link
//! opens in a few milliseconds. A lock file decides who's first when two start
//! at once.

use crate::cli::Request;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

pub enum Claim {
    /// This process is the browser: requests arrive here.
    Primary(UnixListener),
    /// The browser already running has the request.
    Forwarded,
}

pub fn dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d).join("wadbrowser"),
        // SAFETY: getuid can't fail.
        _ => std::env::temp_dir().join(format!("wadbrowser-{}", unsafe { libc::getuid() })),
    }
}

/// Hands `req` to a running browser, or becomes the browser.
pub fn claim(req: &Request) -> std::io::Result<Claim> {
    let dir = dir();
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let sock = dir.join("ctl.sock");
    let lock = File::create(dir.join("ctl.lock"))?;
    lock.lock()?;
    if forward(&sock, req).is_ok() {
        return Ok(Claim::Forwarded);
    }
    // Nobody answered: an old socket is a crashed browser's.
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    listener.set_nonblocking(true)?;
    // The lock is released as `lock` drops: the socket is up by then.
    Ok(Claim::Primary(listener))
}

fn forward(sock: &PathBuf, req: &Request) -> std::io::Result<()> {
    let mut stream = UnixStream::connect(sock)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut line = serde_json::to_vec(req).map_err(std::io::Error::other)?;
    line.push(b'\n');
    stream.write_all(&line)?;
    let mut ack = String::new();
    BufReader::new(stream).read_line(&mut ack)?;
    if ack.trim() == "ok" { Ok(()) } else { Err(std::io::Error::other(format!("browser said {ack:?}"))) }
}

/// The requests waiting on `listener` (it's non-blocking: none is fine).
pub fn accept(listener: &UnixListener) -> Vec<Request> {
    let mut out = Vec::new();
    while let Ok((stream, _)) = listener.accept() {
        // Only this user can reach the socket (its folder is 0700).
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut reader = BufReader::new(&stream);
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(req) => {
                let _ = (&stream).write_all(b"ok\n");
                out.push(req);
            }
            Err(e) => {
                let _ = (&stream).write_all(b"bad request\n");
                tracing::warn!(%e, "a bad request on the socket");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_launch_forwards() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: tests in this module run alone; nothing else reads it.
        unsafe { std::env::set_var("XDG_RUNTIME_DIR", dir.path()) };
        let Claim::Primary(listener) = claim(&Request::default()).unwrap() else { panic!("first should listen") };
        let req = Request { urls: vec!["https://x.example".into()], ..Default::default() };
        let sent = req.clone();
        let t = std::thread::spawn(move || matches!(claim(&sent).unwrap(), Claim::Forwarded));
        let mut got = Vec::new();
        for _ in 0..200 {
            got.extend(accept(&listener));
            if !got.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(t.join().unwrap());
        assert_eq!(got, [req]);

        // The browser gone, its socket left behind: the next launch takes over.
        drop(listener);
        assert!(matches!(claim(&Request::default()).unwrap(), Claim::Primary(_)));
    }
}
