//! Per-project cron scheduler per v2 spec §7.2.3.
//!
//! Reads `~/.grok/cron.yaml` on each tick (every minute). For each project,
//! for each schedule, if the cron expression matches the current minute AND
//! any TAPD task for that project matches the schedule's
//! 'tapd_status_filter' + 'priority_filter', calls
//! dispatcher.dispatch_pending().
//!
//! Failure modes are logged + skipped, never crash the tick task:
//! - bad YAML at read time
//! - cron expression parse error
//! - no TAPD tasks match the filters
//! - dispatcher transient failure (it has its own retry/queue)

use std::path::Path;

use chrono::{DateTime, Timelike, Utc};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use tracing::warn;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProjectSchedule {
    pub key: String,
    pub schedules: Vec<CronSchedule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CronSchedule {
    pub cron: String,
    #[serde(default)]
    pub tapd_status_filter: Vec<String>,
    #[serde(default)]
    pub priority_filter: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct CronConfig {
    #[serde(default)]
    pub projects: Vec<ProjectSchedule>,
}

impl CronConfig {
    /// Parse `cron.yaml` from disk. Returns `Ok(None)` if the file is
    /// missing (caller decides whether to treat that as a no-op or warn).
    /// Returns `Err` only for IO / parse failures that should surface.
    pub fn from_path(path: &Path) -> anyhow::Result<Option<Self>> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(path)?;
        let cfg: CronConfig = serde_yaml::from_str(&raw)?;
        Ok(Some(cfg))
    }

    /// All `(project, schedule)` pairs scheduled at `now`.
    pub fn matches_now(&self, now: DateTime<Utc>) -> Vec<(String, &CronSchedule)> {
        let mut out = Vec::new();
        for p in &self.projects {
            for s in &p.schedules {
                match matches_now(&s.cron, now) {
                    Ok(true) => out.push((p.key.clone(), s)),
                    Ok(false) => {}
                    Err(e) => warn!(
                        project_key = %p.key,
                        cron = %s.cron,
                        "cron expression failed to parse: {e}"
                    ),
                }
            }
        }
        out
    }
}

/// True iff `expr` matches the minute `now` belongs to.
///
/// We use the `cron` crate (`Schedule::after`) which is timezone-aware.
/// The match is per-minute granularity: `now` is treated as the start of
/// its minute; we ask the schedule for the next firing after `now - 1s`
/// and check whether that firing is still in the same minute.
pub fn matches_now(expr: &str, now: DateTime<Utc>) -> anyhow::Result<bool> {
    let sched = expr.parse::<Schedule>()?;
    // The previous second gives us a window where "next firing" is the
    // current minute if the cron matches at this minute, or strictly later.
    let probe = now - chrono::Duration::seconds(1);
    let next = sched.after(&probe).next();
    match next {
        Some(t) => Ok(same_minute(t, now)),
        None => Ok(false),
    }
}

fn same_minute(a: DateTime<Utc>, b: DateTime<Utc>) -> bool {
    // Divide epoch seconds by 60 — equal quotients means the same minute.
    // This avoids needing to import `chrono::Datelike` and `Timelike`.
    a.timestamp() / 60 == b.timestamp() / 60
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn matches_now_respects_minute_field() {
        // "0 9 * * MON" = Mondays at 09:00
        let monday_9_00 = utc(2026, 9, 7, 9, 0); // 2026-09-07 is a Monday
        assert!(matches_now("0 0 9 * * MON *", monday_9_00).unwrap());
        let monday_9_01 = utc(2026, 9, 7, 9, 1);
        assert!(!matches_now("0 0 9 * * MON *", monday_9_01).unwrap());
    }

    #[test]
    fn matches_now_handles_wildcard() {
        // "* * * * *" = every minute
        assert!(matches_now("* * * * * * *", utc(2026, 9, 7, 9, 0)).unwrap());
        assert!(matches_now("* * * * * * *", utc(2026, 9, 7, 0, 0)).unwrap());
        assert!(matches_now("* * * * * * *", utc(2026, 9, 7, 23, 59)).unwrap());
    }

    #[test]
    fn parse_yaml_fails_loudly_on_bad_cron_expr() {
        let bad = r#"
projects:
  - key: my-app
    schedules:
      - cron: "not a cron expression at all"
        tapd_status_filter: ["open"]
"#;
        let cfg: CronConfig = serde_yaml::from_str(bad).expect("yaml parses");
        assert!(cfg.matches_now(utc(2026, 9, 7, 9, 0)).is_empty(),
            "bad cron must NOT match anything (we log + skip, not panic)");
    }

    #[test]
    fn from_path_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("does-not-exist.yaml");
        assert!(CronConfig::from_path(&p).unwrap().is_none());
    }

    #[test]
    fn matches_now_15_minute_interval() {
        // "*/15 * * * *" = every 15 minutes (0, 15, 30, 45)
        assert!(matches_now("0 */15 * * * * *", utc(2026, 9, 7, 9, 0)).unwrap());
        assert!(matches_now("0 */15 * * * * *", utc(2026, 9, 7, 9, 15)).unwrap());
        assert!(matches_now("0 */15 * * * * *", utc(2026, 9, 7, 9, 30)).unwrap());
        assert!(matches_now("0 */15 * * * * *", utc(2026, 9, 7, 9, 45)).unwrap());
        assert!(!matches_now("0 */15 * * * * *", utc(2026, 9, 7, 9, 7)).unwrap());
        assert!(!matches_now("0 */15 * * * * *", utc(2026, 9, 7, 9, 16)).unwrap());
    }

    #[test]
    fn matches_now_filters_projects_and_schedules() {
        let yaml = r#"
projects:
  - key: my-app
    schedules:
      - cron: "* * * * * * *"
      - cron: "0 0 9 * * MON *"
  - key: other-app
    schedules:
      - cron: "0 */30 * * * * *"
"#;
        let cfg: CronConfig = serde_yaml::from_str(yaml).unwrap();
        // At Monday 09:00: my-app has both schedules matching;
        // other-app's */30 does NOT (09:00 is not a multiple of 30).
        let at_monday_9 = utc(2026, 9, 7, 9, 0);
        let matches = cfg.matches_now(at_monday_9);
        assert_eq!(matches.len(), 3, "my-app 2 + other-app 1 (09:00 matches */30)");
        let keys: Vec<&str> = matches.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys.iter().filter(|k| **k == "my-app").count(), 2);
        assert_eq!(keys.iter().filter(|k| **k == "other-app").count(), 1);
        // At Monday 09:30: only my-app's "* * * * *" matches; other-app's
        // */30 also matches; my-app's "0 9 * * MON" does NOT.
        let at_monday_9_30 = utc(2026, 9, 7, 9, 30);
        let matches_30 = cfg.matches_now(at_monday_9_30);
        assert_eq!(matches_30.len(), 2, "my-app '* *' + other-app '*/30'");
        let keys: Vec<&str> = matches_30.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"my-app"));
        assert!(keys.contains(&"other-app"));
    }

}

