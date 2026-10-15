//! The network side runs on tokio (two threads); GTK's loop gets its
//! answers through channels.

use std::sync::OnceLock;

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("wad-net")
            .enable_all()
            .build()
            .expect("a tokio runtime")
    })
}

/// Inside tokio, for code that spawns there itself (wadd's event stream).
pub fn enter() -> tokio::runtime::EnterGuard<'static> {
    runtime().enter()
}
