//! Every case in fixtures/board/goldens.json gives the same result here. The
//! cases came from the web app's board (wadspaces-client's
//! src/components/builder), which checks its copy of the file (`npm run
//! wasm` takes it): the two boards stay the same.

use serde_json::Value;

const GOLDENS: &str = include_str!("../../../fixtures/board/goldens.json");

#[test]
fn all_cases_match() {
    let cases: Vec<Value> = serde_json::from_str(GOLDENS).unwrap();
    assert!(cases.len() >= 250, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let name = c["fn"].as_str().unwrap();
        let args = c["args"].as_array().unwrap();
        let got = crate::call(name, args);
        let ok = match (&got, c.get("out"), c.get("err")) {
            (Ok(v), Some(want), _) => v == want,
            (Err(e), _, Some(want)) => want.as_str() == Some(e.as_str()),
            _ => false,
        };
        if !ok {
            let short = |v: &Value| v.to_string().chars().take(1500).collect::<String>();
            failures.push(format!(
                "#{i} {name}\n  want: {}\n  got:  {}",
                c.get("out").or(c.get("err")).map(short).unwrap_or_default(),
                match &got {
                    Ok(v) => short(v),
                    Err(e) => format!("Err({e})"),
                },
            ));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

/// After a deliberate change to what a function returns:
/// `UPDATE_GOLDENS=1 cargo test -p wad-board goldens -- --ignored` rewrites
/// the cases that differ now. Look at the diff before committing it, and
/// make the web app's board return the same (its tests check it).
#[test]
#[ignore = "rewrites fixtures/board/goldens.json; run on purpose"]
fn rewrite_changed_goldens() {
    if std::env::var("UPDATE_GOLDENS").as_deref() != Ok("1") {
        return;
    }
    let mut cases: Vec<Value> = serde_json::from_str(GOLDENS).unwrap();
    let mut n = 0;
    for c in cases.iter_mut() {
        let name = c["fn"].as_str().unwrap().to_string();
        let args = c["args"].as_array().unwrap().clone();
        if let (Ok(got), Some(want)) = (crate::call(&name, &args), c.get("out"))
            && &got != want
        {
            c["out"] = got;
            n += 1;
        }
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/board/goldens.json");
    // As JSON.stringify(cases, null, 1) wrote it.
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
    serde::Serialize::serialize(&cases, &mut ser).unwrap();
    out.push(b'\n');
    std::fs::write(path, out).unwrap();
    println!("rewrote {n} cases");
}
