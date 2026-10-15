//! Repo tasks, run as `cargo xtask <task>`:
//!
//! - `ci`: everything CI checks (Rust fmt, clippy and tests; the wasm is
//!   current and in budget; the UI's typecheck and tests).
//! - `wasm`: build wad-core for the UI (`apps/client/src/gen/wasm/`):
//!   wasm-bindgen (the same version as the crate) and wasm-opt (binaryen).
//! - `layer <layers.json> <dir>`: the build folders wadd would build a
//!   wadspace's layers from (`{template, customization}`, as in
//!   images/examples/), written to `<dir>/template` and
//!   `<dir>/customization`; one line per layer on stdout:
//!   `<key> <image ref> <FROM> <sha>`. images/build.sh --example uses it.
//!
//! Its tests check repo files no other crate owns (the base image's start-up
//! banner).

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

/// The UI's wasm stays small: raw and gzipped bytes.
const WASM_BUDGET: (u64, u64) = (400 * 1024, 150 * 1024);

fn wasm() -> Result<(), String> {
    run(
        ".",
        "cargo",
        &["build", "--quiet", "-p", "wad-wasm", "--target", "wasm32-unknown-unknown", "--profile", "wasm"],
    )?;
    let out = "apps/client/src/gen/wasm";
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
    run(".", "git", &["diff", "--exit-code", "--stat", "apps/client/src/gen/"])?;
    run("apps/client", "npm", &["run", "typecheck"])?;
    // WadBrowser's chrome: plain JS with JSDoc types (WadSpaces Client's tsc).
    run("apps/client", "npx", &["tsc", "-p", "../wadbrowser/ui"])?;
    run("apps/client", "npm", &["test"])
}

/// Writes a wadspace's layers' build folders (see the module's docs).
fn layer(docs: &str, dir: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(docs).map_err(|e| format!("{docs}: {e}"))?;
    let docs: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{docs}: {e}"))?;
    let template = &docs["template"];
    let mut layers = vec![("template", wad_core::layers::template_layer(template, &serde_json::Value::Null))];
    if !docs["customization"].is_null() {
        layers.push(("customization", wad_core::layers::extensions_layer(&docs["customization"], template)));
    }
    for (name, l) in layers {
        let out = PathBuf::from(dir).join(name);
        if out.exists() {
            std::fs::remove_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;
        }
        for f in l["files"].as_array().into_iter().flatten() {
            let path = out.join(f["path"].as_str().unwrap_or_default());
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("{}: {e}", path.display()))?;
            std::fs::write(&path, f["content"].as_str().unwrap_or_default())
                .map_err(|e| format!("{}: {e}", path.display()))?;
        }
        let s = |k: &str| l[k].as_str().unwrap_or_default().to_string();
        println!("{} {} {} {}", s("key"), s("ref"), s("from"), s("sha"));
    }
    Ok(())
}

fn main() -> ExitCode {
    let task = std::env::args().nth(1).unwrap_or_default();
    let result = match task.as_str() {
        "ci" => ci(),
        "wasm" => wasm(),
        "layer" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            match args.as_slice() {
                [docs, dir] => layer(docs, dir),
                _ => Err("usage: cargo xtask layer <layers.json> <dir>".into()),
            }
        }
        _ => Err("usage: cargo xtask <ci|wasm|layer>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::root;

    /// The base image's start-up banner (linuxserver's init-adduser prints it
    /// with `cat`): it shows the same in any terminal and in podman logs or
    /// journalctl, so plain printable ASCII, LF line ends, no trailing spaces,
    /// narrower than 80 columns, ending in a newline.
    #[test]
    fn the_branding_is_terminal_safe() {
        let path = root().join("images/base/root/etc/s6-overlay/s6-rc.d/init-adduser/branding");
        let text = std::fs::read(&path).expect("the branding file");
        assert!(text.ends_with(b"\n"), "ends in a newline");
        for (n, line) in text.split(|&b| b == b'\n').enumerate() {
            let n = n + 1;
            assert!(
                line.iter().all(|&b| (b' '..=b'~').contains(&b)),
                "line {n}: printable ASCII only (no tabs, CR or UTF-8)"
            );
            assert!(!line.ends_with(b" "), "line {n}: trailing spaces");
            assert!(line.len() <= 80, "line {n}: wider than 80 columns");
        }
    }
}
