//! The network side runs on tokio (two threads); GTK awaits it from its
//! own loop: `rt::run(fut).await` in a `glib::spawn_future_local`.

use std::future::Future;
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

/// Runs `fut` on tokio; await its answer on the GTK loop.
pub fn run<F>(fut: F) -> impl Future<Output = F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let h = runtime().spawn(fut);
    async move { h.await.expect("a network task panicked") }
}

/// Inside tokio, for code that spawns there itself (wadd's event stream).
pub fn enter() -> tokio::runtime::EnterGuard<'static> {
    runtime().enter()
}
