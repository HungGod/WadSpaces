//! How each catalog app (data/apps.json) gets into an image
//! (src/core/catalog/recipes.ts).

use serde_json::{Value, json};

pub enum Recipe {
    /// A `wadspaces-feature` script; `desktop`: the launchers it writes.
    Feature { feature: &'static str, desktop: &'static [&'static str] },
    /// Debian packages (`wadspaces-apt`); `desktop`: the launcher to use.
    Apt { packages: &'static [&'static str], desktop: Option<&'static str> },
    /// A Chrome --app window (`wadspaces-webapp`).
    Webapp { url: String },
    /// In the base image already.
    Builtin { desktop: &'static str },
    /// Not installable yet.
    Soon { reason: &'static str },
}

impl Recipe {
    pub fn to_json(&self) -> Value {
        match self {
            Recipe::Feature { feature, desktop } => {
                json!({ "kind": "feature", "feature": feature, "desktop": desktop })
            }
            Recipe::Apt { packages, desktop } => match desktop {
                Some(d) => json!({ "kind": "apt", "packages": packages, "desktop": d }),
                None => json!({ "kind": "apt", "packages": packages }),
            },
            Recipe::Webapp { url } => json!({ "kind": "webapp", "url": url }),
            Recipe::Builtin { desktop } => json!({ "kind": "builtin", "desktop": desktop }),
            Recipe::Soon { reason } => json!({ "kind": "soon", "reason": reason }),
        }
    }
}

const AGENT: &str = "AI agents are coming soon";
const THIRD_PARTY: &str = "Needs a third-party package source; coming soon";

fn feature(feature: &'static str, desktop: &'static [&'static str]) -> Recipe {
    Recipe::Feature { feature, desktop }
}
fn apt(packages: &'static [&'static str], desktop: Option<&'static str>) -> Recipe {
    Recipe::Apt { packages, desktop }
}
fn web(url: &str) -> Recipe {
    Recipe::Webapp { url: url.into() }
}
fn soon(reason: &'static str) -> Recipe {
    Recipe::Soon { reason }
}

/// The catalog's recipe for an app id, if it has one.
pub fn recipe(id: &str) -> Option<Recipe> {
    Some(match id {
        // Browsers
        "chrome" => feature("chrome", &["wadspaces-chrome.desktop"]),
        "firefox" => apt(&["firefox-esr"], Some("firefox-esr.desktop")),
        "chromium" => apt(&["chromium"], Some("chromium.desktop")),
        "brave" | "librewolf" | "mullvad-browser" | "vivaldi" => soon(THIRD_PARTY),
        // Development
        "vscode" => feature("vscode", &["wadspaces-vscode.desktop"]),
        "terminal" => Recipe::Builtin { desktop: "foot.desktop" },
        "text-editor" => apt(&["mousepad"], Some("org.xfce.mousepad.desktop")),
        "android-studio" => feature("android-studio", &["wadspaces-android-studio.desktop"]),
        "tiled" => feature("tiled", &["wadspaces-tiled.desktop"]),
        "github" => web("https://github.com"),
        "google-cloud" => web("https://console.cloud.google.com"),
        "openrouter" => web("https://openrouter.ai"),
        "postman" => web("https://web.postman.co"),
        "docker" | "godot" | "unity" | "code-server" | "vscodium" | "intellij-idea" | "pycharm" | "github-desktop" => {
            soon(THIRD_PARTY)
        }
        "wireshark" => apt(&["wireshark"], Some("org.wireshark.Wireshark.desktop")),
        "filezilla" => apt(&["filezilla"], None),
        "remmina" => apt(&["remmina"], Some("org.remmina.Remmina.desktop")),
        "kali-linux" => soon("Kali tools don't fit a Debian desktop image"),
        // AI
        "claude-code" => feature("claude-code", &["wadspaces-claude-code.desktop"]),
        "claude" => web("https://claude.ai"),
        "deepseek" => web("https://chat.deepseek.com"),
        "codex" | "gemini-cli" | "opencode" | "qwen-code" | "aider" | "lm-studio" => soon(AGENT),
        // Creative
        "gimp" => apt(&["gimp"], Some("gimp.desktop")),
        "krita" => apt(&["krita"], Some("org.kde.krita.desktop")),
        "inkscape" => apt(&["inkscape"], Some("org.inkscape.Inkscape.desktop")),
        "blender" => apt(&["blender"], Some("blender.desktop")),
        "figma" => web("https://www.figma.com/files"),
        "aseprite" => soon(THIRD_PARTY),
        "spritesheet-packer" => web("https://www.codeandweb.com/free-sprite-sheet-packer"),
        "piskel" => web("https://www.piskelapp.com/"),
        "audacity" => apt(&["audacity"], Some("audacity.desktop")),
        "obs" => apt(&["obs-studio"], Some("com.obsproject.Studio.desktop")),
        "ardour" => apt(&["ardour"], None),
        "kdenlive" => apt(&["kdenlive"], Some("org.kde.kdenlive.desktop")),
        "shotcut" => apt(&["shotcut"], Some("org.shotcut.Shotcut.desktop")),
        "openshot" => apt(&["openshot-qt"], Some("org.openshot.OpenShot.desktop")),
        "darktable" => apt(&["darktable"], Some("org.darktable.darktable.desktop")),
        "digikam" => apt(&["digikam"], Some("org.kde.digikam.desktop")),
        "rawtherapee" => apt(&["rawtherapee"], Some("rawtherapee.desktop")),
        "freecad" => apt(&["freecad"], None),
        "kicad" => apt(&["kicad"], Some("org.kicad.kicad.desktop")),
        "orcaslicer" | "bambustudio" | "cura" => soon(THIRD_PARTY),
        // Focus, office and study
        "obsidian" => feature("obsidian", &["md.obsidian.Obsidian.desktop"]),
        "notion" => web("https://www.notion.so"),
        "libreoffice" => apt(&["libreoffice"], Some("libreoffice-startcenter.desktop")),
        "onlyoffice" => soon(THIRD_PARTY),
        "zotero" => web("https://www.zotero.org/mylibrary"),
        "calibre" => apt(&["calibre"], Some("calibre-gui.desktop")),
        "google-drive" => web("https://drive.google.com"),
        "gmail" => web("https://mail.google.com"),
        "google-workspace" => web("https://workspace.google.com/dashboard"),
        // Chat and meetings
        "slack" => web("https://app.slack.com/client"),
        "discord" => web("https://discord.com/app"),
        "zoom" => web("https://app.zoom.us/wc"),
        "telegram" => apt(&["telegram-desktop"], Some("org.telegram.desktop.desktop")),
        "signal" => soon(THIRD_PARTY),
        "spotify" => web("https://open.spotify.com"),
        // Games
        "steam" => soon(THIRD_PARTY),
        "retroarch" => apt(&["retroarch"], None),
        "dolphin" => apt(&["dolphin-emu"], Some("dolphin-emu.desktop")),
        "scummvm" => apt(&["scummvm"], Some("org.scummvm.scummvm.desktop")),
        "luanti" => apt(&["luanti"], None),
        _ => return None,
    })
}

/// The recipe for a desktop icon: the catalog's, else (a custom app) the site it opens.
pub fn recipe_for(app_id: &str, domain: Option<&str>) -> Recipe {
    if let Some(r) = recipe(app_id) {
        return r;
    }
    match domain {
        Some(d) if !d.is_empty() => {
            let url = if d.starts_with("http://") || d.starts_with("https://") {
                d.to_string()
            } else {
                format!("https://{d}")
            };
            Recipe::Webapp { url }
        }
        _ => soon("Unknown app"),
    }
}

/// Debian package names: what apt accepts (`/^[a-z0-9][a-z0-9+.-]+$/`).
pub fn is_package(s: &str) -> bool {
    let mut cs = s.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() >= 2
        && cs.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalog_app_has_a_recipe() {
        let missing: Vec<&str> =
            crate::icons::apps().iter().filter_map(|a| a["id"].as_str()).filter(|id| recipe(id).is_none()).collect();
        assert!(missing.is_empty(), "no recipe for {missing:?}");
    }

    #[test]
    fn apt_packages_are_plain_debian_names() {
        for a in crate::icons::apps() {
            if let Some(Recipe::Apt { packages, .. }) = recipe(a["id"].as_str().unwrap()) {
                assert!(packages.iter().all(|p| is_package(p)), "{packages:?}");
            }
        }
    }

    #[test]
    fn an_unknown_app_with_a_site_is_a_web_app() {
        assert!(
            matches!(recipe_for("custom-x1", Some("example.com/app")), Recipe::Webapp { url } if url == "https://example.com/app")
        );
        assert!(matches!(recipe_for("custom-x1", None), Recipe::Soon { .. }));
    }
}
