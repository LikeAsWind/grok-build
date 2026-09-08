//! End-to-end test for v2 §7.2.3 cron tick semantics.
//!
//! Verifies that at a given fake `now`, the right `(project, schedule)` pairs
//! fire. The unit tests in `workbench::cron::tests` cover the parsing +
//! matching for a single cron expression; this e2e exercises the full
//! `CronConfig::matches_now` API against a realistic YAML schedule set so
//! we have proof that the integration from YAML parse -> match is correct
//! end-to-end (no scheduler running, no dispatcher attached).
//!
//! The dispatcher-attached path (tick -> dispatch_pending) is deferred until
//! the cron tick loop is implemented in `agent_ops::spawn_workbench_dispatcher`;
//! that wiring is out of v2 M2.5 scope per the M2.5 plan §commit.

use xai_grok_shell::workbench::cron::CronConfig;
use chrono::TimeZone;

#[test]
fn cron_e2e_yaml_parse_then_matches_at_minute() {
    let yaml = r#"
projects:
  - key: my-app
    schedules:
      - cron: "* * * * * * *"
        tapd_status_filter: ["open"]
        priority_filter: ["high"]
      - cron: "0 0 9 * * MON *"
        tapd_status_filter: ["planning"]
        priority_filter: ["urgent"]
  - key: other-app
    schedules:
      - cron: "0 */30 * * * * *"
# note: every 30 minutes starting at :00
"#;
    let cfg: CronConfig = serde_yaml::from_str(yaml).expect("yaml parses");
    // Monday 2026-09-07 09:00:00 UTC (test fixture).
    let monday_9 = chrono::Utc.with_ymd_and_hms(2026, 9, 7, 9, 0, 0).unwrap();
    let fired = cfg.matches_now(monday_9);
    // Both my-app schedules fire (every second + Monday 09:00), and other-app
    // fires (every 30 minutes includes :00).
    assert_eq!(fired.len(), 3, "expected 3 fires, got {:?} (keys: {:?})",
               fired.iter().map(|(k, _)| k).collect::<Vec<_>>(),
               fired.len());
    let keys: std::collections::HashSet<&str> =
        fired.iter().map(|(k, _)| k.as_str()).collect();
    assert!(keys.contains("my-app"));
    assert!(keys.contains("other-app"));
}

#[test]
fn cron_e2e_no_cron_expression_means_nothing_fires() {
    let yaml = r#"
projects: []
"#;
    let cfg: CronConfig = serde_yaml::from_str(yaml).unwrap();
    let now = chrono::Utc::now();
    assert!(cfg.matches_now(now).is_empty());
}

#[test]
fn cron_e2e_missing_yaml_means_no_projects() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("does-not-exist.yaml");
    // from_path returns Ok(None) for missing files (caller decides what to do).
    assert!(CronConfig::from_path(&p).unwrap().is_none());
}

