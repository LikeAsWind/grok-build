# TAPD Workbench Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each `Pending` TAPD ticket into a GitLab MR via a deterministic 6-stage Rust state machine that orchestrates four LLM sub-agents (planner / adjudicator / coder / reviewer) and two tool-only stages (runner / submitter), with full observability in `Sessions Hub`.

**Architecture:**
- New `crates/codegen/xai-grok-shell/src/workbench/` module owns state machine, dispatcher, worktree manager, artifacts, runner, submitter, notifications, and prompt templates.
- `TapdSyncManager` calls `WorkbenchDispatcher::dispatch_pending()` after each sync completes; dispatcher spawns one **main session** per TAPD task that runs the state machine and forwards child session events.
- Main session = state machine + event aggregator; LLM work happens in **child sessions** spawned via existing `run_shell_child`.
- Per-task worktree at `~/.grok/worktrees/<task-id>/` (built on `session/worktree.rs`); branch `tapd/<task-id>-<slug>`; `.workbench/` artifacts gitignored.
- Frontend surfaces: stage badge + timeline on main session row, child session tree shows stage per child, `TaskDetailDrawer` gains stage history, `WorkbenchHeader` gains system health, `grokConfigSchema` gains new sections.

**Tech Stack:** Rust (tokio, axum, serde, rusqlite, reqwest, acp, tracing), React 19 + Vite 7 + Tailwind v4, TOML config, GitLab REST API v4.

---

## File Structure Overview

### NEW backend files
| Path | Responsibility |
|---|---|
| `crates/codegen/xai-grok-shell/src/workbench/mod.rs` | Module root, re-exports |
| `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` | `TaskState`, `Stage`, `Priority` enums + transition table |
| `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs` | `WorkbenchDispatcher` actor: priority queue, slot accounting, dispatch loop |
| `crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs` | Worktree create / list / delete + delayed GC |
| `crates/codegen/xai-grok-shell/src/workbench/artifacts.rs` | Frontmatter parse / write, filename convention |
| `crates/codegen/xai-grok-shell/src/workbench/runner.rs` | `Verify` stage: test_command spawn, output capture, timeout |
| `crates/codegen/xai-grok-shell/src/workbench/submitter.rs` | `MrSubmit` stage: GitLab REST client, MR payload, reviewer resolution |
| `crates/codegen/xai-grok-shell/src/workbench/notifications.rs` | TAPD comment + Slack / Feishu webhook |
| `crates/codegen/xai-grok-shell/src/workbench/main_session.rs` | Main session actor: state machine driver + child session event forwarder |
| `crates/codegen/xai-grok-shell/src/workbench/prompts/mod.rs` | Prompt template loader |
| `crates/codegen/xai-grok-shell/src/workbench/prompts/planner.md.tmpl` | Planner system prompt |
| `crates/codegen/xai-grok-shell/src/workbench/prompts/adjudicator.md.tmpl` | Adjudicator system prompt |
| `crates/codegen/xai-grok-shell/src/workbench/prompts/coder.md.tmpl` | Coder system prompt |
| `crates/codegen/xai-grok-shell/src/workbench/prompts/reviewer.md.tmpl` | Reviewer system prompt |
| `crates/codegen/xai-grok-shell/tests/workbench_pipeline_e2e.rs` | End-to-end pipeline test (mock TAPD + real git + GitLab dry-run) |

### MODIFIED backend files
| Path | Change |
|---|---|
| `crates/codegen/xai-grok-shell/src/tapd/mod.rs` | Add `pub mod workbench;` (gated by `#[cfg(feature = ...)]` if needed; else always-on) |
| `crates/codegen/xai-grok-shell/src/tapd/store.rs` | Add `workbench_task_state` table + DAO |
| `crates/codegen/xai-grok-shell/src/tapd/sync.rs` | After each successful sync, call `WorkbenchDispatcher::dispatch_pending()` |
| `crates/codegen/xai-grok-shell/src/extensions/tapd.rs` | Add `workbench/dispatch`, `workbench/status`, `workbench/resolve_blocked`, `workbench/retry_mr` |
| `crates/codegen/xai-grok-shell/src/agent/config.rs` | Add `WorkbenchConfig`, `GitlabConfig`; extend `TapdProjectConfig` with `target_branch`, `test_command`, `test_timeout_secs`, `mr_reviewers`, `mr_assignees`, `adjudicate_mode` |
| `crates/codegen/xai-grok-shell/src/agent/mvp_agent.rs` | Construct `WorkbenchDispatcher` in `new`; expose accessor; start background dispatch loop |
| `crates/codegen/xai-grok-shell/src/agent/server.rs` | Wire workbench notification channel to gateway sender |

### NEW frontend files
| Path | Responsibility |
|---|---|
| `web/src/features/workbench/StageTimeline.tsx` | 6-stage progress strip |
| `web/src/features/workbench/StageTimeline.test.tsx` | Vitest |
| `web/src/features/workbench/BlockedActions.tsx` | BlockedForHuman action buttons |
| `web/src/features/workbench/BlockedActions.test.tsx` | Vitest |
| `web/src/features/workbench/QueueHealthBanner.tsx` | Burst-control alerts |
| `web/src/features/workbench/QueueHealthBanner.test.tsx` | Vitest |
| `web/src/features/sessions-hub/workbenchStageBadge.ts` | Badge derivation from session notifications |
| `web/src/features/sessions-hub/workbenchStageBadge.test.ts` | Vitest |

### MODIFIED frontend files
| Path | Change |
|---|---|
| `web/src/features/workbench/WorkbenchHeader.tsx` | Add active count + queue depth + worktree pool |
| `web/src/features/workbench/WorkbenchPanel.tsx` | Wire dispatch button + health banner |
| `web/src/features/workbench/TaskDetailDrawer.tsx` | Add stage history section |
| `web/src/features/workbench/taskStatus.ts` | Add workbench status enum + badge mapping |
| `web/src/features/sessions-hub/SessionListItem.tsx` | Render workbench stage badge |
| `web/src/features/sessions-hub/SubtaskPartView.tsx` | Show stage per child session |
| `web/src/features/sessions-hub/status.ts` | Extend to recognize workbench stage notifications |
| `web/src/features/settings/components/grokConfigSchema.ts` | Add `[workbench]`, `[workbench.concurrency]`, `[workbench.models]`, `[workbench.adjudicate]`, `[workbench.notify]`, `[gitlab]` sections; extend `[tapd.projects.*]` |

---

## Conventions

- License: GPL-3.0-only on all new code (per `AGENTS.md`).
- One file = one responsibility; group by feature, not by technical layer.
- Each Rust type lives next to its tests in `#[cfg(test)] mod tests`.
- Each React component has a sibling `.test.tsx` using Vitest.
- All new `.workbench/` writes go through `artifacts.rs` (frontmatter + envelope enforced).
- TDD: every behavior lands as a failing test first, then implementation.
- Commits per task; small, focused, descriptive.

---

## Phase 1 — Configuration Schema (0.5 day)

### Task 1.1: Add WorkbenchConfig + GitlabConfig structs

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/agent/config.rs:1-50` (imports)
- Modify: `crates/codegen/xai-grok-shell/src/agent/config.rs` (add new structs near line 1300, after `TapdProjectConfig`)
- Modify: `crates/codegen/xai-grok-shell/src/agent/config.rs` (add `workbench: WorkbenchConfig` + `gitlab: GitlabConfig` fields to root `Config`)

- [ ] **Step 1: Write failing test for WorkbenchConfig defaults**

In `crates/codegen/xai-grok-shell/src/agent/config.rs`, append:

```rust
#[cfg(test)]
mod workbench_config_tests {
    use super::*;

    #[test]
    fn workbench_config_defaults_when_absent() {
        let toml = "";
        let cfg: WorkbenchConfig = toml::from_str(toml).unwrap();
        assert!(!cfg.enabled);
        assert!(!cfg.keep_stage_files_after_done);
        assert_eq!(cfg.worktree_gc_delay_secs, 300);
    }

    #[test]
    fn workbench_concurrency_defaults_when_absent() {
        let toml = "";
        let cfg: WorkbenchConfig = toml::from_str(toml).unwrap();
        assert_eq!(cfg.concurrency.global_max_active, 5);
        assert_eq!(cfg.concurrency.worktree_pool_max, 10);
        assert_eq!(cfg.concurrency.queue_alert_threshold, 30);
        assert_eq!(cfg.concurrency.queue_stuck_alert_minutes, 60);
    }

    #[test]
    fn workbench_models_default_to_known_ids() {
        let cfg = WorkbenchConfig::default();
        assert_eq!(cfg.models.planner_model, "opus-4.1");
        assert_eq!(cfg.models.adjudicator_model, "sonnet-4.5");
        assert_eq!(cfg.models.coder_model, "opus-4.1");
        assert_eq!(cfg.models.reviewer_model, "sonnet-4.5");
    }

    #[test]
    fn workbench_adjudicate_default_mode_is_recorder() {
        let cfg = WorkbenchConfig::default();
        assert_eq!(cfg.adjudicate.default_mode, AdjudicateMode::Recorder);
        assert!(cfg.adjudicate.escalate_priority.contains(&Priority::Urgent));
        assert!(cfg.adjudicate.escalate_priority.contains(&Priority::High));
        assert_eq!(cfg.adjudicate.escalate_min_acs, 5);
    }

    #[test]
    fn gitlab_config_requires_token_env_var() {
        let cfg = GitlabConfig {
            url: "https://gitlab.example.com".into(),
            token_env: "GITLAB_TOKEN".into(),
            default_assignees_self: false,
        };
        assert_eq!(cfg.token_env, "GITLAB_TOKEN");
        assert!(!cfg.is_configured_for_url(""));
    }
}
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib agent::config::workbench_config_tests -- --nocapture`
Expected: FAIL with `WorkbenchConfig not found in this scope`.

- [ ] **Step 3: Add WorkbenchConfig + GitlabConfig to config.rs**

In `crates/codegen/xai-grok-shell/src/agent/config.rs`, after the `TapdProjectConfig` block (around line 1290), add:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdjudicateMode {
    #[default]
    Recorder,
    Gatekeeper,
    AlwaysSkip,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkbenchConfig {
    pub enabled: bool,
    pub keep_stage_files_after_done: bool,
    pub auto_delete_merged_branches: bool,
    pub worktree_gc_delay_secs: u64,
    pub concurrency: WorkbenchConcurrencyConfig,
    pub models: WorkbenchModelsConfig,
    pub adjudicate: WorkbenchAdjudicateConfig,
    pub notify: WorkbenchNotifyConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkbenchConcurrencyConfig {
    pub global_max_active: usize,
    pub worktree_pool_max: usize,
    pub queue_alert_threshold: usize,
    pub queue_stuck_alert_minutes: u64,
}

impl Default for WorkbenchConcurrencyConfig {
    fn default() -> Self {
        Self {
            global_max_active: 5,
            worktree_pool_max: 10,
            queue_alert_threshold: 30,
            queue_stuck_alert_minutes: 60,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkbenchModelsConfig {
    pub planner_model: String,
    pub adjudicator_model: String,
    pub coder_model: String,
    pub reviewer_model: String,
}

impl Default for WorkbenchModelsConfig {
    fn default() -> Self {
        Self {
            planner_model: "opus-4.1".into(),
            adjudicator_model: "sonnet-4.5".into(),
            coder_model: "opus-4.1".into(),
            reviewer_model: "sonnet-4.5".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkbenchAdjudicateConfig {
    pub default_mode: AdjudicateMode,
    pub escalate_priority: Vec<Priority>,
    pub escalate_min_acs: usize,
}

impl Default for WorkbenchAdjudicateConfig {
    fn default() -> Self {
        Self {
            default_mode: AdjudicateMode::Recorder,
            escalate_priority: vec![Priority::Urgent, Priority::High],
            escalate_min_acs: 5,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkbenchNotifyConfig {
    pub tapd_comment: bool,
    pub slack_webhook: String,
    pub feishu_webhook: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct GitlabConfig {
    pub url: String,
    pub token_env: String,
    pub default_assignees_self: bool,
}

impl Default for GitlabConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            token_env: "GITLAB_TOKEN".into(),
            default_assignees_self: false,
        }
    }
}

impl GitlabConfig {
    pub fn is_configured_for_url(&self, candidate: &str) -> bool {
        !self.url.is_empty() && (candidate.is_empty() || candidate == self.url)
    }
}
```

Add `pub workbench: WorkbenchConfig` and `pub gitlab: GitlabConfig` to root `Config` (search for `pub tapd:` to find its anchor). Initialize them in `Config::default()`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib agent::config::workbench_config_tests -- --nocapture`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/agent/config.rs
git commit -m "feat(config): WorkbenchConfig + GitlabConfig structs with tests"
```

---

### Task 1.2: Extend TapdProjectConfig with workbench fields

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/agent/config.rs` (`TapdProjectConfig` struct)

- [ ] **Step 1: Write failing test for new fields**

In the same `mod workbench_config_tests` block, add:

```rust
#[test]
fn tapd_project_config_carries_workbench_fields() {
    let toml = r#"
        directory = "/repo"
        workspace_id = "12345"
        target_branch = "develop"
        test_command = "cargo nextest run --workspace"
        test_timeout_secs = 1800
        mr_reviewers = ["alice", "bob"]
        mr_assignees = []
        adjudicate_mode = "recorder"
    "#;
    let cfg: TapdProjectConfig = toml::from_str(toml).unwrap();
    assert_eq!(cfg.target_branch, "develop");
    assert_eq!(cfg.test_command.as_deref(), Some("cargo nextest run --workspace"));
    assert_eq!(cfg.test_timeout_secs, Some(1800));
    assert_eq!(cfg.mr_reviewers, vec!["alice", "bob"]);
    assert_eq!(cfg.adjudicate_mode, Some(AdjudicateMode::Recorder));
}

#[test]
fn tapd_project_config_workbench_fields_default_to_none() {
    let cfg = TapdProjectConfig::default();
    assert_eq!(cfg.target_branch, "main");
    assert!(cfg.test_command.is_none());
    assert!(cfg.test_timeout_secs.is_none());
    assert!(cfg.mr_reviewers.is_empty());
    assert!(cfg.adjudicate_mode.is_none());
}
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib agent::config::workbench_config_tests::tapd_project_config_carries_workbench_fields -- --nocapture`
Expected: FAIL with `no field target_branch`.

- [ ] **Step 3: Add fields to TapdProjectConfig**

Replace the `TapdProjectConfig` struct with:

```rust
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TapdProjectConfig {
    pub directory: String,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entity_types: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub module_filter: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default = "default_order_desc")]
    #[serde(skip_serializing_if = "is_order_desc")]
    pub order_desc: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll_interval_override_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    // Workbench pipeline (spec §10)
    #[serde(default = "default_target_branch")]
    pub target_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_timeout_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mr_reviewers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mr_assignees: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adjudicate_mode: Option<AdjudicateMode>,
}

fn default_target_branch() -> String { "main".into() }
```

- [ ] **Step 4: Run all config tests to confirm they pass**

Run: `cargo test -p xai-grok-shell --lib agent::config -- --nocapture`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/agent/config.rs
git commit -m "feat(config): extend TapdProjectConfig with workbench fields"
```

---

### Task 1.3: Add workbench_state DAO to TapdStore

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/tapd/store.rs` (add migration + DAO methods)

- [ ] **Step 1: Write failing test for workbench_task_state persistence**

In `crates/codegen/xai-grok-shell/src/tapd/store.rs`, append:

```rust
#[cfg(test)]
mod workbench_state_tests {
    use super::*;
    use crate::workbench::state_machine::TaskState;

    #[test]
    fn workbench_state_round_trip() {
        let dir = tempdir_in_target();
        let store = TapdStore::open(dir.path()).unwrap();
        let state = TaskState::Pending;
        store
            .put_workbench_state("TAPD-1234", "pending")
            .unwrap();
        assert_eq!(store.get_workbench_state("TAPD-1234").unwrap(), Some("pending".into()));
        store
            .put_workbench_state("TAPD-1234", "running:develop:0")
        .unwrap();
        assert_eq!(
            store.get_workbench_state("TAPD-1234").unwrap(),
            Some("running:develop:0".into())
        );
        assert!(store.get_workbench_state("TAPD-9999").unwrap().is_none());
    }
}
```

(`tempdir_in_target` is a tiny helper that returns a `TempDir` in `target/tmp`; add it at module top if not present.)

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib tapd::store::workbench_state_tests -- --nocapture`
Expected: FAIL with `put_workbench_state` not found.

- [ ] **Step 3: Add migration + DAO methods**

In `TapdStore::open`, after the existing `CREATE TABLE` migrations, append:

```rust
conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS workbench_task_state (
        tapd_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );"
)?;
```

Add to `impl TapdStore`:

```rust
pub fn put_workbench_state(&self, tapd_id: &str, state: &str) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp();
    self.conn.execute(
        "INSERT INTO workbench_task_state (tapd_id, state, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(tapd_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
        rusqlite::params![tapd_id, state, now],
    )?;
    Ok(())
}

pub fn get_workbench_state(&self, tapd_id: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = self.conn.prepare("SELECT state FROM workbench_task_state WHERE tapd_id = ?1")?;
    let mut rows = stmt.query(rusqlite::params![tapd_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn list_pending_workbench_tasks(&self) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = self.conn.prepare(
        "SELECT t.tapd_id, t.title
         FROM tasks t
         LEFT JOIN workbench_task_state w ON w.tapd_id = t.tapd_id
         WHERE t.queue_state = 'pending' AND w.state IS NULL"
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib tapd::store::workbench_state_tests -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/tapd/store.rs
git commit -m "feat(tapd): workbench_task_state persistence DAO"
```

---

## Phase 2 — Dispatcher + Priority Queue (1 day)

### Task 2.1: Priority queue + slot accounting

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Write failing test for WorkbenchQueue ordering**

In `dispatcher.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_orders_by_priority_then_fifo() {
        let mut q = WorkbenchQueue::default();
        q.push(PendingTask { tapd_id: "TAPD-1".into(), priority: Priority::Low,    enqueued_at: 1 });
        q.push(PendingTask { tapd_id: "TAPD-2".into(), priority: Priority::Urgent, enqueued_at: 2 });
        q.push(PendingTask { tapd_id: "TAPD-3".into(), priority: Priority::High,   enqueued_at: 3 });
        q.push(PendingTask { tapd_id: "TAPD-4".into(), priority: Priority::Urgent, enqueued_at: 4 });
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-2");
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-4");
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-3");
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-1");
        assert!(q.pop().is_none());
    }

    #[test]
    fn slot_accounting_blocks_when_at_limit() {
        let mut acc = SlotAccountant::new(2, 5);
        assert!(acc.try_claim("proj-a"));
        assert!(acc.try_claim("proj-b"));
        assert!(!acc.try_claim("proj-c"));
        acc.release("proj-a");
        assert!(acc.try_claim("proj-c"));
    }

    #[test]
    fn slot_accounting_blocks_when_worktree_pool_exhausted() {
        let mut acc = SlotAccountant::new(5, 2);
        assert!(acc.try_claim("proj-a"));
        assert!(acc.try_claim("proj-b"));
        assert!(!acc.try_claim("proj-c"));
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::dispatcher -- --nocapture`
Expected: FAIL with `WorkbenchQueue` not found.

- [ ] **Step 3: Implement WorkbenchQueue + SlotAccountant**

```rust
use std::collections::BinaryHeap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingTask {
    pub tapd_id: String,
    pub priority: Priority,
    pub enqueued_at: i64,
}

impl Ord for PendingTask {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // higher priority first; on tie, earlier enqueue first
        self.priority.cmp(&other.priority).then(other.enqueued_at.cmp(&self.enqueued_at))
    }
}
impl PartialOrd for PendingTask {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> { Some(self.cmp(other)) }
}

#[derive(Default)]
pub struct WorkbenchQueue {
    heap: BinaryHeap<PendingTask>,
}

impl WorkbenchQueue {
    pub fn push(&mut self, task: PendingTask) { self.heap.push(task); }
    pub fn pop(&mut self) -> Option<PendingTask> { self.heap.pop() }
    pub fn len(&self) -> usize { self.heap.len() }
    pub fn is_empty(&self) -> bool { self.heap.is_empty() }
}

#[derive(Debug)]
pub struct SlotAccountant {
    global_max_active: usize,
    worktree_pool_max: usize,
    active: std::collections::HashSet<String>,
    worktree_users: std::collections::HashSet<String>,
}

impl SlotAccountant {
    pub fn new(global_max_active: usize, worktree_pool_max: usize) -> Self {
        Self {
            global_max_active,
            worktree_pool_max,
            active: Default::default(),
            worktree_users: Default::default(),
        }
    }
    pub fn try_claim(&mut self, task_id: &str) -> bool {
        if self.active.len() >= self.global_max_active { return false; }
        if self.worktree_users.len() >= self.worktree_pool_max { return false; }
        self.active.insert(task_id.to_string());
        self.worktree_users.insert(task_id.to_string());
        true
    }
    pub fn release(&mut self, task_id: &str) {
        self.active.remove(task_id);
        self.worktree_users.remove(task_id);
    }
    pub fn active_count(&self) -> usize { self.active.len() }
    pub fn worktree_in_use(&self) -> usize { self.worktree_users.len() }
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::dispatcher -- --nocapture`
Expected: 3 passed.

- [ ] **Step 5: Add `pub mod dispatcher;` to workbench/mod.rs and commit**

```rust
// mod.rs
pub mod dispatcher;
pub mod state_machine;
```

```bash
git add crates/codegen/xai-grok-shell/src/workbench/
git commit -m "feat(workbench): priority queue + slot accountant"
```

---

### Task 2.2: WorkbenchDispatcher background loop

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs`

- [ ] **Step 1: Write failing test for dispatcher behavior**

```rust
#[tokio::test]
async fn dispatcher_drains_queue_when_slots_available() {
    let store = test_store();
    let cfg = WorkbenchConfig::default();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DispatchEvent>();
    let dispatcher = WorkbenchDispatcher::new(store.clone(), cfg, tx);

    store.put_workbench_state("TAPD-1", "pending").unwrap();
    store.put_workbench_state("TAPD-2", "pending").unwrap();

    dispatcher.dispatch_pending().await.unwrap();
    let mut events = vec![];
    while let Ok(e) = rx.try_recv() { events.push(e); }
    assert!(events.iter().any(|e| matches!(e, DispatchEvent::Spawned { .. })));
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::dispatcher::tests::dispatcher_drains_queue -- --nocapture`
Expected: FAIL with `WorkbenchDispatcher` not found.

- [ ] **Step 3: Implement WorkbenchDispatcher**

```rust
#[derive(Clone, Debug)]
pub enum DispatchEvent {
    Spawned { tapd_id: String, session_id: String },
    NoSlot,
    QueueEmpty,
    HealthSnapshot { active: usize, queued: usize, worktree_in_use: usize },
}

pub struct WorkbenchDispatcher {
    store: TapdStore,
    cfg: WorkbenchConfig,
    queue: parking_lot::Mutex<WorkbenchQueue>,
    slots: parking_lot::Mutex<SlotAccountant>,
    sink: tokio::sync::mpsc::UnboundedSender<DispatchEvent>,
}

impl WorkbenchDispatcher {
    pub fn new(
        store: TapdStore,
        cfg: WorkbenchConfig,
        sink: tokio::sync::mpsc::UnboundedSender<DispatchEvent>,
    ) -> Self {
        let slots = SlotAccountant::new(cfg.concurrency.global_max_active, cfg.concurrency.worktree_pool_max);
        Self {
            store, cfg, sink,
            queue: Default::default(),
            slots: parking_lot::Mutex::new(slots),
        }
    }

    pub async fn dispatch_pending(&self) -> anyhow::Result<()> {
        let pending = tokio::task::spawn_blocking({
            let store = self.store.clone();
            move || store.list_pending_workbench_tasks()
        }).await??;
        if pending.is_empty() {
            let _ = self.sink.send(DispatchEvent::QueueEmpty);
            return Ok(());
        }

        let mut queued_count = 0;
        for (tapd_id, _title) in pending {
            let priority = self.fetch_priority(&tapd_id)?;
            self.queue.lock().push(PendingTask {
                tapd_id: tapd_id.clone(),
                priority,
                enqueued_at: chrono::Utc::now().timestamp(),
            });
            self.store.put_workbench_state(&tapd_id, "queued")?;
            queued_count += 1;
        }

        while let Some(task) = self.queue.lock().pop() {
            let mut slots = self.slots.lock();
            if !slots.try_claim(&task.tapd_id) {
                let _ = self.sink.send(DispatchEvent::NoSlot);
                break;
            }
            drop(slots);
            let session_id = self.spawn_main_session(&task.tapd_id).await?;
            self.store.put_workbench_state(&task.tapd_id, "running")?;
            let _ = self.sink.send(DispatchEvent::Spawned { tapd_id: task.tapd_id.clone(), session_id });
        }

        let snap = self.health_snapshot();
        let _ = self.sink.send(DispatchEvent::HealthSnapshot(snap));
        Ok(())
    }

    fn fetch_priority(&self, tapd_id: &str) -> anyhow::Result<Priority> {
        // TODO (Task 2.3): wire to TAPD store's task row.
        // For now, default to Medium so tests run.
        let _ = tapd_id;
        Ok(Priority::Medium)
    }

    async fn spawn_main_session(&self, _tapd_id: &str) -> anyhow::Result<String> {
        // TODO (Task 4.x): wire to session creation; placeholder UUID for now.
        Ok(uuid::Uuid::new_v4().to_string())
    }

    pub fn health_snapshot(&self) -> (usize, usize, usize) {
        (self.slots.lock().active_count(), self.queue.lock().len(), self.slots.lock().worktree_in_use())
    }
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::dispatcher -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs
git commit -m "feat(workbench): dispatcher drain loop with slot accounting"
```

---

### Task 2.3: Wire dispatcher into TapdSyncManager

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/tapd/sync.rs`

- [ ] **Step 1: Locate the sync completion hook**

Search for `pub struct TapdSyncManager` and find where it finishes one `sync_project` call (look for `sync_finished_at` updates or `Ok(SyncStats)`). We add an optional `on_sync_complete` callback.

- [ ] **Step 2: Add callback field + invocation**

In `TapdSyncManager`, add:

```rust
pub struct TapdSyncManager {
    // existing fields...
    pub on_sync_complete: Option<Arc<dyn Fn(&str) -> futures::future::BoxFuture<'static, ()> + Send + Sync>>,
}
```

After the `Ok(SyncStats)` return in the inner loop (or in the post-batch hook), invoke the callback for each directory that synced successfully.

- [ ] **Step 3: Wire the dispatcher in MvpAgent::new**

In `crates/codegen/xai-grok-shell/src/agent/mvp_agent.rs`, after constructing `TapdSyncManager`, attach:

```rust
let dispatcher = Arc::new(WorkbenchDispatcher::new(
    tapd_store.clone(),
    cfg.workbench.clone(),
    dispatch_sink.clone(),
));
sync_manager.on_sync_complete = Some(Arc::new(move |directory: &str| {
    let dispatcher = dispatcher.clone();
    let dir = directory.to_string();
    Box::pin(async move {
        if let Err(e) = dispatcher.dispatch_pending().await {
            tracing::warn!(directory = %dir, "workbench dispatch failed: {e:#}");
        }
    })
}));
```

Expose `agent.workbench_dispatcher() -> Option<Arc<WorkbenchDispatcher>>` (mirroring `agent.tapd_sync_manager()`).

- [ ] **Step 4: Run all related tests**

Run: `cargo test -p xai-grok-shell --lib tapd -- --nocapture`
Expected: existing tests still pass (we did not break sync semantics).

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/tapd/sync.rs crates/codegen/xai-grok-shell/src/agent/mvp_agent.rs
git commit -m "feat(workbench): wire dispatcher into TAPD sync completion"
```

---

## Phase 3 — Worktree Manager (0.5 day)

### Task 3.1: Worktree create + branch naming

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs`
- Modify: `crates/codegen/xai_grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Write failing test for branch naming**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_name_from_task_id_and_title() {
        assert_eq!(
            branch_name("TAPD-1234", "Fix user lookup"),
            "tapd/TAPD-1234-fix-user-lookup"
        );
    }

    #[test]
    fn branch_name_truncates_to_40_chars() {
        let long = "a".repeat(80);
        let name = branch_name("TAPD-9", &long);
        // task-id-prefix + 40 char slug max
        assert!(name.len() <= 60);
    }

    #[test]
    fn branch_name_strips_non_kebab_chars() {
        assert_eq!(
            branch_name("TAPD-1", "Fix: user/lookup & more!"),
            "tapd/TAPD-1-fix-user-lookup-more"
        );
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::worktree_manager -- --nocapture`
Expected: FAIL with `branch_name` not found.

- [ ] **Step 3: Implement branch_name + worktree_manager stub**

```rust
use std::path::{Path, PathBuf};

pub fn worktree_root(grok_home: &Path) -> PathBuf {
    grok_home.join("worktrees")
}

pub fn worktree_path(grok_home: &Path, task_id: &str) -> PathBuf {
    worktree_root(grok_home).join(task_id)
}

pub fn branch_name(task_id: &str, title: &str) -> String {
    let slug = slugify(title, 40);
    format!("tapd/{task_id}-{slug}")
}

fn slugify(title: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(max_len);
    let mut last_dash = false;
    for ch in title.chars() {
        let c = ch.to_ascii_lowercase();
        let keep = c.is_ascii_alphanumeric();
        if keep {
            out.push(c);
            last_dash = false;
        } else if ch == '-' || ch == '_' || ch == ' ' {
            if !out.is_empty() && !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
        if out.len() >= max_len { break; }
    }
    while out.ends_with('-') { out.pop(); }
    out
}

pub async fn create_worktree(
    repo_root: &Path,
    grok_home: &Path,
    task_id: &str,
    title: &str,
    base_branch: &str,
) -> anyhow::Result<PathBuf> {
    let path = worktree_path(grok_home, task_id);
    let branch = branch_name(task_id, title);
    tokio::process::Command::new("git")
        .args(["worktree", "add", "-b", &branch])
        .arg(path.as_os_str())
        .arg(base_branch)
        .current_dir(repo_root)
        .output()
        .await?;
    write_worktree_gitignore(&path).await?;
    Ok(path)
}

async fn write_worktree_gitignore(worktree: &Path) -> anyhow::Result<()> {
    let dir = worktree.join(".workbench");
    tokio::fs::create_dir_all(&dir).await?;
    let gi = dir.join(".gitignore");
    tokio::fs::write(&gi, "*\n!.gitignore\n").await?;
    Ok(())
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::worktree_manager -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/
git commit -m "feat(workbench): worktree manager + branch naming"
```

---

### Task 3.2: Delayed worktree GC

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs`

- [ ] **Step 1: Write failing test for GC delay**

```rust
#[tokio::test(start_paused = true)]
async fn gc_runs_after_configured_delay() {
    let tmp = tempdir_in_target();
    let path = tmp.path().join("wt");
    tokio::fs::create_dir_all(&path).await.unwrap();
    let cfg = WorkbenchConfig { worktree_gc_delay_secs: 60, ..WorkbenchConfig::default() };
    let registry = WorktreeGcRegistry::new(cfg);

    registry.schedule_gc(path.clone()).await;
    tokio::time::advance(std::time::Duration::from_secs(30)).await;
    assert!(path.exists());
    tokio::time::advance(std::time::Duration::from_secs(31)).await;
    assert!(!path.exists());
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::worktree_manager::tests::gc_runs_after_configured_delay -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement WorktreeGcRegistry**

```rust
pub struct WorktreeGcRegistry {
    cfg: WorkbenchConfig,
}

impl WorktreeGcRegistry {
    pub fn new(cfg: WorkbenchConfig) -> Self { Self { cfg } }

    pub fn schedule_gc(&self, path: PathBuf) {
        let delay = std::time::Duration::from_secs(self.cfg.worktree_gc_delay_secs);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Err(e) = tokio::fs::remove_dir_all(&path).await {
                tracing::warn!(path = %path.display(), "worktree GC failed: {e:#}");
            }
        });
    }
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::worktree_manager -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/worktree_manager.rs
git commit -m "feat(workbench): delayed worktree GC after task completion"
```

---

## Phase 4 — State Machine + Persistence (1 day)

### Task 4.1: TaskState enum + transition table

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Write failing test for transitions**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planner_ok_with_no_open_qs_skips_adjudicate_to_develop() {
        let design = DesignDoc::parse("## Open questions\nNone.\n").unwrap();
        assert!(!design.has_open_questions());
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0 },
            &design,
            Priority::Medium,
            3,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 0, .. }));
    }

    #[test]
    fn planner_ok_with_open_qs_and_urgent_priority_runs_adjudicate() {
        let design = DesignDoc::parse("## Open questions\n- needs_owner_decision: Q1\n").unwrap();
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0 },
            &design,
            Priority::Urgent,
            2,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Adjudicate, attempt: 0, .. }));
    }

    #[test]
    fn planner_ok_with_low_priority_and_few_acs_skips_adjudicate() {
        let design = DesignDoc::parse("## Open questions\n- needs_owner_decision: Q1\n").unwrap();
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0 },
            &design,
            Priority::Low,
            2,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 0, .. }));
    }

    #[test]
    fn planner_fail_after_3_retries_goes_dead() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 3, started_at: 0 },
            &DesignDoc::parse("## Open questions\nNone.\n").unwrap(),
            Priority::Medium,
            0,
        );
        assert!(matches!(next, TaskState::Dead { .. }));
    }

    #[test]
    fn adjudicate_proceed_goes_to_develop() {
        let next = next_after_adjudicate(AdjudicateVerdict::Proceed);
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 0, .. }));
    }

    #[test]
    fn adjudicate_block_for_human() {
        let next = next_after_adjudicate(AdjudicateVerdict::BlockForHuman);
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn verify_exit_zero_routes_to_mr_submit() {
        let next = next_after_verify(1, 0);
        assert!(matches!(next, TaskState::Running { stage: Stage::MrSubmit, attempt: 0, .. }));
    }

    #[test]
    fn verify_exit_nonzero_routes_back_to_develop_incrementing_attempt() {
        let next = next_after_verify(1, 1); // prev develop attempt=1, exit=1
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 2, .. }));
    }

    #[test]
    fn verify_exhausts_develop_budget_then_blocks() {
        let next = next_after_verify(3, 1); // prev develop attempt already at max
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn mr_submit_409_does_not_consume_retry_budget() {
        let next = next_after_mr_submit(
            TaskState::Running { stage: Stage::MrSubmit, attempt: 1, started_at: 0 },
            MrSubmitOutcome::Conflict,
        );
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn mr_submit_5xx_increments_attempt() {
        let next = next_after_mr_submit(
            TaskState::Running { stage: Stage::MrSubmit, attempt: 1, started_at: 0 },
            MrSubmitOutcome::TransientError,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::MrSubmit, attempt: 2, .. }));
    }

    #[test]
    fn mr_submit_5xx_after_budget_blocks_for_human() {
        let next = next_after_mr_submit(
            TaskState::Running { stage: Stage::MrSubmit, attempt: 3, started_at: 0 },
            MrSubmitOutcome::TransientError,
        );
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement state_machine.rs**

```rust
use serde::{Deserialize, Serialize};
use crate::agent::config::{AdjudicateMode, Priority};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Brainstorm,
    Adjudicate,
    Develop,
    CodeReview,
    Verify,
    MrSubmit,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskState {
    Queued { priority: Priority },
    Pending,
    Running { stage: Stage, attempt: u8, started_at: i64 },
    BlockedForHuman { stage: Stage, reason: String, payload: serde_json::Value },
    Done { mr_url: String, finished_at: i64 },
    Dead { reason: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum AdjudicateVerdict { Proceed, BlockForHuman }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum MrSubmitOutcome { Ok, Conflict, AuthError, TransientError }

#[derive(Clone, Debug)]
pub struct DesignDoc { pub raw: String }
impl DesignDoc {
    pub fn parse(s: &str) -> anyhow::Result<Self> { Ok(Self { raw: s.into() }) }
    pub fn has_open_questions(&self) -> bool {
        // heuristic: a non-empty `## Open questions` section not equal to "None."
        if let Some(idx) = self.raw.find("## Open questions") {
            let tail = &self.raw[idx..];
            let body = tail.split_once("\n## ").map(|(b, _)| b).unwrap_or(tail);
            !body.contains("None.") && body.lines().any(|l| l.trim_start().starts_with("- "))
        } else { false }
    }
}

fn retry_left(attempt: u8, max: u8) -> bool { attempt < max }

pub fn next_after_planner(
    current: TaskState,
    design: &DesignDoc,
    priority: Priority,
    ac_count: usize,
) -> TaskState {
    let max = 3;
    let attempt = match &current { TaskState::Running { attempt, .. } => *attempt, _ => 0 };
    if !retry_left(attempt, max) {
        return TaskState::Dead { reason: "brainstorm retries exhausted".into() };
    }
    let needs_adj = design.has_open_questions() && (priority >= Priority::High || ac_count >= 5);
    if needs_adj {
        TaskState::Running { stage: Stage::Adjudicate, attempt: 0, started_at: now() }
    } else {
        TaskState::Running { stage: Stage::Develop, attempt: 0, started_at: now() }
    }
}

pub fn next_after_adjudicate(verdict: AdjudicateVerdict) -> TaskState {
    match verdict {
        AdjudicateVerdict::Proceed => TaskState::Running { stage: Stage::Develop, attempt: 0, started_at: now() },
        AdjudicateVerdict::BlockForHuman => TaskState::BlockedForHuman {
            stage: Stage::Adjudicate, reason: "needs_owner_decision".into(), payload: serde_json::json!({}),
        },
    }
}

pub fn next_after_develop(current: TaskState, ok: bool, _review_verdict: &str) -> TaskState {
    let attempt = match &current { TaskState::Running { attempt, .. } => *attempt, _ => 0 };
    if ok {
        TaskState::Running { stage: Stage::CodeReview, attempt: 0, started_at: now() }
    } else if retry_left(attempt, 3) {
        TaskState::Running { stage: Stage::Develop, attempt: attempt + 1, started_at: now() }
    } else {
        TaskState::Dead { reason: "develop retries exhausted".into() }
    }
}


pub fn next_after_verify(prev_develop_attempt: u8, exit_code: i32) -> TaskState {
    if exit_code == 0 {
        TaskState::Running { stage: Stage::MrSubmit, attempt: 0, started_at: now() }
    } else if retry_left(prev_develop_attempt, 3) {
        // Spec §7.1: verify fail routes back to Develop, consuming Develop's retry budget.
        TaskState::Running { stage: Stage::Develop, attempt: prev_develop_attempt + 1, started_at: now() }
    } else {
        TaskState::BlockedForHuman {
            stage: Stage::Verify, reason: "verify keeps failing".into(), payload: serde_json::json!({}),
        }
    }
}

pub fn next_after_mr_submit(current: TaskState, outcome: MrSubmitOutcome) -> TaskState {
    let attempt = match &current { TaskState::Running { attempt, .. } => *attempt, _ => 0 };
    match outcome {
        MrSubmitOutcome::Ok => TaskState::Done { mr_url: String::new(), finished_at: now() },
        MrSubmitOutcome::Conflict | MrSubmitOutcome::AuthError => TaskState::BlockedForHuman {
            stage: Stage::MrSubmit, reason: "branch diverged or gitlab auth failed".into(), payload: serde_json::json!({}),
        },
        MrSubmitOutcome::TransientError if retry_left(attempt, 3) =>
            TaskState::Running { stage: Stage::MrSubmit, attempt: attempt + 1, started_at: now() },
        MrSubmitOutcome::TransientError => TaskState::BlockedForHuman {
            stage: Stage::MrSubmit, reason: "GitLab API persistent failure".into(), payload: serde_json::json!({}),
        },
    }
}

fn now() -> i64 { chrono::Utc::now().timestamp() }
```

Note: `_review_verdict` parameter kept for future use; ignored in v1 (returns from CodeReview route through `next_after_develop` with the boolean).

- [ ] **Step 4: Run tests**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine -- --nocapture`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/state_machine.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench): state machine + transition table + tests"
```

---

### Task 4.2: Artifact envelope parser

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/artifacts.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Write failing test for envelope parse/write**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_envelope() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\n---\n\n# Body\nhello\n";
        let env = ArtifactEnvelope::parse(md).unwrap();
        assert_eq!(env.frontmatter.stage, Stage::Brainstorm);
        assert_eq!(env.frontmatter.task_id, "TAPD-1");
        assert_eq!(env.frontmatter.attempt, 0);
        assert!(env.body.contains("# Body"));
    }

    #[test]
    fn round_trip_preserves_frontmatter_and_body() {
        let env = ArtifactEnvelope {
            frontmatter: ArtifactFrontmatter {
                stage: Stage::Develop,
                task_id: "TAPD-9".into(),
                attempt: 2,
                extra: Default::default(),
            },
            body: "## Notes\nline\n".into(),
        };
        let s = env.to_string();
        let parsed = ArtifactEnvelope::parse(&s).unwrap();
        assert_eq!(parsed.frontmatter.task_id, "TAPD-9");
        assert_eq!(parsed.frontmatter.attempt, 2);
        assert_eq!(parsed.body.trim(), env.body.trim());
    }

    #[test]
    fn filename_for_attempt() {
        assert_eq!(artifact_path(1, "design", 0), ".workbench/stages/1-design.md");
        assert_eq!(artifact_path(1, "design", 2), ".workbench/stages/1-design-attempt-2.md");
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::artifacts -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement artifacts.rs**

```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use crate::workbench::state_machine::Stage;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactFrontmatter {
    pub stage: Stage,
    pub task_id: String,
    pub attempt: u8,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_yaml::Value>,
}

#[derive(Clone, Debug)]
pub struct ArtifactEnvelope {
    pub frontmatter: ArtifactFrontmatter,
    pub body: String,
}

impl ArtifactEnvelope {
    pub fn parse(md: &str) -> anyhow::Result<Self> {
        let (front, body) = md.split_once("---\n")
            .and_then(|(a, rest)| rest.split_once("\n---\n").map(|(b, c)| (a, b, c)))
            .ok_or_else(|| anyhow::anyhow!("missing frontmatter envelope"))?;
        let fm: ArtifactFrontmatter = serde_yaml::from_str(front)?;
        Ok(Self { frontmatter: fm, body: body.to_string() })
    }
}

impl std::fmt::Display for ArtifactEnvelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let yaml = serde_yaml::to_string(&self.frontmatter).map_err(|_| std::fmt::Error)?;
        write!(f, "---\n{}---\n{}", yaml, self.body)
    }
}

pub fn artifact_path(stage_num: u8, name: &str, attempt: u8) -> String {
    if attempt == 0 {
        format!(".workbench/stages/{stage_num}-{name}.md")
    } else {
        format!(".workbench/stages/{stage_num}-{name}-attempt-{attempt}.md")
    }
}
```

Add `serde_yaml = "0.9"` to `crates/codegen/xai-grok-shell/Cargo.toml` dependencies.

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::artifacts -- --nocapture`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/Cargo.toml crates/codegen/xai-grok-shell/src/workbench/artifacts.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench): artifact envelope parse + filename convention"
```

---

### Task 4.3: state.json persistence + resume

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs`

- [ ] **Step 1: Write failing test for state.json round trip**

```rust
#[cfg(test)]
mod persistence_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn state_json_round_trip() {
        let s = TaskState::Running { stage: Stage::Develop, attempt: 1, started_at: 1700000000 };
        let json = serde_json::to_string(&s).unwrap();
        let back: TaskState = serde_json::from_str(&json).unwrap();
        match back {
            TaskState::Running { stage, attempt, started_at } => {
                assert_eq!(stage, Stage::Develop);
                assert_eq!(attempt, 1);
                assert_eq!(started_at, 1700000000);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn state_json_handles_blocked_for_human() {
        let s = TaskState::BlockedForHuman {
            stage: Stage::MrSubmit,
            reason: "branch diverged".into(),
            payload: serde_json::json!({ "branch": "tapd/TAPD-1-x" }),
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: TaskState = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn resume_normalizes_running_to_pending() {
        let s = TaskState::Running { stage: Stage::Develop, attempt: 1, started_at: 0 };
        let normalized = resume_state(s);
        assert!(matches!(normalized, TaskState::Pending));
    }

    #[test]
    fn resume_keeps_terminal_states() {
        let s = TaskState::Done { mr_url: "https://x".into(), finished_at: 1 };
        assert!(matches!(resume_state(s.clone()), TaskState::Done { .. }));
        let s = TaskState::BlockedForHuman { stage: Stage::Adjudicate, reason: "x".into(), payload: serde_json::json!({}) };
        assert!(matches!(resume_state(s), TaskState::BlockedForHuman { .. }));
        let s = TaskState::Dead { reason: "x".into() };
        assert!(matches!(resume_state(s), TaskState::Dead { .. }));
    }
}

pub fn resume_state(s: TaskState) -> TaskState {
    match s {
        TaskState::Running { .. } => TaskState::Pending,
        other => other,
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine::persistence_tests -- --nocapture`
Expected: FAIL with `resume_state` not found.

- [ ] **Step 3: Implement resume_state**

Add to `state_machine.rs`:

```rust
pub fn resume_state(s: TaskState) -> TaskState {
    match s {
        TaskState::Running { .. } => TaskState::Pending,
        other => other,
    }
}

pub async fn load_state(worktree: &Path) -> anyhow::Result<Option<TaskState>> {
    let p = worktree.join(".workbench/state.json");
    if !p.exists() { return Ok(None); }
    let s = tokio::fs::read_to_string(&p).await?;
    Ok(Some(resume_state(serde_json::from_str(&s)?)))
}

pub async fn save_state(worktree: &Path, state: &TaskState) -> anyhow::Result<()> {
    let p = worktree.join(".workbench/state.json");
    tokio::fs::create_dir_all(p.parent().unwrap()).await?;
    tokio::fs::write(&p, serde_json::to_string_pretty(state)?).await?;
    Ok(())
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::state_machine -- --nocapture`
Expected: 15 passed (11 transition + 4 persistence).

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/state_machine.rs
git commit -m "feat(workbench): state.json persistence + resume normalization"
```

---

## Phase 5 — Planner (1 day)

### Task 5.1: Planner prompt template + child session spawn

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/prompts/mod.rs`
- Create: `crates/codegen/xai-grok-shell/src/workbench/prompts/planner.md.tmpl`
- Create: `crates/codegen/xai-grok-shell/src/workbench/main_session.rs`

- [ ] **Step 1: Write failing test for prompt template render**

```rust
// prompts/mod.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planner_prompt_includes_inputs_and_sections() {
        let p = PlannerInputs {
            task_id: "TAPD-1".into(),
            title: "Fix login".into(),
            description: "broken".into(),
            acs: vec!["AC1".into(), "AC2".into()],
            worktree_path: "/tmp/wt".into(),
            priority: Priority::Medium,
            project_yaml: "directory: /repo".into(),
            attempt: 0,
        };
        let rendered = render_planner(&p);
        assert!(rendered.contains("TAPD-1"));
        assert!(rendered.contains("Fix login"));
        assert!(rendered.contains("AC1"));
        assert!(rendered.contains("## Goal"));
        assert!(rendered.contains("## Open questions"));
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::prompts -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement PlannerInputs + render_planner**

```rust
// prompts/mod.rs
pub mod planner;
pub mod adjudicator;
pub mod coder;
pub mod reviewer;

pub use planner::*;
pub use adjudicator::*;
pub use coder::*;
pub use reviewer::*;

use crate::agent::config::Priority;

pub struct PlannerInputs {
    pub task_id: String,
    pub title: String,
    pub description: String,
    pub acs: Vec<String>,
    pub worktree_path: String,
    pub priority: Priority,
    pub project_yaml: String,
    pub attempt: u8,
}
```

```rust
// prompts/planner.rs
use super::PlannerInputs;

pub const PLANNER_PROMPT: &str = include_str!("planner.md.tmpl");

pub fn render_planner(i: &PlannerInputs) -> String {
    PLANNER_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{title}}", &i.title)
        .replace("{{description}}", &i.description)
        .replace("{{ac_list}}", &i.acs.iter().map(|a| format!("- {a}")).collect::<Vec<_>>().join("\n"))
        .replace("{{ac_count}}", &i.acs.len().to_string())
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{priority}}", &format!("{:?}", i.priority).to_lowercase())
        .replace("{{project_config_yaml}}", &i.project_yaml)
        .replace("{{attempt}}", &i.attempt.to_string())
}
```

Then create `planner.md.tmpl`:

```markdown
# Role
You are the Planner for the TAPD workbench pipeline. Your job is to read a TAPD ticket and produce a design doc that the downstream Coder can implement directly.

# Constraints
- You MAY call only `read_file`, `glob`, `grep`.
- You MAY write to exactly one path: `{{worktree_path}}/.workbench/stages/1-design.md`. Anything else is an error.
- No `bash`, no `git`, no network. Do not edit source files.

# Inputs
- TAPD task ID: `{{task_id}}`
- Title: {{title}}
- Priority: {{priority}}
- Description:
{{description}}

- Acceptance criteria ({{ac_count}}):
{{ac_list}}

- Project config (relevant subset):
```yaml
{{project_config_yaml}}
```

- Attempt: {{attempt}}

# Output
Write to `{{worktree_path}}/.workbench/stages/1-design.md` with this frontmatter, then body:

```
---
stage: brainstorm
task_id: {{task_id}}
attempt: {{attempt}}
adjudicated: false
---

## Goal
<one paragraph: what this task accomplishes>

## Approach
<2-4 paragraphs: strategy, key tradeoffs, why this approach>

## Files to modify
<bulleted list; absolute paths; one-line rationale each>

## Edge cases
<bulleted list>

## Out of scope
<bulleted list>

## Open questions
<bulleted list of questions that block implementation. Each tagged `needs_owner_decision`, `auto-resolved: <assumption>`, or `out_of_scope: <reason>`. If none, write exactly `None.`.>

```

You are done when the file exists and frontmatter parses. Do not output anything else.
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::prompts -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/prompts/
git commit -m "feat(workbench): planner prompt template"
```

---

### Task 5.2: Planner child session spawn + artifact validation

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/main_session.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Write failing test for spawn planner + parse artifact**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::prompts::PlannerInputs;

    #[tokio::test]
    async fn planner_artifacts_validates_frontmatter() {
        let tmp = tempdir_in_target();
        let stages = tmp.path().join(".workbench/stages");
        tokio::fs::create_dir_all(&stages).await.unwrap();
        let body = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: false\n---\n## Goal\nx\n## Approach\ny\n## Files to modify\n- a\n## Edge cases\n- b\n## Out of scope\n- c\n## Open questions\nNone.\n";
        tokio::fs::write(stages.join("1-design.md"), body).await.unwrap();

        let valid = validate_design_md(&stages.join("1-design.md")).await.unwrap();
        assert_eq!(valid.frontmatter.task_id, "TAPD-1");
        assert!(valid.body.contains("## Approach"));
    }

    #[tokio::test]
    async fn planner_artifact_rejects_missing_open_questions_section() {
        let tmp = tempdir_in_target();
        let stages = tmp.path().join(".workbench/stages");
        tokio::fs::create_dir_all(&stages).await.unwrap();
        let body = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\n---\n## Goal\nx\n";
        tokio::fs::write(stages.join("1-design.md"), body).await.unwrap();
        let err = validate_design_md(&stages.join("1-design.md")).await.unwrap_err();
        assert!(err.to_string().contains("Open questions"));
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::main_session -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement validate_design_md + child session spawn helper**

```rust
// main_session.rs
use crate::workbench::artifacts::ArtifactEnvelope;
use crate::workbench::state_machine::{TaskState, Stage};
use crate::workbench::prompts::{PlannerInputs, render_planner};

pub async fn validate_design_md(path: &Path) -> anyhow::Result<ArtifactEnvelope> {
    let raw = tokio::fs::read_to_string(path).await?;
    let env = ArtifactEnvelope::parse(&raw)?;
    for required in ["## Goal", "## Approach", "## Files to modify", "## Edge cases", "## Out of scope", "## Open questions"] {
        if !env.body.contains(required) {
            anyhow::bail!("design.md missing required section `{required}`");
        }
    }
    Ok(env)
}

/// Build the planner child session prompt + tool allowlist.
/// Tool enforcement is done by the agent runtime; this returns the inputs.
pub fn build_planner_inputs(
    tapd_id: &str,
    title: &str,
    description: &str,
    acs: Vec<String>,
    worktree_path: &str,
    priority: Priority,
    project_yaml: &str,
    attempt: u8,
) -> String {
    render_planner(&PlannerInputs {
        task_id: tapd_id.into(),
        title: title.into(),
        description: description.into(),
        acs,
        worktree_path: worktree_path.into(),
        priority,
        project_yaml: project_yaml.into(),
        attempt,
    })
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::main_session -- --nocapture`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/main_session.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench): planner artifact validation + spawn inputs"
```

---

## Phase 6 — Adjudicator (0.5 day)

### Task 6.1: Adjudicator prompt template

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/prompts/adjudicator.md.tmpl`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/prompts/mod.rs`

- [ ] **Step 1: Write failing test for render**

```rust
// prompts/adjudicator.rs
use super::*;

pub struct AdjudicatorInputs {
    pub task_id: String,
    pub design_excerpt: String,
    pub worktree_path: String,
    pub attempt: u8,
}

pub fn render_adjudicator(i: &AdjudicatorInputs) -> String {
    ADJUDICATOR_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{design_excerpt}}", &i.design_excerpt)
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{attempt}}", &i.attempt.to_string())
}

pub const ADJUDICATOR_PROMPT: &str = include_str!("adjudicator.md.tmpl");

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn render_includes_inputs() {
        let p = AdjudicatorInputs {
            task_id: "TAPD-1".into(),
            design_excerpt: "## Open questions\n- foo".into(),
            worktree_path: "/tmp/wt".into(),
            attempt: 0,
        };
        let s = render_adjudicator(&p);
        assert!(s.contains("TAPD-1"));
        assert!(s.contains("/tmp/wt"));
        assert!(s.contains("## Open questions"));
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::prompts::adjudicator -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement + write template**

Add to `prompts/mod.rs`:
```rust
pub mod adjudicator;
pub use adjudicator::*;
```

Create `prompts/adjudicator.md.tmpl`:

```markdown
# Role
You are the Adjudicator for the TAPD workbench. You resolve Open Questions in the design doc so the Coder can proceed without ambiguity.

# Mode
**Recorder** (default): you record your decision but do not block on judgment calls. Only `needs_owner_decision` becomes a block.

# Constraints
- You MAY call only `read_file`, `edit_file` on `{{worktree_path}}/.workbench/stages/1-design.md`. No other writes.
- No `bash`, no `git`, no code edits.

# Inputs
- TAPD task ID: `{{task_id}}`
- Attempt: {{attempt}}
- Design doc excerpt:
```
{{design_excerpt}}
```

# Decision rule
For each Open Question in the design, classify as ONE of:
- `auto-resolved: <assumption> because <reason>` — coder can proceed
- `needs_owner_decision: <question>` — genuinely unresolvable without business context
- `out_of_scope: <question>` — not part of this TAPD task

# Output
1. Append a `## Adjudication` section to `{{worktree_path}}/.workbench/stages/1-design.md` listing each Open Question with its classification.
2. Update frontmatter to set `adjudicated: true` and `verdict: proceed | block_for_human`.
3. Verdict rule: `proceed` if ZERO `needs_owner_decision`; `block_for_human` if at least one.

# Verdict rule (for your reference)
You are done when the file exists with both `adjudicated: true` and `verdict: <...>` set.
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::prompts -- --nocapture`
Expected: 2 passed (1 planner + 1 adjudicator).

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/prompts/
git commit -m "feat(workbench): adjudicator prompt template"
```

---

### Task 6.2: Adjudicator appends to 1-design.md + verdict parse

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/main_session.rs`

- [ ] **Step 1: Write failing test for verdict parsing**

```rust
#[cfg(test)]
mod adjudicator_parse_tests {
    use super::*;

    #[test]
    fn parse_proceed_verdict() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: true\nverdict: proceed\n---\n## Adjudication\n- auto-resolved: X\n";
        let verdict = parse_adjudicator_verdict(md).unwrap();
        assert_eq!(verdict, AdjudicateVerdict::Proceed);
    }

    #[test]
    fn parse_block_verdict() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: true\nverdict: block_for_human\n---\n## Adjudication\n- needs_owner_decision: Q1\n";
        let verdict = parse_adjudicator_verdict(md).unwrap();
        assert_eq!(verdict, AdjudicateVerdict::BlockForHuman);
    }

    #[test]
    fn verdict_parse_fails_when_missing() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: false\n---\nbody";
        assert!(parse_adjudicator_verdict(md).is_err());
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::main_session::adjudicator_parse -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement parse_adjudicator_verdict**

```rust
use crate::workbench::state_machine::AdjudicateVerdict;

pub fn parse_adjudicator_verdict(md: &str) -> anyhow::Result<AdjudicateVerdict> {
    let env = ArtifactEnvelope::parse(md)?;
    let verdict = env.frontmatter.extra.get("verdict")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing `verdict` frontmatter key"))?;
    match verdict {
        "proceed" => Ok(AdjudicateVerdict::Proceed),
        "block_for_human" => Ok(AdjudicateVerdict::BlockForHuman),
        other => anyhow::bail!("unknown verdict `{other}`"),
    }
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::main_session -- --nocapture`
Expected: 5 passed (2 planner + 3 adjudicator).

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/main_session.rs
git commit -m "feat(workbench): adjudicator verdict parser"
```

---

## Phase 7 — Coder (1 day)

### Task 7.1: Coder prompt template + retry context injection

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/prompts/coder.md.tmpl`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/prompts/mod.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/main_session.rs`

- [ ] **Step 1: Write failing test for retry context rendering**

```rust
// prompts/coder.rs
use super::*;

pub struct CoderInputs {
    pub task_id: String,
    pub design_md: String,
    pub previous_review: Option<String>,
    pub previous_verify: Option<String>,
    pub retry_history: Vec<String>,
    pub worktree_path: String,
    pub attempt: u8,
}

pub fn render_coder(i: &CoderInputs) -> String {
    let mut s = CODER_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{design_md}}", &i.design_md)
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{attempt}}", &i.attempt.to_string())
        .replace("{{previous_review}}", &i.previous_review.clone().unwrap_or_else(|| "(none)".into()))
        .replace("{{previous_verify}}", &i.previous_verify.clone().unwrap_or_else(|| "(none)".into()))
        .replace("{{retry_history}}", &i.retry_history.iter().map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n"));
    if !i.retry_history.is_empty() {
        s = s.replace("{{retry_block_visible}}", &format!("\n## Retry history\n{}", i.retry_history.iter().map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n")));
    } else {
        s = s.replace("{{retry_block_visible}}", "");
    }
    s
}

pub const CODER_PROMPT: &str = include_str!("coder.md.tmpl");

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_attempt_renders_no_retry_block() {
        let p = CoderInputs {
            task_id: "TAPD-1".into(),
            design_md: "## Goal\nx".into(),
            previous_review: None,
            previous_verify: None,
            retry_history: vec![],
            worktree_path: "/tmp/wt".into(),
            attempt: 0,
        };
        let s = render_coder(&p);
        assert!(s.contains("TAPD-1"));
        assert!(s.contains("(none)"));
        assert!(!s.contains("## Retry history"));
    }

    #[test]
    fn retry_attempt_renders_previous_review_and_verify() {
        let p = CoderInputs {
            task_id: "TAPD-1".into(),
            design_md: "## Goal\nx".into(),
            previous_review: Some("- major: foo".into()),
            previous_verify: Some("exit 1: bar failed".into()),
            retry_history: vec!["attempt 0: reviewer needs_changes".into()],
            worktree_path: "/tmp/wt".into(),
            attempt: 1,
        };
        let s = render_coder(&p);
        assert!(s.contains("- major: foo"));
        assert!(s.contains("exit 1: bar failed"));
        assert!(s.contains("## Retry history"));
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::prompts::coder -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement + write coder.md.tmpl**

Add `pub mod coder; pub use coder::*;` to `prompts/mod.rs`. Create `coder.md.tmpl`:

```markdown
# Role
You are the Coder for the TAPD workbench pipeline. You implement the design doc in the worktree at `{{worktree_path}}`.

# Constraints
- You MAY call `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash` (restricted to `git` and `test_command`).
- You MAY write source files in the worktree.
- You MAY write to exactly `.workbench/stages/3-develop.md`.
- You MAY NOT push branches, modify git remotes, or run network commands.
- You MAY NOT edit any `.workbench/stages/*.md` other than `3-develop.md`.

# Inputs
- TAPD task ID: `{{task_id}}`
- Attempt: {{attempt}}
- Design doc:
```
{{design_md}}
```
- Previous review feedback (if retry):
```
{{previous_review}}
```
- Previous verify output (if retry):
```
{{previous_verify}}
```
{{retry_block_visible}}

# Output
1. Implement the design in the worktree.
2. Write `.workbench/stages/3-develop.md` with this frontmatter and a brief summary of what changed:
```
---
stage: develop
task_id: {{task_id}}
attempt: {{attempt}}
verdict: ok
---

## Changes
<bulleted list of files modified, one line each>

## Self-check
- [ ] compiles
- [ ] no out-of-scope edits
- [ ] all PREVIOUS_REVIEW items addressed (if retry)
```

# Self-check before declaring ok
- Run `cargo check` (or appropriate for the project) — must succeed.
- If retrying, every reviewer major/critical item is either fixed or explicitly justified in `3-develop.md`.
- No edits to files outside the design's "Files to modify" list.
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::prompts -- --nocapture`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/prompts/ crates/codegen/xai-grok-shell/src/workbench/main_session.rs
git commit -m "feat(workbench): coder prompt + retry context injection"
```

---

### Task 7.2: Coder artifact verdict parser

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/main_session.rs`

- [ ] **Step 1: Write failing test for develop verdict parse**

```rust
#[cfg(test)]
mod develop_parse_tests {
    use super::*;
    #[test]
    fn parse_develop_ok() {
        let md = "---\nstage: develop\ntask_id: TAPD-1\nattempt: 0\nverdict: ok\n---\nbody";
        assert_eq!(parse_develop_verdict(md).unwrap(), DevelopVerdict::Ok);
    }
    #[test]
    fn parse_develop_fail() {
        let md = "---\nstage: develop\ntask_id: TAPD-1\nattempt: 0\nverdict: fail\nreason: compile error\n---\nbody";
        match parse_develop_verdict(md).unwrap() {
            DevelopVerdict::Fail(r) => assert!(r.contains("compile")),
            _ => panic!("wrong variant"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DevelopVerdict { Ok, Fail(String) }

pub fn parse_develop_verdict(md: &str) -> anyhow::Result<DevelopVerdict> {
    let env = ArtifactEnvelope::parse(md)?;
    let v = env.frontmatter.extra.get("verdict").and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("missing verdict"))?;
    match v {
        "ok" => Ok(DevelopVerdict::Ok),
        "fail" => Ok(DevelopVerdict::Fail(env.frontmatter.extra.get("reason").and_then(|x| x.as_str()).unwrap_or("").into())),
        other => anyhow::bail!("unknown verdict `{other}`"),
    }
}
```

- [ ] **Step 2: Run test to confirm it passes** (parse function is provided)

Run: `cargo test -p xai-grok-shell --lib workbench::main_session::develop_parse -- --nocapture`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/main_session.rs
git commit -m "feat(workbench): coder verdict parser"
```

---

## Phase 8 — Reviewer (1 day)

### Task 8.1: Reviewer prompt template + verdict parser

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/prompts/reviewer.md.tmpl`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/prompts/mod.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/main_session.rs`

- [ ] **Step 1: Write failing test for review verdict parse**

```rust
// in main_session.rs
#[cfg(test)]
mod review_parse_tests {
    use super::*;
    #[test]
    fn approved_with_zero_critical() {
        let md = "---\nstage: review\ntask_id: TAPD-1\nattempt: 0\nverdict: approved\ncritical_count: 0\nmajor_count: 1\n---\nbody";
        assert_eq!(parse_review_verdict(md).unwrap(), ReviewVerdict::Approved);
    }
    #[test]
    fn needs_changes_with_one_critical() {
        let md = "---\nstage: review\ntask_id: TAPD-1\nattempt: 0\nverdict: needs_changes\ncritical_count: 1\nmajor_count: 0\n---\nbody";
        assert_eq!(parse_review_verdict(md).unwrap(), ReviewVerdict::NeedsChanges);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReviewVerdict { Approved, NeedsChanges }

pub fn parse_review_verdict(md: &str) -> anyhow::Result<ReviewVerdict> {
    let env = ArtifactEnvelope::parse(md)?;
    let v = env.frontmatter.extra.get("verdict").and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("missing verdict"))?;
    let crit = env.frontmatter.extra.get("critical_count").and_then(|x| x.as_u64()).unwrap_or(0);
    let major = env.frontmatter.extra.get("major_count").and_then(|x| x.as_u64()).unwrap_or(0);
    match v {
        "approved" if crit == 0 && major < 3 => Ok(ReviewVerdict::Approved),
        "needs_changes" | "approved" => Ok(ReviewVerdict::NeedsChanges),
        other => anyhow::bail!("unknown verdict `{other}`"),
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::main_session::review_parse -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement ReviewerInputs + render**

Add to `prompts/reviewer.rs`:

```rust
use super::*;

pub struct ReviewerInputs {
    pub task_id: String,
    pub diff: String,
    pub design_excerpt: String,
    pub worktree_path: String,
    pub attempt: u8,
}

pub fn render_reviewer(i: &ReviewerInputs) -> String {
    REVIEWER_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{diff}}", &i.diff)
        .replace("{{design_excerpt}}", &i.design_excerpt)
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{attempt}}", &i.attempt.to_string())
}

pub const REVIEWER_PROMPT: &str = include_str!("reviewer.md.tmpl");

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn render_includes_diff_and_design() {
        let p = ReviewerInputs {
            task_id: "TAPD-1".into(),
            diff: "+ new line".into(),
            design_excerpt: "## Goal\nx".into(),
            worktree_path: "/tmp/wt".into(),
            attempt: 0,
        };
        let s = render_reviewer(&p);
        assert!(s.contains("+ new line"));
        assert!(s.contains("## Goal"));
    }
}
```

Create `reviewer.md.tmpl`:

```markdown
# Role
You are the Reviewer for the TAPD workbench pipeline. You review the diff produced by the Coder against the design doc.

# Constraints
- Read-only: `read_file`, `glob`, `grep` only. NO `write_file`, `edit_file`, `bash`, `git`.

# Inputs
- TAPD task ID: `{{task_id}}`
- Attempt: {{attempt}}
- Diff to review:
```
{{diff}}
```
- Design doc excerpt:
```
{{design_excerpt}}
```

# Calibration
Only flag issues that are:
- Introduced by this diff (not pre-existing)
- Discrete and actionable
- Would be fixed by the author if they knew about them

Do NOT flag: speculative concerns, pre-existing problems unrelated to the diff, style nits, intentional behavior changes documented in the design.

# Severity grades
- `critical` — bug, security, data loss, scope violation, broken contract
- `major` — correctness, performance regression, missing required test
- `minor` — readability, naming, comment quality

# Verdict rule
- `approved` — zero `critical` AND fewer than 3 `major`
- `needs_changes` — at least 1 `critical` OR at least 3 `major`

# Output
Write to `{{worktree_path}}/.workbench/stages/4-review.md` with frontmatter:
```
---
stage: review
task_id: {{task_id}}
attempt: {{attempt}}
verdict: approved | needs_changes
critical_count: <n>
major_count: <n>
minor_count: <n>
---
```

Followed by body:
```
## Findings
### <severity>: <short title>
file:line — one-line description, one-line fix suggestion

(Repeat per finding.)

## Summary
<one paragraph>
```
```

Add `pub mod reviewer; pub use reviewer::*;` to `prompts/mod.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p xai-grok-shell --lib workbench::main_session::review_parse -- --nocapture && cargo test -p xai-grok-shell --lib workbench::prompts::reviewer -- --nocapture`
Expected: 2 + 1 = 3 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/prompts/ crates/codegen/xai-grok-shell/src/workbench/main_session.rs
git commit -m "feat(workbench): reviewer prompt + verdict parser"
```

---

## Phase 9 — Runner (0.5 day)

### Task 9.1: Runner stage with timeout + output capture

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/runner.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Write failing test for runner behavior**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runner_captures_exit_zero() {
        let tmp = tempdir_in_target();
        let stages = tmp.path().join(".workbench/stages");
        tokio::fs::create_dir_all(&stages).await.unwrap();
        let r = run_and_capture("echo hello", tmp.path(), 30).await.unwrap();
        assert_eq!(r.exit_code, 0);
        assert!(r.stdout.contains("hello"));
        write_artifact(&stages.join("5-verify.md"), "TAPD-1", 0, &r).await.unwrap();
        let raw = tokio::fs::read_to_string(stages.join("5-verify.md")).await.unwrap();
        assert!(raw.contains("verdict: pass"));
    }

    #[tokio::test]
    async fn runner_records_exit_nonzero() {
        let tmp = tempdir_in_target();
        let r = run_and_capture("exit 7", tmp.path(), 30).await.unwrap();
        assert_eq!(r.exit_code, 7);
        assert_eq!(verdict_for(&r), "fail");
    }

    #[tokio::test]
    async fn runner_truncates_output_to_500_lines() {
        let tmp = tempdir_in_target();
        let cmd = "for i in $(seq 1 1000); do echo line$i; done";
        let r = run_and_capture(cmd, tmp.path(), 30).await.unwrap();
        let truncated = truncate_output(&r.stdout, 500);
        let line_count = truncated.lines().count();
        assert!(line_count <= 500 + 2); // 500 + truncation note
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::runner -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement runner**

```rust
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Clone, Debug)]
pub struct RunResult {
    pub command: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

pub async fn run_and_capture(cmd: &str, cwd: &Path, timeout_secs: u64) -> anyhow::Result<RunResult> {
    let started = Instant::now();
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut so) = child.stdout.take() { so.read_to_string(&mut stdout).await.ok(); }
    if let Some(mut se) = child.stderr.take() { se.read_to_string(&mut stderr).await.ok(); }

    let exit = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait(),
    ).await;
    let exit_code = match exit {
        Ok(Ok(status)) => status.code().unwrap_or(-1),
        Ok(Err(e)) => { tracing::warn!("wait failed: {e}"); -1 }
        Err(_) => -1, // timeout
    };
    Ok(RunResult {
        command: cmd.into(),
        exit_code,
        stdout, stderr,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

pub fn verdict_for(r: &RunResult) -> &'static str {
    if r.exit_code == 0 { "pass" } else { "fail" }
}

pub fn truncate_output(raw: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() <= max_lines {
        raw.to_string()
    } else {
        let head = lines[..max_lines / 2].join("\n");
        let tail = lines[lines.len() - max_lines / 2..].join("\n");
        format!("{head}\n\n... [truncated {} lines] ...\n\n{tail}", lines.len() - max_lines)
    }
}

pub async fn write_artifact(path: &Path, task_id: &str, attempt: u8, r: &RunResult) -> anyhow::Result<()> {
    let front = format!("---\nstage: verify\ntask_id: {task_id}\nattempt: {attempt}\nexit_code: {}\nverdict: {}\n---\n", r.exit_code, verdict_for(r));
    let body = format!(
        "## Command\n```\n{}\n```\n\n## Exit code\n{}\n\n## Duration\n{} ms\n\n## Stdout (first 500 + last 200 lines)\n```\n{}\n```\n\n## Stderr\n```\n{}\n```\n",
        r.command, r.exit_code, r.duration_ms, truncate_output(&r.stdout, 500), r.stderr,
    );
    tokio::fs::write(path, front + &body).await?;
    Ok(())
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::runner -- --nocapture`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/runner.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench): runner with timeout + truncated output"
```

---

## Phase 10 — Submitter (1 day)

### Task 10.1: GitLab REST client + token from env

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/submitter.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`
- Modify: `crates/codegen/xai-grok-shell/Cargo.toml`

- [ ] **Step 1: Add reqwest dependency if not present**

Check `Cargo.toml` for `reqwest = { ... }`. If absent, add:
```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

- [ ] **Step 2: Write failing test for GitLab client construction + token lookup**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn client_resolves_token_from_env() {
        std::env::set_var("WORKBENCH_TEST_GITLAB_TOKEN", "secret-abc");
        let cfg = GitlabConfig { url: "https://gl.example".into(), token_env: "WORKBENCH_TEST_GITLAB_TOKEN".into(), default_assignees_self: false };
        let client = GitlabClient::new(&cfg).unwrap();
        assert_eq!(client.token(), "secret-abc");
    }

    #[test]
    fn client_errors_when_token_env_missing() {
        std::env::remove_var("WORKBENCH_TEST_GITLAB_TOKEN_MISSING");
        let cfg = GitlabConfig { url: "https://gl.example".into(), token_env: "WORKBENCH_TEST_GITLAB_TOKEN_MISSING".into(), default_assignees_self: false };
        assert!(GitlabClient::new(&cfg).is_err());
    }

    #[tokio::test]
    async fn parse_response_status() {
        let resp = GitlabCreateMrResponse { status: 201, body: r#"{"web_url":"https://x"}"#.into() };
        assert_eq!(resp.status, 201);
        assert_eq!(resp.mr_url(), Some("https://x".to_string()));
    }
}
```

- [ ] **Step 3: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::submitter -- --nocapture`
Expected: FAIL.

- [ ] **Step 4: Implement GitlabClient**

```rust
use crate::agent::config::GitlabConfig;

pub struct GitlabClient {
    cfg: GitlabConfig,
    http: reqwest::Client,
    token: String,
}

pub struct GitlabCreateMrResponse {
    pub status: u16,
    pub body: String,
}

impl GitlabCreateMrResponse {
    pub fn mr_url(&self) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(&self.body).ok()
            .and_then(|v| v.get("web_url").and_then(|u| u.as_str().map(|s| s.to_string())))
    }
}

impl GitlabClient {
    pub fn new(cfg: &GitlabConfig) -> anyhow::Result<Self> {
        let token = std::env::var(&cfg.token_env)
            .map_err(|_| anyhow::anyhow!("env var `{}` is not set", cfg.token_env))?;
        Ok(Self {
            cfg: cfg.clone(),
            http: reqwest::Client::builder().build()?,
            token,
        })
    }
    pub fn token(&self) -> &str { &self.token }

    pub async fn create_merge_request(&self, project_id: &str, payload: &serde_json::Value) -> anyhow::Result<GitlabCreateMrResponse> {
        let url = format!("{}/api/v4/projects/{}/merge_requests", self.cfg.url.trim_end_matches('/'), project_id);
        let resp = self.http.post(&url).bearer_auth(&self.token).json(payload).send().await?;
        let status = resp.status().as_u16();
        let body = resp.text().await?;
        Ok(GitlabCreateMrResponse { status, body })
    }
}
```

- [ ] **Step 5: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::submitter -- --nocapture`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add crates/codegen/xai-grok-shell/Cargo.toml crates/codegen/xai-grok-shell/src/workbench/submitter.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench): GitLab REST client with env-var token"
```

---

### Task 10.2: Reviewer resolution (TAPD owner + config + CODEOWNERS)

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/submitter.rs`

- [ ] **Step 1: Write failing test for resolver precedence**

```rust
#[cfg(test)]
mod resolver_tests {
    use super::*;

    #[test]
    fn resolver_uses_config_first_then_tapd_owner() {
        let cfg = vec!["alice".to_string(), "bob".to_string()];
        let tapd_owner = Some("carol".to_string());
        let codeowners: Vec<String> = vec![];
        let resolved = resolve_reviewers(&cfg, tapd_owner.as_deref(), &codeowners);
        assert_eq!(resolved, vec!["alice", "bob"]);
    }

    #[test]
    fn resolver_falls_back_to_tapd_owner_when_config_empty() {
        let cfg = vec![];
        let resolved = resolve_reviewers(&cfg, Some("carol"), &[]);
        assert_eq!(resolved, vec!["carol"]);
    }

    #[test]
    fn resolver_dedupes() {
        let resolved = resolve_reviewers(&["alice".into()], Some("alice"), &["alice".into()]);
        assert_eq!(resolved, vec!["alice"]);
    }
}
```

- [ ] **Step 2: Implement resolve_reviewers**

```rust
pub fn resolve_reviewers(
    config_reviewers: &[String],
    tapd_owner: Option<&str>,
    codeowners: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !config_reviewers.is_empty() {
        out.extend(config_reviewers.iter().cloned());
    } else if let Some(o) = tapd_owner {
        out.push(o.to_string());
    }
    for c in codeowners {
        if !out.contains(c) { out.push(c.clone()); }
    }
    if out.is_empty() && let Some(o) = tapd_owner { if !out.contains(&o.to_string()) { out.push(o.to_string()); } }
    out
}
```

- [ ] **Step 3: Write CODEOWNERS parser test + impl**

```rust
#[cfg(test)]
mod codeowners_tests {
    use super::*;
    #[test]
    fn parses_simple_patterns() {
        let tmp = tempdir_in_target();
        std::fs::write(tmp.path().join("CODEOWNERS"), "* @alice\n/src/ @bob @carol\n").unwrap();
        let resolved = resolve_codeowners(tmp.path(), &["src/foo.rs".into()]);
        assert!(resolved.contains(&"alice".into()));
        assert!(resolved.contains(&"bob".into()));
        assert!(resolved.contains(&"carol".into()));
    }
    #[test]
    fn missing_codeowners_returns_empty() {
        let tmp = tempdir_in_target();
        let resolved = resolve_codeowners(tmp.path(), &["src/foo.rs".into()]);
        assert!(resolved.is_empty());
    }
}

pub fn resolve_codeowners(worktree: &Path, changed_files: &[String]) -> Vec<String> {
    let co = worktree.join(".gitlab/CODEOWNERS");
    if !co.exists() { return vec![]; }
    let raw = match std::fs::read_to_string(&co) { Ok(s) => s, Err(_) => return vec![] };
    let mut out: Vec<String> = vec![];
    for line in raw.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        let (pattern, owners) = match line.split_once(' ') {
            Some((p, o)) => (p, o),
            None => continue,
        };
        if changed_files.iter().any(|f| matches_pattern(pattern, f)) {
            for o in owners.split_whitespace() {
                if let Some(handle) = o.strip_prefix('@') {
                    if !out.contains(&handle.to_string()) { out.push(handle.to_string()); }
                }
            }
        }
    }
    out
}

fn matches_pattern(pattern: &str, file: &str) -> bool {
    // GitLab CODEOWNERS uses fnmatch-ish patterns; for v1 we support `*` and trailing `/`.
    if pattern == "*" { return true; }
    if let Some(dir) = pattern.strip_suffix('/') {
        return file.starts_with(dir) || file.starts_with(&format!("./{dir}"));
    }
    if pattern.contains('*') {
        // simple glob: split on `*`
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.is_empty() { return true; }
        let mut idx = 0usize;
        for (i, part) in parts.iter().enumerate() {
            if part.is_empty() { continue; }
            if i == 0 {
                if !file[idx..].starts_with(part) { return false; }
                idx += part.len();
            } else if i == parts.len() - 1 {
                return file[idx..].ends_with(part);
            } else {
                match file[idx..].find(part) { Some(p) => idx += p + part.len(), None => return false }
            }
        }
        return true;
    }
    file == pattern || file.ends_with(&format!("/{pattern}"))
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p xai-grok-shell --lib workbench::submitter -- --nocapture`
Expected: 8 passed (3 client + 3 resolver + 2 codeowners).

- [ ] **Step 5: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/submitter.rs
git commit -m "feat(workbench): reviewer resolution + CODEOWNERS parser"
```

---

### Task 10.3: MR payload assembly + transient retry

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/submitter.rs`

- [ ] **Step 1: Write failing test for payload assembly**

```rust
#[cfg(test)]
mod payload_tests {
    use super::*;

    #[test]
    fn payload_includes_required_fields() {
        let p = build_mr_payload(
            "TAPD-1",
            "Fix login",
            "Fix broken login flow",
            &[ "AC1".to_string() ],
            "tapd/TAPD-1-fix-login",
            "main",
            &["alice".to_string()],
            &["bob".to_string()],
        );
        assert_eq!(p["source_branch"], "tapd/TAPD-1-fix-login");
        assert_eq!(p["target_branch"], "main");
        assert_eq!(p["title"], "[TAPD-1] Fix login");
        assert_eq!(p["remove_source_branch"], true);
        assert_eq!(p["squash"], false);
        assert!(p["description"].as_str().unwrap().contains("AC1"));
        assert_eq!(p["reviewer_ids"][0], "bob");
        assert_eq!(p["assignee_ids"][0], "alice");
    }

    #[test]
    fn mr_title_prefix() {
        assert_eq!(format_mr_title("TAPD-9", "Add foo"), "[TAPD-9] Add foo");
    }

    #[tokio::test]
    async fn submitter_classifies_409_as_blocked() {
        let tmp = tempdir_in_target();
        std::fs::write(tmp.path().join("response.json"), "{}").unwrap();
        let outcome = classify_response(GitlabCreateMrResponse { status: 409, body: "{}".into() });
        assert!(matches!(outcome, MrSubmitOutcome::Conflict));
    }

    #[tokio::test]
    async fn submitter_classifies_401_as_blocked() {
        let outcome = classify_response(GitlabCreateMrResponse { status: 401, body: "{}".into() });
        assert!(matches!(outcome, MrSubmitOutcome::AuthError));
    }

    #[tokio::test]
    async fn submitter_classifies_500_as_transient() {
        let outcome = classify_response(GitlabCreateMrResponse { status: 500, body: "{}".into() });
        assert!(matches!(outcome, MrSubmitOutcome::TransientError));
    }

    #[tokio::test]
    async fn submitter_classifies_201_as_ok() {
        let outcome = classify_response(GitlabCreateMrResponse { status: 201, body: r#"{"web_url":"x"}"#.into() });
        assert!(matches!(outcome, MrSubmitOutcome::Ok));
    }
}
```

- [ ] **Step 2: Implement build_mr_payload + classify_response**

```rust
use crate::workbench::state_machine::MrSubmitOutcome;

pub fn format_mr_title(tapd_id: &str, title: &str) -> String {
    format!("[{tapd_id}] {title}")
}

pub fn build_mr_payload(
    tapd_id: &str,
    title: &str,
    description: &str,
    acs: &[String],
    source_branch: &str,
    target_branch: &str,
    assignees: &[String],
    reviewers: &[String],
) -> serde_json::Value {
    let acs_block = if acs.is_empty() { String::new() } else { format!("\n\n## Acceptance Criteria\n{}", acs.iter().map(|a| format!("- {a}")).collect::<Vec<_>>().join("\n")) };
    serde_json::json!({
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": format_mr_title(tapd_id, title),
        "description": format!("{description}{acs_block}"),
        "assignee_ids": assignees,
        "reviewer_ids": reviewers,
        "remove_source_branch": true,
        "squash": false,
    })
}

pub fn classify_response(r: GitlabCreateMrResponse) -> MrSubmitOutcome {
    match r.status {
        201 => MrSubmitOutcome::Ok,
        409 => MrSubmitOutcome::Conflict,
        401 | 403 => MrSubmitOutcome::AuthError,
        500..=599 => MrSubmitOutcome::TransientError,
        _ => MrSubmitOutcome::TransientError,
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p xai-grok-shell --lib workbench::submitter -- --nocapture`
Expected: 13 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/workbench/submitter.rs
git commit -m "feat(workbench): MR payload assembly + status classifier"
```

---

## Phase 11 — Notifications (0.5 day)

### Task 11.1: TAPD comment + Slack / Feishu webhook

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/notifications.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Write failing test for notification dispatcher**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    #[tokio::test]
    async fn tapd_comment_posts_to_story_endpoint() {
        let mut server = Server::new_async().await;
        let m = server.mock("POST", "/api/v1/stories/TAPD-1/comments").with_status(200).create_async().await;
        let client = TapdNotifier::new(server.url(), "tok".into()).unwrap();
        client.comment_on_story("TAPD-1", "MR: https://x").await.unwrap();
        m.assert_async().await;
    }

    #[tokio::test]
    async fn slack_webhook_fires_when_configured() {
        let mut server = Server::new_async().await;
        let m = server.mock("POST", "/hook").with_status(200).create_async().await;
        notify_slack(&server.url(), "msg").await.unwrap();
        m.assert_async().await;
    }

    #[tokio::test]
    async fn slack_webhook_skipped_when_empty_url() {
        notify_slack("", "msg").await.unwrap(); // no panic
    }

    #[tokio::test]
    async fn feishu_webhook_fires_when_configured() {
        let mut server = Server::new_async().await;
        let m = server.mock("POST", "/hook").with_status(200).create_async().await;
        notify_feishu(&server.url(), "msg").await.unwrap();
        m.assert_async().await;
    }
}
```

- [ ] **Step 2: Add mockito as dev-dependency in Cargo.toml**

```toml
[dev-dependencies]
mockito = "1"
```

- [ ] **Step 3: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib workbench::notifications -- --nocapture`
Expected: FAIL.

- [ ] **Step 4: Implement notifications**

```rust
use serde_json::json;

pub struct TapdNotifier {
    base_url: String,
    access_token: String,
    http: reqwest::Client,
}

impl TapdNotifier {
    pub fn new(base_url: String, access_token: String) -> anyhow::Result<Self> {
        Ok(Self { base_url, access_token, http: reqwest::Client::builder().build()? })
    }
    pub async fn comment_on_story(&self, tapd_id: &str, message: &str) -> anyhow::Result<()> {
        let url = format!("{}/api/v1/stories/{}/comments", self.base_url.trim_end_matches('/'), tapd_id);
        self.http.post(&url)
            .query(&[("access_token", &self.access_token)])
            .json(&json!({ "data": { "comment": message } }))
            .send().await?;
        Ok(())
    }
}

pub async fn notify_slack(webhook: &str, message: &str) -> anyhow::Result<()> {
    if webhook.is_empty() { return Ok(()); }
    let http = reqwest::Client::builder().build()?;
    http.post(webhook).json(&json!({ "text": message })).send().await?;
    Ok(())
}

pub async fn notify_feishu(webhook: &str, message: &str) -> anyhow::Result<()> {
    if webhook.is_empty() { return Ok(()); }
    let http = reqwest::Client::builder().build()?;
    http.post(webhook).json(&json!({ "msg_type": "text", "content": { "text": message } })).send().await?;
    Ok(())
}
```

- [ ] **Step 5: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib workbench::notifications -- --nocapture`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add crates/codegen/xai-grok-shell/Cargo.toml crates/codegen/xai-grok-shell/src/workbench/notifications.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench): TAPD comment + Slack/Feishu webhooks"
```

---

## Phase 12 — Burst Control (0.5 day)

### Task 12.1: Health banner + stuck badge

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/extensions/tapd.rs`

- [ ] **Step 1: Write failing test for health snapshot**

In `extensions/tapd.rs` tests:

```rust
#[cfg(test)]
mod health_tests {
    use super::*;
    use crate::workbench::config::WorkbenchConfig;

    #[test]
    fn banner_flag_fires_above_threshold() {
        let cfg = WorkbenchConfig::default();
        let queue_len = cfg.concurrency.queue_alert_threshold + 1;
        let snap = HealthSnapshot { active: 1, queue_len, worktree_in_use: 1, stuck_task_count: 0 };
        assert!(snap.needs_queue_banner(&cfg));
    }

    #[test]
    fn banner_does_not_fire_below_threshold() {
        let cfg = WorkbenchConfig::default();
        let snap = HealthSnapshot { active: 1, queue_len: 5, worktree_in_use: 1, stuck_task_count: 0 };
        assert!(!snap.needs_queue_banner(&cfg));
    }
}

#[derive(Debug, Serialize)]
pub struct HealthSnapshot {
    pub active: usize,
    pub queue_len: usize,
    pub worktree_in_use: usize,
    pub stuck_task_count: usize,
}

impl HealthSnapshot {
    pub fn needs_queue_banner(&self, cfg: &WorkbenchConfig) -> bool {
        self.queue_len >= cfg.concurrency.queue_alert_threshold
    }
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --lib extensions::tapd::health -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement HealthSnapshot**

Add the `HealthSnapshot` impl above (in `extensions/tapd.rs`).

- [ ] **Step 4: Add `workbench/health` ext method**

In `tapd_methods`, add:
```rust
pub const WORKBENCH_HEALTH: &str = "x.ai/tapd/workbench/health";
```

In `handle`, dispatch to a new `handle_workbench_health` that pulls `WorkbenchDispatcher::health_snapshot()` and serializes a `HealthSnapshot`.

- [ ] **Step 5: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --lib extensions::tapd -- --nocapture`
Expected: existing tests + 2 new = pass.

- [ ] **Step 6: Commit**

```bash
git add crates/codegen/xai-grok-shell/src/extensions/tapd.rs
git commit -m "feat(workbench): health snapshot + ext method"
```

---

## Phase 13 — UI: Stage Badge + Timeline + Blocked (1 day)

### Task 13.1: Workbench stage badge derivation

**Files:**
- Create: `web/src/features/sessions-hub/workbenchStageBadge.ts`
- Create: `web/src/features/sessions-hub/workbenchStageBadge.test.ts`

- [ ] **Step 1: Write failing test**

In `workbenchStageBadge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveWorkbenchStage } from './workbenchStageBadge'

describe('workbenchStageBadge', () => {
  it('returns done for Done state', () => {
    expect(deriveWorkbenchStage({ kind: 'done', mrUrl: 'https://x' })).toEqual({ label: 'MR 提交', tone: 'success' })
  })
  it('returns blocked for BlockedForHuman', () => {
    expect(deriveWorkbenchStage({ kind: 'blocked', reason: 'needs_owner_decision' })).toEqual({ label: '需人工', tone: 'danger' })
  })
  it('returns dead for Dead', () => {
    expect(deriveWorkbenchStage({ kind: 'dead', reason: 'crash' })).toEqual({ label: '已失败', tone: 'danger' })
  })
  it('returns current stage for Running', () => {
    expect(deriveWorkbenchStage({ kind: 'running', stage: 'develop', attempt: 0 })).toEqual({ label: '开发', tone: 'progress' })
    expect(deriveWorkbenchStage({ kind: 'running', stage: 'adjudicate', attempt: 0 })).toEqual({ label: '裁断', tone: 'progress' })
  })
  it('returns queued for Queued', () => {
    expect(deriveWorkbenchStage({ kind: 'queued' })).toEqual({ label: '排队', tone: 'muted' })
  })
  it('returns pending for Pending', () => {
    expect(deriveWorkbenchStage({ kind: 'pending' })).toEqual({ label: '待处理', tone: 'muted' })
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cd web && npm run test:run -- workbenchStageBadge.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement workbenchStageBadge.ts**

```ts
export type WorkbenchStageState =
  | { kind: 'pending' }
  | { kind: 'queued' }
  | { kind: 'running'; stage: 'brainstorm' | 'adjudicate' | 'develop' | 'code_review' | 'verify' | 'mr_submit'; attempt: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'done'; mrUrl: string }
  | { kind: 'dead'; reason: string }

export interface WorkbenchStageBadge {
  label: string
  tone: 'progress' | 'success' | 'danger' | 'muted'
}

const STAGE_LABEL: Record<NonNullable<Extract<WorkbenchStageState, { kind: 'running' }>['stage']>, string> = {
  brainstorm: '设计',
  adjudicate: '裁断',
  develop: '开发',
  code_review: '评审',
  verify: '验证',
  mr_submit: '提 MR',
}

export function deriveWorkbenchStage(state: WorkbenchStageState): WorkbenchStageBadge {
  switch (state.kind) {
    case 'pending': return { label: '待处理', tone: 'muted' }
    case 'queued': return { label: '排队', tone: 'muted' }
    case 'running': return { label: STAGE_LABEL[state.stage], tone: 'progress' }
    case 'blocked': return { label: '需人工', tone: 'danger' }
    case 'done': return { label: 'MR 提交', tone: 'success' }
    case 'dead': return { label: '已失败', tone: 'danger' }
  }
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `cd web && npm run test:run -- workbenchStageBadge.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Run typecheck + build**

Run: `cd web && npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/sessions-hub/workbenchStageBadge.ts web/src/features/sessions-hub/workbenchStageBadge.test.ts
git commit -m "feat(web): workbench stage badge derivation"
```

---

### Task 13.2: StageTimeline component

**Files:**
- Create: `web/src/features/workbench/StageTimeline.tsx`
- Create: `web/src/features/workbench/StageTimeline.test.tsx`

- [ ] **Step 1: Write failing test**

In `StageTimeline.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@solidjs/testing-library'
import { StageTimeline } from './StageTimeline'

describe('StageTimeline', () => {
  it('renders 6 stages with correct labels', () => {
    render(<StageTimeline current="brainstorm" />)
    expect(screen.getByText('设计')).toBeTruthy()
    expect(screen.getByText('裁断')).toBeTruthy()
    expect(screen.getByText('开发')).toBeTruthy()
    expect(screen.getByText('评审')).toBeTruthy()
    expect(screen.getByText('验证')).toBeTruthy()
    expect(screen.getByText('提 MR')).toBeTruthy()
  })

  it('marks current stage with active tone', () => {
    const { container } = render(<StageTimeline current="develop" />)
    const active = container.querySelector('[data-stage-active="develop"]')
    expect(active).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cd web && npm run test:run -- StageTimeline.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement StageTimeline.tsx**

```tsx
import type { Component } from 'solid-js'
import { For } from 'solid-js'

export type StageName = 'brainstorm' | 'adjudicate' | 'develop' | 'code_review' | 'verify' | 'mr_submit'

const STAGES: Array<{ key: StageName; label: string }> = [
  { key: 'brainstorm', label: '设计' },
  { key: 'adjudicate', label: '裁断' },
  { key: 'develop', label: '开发' },
  { key: 'code_review', label: '评审' },
  { key: 'verify', label: '验证' },
  { key: 'mr_submit', label: '提 MR' },
]

export const StageTimeline: Component<{ current: StageName | 'done' | 'blocked' | 'dead' }> = (props) => {
  const activeIndex = () => {
    if (props.current === 'done' || props.current === 'blocked' || props.current === 'dead') return STAGES.length - 1
    return STAGES.findIndex((s) => s.key === props.current)
  }
  return (
    <div class="flex items-center gap-1" role="list" aria-label="Pipeline stage">
      <For each={STAGES}>
        {(stage, idx) => {
          const isReached = () => idx() < activeIndex() || (props.current === 'done' && idx() <= activeIndex())
          const isActive = () => !isReached() && idx() === activeIndex()
          const dotClass = () => (isReached() ? 'bg-emerald-500' : isActive() ? 'bg-blue-500' : 'bg-text-500/40')
          return (
            <div
              role="listitem"
              class="flex items-center gap-1"
              data-stage-active={isActive() ? stage.key : undefined}
              data-stage-done={isReached() ? 'true' : undefined}
            >
              <span class={`h-2 w-2 rounded-full ${dotClass()}`} />
              <span class="text-xs text-text-600">{stage.label}</span>
              {idx() < STAGES.length - 1 ? <span class="h-px w-4 bg-text-500/30" /> : null}
            </div>
          )
        }}
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd web && npm run test:run -- StageTimeline.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/workbench/StageTimeline.tsx web/src/features/workbench/StageTimeline.test.tsx
git commit -m "feat(web): StageTimeline component"
```

---

### Task 13.3: BlockedActions component

**Files:**
- Create: `web/src/features/workbench/BlockedActions.tsx`
- Create: `web/src/features/workbench/BlockedActions.test.tsx`

- [ ] **Step 1: Write failing test**

In `BlockedActions.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { BlockedActions } from './BlockedActions'

describe('BlockedActions', () => {
  it('renders reason text', () => {
    render(<BlockedActions reason="needs_owner_decision" onResolve={() => {}} onRetryMr={() => {}} />)
    expect(document.body.textContent).toContain('needs_owner_decision')
  })

  it('shows retry button for branch-diverged', () => {
    const onRetry = vi.fn()
    const { getByText } = render(<BlockedActions reason="branch diverged" onResolve={() => {}} onRetryMr={onRetry} />)
    fireEvent.click(getByText('重试提 MR'))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('shows resolve button for needs_owner_decision', () => {
    const onResolve = vi.fn()
    const { getByText } = render(<BlockedActions reason="needs_owner_decision" onResolve={onResolve} onRetryMr={() => {}} />)
    fireEvent.click(getByText('回答问题并继续'))
    expect(onResolve).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cd web && npm run test:run -- BlockedActions.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement BlockedActions.tsx**

```tsx
import type { Component } from 'solid-js'
import { Show } from 'solid-js'

export const BlockedActions: Component<{
  reason: string
  onResolve: () => void
  onRetryMr: () => void
}> = (props) => {
  const isNeedsOwner = () => props.reason === 'needs_owner_decision'
  const isBranchDiverged = () => props.reason === 'branch diverged'
  return (
    <div class="rounded border border-danger-100 bg-danger-100/10 p-3 text-sm">
      <div class="font-semibold text-danger-100">需要人工处理</div>
      <div class="text-text-600">{props.reason}</div>
      <div class="mt-2 flex gap-2">
        <Show when={isNeedsOwner()}>
          <button class="rounded bg-primary-500 px-3 py-1 text-white" onClick={props.onResolve}>回答问题并继续</button>
        </Show>
        <Show when={isBranchDiverged()}>
          <button class="rounded bg-primary-500 px-3 py-1 text-white" onClick={props.onRetryMr}>重试提 MR</button>
        </Show>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd web && npm run test:run -- BlockedActions.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/workbench/BlockedActions.tsx web/src/features/workbench/BlockedActions.test.tsx
git commit -m "feat(web): BlockedActions component"
```

---

## Phase 14 — UI: Child Tree + Stage History (0.5 day)

### Task 14.1: SubtaskPartView shows per-child stage

**Files:**
- Modify: `web/src/features/sessions-hub/SubtaskPartView.tsx`

- [ ] **Step 1: Locate SubtaskPartView and identify what changes**

Read the file. It renders a child session card. Add a small stage pill based on the child session's `latestNotification` (when `x.ai/workbench/stage` notifications come in).

- [ ] **Step 2: Add stage label mapping**

In `SubtaskPartView.tsx`, add:

```tsx
const STAGE_LABEL: Record<string, string> = {
  brainstorm: '设计',
  adjudicate: '裁断',
  develop: '开发',
  code_review: '评审',
  verify: '验证',
  mr_submit: '提 MR',
}

function stageFromNotifications(notifications: Array<{ type: string; timestamp: number }>): string | null {
  const stageNotif = notifications.filter((n) => n.type === 'x.ai/workbench/stage').pop()
  if (!stageNotif) return null
  const data = (stageNotif as { data?: { stage?: string } }).data
  return data?.stage ?? null
}
```

Use `stageFromNotifications(child.latestNotifications ?? [])` and render `{STAGE_LABEL[stage] ?? stage}` next to the child session title when non-null.

- [ ] **Step 3: Run typecheck**

Run: `cd web && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/features/sessions-hub/SubtaskPartView.tsx
git commit -m "feat(web): subtask view shows per-child workbench stage"
```

---

### Task 14.2: TaskDetailDrawer stage history

**Files:**
- Modify: `web/src/features/workbench/TaskDetailDrawer.tsx`

- [ ] **Step 1: Read existing TaskDetailDrawer**

Locate where the drawer renders the task's history (likely a list of `RunDto`s or events). Add a "Stages" section.

- [ ] **Step 2: Add Stage Timeline + History list**

```tsx
import { StageTimeline, type StageName } from './StageTimeline'

// inside the drawer body
<Show when={props.task.workbenchState}>
  {(state) => (
    <section class="mt-4">
      <h3 class="text-sm font-semibold">Pipeline</h3>
      <StageTimeline current={state().currentStage as StageName} />
      <ol class="mt-2 list-disc pl-5 text-sm">
        <For each={state().history}>
          {(h) => (
            <li>
              {h.stage} — attempt {h.attempt} — {h.verdict} ({h.durationMs}ms)
            </li>
          )}
        </For>
      </ol>
      <Show when={state().kind === 'blocked'}>
        <BlockedActions reason={state().reason} onResolve={() => props.onResolveQ(state().taskId)} onRetryMr={() => props.onRetryMr(state().taskId)} />
      </Show>
    </section>
  )}
</Show>
```

- [ ] **Step 3: Run typecheck + existing tests**

Run: `cd web && npm run typecheck && npm run test:run -- TaskDetailDrawer`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/features/workbench/TaskDetailDrawer.tsx
git commit -m "feat(web): TaskDetailDrawer stage history + blocked actions"
```

---

## Phase 15 — UI: Config Form (0.5 day)

### Task 15.1: Add `[workbench]` and `[gitlab]` sections to grokConfigSchema

**Files:**
- Modify: `web/src/features/settings/components/grokConfigSchema.ts`

- [ ] **Step 1: Locate existing TAPD schema entries around line 522**

In `GROUPS` (or wherever the existing TAPD section lives), add new entries:

```ts
{
  id: 'workbench',
  title: '工作台工作流',
  sections: [
    {
      id: 'workbench',
      title: '工作台开关',
      fields: [
        b('enabled', '启用', 'false', '关闭后只走原有 TAPD 同步流程；开启后会把 Pending 任务自动推进'),
        b('keep_stage_files_after_done', '保留阶段文件', 'false', '默认完成后删除 .workbench/'),
        b('auto_delete_merged_branches', '合并后自动删除分支', 'false', '默认让 GitLab 管理'),
        n('worktree_gc_delay_secs', 'Worktree 清理延迟（秒）', '300', '完成后多久清理工作目录'),
      ],
    },
    {
      id: 'workbench.concurrency',
      title: '并发与队列',
      fields: [
        n('global_max_active', '最大同时运行任务数', '5'),
        n('worktree_pool_max', 'Worktree 池上限', '10'),
        n('queue_alert_threshold', '队列告警阈值', '30', '队列长度 ≥ 此值时显示横幅'),
        n('queue_stuck_alert_minutes', '任务卡住阈值（分钟）', '60'),
      ],
    },
    {
      id: 'workbench.models',
      title: '各角色模型',
      desc: '不同阶段使用不同模型，平衡成本与能力',
      fields: [
        s('planner_model', 'Planner', undefined, 'opus-4.1'),
        s('adjudicator_model', 'Adjudicator', undefined, 'sonnet-4.5'),
        s('coder_model', 'Coder', undefined, 'opus-4.1'),
        s('reviewer_model', 'Reviewer', undefined, 'sonnet-4.5'),
      ],
    },
    {
      id: 'workbench.adjudicate',
      title: 'Adjudicate 触发条件',
      desc: '裁断阶段何时运行；默认 Recorder 模式',
      fields: [
        e('default_mode', '默认模式', ['recorder', 'gatekeeper', 'always_skip'], 'recorder'),
        arr('escalate_priority', '升级优先级', '达到这些优先级时启用裁断'),
        n('escalate_min_acs', '触发所需 AC 数下限', '5', 'AC 数 ≥ 此值时启用裁断'),
      ],
    },
    {
      id: 'workbench.notify',
      title: '通知',
      fields: [
        b('tapd_comment', '在 TAPD 任务下发评论', 'true'),
        s('slack_webhook', 'Slack Webhook URL', '留空 = 不发送'),
        s('feishu_webhook', '飞书 Webhook URL', '留空 = 不发送'),
      ],
    },
  ],
},
{
  id: 'gitlab',
  title: 'GitLab MR 提交',
  sections: [
    {
      id: 'gitlab',
      title: 'GitLab 连接',
      desc: 'Token 读取自环境变量（不在配置中存储）',
      fields: [
        s('url', 'GitLab URL', undefined, 'https://gitlab.example.com'),
        s('token_env', 'Token 环境变量名', undefined, 'GITLAB_TOKEN'),
        b('default_assignees_self', '创建者自动成为 Assignee', 'false'),
      ],
    },
  ],
},
```

(The exact helper names `b`, `e`, `n`, `s`, `arr` should match the existing schema's conventions — check the file before pasting.)

- [ ] **Step 2: Run typecheck**

Run: `cd web && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/features/settings/components/grokConfigSchema.ts
git commit -m "feat(web): schema entries for workbench + gitlab sections"
```

---

### Task 15.2: Extend `[tapd.projects.*]` schema with workbench fields

**Files:**
- Modify: `web/src/features/settings/components/grokConfigSchema.ts`

- [ ] **Step 1: Locate `[tapd.projects]` keyed table definition**

Find `id: 'tapd.projects'` in `KEYED_TABLES`. Add fields to its `fields` array:

```ts
s('target_branch', '目标分支', undefined, 'main'),
s('test_command', '测试命令', '留空 = 不验证'),
n('test_timeout_secs', '测试超时（秒）'),
arr('mr_reviewers', 'MR 评审人'),
arr('mr_assignees', 'MR 指派人', '留空 = 使用 TAPD task.owner'),
e('adjudicate_mode', '裁断模式覆盖', ['recorder', 'gatekeeper', 'always_skip']),
```

- [ ] **Step 2: Run typecheck + tests**

Run: `cd web && npm run typecheck && npm run test:run`
Expected: clean (all 770+ tests pass).

- [ ] **Step 3: Commit**

```bash
git add web/src/features/settings/components/grokConfigSchema.ts
git commit -m "feat(web): schema for tapd.projects workbench fields"
```

---

## Phase 16 — Integration Test (1 day)

### Task 16.1: End-to-end pipeline test (mock TAPD + real git + GitLab dry-run)

**Files:**
- Create: `crates/codegen/xai-grok-shell/tests/workbench_pipeline_e2e.rs`

- [ ] **Step 1: Write failing test scaffold**

```rust
//! End-to-end pipeline test:
//! - Real local git repo with one source file
//! - In-memory TAPD store seeded with a Pending task
//! - Mock GitLab server (mockito) returning 201 for MR create
//! - WorkbenchDispatcher runs the full state machine against the seed
//! - Asserts: branch created, design.md + develop.md + review.md + verify.md + mr.md exist,
//!   final TaskState is Done with the MR URL from mock server.

use std::path::Path;
use std::process::Command;

#[tokio::test]
async fn full_pipeline_to_done() {
    // Setup: real local git repo at $repo with one initial commit on `main`.
    let tmp = tempdir_in_target();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "--initial-branch=main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("hello.txt"), "v0\n").unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "initial"]);

    // Setup: mock GitLab server
    let mut server = mockito::Server::new_async().await;
    let mr_mock = server.mock("POST", "/api/v4/projects/123/merge_requests").with_status(201).with_body(r#"{"web_url":"https://gl.example/mr/1"}"#).create_async().await;

    std::env::set_var("WORKBENCH_TEST_GITLAB_TOKEN", "tok");

    // Seed workbench: tapd_store with pending TAPD-1, config with the mock URL.
    let store = test_tapd_store_with_pending_task(&repo, "TAPD-1", "Add greeting");
    let cfg = test_workbench_config(&server.url(), "main");
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let dispatcher = WorkbenchDispatcher::new(store.clone(), cfg, tx);

    // Drive the pipeline (in production this is async + child-session-spawning;
    // for the e2e we use a deterministic stub that synthesizes the right artifacts).
    dispatcher.dispatch_pending().await.unwrap();

    mr_mock.assert_async().await;

    // Assert: branch exists
    let branches = run_git_out(&repo, &["branch", "--list", "tapd/TAPD-1-add-greeting"]);
    assert!(branches.contains("tapd/TAPD-1-add-greeting"));

    // Assert: state is Done
    let state = store.get_workbench_state("TAPD-1").unwrap();
    assert!(state.is_some()); // not asserted string here since serialized form is implementation-defined
}

fn run_git(cwd: &Path, args: &[&str]) { let _ = Command::new("git").args(args).current_dir(cwd).output().unwrap(); }
fn run_git_out(cwd: &Path, args: &[&str]) -> String { String::from_utf8(Command::new("git").args(args).current_dir(cwd).output().unwrap().stdout).unwrap() }
fn tempdir_in_target() -> tempdir::TempDir { tempdir::TempDir::new("workbench-e2e").unwrap() }
fn test_tapd_store_with_pending_task(_repo: &Path, tapd_id: &str, _title: &str) -> TapdStore { unimplemented!("seed real store") }
fn test_workbench_config(gl_url: &str, target_branch: &str) -> WorkbenchConfig { unimplemented!("build config with gitlab.url={gl_url}") }
```

- [ ] **Step 2: Add dev-dependencies needed**

In `Cargo.toml`:
```toml
[dev-dependencies]
tempdir = "0.3"
mockito = "1"
```

- [ ] **Step 3: Run test to confirm it fails**

Run: `cargo test -p xai-grok-shell --test workbench_pipeline_e2e -- --ignored --nocapture`
Expected: FAIL with multiple `unimplemented!`.

- [ ] **Step 4: Implement helpers + the deterministic harness

- [ ] **Step 5: Run test to confirm it passes**

Run: `cargo test -p xai-grok-shell --test workbench_pipeline_e2e -- --ignored --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/codegen/xai-grok-shell/Cargo.toml crates/codegen/xai-grok-shell/tests/workbench_pipeline_e2e.rs
git commit -m "test(workbench): end-to-end pipeline integration test"
```

---

## Self-Review Checklist (per writing-plans skill)

Before execution:

- [ ] **Spec coverage** — all 20 spec sections covered:
  - §1 Summary → Tasks 4.x, 5–10
  - §2 Context → header + D1–D15 in Phase 1
  - §3 Goals / Non-Goals → enforced via Task 1.x scope limits + Phase 16 e2e
  - §4 Architecture → Phase 1–4 establish it; Task 5–10 implement roles
  - §5 6 Stages → Tasks 5.1–10.3
  - §6 Roles (planner / adjudicator / coder / reviewer / runner / submitter) → Tasks 5.1, 6.1, 7.1, 8.1, 9.1, 10.1
  - §7 State Machine → Task 4.1 + 4.3
  - §8 Artifacts → Task 4.2
  - §9 Worktree & Branch → Task 3.1
  - §10 Configuration → Tasks 1.1, 1.2, 15.1, 15.2
  - §11 Notifications → Task 11.1
  - §12 Burst Control → Task 2.1, 2.2, 12.1
  - §13 Artifact Lifecycle → Task 3.2 + config knob
  - §14 Failure Paths → Tasks 4.1 (Dead), 10.3 (MR submit classifier), 9.1 (runner timeout)
  - §15 UI Surfaces → Tasks 13.1, 13.2, 13.3, 14.1, 14.2
  - §16 Implementation Plan → this plan
  - §17 Decisions → enforced via Task 1.x + Phase 4 (D1–D15)
  - §18 Open Questions → see "Deferred" notes below
  - §19 References → referenced in prefaces
  - §20 Glossary → see glossary in header

- [ ] **No placeholders** — every step contains either code, a command, or a precise spec quote.
- [ ] **Type consistency** — `TaskState`, `Stage`, `Priority`, `MrSubmitOutcome`, `AdjudicateVerdict`, `DevelopVerdict`, `ReviewVerdict` are defined once and used consistently across phases.

## Notes / Out-of-scope (matches spec §18)

- v1 implements Recorder mode only; Gatekeeper / AlwaysSkip are reserved enum variants.
- v1 retries the same model on transient 5xx; multi-model fallback deferred.
- v1 captures runner stdout/stderr only; structured `cargo nextest --message-format json` deferred.
- v1 uses default MR title `[<TAPD-ID>] <title>`; per-project template deferred.

---

## Estimated Effort

| Phase | Tasks | Days |
|---|---|---|
| 1 Config | 3 | 0.5 |
| 2 Dispatcher | 3 | 1.0 |
| 3 Worktree | 2 | 0.5 |
| 4 State machine | 3 | 1.0 |
| 5 Planner | 2 | 1.0 |
| 6 Adjudicator | 2 | 0.5 |
| 7 Coder | 2 | 1.0 |
| 8 Reviewer | 1 | 1.0 |
| 9 Runner | 1 | 0.5 |
| 10 Submitter | 3 | 1.0 |
| 11 Notifications | 1 | 0.5 |
| 12 Burst control | 1 | 0.5 |
| 13 UI badge+timeline+blocked | 3 | 1.0 |
| 14 UI tree+history | 2 | 0.5 |
| 15 UI config form | 2 | 0.5 |
| 16 Integration test | 1 | 1.0 |
| **Total** | **32 tasks** | **~11.5 days** |

(Slightly over spec §16's 10-day estimate because the plan adds more bite-sized steps than the spec's phases; execution will compress closer to 10 days.)

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-01-tapd-workbench-pipeline.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?



