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

/// `bytes` as a `w`×`h` PNG filling it, cropped from the centre (a desktop's preview).
pub fn cover(bytes: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    if img.width() == 0 || img.height() == 0 || w == 0 || h == 0 {
        return None;
    }
    let small = img.resize_to_fill(w, h, FilterType::Triangle);
    let mut out = Cursor::new(Vec::new());
    small.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// A picture as straight RGBA rows: `(width, height, pixels)`.
pub type Rgba = (u32, u32, Vec<u8>);

/// `bytes` as `w`×`h` RGBA filling it, cropped from the centre: no PNG in
/// between (the switcher's wallpapers).
pub fn cover_rgba(bytes: &[u8], w: u32, h: u32) -> Option<Rgba> {
    let img = image::load_from_memory(bytes).ok()?;
    if img.width() == 0 || img.height() == 0 || w == 0 || h == 0 {
        return None;
    }
    let small = img.resize_to_fill(w, h, FilterType::Triangle).to_rgba8();
    Some((small.width(), small.height(), small.into_raw()))
}

/// `bytes` as RGBA, at most `size` on its longer side (the switcher's icons).
pub fn rgba(bytes: &[u8], size: u32) -> Option<Rgba> {
    let img = image::load_from_memory(bytes).ok()?;
    if img.width() == 0 || img.height() == 0 {
        return None;
    }
    let img =
        if img.width() > size || img.height() > size { img.resize(size, size, FilterType::Triangle) } else { img };
    let img = img.to_rgba8();
    Some((img.width(), img.height(), img.into_raw()))
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
    fn raw_pictures_skip_png() {
        let wide = image::RgbaImage::from_pixel(1920, 1080, image::Rgba([0, 0, 255, 255]));
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(wide).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();
        let (w, h, px) = cover_rgba(&png, 288, 192).unwrap();
        assert_eq!((w, h, px.len()), (288, 192, 288 * 192 * 4));
        assert_eq!(&px[..4], &[0, 0, 255, 255]);
        let (w, h, _) = rgba(&png, 32).unwrap();
        assert_eq!((w, h), (32, 18));
        assert!(rgba(b"nope", 32).is_none());
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
