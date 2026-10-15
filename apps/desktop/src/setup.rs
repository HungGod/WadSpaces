//! First run on a machine, one step at a time (the web app's
//! components/machine/MachineGate.tsx and setup.ts): Wi-Fi until it's
//! online, signing in with GitHub, a username, linking the machine to the
//! account (which puts the sign-in's GitHub token in place), then the app.
//! Every boot starts signed out; linking and GitHub stay done.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::{glib, prelude::*};
use wad_gtk::{Icon, Theme};
use wad_proto::v1::WifiNetwork;

use crate::account;
use crate::rt;
use crate::store::{AppState, ProfileState, Topic, store};
use crate::ui::{self, Size, Variant};

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// Not known yet.
    Loading,
    /// The account's settings aren't on this machine.
    Unconfigured(String),
    Wifi,
    SignIn,
    /// Signed in without a username.
    Welcome,
    Link,
    /// The machine is someone else's.
    Relink,
    Github,
    Done,
}

/// The step `s` is at. `waited`: wadd had a few seconds to answer (without
/// it there's nothing to set up: the app isn't held hostage).
pub fn step(s: &AppState, waited: bool) -> Step {
    let a = &s.account;
    if !a.checked || (!s.connected && !waited) {
        return Step::Loading;
    }
    if let Some(e) = &a.unconfigured {
        return Step::Unconfigured(e.clone());
    }
    let Some(user) = &a.user else {
        return if s.connected && !s.online() { Step::Wifi } else { Step::SignIn };
    };
    match a.profile {
        ProfileState::Unknown => return Step::Loading,
        ProfileState::Missing => return Step::Welcome,
        ProfileState::Have(_) => {}
    }
    // A wadd without account settings (a laptop's) can't be linked: it's yours.
    if let Some(cloud) = s.cloud.as_ref().filter(|_| s.connected) {
        match cloud.owner_uid.as_deref() {
            Some(o) if o == user.uid => {}
            Some(_) => return Step::Relink,
            None => return Step::Link,
        }
    }
    if s.connected && a.github == Some(false) && !a.github_later && !account::has_pending() {
        return Step::Github;
    }
    Step::Done
}

/// The frame the setup screens are in (the web app's AuthCard): the logo,
/// the card, the theme switch in the corner.
struct Frame {
    root: gtk::Overlay,
    slot: gtk::Box,
}

fn frame() -> Frame {
    let root = gtk::Overlay::new();
    let back = gtk::Box::new(gtk::Orientation::Vertical, 0);
    back.add_css_class("backdrop");
    back.add_css_class("auth-backdrop");
    root.set_child(Some(&back));

    let column = gtk::Box::new(gtk::Orientation::Vertical, 0);
    column.add_css_class("auth-column");
    column.set_halign(gtk::Align::Center);
    column.set_valign(gtk::Align::Center);
    let logo_svg = |t: Theme| -> &'static [u8] {
        match t {
            Theme::Dark => include_bytes!("../../../apps/client/public/brand/wadspaces-logo-dark.svg"),
            Theme::Light => include_bytes!("../../../apps/client/public/brand/wadspaces-logo-light.svg"),
        }
    };
    // The lockup is 880×560: 144 tall.
    let logo = wad_gtk::Svg::new(logo_svg(wad_gtk::theme::shown()), 226, 144);
    logo.add_css_class("auth-logo");
    logo.set_halign(gtk::Align::Center);
    let l = logo.clone();
    wad_gtk::theme::on_change(move |t| l.set(logo_svg(t)));
    column.append(&logo);
    let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
    column.append(&slot);
    let foot = gtk::Label::new(Some("WAD SPACES · your workspaces, on your machines"));
    foot.add_css_class("auth-foot");
    column.append(&foot);
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
    scroll.set_child(Some(&column));
    root.add_overlay(&scroll);

    let (toggle, _) = crate::shell::theme_toggle();
    toggle.set_halign(gtk::Align::End);
    toggle.set_valign(gtk::Align::Start);
    toggle.set_size_request(176, -1);
    toggle.add_css_class("auth-theme");
    root.add_overlay(&toggle);
    Frame { root, slot }
}

thread_local! {
    static GATE: RefCell<Option<gtk::Stack>> = const { RefCell::new(None) };
}

/// The app, whatever the setup says (snapshots).
pub fn show_app() {
    GATE.with(|g| {
        if let Some(s) = g.borrow().as_ref() {
            s.set_visible_child_name("app");
        }
    });
}

/// The gate: setup until it's done, then `app`. In a stack, so the app
/// isn't built twice.
pub fn gate(app: gtk::Widget) -> gtk::Widget {
    let stack = gtk::Stack::new();
    GATE.with(|g| g.replace(Some(stack.clone())));
    stack.set_transition_type(gtk::StackTransitionType::Crossfade);
    stack.set_transition_duration(200);
    let loading = gtk::Box::new(gtk::Orientation::Vertical, 0);
    loading.add_css_class("backdrop");
    let spin = gtk::Spinner::new();
    spin.set_size_request(24, 24);
    spin.start();
    spin.set_vexpand(true);
    spin.set_valign(gtk::Align::Center);
    loading.append(&spin);
    stack.add_named(&loading, Some("loading"));
    let f = frame();
    stack.add_named(&f.root, Some("setup"));
    stack.add_named(&app, Some("app"));

    let shown: Rc<RefCell<Option<Step>>> = Rc::default();
    let waited = Rc::new(Cell::new(false));
    let saving = Rc::new(Cell::new(false));
    let slot = f.slot.clone();
    // Snapshots of each screen: WADSPACES_SNAPSHOT_STEP names the one to show.
    let forced = std::env::var("WADSPACES_SNAPSHOT_STEP").ok().and_then(|s| forced_step(&s));
    let redraw = {
        let (stack, waited, saving) = (stack.clone(), waited.clone(), saving.clone());
        Rc::new(move |s: &AppState| {
            // The sign-in's token goes in once the machine is this person's.
            let mine = s.account.user.is_some()
                && matches!(s.account.profile, ProfileState::Have(_))
                && s.cloud.as_ref().is_none_or(|c| c.owner_uid == s.account.user.as_ref().map(|u| u.uid.clone()));
            if mine && s.connected && account::has_pending() && !saving.replace(true) {
                let saving = saving.clone();
                glib::spawn_future_local(async move {
                    if let Err(e) = account::save_pending().await {
                        tracing::warn!("GitHub token not saved: {e}");
                    }
                    saving.set(false);
                });
            } else if mine && s.connected && s.account.github.is_none() && !saving.replace(true) {
                let saving = saving.clone();
                glib::spawn_future_local(async move {
                    account::check_github().await;
                    saving.set(false);
                });
            }
            let st = forced.clone().unwrap_or_else(|| step(s, waited.get()));
            if shown.borrow().as_ref() == Some(&st) {
                return;
            }
            shown.replace(Some(st.clone()));
            match &st {
                Step::Loading => stack.set_visible_child_name("loading"),
                Step::Done => stack.set_visible_child_name("app"),
                other => {
                    ui::clear(&slot);
                    let wide =
                        matches!(other, Step::Wifi) || (matches!(other, Step::Link | Step::Relink) && !s.online());
                    // The card's width (the web app's max-w); the column adds its padding.
                    slot.set_size_request(if wide { 640 } else { 420 }, -1);
                    slot.append(&screen(other, s));
                    stack.set_visible_child_name("setup");
                }
            }
        })
    };
    let r = redraw.clone();
    store().watch(&stack, Topic::ACCOUNT | Topic::NETWORK | Topic::CLOUD | Topic::WADD | Topic::MACHINE, move |s| r(s));
    let r = redraw.clone();
    glib::timeout_add_seconds_local_once(3, move || {
        waited.set(true);
        store().read_now(|s| r(s));
    });
    stack.upcast()
}

fn forced_step(name: &str) -> Option<Step> {
    Some(match name {
        "wifi" => Step::Wifi,
        "signin" => Step::SignIn,
        "welcome" => Step::Welcome,
        "link" => Step::Link,
        "relink" => Step::Relink,
        "github" => Step::Github,
        _ => return None,
    })
}

fn screen(step: &Step, s: &AppState) -> gtk::Widget {
    match step {
        Step::Unconfigured(e) => {
            ui::card("This machine can't sign you in", Some("Its account settings are missing."), &ui::notice(e, true))
                .upcast()
        }
        Step::Wifi => {
            ui::card("Connect to Wi-Fi", Some("This machine needs the internet to sign you in."), &wifi_panel())
                .upcast()
        }
        Step::SignIn => sign_in_card(),
        Step::Welcome => welcome_card(s),
        Step::Link | Step::Relink => {
            let name = s.machine.as_ref().map(|m| m.name.clone()).unwrap_or_else(|| "WadSpaces machine".into());
            if !s.online() {
                ui::card(
                    "Connect to Wi-Fi",
                    Some("Linking this machine to your account needs the internet."),
                    &wifi_panel(),
                )
                .upcast()
            } else {
                link_card(name, *step == Step::Relink)
            }
        }
        Step::Github => github_card(s),
        Step::Loading | Step::Done => gtk::Box::new(gtk::Orientation::Vertical, 0).upcast(),
    }
}

/// An error under what failed (replaced by the next one).
fn error_slot() -> gtk::Box {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
    b.add_css_class("error-slot");
    b
}

fn show_error(slot: &gtk::Box, e: Option<&str>) {
    ui::clear(slot);
    if let Some(e) = e {
        slot.append(&ui::notice(e, true));
    }
}

fn sign_in_card() -> gtk::Widget {
    let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let button = ui::github_button("Sign in with GitHub");
    body.append(&button);
    let status = gtk::Box::new(gtk::Orientation::Vertical, 0);
    body.append(&status);
    let err = error_slot();
    body.append(&err);
    button.connect_clicked(move |b| {
        b.set_sensitive(false);
        ui::clear(&status);
        status.append(&ui::busy("Finish signing in on GitHub's page. Close it (Ctrl+W) to cancel."));
        show_error(&err, None);
        let (b, status, err) = (b.clone(), status.clone(), err.clone());
        glib::spawn_future_local(async move {
            let r = account::sign_in().await;
            ui::clear(&status);
            b.set_sensitive(true);
            if let Err(e) = r {
                show_error(&err, Some(&e));
            }
        });
    });
    ui::card(
        "Welcome",
        Some("Sign in with GitHub to build and run your wadspaces. Your projects are your GitHub repositories."),
        &body,
    )
    .upcast()
}

fn welcome_card(s: &AppState) -> gtk::Widget {
    let body = gtk::Box::new(gtk::Orientation::Vertical, 16);
    let hint = gtk::Label::new(None);
    let user = gtk::Box::new(gtk::Orientation::Vertical, 6);
    user.append(&ui::field_label("Username", Some(&hint)));
    let username = ui::entry("");
    username.set_text(&account::suggested_username());
    user.append(&username);
    body.append(&user);
    let disp = gtk::Box::new(gtk::Orientation::Vertical, 6);
    disp.append(&ui::field_label("Display name", None));
    let display = ui::entry("");
    display.set_text(s.account.user.as_ref().and_then(|u| u.display_name.as_deref()).unwrap_or(""));
    disp.append(&display);
    body.append(&disp);
    let err = error_slot();
    body.append(&err);
    let go = ui::button("Continue", Some("arrow-right"), Variant::Primary, Size::Lg);
    body.append(&go);
    let who = s
        .account
        .user
        .as_ref()
        .and_then(|u| u.display_name.clone().or(u.login.clone()))
        .unwrap_or_else(|| "your GitHub account".into());
    let foot = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    foot.set_halign(gtk::Align::Center);
    foot.add_css_class("card-foot");
    foot.append(&gtk::Label::new(Some(&format!("Signed in as {who}."))));
    let not_you = gtk::Button::with_label("Not you?");
    not_you.add_css_class("link");
    not_you.connect_clicked(|_| account::sign_out());
    foot.append(&not_you);
    body.append(&foot);

    let check = {
        let (username, display, hint, go) = (username.clone(), display.clone(), hint.clone(), go.clone());
        move || {
            let lower = username.text().to_lowercase();
            if lower != username.text() {
                username.set_text(&lower);
            }
            let ok = wad_account::username_ok(&lower);
            hint.set_text(if !lower.is_empty() && !ok { "3-24 letters, digits, . _ -" } else { "" });
            display.set_placeholder_text(Some(&lower));
            go.set_sensitive(ok);
        }
    };
    check();
    let c = check.clone();
    username.connect_changed(move |_| c());
    let submit = {
        let (username, display, err, go) = (username.clone(), display.clone(), err.clone(), go.clone());
        move || {
            let name = username.text().to_string();
            if !wad_account::username_ok(&name) {
                return;
            }
            let disp =
                Some(display.text().to_string()).filter(|d| !d.trim().is_empty()).unwrap_or_else(|| name.clone());
            go.set_sensitive(false);
            show_error(&err, None);
            let (err, go) = (err.clone(), go.clone());
            glib::spawn_future_local(async move {
                if let Err(e) = account::claim_username(name, disp).await {
                    show_error(&err, Some(&e));
                    go.set_sensitive(true);
                }
            });
        }
    };
    let s1 = submit.clone();
    go.connect_clicked(move |_| s1());
    username.connect_activate(move |_| submit());
    username.grab_focus();
    ui::card(
        "One more thing",
        Some("Pick a username. It's how people find you to share wadspaces, and it can't be changed later."),
        &body,
    )
    .upcast()
}

fn link_card(machine: String, relink: bool) -> gtk::Widget {
    let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let run = {
        let (body, machine) = (body.clone(), machine.clone());
        Rc::new(move || {
            ui::clear(&body);
            body.append(&ui::busy("One moment…"));
            let (body, machine) = (body.clone(), machine.clone());
            glib::spawn_future_local(async move {
                // wadd's next cloud event has the new owner; the gate moves on from there.
                if let Err(e) = account::link(machine).await {
                    ui::clear(&body);
                    body.append(&ui::notice(&e, true));
                    let again = ui::button("Try again", None, Variant::Primary, Size::Md);
                    again.set_halign(gtk::Align::Start);
                    again.set_margin_top(16);
                    // The card is made again by the gate; here, just try once more.
                    again.connect_clicked(|b| {
                        b.set_sensitive(false);
                        let b = b.clone();
                        glib::spawn_future_local(async move {
                            let name =
                                store().read_now(|s| s.machine.as_ref().map(|m| m.name.clone()).unwrap_or_default());
                            if account::link(name).await.is_err() {
                                b.set_sensitive(true);
                            }
                        });
                    });
                    body.append(&again);
                }
            });
        })
    };
    if !relink {
        run();
        return ui::card("Linking this machine", Some(&format!("{machine}, to your account.")), &body).upcast();
    }
    let warn = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    warn.add_css_class("warning");
    warn.append(&Icon::new("triangle-alert", 16));
    warn.append(&ui::wrapping(
        "Linking it to your account takes it away from theirs. Their projects and GitHub sign-in are removed from this machine; the files stay on its disk.",
    ));
    body.append(&warn);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    row.set_margin_top(24);
    let go = ui::button("Link it to my account", Some("link-2"), Variant::Primary, Size::Md);
    go.set_hexpand(true);
    let r = run.clone();
    go.connect_clicked(move |_| r());
    let out = ui::button("Sign out", Some("log-out"), Variant::Secondary, Size::Md);
    out.connect_clicked(|_| account::sign_out());
    row.append(&go);
    row.append(&out);
    body.append(&row);
    ui::card(
        "This machine is someone else's",
        Some(&format!("{machine} is linked to another WadSpaces account.")),
        &body,
    )
    .upcast()
}

fn github_card(s: &AppState) -> gtk::Widget {
    let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let err = error_slot();
    let status = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let button = ui::github_button("Sign in with GitHub");
    body.append(&err);
    body.append(&button);
    body.append(&status);
    button.connect_clicked(move |b| {
        b.set_sensitive(false);
        show_error(&err, None);
        ui::clear(&status);
        status.append(&ui::busy("Finish signing in on GitHub's page. Close it (Ctrl+W) to cancel."));
        let (b, err, status) = (b.clone(), err.clone(), status.clone());
        glib::spawn_future_local(async move {
            let r = account::github_again().await;
            ui::clear(&status);
            b.set_sensitive(true);
            if let Err(e) = r {
                ui::set_text(&b, "Try again");
                show_error(&err, Some(&e));
            }
        });
    });
    let later = ui::button("Later", Some("arrow-right"), Variant::Ghost, Size::Md);
    later.set_halign(gtk::Align::End);
    later.set_margin_top(24);
    let uid = s.account.user.as_ref().map(|u| u.uid.clone()).unwrap_or_default();
    later.connect_clicked(move |_| account::set_github_later(&uid));
    body.append(&later);
    ui::card(
        "Sign in to GitHub again",
        Some("This machine has no GitHub access yet. Your projects are GitHub repositories: this lets it clone, pull and push them."),
        &body,
    )
    .upcast()
}

/// Wi-Fi on this machine (wadd over NetworkManager): the networks in range,
/// joining one (with its password), leaving.
fn wifi_panel() -> gtk::Widget {
    let body = gtk::Box::new(gtk::Orientation::Vertical, 16);
    let status = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    status.add_css_class("wifi-status");
    body.append(&status);
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    let title = gtk::Label::new(Some("NETWORKS"));
    title.add_css_class("section-label");
    title.set_hexpand(true);
    title.set_xalign(0.0);
    head.append(&title);
    let scan = ui::button("Scan", Some("refresh-cw"), Variant::Ghost, Size::Sm);
    head.append(&scan);
    body.append(&head);
    let list = gtk::Box::new(gtk::Orientation::Vertical, 4);
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
    scroll.set_max_content_height(288);
    scroll.set_propagate_natural_height(true);
    scroll.set_child(Some(&list));
    body.append(&scroll);
    let err = error_slot();
    body.append(&err);

    // The status row follows wadd's network events.
    store().watch(&status, Topic::NETWORK, {
        let (status, err) = (status.clone(), err.clone());
        move |s| {
            ui::clear(&status);
            let on = s.online();
            let icon = Icon::new(if on { "wifi" } else { "wifi-off" }, 20);
            icon.add_css_class(if on { "accent" } else { "faint" });
            status.append(&icon);
            let text = gtk::Box::new(gtk::Orientation::Vertical, 0);
            text.set_hexpand(true);
            let n = s.network.as_ref();
            let name = gtk::Label::new(Some(n.and_then(|n| n.ssid.as_deref()).unwrap_or(if on {
                "Connected"
            } else {
                "Not connected"
            })));
            name.add_css_class("strong");
            name.set_xalign(0.0);
            let sub = gtk::Label::new(Some(if on {
                "Online"
            } else if n.is_some_and(|n| n.connectivity == "portal") {
                "Sign in to the network in a browser first"
            } else if n.and_then(|n| n.ssid.as_ref()).is_some() {
                "No internet yet"
            } else {
                "Pick a network"
            }));
            sub.add_css_class("small-muted");
            sub.set_xalign(0.0);
            text.append(&name);
            text.append(&sub);
            status.append(&text);
            if n.and_then(|n| n.ssid.as_ref()).is_some() {
                let off = ui::button("Disconnect", None, Variant::Ghost, Size::Sm);
                let err = err.clone();
                off.connect_clicked(move |_| {
                    let err = err.clone();
                    glib::spawn_future_local(async move {
                        let w = wad_wadd_client::Wadd::here();
                        if let Err(e) = rt::run(async move {
                            w.act(
                                wad_wadd_client::Method::POST,
                                "/v1/network/wifi/disconnect",
                                Some(&serde_json::json!({})),
                            )
                            .await
                        })
                        .await
                        {
                            show_error(&err, Some(&e.to_string()));
                        }
                    });
                });
                status.append(&off);
            }
        }
    });

    let refresh: Rc<dyn Fn()> = {
        let (list, err) = (list.clone(), err.clone());
        Rc::new(move || {
            let (list, err) = (list.clone(), err.clone());
            if list.first_child().is_none() {
                list.append(&ui::busy("Looking for networks…"));
            }
            glib::spawn_future_local(async move {
                let w = wad_wadd_client::Wadd::here();
                let got = rt::run(async move { w.get::<Vec<WifiNetwork>>("/v1/network/wifi?rescan=true").await }).await;
                ui::clear(&list);
                match got {
                    Ok(nets) if nets.is_empty() => list.append(&ui::busy("No networks in range.")),
                    Ok(nets) => {
                        for n in nets {
                            list.append(&network_row(&n, &list, &err));
                        }
                    }
                    Err(e) => show_error(&err, Some(&e.to_string())),
                }
            });
        })
    };
    refresh();
    let r = refresh.clone();
    scan.connect_clicked(move |_| r());
    body.upcast()
}

fn network_row(n: &WifiNetwork, list: &gtk::Box, err: &gtk::Box) -> gtk::Widget {
    let item = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let b = gtk::Button::new();
    b.add_css_class("network");
    if n.active {
        b.add_css_class("active");
    }
    if !n.supported {
        b.add_css_class("unsupported");
    }
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    row.append(&bars(n.signal));
    let name = gtk::Label::new(Some(&n.ssid));
    name.set_hexpand(true);
    name.set_xalign(0.0);
    name.set_ellipsize(gtk::pango::EllipsizeMode::End);
    name.add_css_class("strong");
    row.append(&name);
    if n.known && !n.active {
        let saved = gtk::Label::new(Some("saved"));
        saved.add_css_class("small-faint");
        row.append(&saved);
    }
    if n.secure {
        let lock = Icon::new("lock", 14);
        lock.add_css_class("faint");
        row.append(&lock);
    }
    if n.active {
        let check = Icon::new("check", 16);
        check.add_css_class("accent");
        row.append(&check);
    }
    b.set_child(Some(&row));
    item.append(&b);
    let form = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    form.add_css_class("password-form");
    form.set_visible(false);
    let pw = ui::entry("Password");
    pw.set_visibility(false);
    pw.set_hexpand(true);
    let join = ui::button("Join", None, Variant::Primary, Size::Md);
    join.set_sensitive(false);
    form.append(&pw);
    form.append(&join);
    item.append(&form);

    let connect = {
        let (n, err, list, form) = (n.clone(), err.clone(), list.clone(), form.clone());
        Rc::new(move |password: Option<String>| {
            let (n, err, list, form) = (n.clone(), err.clone(), list.clone(), form.clone());
            show_error(&err, None);
            glib::spawn_future_local(async move {
                let w = wad_wadd_client::Wadd::here();
                let mut body = serde_json::json!({ "ssid": n.ssid });
                if let Some(p) = password.filter(|p| !p.is_empty()) {
                    body["password"] = p.into();
                }
                let r = rt::run(async move {
                    w.act(wad_wadd_client::Method::POST, "/v1/network/wifi/connect", Some(&body)).await
                })
                .await;
                match r {
                    Ok(()) => {
                        form.set_visible(false);
                        let _ = list;
                    }
                    Err(e) => {
                        let m = e.to_string();
                        // A saved network whose password changed: ask for it.
                        if m.to_lowercase().contains("password required") {
                            form.set_visible(true);
                        } else if ["secrets were required", "802-1x", "psk"]
                            .iter()
                            .any(|w| m.to_lowercase().contains(w))
                        {
                            show_error(&err, Some("Wrong password, or the network refused it."));
                        } else {
                            show_error(&err, Some(&m));
                        }
                    }
                }
            });
        })
    };
    let (n2, err2, form2, c) = (n.clone(), err.clone(), form.clone(), connect.clone());
    b.connect_clicked(move |_| {
        if n2.active {
            return;
        }
        if !n2.supported {
            show_error(&err2, Some(&format!("{} uses {}, which this machine can't join yet.", n2.ssid, n2.security)));
            return;
        }
        if n2.secure && !n2.known {
            form2.set_visible(true);
            return;
        }
        c(None);
    });
    let j = join.clone();
    pw.connect_changed(move |e| j.set_sensitive(e.text().len() >= 8));
    let (c, pw2) = (connect.clone(), pw.clone());
    join.connect_clicked(move |_| c(Some(pw2.text().to_string())));
    let c = connect.clone();
    pw.connect_activate(move |e| {
        if e.text().len() >= 8 {
            c(Some(e.text().to_string()));
        }
    });
    item.upcast()
}

/// Three signal bars.
fn bars(signal: u8) -> gtk::Widget {
    let b = gtk::Box::new(gtk::Orientation::Horizontal, 2);
    b.set_valign(gtk::Align::End);
    b.add_css_class("bars");
    for (i, t) in [25u8, 50, 75].iter().enumerate() {
        let bar = gtk::Box::new(gtk::Orientation::Vertical, 0);
        bar.set_size_request(3, (i as i32 + 2) * 3);
        bar.set_valign(gtk::Align::End);
        bar.add_css_class(if signal >= *t { "bar-on" } else { "bar-off" });
        b.append(&bar);
    }
    b.upcast()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AccountState;
    use wad_proto::v1::{CloudLink, NetworkStatus};

    fn state() -> AppState {
        AppState {
            connected: true,
            network: Some(NetworkStatus {
                available: true,
                state: "connected".into(),
                connectivity: "full".into(),
                wifi_enabled: true,
                wifi_device: None,
                ssid: None,
                signal: None,
            }),
            account: AccountState { checked: true, ..Default::default() },
            ..Default::default()
        }
    }

    fn user(uid: &str) -> wad_account::User {
        wad_account::User { uid: uid.into(), github_id: "1".into(), login: None, display_name: None, photo_url: None }
    }

    fn link(owner: Option<&str>) -> CloudLink {
        CloudLink {
            linked: owner.is_some(),
            machine_id: None,
            owner_uid: owner.map(String::from),
            project_id: None,
            linked_at: None,
            last_heartbeat: None,
            last_error: None,
        }
    }

    #[test]
    fn the_steps_in_order() {
        let mut s = state();
        assert_eq!(step(&s, true), Step::SignIn);
        s.network.as_mut().unwrap().connectivity = "none".into();
        assert_eq!(step(&s, true), Step::Wifi);
        s.network.as_mut().unwrap().connectivity = "full".into();
        s.account.user = Some(user("u1"));
        assert_eq!(step(&s, true), Step::Loading, "the profile isn't known yet");
        s.account.profile = ProfileState::Missing;
        assert_eq!(step(&s, true), Step::Welcome);
        s.account.profile = ProfileState::Have(Default::default());
        s.cloud = Some(link(None));
        assert_eq!(step(&s, true), Step::Link);
        s.cloud = Some(link(Some("someone")));
        assert_eq!(step(&s, true), Step::Relink);
        s.cloud = Some(link(Some("u1")));
        s.account.github = Some(false);
        assert_eq!(step(&s, true), Step::Github);
        s.account.github_later = true;
        assert_eq!(step(&s, true), Step::Done);
    }

    #[test]
    fn a_laptops_wadd_without_an_account_link_is_yours_and_no_wadd_waits_a_moment() {
        let mut s = state();
        s.account.user = Some(user("u1"));
        s.account.profile = ProfileState::Have(Default::default());
        s.account.github = Some(true);
        assert_eq!(step(&s, true), Step::Done);
        s.connected = false;
        assert_eq!(step(&s, false), Step::Loading);
        assert_eq!(step(&s, true), Step::Done);
        s.account.unconfigured = Some("no settings".into());
        assert!(matches!(step(&s, true), Step::Unconfigured(_)));
    }
}
