//! Just enough of URL parsing for what the core reads from URLs: the host,
//! and one query parameter (as URLSearchParams.get decodes it).

/// The host of an absolute http(s) URL, lowercased; relative URLs resolve
/// against `base_host`. None for other schemes (data:, ...).
pub fn host<'a>(url: &'a str, base_host: &'a str) -> Option<String> {
    let lower = url.get(..8).map(str::to_ascii_lowercase).unwrap_or_default();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else if let Some(r) = url.strip_prefix("//") {
        r // scheme-relative: the base's scheme, its own host
    } else if has_scheme(url) {
        return None;
    } else {
        return Some(base_host.into());
    };
    let auth = rest.split(['/', '?', '#', '\\']).next().unwrap_or("");
    let hostport = auth.rsplit('@').next().unwrap_or("");
    let host = hostport.split(':').next().unwrap_or("");
    Some(host.to_ascii_lowercase())
}

fn has_scheme(url: &str) -> bool {
    let mut cs = url.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_alphabetic())
        && url
            .find(':')
            .is_some_and(|i| url[..i].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
}

/// `new URL(url).searchParams.get(name)`.
pub fn query_param(url: &str, name: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    let q = q.split('#').next().unwrap_or("");
    q.split('&').filter(|p| !p.is_empty()).find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (form_decode(k) == name).then(|| form_decode(v))
    })
}

/// application/x-www-form-urlencoded: + is a space, %XX a byte.
fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() && hex(b[i + 1]).is_some() && hex(b[i + 2]).is_some() => {
                out.push(hex(b[i + 1]).unwrap() * 16 + hex(b[i + 2]).unwrap());
                i += 3;
                continue;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}
