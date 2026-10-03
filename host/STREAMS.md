# Viewing wadspaces on other devices (M11)

A machine can stream a wadspace to your other WadSpaces machines, and to a
phone or laptop browser, on **the same local network**. Nothing goes over the
internet, and the account only carries who may ask (your commands) and where
to look (each machine's LAN links and certificate fingerprint).

## How it's protected

- **Off until you turn it on at the machine itself.** In Wad Creator on that
  machine: Viewing → "Let other devices view wadspaces here". The account,
  the online portal and other machines can't turn it on; they can only ask
  a machine that already allows it. Turning it off ends every stream at once.
- **A stream password.** Set in Viewing, or on the online Manager page. It's
  write-only in the account (the rules don't let it be read back), at least
  12 characters ("Make one" gives 20 random ones; use that). No password, a
  short one, or a changed one: no stream, and running streams end.
- **TLS only, with the machine's own certificate.** Each machine makes one,
  and its SHA-256 fingerprint goes in the account. Your machines accept
  exactly that certificate (pinned). A phone's browser warns once, and Wad
  Creator shows the fingerprint to compare. The stream's plain-HTTP port is
  never published.
- **Sign-in on everything.** The stream's web server asks for your username
  and the stream password on every path, the video websocket included.
- **Only while it's being viewed.** A wadspace is streamed only when it's
  asked for, never in the background. Ending it (Stop, or switching to it at
  the machine) takes the stream down.
- **The person at the machine wins.** Switching to a streamed wadspace there
  brings it back to the screen and ends the stream. A remote request takes it
  off the screen only if you confirm.
- **On the viewing machine** the password never reaches the page. That
  machine's wadd adds it, and checks the certificate. The window shows that
  one stream, keeps nothing, and can't call the app's commands.

**What it doesn't protect against.** Anyone on the same network can reach a
running stream's sign-in. On networks you don't trust (cafés, hotels), keep
Viewing off. A weak password is the weak point: use "Make one".

## Trying it (Surface + phone, and + laptop browser)

1. **Update the Surface.** Run `host/build.sh update /dev/sdX --bases`. The
   sidecar image `localhost/wadspaces-stream:trixie` comes with `--bases`; a
   machine without it can't stream.
2. On the Surface, open Wad Creator → **Viewing** (sidebar).
   - Set the stream password ("Make one", then keep it in your password manager).
   - Turn on "Let other devices view wadspaces here".
   - Under "Show one on a phone", pick Writing.
3. **Phone, on the same Wi-Fi.**
   - Scan the QR code.
   - The browser warns about the certificate. Compare its SHA-256 with the
     one in Viewing, and go on only if they match.
   - Sign in with your username (shown there) and the stream password.
   - The desktop shows. Type and click in it.
4. **Laptop browser, online portal, same Wi-Fi.**
   - Manager → the Surface → Writing → "View on this device".
   - The links appear. Open one and check the fingerprint the same way.
5. **Fail-closed checks.**
   - Turn Viewing off. The stream ends within seconds, and its link no
     longer answers.
   - Change the stream password while streaming. The stream ends, and the
     new password works on the next one.
   - Press Super+1 on the Surface while Writing is streamed. It comes back
     to the screen, and the phone loses it.
6. **With a second WadSpaces machine.** In its Manager, pick the Surface →
   Writing → "View here". It opens in a window over Wad Creator. Ctrl+W or
   Close ends it.

No Firebase rules or function changes come with M11. The functions and
rules change from M6 is still waiting for your deploy.

## For development

- `apps/wadd/dev/try-stream.sh` streams on this laptop with real podman.
  `VIEW=1` also opens Wad Creator's stream window and snapshots it.
- `wadd view --url … --sha256 … --user … --password-file …` views a stream
  without the account.
