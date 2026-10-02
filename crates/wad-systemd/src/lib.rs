//! systemd over D-Bus, for wadd's workspace units (quadlet's
//! wad-<id>.service): the system manager on a machine, your user manager on
//! a laptop (`wadd serve --user`). Each operation waits for its job to finish
//! (JobRemoved) and says how it ended, instead of shelling out to systemctl.

use std::time::Duration;

mod power;
pub use power::Power;

use futures_util::StreamExt;
use zbus::zvariant::OwnedObjectPath;

#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Manager",
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1"
)]
trait Manager {
    fn start_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn stop_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn restart_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn reload(&self) -> zbus::Result<()>;
    fn subscribe(&self) -> zbus::Result<()>;
    fn load_unit(&self, name: &str) -> zbus::Result<OwnedObjectPath>;
    #[zbus(signal)]
    fn job_removed(&self, id: u32, job: OwnedObjectPath, unit: String, result: String) -> zbus::Result<()>;
}

#[zbus::proxy(interface = "org.freedesktop.systemd1.Unit", default_service = "org.freedesktop.systemd1")]
trait Unit {
    #[zbus(property)]
    fn active_state(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn load_state(&self) -> zbus::Result<String>;
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("systemd: {0}")]
    Bus(#[from] zbus::Error),
    /// The job ended, but not well: "failed", "timeout", "dependency", ...
    #[error("{op} {unit}: {result}")]
    Job { op: &'static str, unit: String, result: String },
    #[error("{op} {unit}: no answer from systemd in {secs} s")]
    Timeout { op: &'static str, unit: String, secs: u64 },
}

#[derive(Clone)]
pub struct Systemd {
    conn: zbus::Connection,
}

#[derive(Clone, Copy)]
enum Op {
    Start,
    Stop,
    Restart,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Start => "start",
            Op::Stop => "stop",
            Op::Restart => "restart",
        }
    }
}

impl Systemd {
    /// The system manager (a machine; wadd runs as root).
    pub async fn system() -> Result<Self, Error> {
        Ok(Self { conn: zbus::Connection::system().await? })
    }

    /// Your user manager (a laptop).
    pub async fn user() -> Result<Self, Error> {
        Ok(Self { conn: zbus::Connection::session().await? })
    }

    async fn manager(&self) -> Result<ManagerProxy<'_>, Error> {
        Ok(ManagerProxy::new(&self.conn).await?)
    }

    /// Re-reads unit files (and runs generators: quadlet turns
    /// wad-<id>.container into wad-<id>.service here). Returns once done.
    pub async fn reload(&self) -> Result<(), Error> {
        Ok(self.manager().await?.reload().await?)
    }

    pub async fn start(&self, unit: &str, timeout: Duration) -> Result<(), Error> {
        self.job(Op::Start, unit, timeout).await
    }

    pub async fn stop(&self, unit: &str, timeout: Duration) -> Result<(), Error> {
        self.job(Op::Stop, unit, timeout).await
    }

    pub async fn restart(&self, unit: &str, timeout: Duration) -> Result<(), Error> {
        self.job(Op::Restart, unit, timeout).await
    }

    /// "active", "inactive", "failed", "activating", ...
    pub async fn active_state(&self, unit: &str) -> Result<String, Error> {
        let path = self.manager().await?.load_unit(unit).await?;
        let u = UnitProxy::builder(&self.conn).path(path)?.build().await?;
        Ok(u.active_state().await?)
    }

    async fn job(&self, op: Op, unit: &str, timeout: Duration) -> Result<(), Error> {
        let m = self.manager().await?;
        m.subscribe().await.ok(); // already subscribed is fine
        // Listen before asking, so a quick job's end isn't missed.
        let mut removed = m.receive_job_removed().await?;
        let job = match op {
            Op::Start => m.start_unit(unit, "replace").await?,
            Op::Stop => m.stop_unit(unit, "replace").await?,
            Op::Restart => m.restart_unit(unit, "replace").await?,
        };
        let wait = async {
            while let Some(sig) = removed.next().await {
                let Ok(args) = sig.args() else { continue };
                if args.job == job {
                    return Some(args.result.clone());
                }
            }
            None
        };
        let secs = timeout.as_secs();
        match tokio::time::timeout(timeout, wait).await {
            Ok(Some(r)) if r == "done" => Ok(()),
            Ok(Some(r)) => Err(Error::Job { op: op.name(), unit: unit.into(), result: r }),
            Ok(None) => Err(Error::Job { op: op.name(), unit: unit.into(), result: "the signal stream ended".into() }),
            Err(_) => Err(Error::Timeout { op: op.name(), unit: unit.into(), secs }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Your user manager, with a throwaway unit in $XDG_RUNTIME_DIR/systemd/user:
    /// cargo test -p wad-systemd -- --ignored
    #[tokio::test]
    #[ignore]
    async fn real_user_manager() {
        let dir = std::path::PathBuf::from(std::env::var("XDG_RUNTIME_DIR").unwrap()).join("systemd/user");
        std::fs::create_dir_all(&dir).unwrap();
        let unit = "wadd-systemd-test.service";
        std::fs::write(dir.join(unit), "[Service]\nExecStart=/usr/bin/sleep 60\n").unwrap();
        let fail = "wadd-systemd-test-fail.service";
        std::fs::write(dir.join(fail), "[Service]\nType=oneshot\nExecStart=/usr/bin/false\n").unwrap();
        let s = Systemd::user().await.unwrap();
        s.reload().await.unwrap();
        let t = Duration::from_secs(10);
        s.start(unit, t).await.unwrap();
        assert_eq!(s.active_state(unit).await.unwrap(), "active");
        s.restart(unit, t).await.unwrap();
        s.stop(unit, t).await.unwrap();
        assert_eq!(s.active_state(unit).await.unwrap(), "inactive");
        let e = s.start(fail, t).await.unwrap_err();
        assert_eq!(e.to_string(), format!("start {fail}: failed"));
        std::fs::remove_file(dir.join(unit)).unwrap();
        std::fs::remove_file(dir.join(fail)).unwrap();
        s.reload().await.unwrap();
    }
}
