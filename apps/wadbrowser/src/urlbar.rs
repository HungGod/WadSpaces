//! What the URL bar does with what's typed into it: open it as an address, or
//! search for it.

use tauri::Url;

pub const DEFAULT_SEARCH: &str = "https://duckduckgo.com/?q=%s";

/// The page to load for `input`, or None for nothing (blank input).
pub fn resolve(input: &str, search: &str) -> Option<String> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    if has_scheme(input) {
        return Some(input.to_owned());
    }
    if !input.contains(char::is_whitespace) && host_like(input) {
        let scheme = if local(host_of(input)) { "http" } else { "https" };
        if let Ok(url) = Url::parse(&format!("{scheme}://{input}")) {
            return Some(url.into());
        }
    }
    Some(search.replace("%s", &encode(input)))
}

/// An address a launcher or link handed over: as given if it has a scheme,
/// else as if typed into the bar (never a search).
pub fn normalize(url: &str) -> String {
    let url = url.trim();
    if has_scheme(url) || url.is_empty() {
        return url.to_owned();
    }
    let scheme = if local(host_of(url)) { "http" } else { "https" };
    format!("{scheme}://{url}")
}

fn has_scheme(s: &str) -> bool {
    const KNOWN: &[&str] = &["http", "https", "file", "about", "data", "blob", "view-source", "wadbrowser", "webkit"];
    match s.split_once(':') {
        Some((scheme, rest)) => {
            let scheme = scheme.to_ascii_lowercase();
            // "localhost:3000" and "host:8080/x" are hosts with ports, not schemes.
            (KNOWN.contains(&scheme.as_str()) || rest.starts_with("//"))
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        None => false,
    }
}

fn host_of(s: &str) -> &str {
    let end = s.find(['/', '?', '#']).unwrap_or(s.len());
    let host_port = &s[..end];
    if let Some(rest) = host_port.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    host_port.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map_or(host_port, |(h, _)| h)
}

fn host_like(s: &str) -> bool {
    let host = host_of(s);
    if host.is_empty() {
        return false;
    }
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<std::net::IpAddr>().is_ok()
        || (host.contains('.')
            && !host.starts_with('.')
            && !host.ends_with('.')
            && host.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '.'))
            // "e.g" and "v1.2" read as words, not hosts: the last label must be letters.
            && host.rsplit('.').next().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(char::is_alphabetic)))
}

/// Loopback, private and .local hosts: http by default (dev servers).
pub fn local(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
        }
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
        Err(_) => false,
    }
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> String {
        resolve(s, DEFAULT_SEARCH).unwrap()
    }

    #[test]
    fn addresses() {
        assert_eq!(r("https://example.com/a?b"), "https://example.com/a?b");
        assert_eq!(r("example.com"), "https://example.com/");
        assert_eq!(r("  github.com/HungGod  "), "https://github.com/HungGod");
        assert_eq!(r("localhost:3000"), "http://localhost:3000/");
        assert_eq!(r("192.168.1.20:8080/x"), "http://192.168.1.20:8080/x");
        assert_eq!(r("10.0.0.1"), "http://10.0.0.1/");
        assert_eq!(r("8.8.8.8"), "https://8.8.8.8/");
        assert_eq!(r("printer.local"), "http://printer.local/");
        assert_eq!(r("about:blank"), "about:blank");
        assert_eq!(r("file:///etc/hosts"), "file:///etc/hosts");
    }

    #[test]
    fn searches() {
        assert_eq!(r("rust gtk overlay"), "https://duckduckgo.com/?q=rust+gtk+overlay");
        assert_eq!(r("wadspaces"), "https://duckduckgo.com/?q=wadspaces");
        assert_eq!(r("e.g"), "https://duckduckgo.com/?q=e.g");
        assert_eq!(r("v1.2"), "https://duckduckgo.com/?q=v1.2");
        assert_eq!(r("c++ & rust?"), "https://duckduckgo.com/?q=c%2B%2B+%26+rust%3F");
        assert_eq!(resolve("   ", DEFAULT_SEARCH), None);
    }

    #[test]
    fn normalized() {
        assert_eq!(normalize("claude.ai"), "https://claude.ai");
        assert_eq!(normalize("localhost:8080"), "http://localhost:8080");
        assert_eq!(normalize("https://x.y"), "https://x.y");
    }
}
