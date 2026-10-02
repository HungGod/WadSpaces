//! Who may use wadd's API: the caller's credentials (SO_PEERCRED on the Unix
//! socket), checked on every request. Root, wadd's own user, the listed users
//! (the kiosk user `wad`) and members of the listed groups (`wad`, `wheel`).
//! Everyone else gets 403.

/// The process on the other end of a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peer {
    pub uid: u32,
    pub gid: u32,
    pub pid: Option<i32>,
}

impl Peer {
    /// A connection whose credentials couldn't be read: allowed nowhere.
    pub const UNKNOWN: Peer = Peer { uid: u32::MAX, gid: u32::MAX, pid: None };
}

/// Looks users and groups up (the system's databases; fakes in tests).
pub trait Directory: Send + Sync {
    /// A user's name.
    fn user_name(&self, uid: u32) -> Option<String>;
    /// The names of the groups a user is in (primary and supplementary).
    fn user_groups(&self, name: &str, gid: u32) -> Vec<String>;
}

/// /etc/passwd and /etc/group (via NSS).
pub struct System;

impl Directory for System {
    fn user_name(&self, uid: u32) -> Option<String> {
        nix::unistd::User::from_uid(uid.into()).ok().flatten().map(|u| u.name)
    }

    fn user_groups(&self, name: &str, gid: u32) -> Vec<String> {
        let Ok(cname) = std::ffi::CString::new(name) else { return vec![] };
        nix::unistd::getgrouplist(&cname, gid.into())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|g| nix::unistd::Group::from_gid(g).ok().flatten().map(|g| g.name))
            .collect()
    }
}

pub struct Policy {
    /// wadd's own uid: always allowed (on a laptop, that's you).
    pub own_uid: u32,
    pub users: Vec<String>,
    pub groups: Vec<String>,
    pub directory: Box<dyn Directory>,
}

impl Policy {
    pub fn allows(&self, peer: &Peer) -> bool {
        if peer.uid == 0 || peer.uid == self.own_uid {
            return true;
        }
        if peer.uid == Peer::UNKNOWN.uid {
            return false;
        }
        let Some(name) = self.directory.user_name(peer.uid) else { return false };
        if self.users.contains(&name) {
            return true;
        }
        !self.groups.is_empty() && self.directory.user_groups(&name, peer.gid).iter().any(|g| self.groups.contains(g))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Directory for Fake {
        fn user_name(&self, uid: u32) -> Option<String> {
            Some(
                match uid {
                    1000 => "wad",
                    1001 => "admin",
                    1002 => "guest",
                    _ => return None,
                }
                .into(),
            )
        }
        fn user_groups(&self, name: &str, _gid: u32) -> Vec<String> {
            match name {
                "admin" => vec!["admin".into(), "wheel".into()],
                _ => vec![name.into()],
            }
        }
    }

    fn peer(uid: u32) -> Peer {
        Peer { uid, gid: uid, pid: Some(1) }
    }

    #[test]
    fn root_self_listed_users_and_groups() {
        let p =
            Policy { own_uid: 500, users: vec!["wad".into()], groups: vec!["wheel".into()], directory: Box::new(Fake) };
        assert!(p.allows(&peer(0)));
        assert!(p.allows(&peer(500)));
        assert!(p.allows(&peer(1000))); // the kiosk user
        assert!(p.allows(&peer(1001))); // in wheel
        assert!(!p.allows(&peer(1002))); // anyone else
        assert!(!p.allows(&peer(4242))); // no such user
        assert!(!p.allows(&Peer::UNKNOWN));
    }
}
