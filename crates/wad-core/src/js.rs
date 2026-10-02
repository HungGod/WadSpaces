//! JavaScript's semantics where the core depends on them: the TypeScript core
//! this replaces (and the goldens it left, fixtures/core) is the reference.
//! Values are JSON (`serde_json::Value`, insertion-ordered like JS objects).

use std::cmp::Ordering;

use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// JS `\s` / what `String.prototype.trim` removes: WhiteSpace and LineTerminator.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `.length`: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `a < b` for strings: UTF-16 code unit order (Array.prototype.sort's default).
pub fn cmp16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `.slice(0, n)` on a string that's ASCII by then.
pub fn ascii_prefix(s: &str, n: usize) -> &str {
    &s[..s.len().min(n)]
}

/// JS truthiness.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(n)`.
pub fn num(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f.fract() == 0.0 && f.abs() < 1e21 { format!("{f:.0}") } else { format!("{f}") }
}

/// `String(v)` (absent values are passed as Null by callers that mean undefined).
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => num(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `${o.k}` in a template: "undefined" when absent.
pub fn field(o: &Value, k: &str) -> String {
    o.get(k).map(string).unwrap_or_else(|| "undefined".into())
}

/// `list.map(x => x.k).join(sep)`: absent and null become "".
pub fn join_field(list: &[Value], k: &str, sep: &str) -> String {
    list.iter()
        .map(|x| match x.get(k) {
            None | Some(Value::Null) => String::new(),
            Some(v) => string(v),
        })
        .collect::<Vec<_>>()
        .join(sep)
}

/// `JSON.stringify(v)`.
pub fn stringify(v: &Value) -> String {
    serde_json::to_string(v).expect("JSON values serialize")
}

/// `JSON.stringify(v, null, indent)`.
pub fn stringify_pretty(v: &Value, indent: usize) -> String {
    use serde::Serialize;
    let pad = " ".repeat(indent);
    let mut out = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(pad.as_bytes());
    let mut ser = serde_json::Serializer::with_formatter(&mut out, fmt);
    v.serialize(&mut ser).expect("JSON values serialize");
    String::from_utf8(out).expect("JSON is UTF-8")
}

/// `o.k` as a string, when it is one.
pub fn str_of<'a>(o: &'a Value, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

/// `o.k ?? ""` for a string field (a non-string is taken as absent).
pub fn str_or<'a>(o: &'a Value, k: &str, or: &'a str) -> &'a str {
    str_of(o, k).unwrap_or(or)
}

/// `o.k` unless null/undefined (`??`).
pub fn present<'a>(o: &'a Value, k: &str) -> Option<&'a Value> {
    o.get(k).filter(|v| !v.is_null())
}

/// `o.k ?? []` as a slice.
pub fn arr<'a>(o: &'a Value, k: &str) -> &'a [Value] {
    o.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// The strings of `o.k ?? []`.
pub fn strs(o: &Value, k: &str) -> Vec<String> {
    arr(o, k).iter().map(string).collect()
}

/// `{ ...o, k: v }` where `v` may be undefined (then the key goes, as JSON drops it).
pub fn put(o: &mut Obj, k: &str, v: Option<&Value>) {
    match v {
        Some(v) => {
            o.insert(k.into(), v.clone());
        }
        None => {
            o.shift_remove(k);
        }
    }
}

/// `{...o}`.
pub fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

/// An ASCII-only test: every char in the set, `min..=max` of them.
pub fn all_in(s: &str, min: usize, max: usize, ok: impl Fn(char) -> bool) -> bool {
    let n = s.chars().count();
    (min..=max).contains(&n) && s.chars().all(ok)
}

/// Replace every maximal run of chars matching `bad` with `with` (`/[^...]+/g`).
pub fn replace_runs(s: &str, bad: impl Fn(char) -> bool, with: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if bad(c) {
            if !in_run {
                out.push_str(with);
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `/^-+|-+$/g` → "".
pub fn trim_dashes(s: &str) -> &str {
    s.trim_matches('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_strings() {
        assert_eq!(trim("\u{FEFF} a\u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a"); // NEL isn't JS whitespace
        assert_eq!(len16("a😀"), 3);
        assert_eq!(cmp16("\u{FF61}", "😀"), Ordering::Greater); // UTF-16 order, not code points
        assert_eq!(string(&serde_json::json!([1, null, "x"])), "1,,x");
        assert_eq!(stringify_pretty(&serde_json::json!({"a": [1]}), 4), "{\n    \"a\": [\n        1\n    ]\n}");
    }
}
