//! Every case in fixtures/core/goldens.json (what the TypeScript core
//! returned) gives the same result here.

use serde_json::Value;

const GOLDENS: &str = include_str!("../../../fixtures/core/goldens.json");

#[test]
fn all_cases_match_the_typescript_core() {
    let cases: Vec<Value> = serde_json::from_str(GOLDENS).unwrap();
    assert!(cases.len() >= 400, "only {} cases", cases.len());
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
            failures.push(format!(
                "#{i} {name}({})\n  want: {}\n  got:  {}",
                crate::js::stringify(&Value::Array(args.clone())).chars().take(300).collect::<String>(),
                c.get("out")
                    .or(c.get("err"))
                    .map(crate::js::stringify)
                    .unwrap_or_default()
                    .chars()
                    .take(600)
                    .collect::<String>(),
                match &got {
                    Ok(v) => crate::js::stringify(v),
                    Err(e) => format!("Err({e})"),
                }
                .chars()
                .take(600)
                .collect::<String>(),
            ));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

/// After a deliberate change to an output (the build folder's README, say):
/// `UPDATE_GOLDENS=1 cargo test -p wad-core goldens -- --ignored` rewrites the
/// cases that differ now. Look at the diff before committing it.
#[test]
#[ignore = "rewrites fixtures/core/goldens.json; run on purpose"]
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
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/core/goldens.json");
    // As JSON.stringify(cases, null, 1) wrote it.
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
    serde::Serialize::serialize(&cases, &mut ser).unwrap();
    out.push(b'\n');
    std::fs::write(path, out).unwrap();
    println!("rewrote {n} cases");
}
