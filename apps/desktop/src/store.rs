//! What the app knows, in one place: wadd's state as its events tell it
//! (and, later, the account's library). Widgets watch the topics they draw
//! from; an update marks topics and one idle pass redraws what watches them.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::{glib, prelude::*};
use wad_proto::v1::{CloudLink, Event, MachineInfo, NetworkStatus, Session, ViewState, Workspace, WorkspaceState};
use wad_wadd_client::Incoming;

/// What changed, as bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Topic(u32);

impl Topic {
    pub const MACHINE: Topic = Topic(1);
    pub const VIEW: Topic = Topic(1 << 1);
    pub const WORKSPACES: Topic = Topic(1 << 2);
    pub const STATES: Topic = Topic(1 << 3);
    pub const SESSION: Topic = Topic(1 << 4);
    pub const NETWORK: Topic = Topic(1 << 5);
    pub const CLOUD: Topic = Topic(1 << 6);
    pub const WADD: Topic = Topic(1 << 7);
    pub const NONE: Topic = Topic(0);

    pub fn any(self, other: Topic) -> bool {
        self.0 & other.0 != 0
    }
}

impl std::ops::BitOr for Topic {
    type Output = Topic;
    fn bitor(self, o: Topic) -> Topic {
        Topic(self.0 | o.0)
    }
}

#[derive(Debug, Default)]
pub struct AppState {
    /// wadd answers (its event stream is up).
    pub connected: bool,
    pub machine: Option<MachineInfo>,
    pub view: Option<ViewState>,
    pub workspaces: Vec<Workspace>,
    pub states: HashMap<String, WorkspaceState>,
    pub session: Option<Session>,
    pub network: Option<NetworkStatus>,
    pub cloud: Option<CloudLink>,
}

type Watcher = (Topic, glib::WeakRef<gtk::Widget>, Box<dyn Fn(&AppState)>);

#[derive(Default)]
pub struct Store {
    state: RefCell<AppState>,
    dirty: Cell<Topic>,
    scheduled: Cell<bool>,
    watchers: RefCell<Vec<Watcher>>,
}

thread_local! {
    static STORE: Rc<Store> = Rc::new(Store::default());
}

/// The app's store (GTK's thread only).
pub fn store() -> Rc<Store> {
    STORE.with(Rc::clone)
}

impl Store {
    /// Changes the state; `f` says which topics changed. Watchers of those
    /// run once, together, when GTK is next idle.
    pub fn update(self: &Rc<Self>, f: impl FnOnce(&mut AppState) -> Topic) {
        let t = f(&mut self.state.borrow_mut());
        if t == Topic::NONE {
            return;
        }
        self.dirty.set(self.dirty.get() | t);
        if !self.scheduled.replace(true) {
            let me = self.clone();
            glib::idle_add_local_once(move || me.flush());
        }
    }

    fn flush(&self) {
        self.scheduled.set(false);
        let dirty = self.dirty.replace(Topic::NONE);
        // Watchers whose widget is gone go too.
        self.watchers.borrow_mut().retain(|(_, w, _)| w.upgrade().is_some());
        let st = self.state.borrow();
        for (t, w, f) in self.watchers.borrow().iter() {
            if t.any(dirty) && w.upgrade().is_some() {
                f(&st);
            }
        }
    }

    /// Runs `f` now and whenever `topics` change, while `widget` lives.
    pub fn watch(&self, widget: &impl IsA<gtk::Widget>, topics: Topic, f: impl Fn(&AppState) + 'static) {
        f(&self.state.borrow());
        self.watchers.borrow_mut().push((topics, widget.upcast_ref::<gtk::Widget>().downgrade(), Box::new(f)));
    }

    /// One of wadd's events.
    pub fn apply(self: &Rc<Self>, i: Incoming) {
        self.update(|s| match i {
            Incoming::Disconnected => {
                let was = s.connected;
                s.connected = false;
                if was { Topic::WADD } else { Topic::NONE }
            }
            Incoming::Other(..) => Topic::NONE,
            Incoming::Event(e) => {
                let wadd = if s.connected { Topic::NONE } else { Topic::WADD };
                s.connected = true;
                wadd | match e {
                    Event::Machine(m) => {
                        s.machine = Some(m);
                        Topic::MACHINE
                    }
                    Event::View(v) => {
                        s.view = Some(v);
                        Topic::VIEW
                    }
                    Event::Workspaces(w) => {
                        s.workspaces = w;
                        Topic::WORKSPACES
                    }
                    Event::WorkspaceState(st) => {
                        s.states.insert(st.id.clone(), st);
                        Topic::STATES
                    }
                    Event::Session(x) => {
                        s.session = x;
                        Topic::SESSION
                    }
                    Event::Network(n) => {
                        let changed = s.network.as_ref() != Some(&n);
                        s.network = Some(n);
                        if changed { Topic::NETWORK } else { Topic::NONE }
                    }
                    Event::Cloud(c) => {
                        // A heartbeat alone changes nothing shown.
                        let same = s.cloud.as_ref().is_some_and(|o| {
                            o.linked == c.linked && o.owner_uid == c.owner_uid && o.last_error == c.last_error
                        });
                        s.cloud = Some(c);
                        if same { Topic::NONE } else { Topic::CLOUD }
                    }
                    _ => Topic::NONE,
                }
            }
        });
    }
}
