//! Every case in fixtures/board/goldens.json (what the web app's board
//! returned) gives the same result here.

use serde_json::Value;

const GOLDENS: &str = include_str!("../../../fixtures/board/goldens.json");

#[test]
fn all_cases_match_the_web_apps_board() {
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
