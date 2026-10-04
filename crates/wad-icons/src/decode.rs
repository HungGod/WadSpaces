//! Icon files into pictures: PNG, ICO (its largest), JPEG, WebP, GIF, BMP and
//! SVG, with limits so a hostile file can't take the memory.

use image::{ImageReader, Limits, RgbaImage};
use resvg::{tiny_skia, usvg};
use std::io::Cursor;

/// SVGs are drawn this big, as the packager did.
pub const SVG_PX: u32 = 1024;
const MAX_SIDE: u32 = 4096;

/// The picture in `bytes`, or None if it isn't one this reads.
pub fn decode(bytes: &[u8]) -> Option<RgbaImage> {
    if looks_like_svg(bytes) {
        return svg(bytes, SVG_PX);
    }
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(128 << 20);
    reader.limits(limits);
    Some(reader.decode().ok()?.to_rgba8())
}

pub fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    (head.starts_with("<?xml")
        || head.starts_with("<svg")
        || head.starts_with("<!--")
        || head.starts_with("<!doctype svg"))
        && head.contains("<svg")
}

/// An SVG drawn to fit a `px` square, centred.
pub fn svg(bytes: &[u8], px: u32) -> Option<RgbaImage> {
    let tree = usvg::Tree::from_data(bytes, &usvg::Options::default()).ok()?;
    let size = tree.size();
    let scale = (px as f32 / size.width()).min(px as f32 / size.height());
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let mut pixmap = tiny_skia::Pixmap::new(px, px)?;
    let (dx, dy) = ((px as f32 - size.width() * scale) / 2.0, (px as f32 - size.height() * scale) / 2.0);
    resvg::render(&tree, tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, dx, dy), &mut pixmap.as_mut());
    Some(crate::style::to_image(&pixmap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_is_drawn_square() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#000"/></svg>"##;
        assert!(looks_like_svg(svg));
        let img = decode(svg).unwrap();
        assert_eq!(img.dimensions(), (SVG_PX, SVG_PX));
        assert_eq!(img.get_pixel(512, 512)[3], 255, "the rect, centred");
        assert_eq!(img.get_pixel(512, 10)[3], 0, "letterboxed above it");
    }

    #[test]
    fn junk_is_none() {
        assert!(decode(b"not an image").is_none());
        assert!(decode(b"<svg").is_none());
    }
}
