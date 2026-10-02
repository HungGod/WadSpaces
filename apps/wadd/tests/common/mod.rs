//! A fake machine for wadd's tests: podman, systemd and probes in memory.
#![allow(dead_code)]

pub mod host;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use wad_proto::v1::{Display, Workspace};
use wadd::backend::{Backend, OnLine};

#[derive(Default)]
pub struct Machine {
    pub images: HashSet<String>,
    pub containers: HashMap<String, String>,
    pub calls: Vec<String>,
    pub units: Vec<(String, String)>,
    /// URLs that answer.
    pub answering: HashSet<String>,
    /// Polls before a URL answers.
    pub answer_after: usize,
    pub polls: usize,
    pub pull_fails: Option<String>,
    pub start_fails: Option<String>,
    pub rx: u64,
    pub free_gb: f64,
    /// Container id -> its wadspaces.id label.
    pub labels: HashMap<String, String>,
    /// Image -> its labels (an image that's here and not listed has none).
    pub image_labels: HashMap<String, serde_json::Map<String, serde_json::Value>>,
    /// Volume -> where its files are.
    pub volumes: HashMap<String, String>,
    /// Times the units were written.
    pub installs: usize,
}

pub const TOKEN: &str = "ghp_TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";

#[derive(Clone, Default)]
pub struct Fake(pub Arc<Mutex<Machine>>);

impl Fake {
    pub fn with(&self, f: impl FnOnce(&mut Machine)) {
        f(&mut self.0.lock().unwrap());
    }
    pub fn calls(&self) -> Vec<String> {
        self.0.lock().unwrap().calls.clone()
    }
}

#[async_trait]
impl Backend for Fake {
    async fn available(&self) -> bool {
        true
    }
    async fn container(&self, name: &str) -> Result<String, String> {
        Ok(self.0.lock().unwrap().containers.get(name).cloned().unwrap_or_else(|| "missing".into()))
    }
    async fn image_exists(&self, image: &str) -> Result<bool, String> {
        Ok(self.0.lock().unwrap().images.contains(image))
    }
    async fn pull(&self, image: &str, mut on_line: OnLine) -> Result<(), String> {
        self.with(|m| m.calls.push(format!("pull {image}")));
        on_line("Copying blob sha256:abc");
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            self.with(|m| m.rx += 300);
        }
        let fail = self.0.lock().unwrap().pull_fails.clone();
        if let Some(e) = fail {
            return Err(e);
        }
        self.with(|m| {
            m.images.insert(image.into());
        });
        Ok(())
    }
    async fn start(&self, unit: &str) -> Result<(), String> {
        let fail = self.0.lock().unwrap().start_fails.clone();
        self.with(|m| m.calls.push(format!("start {unit}")));
        if let Some(e) = fail {
            return Err(e);
        }
        let name = unit.trim_end_matches(".service").to_string();
        self.with(|m| {
            m.containers.insert(name, "running".into());
        });
        Ok(())
    }
    async fn stop(&self, unit: &str) -> Result<(), String> {
        self.with(|m| {
            m.calls.push(format!("stop {unit}"));
            m.containers.remove(unit.trim_end_matches(".service"));
        });
        Ok(())
    }
    async fn restart(&self, unit: &str) -> Result<(), String> {
        self.with(|m| {
            m.calls.push(format!("restart {unit}"));
            m.containers.insert(unit.trim_end_matches(".service").into(), "running".into());
        });
        Ok(())
    }
    async fn install_units(&self, units: Vec<(String, String)>) -> Result<bool, String> {
        self.with(|m| {
            m.units = units;
            m.installs += 1;
        });
        Ok(true)
    }
    async fn http_ok(&self, url: &str) -> bool {
        let mut m = self.0.lock().unwrap();
        m.polls += 1;
        m.answering.contains(url) && m.polls > m.answer_after
    }
    async fn download_size(&self, image: &str) -> Option<(u64, u32)> {
        (!self.0.lock().unwrap().images.contains(image)).then_some((1000, 2))
    }
    fn rx_bytes(&self) -> u64 {
        self.0.lock().unwrap().rx
    }
    async fn image_labels(&self, image: &str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        let m = self.0.lock().unwrap();
        Ok(m.images.contains(image).then(|| m.image_labels.get(image).cloned().unwrap_or_default()))
    }
    async fn volume_mountpoint(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap().volumes.get(name).cloned()
    }
    async fn github_token(&self) -> Option<String> {
        Some(TOKEN.into())
    }
    async fn workspace_of(&self, container: &str) -> Option<String> {
        self.0.lock().unwrap().labels.get(container).cloned()
    }
    async fn free_gb(&self) -> Option<f64> {
        Some(self.0.lock().unwrap().free_gb)
    }
}

pub fn ws(id: &str, image: &str, display: Display, port: Option<u16>) -> Workspace {
    Workspace {
        id: id.into(),
        name: id.to_uppercase(),
        image: image.into(),
        display,
        port,
        hotkey: None,
        icon: None,
        enabled: true,
        autostart: false,
        container_name: format!("wad-{id}"),
        container_port: 3000,
        env: vec![("PUID".into(), "1000".into())],
        secrets: vec![],
        volumes: vec![],
        devices: vec![],
        shm_size: Some("1g".into()),
        projects: vec![],
    }
}
