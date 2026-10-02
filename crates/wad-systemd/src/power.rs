//! Shutting down and restarting through logind (the kiosk has no desktop
//! menu). wadd is root on a machine, so it isn't asked; interactive is off,
//! so it never waits on a polkit prompt.

#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Login {
    fn power_off(&self, interactive: bool) -> zbus::Result<()>;
    fn reboot(&self, interactive: bool) -> zbus::Result<()>;
}

#[derive(Clone)]
pub struct Power {
    conn: zbus::Connection,
}

impl Power {
    pub async fn system() -> Result<Self, zbus::Error> {
        Ok(Self::on(zbus::Connection::system().await?))
    }

    /// On this bus (tests: a private one).
    pub fn on(conn: zbus::Connection) -> Self {
        Self { conn }
    }

    pub async fn power_off(&self) -> Result<(), zbus::Error> {
        LoginProxy::new(&self.conn).await?.power_off(false).await
    }

    pub async fn reboot(&self) -> Result<(), zbus::Error> {
        LoginProxy::new(&self.conn).await?.reboot(false).await
    }
}
