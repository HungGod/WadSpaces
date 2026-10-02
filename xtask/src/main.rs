//! Repo tasks, run as `cargo xtask <task>`:
//!
//! - `ci`: everything CI checks (Rust fmt, clippy and tests; the UI's
//!   typecheck and tests; wadd-py's tests).
//! - `bindings`: regenerate the UI's TypeScript bindings
//!   (`apps/wadcreator/src/gen/bindings.ts`) from the Tauri commands.

use std::path::PathBuf;
use std::process::{Command, ExitCode};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn run(dir: &str, cmd: &str, args: &[&str]) -> Result<(), String> {
    let dir = root().join(dir);
    eprintln!("$ (cd {}) {cmd} {}", dir.display(), args.join(" "));
    let status = Command::new(cmd).args(args).current_dir(&dir).status().map_err(|e| format!("{cmd}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("{cmd} {} failed ({status})", args.join(" "))) }
}

fn bindings() -> Result<(), String> {
    run(".", "cargo", &["run", "--quiet", "-p", "wadcreator", "--", "--export-bindings"])
}

fn ci() -> Result<(), String> {
    run(".", "cargo", &["fmt", "--all", "--check"])?;
    run(".", "cargo", &["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"])?;
    run(".", "cargo", &["test", "--workspace"])?;
    run("apps/wadcreator", "npm", &["run", "typecheck"])?;
    run("apps/wadcreator", "npm", &["test"])?;
    run("legacy/wadd-py", ".venv/bin/python", &["-m", "pytest", "-q"])
}

fn main() -> ExitCode {
    let task = std::env::args().nth(1).unwrap_or_default();
    let result = match task.as_str() {
        "ci" => ci(),
        "bindings" => bindings(),
        _ => Err("usage: cargo xtask <ci|bindings>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask: {e}");
            ExitCode::FAILURE
        }
    }
}
