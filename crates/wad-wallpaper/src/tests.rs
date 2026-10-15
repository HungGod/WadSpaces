use super::*;

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn splits_layers_on_top_level_commas_only() {
    assert_eq!(
        split_top("radial-gradient(60% 60% at 30% 30%, #ff3d8166 0%, transparent 60%), #0a0614"),
        ["radial-gradient(60% 60% at 30% 30%, #ff3d8166 0%, transparent 60%)", "#0a0614"]
    );
}

#[test]
fn reads_stops_spreading_unpositioned_ones_like_css() {
    let at = |s: &[&str]| stops(&strs(s)).unwrap().iter().map(|s| (s.at * 1000.0).round() / 1000.0).collect::<Vec<_>>();
    assert_eq!(at(&["#000 0%", "#fff 50%"]), [0.0, 0.5]);
    assert_eq!(at(&["red", "green", "blue"]), [0.0, 0.5, 1.0]);
    assert_eq!(at(&["#2a0b2e 0%", "#7a1f3d 55%", "#ff8a3d 120%"]).last(), Some(&1.2));
    assert_eq!(at(&["#000", "#111", "#222", "#333 90%"]), [0.0, 0.3, 0.6, 0.9]);
}

#[test]
fn every_preset_reads_into_layers() {
    let names: Vec<&str> = PRESETS.iter().map(|(n, _)| *n).collect();
    assert_eq!(names, ["Aurora", "Nebula", "Acid Dusk", "Neon Tide", "Ember", "Glacier", "Midnight", "Prism", "Haze"]);
    for (name, css) in PRESETS {
        let ls = layers(css);
        assert_eq!(ls.len(), split_top(css).len(), "{name}");
        // Bottom first: the colour or linear gradient CSS lists last.
        assert!(matches!(ls[0], Layer::Linear { .. } | Layer::Color(_)), "{name}");
        assert!(ls[1..].iter().all(|l| matches!(l, Layer::Radial { .. })), "{name}");
    }
    assert!(matches!(layer(BLANK), Some(Layer::Linear { deg, .. }) if deg == 160.0));
}

#[test]
fn reads_a_radial_shape_whose_centre_is_off_the_picture() {
    assert_eq!(radial_shape("120% 80% at 50% -5%"), Some([1.2, 0.8, 0.5, -0.05]));
    assert_eq!(radial_shape("closest-side"), None);
}

#[test]
fn fades_to_transparent_in_the_neighbouring_colour() {
    assert_eq!(color("rgb(198 255 31 / 0.38)"), Some(Rgba::rgb8(198, 255, 31, 0.38)));
    assert_eq!(color("#ff3d8155"), Some(Rgba::rgb8(255, 61, 129, 0x55 as f32 / 255.0)));
    assert_eq!(color("#abc"), Some(Rgba::rgb8(170, 187, 204, 1.0)));
    assert_eq!(color("rgba(1, 2, 3, 50%)"), Some(Rgba::rgb8(1, 2, 3, 0.5)));
    assert_eq!(color("nope"), None);
    let s = stops(&strs(&["rgb(255 61 129 / 0.5)", "transparent 60%"])).unwrap();
    assert_eq!(s[1], Stop { color: Rgba::rgb8(255, 61, 129, 0.0), at: 0.6 });
    let s = stops(&strs(&["transparent", "#0a0614"])).unwrap();
    assert_eq!(s[0].color, Rgba::rgb8(10, 6, 20, 0.0));
}

#[test]
fn a_linear_gradient_reaches_the_corners() {
    let ((x0, y0), (x1, y1)) = Layer::line(180.0, 100.0, 50.0);
    assert!(
        (x0 - 50.0).abs() < 1e-3 && (y0 - 0.0).abs() < 1e-3 && (x1 - 50.0).abs() < 1e-3 && (y1 - 50.0).abs() < 1e-3
    );
    let ((x0, _), (x1, _)) = Layer::line(90.0, 100.0, 50.0);
    assert!((x0 - 0.0).abs() < 1e-3 && (x1 - 100.0).abs() < 1e-3);
}

#[test]
fn wallpapers_read_as_the_builder_keeps_them() {
    let w: Wallpaper = serde_json::from_str(r##"{"type":"color","value":"#0a0614"}"##).unwrap();
    assert_eq!(w.paint(), Paint::Layers(vec![Layer::Color(Rgba::rgb8(10, 6, 20, 1.0))]));
    let w: Wallpaper = serde_json::from_str(r#"{"type":"image","value":"data:image/png;base64,AA"}"#).unwrap();
    assert_eq!(w.paint(), Paint::Image("data:image/png;base64,AA".into()));
}
