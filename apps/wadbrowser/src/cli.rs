//! What a launch asks for. Launchers pass `%U` (any number of addresses), and
//! old KaleBrowser launchers pass flags of Electron's: unknown flags are
//! ignored rather than refused, so a link always opens.
//!
//! ```text
//! wadbrowser [URL...]                       a browser window (URL bar)
//! wadbrowser --no-urlbar [URL...]           WadBrowser Focus (no URL bar)
//! wadbrowser --default [URL...]             whichever the workspace chose (links)
//! wadbrowser --app <id> --name <name> --url <start> [URL...]
//!                                           a web app's window (wadspaces-webapp-<id>)
//!   --new-window  --profile <p>  --gpu auto|on|off  --icon <png>
//!   --config <json>                         a KaleBrowser app (its config.json)
//! wadbrowser --instance <id> [--setup <file.json>]
//!                                           a WadBrowser of its own (instance.rs),
//!                                           set up as the file says (Setup)
//! ```

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// A WadBrowser setup (wadd writes it for a launch from WadSpaces): WadBrowser
/// or Focus, and web apps each in a window of its own, with the saved sign-in
/// each uses (by id); one without is "Don't save": an ephemeral profile.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setup {
    /// "browser" (an address bar) or "focus".
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub webapps: Vec<SetupApp>,
    /// Web app id → saved sign-in id.
    #[serde(default)]
    pub signins: BTreeMap<String, String>,
    /// A throwaway run: nothing of it is kept, not even its windows.
    #[serde(default)]
    pub ephemeral: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupApp {
    pub id: String,
    pub name: String,
    pub url: String,
}

impl Setup {
    /// Reads and checks a setup file.
    pub fn read(path: &str) -> Result<Setup, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("--setup {path}: {e}"))?;
        let s: Setup = serde_json::from_str(&text).map_err(|e| format!("--setup {path}: {e}"))?;
        if !matches!(s.mode.as_str(), "" | "browser" | "focus") {
            return Err(format!("--setup {path}: mode {:?} isn't browser or focus", s.mode));
        }
        if let Some(w) = s.webapps.iter().find(|w| !web_app_id(&w.id)) {
            return Err(format!("--setup {path}: {:?} isn't an app id (a-z, 0-9, -)", w.id));
        }
        Ok(s)
    }

    pub fn focus(&self) -> bool {
        self.mode == "focus"
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    /// A web app's window: its app_id (`wadspaces-webapp-<id>`).
    pub app_id: Option<String>,
    pub name: Option<String>,
    /// A web app's start page (`--url`).
    pub start: Option<String>,
    /// Pages to open (the arguments).
    pub urls: Vec<String>,
    pub no_urlbar: bool,
    /// The workspace's default kind of window (the link handler).
    pub default: bool,
    pub new_window: bool,
    pub profile: Option<String>,
    /// A picture for the app's window (absolute path).
    pub icon: Option<String>,
    pub gpu: Option<String>,
    /// From the launcher's environment: lets the window take focus.
    pub activation_token: Option<String>,
    /// A WadBrowser of its own (`--instance`), and how it's set up (`--setup`).
    pub instance: Option<String>,
    pub setup: Option<Setup>,
    pub version: bool,
    pub help: bool,
}

pub const USAGE: &str = "usage: wadbrowser [--no-urlbar | --default] [--new-window] [URL...]
       wadbrowser --app <id> --name <name> --url <start> [URL...]
       wadbrowser --instance <id> [--setup <setup.json>] [URL...]
options: --profile <name>  --gpu auto|on|off  --icon <png>  --config <kalebrowser.json>";

/// Reads `args` (without the program name), `cwd` for relative paths.
pub fn parse(args: impl IntoIterator<Item = String>, cwd: &Path) -> Result<Request, String> {
    let mut req = Request::default();
    let mut args = args.into_iter().peekable();
    let mut only_urls = false;
    while let Some(arg) = args.next() {
        if only_urls || !arg.starts_with('-') || arg == "-" {
            if !arg.is_empty() {
                req.urls.push(arg);
            }
            continue;
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_owned(), Some(v.to_owned())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| -> Result<String, String> {
            match inline.clone().or_else(|| args.next()) {
                Some(v) => Ok(v),
                None => Err(format!("{name} needs a value")),
            }
        };
        match flag.as_str() {
            "--" => only_urls = true,
            "--app" => {
                let id = value("--app")?;
                if !web_app_id(&id) {
                    return Err(format!("--app: {id:?} isn't an app id (a-z, 0-9, -)"));
                }
                req.app_id = Some(format!("wadspaces-webapp-{id}"));
            }
            "--name" => req.name = Some(value("--name")?),
            "--url" | "-u" => req.start = Some(value("--url")?),
            "--no-urlbar" | "--focus" => req.no_urlbar = true,
            "--default" => req.default = true,
            "--new-window" => req.new_window = true,
            "--profile" => req.profile = Some(value("--profile")?).filter(|p| profile_name(p)),
            "--gpu" => req.gpu = Some(value("--gpu")?),
            "--icon" | "-I" => req.icon = Some(absolute(&value("--icon")?, cwd)),
            "--config" | "-c" => legacy_config(&absolute(&value("--config")?, cwd), &mut req)?,
            "--instance" => {
                let id = value("--instance")?;
                if !web_app_id(&id) {
                    return Err(format!("--instance: {id:?} isn't an id (a-z, 0-9, -)"));
                }
                req.instance = Some(id);
            }
            "--setup" => req.setup = Some(Setup::read(&absolute(&value("--setup")?, cwd))?),
            "--version" | "-V" => req.version = true,
            "--help" | "-h" => req.help = true,
            // Electron's (--no-sandbox, --ozone-platform=…) and anything new.
            other => tracing::debug!(other, "ignored"),
        }
    }
    Ok(req)
}

/// A KaleBrowser app's config.json: {app_name, app_url, icon_path, wm_class}.
/// Its window keeps the old WM class, so its old launcher still matches it.
fn legacy_config(path: &str, req: &mut Request) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("--config {path}: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("--config {path}: {e}"))?;
    let dir = Path::new(path).parent().unwrap_or(Path::new("/"));
    req.name = v["app_name"].as_str().map(str::to_owned).or(req.name.take());
    req.start = v["app_url"].as_str().map(str::to_owned).or(req.start.take());
    req.icon = v["icon_path"].as_str().map(|p| absolute(p, dir)).or(req.icon.take());
    req.app_id = v["wm_class"].as_str().filter(|c| crate::app_id::valid(c)).map(str::to_owned).or(req.app_id.take());
    if req.app_id.is_none() {
        let slug = slug(req.name.as_deref().unwrap_or("app"));
        req.app_id = Some(format!("wadspaces-webapp-{slug}"));
    }
    Ok(())
}

fn absolute(p: &str, cwd: &Path) -> String {
    let p = Path::new(p);
    if p.is_absolute() { p.to_string_lossy().into() } else { cwd.join(p).to_string_lossy().into() }
}

/// WadSpaces Client's app ids: lower-case letters, digits and dashes.
pub fn web_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn profile_name(p: &str) -> bool {
    web_app_id(p)
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() { "app".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Request {
        parse(args.iter().map(|s| s.to_string()), Path::new("/home/abc")).unwrap()
    }

    #[test]
    fn browser_launches() {
        assert_eq!(p(&[]), Request::default());
        let r = p(&["https://a.example", "b.example"]);
        assert_eq!(r.urls, ["https://a.example", "b.example"]);
        assert!(p(&["--no-urlbar"]).no_urlbar);
        let r = p(&["--default", "--new-window", "https://x.example"]);
        assert!(r.default && r.new_window);
    }

    #[test]
    fn web_apps() {
        let r = p(&["--app", "claude", "--name=Claude", "--url", "https://claude.ai", "%U"]);
        assert_eq!(r.app_id.as_deref(), Some("wadspaces-webapp-claude"));
        assert_eq!(r.name.as_deref(), Some("Claude"));
        assert_eq!(r.start.as_deref(), Some("https://claude.ai"));
        // An unexpanded %U is just a word; the window ignores what isn't an address.
        assert_eq!(r.urls, ["%U"]);
        assert!(parse(["--app".into(), "Not An Id".into()], Path::new("/")).is_err());
        assert!(parse(["--app".into()], Path::new("/")).is_err());
    }

    #[test]
    fn electron_flags_are_ignored() {
        let r = p(&["--no-sandbox", "--ozone-platform=wayland", "https://x.example"]);
        assert_eq!(r.urls, ["https://x.example"]);
    }

    #[test]
    fn kalebrowser_configs() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.json");
        std::fs::write(
            &cfg,
            r#"{"app_name":"Open Router","app_url":"https://openrouter.ai","icon_path":"open-router.png","wm_class":"WADspaces-open-router"}"#,
        )
        .unwrap();
        let r = p(&["--config", cfg.to_str().unwrap()]);
        assert_eq!(r.app_id.as_deref(), Some("WADspaces-open-router"));
        assert_eq!(r.start.as_deref(), Some("https://openrouter.ai"));
        assert_eq!(r.icon, Some(dir.path().join("open-router.png").to_string_lossy().into()));
    }

    #[test]
    fn instances_and_setups() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("setup.json");
        std::fs::write(
            &file,
            r#"{"mode":"focus","webapps":[{"id":"gmail","name":"Gmail","url":"https://mail.google.com"},
               {"id":"drive","name":"Drive","url":"https://drive.google.com"}],"signins":{"gmail":"s1"}}"#,
        )
        .unwrap();
        let r = p(&["--instance", "browser-mail", "--setup", file.to_str().unwrap()]);
        assert_eq!(r.instance.as_deref(), Some("browser-mail"));
        let s = r.setup.unwrap();
        assert!(s.focus() && !s.ephemeral);
        assert_eq!(s.webapps.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["gmail", "drive"]);
        assert_eq!(s.signins.get("gmail").map(String::as_str), Some("s1"));
        // A request with a setup crosses the socket whole.
        let req = p(&["--instance=focus", "--setup", file.to_str().unwrap()]);
        let back: Request = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);
        // No setup at all is a plain WadBrowser of its own.
        assert_eq!(p(&["--instance", "focus", "--no-urlbar"]).setup, None);
    }

    #[test]
    fn bad_instances_and_setups_are_refused() {
        let bad = |args: &[&str]| parse(args.iter().map(|s| s.to_string()), Path::new("/")).is_err();
        assert!(bad(&["--instance", "Not An Id"]));
        assert!(bad(&["--instance", "../x"]));
        assert!(bad(&["--setup", "/nonexistent/setup.json"]));
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in [
            ("mode", r#"{"mode":"kiosk"}"#),
            ("id", r#"{"webapps":[{"id":"Bad Id","name":"x","url":"https://x"}]}"#),
            ("json", "{"),
        ] {
            let f = dir.path().join(name);
            std::fs::write(&f, text).unwrap();
            assert!(bad(&["--setup", f.to_str().unwrap()]), "{name}");
        }
        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, "{}").unwrap();
        let s = p(&["--setup", empty.to_str().unwrap()]).setup.unwrap();
        assert!(s.webapps.is_empty() && !s.focus());
    }

    #[test]
    fn icons_are_made_absolute() {
        assert_eq!(p(&["-I", "icons/x.png"]).icon.as_deref(), Some("/home/abc/icons/x.png"));
        assert_eq!(slug("Open Router!"), "open-router");
    }
}
