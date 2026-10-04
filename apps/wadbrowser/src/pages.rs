//! The browser's own pages, shown in a tab in place of one that couldn't load:
//! a failed load, a crashed page, an untrusted certificate. They're plain
//! HTML; their buttons are links to `wadbrowser-action:` addresses, which
//! the tab's navigation policy catches (`tab.rs`).

use crate::urlbar;
use gtk::gio;
use gtk::glib;
use std::cell::RefCell;
use std::collections::HashMap;
use webkit2gtk::{NetworkError, PolicyError, WebContextExt, WebProcessTerminationReason, WebView, WebViewExt};

pub const ACTION_SCHEME: &str = "wadbrowser-action";
/// WadBrowser's own pages (served by `serve`).
pub const SCHEME: &str = "wadbrowser";
/// The home page: the WadSpaces logo and a search box.
pub const HOME: &str = "wadbrowser://home";
/// The same without the search box (Focus windows: nowhere to go from it).
pub const HOME_PLAIN: &str = "wadbrowser://home?search=0";

pub fn is_home(uri: &str) -> bool {
    uri == HOME || uri.starts_with("wadbrowser://home?") || uri == "wadbrowser://home/"
}

/// Serves wadbrowser:// pages (registered on each profile's context).
pub fn serve(req: &webkit2gtk::URISchemeRequest) {
    use webkit2gtk::URISchemeRequestExt;
    let uri = req.uri().map(String::from).unwrap_or_default();
    if !is_home(&uri) {
        let mut e = glib::Error::new(gio::IOErrorEnum::NotFound, &format!("no page {uri}"));
        req.finish_error(&mut e);
        return;
    }
    let html = home_html(!uri.contains("search=0"));
    let bytes = glib::Bytes::from_owned(html.into_bytes());
    let len = bytes.len() as i64;
    req.finish(&gio::MemoryInputStream::from_bytes(&bytes), len, Some("text/html"));
}

const LOGO: &str = include_str!("../icons/hicolor/scalable/apps/wadbrowser.svg");

/// The home page, with or without its search box.
pub fn home_html(search: bool) -> String {
    let logo = LOGO.find("<svg").map_or(LOGO, |i| &LOGO[i..]);
    let search = if search {
        format!(
            r#"<form id="search" autocomplete="off"><input id="q" type="text" spellcheck="false" aria-label="Search or type an address" placeholder="{}"></form>"#,
            esc(&format!("Search {} or type an address", engine_name(&crate::config::get().search)))
        )
    } else {
        String::new()
    };
    include_str!("../ui/home.html").replace("{logo}", logo).replace("{search}", &search)
}

/// "DuckDuckGo" for https://duckduckgo.com/?q=%s, else the search's host.
fn engine_name(template: &str) -> String {
    let host = tauri::Url::parse(&template.replace("%s", "x"))
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_owned()))
        .unwrap_or_default();
    for (key, name) in [
        ("duckduckgo.", "DuckDuckGo"),
        ("google.", "Google"),
        ("bing.", "Bing"),
        ("startpage.", "Startpage"),
        ("kagi.", "Kagi"),
        ("ecosia.", "Ecosia"),
    ] {
        if host.starts_with(key) {
            return name.into();
        }
    }
    if host.is_empty() { "the web".into() } else { host }
}

thread_local! {
    /// A certificate the user may accept, by tab view: (cert, host, address).
    static TLS: RefCell<HashMap<usize, (gio::TlsCertificate, String, String)>> = RefCell::new(HashMap::new());
}

/// A page that didn't load. Cancelled loads and downloads aren't failures.
pub fn failed(view: &WebView, uri: &str, err: &glib::Error) -> bool {
    if err.matches(NetworkError::Cancelled) || err.matches(PolicyError::FrameLoadInterruptedByPolicyChange) {
        return false;
    }
    let host = tauri::Url::parse(uri).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
    let body = format!(
        "<p>{} didn't answer.</p><p class=detail>{}</p>",
        esc(if host.is_empty() { uri } else { &host }),
        esc(err.message())
    );
    show(view, uri, "This page didn't load", &body, &[("Try again", "reload")]);
    true
}

/// The page's process ended (a crash, or too much memory).
pub fn crashed(view: &WebView, reason: WebProcessTerminationReason) {
    let why = match reason {
        WebProcessTerminationReason::ExceededMemoryLimit => "It was using too much memory.",
        WebProcessTerminationReason::TerminatedByApi => return,
        _ => "Something went wrong in it.",
    };
    let uri = view.uri().map(String::from).unwrap_or_default();
    show(view, &uri, "This tab stopped", &format!("<p>{why}</p>"), &[("Reload", "reload")]);
}

/// A certificate WebKit doesn't trust. On this network (a dev server, a
/// printer) the user can go on anyway; on the internet they can't.
pub fn tls(view: &WebView, uri: &str, cert: &gio::TlsCertificate, _errors: gio::TlsCertificateFlags) -> bool {
    let host = tauri::Url::parse(uri).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
    let local = urlbar::local(&host);
    let mut body = format!(
        "<p>{} sent a certificate this browser doesn't trust, so the connection isn't private.</p>",
        esc(&host)
    );
    let mut buttons: Vec<(&str, &str)> = vec![("Try again", "reload")];
    if local {
        TLS.with_borrow_mut(|t| t.insert(crate::tab::key(view), (cert.clone(), host.clone(), uri.to_owned())));
        body.push_str("<p class=detail>It's on this network: if you know the device, you can go on.</p>");
        buttons.push(("Continue anyway", "allow-tls"));
    }
    show(view, uri, "Not a private connection", &body, &buttons);
    true
}

/// A button on one of these pages.
pub fn action(view: &WebView, uri: &str) {
    match uri.split_once(':').map(|(_, a)| a).unwrap_or_default() {
        "reload" => {
            if let Some(u) = view.uri() {
                view.load_uri(&u);
            }
        }
        // The home page's search box: an address, or a search (as the URL bar).
        a if a.starts_with("go?q=") => {
            let q = percent_decode(&a["go?q=".len()..]);
            if let Some(url) = urlbar::resolve(&q, &crate::config::get().search) {
                view.load_uri(&url);
            }
        }
        "allow-tls" => {
            if let Some((cert, host, uri)) = TLS.with_borrow_mut(|t| t.remove(&crate::tab::key(view)))
                && let Some(ctx) = view.context()
            {
                ctx.allow_tls_certificate_for_host(&cert, &host);
                view.load_uri(&uri);
            }
        }
        other => tracing::debug!(other, "unknown page action"),
    }
}

fn show(view: &WebView, uri: &str, title: &str, body: &str, buttons: &[(&str, &str)]) {
    let buttons: String = buttons
        .iter()
        .map(|(label, act)| format!(r#"<a class=btn href="{ACTION_SCHEME}:{act}">{}</a>"#, esc(label)))
        .collect();
    let html = PAGE.replace("{title}", &esc(title)).replace("{body}", body).replace("{buttons}", &buttons);
    view.load_alternate_html(&html, uri, None);
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
        } else {
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const PAGE: &str = r#"<!doctype html><html><head><meta charset=utf-8><title>{title}</title><style>
:root { color-scheme: light dark; --bg: #f6f6f7; --fg: #202124; --muted: #5f6368; --btn: #202124; --btnfg: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #202124; --fg: #e8eaed; --muted: #9aa0a6; --btn: #d4ff3d; --btnfg: #111; } }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 520px; margin: 18vh auto 0; padding: 0 24px; }
h1 { font-size: 24px; margin: 0 0 12px; }
.detail { color: var(--muted); font-size: 13px; word-break: break-word; }
.btn { display: inline-block; margin: 12px 10px 0 0; padding: 8px 18px; border-radius: 18px; background: var(--btn); color: var(--btnfg); text-decoration: none; }
</style></head><body><main><h1>{title}</h1>{body}<div>{buttons}</div></main></body></html>"#;

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_what_the_home_page_sends() {
        assert_eq!(percent_decode("rust%20%2B%20gtk"), "rust + gtk");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%é"), "%zz%é");
    }
}
