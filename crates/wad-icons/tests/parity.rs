//! The cards look as KaleBrowser's packager made them: each fixture's card
//! against packager.py's (fixtures/icons/make_references.py).
//!
//! `WAD_ICONS_SHEET=<dir>` also writes each pair side by side, to look at.

use image::RgbaImage;
use std::path::PathBuf;

const CASES: &[&str] =
    &["dark-on-light", "light-on-dark", "transparent-logo", "light-plate", "tiny", "wide", "low-contrast"];

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/icons")
}

fn load(name: &str) -> RgbaImage {
    image::open(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}")).to_rgba8()
}

/// Mean absolute difference per channel (0..255), and the share of pixels
/// with a channel off by more than 64.
fn diff(a: &RgbaImage, b: &RgbaImage) -> (f64, f64) {
    let (mut sum, mut bad) = (0u64, 0u64);
    for (p, q) in a.pixels().zip(b.pixels()) {
        let d: Vec<u64> = (0..4).map(|c| (p[c] as i64 - q[c] as i64).unsigned_abs()).collect();
        sum += d.iter().sum::<u64>();
        if d.iter().any(|&x| x > 64) {
            bad += 1;
        }
    }
    let n = (a.width() * a.height()) as f64;
    (sum as f64 / (n * 4.0), bad as f64 / n)
}

#[test]
fn cards_match_the_packager() {
    let sheet = std::env::var_os("WAD_ICONS_SHEET").map(PathBuf::from);
    let mut failed = vec![];
    for name in CASES {
        let ours = wad_icons::style::card(&load(&format!("{name}.png")));
        let theirs = load(&format!("{name}.card.png"));
        assert_eq!(ours.dimensions(), theirs.dimensions());
        let (mean, bad) = diff(&ours, &theirs);
        println!("{name:18} mean diff {mean:.2}  pixels far off {:.2}%", bad * 100.0);
        if mean > 2.0 || bad > 0.005 {
            failed.push(format!("{name}: mean {mean:.2}, {:.2}% far off", bad * 100.0));
        }
        if let Some(dir) = &sheet {
            let mut pair = RgbaImage::new(1024, 512);
            image::imageops::overlay(&mut pair, &theirs, 0, 0);
            image::imageops::overlay(&mut pair, &ours, 512, 0);
            pair.save(dir.join(format!("{name}.pair.png"))).unwrap();
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}
