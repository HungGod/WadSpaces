//! Home (the web app's pages/Home.tsx): a greeting and the numbers
//! (wadspaces, running, machines online), Jump back in (the last launch
//! again), what's running now (to show or stop), and your wadspaces.

use gtk::{glib, prelude::*};
use serde_json::Value;
use wad_gtk::Icon;
use wad_wadd_client::{Method, Wadd};

use super::{badge, now, secs_of, section_head, time_ago, uptime};
use crate::launch::{self, RunItem};
use crate::rt;
use crate::shell::Page;
use crate::store::{AppState, Topic, store};
use crate::thumb::thumb;
use crate::ui::{self, Size, Variant};

/// Heartbeats older than this: the machine's offline.
const ONLINE_WITHIN: f64 = 90.0;

fn greeting() -> &'static str {
    let h = glib::DateTime::now_local().map(|d| d.hour()).unwrap_or(12);
    match h {
        0..=4 => "Up late",
        5..=11 => "Good morning",
        12..=17 => "Good afternoon",
        _ => "Good evening",
    }
}

/// What runs: on this machine (wadd's states), and on others (their
/// heartbeats, while they're online).
struct Running {
    wadspace: String,
    name: String,
    machine: String,
    here: bool,
    on_screen: bool,
    since: f64,
}

fn running(s: &AppState) -> Vec<Running> {
    let mut out = vec![];
    let screen = s.view.as_ref().map(|v| v.view.clone());
    for w in s.workspaces.iter().filter(|w| w.kind == wad_proto::v1::Kind::Container) {
        if s.states.get(&w.id).is_some_and(|st| st.container == "running") {
            out.push(Running {
                wadspace: w.id.clone(),
                name: w.name.clone(),
                machine: "This machine".into(),
                here: true,
                on_screen: screen == Some(wad_proto::v1::View::Workspace(w.id.clone())),
                since: s.states[&w.id].since,
            });
        }
    }
    let me = s.cloud.as_ref().and_then(|c| c.machine_id.clone());
    for m in s.library.iter().flat_map(|l| l.machines.iter()) {
        if me.as_deref() == m["id"].as_str() {
            continue;
        }
        let seen = m["lastSeen"].as_str().and_then(secs_of).unwrap_or(0.0);
        if now() - seen > ONLINE_WITHIN {
            continue;
        }
        let label = m["name"].as_str().or(m["hostname"].as_str()).unwrap_or("A machine").to_string();
        for w in m["workspaces"].as_array().into_iter().flatten().filter(|w| w["container"] == "running") {
            out.push(Running {
                wadspace: w["id"].as_str().unwrap_or_default().into(),
                name: w["name"].as_str().unwrap_or_default().into(),
                machine: label.clone(),
                here: false,
                on_screen: m["view"].as_str() == Some(&format!("workspace:{}", w["id"].as_str().unwrap_or_default())),
                since: seen,
            });
        }
    }
    out
}

fn machines_online(s: &AppState) -> usize {
    let me = s.cloud.as_ref().and_then(|c| c.machine_id.clone());
    let here = usize::from(s.connected);
    here + s
        .library
        .iter()
        .flat_map(|l| l.machines.iter())
        .filter(|m| me.as_deref() != m["id"].as_str())
        .filter(|m| now() - m["lastSeen"].as_str().and_then(secs_of).unwrap_or(0.0) <= ONLINE_WITHIN)
        .count()
}

pub fn page() -> gtk::Widget {
    let body = gtk::Box::new(gtk::Orientation::Vertical, 0);

    // The greeting and the numbers.
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 16);
    head.add_css_class("home-head");
    let hello = gtk::Box::new(gtk::Orientation::Vertical, 2);
    hello.set_hexpand(true);
    hello.set_valign(gtk::Align::End);
    let greet = gtk::Label::new(Some(&format!("{},", greeting())));
    greet.add_css_class("greeting");
    greet.set_xalign(0.0);
    let name = gtk::Label::new(Some("…"));
    name.add_css_class("page-title");
    name.set_xalign(0.0);
    hello.append(&greet);
    hello.append(&name);
    head.append(&hello);
    let stats = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    stats.set_valign(gtk::Align::End);
    let mut tiles = vec![];
    for (label, go) in [("WADSPACES", Page::Builder), ("RUNNING", Page::Machines), ("MACHINES ONLINE", Page::Machines)]
    {
        let b = gtk::Button::new();
        b.add_css_class("stat");
        let col = gtk::Box::new(gtk::Orientation::Vertical, 4);
        let v = gtk::Label::new(Some("0"));
        v.add_css_class("stat-value");
        v.set_xalign(0.0);
        let l = gtk::Label::new(Some(label));
        l.add_css_class("stat-label");
        l.set_xalign(0.0);
        col.append(&v);
        col.append(&l);
        b.set_child(Some(&col));
        b.connect_clicked(move |_| crate::shell::go(go));
        stats.append(&b);
        tiles.push(v);
    }
    head.append(&stats);
    body.append(&head);

    let sections = gtk::Box::new(gtk::Orientation::Vertical, 40);
    let jump = gtk::Box::new(gtk::Orientation::Vertical, 0);
    jump.append(&section_head("Jump back in", "All in the Builder", Page::Builder));
    let jump_body = gtk::Box::new(gtk::Orientation::Vertical, 0);
    jump.append(&jump_body);
    sections.append(&jump);
    let run = gtk::Box::new(gtk::Orientation::Vertical, 0);
    run.append(&section_head("Running now", "Machines", Page::Machines));
    let run_body = gtk::Box::new(gtk::Orientation::Vertical, 8);
    run.append(&run_body);
    sections.append(&run);
    let yours = gtk::Box::new(gtk::Orientation::Vertical, 0);
    yours.append(&section_head("Your wadspaces", "All in the Builder", Page::Builder));
    let grid = gtk::Grid::new();
    grid.set_column_homogeneous(true);
    grid.set_column_spacing(24);
    grid.set_row_spacing(32);
    yours.append(&grid);
    sections.append(&yours);
    body.append(&sections);

    let watched = body.clone();
    store().watch(
        &watched,
        Topic::ACCOUNT
            | Topic::LIBRARY
            | Topic::STATES
            | Topic::WORKSPACES
            | Topic::VIEW
            | Topic::WADD
            | Topic::SESSION,
        move |s| {
            name.set_text(s.profile().map(|p| p.display_name.as_str()).unwrap_or("…"));
            let live = s.wadspaces();
            let now_running = running(s);
            tiles[0].set_text(&live.len().to_string());
            tiles[1].set_text(&now_running.len().to_string());
            tiles[2].set_text(&machines_online(s).to_string());
            jump_back_in(&jump_body, s);
            running_now(&run_body, s, &now_running);
            your_wadspaces(&grid, s);
        },
    );
    super::page(&body)
}

fn jump_back_in(slot: &gtk::Box, s: &AppState) {
    ui::clear(slot);
    let session = launch::last_session();
    let live = s.wadspaces();
    let spaces: Vec<&Value> = session
        .as_ref()
        .map(|v| {
            v["wadspaceIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| live.iter().find(|w| w["id"] == *id).copied())
                .collect()
        })
        .unwrap_or_default();
    let terminal = session
        .as_ref()
        .is_some_and(|v| v["wadspaceIds"].as_array().is_some_and(|a| a.iter().any(|i| i == "terminal")));
    if spaces.is_empty() && !terminal {
        let card = gtk::Box::new(gtk::Orientation::Horizontal, 16);
        card.add_css_class("empty-card");
        let tile = gtk::Box::new(gtk::Orientation::Vertical, 0);
        tile.add_css_class("icon-tile");
        tile.append(&Icon::new("wand-sparkles", 24));
        card.append(&tile);
        let text = gtk::Box::new(gtk::Orientation::Vertical, 2);
        text.set_hexpand(true);
        text.set_valign(gtk::Align::Center);
        let t = gtk::Label::new(Some("Nothing to jump back into yet"));
        t.add_css_class("card-heading");
        t.set_xalign(0.0);
        let p = gtk::Label::new(Some("Launch a wadspace and it'll be waiting here next time."));
        p.add_css_class("small-muted-14");
        p.set_xalign(0.0);
        text.append(&t);
        text.append(&p);
        card.append(&text);
        let go = ui::button("Open the Builder", Some("arrow-right"), Variant::Primary, Size::Md);
        go.set_valign(gtk::Align::Center);
        go.connect_clicked(|_| crate::shell::go(Page::Builder));
        card.append(&go);
        slot.append(&card);
        return;
    }
    let session = session.unwrap_or_default();
    let focus = session["kind"] == "focus";
    let minutes = session["minutes"].as_u64().unwrap_or(25) as u32;
    let card = gtk::Box::new(gtk::Orientation::Horizontal, 20);
    card.add_css_class("jump-card");
    // One big thumbnail, or tiles for several.
    let preview = gtk::Grid::new();
    preview.add_css_class("jump-preview");
    preview.set_size_request(288, -1);
    preview.set_valign(gtk::Align::Center);
    preview.set_column_homogeneous(true);
    preview.set_column_spacing(4);
    preview.set_row_spacing(4);
    let shown: Vec<&&Value> = spaces.iter().take(4).collect();
    for (n, w) in shown.iter().enumerate() {
        let t = thumb(s, w);
        t.set_radius(if shown.len() == 1 { 16.0 } else { 0.0 });
        let (col, row) = if shown.len() == 1 { (0, 0) } else { ((n % 2) as i32, (n / 2) as i32) };
        preview.attach(&t, col, row, 1, 1);
    }
    card.append(&preview);
    let text = gtk::Box::new(gtk::Orientation::Vertical, 0);
    text.set_hexpand(true);
    text.set_valign(gtk::Align::Center);
    let badges = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    if focus {
        badges.append(&badge(&format!("{minutes} min focus"), Some("timer"), true));
    }
    badges.append(&badge("This machine", None, false));
    text.append(&badges);
    let mut names: Vec<String> = spaces.iter().map(|w| s.wadspace_name(w)).collect();
    if terminal {
        names.push("Terminal".into());
    }
    let title =
        gtk::Label::new(Some(&if names.len() == 1 { names[0].clone() } else { format!("{} together", names.len()) }));
    title.add_css_class("jump-title");
    title.set_xalign(0.0);
    title.set_ellipsize(gtk::pango::EllipsizeMode::End);
    text.append(&title);
    let sub_text = if names.len() > 1 {
        names.join(" · ")
    } else {
        spaces
            .first()
            .and_then(|w| w["customization"]["description"].as_str())
            .filter(|d| !d.is_empty())
            .unwrap_or("On the machine")
            .to_string()
    };
    let sub = ui::wrapping(&sub_text);
    sub.add_css_class("small-muted-14");
    sub.set_lines(2);
    sub.set_ellipsize(gtk::pango::EllipsizeMode::End);
    text.append(&sub);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    row.set_margin_top(16);
    let again =
        ui::button(if focus { "Start focus again" } else { "Jump back in" }, Some("play"), Variant::Primary, Size::Md);
    let mut items: Vec<RunItem> =
        spaces.iter().filter_map(|w| w["id"].as_str().map(|id| RunItem::Wadspace(id.into()))).collect();
    if terminal {
        items.push(RunItem::Terminal);
    }
    again.connect_clicked(move |b| {
        b.set_sensitive(false);
        let (b, items) = (b.clone(), items.clone());
        glib::spawn_future_local(async move {
            match launch::launch(items, focus.then_some(minutes)).await {
                Ok(_) => crate::toast::show("Launching", None, crate::toast::Tone::Success),
                Err(e) => crate::toast::error("Couldn't launch", &e),
            }
            b.set_sensitive(true);
        });
    });
    row.append(&again);
    if let Some(at) = session["at"].as_str().and_then(secs_of) {
        let when = gtk::Label::new(Some(&format!("Last used {}", time_ago(now() - at))));
        when.add_css_class("small-faint");
        row.append(&when);
    }
    text.append(&row);
    card.append(&text);
    slot.append(&card);
}

fn running_now(slot: &gtk::Box, s: &AppState, list: &[Running]) {
    ui::clear(slot);
    if list.is_empty() {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        row.add_css_class("empty-row");
        let i = Icon::new("radio", 16);
        i.add_css_class("faint");
        row.append(&i);
        let l = gtk::Label::new(Some("Nothing running. Launch a wadspace and it'll show up here."));
        l.set_xalign(0.0);
        row.append(&l);
        slot.append(&row);
        return;
    }
    let live = s.wadspaces();
    for r in list {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 16);
        row.add_css_class("running-row");
        match live.iter().find(|w| w["id"].as_str() == Some(&r.wadspace)) {
            Some(w) => {
                let t = thumb(s, w);
                t.set_fixed_width(96);
                t.set_radius(12.0);
                t.set_valign(gtk::Align::Center);
                row.append(&t);
            }
            None => {
                let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
                b.add_css_class("thumb-blank");
                b.set_size_request(96, 54);
                row.append(&b);
            }
        }
        let text = gtk::Box::new(gtk::Orientation::Vertical, 2);
        text.set_hexpand(true);
        text.set_valign(gtk::Align::Center);
        let name = gtk::Label::new(Some(
            &live
                .iter()
                .find(|w| w["id"].as_str() == Some(&r.wadspace))
                .map(|w| s.wadspace_name(w))
                .unwrap_or_else(|| r.name.clone()),
        ));
        name.add_css_class("row-title");
        name.set_xalign(0.0);
        text.append(&name);
        let sub = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        dot.add_css_class("live-dot");
        dot.set_valign(gtk::Align::Center);
        sub.append(&dot);
        let where_ = if r.on_screen { "on screen" } else { "in the background" };
        let l = gtk::Label::new(Some(&format!("{} · {where_} · up {}", r.machine, uptime(now() - r.since))));
        l.add_css_class("small-muted");
        sub.append(&l);
        text.append(&sub);
        row.append(&text);
        if r.here && !r.on_screen {
            let show = ui::button("Show", None, Variant::Secondary, Size::Sm);
            show.set_valign(gtk::Align::Center);
            let id = r.wadspace.clone();
            show.connect_clicked(move |_| act(&id, "switch", "Couldn't show it"));
            row.append(&show);
        }
        if r.here {
            let stop = ui::button("Stop", Some("square"), Variant::Ghost, Size::Sm);
            stop.set_valign(gtk::Align::Center);
            let id = r.wadspace.clone();
            stop.connect_clicked(move |_| act(&id, "stop", "Couldn't stop"));
            row.append(&stop);
        }
        slot.append(&row);
    }
}

/// A wadspace here: switched to, or stopped.
fn act(id: &str, what: &'static str, failed: &'static str) {
    let id = id.to_string();
    glib::spawn_future_local(async move {
        let w = Wadd::here();
        let r = rt::run(async move {
            w.act(Method::POST, &format!("/v1/workspaces/{id}/{what}"), Some(&serde_json::json!({}))).await
        })
        .await;
        if let Err(e) = r {
            crate::toast::error(failed, &e.to_string());
        }
    });
}

fn your_wadspaces(grid: &gtk::Grid, s: &AppState) {
    while let Some(c) = grid.first_child() {
        grid.remove(&c);
    }
    let all: Vec<&Value> = s.wadspaces().into_iter().filter(|w| w["customization"].is_object()).collect();
    if all.is_empty() {
        let b = gtk::Button::new();
        b.add_css_class("first-wadspace");
        let col = gtk::Box::new(gtk::Orientation::Vertical, 8);
        col.set_valign(gtk::Align::Center);
        col.append(&Icon::new("wand-sparkles", 28));
        let l = gtk::Label::new(Some("Build your first wadspace"));
        l.add_css_class("strong");
        col.append(&l);
        b.set_child(Some(&col));
        b.set_size_request(-1, 180);
        b.connect_clicked(|_| crate::shell::go(Page::Builder));
        grid.attach(&b, 0, 0, 1, 1);
        // Keep the grid's four columns.
        for c in 1..4 {
            grid.attach(&gtk::Box::new(gtk::Orientation::Vertical, 0), c, 0, 1, 1);
        }
        return;
    }
    for (n, w) in all.iter().take(4).enumerate() {
        let b = gtk::Button::new();
        b.add_css_class("wadspace-card");
        let col = gtk::Box::new(gtk::Orientation::Vertical, 8);
        let t = thumb(s, w);
        t.set_radius(16.0);
        t.add_css_class("card-thumb");
        col.append(&t);
        let name = gtk::Label::new(Some(&s.wadspace_name(w)));
        name.add_css_class("row-title");
        name.set_xalign(0.0);
        name.set_ellipsize(gtk::pango::EllipsizeMode::End);
        col.append(&name);
        b.set_child(Some(&col));
        b.set_tooltip_text(Some(&format!("Open {} in the Builder", s.wadspace_name(w))));
        b.connect_clicked(|_| crate::shell::go(Page::Builder));
        grid.attach(&b, n as i32, 0, 1, 1);
    }
    for c in all.len().min(4)..4 {
        grid.attach(&gtk::Box::new(gtk::Orientation::Vertical, 0), c as i32, 0, 1, 1);
    }
}
