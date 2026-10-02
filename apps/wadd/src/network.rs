//! The machine's network for the app's Wi-Fi menu and the HUD (wad-net:
//! NetworkManager over D-Bus), and power (logind). The status is looked at
//! every 10 s and goes out as a network event when it changes; a change made
//! here is seen at once.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use wad_net::NetworkManager;
use wad_proto::v1::{Event, NetworkStatus, WifiNetwork};
use wad_proto::{ApiError, ErrorCode};

use crate::events::Bus;

const EVERY: Duration = Duration::from_secs(10);

fn status_of(s: wad_net::Status) -> NetworkStatus {
    NetworkStatus {
        available: s.available,
        state: s.state,
        connectivity: s.connectivity,
        wifi_enabled: s.wifi_enabled,
        wifi_device: s.wifi_device,
        ssid: s.ssid,
        signal: s.signal,
    }
}

fn api_error(e: wad_net::Error) -> ApiError {
    let code = match &e {
        wad_net::Error::Refused(_) => ErrorCode::BadRequest,
        wad_net::Error::NoWifi => ErrorCode::Conflict,
        wad_net::Error::Bus(_) => ErrorCode::Offline,
    };
    ApiError::new(code, e.to_string())
}

pub struct Network {
    /// None: no NetworkManager to talk to (a test, a bus that's down).
    nm: Option<NetworkManager>,
    bus: Bus,
    last: Mutex<Option<NetworkStatus>>,
}

impl Network {
    pub fn new(nm: Option<NetworkManager>, bus: Bus) -> Arc<Self> {
        Arc::new(Self { nm, bus, last: Mutex::default() })
    }

    fn nm(&self) -> Result<&NetworkManager, ApiError> {
        self.nm.as_ref().ok_or_else(|| ApiError::new(ErrorCode::Offline, "NetworkManager isn't reachable"))
    }

    /// The status now; published when it changed.
    pub async fn refresh(&self) -> NetworkStatus {
        let s = match &self.nm {
            Some(nm) => status_of(nm.status().await),
            None => status_of(wad_net::Status::unavailable()),
        };
        let changed = self.last.lock().unwrap().replace(s.clone()).as_ref() != Some(&s);
        if changed {
            self.bus.publish(Event::Network(s.clone()));
        }
        s
    }

    pub async fn status(&self) -> NetworkStatus {
        let last = self.last.lock().unwrap().clone();
        match last {
            Some(s) => s,
            None => self.refresh().await,
        }
    }

    /// Online enough to download: full connectivity (or NetworkManager can't
    /// tell, which mustn't hold downloads up forever).
    pub async fn online(&self) -> bool {
        match &self.nm {
            Some(nm) => matches!(nm.connectivity().await.as_str(), "full" | "unknown"),
            None => true,
        }
    }

    /// Waits until online, looking less often the longer it takes.
    pub async fn wait_online(&self) {
        let mut delay = Duration::from_secs(5);
        while !self.online().await {
            tracing::info!("waiting for the network");
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(60));
        }
    }

    pub async fn wifi(&self, rescan: bool) -> Result<Vec<WifiNetwork>, ApiError> {
        let nets = self.nm()?.scan(rescan).await.map_err(api_error)?;
        Ok(nets
            .into_iter()
            .map(|n| WifiNetwork {
                ssid: n.ssid,
                signal: n.signal,
                security: n.security,
                secure: n.secure,
                supported: n.supported,
                active: n.active,
                known: n.known,
            })
            .collect())
    }

    pub async fn connect(&self, ssid: &str, password: Option<&str>) -> Result<NetworkStatus, ApiError> {
        tracing::info!("joining {ssid:?}");
        let r = self.nm()?.connect(ssid, password).await.map_err(api_error);
        let s = self.refresh().await;
        r.map(|()| s)
    }

    pub async fn disconnect(&self) -> Result<NetworkStatus, ApiError> {
        self.nm()?.disconnect().await.map_err(api_error)?;
        Ok(self.refresh().await)
    }

    pub async fn forget(&self, ssid: &str) -> Result<bool, ApiError> {
        let gone = self.nm()?.forget(ssid).await.map_err(api_error)?;
        self.refresh().await;
        Ok(gone)
    }

    /// For as long as wadd runs.
    pub async fn run(self: Arc<Self>) {
        loop {
            self.refresh().await;
            tokio::time::sleep(EVERY).await;
        }
    }
}
