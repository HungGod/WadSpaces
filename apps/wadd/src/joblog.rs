//! A long job's log (launches and builds): the last lines in memory, every
//! line in <state_dir>/<kind>/<id>.log, and how many each watcher has had.

use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Lines {
    lines: Vec<String>,
    /// Lines dropped from the front (only the last `max` are kept).
    dropped: u64,
    max: usize,
    file: PathBuf,
}

impl Lines {
    pub fn new(dir: &Path, id: &str, max: usize) -> Self {
        Self { lines: vec![], dropped: 0, max, file: dir.join(format!("{id}.log")) }
    }

    pub fn push(&mut self, text: &str) {
        self.lines.push(text.into());
        if self.lines.len() > self.max {
            let cut = self.lines.len() - self.max;
            self.lines.drain(..cut);
            self.dropped += cut as u64;
        }
        if let Some(d) = self.file.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.file) {
            let _ = writeln!(f, "{text}");
        }
    }

    /// Lines so far, dropped ones included.
    pub fn total(&self) -> u64 {
        self.dropped + self.lines.len() as u64
    }

    /// The lines from line `n` on (as many as are still kept).
    pub fn since(&self, n: u64) -> Vec<String> {
        let skip = n.saturating_sub(self.dropped) as usize;
        self.lines.iter().skip(skip).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_lines_are_kept_and_all_are_written() {
        let d = tempfile::tempdir().unwrap();
        let mut l = Lines::new(&d.path().join("jobs"), "j1", 3);
        for i in 0..5 {
            l.push(&format!("line {i}"));
        }
        assert_eq!(l.total(), 5);
        assert_eq!(l.since(0), ["line 2", "line 3", "line 4"]);
        assert_eq!(l.since(4), ["line 4"]);
        assert!(l.since(5).is_empty());
        assert_eq!(std::fs::read_to_string(d.path().join("jobs/j1.log")).unwrap().lines().count(), 5);
    }
}
