//! A box exactly as wide as it's told (its child's widths don't move it):
//! the sidebar, whose width is its spring's alone.

use std::cell::Cell;

use gtk::{glib, prelude::*, subclass::prelude::*};

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct Width {
        pub width: Cell<i32>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Width {
        const NAME: &'static str = "WadWidth";
        type Type = super::Width;
        type ParentType = gtk::Widget;

        fn class_init(klass: &mut Self::Class) {
            klass.set_css_name("wad-width");
        }
    }

    impl ObjectImpl for Width {
        fn dispose(&self) {
            while let Some(c) = self.obj().first_child() {
                c.unparent();
            }
        }
    }

    impl WidgetImpl for Width {
        fn request_mode(&self) -> gtk::SizeRequestMode {
            gtk::SizeRequestMode::HeightForWidth
        }

        fn measure(&self, o: gtk::Orientation, for_size: i32) -> (i32, i32, i32, i32) {
            let w = self.width.get();
            match (o, self.obj().first_child()) {
                (gtk::Orientation::Horizontal, _) => (w, w, -1, -1),
                (_, Some(c)) => {
                    // Measured at the width it'll get (never less than it needs).
                    let (need, _, _, _) = c.measure(gtk::Orientation::Horizontal, -1);
                    let at = if for_size < 0 { w } else { for_size.min(w) }.max(need);
                    let (min, nat, _, _) = c.measure(o, at);
                    (min, nat, -1, -1)
                }
                (_, None) => (0, 0, -1, -1),
            }
        }

        fn size_allocate(&self, width: i32, height: i32, baseline: i32) {
            if let Some(c) = self.obj().first_child() {
                // Never less than the child needs (mid-spring, say): what's
                // over is clipped.
                let (min, _, _, _) = c.measure(gtk::Orientation::Horizontal, -1);
                c.allocate(width.min(self.width.get()).max(min), height, baseline, None);
            }
        }
    }
}

glib::wrapper! {
    pub struct Width(ObjectSubclass<imp::Width>) @extends gtk::Widget, @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Width {
    pub fn new(child: &impl IsA<gtk::Widget>, width: i32) -> Self {
        let me: Self = glib::Object::new();
        me.set_overflow(gtk::Overflow::Hidden);
        me.imp().width.set(width);
        child.set_parent(&me);
        me
    }

    pub fn set_width(&self, width: i32) {
        if self.imp().width.replace(width) != width {
            self.queue_resize();
        }
    }
}
