//! A note's markdown as Pango markup, for its preview (a GtkLabel): headings,
//! emphasis, code, lists, task boxes, quotes and links (shown, not opened).
//! Everything from the note is escaped.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

pub fn to_pango(md: &str) -> String {
    let opts = Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES;
    let mut out = String::new();
    // Each open list: Some(next number) for an ordered one.
    let mut lists: Vec<Option<u64>> = vec![];
    let mut quote = 0usize;
    let mut in_code = false;
    // A blank line between blocks (not before the first).
    let gap = |out: &mut String| {
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push_str(if out.ends_with('\n') { "\n" } else { "\n\n" });
        }
    };
    for ev in Parser::new_ext(md, opts) {
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                gap(&mut out);
                let size = match level {
                    HeadingLevel::H1 => "x-large",
                    HeadingLevel::H2 => "large",
                    _ => "medium",
                };
                out.push_str(&format!("<span size=\"{size}\" weight=\"bold\">"));
            }
            Event::End(TagEnd::Heading(_)) => out.push_str("</span>\n"),
            Event::Start(Tag::Paragraph) => {
                if lists.is_empty() {
                    gap(&mut out);
                }
                if quote > 0 {
                    out.push_str("<span foreground=\"#8b93a7\">▎ <i>");
                }
            }
            Event::End(TagEnd::Paragraph) => {
                if quote > 0 {
                    out.push_str("</i></span>");
                }
                if lists.is_empty() {
                    out.push('\n');
                }
            }
            Event::Start(Tag::BlockQuote(_)) => quote += 1,
            Event::End(TagEnd::BlockQuote(_)) => quote = quote.saturating_sub(1),
            Event::Start(Tag::List(start)) => {
                if lists.is_empty() {
                    gap(&mut out);
                }
                lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) => {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&"    ".repeat(lists.len().saturating_sub(1)));
                match lists.last_mut() {
                    Some(Some(n)) => {
                        out.push_str(&format!("{n}. "));
                        *n += 1;
                    }
                    _ => out.push_str("• "),
                }
            }
            Event::End(TagEnd::Item) => {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            Event::TaskListMarker(done) => {
                // The bullet gives way to the box.
                if out.ends_with("• ") {
                    out.truncate(out.len() - "• ".len());
                }
                out.push_str(if done { "☑ " } else { "☐ " });
            }
            Event::Start(Tag::CodeBlock(_)) => {
                gap(&mut out);
                in_code = true;
                out.push_str("<tt>");
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code = false;
                while out.ends_with('\n') {
                    out.pop();
                }
                out.push_str("</tt>\n");
            }
            Event::Start(Tag::Emphasis) => out.push_str("<i>"),
            Event::End(TagEnd::Emphasis) => out.push_str("</i>"),
            Event::Start(Tag::Strong) => out.push_str("<b>"),
            Event::End(TagEnd::Strong) => out.push_str("</b>"),
            Event::Start(Tag::Strikethrough) => out.push_str("<s>"),
            Event::End(TagEnd::Strikethrough) => out.push_str("</s>"),
            Event::Start(Tag::Link { .. }) => out.push_str("<u>"),
            Event::End(TagEnd::Link) => out.push_str("</u>"),
            // Tables: a row a line, cells apart.
            Event::Start(Tag::Table(_)) => gap(&mut out),
            Event::Start(Tag::TableHead) => out.push_str("<b>"),
            Event::End(TagEnd::TableHead) => out.push_str("</b>\n"),
            Event::End(TagEnd::TableRow) => out.push('\n'),
            Event::End(TagEnd::TableCell) => out.push_str("   "),
            Event::Code(c) => out.push_str(&format!("<tt>{}</tt>", escape(&c))),
            Event::Text(t) => out.push_str(&escape(&t)),
            Event::SoftBreak => out.push(if in_code { '\n' } else { ' ' }),
            Event::HardBreak => out.push('\n'),
            Event::Rule => {
                gap(&mut out);
                out.push_str("<span foreground=\"#8b93a7\">────────────</span>\n");
            }
            // Raw HTML is shown as text.
            Event::Html(h) | Event::InlineHtml(h) => out.push_str(&escape(&h)),
            _ => {}
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pango would refuse it otherwise: every tag closed, in order.
    fn balanced(m: &str) -> bool {
        let mut stack = vec![];
        let mut rest = m;
        while let Some(i) = rest.find('<') {
            let j = rest[i..].find('>').unwrap() + i;
            let tag = &rest[i + 1..j];
            if let Some(name) = tag.strip_prefix('/') {
                if stack.pop() != Some(name.to_string()) {
                    return false;
                }
            } else {
                stack.push(tag.split(' ').next().unwrap().to_string());
            }
            rest = &rest[j + 1..];
        }
        stack.is_empty()
    }

    #[test]
    fn markdown_to_markup() {
        let md = "# Plan\n\nSome *soft* and **strong** `code`.\n\n- one\n- [x] done\n- [ ] todo\n  1. sub\n\n> quoted\n\n```\nlet x = 1 < 2;\n```\n\n[link](https://x.y) ~~gone~~";
        let m = to_pango(md);
        assert!(balanced(&m), "{m}");
        assert!(m.starts_with("<span size=\"x-large\" weight=\"bold\">Plan</span>"), "{m}");
        assert!(m.contains("<i>soft</i> and <b>strong</b> <tt>code</tt>"), "{m}");
        assert!(m.contains("• one\n☑ done\n☐ todo\n    1. sub"), "{m}");
        assert!(m.contains("▎ <i>quoted</i>"), "{m}");
        assert!(m.contains("<tt>let x = 1 &lt; 2;</tt>"), "{m}");
        assert!(m.contains("<u>link</u> <s>gone</s>"), "{m}");
    }

    #[test]
    fn whatever_the_note_says_is_escaped() {
        let m = to_pango("<span foreground='red'>x</span> & <b>");
        assert!(balanced(&m), "{m}");
        assert!(!m.contains("<span foreground='red'>"), "{m}");
        assert!(m.contains("&amp;"), "{m}");
        let t = to_pango("| a | b |\n|---|---|\n| 1 | 2 |");
        assert!(balanced(&t), "{t}");
        assert!(t.contains("<b>a   b   </b>"), "{t}");
    }
}
