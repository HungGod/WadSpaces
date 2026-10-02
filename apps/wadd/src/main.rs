//! `wadd`: the WadSpaces machine daemon.
//!
//!   wadd serve            as a machine's system service (wadd.service)
//!   wadd serve --user     on a laptop, as you (rootless)
//!   wadd version

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};
use wad_config::{Config, Profile};
use wadd::logbuf::{BufferLayer, LogBuffer};
use wadd::{Listen, Server, systemd};

#[derive(Parser)]
#[command(name = "wadd", about = "The WadSpaces machine daemon")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the daemon.
    Serve {
        /// As you, on a laptop: rootless podman, your paths, your socket.
        #[arg(long)]
        user: bool,
        /// Read this file after the defaults, instead of the usual ones.
        #[arg(long)]
        config: Option<PathBuf>,
        /// Listen here (when systemd doesn't hand over a socket).
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Print the version.
    Version,
}

fn main() -> ExitCode {
    match Cli::parse().cmd {
        Cmd::Version => {
            println!("wadd {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Cmd::Serve { user, config, socket } => serve(user, config, socket),
    }
}

fn serve(user: bool, config: Option<PathBuf>, socket: Option<PathBuf>) -> ExitCode {
    let profile = if user { Profile::User } else { Profile::System };
    // Before any threads: take systemd's socket, if it gave us one.
    let activated = systemd::listener_from_systemd();
    let files = config.map(|c| vec![c]).unwrap_or_else(|| Config::files(profile));
    let cfg = match Config::load(profile, &files) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("wadd: {e}");
            return ExitCode::FAILURE;
        }
    };
    let logs = LogBuffer::new(cfg.log.buffer_lines);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&cfg.log.level));
    tracing_subscriber::registry()
        .with(BufferLayer { buffer: logs.clone(), to_stderr: true }.with_filter(filter))
        .init();

    let listen = match activated {
        Some(l) => Listen::Activated(l),
        None => Listen::Path(socket.unwrap_or_else(|| cfg.daemon.socket.clone())),
    };
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("wadd: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = rt.block_on(async move {
        let server = Server::new(&cfg, profile, listen, logs)?;
        match &server.bound {
            Some(p) => tracing::info!("wadd {} listening on {}", env!("CARGO_PKG_VERSION"), p.display()),
            None => tracing::info!("wadd {} listening on the socket systemd passed", env!("CARGO_PKG_VERSION")),
        }
        systemd::notify("READY=1");
        server.run(shutdown_signal()).await
    });
    match result {
        Ok(()) => {
            tracing::info!("wadd stopped");
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!("wadd: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    systemd::notify("STOPPING=1");
}
