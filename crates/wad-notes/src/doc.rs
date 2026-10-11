//! A file's two parts: TOML front matter between `+++` lines, then the
//! markdown body. A markdown file without front matter (one dropped into the
//! folder by hand) is all body.

const FENCE: &str = "+++";

/// (front matter, body). The front matter is empty when there's none.
pub fn split(text: &str) -> (&str, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text.strip_prefix(FENCE).and_then(|r| r.strip_prefix('\n').or_else(|| r.strip_prefix("\r\n")))
    else {
        return ("", text);
    };
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == FENCE {
            let body = &rest[at + line.len()..];
            return (&rest[..at], body.strip_prefix('\n').unwrap_or(body));
        }
        at += line.len();
    }
    ("", text) // never closed: not front matter after all
}

pub fn join(front: &str, body: &str) -> String {
    let front = front.trim_end();
    let mut out = format!("{FENCE}\n{front}\n{FENCE}\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(body);
        if !body.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

/// A body's title when the front matter has none: its first heading, else
/// its first line.
pub fn title_of(body: &str) -> Option<String> {
    let lines = || body.lines().map(str::trim).filter(|l| !l.is_empty());
    let heading = lines().find_map(|l| l.strip_prefix('#').map(|h| h.trim_start_matches('#').trim().to_string()));
    heading.or_else(|| lines().next().map(str::to_string)).filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_matter_and_body() {
        let text = join("title = \"A\"", "# Hello\n\nworld");
        assert_eq!(text, "+++\ntitle = \"A\"\n+++\n\n# Hello\n\nworld\n");
        assert_eq!(split(&text), ("title = \"A\"\n", "# Hello\n\nworld\n"));
        assert_eq!(split("just text"), ("", "just text"));
        assert_eq!(split("+++\nnever closed"), ("", "+++\nnever closed"));
        assert_eq!(split("+++\r\na = 1\r\n+++\r\nbody"), ("a = 1\r\n", "body"));
        assert_eq!(join("a = 1\n", ""), "+++\na = 1\n+++\n");
    }

    #[test]
    fn titles_from_the_body() {
        assert_eq!(title_of("\n## Plan\nmore").as_deref(), Some("Plan"));
        assert_eq!(title_of("first line\n# later").as_deref(), Some("later"));
        assert_eq!(title_of("no heading\nat all").as_deref(), Some("no heading"));
        assert_eq!(title_of("  \n"), None);
    }
}
