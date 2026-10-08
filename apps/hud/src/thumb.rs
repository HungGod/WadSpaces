//! Workspace icons for the switcher: whatever the image is (often a full-size
//! wallpaper), a small square from its middle, so it can't fill the screen.
//! And the clipboard history's image previews.

use std::io::Cursor;

use image::imageops::FilterType;

/// `bytes` (PNG, JPEG or WebP) as a `size`×`size` PNG cropped from the centre.
pub fn thumbnail(bytes: &[u8], size: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let side = img.width().min(img.height());
    if side == 0 {
        return None;
    }
    let square = img.crop_imm((img.width() - side) / 2, (img.height() - side) / 2, side, side);
    let small = square.resize_exact(size, size, FilterType::Triangle);
    let mut out = Cursor::new(Vec::new());
    small.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// `bytes` (any image the image crate reads) as a PNG fitted inside
/// `w`×`h`, its shape kept: an image copy's preview.
pub fn fit(bytes: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    if img.width() == 0 || img.height() == 0 {
        return None;
    }
    let small = if img.width() > w || img.height() > h { img.resize(w, h, FilterType::Triangle) } else { img };
    let mut out = Cursor::new(Vec::new());
    small.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wallpaper_becomes_a_small_square() {
        let wide = image::RgbaImage::from_fn(1920, 1080, |x, _| image::Rgba([(x % 256) as u8, 0, 0, 255]));
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(wide).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let t = thumbnail(&png.into_inner(), 128).unwrap();
        let back = image::load_from_memory(&t).unwrap();
        assert_eq!((back.width(), back.height()), (128, 128));
        assert!(thumbnail(b"not an image", 128).is_none());
    }

    #[test]
    fn a_screenshot_keeps_its_shape() {
        let wide = image::RgbaImage::from_pixel(1920, 1080, image::Rgba([0, 0, 255, 255]));
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(wide).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let back = image::load_from_memory(&fit(&png.into_inner(), 192, 96).unwrap()).unwrap();
        assert_eq!((back.width(), back.height()), (171, 96));
    }
}
