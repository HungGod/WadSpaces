# Cutover: from the Python wadd to the Rust wadd

The first image with the Rust wadd (`/usr/bin/wadd`, `wadd.socket` +
`wadd.service`) replaces the Python wadd. The old image stays on the machine
as bootc's rollback deployment, so going back is one command and a restart.

## What happens on the first boot

`wadd.service` runs `wadd migrate` before wadd starts (with full privileges,
once; it writes `/var/lib/wadspaces/migrated-from-python` when it's done):

1. **Workspaces become state.** `/etc/wadspaces/workspaces.yaml` (the old
   image's, as the machine kept it) becomes `/var/lib/wadspaces/workspaces.json`.
   The image's workspaces (`/usr/lib/wadspaces/workspaces.d/*.toml`) are applied
   over it, so the stale `/etc` copy needs no reset by hand any more. Projects
   each workspace mounts are kept. The YAML stays where it is, unused.
2. **Old units go.** The `wad-*.container` files the Python wadd generated in
   `/etc/containers/systemd`. The Rust wadd writes its own to
   `/run/containers/systemd` at every start. Files it didn't generate stay.
3. **The baked GitHub token goes**, only if podman's `github_token` is still
   the one old images baked in (it's revoked). A token from signing in to
   GitHub stays.

Everything else (`enrollment.json`, `projects/`, `runs.jsonl`,
`session.json`, `library/`, `seeded-secrets.json`) stays as it is, in the
Python wadd's formats.

## Steps

On the laptop:

```bash
host/build.sh update /dev/sdX    # plus --images/--bases as usual
```

On the Surface, before booting the update (optional, small):

```bash
sudo cp -a /var/lib/wadspaces /var/lib/wadspaces.before-cutover
sudo bootc status                # note the booted image
```

Boot the drive. It imports the update, restarts once into it, then:

```bash
journalctl -b -u wadd | grep 'wadd migrate'   # what the migration did
curl -s --unix-socket /run/wadd/wadd.sock http://wadd/v1/health
curl -s --unix-socket /run/wadd/wadd.sock http://wadd/v1/workspaces | head -c 600
ls /etc/containers/systemd       # no wad-*.container
```

Then the full checklist:

- [ ] Boots into Wad Creator; no Chromium; the HUD bar is there.
- [ ] Wi-Fi: join a network from the HUD, and from the app's Settings.
- [ ] Sign-in survives a restart; the machine is still linked (Settings).
- [ ] GitHub: repos load; `git push` from a workspace works.
- [ ] All six wadspaces open as windows, with their icons in the switcher.
- [ ] Super+Tab, Super+1..9, Super+0 / Super+Space; Alt+F4 does nothing.
- [ ] A focus session locks to its picks, and the HUD shows the timer.
- [ ] Build a design from the Builder ("Install on this machine").
- [ ] Open a project (git, folder, a USB drive).
- [ ] Power: restart from the HUD.
- [ ] Offline restart after sign-in still reaches Wad Creator.
- [ ] `systemctl is-active tailscaled` says inactive.

## Rollback rehearsal

```bash
sudo bootc rollback && sudo systemctl reboot
```

Back on the Python wadd (its image boots its own `/etc`, with its
workspaces.yaml and units):

- [ ] `curl -s http://127.0.0.1:8080/api/health` answers.
- [ ] Wad Creator signs in, shows the workspaces, and they open.
- [ ] Projects made under the Rust wadd are there; the machine is linked.

Then forward again (rollback swaps the two deployments):

```bash
sudo bootc rollback && sudo systemctl reboot
```

- [ ] `journalctl -b -u wadd | grep 'wadd migrate'` says "already done".
- [ ] Workspaces as they were before the rehearsal.

While rolled back, workspace changes go into the old image's own `/etc`,
which the new one never sees: back on the Rust wadd, the list is the one it
had. Everything under `/var/lib/wadspaces` (projects, the account link, runs)
is shared by both.

## If something's wrong

- `journalctl -b -u wadd` and `journalctl -b -t kiosk -t wadcreator`.
- Wad Creator's Diagnostics page (wadd's log and each workspace's).
- `sudo cp -a /var/lib/wadspaces.before-cutover/. /var/lib/wadspaces/` puts the
  state back as it was, if a rollback isn't enough.
