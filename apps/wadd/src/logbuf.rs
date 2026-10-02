//! wadd's log: to stderr (the journal) and into a ring buffer for /v1/logs,
//! both with secrets taken out first. Tokens, passwords and the like never
//! reach the journal or the API, however a message was written.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;
use wad_proto::v1::LogLine;

/// The last `cap` log lines.
#[derive(Clone)]
pub struct LogBuffer {
    lines: Arc<Mutex<VecDeque<LogLine>>>,
    cap: usize,
}

impl LogBuffer {
    pub fn new(cap: usize) -> Self {
        Self { lines: Arc::new(Mutex::new(VecDeque::with_capacity(cap.min(4096)))), cap: cap.max(1) }
    }

    pub fn push(&self, line: LogLine) {
        let mut l = self.lines.lock().unwrap();
        if l.len() == self.cap {
            l.pop_front();
        }
        l.push_back(line);
    }

    /// The last `n` lines, oldest first.
    pub fn tail(&self, n: usize) -> Vec<LogLine> {
        let l = self.lines.lock().unwrap();
        l.iter().skip(l.len().saturating_sub(n)).cloned().collect()
    }
}

/// A tracing layer that writes each event, redacted, to stderr and the buffer.
pub struct BufferLayer {
    pub buffer: LogBuffer,
    pub to_stderr: bool,
}

struct Message(String);

impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.push_str(value);
        } else {
            let _ = write!(self.0, " {}={value}", field.name());
        }
    }
}

impl<S: Subscriber> Layer<S> for BufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut m = Message(String::new());
        event.record(&mut m);
        let meta = event.metadata();
        let line = LogLine {
            time: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            level: meta.level().as_str().to_lowercase(),
            target: meta.target().to_string(),
            message: redact(m.0.trim_start()),
        };
        if self.to_stderr {
            // The journal adds the time; the level is enough to scan by.
            eprintln!("{:<5} {}: {}", line.level, line.target, line.message);
        }
        self.buffer.push(line);
    }
}

const TOKEN_PREFIXES: &[&str] = &["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
const SECRET_KEYS: &[&str] = &["password", "passwd", "token", "secret", "psk", "authorization", "api_key", "apikey"];
const REDACTED: &str = "[redacted]";

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '+' | '=')
}

/// The message with secrets replaced by [redacted]: GitHub tokens anywhere,
/// `Bearer <token>`, and the value after a key that names a secret
/// (`password=…`, `"token": "…"`, `refresh_token: …`).
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while !rest.is_empty() {
        // GitHub tokens.
        if let Some(p) = TOKEN_PREFIXES.iter().find(|p| rest.starts_with(**p))
            && rest[p.len()..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        {
            out.push_str(REDACTED);
            rest = rest[p.len()..].trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '_');
            continue;
        }
        // Bearer tokens.
        if rest.len() >= 7 && rest[..7].eq_ignore_ascii_case("bearer ") {
            out.push_str(&rest[..7]);
            let after = &rest[7..];
            let n = after.len() - after.trim_start_matches(token_char).len();
            if n > 0 {
                out.push_str(REDACTED);
            }
            rest = &after[n..];
            continue;
        }
        // key=value / key: value / "key": "value" for secret-sounding keys.
        let word_len = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '_').len();
        if word_len > 0 {
            let word = &rest[..word_len];
            let lower = word.to_ascii_lowercase();
            out.push_str(word);
            rest = &rest[word_len..];
            if SECRET_KEYS.iter().any(|k| lower.contains(k)) {
                let sep = rest.len() - rest.trim_start_matches(['"', '\'', ' ', ':', '=']).len();
                let seps = &rest[..sep];
                if seps.contains([':', '=']) {
                    out.push_str(seps);
                    rest = &rest[sep..];
                    // `Authorization: Bearer <token>`: the scheme and the token both go.
                    for scheme in ["bearer ", "basic "] {
                        if rest.len() >= scheme.len() && rest[..scheme.len()].eq_ignore_ascii_case(scheme) {
                            rest = rest[scheme.len()..].trim_start();
                        }
                    }
                    let n = rest.len()
                        - rest
                            .trim_start_matches(|c: char| {
                                !c.is_whitespace() && !matches!(c, '"' | '\'' | ',' | '}' | ')' | ']')
                            })
                            .len();
                    if n > 0 {
                        out.push_str(REDACTED);
                    }
                    rest = &rest[n..];
                }
            }
            continue;
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_taken_out() {
        assert_eq!(redact("cloning with ghp_abcDEF123 now"), "cloning with [redacted] now");
        assert_eq!(redact("url=https://x:github_pat_11AB_cd@github.com"), "url=https://x:[redacted]@github.com");
        assert_eq!(redact("Authorization: Bearer eyJhbGc.x-y_z next"), "Authorization: [redacted] next");
        assert_eq!(redact("header bearer abc.def"), "header bearer [redacted]");
        assert_eq!(
            redact(r#"{"refresh_token": "AOE-1x", "name": "Surface"}"#),
            r#"{"refresh_token": "[redacted]", "name": "Surface"}"#
        );
        assert_eq!(redact("wifi password=hunter2 ssid=Home"), "wifi password=[redacted] ssid=Home");
        assert_eq!(redact("token missing for github"), "token missing for github");
        assert_eq!(redact("Ünï ghp_ and gho"), "Ünï ghp_ and gho");
    }

    #[test]
    fn the_buffer_keeps_the_last_lines() {
        let b = LogBuffer::new(3);
        for i in 0..5 {
            b.push(LogLine { time: i, level: "info".into(), target: "t".into(), message: i.to_string() });
        }
        assert_eq!(b.tail(10).iter().map(|l| l.message.as_str()).collect::<Vec<_>>(), ["2", "3", "4"]);
        assert_eq!(b.tail(1)[0].message, "4");
    }
}
