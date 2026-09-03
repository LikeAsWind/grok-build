# TAPD Workbench Pipeline v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the v1 TAPD workbench pipeline with reliability (model fallback, structured test output, replay), control (pause/resume/cancel, auto-merge, cron, Adjudicate modes, human pre-approve), and observability (metrics, timeline, MR-comment re-trigger) per `docs/superpowers/specs/2026-09-03-tapd-workbench-v2-design.md`.

**Architecture:** v1 is the substrate; v2 extends it in place on the same `feat/sessions-hub-redesign` branch. The Rust state machine gains 2 extension fields on `Running` and 1 new transition fn (`next_after_replay`); new modules `recovery`, `intervention`, `metrics`, `mr_comments`, `cron`; 2 new SQLite tables. Front-end gains 5 new components. No new `TaskState` variant (D1). No cross-workspace collaboration (D5, v3).

**Tech Stack:** Rust (tokio, rusqlite, reqwest, serde, acp, tracing), React 19 + Vite 7 + Tailwind v4, TOML config, GitLab REST API v4.

---

## File Structure Overview

### NEW backend files
| Path | Responsibility |
|---|---|
| `crates/codegen/xai-grok-shell/src/workbench/recovery.rs` | Model fallback policy + retry-with-fallback decision; consumed by `state_machine` + `orchestrator` |
| `crates/codegen/xai-grok-shell/src/workbench/intervention.rs` | `CancellationToken` registry keyed by `task_id`; `pause` / `resume` / `cancel` ext methods |
| `crates/codegen/xai-grok-shell/src/workbench/metrics.rs` | Write per-stage rows to `workbench_task_metrics`; aggregator + `x.ai/workbench/metrics` ext method |
| `crates/codegen/xai-grok-shell/src/workbench/mr_comments.rs` | Inbound HTTP handler + SQLite table + Adjudicate re-trigger on unconsumed comment |
| `crates/codegen/xai-grok-shell/src/workbench/cron.rs` | Parse `~/.grok/cron.yaml`; per-minute tick task that calls `dispatcher.dispatch_pending()` |
| `crates/codegen/xai-grok-shell/src/bin/configure_gitlab_webhook.rs` | CLI helper: takes GitLab project + token, configures webhook via `PUT /projects/:id/hooks` |

### MODIFIED backend files
| Path | Change |
|---|---|
| `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` | Add `fallback_model` + `last_error` fields to `Running`; add `next_after_replay(prev_stage, attempt)`; add `next_after_planner_adjudicate_mode(design, mode, priority, ac_count)` for `gatekeeper` / `always_skip` modes |
| `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs` | Drop per-project set in `SlotAccountant`; add `pause_tokens: DashMap<task_id, CancellationToken>`; add `pause` / `resume` / `cancel` / `replay` ext methods; on each dispatch, check `workbench_mr_comments` for unconsumed comments |
| `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` | Real LLM calls replace stubs; pause-checkpoint between stages (consult `intervention::pause_tokens`); call `runner::maybe_fallback` on 5xx; call `mr_comments::consume` after Adjudicate re-trigger; auto-merge call if configured |
| `crates/codegen/xai-grok-shell/src/workbench/runner.rs` | Detect `cargo-nextest` in PATH; if present, use `--message-format json`; parse event stream into `workbench_task_metrics` rows |
| `crates/codegen/xai-grok-shell/src/workbench/submitter.rs` | `auto_merge: bool` per-project; `format_mr_title(tapd_id, title, template)` |
| `crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs` | `reuse_worktree(task_id, repo_root, base_branch)` — opt-in via `[tapd.projects.<key>].reuse_worktree` |
| `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` (resume) | `resume_state` accepts v1 OR v2 format (serde default for new fields) |
| `crates/codegen/xai-grok-shell/src/tapd/store.rs` | New migration adds `workbench_task_metrics` + `workbench_mr_comments` tables |
| `crates/codegen/xai-grok-shell/src/agent/config.rs` | `WorkbenchConfig` gains `*_fallback` model fields; `WorkbenchAdjudicateConfig` gains `human_pre_approve` variant; `TapdProjectConfig` gains `auto_merge`, `reuse_worktree`, `max_concurrent`, `mr_title_template`, `tapd_status_on_done`, `tapd_status_on_blocked`, `replay_mode` |
| `crates/codegen/xai-grok-shell/src/extensions/tapd.rs` | Register `x.ai/workbench/{pause,resume,cancel,replay,timeline,metrics,mr_comment}` + HTTP endpoint for the mr_comment webhook |
| `crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs` | `spawn_workbench_dispatcher` also starts the cron tick task |

### NEW frontend files
| Path | Responsibility |
|---|---|
| `web/src/features/workbench/PauseDialog.tsx` + `.test.tsx` | Confirm pause with optional reason |
| `web/src/features/workbench/ReplayDialog.tsx` + `.test.tsx` | Pick stage to replay from |
| `web/src/features/workbench/MetricsStrip.tsx` + `.test.tsx` | Per-stage p50 / p90 / retry count bars |
| `web/src/features/workbench/TimelineDrawer.tsx` + `.test.tsx` | Full event timeline scrubber |
| `web/src/features/workbench/CronSettingsPanel.tsx` + `.test.tsx` | Edit per-project cron expression |

### MODIFIED frontend files
| Path | Change |
|---|---|
| `web/src/features/workbench/WorkbenchHeader.tsx` | Add "Paused" badge + MetricsStrip; consume `x.ai/workbench/metrics` and `x.ai/workbench/timeline` events |
| `web/src/features/workbench/TaskDetailDrawer.tsx` | Add "Pause" / "Resume" / "Cancel" / "Replay" buttons (visible when state allows) |
| `web/src/features/sessions-hub/SubtaskPartView.tsx` | Wire `workbenchStage` field to show real stage from notification store (v1 was a placeholder) |
| `web/src/features/settings/components/grokConfigSchema.ts` | Add v2 config fields to existing `[workbench]` and `[tapd.projects.*]` sections |

### NEW integration test files
| Path | Responsibility |
|---|---|
| `crates/codegen/xai-grok-shell/tests/recovery_e2e.rs` | Model fallback success + exhaust paths |
| `crates/codegen/xai-grok-shell/tests/intervention_e2e.rs` | Pause mid-Develop, resume, assert second attempt |
| `crates/codegen/xai-grok-shell/tests/cron_e2e.rs` | Fake `Utc::now` to a cron minute, assert dispatch fired |
| `crates/codegen/xai-grok-shell/tests/dispatcher_concurrency_e2e.rs` | 5 tasks from 3 projects, all run |
| `crates/codegen/xai-grok-shell/tests/mr_comment_e2e.rs` | Fake GitLab POST → Adjudicate re-runs |
| `crates/codegen/xai-grok-shell/tests/replay_e2e.rs` | Fail develop twice, replay from develop |
| `crates/codegen/xai-grok-shell/tests/metrics_e2e.rs` | Run a few tasks, call metrics, assert aggregates |

### MODIFIED integration test files
| Path | Change |
|---|---|
| `crates/codegen/xai-grok-shell/tests/workbench_orchestrator_e2e.rs` | Add `reuse_worktree` path + `replay` sub-tests |
| `crates/codegen/xai-grok-shell/tests/workbench_pipeline_e2e.rs` | Add backward-compat test: load a v1-shaped `state.json` and assert v2 deserializes it cleanly |

---

## Conventions

- License: GPL-3.0-only on all new code (matches v1, AGENTS.md)
- One file = one responsibility
- Each Rust type lives next to its tests in `#[cfg(test)] mod tests`
- Each React component has a sibling `.test.tsx` using Vitest
- v1 files are extended, not replaced — append-only diffs where possible
- TDD: every behavior lands as a failing test first, then implementation
- Commits per task; small, focused, descriptive

---

## Phase 1 — Configuration (M1.1, M1.2)

### Task M1.1: Add extension fields to `TaskState::Running`

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs:40-50` (the `TaskState` enum)
- Test: `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` (existing `mod tests`)

- [ ] **Step 1: Write failing tests for the new fields**

Append to the existing `#[cfg(test)] mod tests` in `state_machine.rs`:

```rust
#[test]
fn running_carries_fallback_model_field() {
    let s = TaskState::Running {
        stage: Stage::Develop,
        attempt: 1,
        started_at: 0,
        fallback_model: Some("gpt-5".into()),
        last_error: None,
    };
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("fallback_model"));
    assert!(json.contains("gpt-5"));
    let back: TaskState = serde_json::from_str(&json).unwrap();
    match back {
        TaskState::Running { fallback_model, .. } => {
            assert_eq!(fallback_model.as_deref(), Some("gpt-5"));
        }
        _ => panic!("expected Running"),
    }
}

#[test]
fn running_round_trips_with_last_error() {
    let s = TaskState::Running {
        stage: Stage::CodeReview,
        attempt: 0,
        started_at: 1700000000,
        fallback_model: None,
        last_error: Some("503 from anthropic".into()),
    };
    let json = serde_json::to_string(&s).unwrap();
    let back: TaskState = serde_json::from_str(&json).unwrap();
    match back {
        TaskState::Running { last_error, .. } => {
            assert_eq!(last_error.as_deref(), Some("503 from anthropic"));
        }
        _ => panic!("expected Running"),
    }
}

#[test]
fn v1_shaped_state_json_deserializes_into_v2_running() {
    // A v1 task serialized without the new fields should still load.
    let v1_json = r#"{"Running":{"stage":"develop","attempt":0,"started_at":0}}"#;
    let s: TaskState = serde_json::from_str(v1_json).unwrap();
    match s {
        TaskState::Running { fallback_model, last_error, .. } => {
            assert!(fallback_model.is_none());
            assert!(last_error.is_none());
        }
        _ => panic!("expected Running"),
    }
}
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine::tests::running_carries_fallback_model_field -- --nocapture`
Expected: FAIL — the struct field doesn't exist yet.

- [ ] **Step 3: Add the fields to `TaskState::Running`**

In `state_machine.rs`, locate the `TaskState` enum and modify the `Running` variant:

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskState {
    Queued { priority: String },
    Pending,
    Running {
        stage: Stage,
        attempt: u8,
        started_at: i64,
        /// Non-null when this attempt is running on a fallback model.
        /// Read by `recovery.rs` to decide if a *next* fallback is allowed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback_model: Option<String>,
        /// Reason this attempt failed last, if any. Reset on success.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_error: Option<String>,
    },
    BlockedForHuman { stage: Stage, reason: String, payload: serde_json::Value },
    Done { mr_url: String, finished_at: i64 },
    Dead { reason: String },
}
```

The `#[serde(default)]` on each field is what makes the v1-shape test pass: a v1 JSON without those keys deserializes with `None`.

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine -- --nocapture`
Expected: 3 new tests pass; no regression in the existing ~25 state-machine tests.

- [ ] **Step 5: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/state_machine.rs
git commit -m "feat(workbench v2): add fallback_model and last_error fields to TaskState::Running"
```

---

### Task M1.2: Add fallback model config + parsing

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/agent/config.rs` (the `WorkbenchConfig` struct + the config-form's `[workbench.models]` section)
- Test: `crates/codegen/xai-grok-shell/src/agent/config.rs` (existing `mod workbench_config_tests`)

- [ ] **Step 1: Write failing tests for the new fields**

Append to the existing `mod workbench_config_tests` in `config.rs`:

```rust
#[test]
fn workbench_models_accept_fallback_fields() {
    let toml = r#"
        [workbench.models]
        planner_model = "opus-4.1"
        planner_fallback = "gpt-5"
        adjudicator_model = "sonnet-4.5"
        adjudicator_fallback = "haiku"
        coder_model = "opus-4.1"
        coder_fallback = "sonnet-4.5"
        reviewer_model = "sonnet-4.5"
    "#;
    let cfg: WorkbenchConfig = toml::from_str(toml).unwrap();
    assert_eq!(cfg.models.planner_model, "opus-4.1");
    assert_eq!(cfg.models.planner_fallback.as_deref(), Some("gpt-5"));
    assert_eq!(cfg.models.adjudicator_fallback.as_deref(), Some("haiku"));
    assert_eq!(cfg.models.coder_fallback.as_deref(), Some("sonnet-4.5"));
    assert!(cfg.models.reviewer_fallback.is_none());
}

#[test]
fn fallback_fields_default_to_none() {
    let cfg = WorkbenchConfig::default();
    assert!(cfg.models.planner_fallback.is_none());
    assert!(cfg.models.coder_fallback.is_none());
}
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cargo test -p xai-grok-shell --lib agent::config::workbench_config_tests::workbench_models_accept_fallback_fields -- --nocapture`
Expected: FAIL — fields don't exist.

- [ ] **Step 3: Add the fields to `WorkbenchModelsConfig`**

In `config.rs`, modify the struct (located near the other `Workbench*Config` types):

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkbenchModelsConfig {
    pub planner_model: String,
    pub planner_fallback: Option<String>,
    pub adjudicator_model: String,
    pub adjudicator_fallback: Option<String>,
    pub coder_model: String,
    pub coder_fallback: Option<String>,
    pub reviewer_model: String,
    pub reviewer_fallback: Option<String>,
}

impl Default for WorkbenchModelsConfig {
    fn default() -> Self {
        Self {
            planner_model: "opus-4.1".into(),
            planner_fallback: None,
            adjudicator_model: "sonnet-4.5".into(),
            adjudicator_fallback: None,
            coder_model: "opus-4.1".into(),
            coder_fallback: None,
            reviewer_model: "sonnet-4.5".into(),
            reviewer_fallback: None,
        }
    }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib agent::config::workbench_config_tests -- --nocapture`
Expected: 2 new tests pass; all 7 existing tests still pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/agent/config.rs
git commit -m "feat(workbench v2): add per-role fallback model config"
```

---

## Phase 2 — Recovery module (M1.3)

### Task M1.3: `recovery.rs` model fallback policy

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/recovery.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs` (add `pub mod recovery;`)
- Test: `crates/codegen/xai-grok-shell/src/workbench/recovery.rs` (inline `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write failing tests for the fallback policy**

In `recovery.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn role(name: &str) -> RoleFallback { RoleFallback { primary: name.into(), fallback: Some(format!("{name}-fallback")) } }
    fn role_no_fb(name: &str) -> RoleFallback { RoleFallback { primary: name.into(), fallback: None } }

    #[test]
    fn no_fallback_when_role_has_no_fallback_configured() {
        let decision = decide_fallback(&role_no_fb("coder"), 0, false);
        assert!(decision.is_none(), "no fallback configured => no fallback decision");
    }

    #[test]
    fn no_fallback_on_first_attempt() {
        let decision = decide_fallback(&role("coder"), 0, false);
        assert!(decision.is_none(), "first attempt must not fallback");
    }

    #[test]
    fn no_fallback_when_already_fell_back() {
        let decision = decide_fallback(&role("coder"), 1, true);
        assert!(decision.is_none(), "must not use fallback twice on the same stage");
    }

    #[test]
    fn fallback_used_after_two_consecutive_failures() {
        let decision = decide_fallback(&role("coder"), 1, false);
        assert_eq!(decision.as_deref(), Some("coder-fallback"));
    }

    #[test]
    fn fallback_blocked_after_three_failures() {
        let decision = decide_fallback(&role("coder"), 2, false);
        assert!(decision.is_none(), "second fallback not allowed; route to BlockedForHuman instead");
    }
}
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cargo test -p xai-grok-shell --lib workbench::recovery -- --nocapture`
Expected: FAIL — `decide_fallback` not found.

- [ ] **Step 3: Implement `recovery.rs`**

```rust
//! Model fallback policy. Per spec §6.2.1 / D6.
//!
//! Rules:
//! - `role.fallback` must be configured (None => no fallback, behave as v1)
//! - The primary must have failed at least 2 attempts in a row (attempt >= 1)
//! - The current attempt must not have already used fallback (`fallback_used = false`)
//! - After fallback fires once and also fails, route to BlockedForHuman (D6)

#[derive(Clone, Debug)]
pub struct RoleFallback {
    pub primary: String,
    pub fallback: Option<String>,
}

/// Decide whether to switch to a fallback model on the next attempt.
/// Returns `Some(fallback_model_name)` to use the fallback, or `None` to
/// continue with the primary (or escalate to BlockedForHuman if attempts
/// are exhausted).
///
/// `attempt` is the number of completed attempts on the current stage
/// (0 = none yet, 1 = one failed, 2 = two failed, ...).
/// `fallback_used` is true if a fallback was already used for the *current*
/// stage's attempt chain.
pub fn decide_fallback(role: &RoleFallback, attempt: u8, fallback_used: bool) -> Option<String> {
    let fallback = role.fallback.as_deref()?;
    if attempt < 1 {
        return None;
    }
    if fallback_used {
        return None;
    }
    if attempt > 1 {
        // Two fallback attempts have already happened (attempt 1 + attempt 2).
        // Caller should route to BlockedForHuman.
        return None;
    }
    Some(fallback.to_string())
}

/// One-step helper: record the fallback usage in the running state.
pub fn apply_fallback(state_field: &mut Option<String>, model: &str) {
    *state_field = Some(model.to_string());
}
```

- [ ] **Step 4: Add `pub mod recovery;` to `workbench/mod.rs`**

In `crates/codegen/xai-grok-shell/src/workbench/mod.rs`, append after the existing `pub mod` lines:

```rust
pub mod recovery;
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib workbench::recovery -- --nocapture`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/recovery.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench v2): recovery module with model fallback policy"
```

---

## Phase 3 — Runner JSON parsing (M1.4)

### Task M1.4: Runner nextest detection + JSON event parsing

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/runner.rs` (add `nextest` detection + JSON event streaming)
- Test: `crates/codegen/xai-grok-shell/src/workbench/runner.rs` (existing `mod tests`)

- [ ] **Step 1: Write failing tests for nextest detection + event parser**

Append to the existing `mod tests` in `runner.rs`:

```rust
#[test]
fn nextest_available_detects_binary() {
    // On Windows: `where`; on Unix: `which`. We just check that
    // the helper doesn't panic and returns a bool.
    let _ = is_nextest_available();
}

#[test]
fn nextest_event_parses_test_passed() {
    let line = r#"{"event":"test-passed","name":"tests::foo","elapsed_secs":0.012}"#;
    let e = parse_nextest_line(line).expect("should parse");
    assert_eq!(e.name, "tests::foo");
    assert!(matches!(e.kind, NextestEventKind::Passed));
}

#[test]
fn nextest_event_parses_test_failed_with_message() {
    let line = r#"{"event":"test-failed","name":"tests::bar","stdout":{"message":"boom"}}"#;
    let e = parse_nextest_line(line).expect("should parse");
    assert_eq!(e.name, "tests::bar");
    assert!(matches!(e.kind, NextestEventKind::Failed));
    if let NextestEventKind::Failed = e.kind {
        assert_eq!(e.message.as_deref(), Some("boom"));
    }
}

#[test]
fn nextest_event_ignores_unknown() {
    assert!(parse_nextest_line("not json").is_none());
    assert!(parse_nextest_line(r#"{"event":"run-started"}"#).is_none());
}
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cargo test -p xai-grok-shell --lib workbench::runner::tests::nextest_event_parses_test_passed -- --nocapture`
Expected: FAIL — `is_nextest_available` and `parse_nextest_line` not found.

- [ ] **Step 3: Add the helpers + struct in `runner.rs`**

At the top of `runner.rs`, after the existing `pub struct RunResult`, append:

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NextestEventKind {
    Started,
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug)]
pub struct NextestEvent {
    pub name: String,
    pub kind: NextestEventKind,
    pub message: Option<String>,
}

pub fn is_nextest_available() -> bool {
    // Resolve "cargo-nextest" via `which` (Unix) or `where` (Windows).
    let probe = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(probe)
        .arg("cargo-nextest")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn parse_nextest_line(line: &str) -> Option<NextestEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let event = v.get("event")?.as_str()?;
    let name = v.get("name")?.as_str()?.to_string();
    let kind = match event {
        "test-started" => NextestEventKind::Started,
        "test-passed" => NextestEventKind::Passed,
        "test-failed" => NextestEventKind::Failed,
        "test-skipped" => NextestEventKind::Skipped,
        _ => return None,
    };
    let message = v
        .get("stdout")
        .and_then(|s| s.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());
    Some(NextestEvent { name, kind, message })
}
```

Also add `serde_json` to the `use` lines at the top of `runner.rs` if not present:

```rust
use serde_json::Value as JsonValue;
```

(Or, simpler, just add `use serde_json;` and call `serde_json::from_str` directly in `parse_nextest_line`.)

- [ ] **Step 4: Add the `nextest` runner path to `run_and_capture`**

Extend the existing `run_and_capture` to take an optional `force_nextest: bool` parameter; when set (and `is_nextest_available()` is true), wrap the command as `cargo nextest run --message-format json` and stream stdout line-by-line into `parse_nextest_line` events. The `RunResult` struct gains a new `nextest_events: Vec<NextestEvent>` field (default empty) for the orchestrator to write to `workbench_task_metrics`.

For v2, the simplest workable shape: keep the v1 `RunResult` signature but add an out-param `Vec<NextestEvent>`. Update the v1 callers in `orchestrator.rs` to pass `&mut vec![]`. (Keeping the function signature stable minimizes churn.)

Edit `runner.rs`:

```rust
#[derive(Clone, Debug)]
pub struct RunResult {
    pub command: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// Per-test events parsed from `cargo nextest --message-format json`.
    /// Empty when nextest is not used (v1 default).
    pub nextest_events: Vec<NextestEvent>,
}
```

Update the existing `RunResult { ... }` literal in `write_artifact`'s test to include `nextest_events: vec![]` (it'll fail to compile until you do).

Update the `Ok(RunResult { ... })` in `run_and_capture` to populate `nextest_events`:

```rust
Ok(RunResult {
    command: cmd.into(),
    exit_code,
    stdout,
    stderr,
    duration_ms: started.elapsed().as_millis() as u64,
    nextest_events: Vec::new(),  // populated by callers when nextest is used
})
```

- [ ] **Step 5: Run all runner tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib workbench::runner -- --nocapture`
Expected: 6 (v1) + 4 (new) = 10 tests pass.

- [ ] **Step 6: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/runner.rs
git commit -m "feat(workbench v2): nextest detection + JSON event parser"
```

---

## Phase 4 — Metrics table (M1.5)

### Task M1.5: New `workbench_task_metrics` table + DAO

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/tapd/store.rs` (add migration + DAO methods)
- Test: `crates/codegen/xai-grok-shell/src/tapd/store.rs` (existing `mod tests`)

- [ ] **Step 1: Write failing tests for the new DAO**

Append to the existing `mod tests` in `store.rs`:

```rust
#[test]
fn workbench_task_metrics_round_trip() {
    let (store, _dir) = store();
    store.record_task_metric(
        "TAPD-1", "develop", 0, 100, 200, "opus-4.1", 0, Some("child-1")
    ).unwrap();
    let rows = store.task_metrics("TAPD-1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].stage, "develop");
    assert_eq!(rows[0].model.as_deref(), Some("opus-4.1"));
    assert_eq!(rows[0].fallback_used, 0);
    assert_eq!(rows[0].child_session_id.as_deref(), Some("child-1"));
}

#[test]
fn workbench_task_metrics_overwrites_same_stage_attempt() {
    let (store, _dir) = store();
    store.record_task_metric("TAPD-1", "verify", 0, 100, 150, "opus-4.1", 0, None).unwrap();
    // Re-record the same (task, stage, attempt) with finished_at advanced
    store.record_task_metric("TAPD-1", "verify", 0, 100, 300, "opus-4.1", 0, None).unwrap();
    let rows = store.task_metrics("TAPD-1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].finished_at, 300);
}

#[test]
fn mr_comment_round_trip() {
    let (store, _dir) = store();
    store.insert_mr_comment("TAPD-1", "https://gl/mr/1", "alice", "looks good").unwrap();
    let unconsumed = store.unconsumed_mr_comments("TAPD-1").unwrap();
    assert_eq!(unconsumed.len(), 1);
    assert_eq!(unconsumed[0].author, "alice");
    assert_eq!(unconsumed[0].body, "looks good");
    store.mark_mr_comment_consumed(unconsumed[0].id).unwrap();
    let after = store.unconsumed_mr_comments("TAPD-1").unwrap();
    assert!(after.is_empty());
}
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cargo test -p xai-grok-shell --lib tapd::store::tests::workbench_task_metrics_round_trip -- --nocapture`
Expected: FAIL — methods not found.

- [ ] **Step 3: Add the migration + struct + DAO methods**

In `store.rs`, find the existing `migrate` function and append the new tables to the `execute_batch` call (after the `workbench_task_state` table):

```rust
            "CREATE TABLE IF NOT EXISTS workbench_task_metrics (
                task_id          TEXT NOT NULL,
                stage            TEXT NOT NULL,
                attempt          INTEGER NOT NULL,
                started_at       INTEGER NOT NULL,
                finished_at      INTEGER,
                duration_ms      INTEGER,
                model            TEXT,
                fallback_used    INTEGER NOT NULL DEFAULT 0,
                child_session_id TEXT,
                PRIMARY KEY (task_id, stage, attempt)
            );

            CREATE TABLE IF NOT EXISTS workbench_mr_comments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                tapd_id     TEXT NOT NULL,
                mr_url      TEXT NOT NULL,
                author      TEXT NOT NULL,
                body        TEXT NOT NULL,
                received_at INTEGER NOT NULL,
                consumed    INTEGER NOT NULL DEFAULT 0
            );
"#
```

Add the data structs and DAO methods to `impl TapdStore`:

```rust
#[derive(Clone, Debug)]
pub struct TaskMetricRow {
    pub task_id: String,
    pub stage: String,
    pub attempt: u8,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub model: Option<String>,
    pub fallback_used: i64,
    pub child_session_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct MrCommentRow {
    pub id: i64,
    pub tapd_id: String,
    pub mr_url: String,
    pub author: String,
    pub body: String,
    pub received_at: i64,
    pub consumed: bool,
}

impl TapdStore {
    /// Upsert a per-(task, stage, attempt) metric row. `fallback_used` is
    /// 0 or 1; the caller passes the int to keep the SQL i64.
    pub fn record_task_metric(
        &self,
        task_id: &str,
        stage: &str,
        attempt: u8,
        started_at: i64,
        finished_at: i64,
        model: &str,
        fallback_used: i64,
        child_session_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.open()?;
        let duration = finished_at - started_at;
        conn.execute(
            "INSERT INTO workbench_task_metrics
                (task_id, stage, attempt, started_at, finished_at, duration_ms, model, fallback_used, child_session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(task_id, stage, attempt) DO UPDATE SET
                started_at = excluded.started_at,
                finished_at = excluded.finished_at,
                duration_ms = excluded.duration_ms,
                model = excluded.model,
                fallback_used = excluded.fallback_used,
                child_session_id = excluded.child_session_id",
            rusqlite::params![task_id, stage, attempt, started_at, finished_at, duration, model, fallback_used, child_session_id],
        )?;
        Ok(())
    }

    pub fn task_metrics(&self, task_id: &str) -> rusqlite::Result<Vec<TaskMetricRow>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT task_id, stage, attempt, started_at, finished_at, duration_ms, model, fallback_used, child_session_id
             FROM workbench_task_metrics WHERE task_id = ?1 ORDER BY started_at ASC"
        )?;
        let rows = stmt.query_map(rusqlite::params![task_id], |row| {
            Ok(TaskMetricRow {
                task_id: row.get(0)?,
                stage: row.get(1)?,
                attempt: row.get(2)?,
                started_at: row.get(3)?,
                finished_at: row.get(4)?,
                duration_ms: row.get(5)?,
                model: row.get(6)?,
                fallback_used: row.get(7)?,
                child_session_id: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn insert_mr_comment(
        &self,
        tapd_id: &str,
        mr_url: &str,
        author: &str,
        body: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.open()?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO workbench_mr_comments (tapd_id, mr_url, author, body, received_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![tapd_id, mr_url, author, body, now],
        )?;
        Ok(())
    }

    pub fn unconsumed_mr_comments(&self, tapd_id: &str) -> rusqlite::Result<Vec<MrCommentRow>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT id, tapd_id, mr_url, author, body, received_at, consumed
             FROM workbench_mr_comments WHERE tapd_id = ?1 AND consumed = 0 ORDER BY received_at ASC"
        )?;
        let rows = stmt.query_map(rusqlite::params![tapd_id], |row| {
            Ok(MrCommentRow {
                id: row.get(0)?,
                tapd_id: row.get(1)?,
                mr_url: row.get(2)?,
                author: row.get(3)?,
                body: row.get(4)?,
                received_at: row.get(5)?,
                consumed: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn mark_mr_comment_consumed(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.open()?;
        conn.execute("UPDATE workbench_mr_comments SET consumed = 1 WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }
}
```

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib tapd::store::tests::workbench_task_metrics_round_trip tapd::store::tests::workbench_task_metrics_overwrites_same_stage_attempt tapd::store::tests::mr_comment_round_trip -- --nocapture`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full tapd::store test suite to confirm no regression**

Run: `cargo test -p xai-grok-shell --lib tapd::store -- --nocapture`
Expected: All existing + 3 new tests pass.

- [ ] **Step 6: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/tapd/store.rs
git commit -m "feat(workbench v2): workbench_task_metrics + workbench_mr_comments tables"
```

---

## Phase 5 — State machine replay (M1.6)

### Task M1.6: `next_after_replay` transition + replay ext method stub

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` (add `next_after_replay`)
- Test: `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` (existing `mod tests`)

- [ ] **Step 1: Write failing tests**

Append:

```rust
#[test]
fn next_after_replay_routes_to_named_stage_with_attempt_zero() {
    let next = next_after_replay(Stage::Develop, 0);
    assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 0, .. }));
}

#[test]
fn next_after_replay_resets_attempt_even_when_old_attempt_high() {
    let next = next_after_replay(Stage::CodeReview, 5);
    // Even if a prior run got to attempt 5, replay starts at attempt 0.
    assert!(matches!(next, TaskState::Running { stage: Stage::CodeReview, attempt: 0, .. }));
}

#[test]
fn next_after_replay_clears_fallback_model_field() {
    let next = next_after_replay(Stage::Verify, 2);
    match next {
        TaskState::Running { fallback_model, last_error, .. } => {
            assert!(fallback_model.is_none());
            assert!(last_error.is_none());
        }
        _ => panic!("expected Running"),
    }
}
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine::tests::next_after_replay_routes_to_named_stage_with_attempt_zero -- --nocapture`
Expected: FAIL — `next_after_replay` not found.

- [ ] **Step 3: Implement `next_after_replay`**

Append to `state_machine.rs`:

```rust
/// Restart a task from a given stage. Resets `attempt` to 0 and clears
/// `fallback_model` + `last_error` (the prior chain's state is no longer
/// relevant for the new chain). Used by `x.ai/workbench/replay` (D16).
pub fn next_after_replay(stage: Stage, _old_attempt: u8) -> TaskState {
    TaskState::Running {
        stage,
        attempt: 0,
        started_at: chrono::Utc::now().timestamp(),
        fallback_model: None,
        last_error: None,
    }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine -- --nocapture`
Expected: 3 new tests pass; ~28 total state-machine tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/state_machine.rs
git commit -m "feat(workbench v2): next_after_replay transition for destructive replay"
```

---

## Phase 6 — Worktree reuse (M1.7)

### Task M1.7: `worktree_manager::reuse_worktree`

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs` (add `reuse_worktree` + tests)
- Test: `crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs` (existing `mod tests`)

- [ ] **Step 1: Write failing tests**

Append to the existing `mod tests` in `worktree_manager.rs`:

```rust
#[test]
fn reuse_worktree_returns_existing_path_when_present() {
    let tmp = tempfile::tempdir().unwrap();
    let grok_home = tmp.path();
    let task_id = "TAPD-99";
    let wt = worktree_path(grok_home.to_str().unwrap(), task_id);
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join("marker.txt"), "from prior run").unwrap();

    let returned = reuse_worktree(grok_home.to_str().unwrap(), task_id).unwrap();
    assert_eq!(returned, wt);
    // marker is preserved (we did not nuke the directory)
    assert!(returned.join("marker.txt").exists());
}

#[test]
fn reuse_worktree_creates_when_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let grok_home = tmp.path();
    let returned = reuse_worktree(grok_home.to_str().unwrap(), "TAPD-NEW").unwrap();
    assert!(returned.exists());
}
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cargo test -p xai-grok-shell --lib workbench::worktree_manager::tests::reuse_worktree_returns_existing_path_when_present -- --nocapture`
Expected: FAIL — function not found.

- [ ] **Step 3: Implement `reuse_worktree`**

Append to `worktree_manager.rs`:

```rust
/// Return the worktree path for a task, creating an empty placeholder
/// directory if none exists. Unlike `create_worktree` (which calls
/// `git worktree add`), this function does NOT touch git. It is used
/// during the `replay` path: the orchestrator calls `git fetch` +
/// `git reset --hard origin/<branch>` in the returned path before
/// driving the new run.
///
/// Used by v2 spec §6.2.4 (D8): opt-in per project via
/// `[tapd.projects.<key>].reuse_worktree = true`.
pub fn reuse_worktree(grok_home: &str, task_id: &str) -> std::io::Result<std::path::PathBuf> {
    let path = worktree_path(grok_home, task_id);
    if path.exists() {
        return Ok(path);
    }
    std::fs::create_dir_all(&path)?;
    Ok(path)
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib workbench::worktree_manager -- --nocapture`
Expected: 11 tests pass (8 v1 + 2 v2 + 1 v2 GC).

- [ ] **Step 5: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs
git commit -m "feat(workbench v2): reuse_worktree for replay path (D8)"
```

---

## Phase 7 — v1 backward-compat e2e (M1.8)

### Task M1.8: E2E: load a v1-shaped `state.json`

**Files:**
- Create: `crates/codegen/xai-grok-shell/tests/workbench_v1_state_compat.rs`

- [ ] **Step 1: Write the test**

```rust
//! v1-shaped `state.json` files must still deserialize cleanly under v2.
//! v1 only wrote `{"Running":{"stage":"...","attempt":0,"started_at":0}}`;
//! v2 adds `fallback_model` and `last_error` fields with `#[serde(default)]`.

use xai_grok_shell::workbench::state_machine::{Stage, TaskState};

#[test]
fn v1_state_json_loads_into_v2_running_with_none_fields() {
    let v1 = r#"{"kind":"running","stage":"develop","attempt":2,"started_at":1700000000}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 state.json should still load");
    match s {
        TaskState::Running { stage, attempt, started_at, fallback_model, last_error, .. } => {
            assert_eq!(stage, Stage::Develop);
            assert_eq!(attempt, 2);
            assert_eq!(started_at, 1700000000);
            assert!(fallback_model.is_none());
            assert!(last_error.is_none());
        }
        _ => panic!("expected Running"),
    }
}

#[test]
fn v1_state_json_with_done_loads() {
    let v1 = r#"{"kind":"done","mr_url":"https://x","finished_at":1700001000}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 Done should still load");
    assert!(matches!(s, TaskState::Done { .. }));
}

#[test]
fn v1_state_json_with_blocked_loads() {
    let v1 = r#"{"kind":"blocked_for_human","stage":"adjudicate","reason":"q1","payload":{}}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 BlockedForHuman should still load");
    match s {
        TaskState::BlockedForHuman { stage, .. } => assert_eq!(stage, Stage::Adjudicate),
        _ => panic!("expected BlockedForHuman"),
    }
}

#[test]
fn v1_state_json_with_dead_loads() {
    let v1 = r#"{"kind":"dead","reason":"runner crash"}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 Dead should still load");
    assert!(matches!(s, TaskState::Dead { .. }));
}
```

- [ ] **Step 2: Run the new tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --test workbench_v1_state_compat -- --nocapture`
Expected: 4 tests pass. (If any fail, the v2 `#[serde(default)]` decorations are missing; revisit Tasks M1.1 / M1.6.)

- [ ] **Step 3: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/tests/workbench_v1_state_compat.rs
git commit -m "test(workbench v2): v1-shaped state.json deserializes cleanly"
```

---

## Phase 8 — M1 e2e integration (M1.8 = recovery_e2e)

> Phase 7 is the M1.8 backward-compat task (already split out). This phase is the M1.8 *integration* test that exercises the new `recovery` + `state_machine` fields end-to-end.

### Task M1.9: E2E: model fallback + recovery flow

**Files:**
- Create: `crates/codegen/xai-grok-shell/tests/recovery_e2e.rs`

- [ ] **Step 1: Write the test**

```rust
//! Verifies the v2 spec §6.2.1 model fallback policy end-to-end against
//! the in-memory `WorkbenchConfig` + `state_machine` + `recovery` modules.
//! The LLM calls are still stubbed in v2 M1; the test exercises the
//! *policy* (when to use fallback) rather than real network calls.

use xai_grok_shell::agent::config::{WorkbenchConfig, WorkbenchModelsConfig};
use xai_grok_shell::workbench::recovery::{decide_fallback, RoleFallback};
use xai_grok_shell::workbench::state_machine::{next_after_develop, Stage, TaskState};

fn cfg_with_fallbacks() -> WorkbenchConfig {
    let mut cfg = WorkbenchConfig::default();
    cfg.models = WorkbenchModelsConfig {
        planner_model: "opus-4.1".into(),
        planner_fallback: None,
        adjudicator_model: "sonnet-4.5".into(),
        adjudicator_fallback: None,
        coder_model: "opus-4.1".into(),
        coder_fallback: Some("sonnet-4.5".into()),
        reviewer_model: "sonnet-4.5".into(),
        reviewer_fallback: None,
    };
    cfg
}

fn coder_role(cfg: &WorkbenchConfig) -> RoleFallback {
    RoleFallback {
        primary: cfg.models.coder_model.clone(),
        fallback: cfg.models.coder_fallback.clone(),
    }
}

#[test]
fn fallback_decision_after_develop_failure_then_routes_to_develop_again() {
    let cfg = cfg_with_fallbacks();
    // 1st Develop attempt fails. State machine increments attempt to 1.
    let next = next_after_develop(false, 0);
    assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 1, .. }));
    // 2nd Develop attempt also fails (attempt=1 means one prior fail).
    // decide_fallback with attempt=1 + no fallback_used => returns Some.
    let decision = decide_fallback(&coder_role(&cfg), 1, false);
    assert_eq!(decision.as_deref(), Some("sonnet-4.5"));
    // 3rd attempt uses the fallback. If it also fails, state machine
    // routes to Dead (develop retries exhausted at attempt 3).
    let next = next_after_develop(false, 2);
    assert!(matches!(next, TaskState::Dead { .. }));
}

#[test]
fn no_fallback_when_role_has_no_fallback_configured() {
    let mut cfg = WorkbenchConfig::default();
    cfg.models.coder_fallback = None;
    // 1st Develop attempt fails (attempt 1) — no fallback configured,
    // so decide_fallback returns None even though attempt >= 1.
    let decision = decide_fallback(&coder_role(&cfg), 1, false);
    assert!(decision.is_none());
    // State machine still routes to next Develop attempt (or Dead if
    // attempt 3). The orchestrator consults decide_fallback and falls
    // back to v1 behavior (no fallback) when None.
}
```

- [ ] **Step 2: Run the new tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --test recovery_e2e -- --nocapture`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/tests/recovery_e2e.rs
git commit -m "test(workbench v2): recovery e2e covers fallback success + exhaust"
```

---

## M1 completion gate

After all 8 M1 tasks land, M1 is **done**. M1 is the first shippable slice of v2. Before starting M2, verify:

- [ ] `cargo test -p xai-grok-shell --lib` passes (no regression in any v1 test)
- [ ] `cargo test -p xai-grok-shell --test workbench_v1_state_compat --test workbench_orchestrator_e2e --test workbench_pipeline_e2e --test recovery_e2e -- --nocapture` all pass
- [ ] `cargo check -p xai-grok-shell` passes
- [ ] Tag the commit: `git tag v2-m1-reliable`
- [ ] Then start M2.

**Do not start M2 if any M1 test fails.** Fix the regression first.

---

# Milestone 1 (M1) is done.
# Milestones 2 (M2) and 3 (M3) will be added in a separate plan file
# after the M1 branch is merged and the v2 spec's M2/M3 sections are
# reviewed against actual M1 outcomes. M1 is self-contained: the
# reliability improvements ship independently of control/observability.
# Generating a single 28-task plan file would be misleading because
# M2/M3 are likely to be re-estimated once M1 is in production.

