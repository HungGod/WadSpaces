//! `wadd`: the WadSpaces machine daemon.
//!
//!   wadd serve            as a machine's system service (wadd.service)
//!   wadd serve --user     on a laptop, as you (rootless)
//!   wadd keys             try the keyboard proxy for a while (as root)
//!   wadd view             view a stream from here without the account (trying it)
//!   wadd version

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};
use wad_config::{Config, Profile};
use wadd::backend::{self, Backend};
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
    /// Moves this machine over from the Python wadd (once; wadd.service runs
    /// it before each start).
    Migrate {
        /// Only say what would happen.
        #[arg(long)]
        dry_run: bool,
        /// Run it again even though it's done.
        #[arg(long)]
        force: bool,
        /// As JSON.
        #[arg(long)]
        json: bool,
        /// The Python wadd's workspaces.yaml (default: the config's).
        #[arg(long)]
        from: Option<PathBuf>,
        /// Read the laptop profile's config.
        #[arg(long)]
        user: bool,
    },
    /// Try the keyboard proxy for a while: grabs the keyboards (as root),
    /// passes typing on, and prints what Super chords would do. Every key is
    /// let go when it ends (and the kernel drops the grab if it dies).
    Keys {
        /// How long, in seconds (at most 120).
        #[arg(long, default_value_t = 20)]
        seconds: u64,
        /// Only watch for chords; filter nothing.
        #[arg(long)]
        no_grab: bool,
    },
    /// Views a stream from here without the account (trying streams out):
    /// prints the address to open, and keeps the view until stopped.
    View {
        /// The stream's link (https://<address>:<port>/).
        #[arg(long)]
        url: String,
        /// Its certificate's SHA-256 (from GET /v1/streams on that machine).
        #[arg(long)]
        sha256: String,
        #[arg(long)]
        user: String,
        /// A file holding the stream password (not on the command line).
        #[arg(long)]
        password_file: PathBuf,
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
        Cmd::Migrate { dry_run, force, json, from, user } => migrate(dry_run, force, json, from, user),
        Cmd::Keys { seconds, no_grab } => keys(seconds.min(120), !no_grab),
        Cmd::View { url, sha256, user, password_file } => view(url, sha256, user, password_file),
    }
}

fn view(url: String, sha256: String, user: String, password_file: PathBuf) -> ExitCode {
    let password = match std::fs::read_to_string(&password_file) {
        Ok(p) => p.trim().to_string(),
        Err(e) => {
            eprintln!("wadd view: {}: {e}", password_file.display());
            return ExitCode::FAILURE;
        }
    };
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("a runtime");
    rt.block_on(async {
        let views = wadd::remote::RemoteViews::new(std::time::Duration::from_secs(3600));
        let target =
            wadd::remote::Target { machine: "the stream".into(), urls: vec![url], user, sha256: sha256.to_lowercase() };
        match views.open(target, &password).await {
            Ok(v) => {
                println!("{}", v.url);
                let _ = tokio::signal::ctrl_c().await;
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("wadd view: {}", e.message);
                ExitCode::FAILURE
            }
        }
    })
}

fn keys(seconds: u64, grab: bool) -> ExitCode {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::new("info")).init();
    let cfg = wad_config::Keys::for_profile(Profile::System);
    let mut bindings = std::collections::HashMap::new();
    for k in &cfg.home {
        if let Ok(c) = wad_input::keys::code(k) {
            bindings.insert(c, "home".to_string());
        }
    }
    for n in 1..=9u8 {
        bindings
            .insert(wad_input::keys::code(&n.to_string()).expect("digits are keys"), format!("switch:<hotkey {n}>"));
    }
    let block = cfg.block.iter().filter_map(|c| wad_input::Chord::parse(c).ok()).collect();
    let router = wad_input::KeyRouter::new(bindings, block, false);
    println!("For {seconds} s: try Super+Tab (hold Super), Super+1..9, Super+0, Alt+F4. Typing still works.");
    let proxy = wad_input::Proxy::start(router, grab, |a| println!("  -> {a:?}"));
    std::thread::sleep(std::time::Duration::from_millis(2500));
    let st = proxy.status();
    println!(
        "grabbing: {}, keyboards: {:?}{}",
        st.grabbing,
        st.keyboards,
        st.note.map(|n| format!(" ({n})")).unwrap_or_default()
    );
    std::thread::sleep(std::time::Duration::from_secs(seconds.saturating_sub(2)));
    drop(proxy);
    println!("done: keyboards released");
    ExitCode::SUCCESS
}

fn migrate(dry_run: bool, force: bool, json: bool, from: Option<PathBuf>, user: bool) -> ExitCode {
    let profile = if user { Profile::User } else { Profile::System };
    let mut cfg = match Config::load(profile, &Config::files(profile)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("wadd: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(f) = from {
        cfg.daemon.legacy_config = f;
    }
    if dry_run {
        let plan = wad_store::migrate::plan(&cfg.daemon.legacy_config, Some(&cfg.daemon.vendor_cloud));
        if json {
            println!("{}", serde_json::to_string_pretty(&plan).expect("plans serialize"));
        } else {
            print!("{}", plan.text());
        }
        return ExitCode::SUCCESS;
    }
    tracing_subscriber::fmt().with_env_filter(EnvFilter::new("info")).with_writer(std::io::stderr).init();
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("wadd: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = rt.block_on(async {
        let backend = backend::connect(&cfg.daemon, profile).await.inspect_err(|e| eprintln!("wadd migrate: {e}")).ok();
        wadd::migrate::apply(&cfg, backend.as_ref().map(|b| b as &dyn Backend), force).await
    });
    match result {
        Ok(report) => {
            for line in report {
                println!("wadd migrate: {line}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("wadd migrate: {e}");
            ExitCode::FAILURE
        }
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
        let backend: Arc<dyn Backend> = match backend::connect(&cfg.daemon, profile).await {
            Ok(real) => Arc::new(real),
            Err(e) => {
                tracing::error!("can't manage workspaces: {e}");
                Arc::new(backend::Offline(e))
            }
        };
        let mut server = Server::new(&cfg, profile, listen, logs, backend)?;
        let nm = wad_net::NetworkManager::system().await.inspect_err(|e| tracing::warn!("no NetworkManager: {e}")).ok();
        let power = wad_systemd::Power::system().await.inspect_err(|e| tracing::warn!("no logind: {e}")).ok();
        server.set_machine(nm, power);
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
