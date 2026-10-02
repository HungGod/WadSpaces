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
