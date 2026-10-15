//! WadSpaces' look in GTK4, for the native client (and the HUD): the
//! site's colours as CSS tokens, its fonts, lucide icons in the text's
//! colour, motion's springs, and lists kept by key.

pub mod desktop;
pub mod fonts;
pub mod icon;
pub mod keyed;
pub mod spring;
pub mod theme;
pub mod wallpaper;
pub mod width;

pub use desktop::{DesktopIcon, DesktopThumb};
pub use icon::{Icon, Svg};
pub use spring::{Params, Spring};
pub use theme::Theme;
pub use wallpaper::Wallpaper;
pub use width::Width;
