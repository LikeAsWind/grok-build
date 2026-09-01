# TAPD Workbench Pipeline — Design Spec

> Status: **Draft v1**
> Date: 2026-09-01
> Owner: workbench subsystem
> Scope: extends the existing `xai-grok-shell` TAPD sync module (`crates/codegen/xai-grok-shell/src/tapd/`) with an automated, multi-stage workflow that turns each TAPD ticket into a GitLab MR.

---

## 1. Summary

This spec adds a **6-stage pipeline** to the existing TAPD workbench. Each TAPD ticket arriving in `Pending` state is dispatched to a dedicated **main session** (visible in `Sessions Hub`) that runs an opinionated pipeline:

```
Brainstorm → Adjudicate (conditional) → Develop → Code Review → Verify → MR Submit
```

Each stage is owned by a specialized **sub-agent** (planner / adjudicator / coder / reviewer) or a tool-only step (verify runner / MR submitter). Stage transitions are governed by a **Rust state machine** with deterministic retry rules. Artifacts (`design.md`, `develop.md`, `review.md`, `verify.md`, `mr.md`) live in a per-task worktree and are deleted on task completion; the main session's chat history is the only long-term audit source.

The pipeline is **fully autonomous by default**: the user can watch each session's live stream in `Sessions Hub` but does not need to intervene. Failure modes route to `BlockedForHuman` (visible UI badge with action buttons) or `Dead` (terminal failure).

---

## 2. Context & Motivation

The existing TAPD workbench (frontend `web/src/features/workbench/`, backend `crates/codegen/xai-grok-shell/src/tapd/`) implements **pull + display**: TAPD tickets sync into `TapdStore`, surface in the Workbench UI, and stay there waiting for a human to act on them. The pipeline between "task in `Pending`" and "MR submitted" is entirely manual.

This spec closes that gap. Per the workbench's known-gaps list (`AGENTS.md` § Known Gaps), the missing capability is the **agent-driven development lifecycle**. Several pre-requisites already exist:
- Worktree infrastructure (`AGENTS.md` §6d — partial; create flow is wired into `NewSessionDialog`)
- Session stream + child session tree (`AGENTS.md` § Subagent / 子会话视图)
- TAPD sync cursor and store (`crates/codegen/xai-grok-shell/src/tapd/{sync,store}.rs`)
- Workbench status badge + history panel (`web/src/features/workbench/`)

What's missing is the **state machine** that drives an agent through the lifecycle, the **GitLab MR submission path**, and the **integration tests** that prove the loop works end-to-end.

---

## 3. Goals & Non-Goals

### 3.1 Goals

- **G1.** Each `Pending` TAPD task transitions through 6 stages and produces a GitLab MR (or terminates in `BlockedForHuman` / `Dead`).
- **G2.** Main session lifecycle is fully observable in `Sessions Hub` — user sees stage progress, child sessions, retry events, terminal failure.
- **G3.** State transitions are **deterministic and Rust-driven** (no LLM orchestration).
- **G4.** Roles are isolated: planner cannot edit code, reviewer cannot write, coder cannot review its own diff.
- **G5.** Failure recovery is bounded: stage-level retries (default 3) with explicit `BlockedForHuman` after exhaustion.
- **G6.** Configuration is declarative (TOML); pipeline semantics live in code.
- **G7.** Burst load is bounded (global concurrency cap, worktree pool, priority queue).

### 3.2 Non-Goals (out of scope this iteration)

- **N1.** User mid-flight intervention. Main session is read-only observation; users wanting to intervene open a separate ChatPane session.
- **N2.** Auto-merge. MRs are submitted as Draft with reviewers assigned; merge is a human action in GitLab.
- **N3.** Cross-project concurrency. `Q4 = 1 task/project`; projects run in parallel, but each project serializes its own tasks.
- **N4.** Multi-model fallback. v1 retries the same model on transient errors; model swap is a future enhancement.
- **N5.** TAPD status writeback before MR is created. Status only flips to `已实现` after successful MR creation (avoid false positives).
- **N6.** Cron / scheduled tasks / background-task cards. Listed in `AGENTS.md` § Known Gaps as separate work.
- **N7.** Worktree apply / reuse. Each TAPD task gets its own fresh worktree (no existing-worktree adoption).

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────┐
│  TAPD Sync (existing)                                │
│    sync.rs ──→ TapdStore (pending/processing/...)      │
└────────────────────┬─────────────────────────────────┘
                     │ new pending task
                     ▼
┌──────────────────────────────────────────────────────┐
│  WorkbenchDispatcher (NEW)                           │
│   - priority queue (urgent→low, then FIFO)            │
│   - global_max_active = 5, worktree_pool_max = 10     │
│   - slot available → enqueue to main session          │
└────────────────────┬─────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────┐
│  Main Session (workflow runtime, Rust-driven)         │
│   - state machine                                    │
│   - event aggregation stream                         │
│   - never calls LLM directly                         │
└──┬─────────┬──────────┬──────────┬──────────┬────────┘
   ▼         ▼          ▼          ▼          ▼
planner   adjudicator  coder    reviewer   runner/MR
(child)   (child)      (child)  (child)    (tool)
LLM       LLM          LLM      LLM        no LLM
   │         │          │          │          │
   └─────────┴──────────┴──────────┴──────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────┐
│  Worktree (per TAPD task)                            │
│    path: ~/.grok/worktrees/<task-id>/                 │
│    branch: tapd/<task-id>-<slug>                     │
│    .workbench/                                       │
│      stages/1-design.md       (brain + adjudicate)   │
│      stages/3-develop.md                             │
│      stages/4-review.md                              │
│      stages/5-verify.md                              │
│      stages/6-mr.md                                  │
│      state.json                                      │
│      .gitignore  (blocks all .workbench/ from git)   │
└──────────────────────────────────────────────────────┘
```

### Key decisions

- **Main session is a Rust state machine**, not an LLM. It owns the workflow state, advances stages deterministically, and spawns sub-sessions for LLM stages.
- **Sub-agents are real child sessions**, streamed into the main session's event log (reuses `SubtaskPartView` + `childSessionStore` already in `AGENTS.md` § Subagent / 子会话视图).
- **One worktree per TAPD task.** Branch name encodes the task ID; `.workbench/` is `.gitignore`d so it never enters git history.
- **Artifacts are ephemeral.** `.workbench/` is deleted when task reaches terminal state (`Done` / `BlockedForHuman` / `Dead`). Long-term audit comes from the main session's chat history.

---

## 5. Pipeline — 6 Stages

| # | Stage | Trigger | Role | Artifact | Retry to |
|---|---|---|---|---|---|
| 1 | **Brainstorm** | Main session created | `planner` (LLM) | `.workbench/stages/1-design.md` | §7 Adjudicate `revise_design` |
| 2a | **Adjudicate** | design has Open Qs **and** (priority∈{urgent,high} **or** AC≥5) | `adjudicator` (LLM, Recorder mode) | appended to `1-design.md` | §7 Adjudicate `block_for_human` |
| 2b | **Adjudicate (skip)** | design has no Open Qs **or** (priority∉{urgent,high} **and** AC<5) | — | — | — |
| 3 | **Develop** | Adjudicate `proceed` or Adjudicate skipped | `coder` (LLM) | commits + `.workbench/stages/3-develop.md` | §7 CodeReview `needs_changes` **or** Verify `fail` |
| 4 | **Code Review** | Develop `ok` | `reviewer` (LLM) | `.workbench/stages/4-review.md` | — |
| 5 | **Verify** | Code Review `approved` | `runner` (tool only) | `.workbench/stages/5-verify.md` | §7 Verify `fail` |
| 6 | **MR Submit** | Verify `pass` | `submitter` (tool only) | `.workbench/stages/6-mr.md` | §7 MrSubmit `conflict` / `auth_error` |

**Conditional skip (stage 2):** Adjudicate runs only when there is real ambiguity to resolve. Clean designs skip it for cost. Per-task override via `[tapd.projects.<key>].adjudicate_mode`.

**Stage ordering:** strictly sequential within one task. No parallel stages.

---

## 6. Roles

Six roles total: four LLM-driven, two tool-only.

### 6.1 Planner (LLM)
- **Stage:** Brainstorm
- **Tools:** `read_file`, `glob`, `grep` (Rust allowlist enforced)
- **Writes:** only `.workbench/stages/1-design.md`
- **Forbidden:** `write_file` / `edit_file` to anything else, `bash`, `git`
- **Output frontmatter:**
  ```yaml
  stage: brainstorm
  task_id: <TAPD-ID>
  attempt: <int>
  ```
- **Output body schema:** Goal / Approach / Files to modify / Edge cases / Out of scope / Open questions
- **Template:** `crates/codegen/xai-grok-shell/src/workbench/prompts/planner.md.tmpl`

### 6.2 Adjudicator (LLM)
- **Stage:** Adjudicate
- **Tools:** `read_file`, `edit_file` (path filter: only `1-design.md`)
- **Writes:** appends `## Adjudication` section to `1-design.md`; updates frontmatter `adjudicated: true, verdict: <proceed|block_for_human>`
- **Forbidden:** `write_file` elsewhere, `bash`, `git`, all code-modification tools
- **Decision rule (per Open Question):**
  - `auto-resolved: <X> because <Y>` — coder can proceed with stated assumption
  - `needs_owner_decision: <Q>` — genuinely unresolvable without business context
  - `out_of_scope: <Q>` — not part of this TAPD task
- **Verdict rule:**
  - `proceed` — zero `needs_owner_decision`
  - `block_for_human` — ≥1 `needs_owner_decision`
- **Default mode:** `recorder`. `gatekeeper` and `always_skip` modes are future work.
- **Template:** `crates/codegen/xai-grok-shell/src/workbench/prompts/adjudicator.md.tmpl`

### 6.3 Coder (LLM)
- **Stage:** Develop
- **Tools:** `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash` (restricted to git + test_command)
- **Writes:** source files in worktree + `.workbench/stages/3-develop.md`
- **Forbidden:** writing to `.workbench/stages/` other than `3-develop.md`, pushing branches
- **Context injected:** `1-design.md` (post-adjudication), `4-review.md` (if retry), `5-verify.md` (if retry), retry history
- **Self-check items:** compile passes, no out-of-scope edits, all PREVIOUS_REVIEW items addressed
- **Template:** `crates/codegen/xai-grok-shell/src/workbench/prompts/coder.md.tmpl`

### 6.4 Reviewer (LLM)
- **Stage:** Code Review
- **Tools:** `read_file`, `glob`, `grep` (read-only)
- **Writes:** only `.workbench/stages/4-review.md`
- **Forbidden:** all write/edit/bash/git tools
- **Verdict rule:**
  - `approved` — zero critical AND fewer than 3 major
  - `needs_changes` — ≥1 critical OR ≥3 major
- **Severity grades:** `critical` / `major` / `minor` (with line refs)
- **Calibration (from `~/.codex/skills/.system/review-agent/SKILL.md`):** only flag issues that are introduced by this diff, are discrete and actionable, and would be fixed if the author knew about them. Do not flag speculative concerns, pre-existing problems, style nits, or intentional behavior changes.
- **Template:** `crates/codegen/xai-grok-shell/src/workbench/prompts/reviewer.md.tmpl`

### 6.5 Runner (tool only)
- **Stage:** Verify
- **No LLM invocation.** Spawns the configured `test_command` (e.g. `cargo nextest run --workspace`).
- **Captures:** stdout, stderr, exit code, duration
- **Timeout:** default 30 min, configurable per project via `[tapd.projects.<key>].test_timeout_secs`
- **Verdict rule:** exit code 0 → `pass`; otherwise → `fail` (stdout/stderr preserved in artifact)
- **Output:** `.workbench/stages/5-verify.md` with command, exit code, duration, truncated output (first 500 lines + last 200 lines if >500 total)

### 6.6 Submitter (tool only)
- **Stage:** MR Submit
- **No LLM invocation.** Calls GitLab REST API `POST /projects/:id/merge_requests`.
- **Payload construction:**
  - `source_branch`: `tapd/<task-id>-<slug>`
  - `target_branch`: `[tapd.projects.<key>].target_branch` (default `main`)
  - `title`: `[<TAPD-ID>] <task.title>`
  - `description`: TAPD task description + AC list + MR summary (commits, files changed, test summary)
  - `assignee_ids`: from `mr_assignees` config + TAPD `task.owner`
  - `reviewer_ids`: from `mr_reviewers` config + `.gitlab/CODEOWNERS` resolution
  - `remove_source_branch`: true
  - `squash`: false (preserve per-stage commits)
- **Verdict rule:** HTTP 201 → `ok`; 409 → `conflict`; 401/403 → `auth_error`; 5xx / network → `transient_error`
- **Output:** `.workbench/stages/6-mr.md` with HTTP status, response body (truncated), MR URL on success

---

## 7. State Machine

```rust
// crates/codegen/xai-grok-shell/src/workbench/state_machine.rs

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskState {
    Queued { position: u32, priority: Priority },
    Pending,
    Running { stage: Stage, attempt: u8, started_at: i64 },
    BlockedForHuman {
        stage: Stage,
        reason: String,
        payload: serde_json::Value,
        actions: Vec<Action>,
    },
    Done { mr_url: String, finished_at: i64 },
    Dead { reason: String },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage { Brainstorm, Adjudicate, Develop, CodeReview, Verify, MrSubmit }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Priority { Low, Medium, High, Urgent }
```

### 7.1 Transitions

| Current state | Outcome | Next state |
|---|---|---|
| `Running { Brainstorm, _ }` | planner ok | `Running { Adjudicate, attempt=0 }` if `needs_adjudicate()`, else `Running { Develop, attempt=0 }` |
| `Running { Brainstorm, _ }` | planner fail | `Running { Brainstorm, attempt+1 }` if `stage_retry_left()`, else `Dead` |
| `Running { Adjudicate, _ }` | verdict `proceed` | `Running { Develop, attempt=0 }` |
| `Running { Adjudicate, _ }` | verdict `block_for_human` | `BlockedForHuman { reason: "needs_owner_decision" }` |
| `Running { Develop, _ }` | coder ok | `Running { CodeReview, attempt=0 }` |
| `Running { Develop, _ }` | coder fail | `Running { Develop, attempt+1 }` if `stage_retry_left()`, else `Dead` |
| `Running { CodeReview, _ }` | verdict `approved` | `Running { Verify, attempt=0 }` |
| `Running { CodeReview, _ }` | verdict `needs_changes` | `Running { Develop, attempt+1 }` if `develop_retry_left()`, else `BlockedForHuman { reason: "develop retries exhausted" }` |
| `Running { Verify, _ }` | exit 0 | `Running { MrSubmit, attempt=0 }` |
| `Running { Verify, _ }` | exit ≠ 0 | `Running { Develop, attempt+1 }` if `develop_retry_left()`, else `BlockedForHuman { reason: "verify keeps failing" }` |
| `Running { MrSubmit, _ }` | HTTP 201 | `Done { mr_url }` |
| `Running { MrSubmit, _ }` | HTTP 409 | `BlockedForHuman { reason: "branch diverged", actions: [RetryMr] }` |
| `Running { MrSubmit, _ }` | HTTP 401/403 | `BlockedForHuman { reason: "GitLab auth failed" }` |
| `Running { MrSubmit, _ }` | HTTP 5xx / network | `Running { MrSubmit, attempt+1 }` if `mr_retry_left()`, else `BlockedForHuman { reason: "GitLab API persistent failure" }` |

`needs_adjudicate()` = `design.has_open_questions() && (priority ≥ High || ac_count ≥ 5)`

### 7.2 Retry budgets

- **Brainstorm, Adjudicate, Develop, CodeReview** retry budget: `stage_retry_max = 3` (default, configurable per project).
- **MrSubmit** retry budget: `mr_retry_max = 3`; applies **only** to transient errors (5xx / network). HTTP 409 / 401 / 403 do not consume retry budget — they route directly to `BlockedForHuman`.
- **Verify** has **no own retry budget**: failure (exit code ≠ 0) routes back to `Develop` and consumes Develop's retry budget. Runner crash / shell error / timeout is treated as infrastructure failure → `Dead` (no retry — restart whole task via `state.json` resume).

### 7.3 Resume semantics

`state.json` in worktree snapshots current `TaskState`. On backend restart, in-flight tasks resume from their persisted state (no replay of completed stages). Tasks in `Running` at restart time transition to `Pending` and restart their current stage.

---

## 8. Stage Artifacts

All artifacts share a common envelope:

```markdown
---
stage: <brainstorm|develop|review|verify|mr>
task_id: TAPD-1234
attempt: 0
{stage-specific fields: verdict, mr_url, exit_code, ...}
---

<stage-specific body>
```

**Filename convention:** `<n>-<stage>.md` for first attempt, `<n>-<stage>-attempt-<k>.md` for retries. The current attempt is always at the un-suffixed path; prior attempts are retained for debug until task completion.

**`.gitignore`:**
```
# .workbench/.gitignore
*
!.gitignore
```

This blocks all workbench artifacts from entering git history of the worktree's branch.

---

## 9. Worktree & Branch Strategy

- **Worktree path:** `~/.grok/worktrees/<task-id>/`
- **Branch name:** `tapd/<task-id>-<slug>` where `<slug>` is the task title slugified (lowercase, kebab-case, max 40 chars)
- **Base branch:** `[tapd.projects.<key>].target_branch` (default `main`)
- **Worktree creation:** `git worktree add ~/.grok/worktrees/<task-id>/ -b tapd/<task-id>-<slug> <base_branch>`
- **Worktree lifecycle:**
  - Created when task transitions `Pending → Running`
  - Retained during `Running` and `BlockedForHuman`
  - Deleted 5 minutes after `Done` / `BlockedForHuman` / `Dead` (configurable `[workbench].worktree_gc_delay_secs`)
  - Branch itself is NOT auto-deleted; left for GitLab / user to manage post-merge

---

## 10. Configuration

New sections in `config.toml`:

```toml
[workbench]
enabled = true
keep_stage_files_after_done = false   # default: delete .workbench/ on Done/Blocked/Dead
auto_delete_merged_branches = false  # default: do NOT auto-delete; let GitLab manage
worktree_gc_delay_secs = 300          # default: 5 min after task completion

[workbench.concurrency]
global_max_active            = 5      # active main sessions across all projects
worktree_pool_max             = 10     # simultaneous worktree directories
queue_alert_threshold         = 30     # UI banner when queue depth ≥ this
queue_stuck_alert_minutes     = 60     # UI banner when task waited > this

[workbench.models]
planner_model     = "opus-4.1"        # per-project override available
adjudicator_model = "sonnet-4.5"
coder_model       = "opus-4.1"
reviewer_model    = "sonnet-4.5"

[workbench.adjudicate]
default_mode      = "recorder"        # recorder | gatekeeper | always_skip
escalate_priority = ["urgent", "high"]
escalate_min_acs  = 5

[workbench.notify]
tapd_comment   = true                 # post MR URL to TAPD task as comment
slack_webhook   = ""                  # optional
feishu_webhook = ""

[gitlab]
url             = "https://gitlab.example.com"
token_env       = "GITLAB_TOKEN"      # token read from env var, not stored in config
default_assignees_self = false        # if true, MR creator is also an assignee

[tapd.projects.my-app]
target_branch  = "main"
test_command   = "cargo nextest run --workspace"
test_timeout_secs = 1800              # 30 min
mr_reviewers   = ["alice", "bob"]
mr_assignees   = []                   # empty → use TAPD task.owner
adjudicate_mode = "recorder"          # per-project override
```

**Secrets policy:** GitLab token is read from `GITLAB_TOKEN` environment variable, never stored in `config.toml`. Slack/Feishu webhooks are stored in config (acceptable since they're URLs, not secrets).

---

## 11. Notification & Reviewers

### 11.1 Reviewer resolution (priority order, deduplicated)

1. **TAPD `task.owner`** → assigned to MR (assignee)
2. **`[tapd.projects.<key>].mr_reviewers`** → requested review (reviewer)
3. **`.gitlab/CODEOWNERS`** in target repo → requested review (reviewer), based on files changed
4. **No resolver hits** → MR has no assignee/reviewer; TAPD comment notes the gap

### 11.2 Notification channels

| Channel | Source | Mechanism |
|---|---|---|
| GitLab in-app + email | assignee_ids, reviewer_ids | GitLab built-in (workbench does nothing extra) |
| TAPD task comment | `[workbench].notify.tapd_comment = true` | Workbench calls `TAPD API` to post comment with MR URL |
| Slack | `[workbench].notify.slack_webhook` non-empty | POST to webhook URL |
| Feishu | `[workbench].notify.feishu_webhook` non-empty | POST to webhook URL |

GitLab's native assignment emails cover the case of "the assignee gets notified" — no separate `@mention` is needed (this simplifies the original draft).

---

## 12. Burst Handling & Queue

### 12.1 Dispatcher loop

```
loop {
    while !queue.is_empty()
        && active_main_sessions < global_max_active
        && worktree_count < worktree_pool_max
    {
        let task = queue.pop();  // priority + FIFO
        spawn_main_session(task);
    }
    sleep(10s);
}
```

### 12.2 Queue ordering

1. `priority`: `urgent` (4) → `high` (3) → `medium` (2) → `low` (1), descending
2. Tie-break: arrival time (FIFO)

Queue lives in process memory; on backend restart, unstarted tasks remain in `TapdStore` as `pending` and will be re-dispatched on next sync cycle.

### 12.3 Worktree pool exhaustion

When `worktree_count == worktree_pool_max`:
- Force-trigger GC for oldest Done/Blocked/Dead tasks (respecting `worktree_gc_delay_secs`)
- If still no slot, queue blocks until a slot frees

### 12.4 Health alerts

- `queue.len ≥ queue_alert_threshold` → red banner in Workbench header
- Any task in queue > `queue_stuck_alert_minutes` → per-task warning badge

---

## 13. Artifact Lifecycle

| Artifact | Created by | Consumed by | Deleted when |
|---|---|---|---|
| `1-design.md` | planner, adjudicator (append) | adjudicator, coder | Task `Done` / `BlockedForHuman` / `Dead` (default) |
| `3-develop.md` | coder | reviewer, state machine | Same as above |
| `3-develop-attempt-<k>.md` | coder (retry) | reviewer (retry |k>0) | Same as above |
| `4-review.md` | reviewer | coder (retry), state machine | Same as above |
| `4-review-attempt-<k>.md` | reviewer (retry) | coder (retry k+1) | Same as above |
| `5-verify.md` | runner | coder (retry), state machine | Same as above |
| `6-mr.md` | submitter | state machine | Same as above |
| `state.json` | state machine | state machine (resume) | Same as above |
| main session chat history | (always) | (audit) | **Never** (persists in DB) |

`keep_stage_files_after_done = false` (default) → all `.workbench/` deleted on terminal state.
`keep_stage_files_after_done = true` → retain `.workbench/` until worktree GC.

**Long-term audit source:** main session chat history in `Sessions Hub`. Workbench artifacts are short-lived by design.

---

## 14. Failure Paths

| Failure | Detection | Handling |
|---|---|---|
| Planner LLM crash | session/idle timeout | Retry Brainstorm (≤3) |
| Planner output malformed | frontmatter parse fail | Retry Brainstorm |
| Coder edits out of scope | reviewer flags `critical: scope` | needs_changes → retry Develop |
| Test command timeout | `bash` killed at `test_timeout_secs` | verify fail → retry Develop |
| Test command non-zero exit | exit code ≠ 0 | verify fail → retry Develop |
| GitLab 401 / 403 | HTTP status | `BlockedForHuman` reason: "GitLab auth failed"; UI shows token troubleshooting |
| GitLab 409 conflict | HTTP status | `BlockedForHuman` reason: "branch diverged"; UI shows "Retry MR" action |
| GitLab 5xx / network | HTTP status / timeout | Retry MrSubmit (≤3) |
| Worktree pool exhausted | pool full + GC has no slots | Queue blocks; UI banner if depth ≥ threshold |
| Task stuck >60min | heartbeat miss | UI per-task badge |
| Backend crash mid-stage | restart loads `state.json` | Task resumes from last persisted stage |
| Runner crash / timeout | shell exit ≠ expected codes / `test_timeout_secs` exceeded | `Dead` (infrastructure failure; not retried; user must manually re-dispatch)
| Backend crash mid-LLM-call | restart loses in-flight LLM | Task restarts current stage (LLM idempotent within retry budget) |

---

## 15. UI Surfaces

### 15.1 Sessions Hub — main session row

```
[▶ Stage 2/6 Adjudicate] TAPD-1234: Fix user lookup
   branch: tapd/TAPD-1234-fix-user-lookup
   started: 14:23 (1h 12m ago)
```

### 15.2 ChatPane header — stage timeline

```
●━━━━●━━━━○━━━━○━━━━○━━━━○
Bs   Adj  Dev  Rev  Vfy  MR
              ↑
              currently active
```

### 15.3 Child session tree (existing `SubtaskPartView`)

```
▼ Main: TAPD-1234 [Stage 2 Adjudicate]
    ▼ planner-04af (Brainstorm, ✓ done)
    ▼ adjudicator-12bc (Adjudicate, ⚙ active)
    ▶ coder-?? (Develop, ⏸ pending)
    ...
```

### 15.4 TaskDetailDrawer — stage history

Each completed stage shows: child session ID, duration, verdict, retry count.

### 15.5 BlockedForHuman — UI

- Red badge on session row
- Reason text + payload preview (e.g. "needs_owner_decision: Q3 业务侧对失败响应的期望")
- Action buttons (e.g. "Retry MR", "Resolve Q and resume")

### 15.6 Workbench header — system health

- Active count vs. `global_max_active`
- Queue depth vs. `queue_alert_threshold`
- Worktree pool usage

### 15.7 Config form (existing `GrokConfigSettings`)

New sections in `grokConfigSchema`: `[workbench]`, `[workbench.concurrency]`, `[workbench.models]`, `[workbench.adjudicate]`, `[workbench.notify]`, `[gitlab]`, plus per-project fields in `[tapd.projects.<key>]`.

---

## 16. Implementation Plan (suggested decomposition)

| Phase | Content | Estimate |
|---|---|---|
| 1 | `config.toml` schema additions + parsing | 0.5 day |
| 2 | `WorkbenchDispatcher` + priority queue + slot accounting | 1 day |
| 3 | Worktree create / list / delete + branch naming | 0.5 day |
| 4 | State machine framework + persistence (`state.json`) | 1 day |
| 5 | Planner prompt template + child session spawn + artifact validation | 1 day |
| 6 | Adjudicator prompt template + conditional trigger + design.md append | 0.5 day |
| 7 | Coder prompt template + retry context injection + self-check | 1 day |
| 8 | Reviewer prompt template + diff parsing + verdict frontmatter | 1 day |
| 9 | Runner (test_command + timeout + output capture) | 0.5 day |
| 10 | Submitter (GitLab API client + reviewer resolution + payload) | 1 day |
| 11 | Notification (TAPD comment + Slack/Feishu webhook) | 0.5 day |
| 12 | Burst control (queue alert + stuck badge + worktree GC) | 0.5 day |
| 13 | UI: main session badge, stage timeline, blocked interaction | 1 day |
| 14 | UI: child session tree update + TaskDetailDrawer stage history | 0.5 day |
| 15 | UI: config form additions | 0.5 day |
| 16 | Integration test: mock TAPD + real local git repo + GitLab dry-run | 1 day |
| **Total** | | **~10 working days** |

---

## 17. Decision Log

| # | Decision | Rationale |
|---|---|---|
| D1 | Main session = Rust state machine (not LLM orchestrator) | Determinism, testability, retry precision |
| D2 | Each TAPD task = one main session | One task = one worktree = one branch (forced by existing `WorkbenchHeader` pattern) |
| D3 | Adjudicate is conditional, default Recorder | Avoid LLM-evaluating-LLM; cost optimization |
| D4 | Artifacts deleted on task completion | Worktree ephemeral; chat history is audit source |
| D5 | GitLab MR uses assignee_ids + reviewer_ids (not @mention) | GitLab native email handles notification |
| D6 | Q3 = notify reviewer, do NOT auto-merge | Per user selection; merge is a human action |
| D7 | Q4 = 1 task per project | Simplicity first; revisit when contention observed |
| D8 | Q5 = sync completion triggers dispatch | Reuses existing sync; zero new infrastructure |
| D9 | Each stage's LLM has its own model config | Cost optimization (planner/reviewer cheaper than coder) |
| D10 | Worktree GC delayed 5 min after task completion | Allow user to observe final stage stream |
| D11 | `.workbench/.gitignore` blocks all artifacts from git | Branch history stays clean |
| D12 | State machine persists to `state.json` per worktree | Resume after backend restart |
| D13 | LLM retry budget = 3 per stage | Bounds total per-task retries; after exhaustion → BlockedForHuman or Dead |
| D14 | GitLab token from env var, not config | Secrets policy |
| D15 | Adjudicate mode = `recorder` (default); `gatekeeper` and `always_skip` are reserved enum variants for future expansion (not implemented in v1) | Avoid building unproven modes |

---

## 18. Open Questions

1. **Multi-model fallback** — when `coder_model` returns 5xx, should we automatically retry with `adjudicator_model` as a fallback? (Decision: not in v1; revisit after observing failure patterns.)
2. **Test output parsing** — should the runner parse `cargo nextest --message-format json` to record per-test results in `5-verify.md`? (Decision: v1 captures stdout/stderr only; structured output is a future enhancement.)
3. **MR title template** — `[<TAPD-ID>] <title>` is the default, but per-project override may be needed. (Decision: add `[tapd.projects.<key>].mr_title_template` in a follow-up if requested.)
4. **Worktree path collision** — if two tasks have similar slugs, could two worktrees share a parent directory? (Decision: branch name and worktree path use `<task-id>` directly, so collision is impossible; slug is cosmetic only.)
5. **Block-for-human resolution flow** — when a user clicks "Resolve Q and resume", should we restart Brainstorm with the answer, or inject the answer into the existing design? (Decision: restart Brainstorm (cheaper than retrofitting design.md); revisit if pattern emerges.)

---

## 19. References

- `AGENTS.md` § 模块地图（实文件）— TAPD + Workbench + Web UI structure
- `AGENTS.md` § 已知缺口 — items this spec addresses (item 6d: Worktree lifecycle, partial)
- `crates/codegen/xai-grok-shell/src/tapd/` — existing TAPD sync (sync.rs, store.rs, client.rs, disk_config_source.rs)
- `crates/codegen/xai-grok-shell/src/extensions/tapd.rs` — existing `x.ai/tapd/*` ext methods
- `web/src/features/workbench/` — existing Workbench UI (TaskList, TaskRow, ProjectSelector, BindProjectDialog, TaskDetailDrawer, SyncHistoryPanel, useTapdWorkbench)
- `web/src/features/sessions-hub/SubtaskPartView.tsx` — child session tree rendering
- `~/.codex/skills/.system/review-agent/SKILL.md` — calibration pattern for Reviewer
- `~/.codex/skills/brainstorming/spec-document-reviewer-prompt.md` — reviewer output format pattern
- `~/.codex/skills/gstack/.agents/skills/gstack-plan-eng-review/SKILL.md` — multi-lens review pattern (adapted into Adjudicate)
- `docs/web-acp-adaptation-plan.md` — ACP bridge architecture (relevant to child session spawning)

---

## 20. Glossary

- **Main session** — top-level session visible in `Sessions Hub`, one per TAPD task; runs the Rust state machine and aggregates child session streams.
- **Child session** — LLM-driven sub-session spawned by the main session; one per stage that uses an LLM (Brainstorm, Adjudicate, Develop, Code Review).
- **Stage** — one of 6 workflow steps; has its own role, retry budget, and artifact.
- **Adjudicate** — short stage between Brainstorm and Develop that resolves Open Questions in the design doc.
- **Worktree** — git worktree directory `~/.grok/worktrees/<task-id>/` containing the task's branch and `.workbench/` artifacts.
- **Verify** — running the project's `test_command` and checking exit code; tool-only stage.
- **MrSubmit** — POST to GitLab API to create a Draft MR; tool-only stage.
- **BlockedForHuman** — terminal state requiring user action; UI shows reason and action buttons.
- **Dead** — terminal state from unrecoverable error; no retry, no manual path.




