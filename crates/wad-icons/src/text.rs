//! Text on an icon (a host name), drawn from glyph outlines of the embedded
//! font, so it looks the same wherever it's made (wadd on the host, or the
//! image helper in a workspace).

use resvg::tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};
use ttf_parser::{Face, OutlineBuilder};

/// Noto Sans ExtraBold, Basic Latin only (fonts/OFL.txt).
const FONT: &[u8] = include_bytes!("../fonts/NotoSans-ExtraBold-Latin.ttf");
/// Text is shortened rather than drawn smaller than this.
pub(crate) const READABLE_PX: f32 = 56.0;
/// The smallest it's drawn: past this, it's cut short with "...".
const MIN_PX: f32 = 36.0;

/// The size (px) `text` would be drawn at to fit `max_w` × `max_h`.
pub(crate) fn fit_px(text: &str, max_w: f32, max_h: f32) -> f32 {
    let Ok(face) = Face::parse(FONT, 0) else { return 0.0 };
    let upem = face.units_per_em() as f32;
    let chars = glyph_chars(&face, text);
    (max_h * upem / cap_height(&face)).min(max_w * upem / width_units(&face, &chars).max(1.0))
}

/// Draws `text` in white, centred on (cx, cy), as large as fits in
/// `max_w` × `max_h` (the capitals' height); below a readable size, cut
/// short with "...".
pub(crate) fn draw_centered(pixmap: &mut Pixmap, text: &str, cx: f32, cy: f32, max_w: f32, max_h: f32) {
    let Ok(face) = Face::parse(FONT, 0) else { return };
    let upem = face.units_per_em() as f32;
    let cap = cap_height(&face);
    let mut shown = glyph_chars(&face, text);
    let mut px = (max_h * upem / cap).min(max_w * upem / width_units(&face, &shown).max(1.0));
    if px < MIN_PX {
        px = MIN_PX;
        let dots: Vec<char> = "...".chars().collect();
        while shown.len() > 1 && width_units(&face, &[shown.as_slice(), &dots].concat()) * px / upem > max_w {
            shown.pop();
        }
        shown.extend(dots);
    }

    let scale = px / upem;
    let total = width_units(&face, &shown) * scale;
    let mut pen = cx - total / 2.0;
    let baseline = cy + cap * scale / 2.0;
    let mut path = Outline { pb: PathBuilder::new(), x: 0.0, y: baseline, scale };
    for c in shown {
        let Some(g) = face.glyph_index(c) else { continue };
        path.x = pen;
        face.outline_glyph(g, &mut path);
        pen += face.glyph_hor_advance(g).unwrap_or(0) as f32 * scale;
    }
    let Some(path) = path.pb.finish() else { return };
    let mut paint = Paint::default();
    paint.set_color_rgba8(255, 255, 255, 255);
    paint.anti_alias = true;
    pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
}

/// The font has Basic Latin only: anything else shows as "?".
fn glyph_chars(face: &Face, text: &str) -> Vec<char> {
    text.chars().map(|c| if face.glyph_index(c).is_some() { c } else { '?' }).collect()
}

fn width_units(face: &Face, chars: &[char]) -> f32 {
    chars.iter().filter_map(|&c| face.glyph_index(c)).map(|g| face.glyph_hor_advance(g).unwrap_or(0) as f32).sum()
}

fn cap_height(face: &Face) -> f32 {
    face.capital_height().map_or(face.units_per_em() as f32 * 0.714, |c| c as f32)
}

/// Glyph outlines (font units, y up) into a path (pixels, y down) at the pen.
struct Outline {
    pb: PathBuilder,
    x: f32,
    y: f32,
    scale: f32,
}

impl Outline {
    fn at(&self, x: f32, y: f32) -> (f32, f32) {
        (self.x + x * self.scale, self.y - y * self.scale)
    }
}

impl OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.pb.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.pb.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let ((x1, y1), (x, y)) = (self.at(x1, y1), self.at(x, y));
        self.pb.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let ((x1, y1), (x2, y2), (x, y)) = (self.at(x1, y1), self.at(x2, y2), self.at(x, y));
        self.pb.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.pb.close();
    }
}
