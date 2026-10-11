//! The calendar's arithmetic: a month's grid, what's on a day, what's coming,
//! and which reminders are due (with what was dismissed or snoozed).

use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::model::Event;

/// Six weeks from the Monday on or before the month's first day: every day
/// a month view shows, in order.
pub fn month_grid(year: i32, month: u32) -> Vec<NaiveDate> {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("a real month");
    let start = first - Duration::days(first.weekday().num_days_from_monday() as i64);
    (0..42).map(|i| start + Duration::days(i)).collect()
}

/// The month before or after (`by` months on).
pub fn add_months(year: i32, month: u32, by: i32) -> (i32, u32) {
    let n = year * 12 + month as i32 - 1 + by;
    (n.div_euclid(12), n.rem_euclid(12) as u32 + 1)
}

/// The events on a day (all-day ones first, then by start).
pub fn on_day(events: &[Event], day: NaiveDate) -> Vec<&Event> {
    let mut out: Vec<&Event> = events
        .iter()
        .filter(|e| {
            let (a, b) = e.days();
            a <= day && day <= b
        })
        .collect();
    out.sort_by_key(|e| (!e.all_day, e.start));
    out
}

/// What's still to come (or under way) from `now` to `days` days on, by start.
pub fn upcoming(events: &[Event], now: NaiveDateTime, days: i64) -> Vec<&Event> {
    let until = (now.date() + Duration::days(days)).and_time(NaiveTime::MIN);
    let mut out: Vec<&Event> = events.iter().filter(|e| e.over_at() > now && e.start < until).collect();
    out.sort_by_key(|e| e.start);
    out
}

/// When an event's reminder goes off: `remind` minutes before its start (an
/// all-day event's "start" for this is 9:00 on its first day).
pub fn remind_at(e: &Event) -> Option<NaiveDateTime> {
    let base = if e.all_day { e.start.date().and_hms_opt(9, 0, 0)? } else { e.start };
    Some(base - Duration::minutes(e.remind? as i64))
}

/// How long a missed reminder still shows (the machine was off): after
/// that it's let go.
const STALE: Duration = Duration::hours(12);

/// Reminders you've dealt with, by occurrence (the event and its time, so
/// moving an event sets its reminder again).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Reminders {
    #[serde(default)]
    pub dismissed: Vec<String>,
    /// occurrence -> not before this time (local, as the files have it).
    #[serde(default)]
    pub snoozed: BTreeMap<String, String>,
}

impl Reminders {
    pub fn key(e: &Event) -> String {
        format!("{}@{}", e.id, crate::model::fmt_time(e.start))
    }

    pub fn dismiss(&mut self, e: &Event) {
        let k = Self::key(e);
        self.snoozed.remove(&k);
        if !self.dismissed.contains(&k) {
            self.dismissed.push(k);
        }
    }

    pub fn snooze(&mut self, e: &Event, until: NaiveDateTime) {
        self.snoozed.insert(Self::key(e), crate::model::fmt_time(until));
    }

    /// Forgets what's about events that are gone or long over.
    pub fn prune(&mut self, events: &[Event], now: NaiveDateTime) {
        let live: Vec<String> =
            events.iter().filter(|e| e.over_at() + STALE > now).map(Self::key).collect();
        self.dismissed.retain(|k| live.contains(k));
        self.snoozed.retain(|k, _| live.contains(k));
    }
}

/// The reminders that should show now: gone off, not dismissed, not
/// snoozed past now, and not stale. Soonest first.
pub fn due_reminders<'a>(events: &'a [Event], now: NaiveDateTime, done: &Reminders) -> Vec<&'a Event> {
    let mut out: Vec<&Event> = events
        .iter()
        .filter(|e| {
            let Some(at) = remind_at(e) else { return false };
            let key = Reminders::key(e);
            let snoozed = done.snoozed.get(&key).and_then(|t| crate::model::parse_time(t)).is_some_and(|t| t > now);
            at <= now && now < at.max(e.start) + STALE && !done.dismissed.contains(&key) && !snoozed
        })
        .collect();
    out.sort_by_key(|e| e.start);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{parse_date, parse_time};

    fn t(s: &str) -> NaiveDateTime {
        parse_time(s).unwrap()
    }
    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }
    fn ev(id: &str, start: &str, remind: Option<u32>) -> Event {
        Event { id: id.into(), title: id.into(), remind, ..Event::new(t(start), None) }
    }

    #[test]
    fn a_months_grid() {
        let g = month_grid(2026, 10); // 1 October 2026 is a Thursday
        assert_eq!((g.len(), g[0], g[3], g[41]), (42, d("2026-09-28"), d("2026-10-01"), d("2026-11-08")));
        assert_eq!(add_months(2026, 12, 1), (2027, 1));
        assert_eq!(add_months(2026, 1, -1), (2025, 12));
        assert_eq!(add_months(2026, 10, -22), (2024, 12));
    }

    #[test]
    fn days_and_whats_coming() {
        let trip = Event { all_day: true, end: Some(t("2026-10-16")), ..ev("trip", "2026-10-14", None) };
        let call = ev("call", "2026-10-15T10:00", None);
        let early = Event { all_day: false, ..ev("early", "2026-10-15T07:00", None) };
        let all = vec![call.clone(), trip.clone(), early.clone()];
        let ids = |v: Vec<&Event>| v.into_iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(on_day(&all, d("2026-10-15"))), ["trip", "early", "call"]);
        assert_eq!(ids(on_day(&all, d("2026-10-16"))), ["trip"]);
        assert!(on_day(&all, d("2026-10-17")).is_empty());
        // Coming up from the 15th at 8:00: the trip (under way) and the call; the early one's over.
        assert_eq!(ids(upcoming(&all, t("2026-10-15T08:00"), 7)), ["trip", "call"]);
        assert_eq!(ids(upcoming(&all, t("2026-10-01T08:00"), 7)), Vec::<String>::new());
    }

    #[test]
    fn reminders_go_off_and_are_dealt_with() {
        let call = ev("call", "2026-10-15T10:00", Some(15));
        let quiet = ev("quiet", "2026-10-15T10:00", None);
        let day = Event { all_day: true, ..ev("day", "2026-10-15", Some(60)) };
        let all = vec![call.clone(), quiet, day.clone()];
        let mut done = Reminders::default();
        let due = |now: &str, done: &Reminders| {
            due_reminders(&all, t(now), done).into_iter().map(|e| e.id.clone()).collect::<Vec<_>>()
        };
        assert_eq!(remind_at(&day), Some(t("2026-10-15T08:00")));
        assert!(due("2026-10-15T07:59", &done).is_empty());
        assert_eq!(due("2026-10-15T09:45", &done), ["day", "call"]);
        done.snooze(&call, t("2026-10-15T09:50"));
        assert_eq!(due("2026-10-15T09:46", &done), ["day"]);
        assert_eq!(due("2026-10-15T09:50", &done), ["day", "call"]);
        done.dismiss(&call);
        done.dismiss(&day);
        assert!(due("2026-10-15T09:51", &done).is_empty());
        // Moved: it reminds again.
        let moved = vec![Event { start: t("2026-10-15T11:00"), ..call.clone() }];
        assert_eq!(due_reminders(&moved, t("2026-10-15T10:50"), &done).len(), 1);
        // Missed for half a day (the machine was off): let go.
        assert!(due("2026-10-15T22:30", &Reminders::default()).is_empty());
        // Pruned once long over.
        done.prune(&all, t("2026-10-20T00:00"));
        assert_eq!(done, Reminders::default());
    }
}
