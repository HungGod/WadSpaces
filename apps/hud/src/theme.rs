//! The HUD in the site's colours (apps/wadcreator/src/styles/globals.css),
//! dark or light as Wad Creator is: the app writes its choice to
//! ~/.config/wadspaces/theme (src-tauri/src/theme.rs), and the HUD follows
//! that file.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    Dark,
    Light,
}

impl Theme {
    pub fn parse(s: &str) -> Theme {
        if s.trim() == "light" { Theme::Light } else { Theme::Dark }
    }
}

/// Where Wad Creator keeps its theme for the HUD.
pub fn file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    config.join("wadspaces/theme")
}

/// The theme now (dark until the app says otherwise). WADSPACES_HUD_THEME wins (snapshots).
pub fn current() -> Theme {
    if let Ok(t) = std::env::var("WADSPACES_HUD_THEME") {
        return Theme::parse(&t);
    }
    std::fs::read_to_string(file()).map(|s| Theme::parse(&s)).unwrap_or(Theme::Dark)
}

/// The site's tokens, as GTK named colours.
fn palette(t: Theme) -> &'static str {
    match t {
        Theme::Dark => {
            "@define-color bg #0a0614;
@define-color surface #140d22;
@define-color surface2 #1b132d;
@define-color surface3 #241a39;
@define-color line rgba(240, 234, 250, 0.09);
@define-color line_strong rgba(240, 234, 250, 0.18);
@define-color fg #f5f2fa;
@define-color muted rgba(245, 242, 250, 0.62);
@define-color faint rgba(245, 242, 250, 0.4);
@define-color accent #c6ff1f;
@define-color accent_fg #0a0614;
@define-color accent_soft rgba(198, 255, 31, 0.2);
@define-color accent2 #ff3d81;
@define-color danger #ff5d7a;
@define-color warn #e8c36a;
@define-color dim rgba(3, 2, 8, 0.62);
"
        }
        // The site's light theme is strictly greyscale.
        Theme::Light => {
            "@define-color bg #f4f4f4;
@define-color surface #ffffff;
@define-color surface2 #f6f6f6;
@define-color surface3 #ebebeb;
@define-color line rgba(10, 6, 20, 0.09);
@define-color line_strong rgba(10, 6, 20, 0.18);
@define-color fg #0a0614;
@define-color muted #5f5f5f;
@define-color faint #9a9a9a;
@define-color accent #0a0614;
@define-color accent_fg #ffffff;
@define-color accent_soft rgba(10, 6, 20, 0.07);
@define-color accent2 #d9d9d9;
@define-color danger #3a3a3a;
@define-color warn #5f5f5f;
@define-color dim rgba(10, 6, 20, 0.35);
"
        }
    }
}

const RULES: &str = r#"
* { font-family: "Inter Variable", "Inter", "Noto Sans", sans-serif; }
window { background: transparent; }
.pill {
  background: alpha(@surface, 0.94); color: @fg; border: 1px solid @line_strong;
  border-radius: 999px; padding: 4px 12px; min-height: 0;
  font-size: 13px; font-weight: 500; box-shadow: none;
}
.pill:hover { background: @surface2; }
.pill.offline { color: @warn; }
.pill.done { color: @accent; border-color: @accent; }
.pill.focus { color: @accent; border-color: alpha(@accent, 0.45); }
.pill.logo-button { padding: 3px 9px; }

button.dim, button.dim:hover, button.dim:active {
  background: @dim; background-image: none; border: none; border-radius: 0; box-shadow: none; outline: none;
}
.card {
  background: @surface; color: @fg; border: 1px solid @line;
  border-radius: 24px; padding: 22px; box-shadow: 0 20px 60px -20px rgba(3, 2, 8, 0.6);
}
.title { font-size: 20px; font-weight: 700; color: @fg; }
.sub { color: @muted; font-size: 13px; }
.section { color: @faint; font-size: 11px; font-weight: 600; letter-spacing: 1px; }
.error { color: @danger; font-size: 13px; }
.menu-button {
  background: @surface2; color: @fg; border: 1px solid @line; border-radius: 14px;
  padding: 12px 18px; font-size: 15px; font-weight: 500; min-width: 220px; box-shadow: none;
}
.menu-button:hover { background: @surface3; border-color: @line_strong; }
.menu-button.danger { color: @danger; border-color: alpha(@danger, 0.35); }
.menu-button.quiet { background: transparent; border-color: transparent; color: @muted; }
.menu-button.quiet:hover { color: @fg; }
.small-button {
  background: @surface2; color: @fg; border: 1px solid @line; border-radius: 10px;
  padding: 4px 12px; font-size: 13px; font-weight: 500; box-shadow: none;
}
.small-button:hover { background: @surface3; }
.small-button.primary { background: @accent; color: @accent_fg; border-color: @accent; }
.net-row { background: transparent; border: none; border-radius: 12px; padding: 8px 10px; color: @fg; font-size: 14px; box-shadow: none; }
.net-row:hover { background: @surface2; }
.net-row.active { background: @accent_soft; }
.net-row .tag { color: @faint; font-size: 12px; }
.net-row .bars { color: @muted; font-size: 11px; min-width: 34px; }
.status { background: @surface2; border: 1px solid @line; border-radius: 14px; padding: 10px 14px; color: @fg; }
scrollbar slider { min-width: 6px; min-height: 6px; margin: 0; }
entry, passwordentry {
  background: @bg; color: @fg; border: 1px solid @line_strong; border-radius: 10px; padding: 6px 10px; box-shadow: none;
}
entry:focus-within, passwordentry:focus-within { border-color: @accent; }

.switcher { background: alpha(@surface, 0.96); border: 1px solid @line_strong; border-radius: 28px; padding: 18px; }
.item { border-radius: 18px; padding: 14px; min-width: 128px; border: 2px solid transparent; }
.item.selected { background: @accent_soft; border-color: @accent; }
.item .icon { background: @surface3; border-radius: 16px; min-width: 64px; min-height: 64px; font-size: 26px; font-weight: 700; color: @fg; }
.item .name { color: @fg; font-size: 13px; font-weight: 500; margin-top: 8px; }
.item .state { color: @faint; font-size: 11px; }
"#;

pub fn css(t: Theme) -> String {
    format!("{}{RULES}", palette(t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn themes() {
        assert_eq!(Theme::parse("light\n"), Theme::Light);
        assert_eq!(Theme::parse("dark"), Theme::Dark);
        assert_eq!(Theme::parse("anything"), Theme::Dark);
        for t in [Theme::Dark, Theme::Light] {
            let css = css(t);
            // Every colour the rules use is defined.
            for name in [
                "bg",
                "surface",
                "surface2",
                "surface3",
                "line",
                "line_strong",
                "fg",
                "muted",
                "faint",
                "accent",
                "accent_fg",
                "accent_soft",
                "danger",
                "warn",
                "dim",
            ] {
                assert!(css.contains(&format!("@define-color {name} ")), "{t:?} lacks {name}");
            }
        }
    }
}
