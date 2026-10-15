//! Two layouts Storage needs that boxes don't do: the layer tree (nodes in
//! columns, joined by curves, the columns sharing the width they're given)
//! and the disk bar (parts as wide as their share of it).

use std::cell::{Cell, RefCell};

use gtk::{glib, graphene, gsk, prelude::*, subclass::prelude::*};

pub const NODE_W: i32 = 184;
/// Room between columns for the edges, at the least.
const MIN_COL_W: i32 = NODE_W + 28;
pub const ROW_H: i32 = 62;
pub const NODE_H: i32 = 50;

/// A node in its place: its column, its row (halves between rows), what
/// it's built on (an earlier node), and the widget its edge takes its
/// colour from.
pub struct Placed {
    pub widget: gtk::Widget,
    pub col: usize,
    pub row: f64,
    pub parent: Option<usize>,
    pub stripe: gtk::Widget,
    /// Not on the machine: a dashed, fainter edge.
    pub absent: bool,
}

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct Tree {
        pub nodes: RefCell<Vec<Placed>>,
        pub cols: Cell<usize>,
        pub rows: Cell<usize>,
        pub col_w: Cell<i32>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Tree {
        const NAME: &'static str = "WadLayerTree";
        type Type = super::Tree;
        type ParentType = gtk::Widget;

        fn class_init(klass: &mut Self::Class) {
            klass.set_css_name("wad-tree");
        }
    }

    impl ObjectImpl for Tree {
        fn dispose(&self) {
            for n in self.nodes.borrow().iter() {
                n.widget.unparent();
            }
        }
    }

    impl Tree {
        fn at(&self, n: &Placed) -> (f32, f32) {
            ((n.col as i32 * self.col_w.get()) as f32, (n.row * ROW_H as f64) as f32 + (ROW_H - NODE_H) as f32 / 2.0)
        }
    }

    impl WidgetImpl for Tree {
        fn measure(&self, o: gtk::Orientation, _for: i32) -> (i32, i32, i32, i32) {
            let n = match o {
                gtk::Orientation::Horizontal => self.cols.get() as i32 * MIN_COL_W + NODE_W,
                _ => self.rows.get() as i32 * ROW_H,
            };
            (n, n, -1, -1)
        }

        fn size_allocate(&self, width: i32, _height: i32, _baseline: i32) {
            let cols = self.cols.get() as i32;
            self.col_w.set(if cols > 0 { MIN_COL_W.max((width - NODE_W) / cols) } else { MIN_COL_W });
            for n in self.nodes.borrow().iter() {
                let (x, y) = self.at(n);
                let t = gsk::Transform::new().translate(&graphene::Point::new(x, y));
                n.widget.allocate(NODE_W, NODE_H, -1, Some(t));
            }
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let nodes = self.nodes.borrow();
            for n in nodes.iter() {
                let Some(p) = n.parent.and_then(|i| nodes.get(i)) else { continue };
                let (ax, ay) = self.at(p);
                let (bx, by) = self.at(n);
                let (x1, y1, x2, y2) = (ax + NODE_W as f32, ay + NODE_H as f32 / 2.0, bx, by + NODE_H as f32 / 2.0);
                let mid = (x1 + x2) / 2.0;
                let path = gsk::PathBuilder::new();
                path.move_to(x1, y1);
                path.cubic_to(mid, y1, mid, y2, x2, y2);
                let stroke = gsk::Stroke::new(1.5);
                let mut color = n.stripe.color();
                if n.absent {
                    stroke.set_dash(&[4.0, 4.0]);
                    color.set_alpha(0.3);
                } else {
                    color.set_alpha(0.55);
                }
                snapshot.append_stroke(&path.to_path(), &stroke, &color);
            }
            drop(nodes);
            self.parent_snapshot(snapshot);
        }
    }

    #[derive(Default)]
    pub struct Shares {
        /// Each part's share of the whole (0..1).
        pub shares: RefCell<Vec<(gtk::Widget, f64)>>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Shares {
        const NAME: &'static str = "WadShares";
        type Type = super::Shares;
        type ParentType = gtk::Widget;

        fn class_init(klass: &mut Self::Class) {
            klass.set_css_name("wad-shares");
        }
    }

    impl ObjectImpl for Shares {
        fn dispose(&self) {
            for (w, _) in self.shares.borrow().iter() {
                w.unparent();
            }
        }
    }

    impl WidgetImpl for Shares {
        /// As wide as it's given; as tall as its CSS says.
        fn measure(&self, _o: gtk::Orientation, _for: i32) -> (i32, i32, i32, i32) {
            (0, 0, -1, -1)
        }

        fn size_allocate(&self, width: i32, height: i32, _baseline: i32) {
            let mut x = 0.0f32;
            for (w, share) in self.shares.borrow().iter() {
                // Every part shows, however small.
                let wd = ((share * width as f64) as f32).max(3.0);
                w.allocate(
                    wd.round() as i32,
                    height,
                    -1,
                    Some(gsk::Transform::new().translate(&graphene::Point::new(x, 0.0))),
                );
                x += wd;
            }
        }
    }
}

glib::wrapper! {
    pub struct Tree(ObjectSubclass<imp::Tree>) @extends gtk::Widget, @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Tree {
    pub fn new(nodes: Vec<Placed>, cols: usize, rows: usize) -> Self {
        let me: Self = glib::Object::new();
        for n in &nodes {
            n.widget.set_parent(&me);
        }
        let i = me.imp();
        i.nodes.replace(nodes);
        i.cols.set(cols);
        i.rows.set(rows);
        me
    }
}

glib::wrapper! {
    pub struct Shares(ObjectSubclass<imp::Shares>) @extends gtk::Widget, @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Shares {
    /// Parts (a widget each, styled by its classes) and their shares.
    pub fn new(parts: Vec<(gtk::Widget, f64)>) -> Self {
        let me: Self = glib::Object::new();
        me.set_overflow(gtk::Overflow::Hidden);
        for (w, _) in &parts {
            w.set_parent(&me);
        }
        me.imp().shares.replace(parts);
        me
    }
}
