# TAPD Workbench Pipeline v2 — M2 Plan (Automation & control + Concurrency)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add v2 Theme 2 (Automation & control) + Theme 3 (Concurrency & routing) per `docs/superpowers/specs/2026-09-03-tapd-workbench-v2-design.md` §7 + §8. Builds on M1 (tagged `v2-m1-reliable`).

**Architecture:** All v2 file structure already laid out in `docs/superpowers/plans/2026-09-03-tapd-workbench-v2.md` File Structure Overview. M2 ships:
- New `workbench::intervention` (CancellationToken registry + pause/resume/cancel ext methods)
- New `workbench::cron` (`~/.grok/cron.yaml` parser + per-minute tick task)
- 3 new `adjudicate_mode` variants in `WorkbenchAdjudicateConfig` (gatekeeper, always_skip, human_pre_approve)
- `submitter::auto_merge_after_create` + `format_mr_title(template)`
- `dispatcher::SlotAccountant` simplified (cross-project parallelism + opt-in `max_concurrent`)
- TAPD status writeback on terminal states (best-effort)
- 3 new front-end components (`PauseDialog`, `ReplayDialog`, `Cron.yaml` editor panel)

**Tech Stack:** Same as v2 M1.

**Dependency note:** M2 task order assumes M1 is merged (M1.9 done, `v2-m1-reliable` tagged). `intervention.rs` is M2.1; everything else depends on it (orchestrator hook in M2.2).

---

## File Structure (M2-specific)

Refer to `docs/superpowers/plans/2026-09-03-tapd-workbench-v2.md` §File Structure Overview for the full v2 layout. M2 introduces / modifies:

**NEW backend:**
- `crates/codegen/xai-grok-shell/src/workbench/intervention.rs`
- `crates/codegen/xai-grok-shell/src/workbench/cron.rs`

**MODIFIED backend:**
- `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs` (SlotAccountant simplification, cron tick spawn, `replay` ext method, mr_comments check on dispatch)
- `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` (intervention token poll at stage boundaries, TAPD status writeback, auto-merge call)
- `crates/codegen/xai-grok-shell/src/workbench/submitter.rs` (`auto_merge_after_create` + `format_mr_title(template)`)
- `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` (`next_after_planner_adjudicate_mode` taking mode param)
- `crates/codegen/xai-grok-shell/src/agent/config.rs` (WorkbenchAdjudicateConfig 4 variants, TapdProjectConfig new fields: `auto_merge`, `max_concurrent`, `mr_title_template`, `tapd_status_on_done`, `tapd_status_on_blocked`)
- `crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs` (spawn cron tick alongside workbench dispatcher)
- `crates/codegen/xai-grok-shell/src/extensions/tapd.rs` (register `x.ai/workbench/pause` / `resume` / `cancel` / `replay`)

**NEW frontend:**
- `web/src/features/workbench/PauseDialog.tsx` + `.test.tsx`
- `web/src/features/workbench/ReplayDialog.tsx` + `.test.tsx`
- `web/src/features/workbench/CronSettingsPanel.tsx` + `.test.tsx`

**MODIFIED frontend:**
- `web/src/features/workbench/WorkbenchHeader.tsx` (Paused badge)
- `web/src/features/workbench/TaskDetailDrawer.tsx` (Pause / Resume / Cancel / Replay buttons)
- `web/src/features/settings/components/grokConfigSchema.ts` (auto_merge, max_concurrent, mr_title_template, adjudicate_mode 4th variant, tapd_status_on_* fields)

**NEW integration tests:**
- `crates/codegen/xai-grok-shell/tests/intervention_e2e.rs`
- `crates/codegen/xai-grok-shell/tests/cron_e2e.rs`
- `crates/codegen/xai-grok-shell/tests/dispatcher_concurrency_e2e.rs`

---

## Conventions

Inherits v2 plan conventions (TDD, GPL-3.0-only, one file = one responsibility, commits per task).

M2-specific:
- All ext method names use `x.ai/workbench/<verb>` snake_case
- Pause / resume / cancel are idempotent (calling pause on a paused task is a no-op, not an error)
- Cron failures log + skip, never crash the tick task
- TAPD status writeback is best-effort: HTTP failure logs `warn!` but does NOT flip the workbench state

---

## Phase 1 — Intervention registry

### Task M2.1: New `workbench

**Files:** Create `crates/codegen/xai-grok-shell/src/workbench/intervention.rs`; modify `workbench/mod.rs` (`pub mod intervention;`) + `extensions/tapd.rs` (register `x.ai/workbench/{pause,resume,cancel}` handlers).

- [ ] **Step 1:** Write 4 failing tests in `intervention::tests`: `pause_sets_token_for_task`, `pause_idempotent_on_already_paused`, `cancel_triggers_token`, `lookup_unknown_task_returns_none`.
- [ ] **Step 2:** Implement `InterventionRegistry` wrapping `dashmap::DashMap<String, CancellationToken>` with `pause(task_id, reason)`, `resume(task_id)`, `cancel(task_id)`, `token(task_id) -> Option<CancellationToken>`.
- [ ] **Step 3:** Register ext method handlers in `extensions/tapd.rs` that call into the registry. Methods return `Ok(())` if the task is unknown (idempotent).
- [ ] **Step 4:** Run `cargo test --lib workbench::intervention` — 4 tests pass.
- [ ] **Step 5:** Commit: `feat(workbench v2): intervention registry with pause/resume/cancel ext methods`.

---

## Phase 2 — Orchestrator integration

### Task M2.2: Orchestrator consults `intervention

**Files:** Modify `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs`.

- [ ] **Step 1:** Refactor `drive_task` to accept `Arc<InterventionRegistry>`.
- [ ] **Step 2:** Between each `next_after_*` transition, call `registry.token(&inputs.tapd_id)`. If `Some(token)` and `token.is_cancelled()`, transition to `Dead { reason: "user_cancelled" }` and return early.
- [ ] **Step 3:** Inside `stub_coder` / `stub_planner` (and any future real LLM call), wrap the await loop in `tokio::select!` with the cancellation token; on cancel, send `acp::Cancel` to the child session handle.
- [ ] **Step 4:** Add 1 integration test in `orchestrator::tests::user_cancel_during_develop_routes_to_dead` (registers intervention, calls `drive_task` with a tokio task that cancels mid-loop, asserts final state).
- [ ] **Step 5:** Run `cargo test --lib workbench::orchestrator` — all existing + 1 new pass.
- [ ] **Step 6:** Commit: `feat(workbench v2): orchestrator respects pause/cancel between stages`.

---

## Phase 3 — Pause / Replay dialogs

### Task M2.3: Front-end `PauseDialog` (reason input) + `ReplayDialog` (stage picker). `WorkbenchHeader` shows a "Paused" badge derived from notification. `TaskDetailDrawer` adds Pause/Resume/Cancel/Replay buttons.

**Files:** Create `web/src/features/workbench/PauseDialog.tsx` + `.test.tsx` + `ReplayDialog.tsx` + `.test.tsx`; modify `WorkbenchHeader.tsx` + `TaskDetailDrawer.tsx`.

- [ ] **Step 1:** `PauseDialog`: modal with reason Textarea + "Pause" / "Cancel" buttons. Submits via `acpBridge.extRequest("x.ai/workbench/pause", { tapd_id, reason })`. Vitest covers open/close + submit + reason passthrough.
- [ ] **Step 2:** `ReplayDialog`: stage picker (6 stages from spec) + reason Textarea. Submits `x.ai/workbench/replay` with `replay_from`. Vitest covers stage selection + submit.
- [ ] **Step 3:** `WorkbenchHeader`: subscribe to `x.ai/workbench/stage` notifications; show "Paused" badge when `stage === "paused"`.
- [ ] **Step 4:** `TaskDetailDrawer`: add Pause/Resume/Cancel/Replay buttons; each calls the corresponding ext method; buttons hidden when state is terminal.
- [ ] **Step 5:** Run `npm run typecheck && npm run test:run 2>&1 | tail -10 && npm run build` — typecheck clean, all tests pass, build OK.
- [ ] **Step 6:** Commit: `feat(web workbench v2): PauseDialog + ReplayDialog + WorkbenchHeader paused badge`.

---

## Phase 4 — auto-merge

### Task M2.4: Per-project `auto_merge

**Files:** Modify `crates/codegen/xai-grok-shell/src/workbench/submitter.rs` + `crates/codegen/xai-grok-shell/src/agent/config.rs` (TapdProjectConfig `auto_merge` field).

- [ ] **Step 1:** Add `auto_merge: bool` field to `TapdProjectConfig` with `#[serde(default)]`; default `false`.
- [ ] **Step 2:** In `submitter::create_mr`: after the 201 response, if `cfg.auto_merge` is true, check `GET /projects/:id` for `merge_when_pipeline_succeeds`; if enabled, call `PUT /merge_requests/:iid/merge` with the squash + auto-merge params.
- [ ] **Step 3:** New helper `submitter::poll_merge_status(mr_url, max_wait_secs) -> MergeOutcome::{Merged, PipelineFailed, Conflict}` returning one of 3 enum variants.
- [ ] **Step 4:** Map: `Merged` → orchestrator transitions to `Done` (existing path); `PipelineFailed` or `Conflict` → `BlockedForHuman { reason: "auto_merge_blocked" }`.
- [ ] **Step 5:** Tests: `submitter::auto_merge_disabled_by_default`, `auto_merge_calls_second_endpoint_when_project_opt_in`, `merge_status_polling_classifies_cannot_be_merged_as_blocked`.
- [ ] **Step 6:** Run `cargo test --lib workbench::submitter` — 3 new + existing tests pass.
- [ ] **Step 7:** Commit: `feat(workbench v2): per-project auto_merge with pipeline-succeeds check`.

---

## Phase 5 — Cron tick

### Task M2.5: New `workbench

**Files:** Create `crates/codegen/xai-grok-shell/src/workbench/cron.rs`; modify `crates/codegen/xai-grok-shell/src/workbench/mod.rs` + `crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs` (spawn tick alongside dispatcher).

- [ ] **Step 1:** Define `pub struct CronSchedule { cron: String, tapd_status_filter: Vec<String>, priority_filter: Vec<String> }` + `pub struct CronConfig { projects: Vec<ProjectSchedule> }`.
- [ ] **Step 2:** Parse via `serde_yaml` (already a transitive dep via TAPD sync). Schema documented inline.
- [ ] **Step 3:** Implement `matches_now(schedule: &CronSchedule, now: chrono::DateTime<Utc>) -> bool` using the `cron` crate (already in workspace deps).
- [ ] **Step 4:** Spawn a `tokio::spawn` loop in `agent_ops::spawn_workbench_dispatcher` that sleeps 60s then calls `cron::tick(&config, &dispatcher)`. On error, log `warn!` and continue.
- [ ] **Step 5:** Tests: `cron::matches_now_respects_minute_field`, `cron::matches_now_handles_wildcard`, `parse_yaml_fails_loudly_on_bad_cron_expr`.
- [ ] **Step 6:** Run `cargo test --lib workbench::cron` — 3 tests pass.
- [ ] **Step 7:** Commit: `feat(workbench v2): cron tick reads ~/.grok/cron.yaml every minute`.

---

## Phase 6 — Cron settings panel

### Task M2.6: Front-end `CronSettingsPanel` reads / writes `~/.grok/cron.yaml`. Edits per-project cron expression + tapd_status_filter + priority_filter. Uses existing `grokConfig.ts

**Files:** Create `web/src/features/workbench/CronSettingsPanel.tsx` + `.test.tsx`.

- [ ] **Step 1:** Component: list of project entries; each row has cron-expression input, tapd_status_filter multi-select, priority_filter multi-select. "Add project" button at top, "Save" at bottom.
- [ ] **Step 2:** Backend endpoint: extend `xai-grok-config` ext method set with `read_cron_yaml` / `write_cron_yaml` (or reuse `grokConfig.ts` shape).
- [ ] **Step 3:** Save → POST → optimistic UI update; show toast on success / failure.
- [ ] **Step 4:** Test: render with mock fetch; assert PUT body shape and refetch on save.
- [ ] **Step 5:** Run `npm run typecheck && npm run test:run 2>&1 | tail -5` — pass.
- [ ] **Step 6:** Commit: `feat(web workbench v2): CronSettingsPanel with YAML edit + save`.

---

## Phase 7 — Adjudicate modes

### Task M2.7: Add `Gatekeeper` + `AlwaysSkip` enum variants to `WorkbenchAdjudicateConfig`. `state_machine

**Files:** Modify `crates/codegen/xai-grok-shell/src/agent/config.rs` + `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` + `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` (pass mode through).

- [ ] **Step 1:** Extend `WorkbenchAdjudicateConfig.default_mode` enum to include `Recorder | Gatekeeper | AlwaysSkip`. `#[serde(rename_all = "snake_case")]`.
- [ ] **Step 2:** Add `TapdProjectConfig.adjudicate_mode: Option<AdjudicateMode>` with `#[serde(default)]` (None = use global default).
- [ ] **Step 3:** Update `next_after_planner` signature to take `mode: AdjudicateMode`. Branch: `Recorder` → existing logic; `Gatekeeper` → only block if any open question tagged `critical`; `AlwaysSkip` → return `Running { stage: Develop, attempt: 0, .. }` regardless.
- [ ] **Step 4:** Update `next_after_adjudicate` / orchestrator to use the resolved mode (global default → per-project override → fallback chain).
- [ ] **Step 5:** Tests: `next_after_planner_gatekeeper_passes_non_critical_questions`, `next_after_planner_always_skip_goes_straight_to_develop`, `project_overrides_global_mode`.
- [ ] **Step 6:** Run `cargo test --lib workbench::state_machine` — 3 new + existing pass.
- [ ] **Step 7:** Commit: `feat(workbench v2): adjudicate_mode = gatekeeper | always_skip with per-project override`.

---

## Phase 8 — Human pre-approve

### Task M2.8: Add 4th `adjudicate_mode` value `HumanPreApprove`. After Brainstorm writes `1-design.md`, transition to `BlockedForHuman { reason

**Files:** Modify `crates/codegen/xai-grok-shell/src/agent/config.rs` + `workbench/state_machine.rs` + front-end `ReplayDialog.tsx` (add pre_approve checkbox).

- [ ] **Step 1:** Extend `AdjudicateMode` enum with `HumanPreApprove` (snake_case serde rename).
- [ ] **Step 2:** In `next_after_planner`: when mode is `HumanPreApprove`, return `BlockedForHuman { stage: Adjudicate, reason: "human_pre_approve_pending", payload: design_summary_json }`.
- [ ] **Step 3:** In orchestrator: when `pre_approved: true` arrives on a replay, skip the Adjudicate stage and route directly to Develop.
- [ ] **Step 4:** Front-end: `ReplayDialog` adds a "Pre-approve (skip Adjudicate)" checkbox visible only when the chosen replay_from is `adjudicate` and the task has a design doc.
- [ ] **Step 5:** Tests: `next_after_planner_human_pre_approve_always_blocks`; `replay_with_pre_approved_skips_adjudicate`.
- [ ] **Step 6:** Commit: `feat(workbench v2): human_pre_approve mode skips Adjudicate on replay`.

---

## Phase 9 — TAPD status writeback

### Task M2.9: On terminal states (`Done` / `BlockedForHuman`), call `tapd_client.set_task_status(tapd_id, "done" | "blocked")` with per-project override (`tapd_status_on_done` / `tapd_status_on_blocked`, default `"done"` / `"blocked"`). `Dead` does NOT trigger writeback. HTTP failure logs `warn!` but does not flip workbench state.

**Files:** Modify `crates/codegen/xai-grok-shell/src/agent/config.rs` (TapdProjectConfig 2 new fields) + `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` (writeback call after terminal transition).

- [ ] **Step 1:** Add `TapdProjectConfig.tapd_status_on_done: Option<String>` + `tapd_status_on_blocked: Option<String>` with `#[serde(default)]`.
- [ ] **Step 2:** Add `tapd_client::set_task_status(tapd_id, status) -> anyhow::Result<()>` (HTTP PUT to TAPD; method already exists in `tapd::client` module per v1 plan Task 11.1 — verify and reuse).
- [ ] **Step 3:** In `orchestrator::drive_task`: after transitions to `Done` or `BlockedForHuman`, spawn a `tokio::task` that calls `tapd_client.set_task_status`; on error log `warn!`. `Dead` skipped.
- [ ] **Step 4:** Tests: `writeback_done_uses_default_status`, `writeback_blocked_uses_per_project_override`, `dead_state_does_not_trigger_writeback`.
- [ ] **Step 5:** Commit: `feat(workbench v2): TAPD status writeback on Done / BlockedForHuman (best-effort)`.

---

## Phase 10 — Cross-project concurrency

### Task M2.10: Drop per-project `HashSet<String>` from `SlotAccountant`. New constraint

**Files:** Modify `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs` + `crates/codegen/xai-grok-shell/src/agent/config.rs` (TapdProjectConfig `max_concurrent` field).

- [ ] **Step 1:** Add `TapdProjectConfig.max_concurrent: Option<u32>` (None = no cap).
- [ ] **Step 2:** Replace `SlotAccountant.active: HashSet<String>` with `HashMap<String, TaskSlotInfo>` storing `{ project_key, project_count }`. Add `project_counts: HashMap<String, u32>` for per-project accounting.
- [ ] **Step 3:** Update `try_claim` / `release` methods: enforce global + per-project caps; decrement both on release.
- [ ] **Step 4:** Update `dispatch_pending` to no longer group by project; pop priority queue and claim.
- [ ] **Step 5:** Tests: `slot_accountant_caps_global_only_when_no_per_project_cap`, `slot_accountant_enforces_per_project_cap`, `dispatch_pending_dispatches_concurrent_projects`.
- [ ] **Step 6:** Run `cargo test --lib workbench::dispatcher` — 3 new + existing pass.
- [ ] **Step 7:** Commit: `feat(workbench v2): cross-project parallelism + opt-in max_concurrent cap`.

---

## Phase 11 — MR title template

### Task M2.11: `submitter

**Files:** Modify `crates/codegen/xai-grok-shell/src/workbench/submitter.rs` + `crates/codegen/xai-grok-shell/src/agent/config.rs` (TapdProjectConfig `mr_title_template` field).

- [ ] **Step 1:** Add `TapdProjectConfig.mr_title_template: Option<String>` with `#[serde(default)]`.
- [ ] **Step 2:** Add `format_mr_title(tapd_id, title, template: Option<&str>, ctx: &MrTitleContext) -> String` where `MrTitleContext { priority, owner, module }`. Use `format!`-style placeholder substitution with literal fallback for unknown keys.
- [ ] **Step 3:** In `create_mr`: resolve template (per-project override → global config default); build context from current `TaskState::Running` and TAPD-side fields; call `format_mr_title`.
- [ ] **Step 4:** Tests: `format_mr_title_default_template`, `format_mr_title_custom_template_with_placeholders`, `format_mr_title_unknown_placeholder_left_literal`.
- [ ] **Step 5:** Commit: `feat(workbench v2): per-project MR title template with placeholder substitution`.

---

## Phase 12 — M2 e2e integration

### Task M2.12: Three new e2e test files covering intervention, cron, and dispatcher concurrency.

**Files:** Create `crates/codegen/xai-grok-shell/tests/intervention_e2e.rs` + `cron_e2e.rs` + `dispatcher_concurrency_e2e.rs`.

- [ ] **Step 1:** `intervention_e2e.rs` — start a task, register intervention, pause mid-Develop (in a test-only hook), resume, assert second Develop attempt artifacts are newer than the first.
- [ ] **Step 2:** `cron_e2e.rs` — fake `Utc::now` advancing to a cron minute; load `tests/fixtures/cron.yaml`; assert `dispatcher.dispatch_pending` called with expected filter.
- [ ] **Step 3:** `dispatcher_concurrency_e2e.rs` — 5 tasks from 3 different projects; with `global_max_active: 5`, assert all 5 main sessions spawn concurrently (no per-project serialization).
- [ ] **Step 4:** Run `cargo test -p xai-grok-shell --test intervention_e2e --test cron_e2e --test dispatcher_concurrency_e2e -- --nocapture` — all e2e tests pass.
- [ ] **Step 5:** Commit: `test(workbench v2): intervention / cron / concurrency e2e integration`.

---

## M2 completion gate

After all 12 M2 tasks land, M2 is **done**. Before starting M3:

- [ ] `cargo test -p xai-grok-shell --lib` passes (no regression in any v1 / M1 test)
- [ ] `cargo test -p xai-grok-shell --test workbench_v1_state_compat --test workbench_orchestrator_e2e --test workbench_pipeline_e2e --test recovery_e2e --test intervention_e2e --test cron_e2e --test dispatcher_concurrency_e2e -- --nocapture` all pass
- [ ] `cargo check -p xai-grok-shell` passes
- [ ] `npm run typecheck && npm run test:run 2>&1 | tail -5 && npm run build` all pass (no frontend regression)
- [ ] Tag the commit: `git tag v2-m2-control`
- [ ] Then start M3.

**Do not start M3 if any M2 test fails.** Fix the regression first.

---

# M2 is done when this plan has 12 checked tasks + the gate tag is set.
# M3 plan lives in a separate file (per spec §11.3) and will be written
# after M2 lands.
