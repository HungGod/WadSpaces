//! Where a page says its icons are: `<link rel="…icon…">` tags (and its web
//! app manifest's), read from the page's head with a small tag scanner. Only
//! `<link>` and `<base>` tags matter here, so a full HTML parser isn't needed.

use url::Url;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub url: Url,
    /// The `sizes` attribute, lower case ("32x32 64x64", "any", "").
    pub sizes: String,
    /// The `rel` (or "manifest", "fallback").
    pub rel: String,
    /// Its `type`, if it says ("image/svg+xml").
    pub kind: String,
}

impl Candidate {
    /// What it says it is: SVG, by type or by name.
    pub fn says_svg(&self) -> bool {
        self.kind.contains("svg") || self.url.path().to_ascii_lowercase().ends_with(".svg")
    }

    /// The pixel area its `sizes` declares; "any" (a scalable icon) beats all.
    pub fn declared_area(&self) -> u64 {
        if self.sizes.split_whitespace().any(|s| s == "any") {
            return 1_000_000_000;
        }
        self.sizes
            .split_whitespace()
            .filter_map(|t| t.split_once('x'))
            .filter_map(|(w, h)| Some(w.parse::<u64>().ok()? * h.parse::<u64>().ok()?))
            .max()
            .unwrap_or(0)
    }
}

/// The icons `html` (the page at `page`) links to, and its manifest's address.
pub fn links(html: &str, page: &Url) -> (Vec<Candidate>, Option<Url>) {
    // Icons belong in the head; stop at the body so a long page isn't scanned.
    let lower = html.to_ascii_lowercase();
    let end = ["</head", "<body"].iter().filter_map(|t| lower.find(t)).min().unwrap_or(html.len());
    let (html, lower) = (&html[..end], &lower[..end]);

    let mut base = page.clone();
    let mut icons = Vec::new();
    let mut manifest = None;
    for (name, attrs) in tags(html, lower) {
        let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        if name == "base" {
            if let Some(b) = get("href").and_then(|h| page.join(h).ok()) {
                base = b;
            }
            continue;
        }
        let Some(href) = get("href").filter(|h| !h.trim().is_empty()) else { continue };
        let rel = get("rel").unwrap_or_default().to_ascii_lowercase();
        let Ok(url) = base.join(href.trim()) else { continue };
        if !matches!(url.scheme(), "http" | "https" | "data") {
            continue;
        }
        if rel.split_whitespace().any(|r| r == "manifest") {
            manifest.get_or_insert(url);
        } else if rel.contains("icon") {
            icons.push(Candidate {
                url,
                sizes: get("sizes").unwrap_or_default().to_ascii_lowercase(),
                rel,
                kind: get("type").unwrap_or_default().to_ascii_lowercase(),
            });
        }
    }
    (icons, manifest)
}

/// The icons a web app manifest (JSON at `at`) lists, "any" purpose first.
pub fn manifest_icons(json: &str, at: &Url) -> Vec<Candidate> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let mut icons: Vec<(bool, Candidate)> = v["icons"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| {
            let url = at.join(i["src"].as_str()?).ok()?;
            let purpose = i["purpose"].as_str().unwrap_or("any");
            // Maskable icons are padded onto a full background: a worse silhouette.
            let any = purpose.split_whitespace().any(|p| p == "any");
            Some((
                any,
                Candidate {
                    url,
                    sizes: i["sizes"].as_str().unwrap_or_default().to_ascii_lowercase(),
                    rel: "manifest".into(),
                    kind: i["type"].as_str().unwrap_or_default().to_ascii_lowercase(),
                },
            ))
        })
        .collect();
    icons.sort_by_key(|(any, _)| !any);
    icons.into_iter().map(|(_, c)| c).collect()
}

/// `<link>` and `<base>` tags in order: (name, [(attribute, value)]).
fn tags(html: &str, lower: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = lower[at..].find('<').map(|i| at + i) {
        at = i + 1;
        let rest = &lower[at..];
        if rest.starts_with("!--") {
            at = lower[at..].find("-->").map_or(lower.len(), |e| at + e + 3);
            continue;
        }
        for name in ["link", "base"] {
            if rest.starts_with(name)
                && rest[name.len()..].starts_with(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
            {
                let (attrs, next) = attributes(html, at + name.len());
                out.push((name.to_owned(), attrs));
                at = next;
                break;
            }
        }
    }
    out
}

/// Attributes from `from` to the tag's end; and where the tag ends.
fn attributes(html: &str, from: usize) -> (Vec<(String, String)>, usize) {
    let b = html.as_bytes();
    let mut i = from;
    let mut attrs = Vec::new();
    loop {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if i >= b.len() || b[i] == b'>' {
            return (attrs, (i + 1).min(b.len()));
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        let name = html[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                let s = i + 1;
                i = s;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = html[s..i].to_owned();
                i = (i + 1).min(b.len());
            } else {
                let s = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                    i += 1;
                }
                value = html[s..i].to_owned();
            }
        }
        if !name.is_empty() {
            attrs.push((name, unescape(&value)));
        }
    }
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Url {
        Url::parse("https://example.com/app/index.html").unwrap()
    }

    #[test]
    fn finds_icon_links() {
        let html = r##"<!doctype html><html><head>
            <meta charset=utf-8><!-- <link rel="icon" href="commented.png"> -->
            <LINK REL="shortcut icon" HREF="/favicon.ico">
            <link rel=apple-touch-icon sizes=180x180 href=touch.png>
            <link rel="icon" type="image/svg+xml" href="https://cdn.example.com/i.svg?a=1&amp;b=2" />
            <link rel="mask-icon" href="mask.svg" color="#000">
            <link rel="manifest" href="/site.webmanifest">
            <link rel="stylesheet" href="x.css">
            </head><body><link rel="icon" href="late.png"></body>"##;
        let (icons, manifest) = links(html, &page());
        let urls: Vec<&str> = icons.iter().map(|c| c.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "https://example.com/favicon.ico",
                "https://example.com/app/touch.png",
                "https://cdn.example.com/i.svg?a=1&b=2",
                "https://example.com/app/mask.svg"
            ]
        );
        assert_eq!(icons[1].declared_area(), 180 * 180);
        assert!(icons[2].says_svg() && icons[3].says_svg());
        assert_eq!(manifest.unwrap().as_str(), "https://example.com/site.webmanifest");
    }

    #[test]
    fn base_href_counts() {
        let html = r#"<head><base href="/static/"><link rel=icon href="f.png"></head>"#;
        let (icons, _) = links(html, &page());
        assert_eq!(icons[0].url.as_str(), "https://example.com/static/f.png");
    }

    #[test]
    fn sizes() {
        let c = |s: &str| Candidate { url: page(), sizes: s.into(), rel: "icon".into(), kind: String::new() };
        assert_eq!(c("16x16 32x32 192x192").declared_area(), 192 * 192);
        assert_eq!(c("any").declared_area(), 1_000_000_000);
        assert_eq!(c("").declared_area(), 0);
        assert_eq!(c("bogus").declared_area(), 0);
    }

    #[test]
    fn manifest_any_first() {
        let json = r#"{"icons":[{"src":"m.png","sizes":"512x512","purpose":"maskable"},
                                {"src":"/a.png","sizes":"192x192"}]}"#;
        let at = Url::parse("https://example.com/x/site.webmanifest").unwrap();
        let icons = manifest_icons(json, &at);
        assert_eq!(icons[0].url.as_str(), "https://example.com/a.png");
        assert_eq!(icons[1].url.as_str(), "https://example.com/x/m.png");
    }
}
