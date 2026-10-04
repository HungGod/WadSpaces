//! wadspaces-icon: a web app's icon, for images built without wadd (and by
//! hand). Inside a build, wadspaces-webapp runs `fallback` when Wad Creator
//! gave no icon: nothing is fetched while an image builds.
//!
//!   wadspaces-icon fallback --url <site> --out <png>    the text card
//!   wadspaces-icon fetch --url <site> --out <png> [--cache <dir>]
//!   wadspaces-icon card --in <picture> --out <png>       a picture's silhouette card

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;
use wad_icons::{Resolver, cache::Cache, decode, label_for, png, style};

#[derive(Parser)]
#[command(about = "Web app icons for WadSpaces images")]
struct Args {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// The text card for a site (its host's name).
    Fallback {
        #[arg(long)]
        url: String,
        #[arg(long)]
        out: PathBuf,
    },
    /// The site's own icon as a card (the text card if it has none).
    Fetch {
        #[arg(long)]
        url: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        cache: Option<PathBuf>,
    },
    /// A picture on disk as a silhouette card.
    Card {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
}

fn main() -> ExitCode {
    let bytes = match Args::parse().cmd {
        Cmd::Fallback { url, out } => (png(&style::text_card(&label_for(&url))), out),
        Cmd::Fetch { url, out, cache } => {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
            let icon = rt.block_on(Resolver::new(cache.map(Cache::new)).site(&url));
            eprintln!("wadspaces-icon: {url}: {:?}", icon.source);
            (icon.png, out)
        }
        Cmd::Card { input, out } => match std::fs::read(&input).ok().and_then(|b| decode::decode(&b)) {
            Some(img) => (png(&style::card(&img)), out),
            None => {
                eprintln!("wadspaces-icon: {} isn't a picture this reads", input.display());
                return ExitCode::from(1);
            }
        },
    };
    let (png, out) = bytes;
    if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(&out, png) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("wadspaces-icon: {}: {e}", out.display());
            ExitCode::from(1)
        }
    }
}
