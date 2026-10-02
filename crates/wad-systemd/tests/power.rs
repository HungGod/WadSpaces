//! Power off and restart against a fake logind on a private bus.

use std::sync::{Arc, Mutex};

use wad_systemd::Power;

struct Login(Arc<Mutex<Vec<String>>>);

#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl Login {
    fn power_off(&self, interactive: bool) {
        self.0.lock().unwrap().push(format!("PowerOff({interactive})"));
    }
    fn reboot(&self, interactive: bool) {
        self.0.lock().unwrap().push(format!("Reboot({interactive})"));
    }
}

#[tokio::test]
async fn powering_off_and_restarting_ask_logind_without_prompts() {
    let d = tempfile::tempdir().unwrap();
    let sock = d.path().join("bus");
    let addr = format!("unix:path={}", sock.display());
    let _daemon = tokio::process::Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--address", &addr])
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let calls = Arc::new(Mutex::new(vec![]));
    let _server = zbus::connection::Builder::address(addr.as_str())
        .unwrap()
        .name("org.freedesktop.login1")
        .unwrap()
        .serve_at("/org/freedesktop/login1", Login(calls.clone()))
        .unwrap()
        .build()
        .await
        .unwrap();
    let power = Power::on(zbus::connection::Builder::address(addr.as_str()).unwrap().build().await.unwrap());
    power.reboot().await.unwrap();
    power.power_off().await.unwrap();
    assert_eq!(*calls.lock().unwrap(), ["Reboot(false)", "PowerOff(false)"]);
}
