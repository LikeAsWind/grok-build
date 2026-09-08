//! End-to-end test for the v2 §9.2.2 metrics path.
//!
//! Round-trips rows through `TapdStore::record_task_metric` (DAO) and then
//! `metrics::aggregate` (pure aggregator). Verifies that the store and the
//! aggregator agree on percentiles + retry/fallback counts.
use xai_grok_shell::tapd::store::TapdStore;
use xai_grok_shell::workbench::metrics::{MetricsSummary, aggregate};

fn tmp_store() -> (tempfile::TempDir, TapdStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = TapdStore::new(dir.path().join("wb.sqlite"));
    (dir, store)
}

#[test]
fn record_then_aggregate_round_trip() {
    let (_dir, store) = tmp_store();

    // Three develop-stage rows on two task_ids; one attempt=2 (retry) and
    // one with fallback_used=1.
    store.record_task_metric("TAPD-1", "develop", 0, 1_000, 1_100, "opus-4.1", 0, Some("sess-A")).unwrap();
    store.record_task_metric("TAPD-1", "develop", 1, 2_000, 2_300, "opus-4.1", 0, Some("sess-B")).unwrap();
    store.record_task_metric("TAPD-1", "develop", 2, 3_000, 3_600, "gpt-5", 1, Some("sess-C")).unwrap();
    store.record_task_metric("TAPD-2", "verify", 0, 4_000, 4_050, "opus-4.1", 0, None).unwrap();

    // Pull rows for TAPD-1 only (per-task aggregate).
    let rows = store.task_metrics("TAPD-1").unwrap();
    assert_eq!(rows.len(), 3, "3 develop rows for TAPD-1");

    let summary = aggregate(&rows, 0);
    let develop = summary.stages.iter().find(|s| s.stage == "develop").expect("develop stage");
    // 3 durations: 100ms, 300ms, 600ms. Sorted: [100, 300, 600].
    // p50 nearest-rank: ceil(0.5 * 3) = 2 -> idx 1 -> 300ms.
    // p90 nearest-rank: ceil(0.9 * 3) = 3 -> idx 2 -> 600ms.
    assert_eq!(develop.p50_ms, 300);
    assert_eq!(develop.p90_ms, 600);
    assert_eq!(develop.retry_count, 2, "attempt=1 and attempt=2 are retries");
    assert_eq!(develop.fallback_count, 1, "the gpt-5 row used fallback");

    // sample_size counts all input rows, not just the per-stage ones.
    assert_eq!(summary.totals.sample_size, 3);
}

#[test]
fn aggregate_handles_empty_db() {
    let (_dir, store) = tmp_store();
    let rows = store.task_metrics("nonexistent").unwrap();
    assert!(rows.is_empty());

    let s: MetricsSummary = aggregate(&rows, 0);
    assert_eq!(s.totals.sample_size, 0);
    assert_eq!(s.stages.len(), 0);
}

#[test]
fn upsert_overwrites_same_stage_attempt() {
    let (_dir, store) = tmp_store();
    store.record_task_metric("TAPD-1", "verify", 0, 1_000, 1_100, "opus-4.1", 0, None).unwrap();
    store.record_task_metric("TAPD-1", "verify", 0, 5_000, 5_400, "opus-4.1", 0, None).unwrap();

    let rows = store.task_metrics("TAPD-1").unwrap();
    assert_eq!(rows.len(), 1, "UNIQUE(task_id, stage, attempt) collapses the upsert");
    // The upsert overwrote started_at with 5000 and duration with 400.
    assert_eq!(rows[0].started_at, 5_000);
    assert_eq!(rows[0].duration_ms, Some(400));
}
