# TAPD Workbench Pipeline v2 — M3 Plan (Observability)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add v2 Theme 4 (Observability) per `docs/superpowers/specs/2026-09-03-tapd-workbench-v2-design.md` §9. Builds on M2 (tagged `v2-m2-control`). Purely additive: events + on-demand pull, no new event-log table.

**Architecture:**
- `workbench::metrics` aggregates `workbench_task_metrics` (table from M1.5) into p50 / p90 / retry-count summaries.
- `workbench::mr_comments` is a new module: HTTP endpoint + SQLite table (table from M1.5) + dispatcher re-trigger on unconsumed comment.
- `x.ai/workbench/replay` ext method already stubbed in M1.6 (transition fn `next_after_replay`); M3 wires the dispatcher side.
- `x.ai/workbench/timeline` + `x.ai/workbench/metrics` ext methods expose reads.
- `bin/configure_gitlab_webhook` CLI helper configures the GitLab side-channel that POSTs to `x.ai/workbench/mr_comment`.
- Front-end: `MetricsStrip` on `WorkbenchHeader` + `TimelineDrawer` opens from `TaskDetailDrawer`.

**Tech Stack:** Same as v2 M1/M2.

---

## File Structure (M3-specific)

Refer to `docs/superpowers/plans/2026-09-03-tapd-workbench-v2.md` §File Structure Overview for the full v2 layout. M3 introduces / modifies:

**NEW backend:**
- `crates/codegen/xai-grok-shell/src/workbench/metrics.rs`
- `crates/codegen/xai-grok-shell/src/workbench/mr_comments.rs`
- `crates/codegen/xai-grok-shell/src/bin/configure_gitlab_webhook.rs`

**MODIFIED backend:**
- `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs` (call `replay` on ext method; check unconsumed comments on each dispatch sweep)
- `crates/codegen/xai-grok-shell/src/extensions/tapd.rs` (register `x.ai/workbench/{replay,timeline,metrics,mr_comment}` ext methods + HTTP handler for mr_comment webhook)
- `crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs` (wire `x.ai/workbench/mr_comment` notification handler)

**NEW frontend:**
- `web/src/features/workbench/MetricsStrip.tsx` + `.test.tsx`
- `web/src/features/workbench/TimelineDrawer.tsx` + `.test.tsx`

**MODIFIED frontend:**
- `web/src/features/workbench/WorkbenchHeader.tsx` (embed MetricsStrip)
- `web/src/features/workbench/TaskDetailDrawer.tsx` (add Timeline button → opens TimelineDrawer)
- `web/src/features/settings/components/grokConfigSchema.ts` (configure_gitlab_webhook setting if needed)

**NEW integration tests:**
- `crates/codegen/xai-grok-shell/tests/mr_comment_e2e.rs`
- `crates/codegen/xai-grok-shell/tests/replay_e2e.rs`
- `crates/codegen/xai-grok-shell/tests/metrics_e2e.rs`

---

## Conventions

Inherits v2 plan conventions (TDD, GPL-3.0-only, one file = one responsibility, commits per task).

M3-specific:
- `metrics` reads are on-demand; no background poll. The dispatcher only triggers a fresh `x.ai/workbench/metrics` event when a stage transitions (cheap to emit).
- `mr_comments` re-trigger consumes a comment on the FIRST Adjudicate re-run after the comment arrives (one-shot). The audit log is in `workbench_mr_comments` (not deleted).
- `replay` is destructive: prior artifacts moved to `.workbench/stages/<n>-<stage>-attempt-<old>.md` before the new run starts (v1 spec §8 convention). The UI must warn before invoking.
- `timeline` is computed on-demand from `workbench_task_metrics` joined with `workbench_task_state` (no new event-log table).

---

## Phase 1 — metrics aggregator

### Task M3.1: Aggregator over `workbench_task_metrics`.

- [ ] **Step 1:** Define `pub struct StageAggregate { stage: String, p50_ms: i64, p90_ms: i64, retry_count: i64 }`.
- [ ] **Step 2:** Implement `metrics::aggregate(project_key: Option<&str>, since_ts: i64, store: &TapdStore) -> anyhow::Result<MetricsSummary>` where `MetricsSummary { totals: Totals { done, blocked, dead }, stages: Vec<StageAggregate> }`.
- [ ] **Step 3:** p50 / p90 computed by collecting `duration_ms` rows per stage, sorting, picking the relevant percentile (interpolate between two values if needed).
- [ ] **Step 4:** Tests: `aggregate_with_no_rows_returns_zero`, `aggregate_p50_p90_single_stage_two_durations`, `aggregate_filters_by_project`.
- [ ] **Step 5:** Commit: `feat(workbench v2): metrics aggregator over workbench_task_metrics`.

---

## Phase 2 — x.ai/workbench/metrics ext

### Task M3.2: Wire `x.ai/workbench/metrics` ext method.

- [ ] **Step 1:** In `extensions/tapd.rs`, register handler for `x.ai/workbench/metrics` with request `{ project_key?: String, since_ts?: i64 }`.
- [ ] **Step 2:** Handler calls `metrics::aggregate(project_key, since_ts, &tapd_store)` and returns the `MetricsSummary` JSON shape from spec §9.2.2.
- [ ] **Step 3:** Tests: `metrics_ext_returns_aggregates_for_known_project`, `metrics_ext_returns_zeros_when_no_data`.
- [ ] **Step 4:** Commit: `feat(workbench v2): x.ai/workbench/metrics ext method`.

---

## Phase 3 — MetricsStrip component

### Task M3.3: Front-end bar component.

- [ ] **Step 1:** Component receives `MetricsSummary` as prop. Renders per-stage rows: stage name + p50 bar + p90 bar + retry count badge.
- [ ] **Step 2:** Subscribe to `x.ai/workbench/metrics` notification via `useSyncExternalStore`. On any task stage transition, refetch.
- [ ] **Step 3:** Tests: render with mock data; assert bar widths reflect p50 / p90.
- [ ] **Step 4:** Commit: `feat(web workbench v2): MetricsStrip component on WorkbenchHeader`.

---

## Phase 4 — x.ai/workbench/timeline ext + TimelineDrawer

### Task M3.4: Read-only event log + UI scrubber.

- [ ] **Step 1:** In `extensions/tapd.rs`, register handler for `x.ai/workbench/timeline` with `{ tapd_id: String }`.
- [ ] **Step 2:** Handler queries `workbench_task_metrics` for `tapd_id` + parses `workbench_task_state` history; assembles events `[ {ts, kind, stage?, attempt?, model?, verdict?, mr_url?} ]` and returns JSON.
- [ ] **Step 3:** Front-end `TimelineDrawer`: horizontal scrollable strip; each event is a dot + tooltip; click an event to expand details.
- [ ] **Step 4:** Open from `TaskDetailDrawer` "Timeline" button.
- [ ] **Step 5:** Tests: `timeline_ext_returns_events_for_known_task`, `timeline_ext_returns_empty_for_unknown_task`; component test with sample event array.
- [ ] **Step 6:** Commit: `feat(workbench v2): x.ai/workbench/timeline ext + TimelineDrawer`.

---

## Phase 5 — mr_comments module

### Task M3.5: Inbound HTTP endpoint + dispatcher re-trigger.

- [ ] **Step 1:** `mr_comments::handler(store, body)` extracts `{ tapd_id, author, body, mr_url }` from POST body and calls `store.insert_mr_comment(...)`.
- [ ] **Step 2:** Register HTTP route on the same axum router as `x.ai/workbench/*` ext methods: `POST /x.ai/workbench/mr_comment` (NOT under WebSocket — GitLab webhook uses HTTP).
- [ ] **Step 3:** Handler emits `x.ai/workbench/mr_comment` notification after insert.
- [ ] **Step 4:** In `dispatcher::dispatch_pending`: for each pending task, check `store.unconsumed_mr_comments(tapd_id)`; if non-empty, route the task through `Adjudicate` re-run with the comment body appended to `1-design.md` under `## External comment`. After re-trigger, call `store.mark_mr_comment_consumed(id)`.
- [ ] **Step 5:** Tests: `mr_comments::handler_inserts_row`, `dispatcher_consumes_unconsumed_comment_on_next_sweep`.
- [ ] **Step 6:** Commit: `feat(workbench v2): mr_comments module with HTTP endpoint + dispatcher re-trigger`.

---

## Phase 6 — replay dispatcher + ext method

### Task M3.6: Wire the dispatcher side of replay (transition fn `next_after_replay` already exists from M1.6).

- [ ] **Step 1:** In `extensions/tapd.rs`, register handler for `x.ai/workbench/replay` with `{ tapd_id, replay_from: Stage, reason?: String, pre_approved?: bool }`.
- [ ] **Step 2:** Handler loads existing `1-design.md` + `2-adjudicate.md` as in-context; sets `workbench_state = "running:<replay_from>:0"`; moves prior artifacts to `<n>-<stage>-attempt-<old>.md`; calls `orchestrator::drive_task` with `start_stage = replay_from`.
- [ ] **Step 3:** When `pre_approved: true` and `replay_from == Adjudicate`, skip the Adjudicate stage and route to Develop.
- [ ] **Step 4:** Tests: `replay_ext_moves_prior_artifacts`, `replay_with_pre_approved_skips_adjudicate`.
- [ ] **Step 5:** Commit: `feat(workbench v2): x.ai/workbench/replay dispatcher + ext method`.

---

## Phase 7 — configure_gitlab_webhook CLI

### Task M3.7: Standalone CLI helper to point GitLab at the local mr_comment endpoint.

- [ ] **Step 1:** New binary: `crates/codegen/xai-grok-shell/src/bin/configure_gitlab_webhook.rs`.
- [ ] **Step 2:** CLI args: `--gitlab-url <URL> --project-id <ID> --token-env <ENV_VAR_NAME> --local-secret <SECRET>`. Reads token from env var, POSTs `PUT /projects/:id/hooks` with `{ url: "http://localhost:<port>/x.ai/workbench/mr_comment?secret=<local_secret>", mr_events: true, note_events: false }`.
- [ ] **Step 3:** Print success / error to stderr; exit 1 on non-201 response.
- [ ] **Step 4:** Tests: live test would need a mock GitLab; for v2 unit-test the request-body builder only (`build_hook_payload`).
- [ ] **Step 5:** Commit: `feat(workbench v2): configure_gitlab_webhook CLI helper`.

---

## Phase 8 — M3 e2e integration

### Task M3.8: Three new e2e test files.

- [ ] **Step 1:** `mr_comment_e2e.rs` — POST a fake GitLab comment to the HTTP handler; assert row inserted in `workbench_mr_comments`; trigger dispatcher sweep; assert comment consumed + Adjudicate re-ran.
- [ ] **Step 2:** `replay_e2e.rs` — drive a task to fail Develop twice; call `x.ai/workbench/replay` with `replay_from: Develop`; assert `attempt` resets to 0 and new artifacts replace old (prior artifacts moved to `*-attempt-1.md`).
- [ ] **Step 3:** `metrics_e2e.rs` — run a few tasks through Develop → Verify; call `x.ai/workbench/metrics`; assert `stages[0].p50_ms > 0`.
- [ ] **Step 4:** Run all 3 e2e; commit: `test(workbench v2): mr_comment / replay / metrics e2e integration`.

---

## M3 completion gate

After all 8 M3 tasks land, M3 is **done**. v2 is complete: reliability (M1) + control (M2) + observability (M3). Before declaring v2 done:

- [ ] `cargo test -p xai-grok-shell --lib` passes (no regression in any v1 / M1 / M2 test)
- [ ] All e2e binaries pass: `workbench_v1_state_compat`, `workbench_orchestrator_e2e`, `workbench_pipeline_e2e`, `recovery_e2e`, `intervention_e2e`, `cron_e2e`, `dispatcher_concurrency_e2e`, `mr_comment_e2e`, `replay_e2e`, `metrics_e2e`
- [ ] `cargo check -p xai-grok-shell` passes
- [ ] `npm run typecheck && npm run test:run 2>&1 | tail -5 && npm run build` all pass
- [ ] Tag the commit: `git tag v2-m3-observable`
- [ ] Then write the "Stub → Real LLM" sub-plan (the ~9-10 day effort to actually run development end-to-end).

**Do not declare v2 done if any test fails.**

---

# v2 (M1 + M2 + M3) is fully done when this gate is passed.
# What remains AFTER v2 ships is the deferred "Stub → Real LLM" work — see
# session transcript 2026-09-07 for the ~9-10 day scope and the v3 spec.
