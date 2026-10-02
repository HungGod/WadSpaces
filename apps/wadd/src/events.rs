//! What changed, for everyone watching /v1/events: a broadcast of events,
//! plus the latest of each kind so a new watcher starts from the present.

use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;
use wad_proto::v1::{Event, MachineInfo};

#[derive(Clone)]
pub struct Bus {
    tx: broadcast::Sender<Event>,
    machine: Arc<Mutex<MachineInfo>>,
}

impl Bus {
    pub fn new(machine: MachineInfo) -> Self {
        Self { tx: broadcast::channel(256).0, machine: Arc::new(Mutex::new(machine)) }
    }

    pub fn publish(&self, e: Event) {
        if let Event::Machine(m) = &e {
            *self.machine.lock().unwrap() = m.clone();
        }
        let _ = self.tx.send(e);
    }

    pub fn machine(&self) -> MachineInfo {
        self.machine.lock().unwrap().clone()
    }

    /// The current state (one event per kind), then whatever happens next.
    pub fn subscribe(&self) -> (Vec<Event>, broadcast::Receiver<Event>) {
        let rx = self.tx.subscribe();
        (vec![Event::Machine(self.machine())], rx)
    }
}
