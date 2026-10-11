//! The layers' rules, ported from the WadBuilder mockup's model tests
//! (src/data/wad/model.test.ts), on the same sample library: the Writing and
//! Dev starters, a Dev customization with seven web apps, and a wadspace on
//! each kind of base. Secret names here are made up.

use serde_json::{Value, json};

use super::*;

fn web(name: &str, url: &str) -> Value {
    json!({ "id": webapp_id(name), "name": name, "url": url })
}

fn writing() -> Value {
    json!({ "id": "writing", "owner": "me", "name": "Writing", "description": "", "apps": ["obsidian"], "createdAt": "2026-01-01", "updatedAt": "2026-01-01" })
}

fn dev() -> Value {
    json!({ "id": "dev", "owner": "me", "name": "Dev", "description": "", "apps": ["wadbrowser", "vscode"], "createdAt": "2026-01-02", "updatedAt": "2026-01-02" })
}

fn academy_dev() -> Value {
    json!({
        "id": "academy-dev", "owner": "me", "name": "Academy Dev", "description": "", "templateId": "dev",
        "browserMode": "browser",
        "webapps": [
            web("GitHub", "https://github.com"),
            web("Claude", "https://claude.ai"),
            web("Google FireBase", "https://firebase.google.com"),
            web("Google Cloud", "https://cloud.google.com"),
            web("Gmail", "https://mail.google.com"),
            web("Google Drive", "https://drive.google.com"),
            web("Google Workspace", "https://workspace.google.com"),
        ],
        "extensions": ["anthropic.claude-code"], "tools": ["firebase"], "autostart": [],
        "createdAt": "2026-02-01", "updatedAt": "2026-02-01",
    })
}

fn r(id: &str, name: &str, kind: &str) -> Value {
    json!({ "id": id, "name": name, "kind": kind })
}

fn wadspaces() -> Vec<Value> {
    let (cloud, mail) = (r("s-cloud", "Work-WadBrowser-Google", "web"), r("s-mail", "Mail-WadBrowser-Google", "web"));
    vec![
        json!({ "version": 2, "id": "novel", "owner": "me", "name": "Novel", "description": "",
                "base": { "kind": "template", "id": "writing" }, "wallpaper": { "type": "image", "value": "/wallpapers/x.png" },
                "projects": ["writing"], "secrets": {}, "createdAt": "2026-03-01", "updatedAt": "2026-03-01" }),
        json!({ "version": 2, "id": "academy", "owner": "me", "name": "Academy", "description": "",
                "base": { "kind": "customization", "id": "academy-dev" }, "wallpaper": { "type": "color", "value": "#000" },
                "projects": ["academy"], "createdAt": "2026-03-02", "updatedAt": "2026-03-02",
                "secrets": {
                    "ext:anthropic.claude-code": r("s-claude", "Me-VSCode-ClaudeCode", "vscode-claude-code"),
                    "web:github": r("s-gh", "Me-WadBrowser-GitHub", "web"),
                    "web:claude": r("s-cl", "Academy-WadBrowser-Claude", "web"),
                    "web:google-firebase": cloud, "web:google-cloud": cloud,
                    "web:gmail": mail, "web:google-drive": mail, "web:google-workspace": mail,
                } }),
    ]
}

fn lib() -> Value {
    json!({ "templates": [writing(), dev()], "customizations": [academy_dev()], "wadspaces": wadspaces() })
}

fn keys(v: &[Value], k: &str) -> Vec<String> {
    v.iter().map(|x| x[k].as_str().unwrap_or("").to_string()).collect()
}

#[test]
fn resolves_a_base_to_its_template_and_setup() {
    let got = resolve(&lib(), &json!({ "kind": "customization", "id": "academy-dev" }));
    assert_eq!(got["template"]["id"], "dev");
    assert_eq!(got["setup"]["tools"], json!(["firebase"]));
    assert_eq!(resolve(&lib(), &json!({ "kind": "template", "id": "writing" }))["setup"], empty_setup("writing"));
    assert!(resolve(&lib(), &json!({ "kind": "template", "id": "gone" })).is_null());
}

#[test]
fn offers_a_slot_per_web_app_ai_extension_and_app_that_keeps_a_sign_in() {
    let slots = slots_for(&dev(), &academy_dev());
    // In desktop order: WadBrowser's web apps, then VS Code's extension.
    let mut want: Vec<String> =
        js::arr(&academy_dev(), "webapps").iter().map(|w| format!("web:{}", w["id"].as_str().unwrap())).collect();
    want.push("ext:anthropic.claude-code".into());
    assert_eq!(keys(&slots, "key"), want);
    let w = slots_for(&writing(), &empty_setup("writing"));
    assert_eq!((keys(&w, "key"), keys(&w, "kind")), (vec!["app:obsidian".into()], vec!["obsidian".into()]));
    // An extension that keeps nothing, or Copilot (signs in inside each wadspace), has no slot.
    let mut plain = academy_dev();
    plain["webapps"] = json!([]);
    plain["extensions"] = json!(["ms-python.python", "github.copilot-chat"]);
    assert!(slots_for(&dev(), &plain).is_empty());
    let steam = json!({ "id": "games", "name": "Games", "apps": ["steam", "dolphin"] });
    assert_eq!(keys(&slots_for(&steam, &empty_setup("games")), "kind"), ["steam"]);
}

#[test]
fn names_new_secrets_after_the_wadspace_or_the_setup() {
    let slots = slots_for(&dev(), &academy_dev());
    let slot = |k: &str| slots.iter().find(|s| s["key"] == k).unwrap().clone();
    assert_eq!(new_secret_name("Academy", &slot("ext:anthropic.claude-code")), "Academy-VSCode-ClaudeCode");
    assert_eq!(new_secret_name("Vanua Academy", &slot("web:github")), "VanuaAcademy-WadBrowser-GitHub");
    assert_eq!(new_secret_name("", &slot("web:github")), "Wadspace-WadBrowser-GitHub");
    let b = browser_slots(&json!({ "webapps": [web("GitHub", "https://github.com")] }));
    assert_eq!(b[0]["label"], "GitHub");
    assert_eq!(default_browser_secret_name("Cloud work", &b[0]), "Cloudwork-WadBrowser-GitHub");
    assert_eq!(default_browser_secret_name("  ", &b[0]), "WadSpaces-WadBrowser.GitHub");
}

#[test]
fn only_mounts_a_secret_where_its_kind_fits() {
    let slots = slots_for(&dev(), &academy_dev());
    let slot = |k: &str| slots.iter().find(|s| s["key"] == k).unwrap().clone();
    assert!(fits(&json!({ "kind": "web" }), &slot("web:github")));
    assert!(!fits(&json!({ "kind": "web" }), &slot("ext:anthropic.claude-code")));
    assert!(!fits(&json!({ "kind": "obsidian" }), &slot("web:github")));
    assert_eq!(kind_of_slot_key("ext:openai.chatgpt").as_deref(), Some("vscode-codex"));
    assert_eq!(kind_of_slot_key("app:steam").as_deref(), Some("steam"));
    assert_eq!(kind_of_slot_key("web:x").as_deref(), Some("web"));
    assert_eq!(kind_of_slot_key("app:vscode"), None);
}

#[test]
fn shares_secrets_as_the_slots_say() {
    let browsers =
        vec![json!({ "id": "mail", "name": "Mail", "secrets": { "web:gmail": r("s-mail", "Mail", "web") } })];
    let use_ = secret_use(&wadspaces(), &browsers);
    let slots = |id: &str| {
        let mut v: Vec<String> =
            use_[id].as_array().unwrap().iter().map(|u| u["slot"].as_str().unwrap().into()).collect();
        v.sort();
        v
    };
    assert_eq!(slots("s-cloud"), ["web:google-cloud", "web:google-firebase"]);
    assert_eq!(slots("s-mail"), ["web:gmail", "web:gmail", "web:google-drive", "web:google-workspace"]);
    assert_eq!(use_["s-mail"].as_array().unwrap().last().unwrap()["kind"], "browser");
}

#[test]
fn puts_apps_then_web_apps_then_project_folders_on_the_desktop() {
    let projects = [json!({ "id": "academy", "name": "Academy" })];
    let items = desktop_for(&dev(), &academy_dev(), &projects);
    let mut want = vec!["WadBrowser".to_string(), "VS Code".into()];
    want.extend(js::arr(&academy_dev(), "webapps").iter().map(|w| w["name"].as_str().unwrap().to_string()));
    want.push("Academy".into());
    assert_eq!(keys(&items, "label"), want);
    let mut focus = academy_dev();
    focus["browserMode"] = "focus".into();
    assert_eq!(desktop_for(&dev(), &focus, &[])[0]["label"], "WadBrowser Focus");
    // Nothing in Writing opens a folder in a window: its projects are mounted with no icon.
    let w = desktop_for(&writing(), &empty_setup("writing"), &[json!({ "id": "writing", "name": "Writing" })]);
    assert_eq!(keys(&w, "label"), ["Obsidian"]);
    // Bundled icons for sites the catalog knows, so they draw offline.
    assert_eq!(items[0]["iconUrl"], "/brand/wadbrowser-icon-dark.svg");
}

#[test]
fn marks_vs_code_with_extensions_added() {
    let added = |setup: &Value| {
        desktop_for(&dev(), setup, &[]).into_iter().find(|i| i["id"] == "app:vscode").unwrap()["added"].clone()
    };
    assert_eq!(added(&academy_dev()), 1);
    assert!(added(&empty_setup("dev")).is_null());
}

#[test]
fn lists_every_launcher_in_the_start_menu_by_category() {
    let menu = start_menu_for(&dev(), &academy_dev());
    assert_eq!(keys(&menu, "name"), ["Development", "Internet", "System"]);
    let internet = keys(menu[1]["apps"].as_array().unwrap(), "name");
    for n in ["WadBrowser", "WadBrowser Focus", "GitHub", "Gmail"] {
        assert!(internet.contains(&n.to_string()), "{n}");
    }
    let mut sorted = internet.clone();
    sorted.sort_by_key(|n| n.to_lowercase());
    assert_eq!(internet, sorted);
    // An old app (a migrated template's) goes under Misc, last.
    let old = json!({ "id": "x", "name": "X", "apps": ["vscode", "gimp"] });
    assert_eq!(keys(&start_menu_for(&old, &empty_setup("x")), "name"), ["Development", "Internet", "System", "Misc"]);
}

#[test]
fn builds_a_template_on_the_base_and_a_customization_on_its_template() {
    let t = template_dockerfile(&dev());
    assert!(t.contains("ARG BASE_IMAGE=localhost/wadspaces-base:trixie\nFROM ${BASE_IMAGE}"), "{t}");
    assert!(t.contains("RUN wadspaces-feature vscode\n"), "{t}");
    assert!(t.contains("LABEL io.wadspaces.layer=\"template:dev\" io.wadspaces.apps=\"wadbrowser,vscode\""), "{t}");
    assert!(t.contains("ENV TITLE=\"Dev\""), "{t}");
    let apt = template_dockerfile(&json!({ "id": "m", "name": "Music", "apps": ["lmms", "obs", "audacity"] }));
    assert!(apt.contains("RUN wadspaces-feature audacity\n"), "{apt}");
    assert!(
        apt.contains("RUN wadspaces-apt lmms --desktop lmms.desktop lmms && \\\n    wadspaces-apt obs --desktop com.obsproject.Studio.desktop obs-studio && \\\n    wadspaces-apt --clean"),
        "{apt}"
    );
    let d = customization_dockerfile(&academy_dev(), &dev());
    assert!(d.contains("ARG BASE_IMAGE=localhost/wadspaces-template-dev:latest\nFROM ${BASE_IMAGE}"), "{d}");
    assert!(d.contains("LABEL io.wadspaces.layer=\"custom:academy-dev\""), "{d}");
    assert!(d.contains("RUN wadspaces-feature firebase\n"), "{d}");
    assert!(d.contains("RUN wadspaces-vscode-extensions anthropic.claude-code\n"), "{d}");
    assert!(
        d.contains("wadspaces-webapp --id google-firebase \"Google FireBase\" \"https://firebase.google.com\""),
        "{d}"
    );
    assert!(d.ends_with("COPY root/ /\n"));
    let mut boot = academy_dev();
    boot["autostart"] = json!(["app:vscode", "web:gmail"]);
    let layout: Value = serde_json::from_str(&layout_json_for(&dev(), &boot)).unwrap();
    assert_eq!(
        layout["icons"][1],
        json!({ "app": "vscode", "desktop": "wadspaces-vscode.desktop", "label": "VS Code", "autostart": true })
    );
    assert_eq!(
        layout["icons"][6],
        json!({ "app": "webapp-gmail", "desktop": "wadspaces-webapp-gmail.desktop", "label": "Gmail", "autostart": true })
    );
}

#[test]
fn nothing_a_shell_reads_gets_into_a_dockerfile() {
    let mut c = academy_dev();
    c["extensions"] = json!(["ok.ext", "bad;rm -rf /", "$(x).y"]);
    c["webapps"] = json!([{ "id": "x", "name": "A \"quote\" $HOME", "url": "https://a.b/$(x)" }, { "id": "Bad Id", "name": "n", "url": "https://c" }]);
    c["tools"] = json!(["go", "not-a-feature"]);
    let d = customization_dockerfile(&c, &dev());
    assert!(d.contains("RUN wadspaces-vscode-extensions ok.ext\n"), "{d}");
    assert!(d.contains(r#"wadspaces-webapp --id x "A \"quote\" \$HOME" "https://a.b/\$(x)""#), "{d}");
    assert!(!d.contains("Bad Id") && !d.contains("not-a-feature"), "{d}");
    let t = template_dockerfile(&json!({ "id": "t", "name": "Two\nlines", "apps": [] }));
    assert!(t.starts_with("# Two lines template."), "{t}");
}

#[test]
fn layers_carry_their_files_and_a_sha_that_follows_them() {
    let t = template_layer(&dev());
    assert_eq!(
        (t["key"].as_str(), t["ref"].as_str()),
        (Some("template:dev"), Some("localhost/wadspaces-template-dev:latest"))
    );
    assert_eq!(t["from"], DEFAULT_BASE_IMAGE);
    let paths: Vec<&str> = t["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["Dockerfile", "root/etc/wadspaces/layout.json", "root/etc/wadspaces/wadbrowser.conf"]);
    let c = customization_layer(&academy_dev(), &dev());
    assert_eq!(c["from"], "localhost/wadspaces-template-dev:latest");
    let mut focus = academy_dev();
    focus["browserMode"] = "focus".into();
    let f = customization_layer(&focus, &dev());
    assert_ne!(f["sha"], c["sha"]);
    assert!(f["files"][2]["content"].as_str().unwrap().contains("default = focus"));
    assert_eq!(c["sha"], customization_layer(&academy_dev(), &dev())["sha"]);
    assert_eq!(c["sha"].as_str().unwrap().len(), 64);
    let w = template_layer(&writing());
    assert_eq!(w["files"].as_array().unwrap().len(), 2, "no WadBrowser, no wadbrowser.conf");
}

#[test]
fn tells_a_changed_setup_from_its_base() {
    assert!(same_setup(&academy_dev(), &academy_dev()));
    let mut changed = academy_dev();
    changed["tools"] = json!([]);
    assert!(!same_setup(&academy_dev(), &changed));
    assert!(same_setup(&json!({ "templateId": "dev" }), &empty_setup("dev")));
}

#[test]
fn piles_each_templates_customizations_and_wadspaces_on_it() {
    let st = stacks(&lib());
    assert_eq!(st[0]["template"]["id"], "writing");
    assert_eq!(keys(st[0]["wadspaces"].as_array().unwrap(), "name"), ["Novel"]);
    assert_eq!(st[0]["customizations"], json!([]));
    assert_eq!(st[1]["wadspaces"], json!([]));
    assert_eq!(st[1]["customizations"][0]["customization"]["name"], "Academy Dev");
    assert_eq!(keys(st[1]["customizations"][0]["wadspaces"].as_array().unwrap(), "name"), ["Academy"]);
    // Deleted ones leave the stacks.
    let mut l = lib();
    l["wadspaces"][0]["deletedAt"] = "2026-04-01".into();
    l["templates"][1]["deletedAt"] = "2026-04-01".into();
    let st = stacks(&l);
    assert_eq!(st.len(), 1);
    assert_eq!(st[0]["wadspaces"], json!([]));
}

#[test]
fn wont_take_a_name_already_in_use() {
    assert!(name_taken("dev", &lib(), None));
    assert!(name_taken(" Academy Dev ", &lib(), None));
    assert!(!name_taken("Academy Dev", &lib(), Some("academy-dev")));
    assert!(!name_taken("Night Writing", &lib(), None));
    assert!(named("novel", &wadspaces(), None));
    assert!(!named("Novel", &wadspaces(), Some("novel")));
}

#[test]
fn brings_what_fits_into_another_template_and_says_why_the_rest_doesnt() {
    let can = importable(&academy_dev(), &writing());
    assert_eq!(can["tools"]["ok"], true);
    assert_eq!(can["webapps"], json!({ "count": 7, "ok": false, "why": "Writing has no WadBrowser" }));
    assert_eq!(can["extensions"]["why"], "Writing has no VS Code");
    let next = import_into(&empty_setup("writing"), &academy_dev(), &writing(), &["webapps", "extensions", "tools"]);
    assert_eq!(next["templateId"], "writing");
    assert_eq!(
        (next["webapps"].clone(), next["extensions"].clone(), next["tools"].clone()),
        (json!([]), json!([]), json!(["firebase"]))
    );
}

#[test]
fn merges_without_repeats_keeping_boot_apps_that_exist_here() {
    let mut into = empty_setup("dev");
    into["webapps"] = json!([{ "id": "github", "name": "GitHub", "url": "https://github.com/" }]);
    into["tools"] = json!(["firebase"]);
    let mut from = academy_dev();
    from["autostart"] = json!(["web:claude", "app:obsidian"]);
    let next = import_into(&into, &from, &dev(), &["webapps", "extensions", "tools", "autostart"]);
    let mut want = vec!["GitHub".to_string()];
    want.extend(js::arr(&academy_dev(), "webapps")[1..].iter().map(|w| w["name"].as_str().unwrap().to_string()));
    assert_eq!(keys(next["webapps"].as_array().unwrap(), "name"), want);
    assert_eq!(next["tools"], json!(["firebase"]));
    assert_eq!(next["extensions"], json!(["anthropic.claude-code"]));
    // Obsidian isn't in Dev, so it can't open at boot here.
    assert_eq!(next["autostart"], json!(["web:claude"]));
}

#[test]
fn a_web_app_kept_once_brings_its_boot_key_along() {
    let mut into = empty_setup("dev");
    into["webapps"] = json!([{ "id": "hub", "name": "Hub", "url": "https://github.com" }]);
    let from =
        json!({ "templateId": "dev", "webapps": [web("GitHub", "https://github.com/")], "autostart": ["web:github"] });
    let next = import_into(&into, &from, &dev(), &["webapps", "autostart"]);
    assert_eq!(next["autostart"], json!(["web:hub"]));
}

#[test]
fn summarises_what_is_mounted_at_start() {
    let w = &wadspaces()[1];
    let projects = [json!({ "id": "academy", "name": "Academy", "mountName": "Academy" })];
    let lines = run_summary(w, &projects, &slots_for(&dev(), &academy_dev()));
    assert_eq!(lines[0], "wallpaper  → /run/wadspaces-extra/wallpaper.png (color)");
    assert_eq!(lines[1], "project    Academy → ~/Desktop/Academy");
    assert!(
        lines.contains(
            &"secret     Mail-WadBrowser-Google → Gmail (web app), Google Drive (web app), Google Workspace (web app)"
                .to_string()
        )
    );
    assert_eq!(wallpaper_ext(&json!({ "type": "image", "value": "data:image/jpeg;base64,xx" })), "jpg");
}

#[test]
fn installs_a_wadspace_on_its_layers_image_with_its_secrets() {
    let w = &wadspaces()[1];
    let ws = workspace_for(w, &dev(), &academy_dev(), &json!({ "tz": "Pacific/Fiji", "secrets": ["github_token"] }));
    assert_eq!(ws["image"], "localhost/wadspaces-custom-academy-dev:latest");
    assert_eq!(
        ws["env"],
        json!({ "PUID": "1000", "PGID": "1000", "TZ": "Pacific/Fiji", "TITLE": "Academy", "WALLPAPER": "/run/wadspaces-extra/wallpaper.png" })
    );
    assert_eq!(ws["volumes"], json!(["wad-academy-config:/config:z"]));
    assert_eq!((ws["hotkey"].clone(), ws["autostart"].clone()), (Value::Null, json!(false)));
    let s = ws["signins"].as_array().unwrap();
    assert_eq!(s.len(), 8);
    assert_eq!(
        s[0],
        json!({ "id": "s-gh", "app": "github", "web": true, "name": "Me-WadBrowser-GitHub", "kind": "web", "slot": "web:github" })
    );
    assert_eq!(
        s[7],
        json!({ "id": "s-claude", "app": "vscode", "name": "Me-VSCode-ClaudeCode", "kind": "vscode-claude-code", "slot": "ext:anthropic.claude-code" })
    );
    // From before the layers: its old image, with its wallpaper baked in.
    let mut old = w.clone();
    old["legacyImage"] = "localhost/wadspaces-academy:latest".into();
    let ws = workspace_for(&old, &dev(), &academy_dev(), &json!({}));
    assert_eq!(ws["image"], "localhost/wadspaces-academy:latest");
    assert!(ws["env"].get("WALLPAPER").is_none());
    assert_eq!(ws["env"]["TZ"], "Etc/UTC");
}

fn v1(id: &str, name: &str, icons: Value, tools: Value) -> Value {
    json!({ "id": id, "name": name, "description": "d", "updatedAt": "2026-05-01",
            "layout": { "wallpaper": { "type": "image", "value": "/wallpapers/x.png" }, "grid": true, "icons": icons },
            "advanced": { "tools": tools, "projects": ["p1", "gone"], "hotkey": 3, "autostart": true } })
}

fn icon(app: &str, row: u32, extra: Value) -> Value {
    let mut i = json!({ "id": format!("{app}-{row}"), "appId": app, "label": app, "iconUrl": "", "color": "#000", "x": 0, "y": 0, "cell": { "col": 0, "row": row } });
    for (k, v) in extra.as_object().unwrap() {
        i[k] = v.clone();
    }
    i
}

#[test]
fn an_old_wadspace_becomes_a_template_a_customization_and_a_wadspace() {
    let old = v1(
        "academy-ab12cd",
        "Academy",
        json!([
            icon("chrome", 0, json!({ "label": "Chrome" })),
            icon("vscode", 1, json!({ "label": "VS Code", "autostart": true })),
            icon("gmail", 2, json!({ "label": "Gmail", "signIn": "s-mail" })),
            icon("github", 3, json!({ "label": "GitHub", "signIn": "unknown-1" })),
            icon("slack", 4, json!({ "label": "Slack" })),
            icon("brave", 5, json!({ "label": "Brave" })),
            icon("obsidian", 6, json!({ "label": "Obsidian", "signIn": "s-obs" })),
            icon("wadbrowser-focus", 7, json!({})),
        ]),
        json!(["git", "python", "firebase"]),
    );
    let opts = json!({ "owner": "me", "now": "2026-10-11", "legacyImage": "localhost/wadspaces-academy-ab12cd:latest",
                       "projects": ["p1"], "signins": [{ "id": "s-mail", "name": "Mail", "app": "web" }, { "id": "s-obs", "name": "Notes", "app": "obsidian" }] });
    let m = migrate_wadspace_v1(&old, &lib(), &opts);
    assert_eq!(m["newTemplate"], true);
    assert_eq!(m["template"]["apps"], json!(["chrome", "vscode", "wadbrowser", "obsidian"]));
    assert_eq!(m["template"]["name"], "Chrome + 3 apps");
    let c = &m["customization"];
    assert_eq!(c["name"], "Academy setup");
    assert_eq!(c["templateId"], m["template"]["id"]);
    assert_eq!(keys(c["webapps"].as_array().unwrap(), "name"), ["Gmail", "GitHub", "Slack"]);
    assert_eq!(c["webapps"][2]["url"], "https://app.slack.com/client");
    assert_eq!(c["tools"], json!(["python", "firebase"]));
    assert_eq!(c["autostart"], json!(["app:vscode"]));
    // WadBrowser Focus only (no plain WadBrowser icon): the customization's mode.
    assert_eq!(c["browserMode"], "focus");
    let w = &m["wadspace"];
    assert_eq!((w["version"].clone(), w["id"].clone()), (json!(2), json!("academy-ab12cd")));
    assert_eq!(w["base"], json!({ "kind": "customization", "id": c["id"] }));
    assert_eq!(w["projects"], json!(["p1"]));
    assert_eq!(w["wallpaper"]["value"], "/wallpapers/x.png");
    assert_eq!(w["legacyImage"], "localhost/wadspaces-academy-ab12cd:latest");
    assert_eq!(w["secrets"]["web:gmail"], r("s-mail", "Mail", "web"));
    assert_eq!(w["secrets"]["web:github"], r("unknown-1", "unknown-1", "web"));
    assert_eq!(w["secrets"]["app:obsidian"], r("s-obs", "Notes", "obsidian"));
    assert!(w.get("hotkey").is_none() && w.get("advanced").is_none());
    assert_eq!(m["leftOut"], json!(["Brave"]));
    assert_eq!(m["chromeApps"], json!(["Slack"]));
    assert_eq!(
        m["notice"],
        "Left out of Academy: Brave. Slack opens in WadBrowser now, which can't do video calls or play DRM video."
    );
}

#[test]
fn an_old_wadspace_with_the_same_apps_as_a_template_reuses_it() {
    let old = v1("writing", "Writing", json!([icon("obsidian", 0, json!({ "label": "Obsidian" }))]), json!(["git"]));
    let m = migrate_wadspace_v1(&old, &lib(), &json!({ "owner": "me", "now": "2026-10-11" }));
    assert_eq!((m["newTemplate"].clone(), m["template"]["id"].clone()), (json!(false), json!("writing")));
    assert!(m["customization"].is_null(), "nothing differs from Writing");
    assert_eq!(m["wadspace"]["base"], json!({ "kind": "template", "id": "writing" }));
    assert_eq!(m["wadspace"]["projects"], json!(["p1", "gone"]), "no project list given: all kept");
    assert!(m["wadspace"].get("legacyImage").is_none());
    assert!(m["notice"].is_null());
}

#[test]
fn migrated_names_and_ids_stay_unique() {
    let old = v1("x", "Dev", json!([icon("vscode", 0, json!({})), icon("tiled", 1, json!({}))]), json!(["go"]));
    let mut l = lib();
    l["templates"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "vs-code-1-app", "name": "VS Code + 1 app", "apps": ["vscode"] }));
    l["customizations"].as_array_mut().unwrap().push(json!({ "id": "dev-setup", "name": "Dev setup" }));
    let m = migrate_wadspace_v1(&old, &l, &json!({ "owner": "me", "now": "t" }));
    assert_eq!(
        (m["template"]["name"].as_str(), m["template"]["id"].as_str()),
        (Some("VS Code + 1 app 2"), Some("vs-code-1-app-2"))
    );
    assert_eq!(
        (m["customization"]["name"].as_str(), m["customization"]["id"].as_str()),
        (Some("Dev setup 2"), Some("dev-setup-2"))
    );
}

#[test]
fn every_preset_migrates() {
    for p in crate::presets::presets() {
        let id = p["id"].as_str().unwrap();
        let ws = crate::presets::preset_wadspace(id).unwrap();
        let m = migrate_wadspace_v1(&ws, &lib(), &json!({ "owner": "me", "now": "t" }));
        assert!(!js::arr(&m["template"], "apps").is_empty(), "{id}");
        assert_eq!(m["wadspace"]["name"], p["name"], "{id}");
        let r = resolve(
            &json!({ "templates": [m["template"].clone()], "customizations": [m["customization"].clone()] }),
            &m["wadspace"]["base"],
        );
        assert!(!r.is_null(), "{id}");
    }
}

#[test]
fn extension_ids_are_plain_marketplace_ids() {
    for ok in ["anthropic.claude-code", "rust-lang.rust-analyzer", "ms-vscode.cpptools", "a.b.c"] {
        assert!(is_extension_id(ok), "{ok}");
    }
    for bad in ["", "noperiod", ".x", "x.", "a b.c", "a.$(x)", "a;b.c"] {
        assert!(!is_extension_id(bad), "{bad}");
    }
}

#[test]
fn starters_are_writing_and_dev_from_catalog_apps() {
    let st = catalog::starters().as_array().unwrap();
    assert_eq!(keys(st, "name"), ["Writing", "Dev"]);
    for t in st {
        for a in strs(t, "apps") {
            assert!(catalog::catalog_app(a).is_some(), "{a}");
        }
    }
}
