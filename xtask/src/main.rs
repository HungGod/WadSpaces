//! Repo tasks, run as `cargo xtask <task>`:
//!
//! - `ci`: everything CI checks (Rust fmt, clippy and tests; the wasm is
//!   current and in budget; the UI's typecheck and tests).
//! - `bindings`: regenerate the UI's TypeScript bindings
//!   (`apps/wadcreator/src/gen/bindings.ts`) from the Tauri commands.
//! - `wasm`: build wad-core for the UI (`apps/wadcreator/src/gen/wasm/`):
//!   wasm-bindgen (the same version as the crate) and wasm-opt (binaryen).

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

/// The UI's wasm stays small: raw and gzipped bytes.
const WASM_BUDGET: (u64, u64) = (400 * 1024, 150 * 1024);

fn wasm() -> Result<(), String> {
    run(
        ".",
        "cargo",
        &["build", "--quiet", "-p", "wad-wasm", "--target", "wasm32-unknown-unknown", "--profile", "wasm"],
    )?;
    let out = "apps/wadcreator/src/gen/wasm";
    run(
        ".",
        "wasm-bindgen",
        &["target/wasm32-unknown-unknown/wasm/wad_wasm.wasm", "--target", "web", "--out-dir", out],
    )?;
    let file = format!("{out}/wad_wasm_bg.wasm");
    run(".", "wasm-opt", &["-Oz", "--all-features", "--strip-debug", &file, "-o", &file])?;
    let raw = std::fs::metadata(root().join(&file)).map_err(|e| e.to_string())?.len();
    let gz =
        Command::new("gzip").args(["-9c", &file]).current_dir(root()).output().map_err(|e| e.to_string())?.stdout.len()
            as u64;
    eprintln!("wasm: {} KB ({} KB gzipped)", raw / 1024, gz / 1024);
    if raw > WASM_BUDGET.0 || gz > WASM_BUDGET.1 {
        return Err(format!("the wasm is over budget ({} / {} KB)", WASM_BUDGET.0 / 1024, WASM_BUDGET.1 / 1024));
    }
    Ok(())
}

fn ci() -> Result<(), String> {
    run(".", "cargo", &["fmt", "--all", "--check"])?;
    run(".", "cargo", &["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"])?;
    run(".", "cargo", &["test", "--workspace"])?;
    // The committed wasm is what wad-core builds now.
    wasm()?;
    run(".", "git", &["diff", "--exit-code", "--stat", "apps/wadcreator/src/gen/"])?;
    run("apps/wadcreator", "npm", &["run", "typecheck"])?;
    run("apps/wadcreator", "npm", &["test"])
}

fn main() -> ExitCode {
    let task = std::env::args().nth(1).unwrap_or_default();
    let result = match task.as_str() {
        "ci" => ci(),
        "bindings" => bindings(),
        "wasm" => wasm(),
        _ => Err("usage: cargo xtask <ci|bindings|wasm>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask: {e}");
            ExitCode::FAILURE
        }
    }
}
