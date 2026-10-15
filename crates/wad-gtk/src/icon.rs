//! Lucide icons (assets/lucide, made by tools/lucide.mjs) drawn in the
//! widget's own CSS colour, at its size and the screen's scale: what
//! lucide-react draws in the web app. `Icon::new("play", 16)`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use gtk::{gdk, glib, graphene, prelude::*, subclass::prelude::*};

include!(concat!(env!("OUT_DIR"), "/lucide.rs"));

/// An icon's drawing, by lucide name ("circle-check"), if it's one of ours.
pub fn svg(name: &str) -> Option<&'static str> {
    LUCIDE.iter().find(|(n, _)| *n == name).map(|(_, s)| *s)
}

/// An icon drawn: its name, pixel size, colour and fill.
type Drawn = (&'static str, u32, [u8; 4], bool);

thread_local! {
    static DRAWN: RefCell<HashMap<Drawn, Option<gdk::Texture>>> = RefCell::default();
}

/// `name` drawn `px` pixels square in `color` (`filled`: its shapes filled
/// too, lucide-react's `fill-current`): cached.
pub fn texture(name: &'static str, px: u32, color: &gdk::RGBA, filled: bool) -> Option<gdk::Texture> {
    let rgba = [
        (color.red() * 255.0).round() as u8,
        (color.green() * 255.0).round() as u8,
        (color.blue() * 255.0).round() as u8,
        (color.alpha() * 255.0).round() as u8,
    ];
    let key = (name, px, rgba, filled);
    if let Some(t) = DRAWN.with(|d| d.borrow().get(&key).cloned()) {
        return t;
    }
    let svg = svg(name)?;
    let made = if filled {
        draw(&svg.replace("fill=\"none\"", "fill=\"currentColor\""), px, rgba)
    } else {
        draw(svg, px, rgba)
    };
    DRAWN.with(|d| d.borrow_mut().insert(key, made.clone()));
    made
}

/// Any SVG (a brand mark, a logo) as a texture `px` square, drawn here:
/// GTK would start a loader process (glycin) for each one.
pub fn svg_texture(svg: &[u8], px: u32) -> Option<gdk::Texture> {
    let pm = render(std::str::from_utf8(svg).ok()?, px)?;
    Some(premultiplied(pm, px))
}

fn render(svg: &str, px: u32) -> Option<resvg::tiny_skia::Pixmap> {
    use resvg::{tiny_skia, usvg};
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).ok()?;
    let mut pm = tiny_skia::Pixmap::new(px, px)?;
    let (w, h) = (tree.size().width(), tree.size().height());
    let k = px as f32 / w.max(h);
    // Centred in its square.
    let t = tiny_skia::Transform::from_row(k, 0.0, 0.0, k, (px as f32 - w * k) / 2.0, (px as f32 - h * k) / 2.0);
    resvg::render(&tree, t, &mut pm.as_mut());
    Some(pm)
}

fn premultiplied(pm: resvg::tiny_skia::Pixmap, px: u32) -> gdk::Texture {
    let bytes = glib::Bytes::from_owned(pm.take());
    gdk::MemoryTexture::new(px as i32, px as i32, gdk::MemoryFormat::R8g8b8a8Premultiplied, &bytes, px as usize * 4)
        .upcast()
}

fn draw(svg: &str, px: u32, [r, g, b, a]: [u8; 4]) -> Option<gdk::Texture> {
    use resvg::tiny_skia;
    let svg = svg.replace("currentColor", &format!("#{r:02x}{g:02x}{b:02x}"));
    let mut pm = render(&svg, px)?;
    // The colour's own alpha, on top of the drawing's.
    if a < 255 {
        for p in pm.pixels_mut() {
            let scale = |v: u8| ((v as u16 * a as u16) / 255) as u8;
            *p = tiny_skia::PremultipliedColorU8::from_rgba(
                scale(p.red()),
                scale(p.green()),
                scale(p.blue()),
                scale(p.alpha()),
            )
            .unwrap_or(*p);
        }
    }
    Some(premultiplied(pm, px))
}

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct Icon {
        pub name: Cell<&'static str>,
        pub size: Cell<i32>,
        pub filled: Cell<bool>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Icon {
        const NAME: &'static str = "WadIcon";
        type Type = super::Icon;
        type ParentType = gtk::Widget;

        fn class_init(klass: &mut Self::Class) {
            klass.set_css_name("wad-icon");
            klass.set_accessible_role(gtk::AccessibleRole::Img);
        }
    }

    impl ObjectImpl for Icon {}

    impl WidgetImpl for Icon {
        fn measure(&self, _: gtk::Orientation, _: i32) -> (i32, i32, i32, i32) {
            let s = self.size.get();
            (s, s, -1, -1)
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let w = self.obj();
            let (size, name) = (self.size.get(), self.name.get());
            if size <= 0 || name.is_empty() {
                return;
            }
            let px = (size * w.scale_factor()) as u32;
            if let Some(t) = texture(name, px, &w.color(), self.filled.get()) {
                // Centred in what it was given.
                let (x, y) = ((w.width() - size) as f32 / 2.0, (w.height() - size) as f32 / 2.0);
                snapshot.append_texture(&t, &graphene::Rect::new(x, y, size as f32, size as f32));
            }
        }
    }
}

glib::wrapper! {
    /// A lucide icon in the widget's colour (`color:` in CSS), `size` px.
    pub struct Icon(ObjectSubclass<imp::Icon>) @extends gtk::Widget, @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Icon {
    pub fn new(name: &'static str, size: i32) -> Self {
        let me: Self = glib::Object::new();
        me.set(name);
        me.imp().size.set(size);
        me.set_halign(gtk::Align::Center);
        me.set_valign(gtk::Align::Center);
        if svg(name).is_none() {
            tracing::warn!("no lucide icon {name:?} in assets/lucide (tools/lucide.mjs)");
        }
        me
    }

    /// Its shapes filled in its colour too (lucide-react's `fill-current`).
    pub fn filled(name: &'static str, size: i32) -> Self {
        let me = Self::new(name, size);
        me.imp().filled.set(true);
        me
    }

    /// Another icon in its place.
    pub fn set(&self, name: &'static str) {
        if self.imp().name.replace(name) != name {
            self.queue_draw();
        }
    }

    pub fn set_size(&self, size: i32) {
        if self.imp().size.replace(size) != size {
            self.queue_resize();
        }
    }
}
