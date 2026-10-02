//! wadd, from the HUD: its event stream (followed on a thread, delivered to
//! the GTK loop through a channel) and the few calls the buttons make. Today
//! that's the Python wadd on 127.0.0.1:8080 (WADD_URL); the Rust wadd's /v1
//! over its socket replaces it at the cutover.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::model::WifiNetwork;

pub enum Incoming {
    /// A wadd event: its name and data.
    Event(String, Value),
    /// The stream dropped (it reconnects by itself).
    Disconnected,
}

#[derive(Clone)]
pub struct Wadd {
    base: String,
    agent: ureq::Agent,
}

impl Wadd {
    pub fn from_env() -> Self {
        let base = std::env::var("WADD_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(40)))
            .http_status_as_error(false)
            .build()
            .into();
        Self { base: base.trim_end_matches('/').into(), agent }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// The body of a failed call: wadd's `detail`, else the status.
    fn failure(status: u16, body: &str) -> String {
        serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v.get("detail").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| format!("wadd answered {status}"))
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let mut res = self.agent.get(&self.url(path)).call().map_err(|e| format!("can't reach wadd: {e}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
        if !(200..300).contains(&status) {
            return Err(Self::failure(status, &body));
        }
        serde_json::from_str(&body).map_err(|e| e.to_string())
    }

    fn post(&self, path: &str, body: Value) -> Result<(), String> {
        let mut res =
            self.agent.post(&self.url(path)).send_json(&body).map_err(|e| format!("can't reach wadd: {e}"))?;
        let status = res.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let text = res.body_mut().read_to_string().unwrap_or_default();
        Err(Self::failure(status, &text))
    }

    /// Wad Creator on screen (what Super+0 does).
    pub fn home(&self) -> Result<(), String> {
        self.post("/api/keys/action", json!({ "action": "launcher" }))
    }

    pub fn power(&self, action: &str) -> Result<(), String> {
        self.post("/api/power", json!({ "action": action }))
    }

    pub fn wifi_scan(&self) -> Result<Vec<WifiNetwork>, String> {
        self.get("/api/network/wifi")
    }

    pub fn wifi_connect(&self, ssid: &str, password: Option<&str>) -> Result<(), String> {
        let mut body = json!({ "ssid": ssid });
        if let Some(p) = password.filter(|p| !p.is_empty()) {
            body["password"] = p.into();
        }
        self.post("/api/network/wifi/connect", body)
    }

    pub fn wifi_disconnect(&self) -> Result<(), String> {
        self.post("/api/network/wifi/disconnect", json!({}))
    }

    /// A workspace's icon (`/api/icons/<id>`), as bytes.
    pub fn bytes(&self, path: &str) -> Option<Vec<u8>> {
        let mut res = self.agent.get(&self.url(path)).call().ok()?;
        if res.status().as_u16() != 200 {
            return None;
        }
        res.body_mut().with_config().limit(4 << 20).read_to_vec().ok()
    }

    /// Follows wadd's server-sent events for as long as the HUD runs.
    pub fn follow(&self, tx: async_channel::Sender<Incoming>) {
        let me = self.clone();
        std::thread::spawn(move || {
            loop {
                let _ = me.stream_once(&tx);
                if tx.send_blocking(Incoming::Disconnected).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        });
    }

    fn stream_once(&self, tx: &async_channel::Sender<Incoming>) -> Result<(), String> {
        let agent: ureq::Agent =
            ureq::Agent::config_builder().timeout_global(None).http_status_as_error(false).build().into();
        let mut res = agent
            .get(&self.url("/api/events"))
            .header("accept", "text/event-stream")
            .call()
            .map_err(|e| e.to_string())?;
        if res.status().as_u16() != 200 {
            return Err(format!("status {}", res.status()));
        }
        let reader = BufReader::new(res.body_mut().as_reader());
        let (mut name, mut data) = (String::new(), Vec::<String>::new());
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                if !data.is_empty() {
                    let value = serde_json::from_str(&data.join("\n")).unwrap_or(Value::Null);
                    let ev = if name.is_empty() { "message".to_string() } else { std::mem::take(&mut name) };
                    if tx.send_blocking(Incoming::Event(ev, value)).is_err() {
                        return Ok(());
                    }
                }
                name.clear();
                data.clear();
            } else if let Some(v) = line.strip_prefix("event:") {
                name = v.trim().into();
            } else if let Some(v) = line.strip_prefix("data:") {
                data.push(v.strip_prefix(' ').unwrap_or(v).into());
            }
        }
        Ok(())
    }
}
