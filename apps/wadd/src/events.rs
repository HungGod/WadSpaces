//! What changed, for everyone watching /v1/events: a broadcast of events,
//! plus the latest of each kind (and each workspace's state) so a new
//! watcher starts from the present.

use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;
use wad_proto::v1::{Event, MachineInfo, WorkspaceState};

#[derive(Clone)]
pub struct Bus {
    tx: broadcast::Sender<Event>,
    machine: Arc<Mutex<MachineInfo>>,
    states: Arc<Mutex<Vec<WorkspaceState>>>,
}

impl Bus {
    pub fn new(machine: MachineInfo) -> Self {
        Self { tx: broadcast::channel(256).0, machine: Arc::new(Mutex::new(machine)), states: Arc::default() }
    }

    pub fn publish(&self, e: Event) {
        match &e {
            Event::Machine(m) => *self.machine.lock().unwrap() = m.clone(),
            Event::WorkspaceState(st) => {
                let mut states = self.states.lock().unwrap();
                match states.iter_mut().find(|s| s.id == st.id) {
                    Some(s) => *s = st.clone(),
                    None => states.push(st.clone()),
                }
            }
            Event::Notice { .. } => {}
        }
        let _ = self.tx.send(e);
    }

    pub fn machine(&self) -> MachineInfo {
        self.machine.lock().unwrap().clone()
    }

    /// The workspaces there are now, in order (a new list replaces the old,
    /// without an event for each).
    pub fn set_states(&self, states: Vec<WorkspaceState>) {
        *self.states.lock().unwrap() = states;
    }

    /// The current state (the machine, then each workspace's), then whatever
    /// happens next.
    pub fn subscribe(&self) -> (Vec<Event>, broadcast::Receiver<Event>) {
        let rx = self.tx.subscribe();
        let mut now = vec![Event::Machine(self.machine())];
        now.extend(self.states.lock().unwrap().iter().cloned().map(Event::WorkspaceState));
        (now, rx)
    }
}
