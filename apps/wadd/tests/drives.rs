//! Drives (drives.py's tests): lsblk, systemd-mount and udisksctl faked by
//! a host whose lsblk answer changes as things get mounted.

mod common;

use std::sync::Arc;

use async_trait::async_trait;
use common::host::{FakeHost, fixture};
use wadd::drives::{DRIVES_DIR, DriveError, Drives, LSBLK, Runner, parse_lsblk};

pub const STICK: &str = "5E3F-1A2B";
const DATA: &str = "bbbbbbbb-0000-4000-8000-000000000001";
const VAULT: &str = "cccccccc-0000-4000-8000-000000000001";

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn lsblk_keeps_only_data_drives() {
    let drives = parse_lsblk(&fixture().to_string());
    let uuids: Vec<&str> = drives.iter().map(|d| d.uuid.as_str()).collect();
    // Not: the loop device, anything on the system's disk (even its spare
    // partition), swap (zram too), LUKS and LVM members.
    assert_eq!(uuids, [DATA, VAULT, STICK]);
    assert_eq!(
        (drives[0].label.as_str(), drives[0].fstype.as_str(), drives[0].size),
        ("Data", "ext4", 1_500_000_000_000)
    );
    assert_eq!(
        (drives[0].mountpoint.as_deref(), drives[0].removable, drives[0].model.as_deref()),
        (Some("/mnt/data"), false, Some("WDC WD20EZAZ-00G"))
    );
    assert_eq!((drives[1].label.as_str(), drives[1].mountpoint.as_deref()), ("Vault", None)); // unlocked, inside LUKS
    assert_eq!((drives[2].fstype.as_str(), drives[2].size, drives[2].removable), ("exfat", 64_022_208_512, true));
    assert_eq!(drives[2].model.as_deref(), Some("SanDisk Ultra"));
}

#[test]
fn lsblk_list_form_and_old_style_values() {
    let flat = serde_json::json!({"blockdevices": [
        {"name": "sda", "uuid": null, "fstype": null, "size": "100", "type": "disk", "pkname": null, "model": "Disk", "rm": "0", "hotplug": "0", "mountpoint": null},
        {"name": "sda1", "uuid": "U1", "fstype": "ext4", "size": "90", "type": "part", "pkname": "sda", "rm": "0", "hotplug": "1", "mountpoint": "/run/media/wad/x"},
        {"name": "sdc", "uuid": null, "fstype": null, "size": "100", "type": "disk", "pkname": null},
        {"name": "sdc1", "uuid": "SYS", "fstype": "xfs", "size": "9", "type": "part", "pkname": "sdc", "mountpoint": "/"},
        {"name": "sdc2", "uuid": "SYS2", "fstype": "xfs", "size": "9", "type": "part", "pkname": "sdc"}]});
    let d = parse_lsblk(&flat.to_string());
    assert_eq!(d.len(), 1);
    assert_eq!(
        (d[0].uuid.as_str(), d[0].size, d[0].mountpoint.as_deref(), d[0].removable, d[0].model.as_deref()),
        ("U1", 90, Some("/run/media/wad/x"), true, None)
    );
    assert!(parse_lsblk("").is_empty());
}

#[tokio::test]
async fn as_root_systemd_mounts_it() {
    let host = FakeHost::new(None);
    let d = Drives::new(1000, Arc::new(host.clone()), true);
    assert_eq!(d.mount(STICK, "STICK", "").await.unwrap(), format!("{DRIVES_DIR}/{STICK}"));
    // FAT-like filesystems have no owners: mounted as the projects user.
    let want = s(&[
        "systemd-mount",
        "--no-block",
        "--collect",
        "-o",
        "uid=1000,gid=1000,umask=022",
        &format!("/dev/disk/by-uuid/{STICK}"),
        &format!("{DRIVES_DIR}/{STICK}"),
    ]);
    assert!(host.calls().contains(&want));
    assert_eq!(d.mount(VAULT, "Vault", "").await.unwrap(), format!("{DRIVES_DIR}/{VAULT}"));
    let want = s(&[
        "systemd-mount",
        "--no-block",
        "--collect",
        &format!("/dev/disk/by-uuid/{VAULT}"),
        &format!("{DRIVES_DIR}/{VAULT}"),
    ]);
    assert!(host.calls().contains(&want)); // xfs: as it is
}

#[tokio::test(start_paused = true)]
async fn systemd_mount_returns_before_the_mount_is_there() {
    let host = FakeHost::new(None);
    host.0.lock().unwrap().lag = 3;
    let d = Drives::new(1000, Arc::new(host.clone()), true);
    assert_eq!(d.mount(STICK, "", "").await.unwrap(), format!("{DRIVES_DIR}/{STICK}"));
    assert!(host.calls().iter().filter(|c| **c == s(&LSBLK)).count() >= 3);
}

#[tokio::test]
async fn as_a_user_udisks_mounts_it() {
    let host = FakeHost::new(None);
    let d = Drives::new(1000, Arc::new(host.clone()), false);
    assert_eq!(d.mount(STICK, "STICK", "").await.unwrap(), "/run/media/wad/STICK");
    assert!(host.calls().contains(&s(&[
        "udisksctl",
        "mount",
        "-b",
        &format!("/dev/disk/by-uuid/{STICK}"),
        "--no-user-interaction"
    ])));
}

#[tokio::test]
async fn mounted_missing_and_failing_drives() {
    let host = FakeHost::new(None);
    let d = Drives::new(1000, Arc::new(host.clone()), true);
    assert_eq!(d.mount(DATA, "", "").await.unwrap(), "/mnt/data");
    assert!(host.calls().iter().all(|c| c[0] == "lsblk")); // nothing to mount
    assert_eq!(
        d.mount("ffffffff-0000-4000-8000-000000000009", "Backup", "").await,
        Err(DriveError::Missing("plug in the drive Backup".into()))
    );
    assert!(matches!(d.mount("../etc", "", "").await, Err(DriveError::BadId(_))));
    host.0.lock().unwrap().fail_mount = true;
    assert_eq!(
        d.mount(STICK, "STICK", "").await,
        Err(DriveError::Failed("mounting STICK: Failed to mount: wrong fs type".into()))
    );
}

#[tokio::test]
async fn mountinfo_answers_when_lsblk_shows_no_mountpoint() {
    let t = tempfile::tempdir().unwrap();
    let by_uuid = t.path().join("by-uuid");
    std::fs::create_dir(&by_uuid).unwrap();
    std::fs::write(t.path().join("sdb1"), "").unwrap();
    std::os::unix::fs::symlink(t.path().join("sdb1"), by_uuid.join(STICK)).unwrap();
    let mountinfo = t.path().join("mountinfo");
    std::fs::write(
        &mountinfo,
        format!(
            "36 35 8:1 / /run/media/wad/MY\\040STICK rw,relatime shared:1 - exfat {}/sdb1 rw\n",
            t.path().display()
        ),
    )
    .unwrap();
    let host = FakeHost::new(None);
    let d = Drives::new(1000, Arc::new(host), true).with_paths(mountinfo, by_uuid);
    assert_eq!(d.mount(STICK, "", "").await.unwrap(), "/run/media/wad/MY STICK");
}

#[tokio::test]
async fn lsblk_missing() {
    struct Broken;
    #[async_trait]
    impl Runner for Broken {
        async fn run(&self, _: &[String]) -> (i32, String, String) {
            (127, String::new(), "lsblk is not installed".into())
        }
    }
    let d = Drives::new(1000, Arc::new(Broken), true);
    assert_eq!(d.list().await, Err(DriveError::Failed("lsblk: lsblk is not installed".into())));
    // The real runner, for a command that isn't there.
    let (code, _, _) = wadd::drives::System.run(&s(&["no-such-command-here"])).await;
    assert_eq!(code, 127);
}
