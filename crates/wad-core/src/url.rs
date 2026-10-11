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
