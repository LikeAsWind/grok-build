//! v2 spec §9.2.2: per-stage metrics aggregator.
//!
//! Reads `workbench_task_metrics` rows (one per (task, stage, attempt);
//! see `tapd::store::record_task_metric`) and produces a `MetricsSummary`
//! that answers questions like:
//!
//! - "What was the median Develop duration last week?"
//! - "How many tasks fell back to a fallback model this month?"
//! - "Which project has the highest Verify-fail rate?"
//!
//! Pure functions only -- no I/O, no LLM, no clock. The caller fetches rows
//! from `TapdStore::task_metrics` and feeds them to `aggregate`.

use crate::tapd::store::TaskMetricRow;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageAggregate {
    pub stage: String,
    pub p50_ms: i64,
    pub p90_ms: i64,
    pub retry_count: i64,
    pub fallback_count: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Totals {
    pub done: i64,
    pub blocked: i64,
    pub dead: i64,
    pub sample_size: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricsSummary {
    pub project_key: Option<String>,
    pub since_ts: i64,
    pub totals: Totals,
    pub stages: Vec<StageAggregate>,
}

/// Aggregate a batch of metric rows into a per-stage summary. Rows with
/// `duration_ms.is_none()` are excluded from the percentile calculation but
/// still contribute to the retry_count (attempt > 0 implies retry).
pub fn aggregate(rows: &[TaskMetricRow], since_ts: i64) -> MetricsSummary {
    let mut stages: std::collections::BTreeMap<String, StageAggregate> =
        std::collections::BTreeMap::new();
    let mut all_durations: std::collections::BTreeMap<String, Vec<i64>> =
        std::collections::BTreeMap::new();
    let mut totals = Totals::default();
    totals.sample_size = rows.len() as i64;

    for row in rows {
        if row.started_at < since_ts {
            continue;
        }
        let entry = stages.entry(row.stage.clone()).or_default();
        if row.attempt > 0 {
            entry.retry_count += 1;
        }
        if row.fallback_used != 0 {
            entry.fallback_count += 1;
        }
        if let Some(d) = row.duration_ms {
            all_durations.entry(row.stage.clone()).or_default().push(d);
        }
    }

    // Compute percentiles per stage. Use nearest-rank (the standard
    // percentile definition for small samples); for empty samples we emit
    // 0.
    for (stage, mut durations) in all_durations {
        durations.sort_unstable();
        let entry = stages.entry(stage.clone()).or_default();
        entry.p50_ms = percentile(&durations, 0.50);
        entry.p90_ms = percentile(&durations, 0.90);
    }

    MetricsSummary {
        project_key: None,
        since_ts,
        totals,
        stages: stages.into_values().collect(),
    }
}

/// Aggregate filtered by project key (used by per-project dashboards).
/// A row counts toward totals when its task_id starts with `<project_key>:`.
/// (Real project -> task_id mapping lives in TAPD; this is a heuristic for
/// the v1/v2 prototype.)
pub fn aggregate_for_project(
    rows: &[TaskMetricRow],
    project_key: &str,
    since_ts: i64,
) -> MetricsSummary {
    let prefix = format!("{}:", project_key);
    let filtered: Vec<TaskMetricRow> = rows
        .iter()
        .filter(|r| r.task_id.starts_with(&prefix))
        .cloned()
        .collect();
    let mut summary = aggregate(&filtered, since_ts);
    summary.project_key = Some(project_key.to_string());
    summary
}

/// Compute the p-th percentile of a sorted slice using nearest-rank.
/// Returns 0 for an empty slice. Caller must pre-sort.
pub fn percentile(sorted: &[i64], p: f64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p * sorted.len() as f64).ceil() as usize;
    let idx = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[idx]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(stage: &str, attempt: u8, duration_ms: Option<i64>, fallback: i64, started_at: i64) -> TaskMetricRow {
        TaskMetricRow {
            task_id: format!("TAPD-1:{}", stage),
            stage: stage.into(),
            attempt,
            started_at,
            finished_at: duration_ms.map(|d| started_at + d),
            duration_ms,
            model: None,
            fallback_used: fallback,
            child_session_id: None,
        }
    }

    #[test]
    fn aggregate_empty_rows_returns_zeros() {
        let s = aggregate(&[], 0);
        assert_eq!(s.totals.sample_size, 0);
        assert_eq!(s.stages.len(), 0);
    }

    #[test]
    fn aggregate_p50_p90_single_stage() {
        // 10 durations: 100, 200, ..., 1000. p50 = 500, p90 = 900.
        let rows: Vec<TaskMetricRow> = (1..=10)
            .map(|i| row("develop", 0, Some(i * 100), 0, 1))
            .collect();
        let s = aggregate(&rows, 0);
        let d = s.stages.iter().find(|s| s.stage == "develop").unwrap();
        assert_eq!(d.p50_ms, 500);
        assert_eq!(d.p90_ms, 900);
        assert_eq!(d.retry_count, 0);
        assert_eq!(d.fallback_count, 0);
    }

    #[test]
    fn aggregate_counts_retries_and_fallbacks() {
        let rows = vec![
            row("develop", 0, Some(100), 0, 1),
            row("develop", 1, Some(200), 0, 2), // retry
            row("develop", 2, Some(300), 1, 3), // retry + fallback
            row("verify", 0, Some(50), 0, 4),
        ];
        let s = aggregate(&rows, 0);
        let d = s.stages.iter().find(|s| s.stage == "develop").unwrap();
        assert_eq!(d.retry_count, 2, "attempt >= 1 means retry");
        assert_eq!(d.fallback_count, 1);
        let v = s.stages.iter().find(|s| s.stage == "verify").unwrap();
        assert_eq!(v.retry_count, 0);
        assert_eq!(v.fallback_count, 0);
    }

    #[test]
    fn aggregate_filters_by_since_ts() {
        let rows = vec![
            row("develop", 0, Some(100), 0, 5), // kept (started_at >= 5)
            row("develop", 0, Some(200), 0, 3), // dropped
        ];
        let s = aggregate(&rows, 5);
        let d = s.stages.iter().find(|s| s.stage == "develop").unwrap();
        // Only the kept row contributes; p50 == 100 (nearest-rank: ceil(0.5*1)=1, idx=0).
        assert_eq!(d.p50_ms, 100);
        assert_eq!(d.p90_ms, 100);
    }

    #[test]
    fn aggregate_handles_empty_durations() {
        // All rows have duration_ms=None -> percentiles are 0, but counts work.
        let rows = vec![
            row("develop", 1, None, 0, 1),
            row("develop", 2, None, 1, 2),
        ];
        let s = aggregate(&rows, 0);
        let d = s.stages.iter().find(|s| s.stage == "develop").unwrap();
        assert_eq!(d.p50_ms, 0);
        assert_eq!(d.p90_ms, 0);
        assert_eq!(d.retry_count, 2);
        assert_eq!(d.fallback_count, 1);
    }

    #[test]
    fn aggregate_for_project_filters_by_task_id_prefix() {
        let rows = vec![
            row("develop", 0, Some(100), 0, 1), // TAPD-1:develop
            row("verify", 0, Some(200), 0, 2), // TAPD-1:verify
            row("develop", 0, Some(300), 0, 3), // TAPD-2:develop (other project)
        ];
        let s = aggregate_for_project(&rows, "TAPD-1", 0);
        assert_eq!(s.project_key.as_deref(), Some("TAPD-1"));
        let d = s.stages.iter().find(|s| s.stage == "develop").unwrap();
        assert_eq!(d.p50_ms, 100, "only the TAPD-1 develop row counts");
        let v = s.stages.iter().find(|s| s.stage == "verify").unwrap();
        assert_eq!(v.p50_ms, 200);
        // TAPD-2 develop was filtered out.
        assert!(s.stages.iter().find(|s| s.stage == "develop" && s.p50_ms == 300).is_none());
    }

    #[test]
    fn percentile_nearest_rank_picks_ceiling() {
        // sorted [10, 20, 30, 40, 50], n=5
        // p50 ceil(0.5*5)=3, idx=2 -> 30
        // p90 ceil(0.9*5)=5, idx=4 -> 50
        // p10 ceil(0.1*5)=1, idx=0 -> 10
        let s = vec![10, 20, 30, 40, 50];
        assert_eq!(percentile(&s, 0.50), 30);
        assert_eq!(percentile(&s, 0.90), 50);
        assert_eq!(percentile(&s, 0.10), 10);
        assert_eq!(percentile(&[], 0.50), 0);
    }
}
