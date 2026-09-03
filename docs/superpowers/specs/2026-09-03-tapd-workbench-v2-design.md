# TAPD Workbench Pipeline v2 — Design Spec

> Status: **Draft v1**
> Date: 2026-09-03
> Owner: workbench subsystem
> Predecessor: `docs/superpowers/specs/2026-09-01-tapd-workbench-pipeline-design.md` (v1, implemented & committed)
> Scope: extends v1 across 18 deferred decisions / Non-Goals / new features, organized into 5 themes.

---

## 1. Summary

v1 ships a 6-stage pipeline (Brainstorm → Adjudicate → Develop → Code Review → Verify → MR Submit) that turns TAPD tickets into Draft GitLab MRs. It is **fully autonomous and read-only**: humans can observe the run but cannot intervene; on failure, tasks end up `BlockedForHuman` or `Dead` and require out-of-band repair.

v2 unlocks three classes of capability that v1 deliberately deferred:

1. **Reliability** — automatic retry with model fallback, structured test output, recoverable failure modes, worktree reuse.
2. **Control** — users can pause, resume, redirect, or take over a running task; Adjudicate can be fully automatic; humans can pre-approve the planner's design.
3. **Observability** — live stage notifications, replay from any stage, failure postmortems, metrics in SQLite.

v2 deliberately does **not** introduce a new top-level `TaskState` variant (D1) and does **not** add cross-workspace collaboration (D5, deferred to v3). v2's design extends v1 in place on the same branch (`feat/sessions-hub-redesign`); no migration.

---

## 2. Context & Motivation

v1 was the first end-to-end version. The 6 stages work, the state machine is correct, the artifacts are well-formed, the dispatcher drains correctly, and 10 integration tests pass end-to-end against a mock GitLab server. The 35-commit diff for v1 is reviewable in one sitting.

The next iteration's design questions cluster around three observed gaps:

- **Reliability**: v1's runner treats *any* non-zero exit as a verification failure that retries Develop. There is no model fallback, no per-test signal, no way to resume from a half-finished task. When the LLM gives a 5xx, the user has no recourse except to fix `~/.grok/state.json` by hand.
- **Control**: v1 spec §3.2 N1 explicitly forbade user mid-flight intervention. In practice, this means a 30-minute coder run that drifts off-topic cannot be corrected. v1 also forces every Adjudicate decision to a human (Recorder mode only), which is fine for low-trust cases but a bottleneck for high-volume days.
- **Observability**: v1 surfaces a stage badge in Sessions Hub and writes artifacts to disk, but offers no metrics, no replay, no failure postmortem. Diagnosing "why did TAPD-1234 fail yesterday" requires `git log` plus manual file inspection.

v2 is the first natural extension that addresses all three. The work is large but bounded: 18 topics, ~30-40 implementation tasks, ~3 milestones.

---

## 3. Goals & Non-Goals

### 3.1 Goals

- **G1.** A coder or runner 5xx automatically retries once with a fallback model, then escalates to human (D1).
- **G2.** `cargo nextest --message-format json` results are recorded per-test in `5-verify.md`, so a CI-style pass/fail report is visible without re-running.
- **G3.** A `BlockedForHuman` task can be resolved by the user answering the open question (or modifying the design); the task resumes from `Brainstorm` with the answer injected.
- **G4.** A running task can be `Pause`d, `Resume`d, or `Cancel`d by the user at any time (N1 unlocked). `Pause` preserves `state.json`; `Resume` continues from the current stage's `attempt` field.
- **G5.** A user can pre-approve the planner's design (v1 always runs Adjudicate first). The Adjudicate stage itself can be configured to never block (auto-approve) on a per-project basis.
- **G6.** Cross-project concurrency: any number of tasks from any number of projects can run in parallel, bounded only by `global_max_active` and `worktree_pool_max` (N3 unlocked).
- **G7.** A `Done` MR can be promoted to auto-merge when the GitLab pipeline passes and reviewers approve, if the project's `auto_merge = true` (N2 unlocked per-project).
- **G8.** Every task exposes a complete timeline (pending → queued → running:stage:attempt → done|blocked|dead) and a metrics strip (per-stage duration, retry count, child session count). Live events via the existing `x.ai/workbench/stage` notification.
- **G9.** Failure postmortem: any `Dead` task can be replayed from a chosen stage (not necessarily the start) using the existing `state.json` + artifact files.
- **G10.** GitLab MR comments are received as `x.ai/workbench/mr_comment` notifications, allowing the user to ask the workbench to re-plan or re-implement in response.

### 3.2 Non-Goals (out of scope for v2)

- **N1-v2.** Multi-tenant / multi-org support. v2 still assumes a single user / single grog home.
- **N2-v2.** Global metrics backend (Prometheus / OpenTelemetry export). Metrics live in SQLite only.
- **N3-v2.** Pipeline visual editor (drag-drop pipeline composition). v2 stages are still hard-coded in `state_machine.rs`.
- **N4-v2.** Cross-workspace collaboration (multiple users on one TAPD task across multiple local worktrees). Deferred to v3.
- **N5-v2.** Branch name templates per project (over and above the worktree slug). v1's `branch_name(tapd_id, title)` stays.
- **N6-v2.** Replacing the Rust state machine with an LLM-driven control loop. The deterministic Rust state machine stays; v2 only adds the `_retry_with_fallback` and `_paused` extensions.
- **N7-v2.** Per-LLM-call token-budget enforcement. v2 only logs estimated token counts in the metrics table.

---

## 4. Theme Overview

v2 organizes the 18 deferred decisions / Non-Goals / new features into 5 themes. Each theme section below follows the structure: *v1现状 → v2改动 → 关键决策 → 测试要点*.

| # | Theme | Topics | v1 → v2 delta |
|---|---|---|---|
| 1 | **状态机健壮性** (State machine robustness) | 多模型 fallback · cargo nextest JSON · BlockedForHuman 回放 · worktree 复用 | new `_retry_with_fallback` and `_paused` markers on `Running`; new structured test output |
| 2 | **自动化与控制** (Automation & control) | 用户中途干预 · 自动合入 · 定时任务 · Adjudicate 自动模式 · 人类审批插件 · TAPD 状态回写 | new `pause`/`resume`/`cancel` ext methods; new `auto_merge` config; new `adjudicate_mode = "auto"` mode; new `cron.yaml` parser |
| 3 | **并发与路由** (Concurrency & routing) | 跨项目并发 · MR 标题模板 · worktree 路径加固 | dispatcher algorithm simplified (no per-project serialization); per-project `mr_title_template` config |
| 4 | **可观测性** (Observability) | 评论机器人 · metrics dashboard · failure replay · timeline 溯源 | new `workbench_task_metrics` + `workbench_mr_comments` tables; new `x.ai/workbench/timeline` + `x.ai/workbench/metrics` + `x.ai/workbench/mr_comment` ext methods; new `Replay` button in UI |
| 5 | **协同** (Collaboration) | 跨工作区协同 | **not implemented in v2**; deferred to v3 (only spec'd here as a non-goal) |

---


## 5. Cross-Theme Architecture (v1 → v2)

### 5.1 New external ext methods

| Ext method | Direction | Purpose |
|---|---|---|
| `x.ai/workbench/stage` (existing) | backend → frontend | unchanged; v2 reuses for live stage events |
| `x.ai/workbench/timeline` (new) | backend → frontend | full timeline for a single task (push on demand) |
| `x.ai/workbench/metrics` (new) | backend → frontend | aggregate counts + per-stage durations for a project |
| `x.ai/workbench/mr_comment` (new) | frontend → backend (request) / backend → frontend (event) | submit a comment for adjudication; receive webhook events |
| `x.ai/workbench/pause` (new) | frontend → backend | request pause of a running task |
| `x.ai/workbench/resume` (new) | frontend → backend | request resume of a paused task |
| `x.ai/workbench/cancel` (new) | frontend → backend | request cancel of a running task |
| `x.ai/workbench/replay` (new) | frontend → backend | request replay from a chosen stage |
| `x.ai/workbench/health` (existing) | frontend → backend | unchanged |

### 5.2 New Rust modules

```
crates/codegen/xai-grok-shell/src/workbench/
  ├─ mod.rs                    (existing; add new module decls)
  ├─ state_machine.rs          (extend: add TaskState extension fields + new transition fns)
  ├─ dispatcher.rs             (extend: drop per-project serialization; add pause/cancel handling)
  ├─ recovery.rs               (NEW: model fallback, retry budget, runner JSON parsing)
  ├─ intervention.rs           (NEW: pause/resume/cancel/replay signals; cancellation token plumbing)
  ├─ metrics.rs                (NEW: write to workbench_task_metrics table; expose x.ai/workbench/metrics)
  ├─ mr_comments.rs            (NEW: handle inbound GitLab MR comment webhook; route to Adjudicate)
  ├─ orchestrator.rs           (extend: add retry hooks + pause checkpoint + cron + auto-merge)
  ├─ cron.rs                   (NEW: parse cron.yaml; produce tick events)
  ├─ submitter.rs              (extend: auto-merge call after MR creation; mr_title_template support)
  ├─ worktree_manager.rs       (extend: reuse_worktree(task_id) to drop a fresh clone of an existing branch)
  └─ (others unchanged)
```

### 5.3 New SQLite tables

```sql
-- Per-task metrics: one row per stage, append-only.
CREATE TABLE IF NOT EXISTS workbench_task_metrics (
    task_id          TEXT NOT NULL,
    stage            TEXT NOT NULL,           -- brainstorm|adjudicate|develop|code_review|verify|mr_submit
    attempt          INTEGER NOT NULL,
    started_at       INTEGER NOT NULL,
    finished_at      INTEGER,                 -- NULL while running
    duration_ms      INTEGER,                 -- computed when finished_at set
    model            TEXT,                    -- planner_model|coder_model|adjudicator_model|...
    fallback_used    INTEGER NOT NULL DEFAULT 0,  -- 1 if a fallback model was used this attempt
    child_session_id TEXT,
    PRIMARY KEY (task_id, stage, attempt)
);

-- Inbound GitLab MR comments (for adjudication re-trigger).
CREATE TABLE IF NOT EXISTS workbench_mr_comments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id          TEXT NOT NULL,
    mr_url           TEXT NOT NULL,
    author           TEXT NOT NULL,
    body             TEXT NOT NULL,
    received_at      INTEGER NOT NULL,
    consumed         INTEGER NOT NULL DEFAULT 0  -- 1 once a stage was re-run in response
);
```

### 5.4 New front-end components

```
web/src/features/workbench/
  ├─ PauseDialog.tsx          (NEW: confirm pause with optional reason)
  ├─ ReplayDialog.tsx         (NEW: pick stage to replay from)
  ├─ MetricsStrip.tsx         (NEW: per-stage duration bars + retry count)
  ├─ TimelineDrawer.tsx       (NEW: full timeline scrubber)
  ├─ CronSettingsPanel.tsx    (NEW: edit per-project cron expression)
  └─ (others unchanged)
```

### 5.5 v2 architecture diagram (delta from v1)

```
v1:                                 v2:
┌─ TapdStore ─┐                     ┌─ TapdStore ─┬── workbench_task_metrics (NEW)
└─ Dispatcher │                     └─ Dispatcher │── workbench_mr_comments (NEW)
   │                                  │  │
   ├─ Orchestrator (stubbed)         ├─ Orchestrator (real LLM + pause checkpoint)
   │  │                               │  ├─ recovery (NEW: model fallback)
   │  ├─ Planner stub                 │  ├─ intervention (NEW: pause/resume/cancel/replay)
   │  ├─ Adjudicator stub             │  ├─ metrics (NEW: per-stage writes)
   │  ├─ Coder stub                   │  ├─ cron (NEW: scheduled tasks)
   │  ├─ Reviewer stub                │  ├─ mr_comments (NEW: GitLab webhook)
   │  ├─ Runner (cmd)                 │  └─ Runner (cmd + JSON parse + fallback model retry)
   │  └─ Submitter (GitLab)           └─ Submitter (GitLab + auto-merge + mr_title_template)
   │                                  │
   └─ state_machine (6 states)        └─ state_machine (6 states + extension fields;
                                                no new variants)
```


## 6. Theme 1 — State machine robustness

### 6.1 v1现状

`TaskState::Running { stage, attempt, started_at }` is the only state in which a stage executes. On failure, the transition functions in `state_machine.rs` either retry the same stage (with attempt+1) or route to `BlockedForHuman` / `Dead`. v1 has no model fallback, no structured test output, no worktree reuse, and no clean recovery from `BlockedForHuman`.

### 6.2 v2改动

#### 6.2.1 多模型 fallback (T-A1)

**`TaskState::Running` extension fields** (D1):
```rust
Running {
    stage: Stage,
    attempt: u8,
    started_at: i64,
    /// Non-null when this attempt is running on a fallback model.
    /// Read by `recovery.rs` to decide if a *next* fallback is allowed
    /// (max 1 fallback per attempt per v2; further failures → BlockedForHuman).
    fallback_model: Option<String>,
    /// Reason this attempt failed last, if any. Reset on success.
    last_error: Option<String>,
}
```
Backward compatibility: existing `state.json` files without these fields deserialize via `#[serde(default)]` (T4.3 already uses `#[serde(default)]` on `TaskState`).

**`recovery.rs`** owns the model-fallback policy:
- `pub fn maybe_fallback(stage: Stage, attempts: &[RunAttempt]) -> Option<String>` — returns the fallback model name if (a) primary failed 2x in a row AND (b) `workbench.models.<role>_fallback` is configured AND (c) we haven't already used fallback this attempt.
- Fallback config: `[workbench.models]` gains `planner_fallback`, `adjudicator_fallback`, `coder_fallback`, `reviewer_fallback` (each optional `String`).
- Audit trail: each fallback attempt writes a `workbench_task_metrics` row with `fallback_used = 1` and the model name.

#### 6.2.2 cargo nextest JSON (T-A2)

`runner.rs` is extended to detect `cargo-nextest` in `PATH` and prefer it over plain `cargo test`. The `nextest` invocation uses `--message-format json` and the test binary's stdout is parsed into `serde_json::Value` per line; each test event (`test-started`, `test-passed`, `test-failed`, `test-skipped`) is recorded into the new `workbench_task_metrics` rows. The `5-verify.md` body gains a "## Per-test results" table.

For non-nextest projects (e.g. plain `cargo test` or a custom test_command), v2 falls back to the v1 behavior (stdout/stderr capture only); the per-test table is empty.

#### 6.2.3 BlockedForHuman 回放 (T-A5)

`main_session` `BlockedForHuman` reason field gains a new value: `"needs_owner_decision:<q_id>"`. The `x.ai/workbench/replay` ext method (see §7.4) lets the user inject an answer and restart the task at `Brainstorm`. The injected answer is appended to a new section of `1-design.md` titled `## Injected answer` and the task resumes.

Per-project replay policy config: `[tapd.projects.<key>].replay_mode = "restart_brainstorm" | "inject_into_design"` (default `restart_brainstorm`, matching v1 spec §18.5).

#### 6.2.4 worktree 复用 (T-B7)

`worktree_manager.rs` gains `pub fn reuse_worktree(task_id: &str) -> Result<PathBuf>`. Called by `orchestrator` when starting a task whose `workbench_state` row indicates a prior `Done` or `Dead` with `keep_stage_files_after_done = true` (or after a `Pause` with `recover_after = "reuse"`). The function reuses the existing `~/.grok/worktrees/<task-id>/` directory, runs `git fetch` (in case the remote has new commits) and `git reset --hard origin/<branch>` to bring the branch up to date. The artifacts in `.workbench/` are preserved; the new run overwrites them on each stage transition.

This is the implementation of v1 spec §3.2 N7's deferral. It is opt-in: by default a new task still creates a fresh worktree.

### 6.3 关键决策 (this theme)

- **D1**: No new `TaskState` variant. Extension fields + new transition fns only. Backward-compat with v1 `state.json` via `#[serde(default)]`.
- **D6**: Fallback is opt-in per role. A project without a `*_fallback` config behaves exactly as v1 (Dead after retry budget).
- **D7**: nextest is auto-detected; projects without nextest fall back to v1 behavior. No forced migration.
- **D8**: Worktree reuse is opt-in via `[tapd.projects.<key>].reuse_worktree = true` (default false).

### 6.4 测试要点

- Unit: `recovery::maybe_fallback` — first attempt fails → use fallback; fallback fails → no third attempt.
- Unit: `runner` nextest parsing — synthetic JSON event stream, assert `workbench_task_metrics` rows.
- Integration: `recovery_fallback.rs` — failing primary model + working fallback model → `Done`; both failing → `BlockedForHuman` with reason `model_fallback_exhausted`.
- E2E: existing `workbench_orchestrator_e2e.rs` extended with `reuse_worktree` path.

---

## 7. Theme 2 — Automation & control

### 7.1 v1现状

v1's main session is started by the dispatcher and runs to a terminal state without external interference (N1). Adjudicate always uses `recorder` mode and escalates to `BlockForHuman` whenever an open question is tagged `needs_owner_decision` (D15). MRs are created as Draft and never auto-merged (N2). TAPD sync is event-driven from `tapd_sync_manager`; there is no cron-based task trigger (B6). The dispatcher only pulls from `TapdStore::list_pending_workbench_tasks` once per sync.

### 7.2 v2改动

#### 7.2.1 用户中途干预 (T-B1)

New `intervention.rs` module owns three signals: `pause`, `resume`, `cancel`. Each maps to a `tokio_util::sync::CancellationToken` stored in a `dashmap::DashMap<task_id, CancellationToken>` inside the dispatcher. The orchestrator checks the token at each stage boundary AND between child-session token chunks; on cancel, the in-flight child session is sent `acp::Cancel` and the task transitions to `Dead { reason: "user_cancelled" }`.

UI surfaces: `PauseDialog` with optional reason (`"user wanted to fix the design first"`). The dialog commits the reason to `workbench_task_state.reason` and emits `x.ai/workbench/stage` with `stage: "paused"`. The `WorkbenchHeader` shows a "Paused" badge.

Persistence: when paused, the current `TaskState::Running` is saved to `state.json` with `attempt` unchanged; on resume, the orchestrator re-runs the current stage from scratch (LLM stages re-execute; tool stages re-run). v2 does **not** checkpoint mid-stage (e.g. mid-LLM-call); checkpoint granularity is one stage.

#### 7.2.2 自动合入 (T-B2)

`submitter.rs` gains an opt-in `auto_merge: bool` per project (default false). After MR creation returns 201, if `auto_merge` is true and the GitLab response includes `merge_when_pipeline_succeeds = true` in the project settings, the submitter issues a second `PUT /projects/:id/merge_requests/:mr_iid/merge` call with `merge_when_pipeline_succeeds: true, squash: true`. The MR's `state` field is monitored; on `merged` the task transitions to `Done { mr_url }` as today; on `cannot_be_merged` (pipeline failed, approvals missing) the task transitions to `BlockedForHuman` with reason `"auto_merge_blocked"`.

#### 7.2.3 定时任务 (T-B6)

New `cron.rs` module parses a `~/.grok/cron.yaml` file:
```yaml
projects:
  - key: my-app
    schedules:
      - cron: "0 9 * * MON"
        tapd_status_filter: ["planning", "open"]
        priority_filter: ["high", "urgent"]
      - cron: "*/15 * * * *"
        tapd_status_filter: ["open"]
        priority_filter: ["urgent"]
```
A tokio task ticks every minute. For each match (project + current `tapd_status` ∈ filter + current `priority` ∈ filter), if the project has any TAPD tasks matching, the dispatcher is invoked. v1's `dispatch_pending` is reused unchanged. The cron task respects the existing `global_max_active` and `worktree_pool_max`.

Failure modes: bad YAML → log error + skip; cron expression parse error → log error + skip; all the dispatcher's normal failure handling applies.

#### 7.2.4 Adjudicate 自动模式 (T-C5)

`WorkbenchAdjudicateConfig.default_mode` is already in v1 spec; v1 only implements `Recorder`. v2 implements the other enum variants:
- `Recorder` (v1): always block on `needs_owner_decision`.
- `Gatekeeper` (new): blocks on `needs_owner_decision` IF the question is tagged `critical`; auto-resolves `non_critical` with the assistant's proposed `auto-resolved` resolution.
- `AlwaysSkip` (new): Adjudicate stage is a no-op. The pipeline goes directly from `Brainstorm` to `Develop` regardless of open questions.

Per-project override: `[tapd.projects.<key>].adjudicate_mode = "recorder" | "gatekeeper" | "always_skip"`. The transition function in `state_machine.rs` becomes `next_after_planner(design, mode, priority, ac_count)`.

#### 7.2.5 人类审批插件 (T-C6)

New `adjudicate_mode` config value `"human_pre_approve"`: after Brainstorm writes `1-design.md`, the task transitions to `BlockedForHuman` with reason `"human_pre_approve_pending"` *regardless* of open questions. The UI shows the design doc in a preview pane with "Approve & Continue" / "Edit & Continue" buttons. The Approve button calls `x.ai/workbench/replay` with `replay_from: "adjudicate"` and a `pre_approved: true` marker; the Adjudicate stage is then skipped.

This is a sub-case of T-A5 BlockedForHuman replay.

#### 7.2.6 TAPD 状态回写 (T-B5)

After `Done` (or terminal failure), if the task had a TAPD-side `task_id`, the orchestrator calls `tapd_client.set_task_status(tapd_id, "in_progress" | "done" | "blocked")`. The mapping:
- `Done` → TAPD `done` (or project-configured `tapd_status_on_done`, default `"done"`)
- `BlockedForHuman` → TAPD `blocked` (or `tapd_status_on_blocked`, default `"blocked"`)
- `Dead` → no TAPD change (Dead is internal infrastructure failure, not the user's fault)

Per-project override: `[tapd.projects.<key>].tapd_status_on_done = "implemented"` etc. If unset, defaults apply.

### 7.3 关键决策 (this theme)

- **D2**: `Paused` is NOT a new TaskState variant (D1). It's `Running { attempt: unchanged, ... }` plus a `dispatcher.pause_tokens[task_id]` set. The UI shows a "Paused" badge derived from token presence, not state.
- **D9**: Pause granularity is one stage, not one LLM call. A 30-minute coder run that gets paused mid-call still wastes the call's tokens. This is a known cost; spec defers LLM-call-level pause to v3.
- **D10**: Auto-merge is opt-in. v1's Draft-MR-only behavior is the default; per-project opt-in is required.
- **D11**: Gatekeeper / AlwaysSkip / HumanPreApprove are all opt-in via `adjudicate_mode`. Recorder (v1 default) is unchanged.
- **D12**: TAPD status writeback is best-effort. A TAPD API failure is logged but does not flip the workbench state.

### 7.4 测试要点

- Unit: `intervention::pause` sets the token, `orchestrator` checks it between stages and aborts.
- Unit: `cron::matches_now` with a frozen clock — assert which `(project, schedule)` pairs match at a given minute.
- Unit: `submitter::auto_merge` — 201 response + `merge_when_pipeline_succeeds: true` triggers the second call.
- Integration: `intervention_e2e.rs` — start a task, pause it mid-Develop, resume, assert the second Develop attempt's artifacts are newer than the first.
- E2E: `cron_e2e.rs` — fake `Utc::now` advances to a cron minute, assert dispatcher is invoked.

---


## 8. Theme 3 — Concurrency & routing

### 8.1 v1现状

`WorkbenchDispatcher` enforces a per-project serialization: at most one task per project runs at a time. This was a v1 simplification (spec §3.2 N3) chosen to keep the slot accountant simple. The `global_max_active` and `worktree_pool_max` limits are global, not per-project.

`branch_name(task_id, title)` uses `<task-id>` to avoid slug collisions; the slug is cosmetic. `format_mr_title(tapd_id, title)` returns `"[<TAPD-ID>] <title>"` with no override.

### 8.2 v2改动

#### 8.2.1 跨项目并发 (T-B3)

`SlotAccountant` is simplified: drop the per-project set; the only constraint is `active < global_max_active` and `worktree_users < worktree_pool_max`. Any number of tasks from any number of projects can claim slots simultaneously. The dispatcher's `dispatch_pending` no longer groups by project; it just pops the priority queue and claims slots.

Per-project cap (optional): `[tapd.projects.<key>].max_concurrent` (default = null = no cap). When set, the dispatcher checks the count of currently-running tasks for that project against the cap before claiming. The implementation is a `HashMap<String, u32>` in the dispatcher; counts are decremented on slot release.

#### 8.2.2 MR 标题模板 (T-A3)

`submitter::format_mr_title` is extended:
```rust
pub fn format_mr_title(
    tapd_id: &str,
    title: &str,
    template: Option<&str>,  // None = default
) -> String
```
Default template: `"[{tapd_id}] {title}"`. Custom template: e.g. `"[{priority}] {tapd_id} - {title}"`. Placeholders supported: `{tapd_id}`, `{title}`, `{priority}`, `{owner}`, `{module}`. Missing placeholders are left literal (so `"FOO {nonexistent}"` produces `"FOO {nonexistent}"` rather than erroring — the audit log records the substitution).

Per-project template: `[tapd.projects.<key>].mr_title_template` (string, optional).

#### 8.2.3 worktree 路径加固 (T-A4)

v1's `branch_name` and `worktree_path` already use `<task-id>` directly, so collision is impossible (v1 spec §18.4 already addressed this). v2 hardens the invariant: `worktree_path(grok_home, task_id)` is the single source of truth; tests assert that the function returns the same path for any two titles with the same `task_id` (regression test for §18.4).

### 8.3 关键决策 (this theme)

- **D3**: Cross-project full parallelism is the v2 default; per-project cap is opt-in.
- **D13**: MR title template is per-project; the global default `[<id>] <title>` is preserved.
- **D14**: Worktree path hardening is a regression test only; no production change needed.

### 8.4 测试要点

- Unit: `dispatcher` with multiple projects all pending — assert all can claim slots (not serialized).
- Unit: `format_mr_title` with custom template — assert placeholder substitution.
- Unit: regression test for `worktree_path` — same `task_id`, different titles → same path.
- Integration: `dispatcher_concurrency_e2e.rs` — 5 tasks from 3 projects, all dispatched, all run.

---

## 9. Theme 4 — Observability

### 9.1 v1现状

`WorkbenchDispatcher` emits `DispatchEvent::{Spawned, NoSlot, QueueEmpty, HealthSnapshot}` to a `tokio::sync::mpsc` channel that the front-end subscribes to. There are no per-stage metrics, no timeline, no replay. `x.ai/workbench/stage` notifications exist (T13.1) but the actual stage notification plumbing in the front-end is a placeholder.

### 9.2 v2改动

#### 9.2.1 GitLab MR 评论机器人 (T-C1)

`mr_comments.rs` is a new module. It exposes two things:

- **Inbound**: a `POST /x.ai/workbench/mr_comment` HTTP endpoint on the local server (port = same as the agent). The body is `{ tapd_id, author, body, mr_url }`. The handler stores the comment in `workbench_mr_comments` and emits a `x.ai/workbench/mr_comment` notification.
- **Re-trigger**: when the comment is `consumed = 0`, the dispatcher checks on each dispatch_pending sweep if the comment is `consumed = 0`; if so, the Adjudicate stage is re-run with the comment as additional context. The comment body is appended to `1-design.md` under a new `## External comment` section. After Adjudicate re-runs, the comment is marked `consumed = 1`.

This makes "reviewer left a comment on the MR" → "Adjudicate re-plans with that comment" automatic, closing the feedback loop.

The local HTTP endpoint is NOT a public webhook — it's for the GitLab side-channel that v2's GitLab server configures (via `webhook_url` field in the GitLab project settings) to forward MR comments. v2 ships a `bin/configure_gitlab_webhook` CLI helper that takes a GitLab project ID and personal access token and configures the webhook via `PUT /projects/:id/hooks`.

#### 9.2.2 metrics dashboard (T-C2)

`metrics.rs` is a new module. It writes per-stage, per-attempt rows to `workbench_task_metrics` (see §5.3 schema). The schema captures enough to answer:
- "What was the median Develop duration last week?"
- "How many tasks fell back to a fallback model this month?"
- "Which project has the highest Verify-fail rate?"

The `x.ai/workbench/metrics` ext method accepts a `project_key` (optional) and returns:
```json
{
  "project_key": "my-app",
  "since_ts": 1700000000,
  "totals": {
    "done": 12, "blocked": 1, "dead": 0
  },
  "stages": [
    {"stage": "develop", "p50_ms": 84000, "p90_ms": 180000, "retry_count": 2},
    ...
  ]
}
```
The front-end `MetricsStrip` component renders the p50 / p90 / retry counts as inline bars on the workbench header.

#### 9.2.3 failure replay (T-C3)

`x.ai/workbench/replay` is a new ext method. Body:
```json
{ "tapd_id": "TAPD-1", "replay_from": "develop", "reason": "model upgraded; try again" }
```
The dispatcher:
1. Sets `workbench_state = "running:<replay_from>:0"`.
2. Loads the existing `1-design.md` and `2-adjudicate.md` (if any) as the in-context for the new run.
3. Dispatches a fresh `orchestrator::drive_task` with the same `tapd_id` and `replay_from` as a starting point.

The starting stage is configurable: `brainstorm` | `adjudicate` | `develop` | `code_review` | `verify` | `mr_submit`. Each stage's `attempt` resets to 0 on replay. Artifacts from the prior run are moved to `.workbench/stages/<n>-<stage>-attempt-<old>.md` (v1 spec §8 convention).

The orchestrator gains a `start_stage: Stage` parameter; the existing 6-stage pipeline becomes a stage-indexed loop.

#### 9.2.4 timeline 溯源 (T-C7)

`x.ai/workbench/timeline` is a new ext method. Body: `{ "tapd_id": "TAPD-1" }`. Returns the full ordered event log of that task:
```json
{
  "tapd_id": "TAPD-1",
  "events": [
    {"ts": 1700000000, "kind": "pending"},
    {"ts": 1700000010, "kind": "queued", "priority": "high"},
    {"ts": 1700000020, "kind": "running", "stage": "brainstorm", "attempt": 0, "model": "opus-4.1"},
    {"ts": 1700000090, "kind": "stage_done", "stage": "brainstorm", "verdict": "ok"},
    {"ts": 1700000095, "kind": "running", "stage": "adjudicate", "attempt": 0},
    {"ts": 1700000150, "kind": "stage_done", "stage": "adjudicate", "verdict": "proceed"},
    ...
    {"ts": 1700001000, "kind": "done", "mr_url": "https://gl.example/mr/1"}
  ]
}
```
The data is read from `workbench_task_metrics` (one row per stage-attempt) joined with `workbench_state` (state transitions). No new table; the existing `workbench_state` text field encodes `pending` / `queued` / `running:<stage>:<attempt>` / `done` / `blocked` / `dead` and is augmented with timestamp columns.

The `TimelineDrawer` component renders the events as a horizontal scrollable strip with tooltips per event.

### 9.3 关键决策 (this theme)

- **D4**: Observability is event-driven + on-demand pull; no separate metrics backend. SQLite + ext methods are sufficient.
- **D15**: The MR comment re-trigger path consumes a comment on first Adjudicate re-run. Comments are not deleted; they live in `workbench_mr_comments` for audit.
- **D16**: `replay` is destructive — prior artifacts are moved to `-attempt-<old>.md`. The user is warned in the UI before replay.
- **D17**: Timeline is computed on-demand from existing tables. No event log table.

### 9.4 测试要点

- Unit: `mr_comments::consume` — comment marked consumed after re-trigger.
- Unit: `metrics::aggregate` — p50 / p90 / counts from sample `workbench_task_metrics` rows.
- Integration: `mr_comment_e2e.rs` — fake GitLab POST → Adjudicate re-runs → comment marked consumed.
- Integration: `replay_e2e.rs` — fail develop twice, then replay from `develop`, assert `attempt` resets and new artifacts replace old.
- E2E: `metrics_e2e.rs` — run a few tasks, call metrics, assert aggregates.

---

## 10. Theme 5 — Collaboration (v2 does NOT implement)

### 10.1 v1现状

v1's worktree is created on the local machine where `grok` runs. There is no facility for multiple users or machines to coordinate on a single TAPD task. v1 spec §3.2 N3 explicitly defers this.

### 10.2 v2处理

`C4 跨工作区协同` is a v3 topic. v2 only documents the deferral.

Rationale (recording now to avoid re-litigating later): v1's single-machine flow has not been load-tested. Adding cross-workspace features before the single-machine flow is proven in production would multiply debugging surface. The v3 cross-workspace design will be informed by what we learn in v2.

The only v2-side change related to this theme: the `dispatch_pending` API is now workspace-agnostic (D3 — no per-project serialization). v3 will layer on top of v2's flat dispatch, not against v1's per-project fence.

---


## 11. Implementation plan (M1 → M2 → M3)

The v2 plan decomposes into three milestones. Each milestone is self-contained: M1 can ship without M2/M3, M2 builds on M1, M3 is purely additive observability. The order is "reliability first, then control, then observability on top" — so an M1 release buys us production hardening before introducing new control surfaces.

### 11.1 M1: Reliability (Theme 1)

8 implementation tasks, ~3-5 working days.

1. Add extension fields to `TaskState::Running` (`fallback_model`, `last_error`) + `#[serde(default)]` backward compat — 0.5d
2. Add fallback model config: `[workbench.models.{role}_fallback]` + parsing tests — 0.5d
3. New `recovery.rs`: `maybe_fallback` policy + integration with `state_machine::next_after_develop` and `next_after_mr_submit` — 1d
4. Runner: detect `cargo-nextest` in PATH, parse `--message-format json` event stream, write per-test metrics — 1d
5. New `workbench_task_metrics` table migration + DAO + write-on-stage-finish hook in `orchestrator` — 0.5d
6. `BlockedForHuman` resume: extend `state_machine` with `next_after_replay`; new `x.ai/workbench/replay` ext method — 1d
7. `worktree_manager::reuse_worktree` + opt-in config + regression test for v1 §18.4 — 0.5d
8. Integration test: `recovery_e2e.rs` covering fallback success / fallback exhaust / reuse_worktree path — 0.5d

### 11.2 M2: Automation & control + Concurrency (Themes 2 & 3)

12 implementation tasks, ~4-7 working days.

1. `intervention.rs`: `CancellationToken` registry + `pause` / `resume` / `cancel` ext methods — 1d
2. Orchestrator: poll token at stage boundaries, abort child LLM call on cancel — 1d
3. Front-end: `PauseDialog` + `ReplayDialog` + `WorkbenchHeader` "Paused" badge — 0.5d
4. `auto_merge` per-project config + `submitter::auto_merge_after_create` — 0.5d
5. `cron.rs`: `~/.grok/cron.yaml` parser + per-minute tick task — 1d
6. Front-end: `CronSettingsPanel` — 0.5d
7. `adjudicate_mode = "gatekeeper" | "always_skip"` + `next_after_planner(mode, ...)` + per-project override — 1d
8. `adjudicate_mode = "human_pre_approve"` + new BlockedForHuman reason + UI preview pane — 0.5d
9. TAPD status writeback: `tapd_client.set_task_status` + retry semantics — 0.5d
10. `SlotAccountant` simplification: drop per-project set + opt-in `max_concurrent` cap — 0.5d
11. `format_mr_title` with template parameter + per-project override — 0.5d
12. Integration: `intervention_e2e.rs` + `cron_e2e.rs` + `dispatcher_concurrency_e2e.rs` — 1d

### 11.3 M3: Observability (Theme 4)

8 implementation tasks, ~3-5 working days.

1. `metrics.rs`: aggregator over `workbench_task_metrics` — 0.5d
2. `x.ai/workbench/metrics` ext method (request/response shape per §9.2.2) — 0.5d
3. Front-end: `MetricsStrip` component — 0.5d
4. `x.ai/workbench/timeline` ext method + `TimelineDrawer` component — 1d
5. `mr_comments.rs`: new SQLite table + inbound HTTP handler + `x.ai/workbench/mr_comment` notification — 1d
6. Re-trigger logic: dispatcher detects unconsumed comment, routes through Adjudicate — 0.5d
7. `bin/configure_gitlab_webhook` CLI helper — 0.5d
8. Integration: `mr_comment_e2e.rs` + `metrics_e2e.rs` + `replay_e2e.rs` — 1d

### 11.4 Effort summary

| Milestone | Tasks | Working days |
|---|---|---|
| M1: Reliability | 8 | 3-5 |
| M2: Automation + Concurrency | 12 | 4-7 |
| M3: Observability | 8 | 3-5 |
| **Total** | **28** | **10-17** |

v1 was 32 tasks / 11.5 days. v2 is similar order of magnitude.

---

## 12. Decision log (v2)

| # | Decision | Rationale |
|---|---|---|
| D1 | No new `TaskState` variant; extension fields only | Backward compat with v1 `state.json` files; avoids breaking transition fns; new concepts express as field on `Running` |
| D2 | `Paused` ≠ new variant; it's `Running` + a token in `dispatcher` | Pause is a control concept, not a state concept; the state machine stays clean |
| D3 | Cross-project full parallelism is v2 default; per-project cap opt-in | v1's per-project fence was a simplification, not a product need |
| D4 | Observability is event-driven + on-demand pull; no metrics backend | YAGNI: spec §12 channels + SQLite suffice |
| D5 | Cross-workspace collaboration v2 does not implement | YAGNI: v1 single-machine flow unproven |
| D6 | Model fallback is opt-in per role | Projects without `*_fallback` config behave as v1 |
| D7 | nextest auto-detected; v1 fallback if absent | No forced migration |
| D8 | Worktree reuse is opt-in per project | Default = fresh worktree; reuse requires explicit config |
| D9 | Pause granularity is one stage, not one LLM call | Mid-call pause needs a checkpoint protocol v2 doesn't add |
| D10 | Auto-merge is opt-in per project | v1's Draft-MR-only behavior stays the default |
| D11 | Gatekeeper / AlwaysSkip / HumanPreApprove are opt-in via `adjudicate_mode` | Recorder (v1 default) is unchanged |
| D12 | TAPD status writeback is best-effort | API failure does not flip workbench state |
| D13 | MR title template is per-project; global default preserved | Smooth migration path |
| D14 | Worktree path hardening is a regression test only | No production change needed |
| D15 | MR comment re-trigger consumes the comment on first Adjudicate re-run | Audit trail preserved in `workbench_mr_comments` |
| D16 | Replay is destructive (moves prior artifacts) | User warned in UI before replay |
| D17 | Timeline computed on-demand from existing tables | No event log table |

---

## 13. Deferred to v3

- **C4 跨工作区协同** — see §10.2
- **N1-v2** Multi-tenant / multi-org support
- **N2-v2** Global metrics backend (Prometheus / OpenTelemetry export)
- **N3-v2** Pipeline visual editor
- **D9 follow-up** LLM-call-level pause / checkpoint protocol
- **T-A1 follow-up** Cross-vendor model routing (e.g. OpenAI when Anthropic 5xx)
- **T-C5 follow-up** Custom Adjudicate modes (project-defined)
- **N7-v2** Per-LLM-call token-budget enforcement

---

## 14. References

- `docs/superpowers/specs/2026-09-01-tapd-workbench-pipeline-design.md` — v1 spec (the entire §3.2 Non-Goals and §18 Open Questions are the input to v2)
- `crates/codegen/xai-grok-shell/src/workbench/` — v1 implementation, the file v2 extends
- `crates/codegen/xai-grok-shell/src/tapd/store.rs` — v1 `TapdStore` schema and DAO; v2 adds two tables via the same migration path
- `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` — v1 orchestrator with stubbed LLM stages; v2 turns stubs into real calls + retry hooks + pause checkpoint
- `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` — v1 transition functions; v2 extends with `next_after_replay` and `next_after_planner(mode, ...)`
- `web/src/features/workbench/` — v1 Workbench UI; v2 adds PauseDialog, ReplayDialog, MetricsStrip, TimelineDrawer, CronSettingsPanel
- `crates/codegen/xai-grok-shell/src/extensions/tapd.rs` — v1 ext method dispatch; v2 adds `x.ai/workbench/{pause,resume,cancel,replay,timeline,metrics,mr_comment}` here
- `~/.codex/skills/.system/review-agent/SKILL.md` — calibration pattern inherited from v1
- `docs/superpowers/specs/2026-08-21-folder-view-diff-stats-design.md` — pattern reference for `workbench_task_metrics` per-event schema

---

## 15. Glossary

Terms added or refined in v2 (v1 terms unchanged):

- **Recovery** — automatic retry with a fallback model when the primary model returns 5xx (D1, D6). One fallback per attempt; second failure routes to `BlockedForHuman`.
- **Intervention** — user-driven control over a running task: `pause` (preserve state, halt), `resume` (continue from current stage, attempt 0), `cancel` (transition to `Dead`). Distinct from `BlockedForHuman` (system requests user input).
- **Replay** — restart a task from a chosen stage (not necessarily `Brainstorm`). Destructive: prior artifacts are moved to `-attempt-<old>.md`.
- **MR comment re-trigger** — GitLab MR comments are received, stored, and consumed by re-running the Adjudicate stage with the comment as additional design context.
- **Auto-merge** — opt-in per project: after MR creation, the submitter polls GitLab and issues `PUT /merge` when pipeline passes. Default off (matches v1's Draft-MR-only).
- **Worktree reuse** — opt-in per project: a new run for the same `tapd_id` reuses the existing `~/.grok/worktrees/<id>/` instead of creating a fresh one. Prior artifacts are preserved.
- **Timeline** — full event log of a single task, computed on-demand from `workbench_task_metrics` + `workbench_state`. No new table.

---

