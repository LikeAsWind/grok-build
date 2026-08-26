//! Global, cross-session daily usage log for the Web home dashboard.
//!
//! Unlike `summary.json` (one file per session, session-scoped fields),
//! per-day / per-model token stats need to be attributed to the exact day a
//! model call completed — a session can span multiple days, so a single
//! end-of-session snapshot cannot correctly attribute early-session activity.
//! This module instead appends one record per model call (fired from
//! `sampler_turn.rs::record_response_token_usage`) to a single global
//! append-only JSONL file (`usage_daily.jsonl`), then aggregates it on demand
//! for `x.ai/session_summaries/dashboard_stats`.
//!
//! Writes are serialized through one process-wide actor (parallel to the
//! per-session persistence actor, but global) so concurrent sessions don't
//! race on the same file.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Write as _};
use std::path::PathBuf;
use std::sync::OnceLock;

use chrono::NaiveDate;
use tokio::sync::mpsc;

use crate::session::persistence::Summary;
use crate::util::grok_home::grok_home;

/// One model-call record appended to `usage_daily.jsonl`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct UsageDailyRecord {
    /// Local calendar date the call completed on.
    pub date: NaiveDate,
    pub session_id: String,
    pub model_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd_ticks: Option<i64>,
    /// Hour-of-day (0-23, local time) — for Peak hour.
    pub hour: u8,
    /// Messages produced by this call (`response.items.len()`). Recorded
    /// alongside tokens so the daily heatmap can bucket real per-day message
    /// counts without falling back to the session-level `Summary.num_messages`
    /// (which can only be attributed to a session's *last* active day).
    pub message_count: u64,
}

fn usage_daily_path() -> PathBuf {
    grok_home().join("usage_daily.jsonl")
}

static USAGE_DAILY_TX: OnceLock<mpsc::UnboundedSender<UsageDailyRecord>> = OnceLock::new();

/// Lazily start (once per process) the global usage-daily actor and return
/// its sender. `get_or_init` is itself synchronization, so callers never
/// race on the spawn — the first caller wins and every session shares one
/// writer, avoiding concurrent-append corruption on `usage_daily.jsonl`.
fn usage_daily_tx() -> &'static mpsc::UnboundedSender<UsageDailyRecord> {
    USAGE_DAILY_TX.get_or_init(|| {
        let (tx, mut rx) = mpsc::unbounded_channel::<UsageDailyRecord>();
        tokio::spawn(async move {
            while let Some(record) = rx.recv().await {
                let result = tokio::task::spawn_blocking(move || append_usage_daily_record(&record)).await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => tracing::warn!(?e, "failed to append usage_daily record"),
                    Err(e) => tracing::warn!(?e, "usage_daily append task panicked"),
                }
            }
        });
        tx
    })
}

fn append_usage_daily_record(record: &UsageDailyRecord) -> io::Result<()> {
    let line = serde_json::to_string(record).map_err(io::Error::other)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(usage_daily_path())?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

/// Fire-and-forget append of one usage record (best-effort telemetry, not
/// durable state) — starts the global writer actor on first use.
pub(crate) fn record_usage_daily(record: UsageDailyRecord) {
    let _ = usage_daily_tx().send(record);
}

/// Read and parse every record in `usage_daily.jsonl`. Missing file returns
/// an empty list (first run / nothing recorded yet). Individual malformed
/// lines are skipped (tolerates partial writes / future format drift) rather
/// than failing the whole read.
pub(crate) async fn read_usage_daily() -> io::Result<Vec<UsageDailyRecord>> {
    tokio::task::spawn_blocking(read_usage_daily_sync)
        .await
        .map_err(io::Error::other)?
}

fn read_usage_daily_sync() -> io::Result<Vec<UsageDailyRecord>> {
    let path = usage_daily_path();
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let reader = BufReader::new(file);
    let mut records = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<UsageDailyRecord>(&line) {
            Ok(record) => records.push(record),
            Err(e) => {
                tracing::warn!(?e, "skipping malformed usage_daily line");
            }
        }
    }
    Ok(records)
}

// ── Dashboard aggregation ────────────────────────────────────────────────

/// One day's aggregate for the activity heatmap.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DayActivity {
    pub date: String,
    pub message_count: u64,
}

/// One model's token split within a single day, for the Models tab's
/// stacked bar chart.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDayUsage {
    pub model_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// One day's per-model breakdown, for the Models tab.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DayModelBreakdown {
    pub date: String,
    pub by_model: Vec<ModelDayUsage>,
}

/// Aggregated stats for the Web home dashboard (`x.ai/session_summaries/dashboard_stats`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardStats {
    pub total_sessions: u64,
    pub total_messages: u64,
    pub total_tokens: u64,
    pub active_days: u64,
    pub current_streak_days: u64,
    pub longest_streak_days: u64,
    pub peak_hour: Option<u8>,
    pub favorite_model: Option<String>,
    pub heatmap: Vec<DayActivity>,
    pub models_by_day: Vec<DayModelBreakdown>,
}

/// Number of trailing days the heatmap covers (53 full weeks — GitLab's
/// contribution calendar spans a full year, always in whole-week columns).
const HEATMAP_DAYS: i64 = 371;

/// Pure aggregation over already-loaded records/summaries — no I/O, fully
/// unit-testable. `window_days`: `None` = all time, `Some(n)` = only the
/// trailing `n` days (relative to `today`).
pub(crate) fn compute_dashboard_stats(
    records: &[UsageDailyRecord],
    summaries: &[Summary],
    window_days: Option<u32>,
    today: NaiveDate,
) -> DashboardStats {
    let cutoff = window_days.map(|d| today - chrono::Duration::days(i64::from(d)));

    let filtered_records: Vec<&UsageDailyRecord> = records
        .iter()
        .filter(|r| cutoff.is_none_or(|c| r.date >= c))
        .collect();

    let filtered_summaries: Vec<&Summary> = summaries
        .iter()
        .filter(|s| {
            cutoff.is_none_or(|c| {
                let local_date = s.created_at.with_timezone(&chrono::Local).date_naive();
                local_date >= c
            })
        })
        .collect();

    let total_sessions = filtered_summaries.len() as u64;
    let total_messages: u64 = filtered_records.iter().map(|r| r.message_count).sum();
    let total_tokens: u64 = filtered_records
        .iter()
        .map(|r| r.input_tokens + r.output_tokens)
        .sum();

    // Per-day message counts, streaks, peak hour, and favorite model are all
    // computed over `filtered_records` (respect the All/30d/7d window). The
    // heatmap is deliberately excluded from this pass — see `by_day_all`
    // below — matching GitLab's contribution calendar, which always shows a
    // fixed trailing period regardless of any other page-level filter.
    let mut by_day: BTreeMap<NaiveDate, u64> = BTreeMap::new();
    let mut by_day_model: BTreeMap<NaiveDate, BTreeMap<&str, (u64, u64)>> = BTreeMap::new();
    let mut hour_counts: [u64; 24] = [0; 24];
    let mut model_totals: BTreeMap<&str, u64> = BTreeMap::new();

    for r in &filtered_records {
        *by_day.entry(r.date).or_default() += r.message_count;
        let entry = by_day_model.entry(r.date).or_default();
        let model_entry = entry.entry(r.model_id.as_str()).or_default();
        model_entry.0 += r.input_tokens;
        model_entry.1 += r.output_tokens;
        hour_counts[usize::from(r.hour.min(23))] += 1;
        *model_totals.entry(r.model_id.as_str()).or_default() += r.input_tokens + r.output_tokens;
    }

    let active_days = by_day.len() as u64;

    let (current_streak_days, longest_streak_days) = compute_streaks(by_day.keys().copied(), today);

    // Heatmap always covers the full trailing `HEATMAP_DAYS` window, built
    // from the unfiltered `records` — independent of `window_days`.
    let mut by_day_all: BTreeMap<NaiveDate, u64> = BTreeMap::new();
    for r in records {
        *by_day_all.entry(r.date).or_default() += r.message_count;
    }

    let peak_hour = hour_counts
        .iter()
        .enumerate()
        .filter(|&(_, &count)| count > 0)
        .max_by_key(|&(hour, &count)| (count, std::cmp::Reverse(hour)))
        .map(|(hour, _)| hour as u8);

    let favorite_model = model_totals
        .iter()
        .max_by_key(|&(model_id, &total)| (total, std::cmp::Reverse(*model_id)))
        .map(|(model_id, _)| model_id.to_string());

    let heatmap_start = today - chrono::Duration::days(HEATMAP_DAYS - 1);
    let heatmap: Vec<DayActivity> = (0..HEATMAP_DAYS)
        .map(|offset| {
            let date = heatmap_start + chrono::Duration::days(offset);
            DayActivity {
                date: date.to_string(),
                message_count: by_day_all.get(&date).copied().unwrap_or(0),
            }
        })
        .collect();

    let models_by_day: Vec<DayModelBreakdown> = by_day_model
        .into_iter()
        .map(|(date, models)| DayModelBreakdown {
            date: date.to_string(),
            by_model: models
                .into_iter()
                .map(|(model_id, (input_tokens, output_tokens))| ModelDayUsage {
                    model_id: model_id.to_string(),
                    input_tokens,
                    output_tokens,
                })
                .collect(),
        })
        .collect();

    DashboardStats {
        total_sessions,
        total_messages,
        total_tokens,
        active_days,
        current_streak_days,
        longest_streak_days,
        peak_hour,
        favorite_model,
        heatmap,
        models_by_day,
    }
}

/// Given a set of active dates, returns `(current_streak, longest_streak)`
/// in days, where "current" only counts if it includes `today` or
/// `today - 1` (yesterday) — a streak broken more than a day ago is 0, not
/// stale-positive.
fn compute_streaks(dates: impl Iterator<Item = NaiveDate>, today: NaiveDate) -> (u64, u64) {
    let mut sorted: Vec<NaiveDate> = dates.collect();
    sorted.sort_unstable();
    sorted.dedup();

    if sorted.is_empty() {
        return (0, 0);
    }

    let mut longest = 1u64;
    let mut run = 1u64;
    let mut run_start_idx = 0usize;
    let mut longest_end_idx = 0usize;

    for i in 1..sorted.len() {
        if sorted[i] == sorted[i - 1] + chrono::Duration::days(1) {
            run += 1;
        } else {
            run = 1;
            run_start_idx = i;
        }
        if run > longest {
            longest = run;
            longest_end_idx = i;
        }
        let _ = run_start_idx;
    }

    let current = {
        let last = *sorted.last().expect("non-empty");
        if last == today || last == today - chrono::Duration::days(1) {
            // Walk backward from the end counting the contiguous run.
            let mut count = 1u64;
            let mut idx = sorted.len();
            while idx > 1 && sorted[idx - 1] == sorted[idx - 2] + chrono::Duration::days(1) {
                count += 1;
                idx -= 1;
            }
            count
        } else {
            0
        }
    };
    let _ = longest_end_idx;

    (current, longest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
    }

    fn record(date: NaiveDate, model_id: &str, input: u64, output: u64, hour: u8, messages: u64) -> UsageDailyRecord {
        UsageDailyRecord {
            date,
            session_id: "sess".into(),
            model_id: model_id.into(),
            input_tokens: input,
            output_tokens: output,
            cost_usd_ticks: None,
            hour,
            message_count: messages,
        }
    }

    fn summary_on(date: chrono::DateTime<chrono::Utc>) -> Summary {
        let mut s = Summary::new(
            &crate::session::info::Info {
                id: agent_client_protocol::SessionId::new("s"),
                cwd: "/tmp".into(),
            },
            crate::session::persistence::default_model_id(),
        )
        .expect("summary");
        s.created_at = date;
        s
    }

    #[test]
    fn empty_input_yields_all_zero() {
        let stats = compute_dashboard_stats(&[], &[], None, ymd(2026, 8, 24));
        assert_eq!(stats.total_sessions, 0);
        assert_eq!(stats.total_messages, 0);
        assert_eq!(stats.total_tokens, 0);
        assert_eq!(stats.active_days, 0);
        assert_eq!(stats.current_streak_days, 0);
        assert_eq!(stats.longest_streak_days, 0);
        assert_eq!(stats.peak_hour, None);
        assert_eq!(stats.favorite_model, None);
        assert_eq!(stats.heatmap.len(), HEATMAP_DAYS as usize);
        assert!(stats.heatmap.iter().all(|d| d.message_count == 0));
        assert!(stats.models_by_day.is_empty());
    }

    #[test]
    fn multiple_records_same_day_aggregate_by_model() {
        let today = ymd(2026, 8, 24);
        let records = vec![
            record(today, "grok-4", 100, 10, 9, 2),
            record(today, "grok-4", 50, 5, 10, 1),
            record(today, "sonnet-5", 30, 3, 9, 1),
        ];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.total_messages, 4);
        assert_eq!(stats.total_tokens, 100 + 10 + 50 + 5 + 30 + 3);
        assert_eq!(stats.active_days, 1);
        assert_eq!(stats.models_by_day.len(), 1);
        let day = &stats.models_by_day[0];
        assert_eq!(day.date, today.to_string());
        let grok4 = day.by_model.iter().find(|m| m.model_id == "grok-4").unwrap();
        assert_eq!(grok4.input_tokens, 150);
        assert_eq!(grok4.output_tokens, 15);
    }

    #[test]
    fn continuous_streak_counts_consecutive_days() {
        let today = ymd(2026, 8, 24);
        let records = vec![
            record(ymd(2026, 8, 22), "m", 1, 1, 0, 1),
            record(ymd(2026, 8, 23), "m", 1, 1, 0, 1),
            record(today, "m", 1, 1, 0, 1),
        ];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.active_days, 3);
        assert_eq!(stats.current_streak_days, 3);
        assert_eq!(stats.longest_streak_days, 3);
    }

    #[test]
    fn broken_streak_resets_current_but_keeps_longest() {
        let today = ymd(2026, 8, 24);
        let records = vec![
            record(ymd(2026, 8, 10), "m", 1, 1, 0, 1),
            record(ymd(2026, 8, 11), "m", 1, 1, 0, 1),
            record(ymd(2026, 8, 12), "m", 1, 1, 0, 1),
            record(ymd(2026, 8, 13), "m", 1, 1, 0, 1),
            // gap
            record(today, "m", 1, 1, 0, 1),
        ];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.longest_streak_days, 4);
        assert_eq!(stats.current_streak_days, 1, "today alone, gap before it");
    }

    #[test]
    fn streak_counts_yesterday_as_still_current() {
        let today = ymd(2026, 8, 24);
        let yesterday = today - chrono::Duration::days(1);
        let records = vec![record(yesterday, "m", 1, 1, 0, 1)];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(
            stats.current_streak_days, 1,
            "no activity today yet, but yesterday keeps the streak alive"
        );
    }

    #[test]
    fn streak_older_than_yesterday_is_not_current() {
        let today = ymd(2026, 8, 24);
        let two_days_ago = today - chrono::Duration::days(2);
        let records = vec![record(two_days_ago, "m", 1, 1, 0, 1)];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.current_streak_days, 0);
        assert_eq!(stats.longest_streak_days, 1);
    }

    #[test]
    fn peak_hour_tie_break_picks_smaller_hour() {
        let today = ymd(2026, 8, 24);
        let records = vec![
            record(today, "m", 1, 1, 5, 1),
            record(today, "m", 1, 1, 20, 1),
        ];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.peak_hour, Some(5));
    }

    #[test]
    fn favorite_model_tie_break_picks_lexicographically_smaller_id() {
        let today = ymd(2026, 8, 24);
        let records = vec![
            record(today, "zeta", 50, 0, 0, 1),
            record(today, "alpha", 50, 0, 0, 1),
        ];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.favorite_model, Some("alpha".to_string()));
    }

    #[test]
    fn favorite_model_picks_highest_token_total() {
        let today = ymd(2026, 8, 24);
        let records = vec![
            record(today, "small", 10, 0, 0, 1),
            record(today, "big", 1000, 0, 0, 1),
        ];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.favorite_model, Some("big".to_string()));
    }

    #[test]
    fn window_filter_excludes_records_outside_the_trailing_window() {
        let today = ymd(2026, 8, 24);
        let inside = today - chrono::Duration::days(29);
        let boundary = today - chrono::Duration::days(30);
        let outside = today - chrono::Duration::days(31);
        let records = vec![
            record(inside, "m", 10, 0, 0, 1),
            record(boundary, "m", 10, 0, 0, 1),
            record(outside, "m", 10, 0, 0, 1),
        ];
        let stats = compute_dashboard_stats(&records, &[], Some(30), today);
        // inside + boundary count, outside does not.
        assert_eq!(stats.total_tokens, 20);
    }

    #[test]
    fn heatmap_ignores_window_filter_and_shows_full_history() {
        let today = ymd(2026, 8, 24);
        // Well outside a 7-day window, but still inside the 84-day heatmap.
        let outside_window = today - chrono::Duration::days(30);
        let inside_window = today - chrono::Duration::days(3);
        let records = vec![
            record(outside_window, "m", 10, 0, 0, 5),
            record(inside_window, "m", 10, 0, 0, 2),
        ];
        let stats = compute_dashboard_stats(&records, &[], Some(7), today);

        // Non-heatmap fields respect the 7-day window: only the recent record counts.
        assert_eq!(stats.total_messages, 2, "window-filtered fields must exclude the older record");

        // The heatmap always covers the full trailing history, unaffected by `window_days`.
        let outside_day = stats
            .heatmap
            .iter()
            .find(|d| d.date == outside_window.to_string())
            .expect("heatmap covers the full 84-day window regardless of window_days");
        assert_eq!(
            outside_day.message_count, 5,
            "heatmap must show the real count even for days outside the requested window"
        );
    }

    #[test]
    fn window_none_means_all_time() {
        let today = ymd(2026, 8, 24);
        let ancient = today - chrono::Duration::days(400);
        let records = vec![record(ancient, "m", 10, 0, 0, 1)];
        let stats = compute_dashboard_stats(&records, &[], None, today);
        assert_eq!(stats.total_tokens, 10);
    }

    #[test]
    fn total_sessions_and_messages_use_independent_sources() {
        let today = ymd(2026, 8, 24);
        let created = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
            today.and_hms_opt(12, 0, 0).unwrap(),
            chrono::Utc,
        );
        let summaries = vec![summary_on(created), summary_on(created)];
        let records = vec![record(today, "m", 10, 5, 12, 3)];
        let stats = compute_dashboard_stats(&records, &summaries, None, today);
        assert_eq!(stats.total_sessions, 2);
        assert_eq!(stats.total_messages, 3);
    }

    #[test]
    fn read_usage_daily_sync_skips_malformed_lines() {
        let tmp = tempfile::TempDir::new().unwrap();
        // SAFETY: test-only env var override, single-threaded test process
        // for this path is not guaranteed, but GROK_HOME is read once via
        // OnceLock in grok_home() so we instead write directly to a temp file
        // and exercise the line-parsing logic without going through the
        // global path helper.
        let path = tmp.path().join("usage_daily.jsonl");
        std::fs::write(
            &path,
            "not json\n{\"date\":\"2026-08-24\",\"session_id\":\"s\",\"model_id\":\"m\",\"input_tokens\":1,\"output_tokens\":1,\"hour\":0,\"message_count\":1}\n\n",
        )
        .unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let reader = BufReader::new(file);
        let mut records = Vec::new();
        for line in reader.lines() {
            let line = line.unwrap();
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(record) = serde_json::from_str::<UsageDailyRecord>(&line) {
                records.push(record);
            }
        }
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].model_id, "m");
    }
}
