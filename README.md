# WadBrowser

Chromium-based minimal browser (Electron) with no URL bar, WebRTC, drag-and-drop tabs, download manager, and packager integration for turning web addresses into desktop apps.

## Running the browser

**Prerequisites:** Node.js 18+ and npm.

```bash
# Install dependencies (once)
npm install

# Run the browser
npm run start

# Run and open a specific URL
npm run start -- --url "https://google.com"

# Run with a packager-generated config (app name, home URL, icon)
npm run start -- --config /path/to/config.json
```

**Build (Linux AppImage):**

```bash
npm run build
# Output: dist/WadBrowser.AppImage
```

Run the AppImage with an optional URL: `./dist/WadBrowser.AppImage "https://example.com"` or `./dist/WadBrowser.AppImage --url "https://example.com"`.

## Packager

The packager generates `config.json`, launcher scripts, and `.desktop` files so you can create desktop apps that open a specific site in WadBrowser.

**Prerequisites:** Python 3.9+ and the packager dependencies.

```bash
cd packager
python -m venv .venv
source .venv/bin/activate 
pip install -r requirements.txt
```

**Run the packager:**

```bash
# From project root (recommended)
python3 packager/packager.py

# Or from inside packager/
cd packager
python3 packager.py
```

Use `--project-dir` to point at the WadBrowser project root (so generated launchers run the Electron app). See `python3 packager/packager.py --help` for options. Input apps are listed in `packager/resources.json`.

## Login screening (url-redirect mode)

The generated **url-redirect** app registers WadBrowser as the system `http`/`https` handler, so any link opened by another application lands here. Because that destination is arbitrary, redirect launches are screened and only sign-in pages open.

This applies **only** to redirect launches (`--url` with no `--config`). Packaged mini-apps (`--config`) have a URL chosen at package time and are opened as-is.

**What gets through.** The link is judged from its address alone, so the verdict is instant and nothing is loaded before it is allowed. A link opens if it carries at least one clear sign-in signal:

- a known identity provider (`accounts.google.com`, `login.microsoftonline.com`, `*.okta.com`, …) or an auth hostname (`login.`, `sso.`, `auth.`, …)
- a login-shaped path — `/login`, `/users/sign_in`, `/oauth2/authorize`, `/mfa`, and camelCase or hyphenated forms like `/loginDeepControl` and `/Service-Login`
- OAuth/OIDC/SAML parameters, or a query naming the flow (`?mode=login`)

Anything else — `reddit.com/r/all`, a video, a file download, a non-http scheme — is blocked with a screen explaining why. There is no in-app override.

**Denylisted sites are refused before any of that.** A sign-in page on a social feed is still a doorway to the feed, so Reddit, X/Twitter, Facebook, Instagram, Threads, TikTok, YouTube, Snapchat, Pinterest, Tumblr, Twitch, LinkedIn, and similar are blocked even when the link is a real login page. Routes *through* an allowed host are caught too — `accounts.google.com/signin?service=youtube` and `?continue=https://youtube.com/` are both refused, while ordinary Google sign-in still works.

One consequence: a site's own OAuth endpoint is blocked with it, so "Continue with Facebook" on a third-party site will not complete. "Continue with Google" is unaffected — `accounts.google.com` is a separate host from `youtube.com`. Edit `BLOCKED_HOSTS` in `shared/login-screening.js` to fit; it is a plain list of domains and matches subdomains automatically.

**Judging by address is deliberately loose.** A page that merely looks like a login URL (`/wiki/Login`, a blog post about auth) will open. That is the accepted trade: waiting seconds on every link, or wrongly blocking a real sign-in, is worse than letting an uninteresting page through.

**Navigation is confined to the sign-in flow**, which is what keeps a loose match from becoming a browsing session. Once open, the window follows the login only: the auth host, its sign-in steps, and the identity provider's callback. When the flow reaches an ordinary page — the site's home page after a successful login — it stops and shows "Sign-in complete" instead of the page. These windows also have no new tabs, and cannot detach or dock tabs into a regular window.

To tune what counts as a login link, edit `shared/login-screening.js`.

## Features

- No search/URL bar (toolbar: back, forward, reload, home, downloads)
- Tabs: reorder by drag; drag to another window to dock or open in a new window; close last tab to close the window
- Download manager (list, progress, open folder, cancel)
- Context menu: Open link in new tab, Copy link, Copy
- Fullscreen (F11), minimize to tray when closing the last window
- Window: drag top bar to move; resize from bottom-right corner
- WebRTC supported
- Fedora KDE Plasma supported
- Redirected links are screened so only sign-in pages open (see Login screening)
