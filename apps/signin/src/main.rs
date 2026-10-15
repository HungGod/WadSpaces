//! The GitHub sign-in window of WadSpaces Client (the native one, which has
//! no web view of its own): the web portal's sign-in page in WebKit, for as
//! long as signing in takes, then gone.
//!
//!   client-signin PAGE_URL REPLY_HOST CLOSE_URL
//!
//! When the page goes to an address on REPLY_HOST (the answer: the GitHub
//! token, or why not), that address is printed as `{"reply": "<url>"}` and
//! the window closes (exit 0); the client reads the answer from it. Closed
//! (or Ctrl+W, which goes to CLOSE_URL): exit 1, nothing printed.
//!
//! Nothing is kept: the browsing data is ephemeral. Only https pages load;
//! no pop-ups. sway floats the window over the app (app_id client-signin).

use std::cell::Cell;
use std::rc::Rc;

use gtk::prelude::*;
use webkit2gtk::{
    HardwareAccelerationPolicy, NavigationPolicyDecision, NavigationPolicyDecisionExt, PolicyDecisionExt,
    PolicyDecisionType, Settings, SettingsExt, URIRequestExt, UserContentInjectedFrames, UserContentManager,
    UserContentManagerExt, UserScript, UserScriptInjectionTime, WebContext, WebView, WebViewExt, WebsiteDataManager,
};

const TITLE: &str = "Sign in to GitHub";

/// window.open does nothing; Ctrl+W goes to the close address.
const SCRIPT: &str = r#"(() => {
  window.open = () => null;
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      location.href = "__CLOSE__";
    }
  }, true);
})();"#;

/// Where the page may go: https pages (GitHub's sign-in passes through its
/// own hosts and Firebase's), nothing else.
fn allowed(uri: &str) -> bool {
    uri.starts_with("https://")
}

fn host_of(uri: &str) -> &str {
    uri.split_once("://").map(|(_, r)| r).unwrap_or("").split(['/', '?', '#', ':']).next().unwrap_or("")
}

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [page, reply_host, close_url] = args.as_slice() else {
        eprintln!("usage: client-signin PAGE_URL REPLY_HOST CLOSE_URL");
        return std::process::ExitCode::from(2);
    };
    if !allowed(page) {
        eprintln!("client-signin: not an https page: {page}");
        return std::process::ExitCode::from(2);
    }
    // The window's app_id on Wayland.
    gtk::glib::set_prgname(Some("client-signin"));
    gtk::glib::set_application_name(TITLE);
    if gtk::init().is_err() {
        eprintln!("client-signin: no display");
        return std::process::ExitCode::from(2);
    }
    let answered = Rc::new(Cell::new(false));

    let data = WebsiteDataManager::new_ephemeral();
    let context = WebContext::builder().website_data_manager(&data).build();
    let scripts = UserContentManager::new();
    scripts.add_script(&UserScript::new(
        &SCRIPT.replace("__CLOSE__", close_url),
        UserContentInjectedFrames::AllFrames,
        UserScriptInjectionTime::Start,
        &[],
        &[],
    ));
    let settings = Settings::new();
    // A sign-in page needs no GPU (and a headless or odd one can't break it).
    settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
    settings.set_enable_developer_extras(false);
    let view = WebView::builder().web_context(&context).user_content_manager(&scripts).settings(&settings).build();

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title(TITLE);
    window.set_default_size(900, 720);
    window.add(&view);
    window.connect_delete_event(|_, _| {
        gtk::main_quit();
        gtk::glib::Propagation::Proceed
    });

    // No new windows.
    view.connect_create(|_, _| None);
    let (reply_host, close_url) = (reply_host.clone(), close_url.clone());
    let done = answered.clone();
    view.connect_decide_policy(move |_, decision, kind| {
        if !matches!(kind, PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction) {
            return false;
        }
        let Some(nav) = decision.downcast_ref::<NavigationPolicyDecision>() else { return false };
        let Some(uri) = nav.navigation_action().and_then(|a| a.request()).and_then(|r| r.uri()).map(String::from)
        else {
            return false;
        };
        if host_of(&uri) == reply_host {
            decision.ignore();
            println!("{}", serde_json::json!({ "reply": uri }));
            done.set(true);
            gtk::main_quit();
            return true;
        }
        if uri == close_url {
            decision.ignore();
            gtk::main_quit();
            return true;
        }
        if kind == PolicyDecisionType::NewWindowAction || !allowed(&uri) {
            eprintln!("client-signin: blocked {uri}");
            decision.ignore();
            return true;
        }
        false
    });

    view.load_uri(page);
    window.show_all();
    gtk::main();
    if answered.get() { std::process::ExitCode::SUCCESS } else { std::process::ExitCode::from(1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_on_https_and_knows_its_hosts() {
        assert!(
            allowed("https://github.com/login/oauth")
                && !allowed("http://github.com")
                && !allowed("file:///etc/passwd")
        );
        assert_eq!(host_of("https://signed-in.client.invalid/?n=1&token=x"), "signed-in.client.invalid");
        assert_eq!(host_of("https://a.b:443/x"), "a.b");
        assert_eq!(host_of("nonsense"), "");
    }
}
