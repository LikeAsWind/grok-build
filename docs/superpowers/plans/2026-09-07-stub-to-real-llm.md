# V2.5: Stub → Real LLM (coder + reviewer) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deterministic `stub_coder` / `stub_reviewer` calls inside `drive_task` with an `LlmStage` boundary and exercise the real fallback and metrics paths. Per the selected B rollout, ACP child-session injection remains a V2.6 task; V2.5 must stay safe with canned stage output until that injection is available.

**Architecture:** `drive_task` gains a generic `LlmStage` trait injected through `OrchestratorInputs`. Tests use `FakeLlmStage`; the production dispatcher uses a safe canned implementation in V2.5 and logs a warning if `use_real_llm` is enabled. `MvpAgentLlmStage` and `MvpAgent::create_stage_session` are prepared for V2.6, but are not wired into the current cross-thread dispatcher.

**Tech Stack:** Rust (tokio, agent_client_protocol, anyhow, serde, tracing, rusqlite, async-trait), TOML config. No new top-level dependencies (per spec §4 soft constraint).

## Execution Status (B Rollout)

- Foundation, `LlmStage`, fake stage, config flag, prompt builders, orchestrator wiring, dispatcher fallback, parser tests, and fallback metrics are implemented.
- `use_real_llm` remains opt-in but safely uses the canned V2.5 stage while the dispatcher is owned by a `Send + Sync` sync callback and `MvpAgent` remains LocalSet-bound.
- Real ACP child-session wiring, real diffs, and manual smoke validation are V2.6 work; the V2.5 implementation must not be treated as live LLM execution.
- Existing unrelated validation failures remain documented below: metrics unit fixtures panic on missing rows, and several integration test files have pre-existing compile errors.

### Task Status (2026-09-09)

| Task | Status | Notes |
|---|---|---|
| 1.1-1.3 | Done | Trait, fake stage, and opt-in config are implemented. |
| 2.1-2.3 | B-scope done | ACP wrapper and stage adapter are present as V2.5 stubs; real child-session wiring is deferred. |
| 3.1-3.3 | Done | Orchestrator fallback path and dispatcher selection are implemented; `use_real_llm=true` safely falls back to canned execution. |
| 4.1-4.3 | Done | E2E, parser, fake-stage, recovery, and metrics coverage added and targeted checks pass. |
| 4.4 | Deferred | Requires a human-run real ACP smoke test after V2.6 wiring. |

The unchecked task-by-task recipe below is retained as the original implementation history. The table above is the authoritative status for the selected B rollout.

**Hard constraints** (from spec §4, must not be violated):

- `pub async fn drive_task(...)` signature unchanged.
- `OrchestratorInputs` / `OrchestratorResult` pub fields unchanged. The new `llm_stage` field is private + set via a new `with_llm_stage()` constructor.
- `ArtifactEnvelope` frontmatter format unchanged (v1/v2 fixtures rely on it).
- `cargo test -p xai-grok-shell` runs green in CI without network.
- GPL-3.0-only license on all new code.

---

## File Structure Overview

### NEW backend files
| Path | Responsibility |
|---|---|
| `crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs` | `LlmStage` trait, `CodeInputs`/`CodeOutputs`/`ReviewInputs`/`ReviewOutputs`, `MvpAgentLlmStage` real impl, parsing helpers |
| `crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs` | `FakeLlmStage` (gated by `#[cfg(test)]`) + canned artifact bodies that match the v1 e2e fixture text |

### MODIFIED backend files
| Path | Change |
|---|---|
| `crates/codegen/xai-grok-shell/src/workbench/mod.rs` | Add `pub mod llm_stage;` and `#[cfg(test)] pub mod test_helpers;` |
| `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` | Add `llm_stage: Arc<dyn LlmStage>` private field on `OrchestratorInputs` + `with_llm_stage()` constructor; replace `stub_coder` / `stub_reviewer` calls in `drive_task` with `llm_stage.code` / `llm_stage.review`; add fallback-retry loop; wire `record_task_metric(..., fallback_used, child_session_id)`; delete the now-unused `stub_coder` / `stub_reviewer` functions (keep `stub_planner`, `stub_adjudicator`, `stub_runner`) |
| `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs` | In `spawn_main_session`, construct `Arc<dyn LlmStage>` from `cfg.use_real_llm` and pass via `with_llm_stage` |
| `crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_lifecycle.rs` | Add `MvpAgent::create_stage_session(prompt: &str) -> anyhow::Result<(String, String)>` — thin ACP wrapper that opens a session, sends the prompt, streams the response, returns the full text |
| `crates/codegen/xai-grok-shell/src/agent/config.rs` | Add `use_real_llm: bool` (default `false`) on `WorkbenchConfig`; update `WorkbenchConfig::default()` |

### NEW test files
| Path | Coverage |
|---|---|
| `crates/codegen/xai-grok-shell/tests/workbench_real_llm_e2e.rs` | E2E tests per spec §9: success records metrics, coder failure triggers fallback, double failure routes to Dead |

### MODIFIED test files
| Path | Change |
|---|---|
| `crates/codegen/xai-grok-shell/tests/workbench_orchestrator_e2e.rs` | Wire `FakeLlmStage::default()` through `with_llm_stage` so the existing test body keeps compiling unchanged |

---

## Phase 1 — Foundation (trait + fake + config flag)

### Task 1.1: Add `LlmStage` trait + I/O structs

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Create `llm_stage.rs` with the trait and I/O structs**

```rust
//! Trait abstraction over the LLM stages that V2.5 makes real
//! (coder + reviewer). Production wires `MvpAgentLlmStage` (real ACP);
//! tests wire `FakeLlmStage` (see `test_helpers`).

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DevelopVerdict {
    Approved,
    NeedsChanges,
}

#[derive(Clone, Debug)]
pub struct CodeInputs {
    pub task_id: String,
    pub title: String,
    pub description: String,
    pub acs: Vec<String>,
    pub worktree_path: PathBuf,
    pub project_config_yaml: String,
    pub prior_artifacts: Vec<PriorArtifact>,
    pub attempt: u8,
    pub primary_model: String,
    pub fallback_model: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PriorArtifact {
    pub stage: String,    // "design" | "adjudicate" | "review" | "verify"
    pub attempt: u8,
    pub body: String,
}

#[derive(Clone, Debug)]
pub struct CodeOutputs {
    pub artifact_body: String,
    pub verdict: DevelopVerdict,
    pub model: String,
    pub fallback_used: bool,
    pub child_session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewVerdict {
    Approved,
    NeedsChanges,
}

#[derive(Clone, Debug)]
pub struct ReviewInputs {
    pub task_id: String,
    pub worktree_path: PathBuf,
    pub design_excerpt: String,
    pub diff: String,
    pub prior_review: Option<String>,
    pub prior_verify: Option<String>,
    pub attempt: u8,
    pub primary_model: String,
    pub fallback_model: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ReviewOutputs {
    pub artifact_body: String,
    pub verdict: ReviewVerdict,
    pub model: String,
    pub fallback_used: bool,
    pub child_session_id: Option<String>,
}

/// Trait abstraction over the two LLM stages V2.5 replaces.
/// Uses explicit `Pin<Box<…>>` instead of `async_trait` to avoid adding
/// a new top-level dependency (spec §4 soft constraint).
pub trait LlmStage: Send + Sync {
    fn code(&self, input: &CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + Send + '_>
    >;
    fn review(&self, input: &ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + Send + '_>
    >;
}

pub type DynLlmStage = Arc<dyn LlmStage>;
```

- [ ] **Step 2: Wire the new module**

Edit `crates/codegen/xai-grok-shell/src/workbench/mod.rs`. Add this line in alphabetical order with the other `pub mod` declarations:

```rust
pub mod llm_stage;
```

- [ ] **Step 3: Add a compile test in the same file (at the bottom)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trait_object_compiles() {
        // Compile-only: ensure the trait + types can be referenced as DynLlmStage.
        fn _accepts_dyn(_l: DynLlmStage) {}
    }
}
```

- [ ] **Step 4: Verify the module compiles**

Run: `cargo check -p xai-grok-shell`
Expected: no errors. The `cargo check` step may surface "unused field" warnings on `CodeInputs` / `ReviewInputs`; that's expected — the impls land in Tasks 1.2 + 2.2.

- [ ] **Step 5: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench v2.5): LlmStage trait + CodeInputs/ReviewInputs types"
```

---

### Task 1.2: Add `FakeLlmStage` (test-only)

**Files:**
- Create: `crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/mod.rs`

- [ ] **Step 1: Create `test_helpers.rs`**

```rust
//! Test-only helpers for the workbench pipeline. NOT compiled into release.

#![cfg(test)]

use std::sync::{Arc, Mutex};

use crate::workbench::llm_stage::{
    CodeInputs, CodeOutputs, DevelopVerdict, DynLlmStage, LlmStage,
    ReviewInputs, ReviewOutputs, ReviewVerdict,
};

#[derive(Clone, Debug)]
pub struct RecordedCall {
    pub stage: &'static str,        // "code" | "review"
    pub task_id: String,
    pub attempt: u8,
    pub primary_model: String,
    pub fallback_model: Option<String>,
    pub worktree_path: std::path::PathBuf,
}

pub struct FakeLlmStage {
    pub code_response: String,
    pub review_response: String,
    pub fail_code: bool,
    pub fail_review: bool,
    pub calls: Mutex<Vec<RecordedCall>>,
}

impl Default for FakeLlmStage {
    fn default() -> Self {
        Self {
            code_response: default_code_body(),
            review_response: default_review_body(),
            fail_code: false,
            fail_review: false,
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl FakeLlmStage {
    pub fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }

    pub fn into_dyn(self) -> DynLlmStage {
        Arc::new(self) as DynLlmStage
    }
}

impl LlmStage for FakeLlmStage {
    fn code(&self, input: &CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + Send + '_>
    > {
        let input = input.clone();
        let resp = self.code_response.clone();
        let fail = self.fail_code;
        self.calls.lock().unwrap().push(RecordedCall {
            stage: "code",
            task_id: input.task_id.clone(),
            attempt: input.attempt,
            primary_model: input.primary_model.clone(),
            fallback_model: input.fallback_model.clone(),
            worktree_path: input.worktree_path.clone(),
        });
        Box::pin(async move {
            if fail {
                anyhow::bail!("FakeLlmStage: fail_code=true");
            }
            Ok(CodeOutputs {
                artifact_body: resp,
                verdict: DevelopVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }

    fn review(&self, input: &ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + Send + '_>
    > {
        let input = input.clone();
        let resp = self.review_response.clone();
        let fail = self.fail_review;
        self.calls.lock().unwrap().push(RecordedCall {
            stage: "review",
            task_id: input.task_id.clone(),
            attempt: input.attempt,
            primary_model: input.primary_model.clone(),
            fallback_model: input.fallback_model.clone(),
            worktree_path: input.worktree_path.clone(),
        });
        Box::pin(async move {
            if fail {
                anyhow::bail!("FakeLlmStage: fail_review=true");
            }
            Ok(ReviewOutputs {
                artifact_body: resp,
                verdict: ReviewVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }
}

fn default_code_body() -> String {
    "## Changes\n- edited src/{slug}.rs\n## Self-check\n- [x] compiles\n".into()
}

fn default_review_body() -> String {
    "## Findings\n(none)\n## Summary\nLGTM.\n".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_records_code_call() {
        let fake = FakeLlmStage::default();
        let _ = fake.code(&CodeInputs {
            task_id: "TAPD-1".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec![],
            worktree_path: "/tmp/wt".into(),
            project_config_yaml: String::new(),
            prior_artifacts: vec![],
            attempt: 0,
            primary_model: "opus-4.1".into(),
            fallback_model: Some("sonnet-4.5".into()),
        }).await.unwrap();
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].stage, "code");
        assert_eq!(calls[0].task_id, "TAPD-1");
        assert_eq!(calls[0].fallback_model.as_deref(), Some("sonnet-4.5"));
    }

    #[tokio::test]
    async fn fake_fail_code_returns_err() {
        let mut fake = FakeLlmStage::default();
        fake.fail_code = true;
        let res = fake.code(&CodeInputs {
            task_id: "TAPD-1".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec![],
            worktree_path: "/tmp/wt".into(),
            project_config_yaml: String::new(),
            prior_artifacts: vec![],
            attempt: 0,
            primary_model: "opus-4.1".into(),
            fallback_model: None,
        }).await;
        assert!(res.is_err());
    }
}
```

- [ ] **Step 2: Wire the new test-helpers module**

Edit `crates/codegen/xai-grok-shell/src/workbench/mod.rs`. Add this line right after `pub mod llm_stage;`:

```rust
#[cfg(test)]
pub mod test_helpers;
```

- [ ] **Step 3: Run the unit tests to confirm they pass**

Run: `cargo test --lib -p xai-grok-shell workbench::test_helpers`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs crates/codegen/xai-grok-shell/src/workbench/mod.rs
git commit -m "feat(workbench v2.5): FakeLlmStage test double with recorded call log"
```

---

### Task 1.3: Add `use_real_llm` flag to `WorkbenchConfig`

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/agent/config.rs`

- [ ] **Step 1: Add the field to `WorkbenchConfig`**

In `crates/codegen/xai-grok-shell/src/agent/config.rs`, locate the `WorkbenchConfig` struct (around line 1360) and add a new field. The struct currently ends with:

```rust
    pub models: WorkbenchModelsConfig,
    pub adjudicate: WorkbenchAdjudicateConfig,
    pub notify: WorkbenchNotifyConfig,
}
```

Add the new field as the last item:

```rust
    pub notify: WorkbenchNotifyConfig,
    /// V2.5: when true, the dispatcher wires `MvpAgentLlmStage` (real ACP);
    /// when false (default), wires `FakeLlmStage` so v1/v2 behavior is preserved.
    #[serde(default)]
    pub use_real_llm: bool,
}
```

- [ ] **Step 2: Update `impl Default for WorkbenchConfig` (around line 1371)**

Add `use_real_llm: false,` to the returned struct so it reads:

```rust
impl Default for WorkbenchConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_delete_merged_branches: false,
            worktree_gc_delay_secs: 300,
            concurrency: WorkbenchConcurrencyConfig::default(),
            models: WorkbenchModelsConfig::default(),
            adjudicate: WorkbenchAdjudicateConfig::default(),
            notify: WorkbenchNotifyConfig::default(),
            use_real_llm: false,
        }
    }
}
```

- [ ] **Step 3: Verify the existing config tests still pass**

Run: `cargo test --lib -p xai-grok-shell agent::config::tests`
Expected: all config tests pass (the `Default` impl is exercised by every test that constructs `WorkbenchConfig`).

- [ ] **Step 4: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/agent/config.rs
git commit -m "feat(workbench v2.5): WorkbenchConfig.use_real_llm flag (default false)"
```

> Phase 1 gate: `cargo check -p xai-grok-shell` is green; `FakeLlmStage` test double is ready. Move on to Phase 2.

---

## Phase 2 — Real ACP implementation

### Task 2.1: Add `MvpAgent::create_stage_session` wrapper

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_lifecycle.rs`

> **Why this is a separate task**: the spec lists the ACP `create_session` signature as Open Question #1 with likelihood = medium (spec §11). Read the existing subagent pattern BEFORE writing the wrapper. If the wrapper would have to call a fundamentally different ACP entry point, stop and revise this plan — do not invent a new abstraction.

- [ ] **Step 1: Survey the existing ACP child-session pattern**

Run: `rg -n "create_session|new_session|send_request" crates/codegen/xai-grok-shell/src/agent/mvp_agent/ | head -50`
Expected output: 5-15 hits showing how `MvpAgent` already opens child sessions (e.g. via `subagent_coordinator.rs` or `session_registry.rs`). Identify the actual ACP method name and the JSON-RPC shape. **Do not proceed to Step 2 if the pattern is unclear; ask the user.**

- [ ] **Step 2: Add `MvpAgent::create_stage_session`**

In `crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_lifecycle.rs`, add a new method:

```rust
impl MvpAgent {
    /// Open a short-lived ACP child session, send `prompt`, stream the
    /// response, and return the full text. Used by `MvpAgentLlmStage` to
    /// drive the coder and reviewer stages (V2.5).
    ///
    /// Returns:
    /// - `Ok((session_id, full_text))` on success
    /// - `Err(_)` on any ACP / network / parse error — caller decides fallback
    pub async fn create_stage_session(
        &self,
        prompt: &str,
    ) -> anyhow::Result<(String, String)> {
        // Implementation mirrors the existing subagent pattern from Step 1.
        // The exact ACP method (session/new + session/prompt vs. session/fork + ...)
        // is decided in Step 1; copy that path verbatim and only add
        // prompt streaming + text capture.
        todo!("implement after Step 1 survey")
    }
}
```

> The exact body of `create_stage_session` is intentionally left as `todo!()` here. **Replace `todo!()` with the actual implementation that matches the pattern found in Step 1.** Do not invent a new ACP flow.

- [ ] **Step 3: Add a smoke test (mocked ACP server)**

In the same file's `#[cfg(test)] mod tests` block, add:

```rust
    #[tokio::test]
    async fn create_stage_session_returns_text() {
        // Use the existing test-only ACP harness in
        // `crates/codegen/xai-grok-shell/tests/acp_harness/` to spin up a
        // fake ACP server that returns a canned response. Assert
        // create_stage_session returns the canned text.
        todo!("wire the existing acp_harness fixture; assert (session_id, text)")
    }
```

- [ ] **Step 4: Run the new test**

Run: `cargo test --lib -p xai-grok-shell agent::mvp_agent::session_lifecycle::tests::create_stage_session_returns_text -- --nocapture`
Expected: 1 test passes (once Step 2's `todo!()` is replaced). If the harness fixture is not yet wired, copy the minimal scaffold from `crates/codegen/xai-grok-shell/tests/acp_harness/`.

- [ ] **Step 5: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_lifecycle.rs
git commit -m "feat(mvp_agent v2.5): create_stage_session ACP wrapper"
```

---

### Task 2.2: Implement `MvpAgentLlmStage`

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs`

- [ ] **Step 1: Add `MvpAgentLlmStage` struct + `impl LlmStage`**

Append to `llm_stage.rs`:

```rust
use std::sync::Arc;

use crate::agent::mvp_agent::MvpAgent;
use crate::workbench::prompts::{render_coder, render_reviewer, CoderInputs, ReviewerInputs};

/// Real implementation of `LlmStage`. Opens an ACP child session per call,
/// streams the prompt, captures the full text, parses it into the
/// appropriate outputs struct.
pub struct MvpAgentLlmStage {
    pub agent: Arc<MvpAgent>,
}

impl LlmStage for MvpAgentLlmStage {
    fn code(&self, input: &CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + Send + '_>
    > {
        let agent = self.agent.clone();
        let input = input.clone();
        Box::pin(async move {
            let prompt = build_coder_prompt(&input);
            let (session_id, text) = agent.create_stage_session(&prompt).await?;
            let verdict = parse_coder_verdict(&text);
            Ok(CodeOutputs {
                artifact_body: text,
                verdict,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: Some(session_id),
            })
        })
    }

    fn review(&self, input: &ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + Send + '_>
    > {
        let agent = self.agent.clone();
        let input = input.clone();
        Box::pin(async move {
            let prompt = build_reviewer_prompt(&input);
            let (session_id, text) = agent.create_stage_session(&prompt).await?;
            let verdict = parse_reviewer_verdict(&text);
            Ok(ReviewOutputs {
                artifact_body: text,
                verdict,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: Some(session_id),
            })
        })
    }
}

fn build_coder_prompt(input: &CodeInputs) -> String {
    let pi = CoderInputs {
        task_id: input.task_id.clone(),
        design_md: extract_design(&input.prior_artifacts),
        previous_review: extract_prior(&input.prior_artifacts, "review"),
        previous_verify: extract_prior(&input.prior_artifacts, "verify"),
        retry_history: input.prior_artifacts.iter()
            .filter(|a| a.stage == "review" && a.attempt > 0)
            .map(|a| format!("attempt {}: reviewer needs_changes", a.attempt))
            .collect(),
        worktree_path: input.worktree_path.to_string_lossy().into_owned(),
        attempt: input.attempt,
    };
    render_coder(&pi)
}

fn build_reviewer_prompt(input: &ReviewInputs) -> String {
    let pi = ReviewerInputs {
        task_id: input.task_id.clone(),
        diff: input.diff.clone(),
        design_excerpt: input.design_excerpt.clone(),
        worktree_path: input.worktree_path.to_string_lossy().into_owned(),
        attempt: input.attempt,
    };
    render_reviewer(&pi)
}

fn extract_design(artifacts: &[PriorArtifact]) -> String {
    artifacts.iter()
        .find(|a| a.stage == "design")
        .map(|a| a.body.clone())
        .unwrap_or_else(|| "(none)".into())
}

fn extract_prior(artifacts: &[PriorArtifact], stage: &str) -> Option<String> {
    artifacts.iter()
        .find(|a| a.stage == stage)
        .map(|a| a.body.clone())
}

fn parse_coder_verdict(text: &str) -> DevelopVerdict {
    if text.contains("verdict: ok") || text.contains("## Self-check\n- [x]") {
        DevelopVerdict::Approved
    } else {
        DevelopVerdict::NeedsChanges
    }
}

fn parse_reviewer_verdict(text: &str) -> ReviewVerdict {
    if text.contains("LGTM") || text.contains("## Findings\n(none)") {
        ReviewVerdict::Approved
    } else {
        ReviewVerdict::NeedsChanges
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p xai-grok-shell`
Expected: no errors.

- [ ] **Step 3: Add a unit test using the existing ACP harness fixture**

Append to the `tests` module in `llm_stage.rs`:

```rust
    #[tokio::test]
    async fn mvp_agent_llm_stage_uses_create_session() {
        // Wire the existing `acp_harness` test fixture to assert that
        // MvpAgentLlmStage::code invokes create_stage_session and parses
        // the canned response into CodeOutputs.
        todo!("wire acp_harness fixture; assert (CodeOutputs.verdict == Approved)")
    }
```

If `acp_harness` is too heavy for a unit test, drop this test — it duplicates Task 2.1's `create_stage_session_returns_text` and adds little coverage. The end-to-end coverage lives in Task 4.2's `workbench_real_llm_e2e.rs`.

- [ ] **Step 4: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs
git commit -m "feat(workbench v2.5): MvpAgentLlmStage talks to ACP via create_stage_session"
```

---

### Task 2.3: Add `build_coder_inputs` / `build_reviewer_inputs` helpers

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs`

- [ ] **Step 1: Add the input builders**

In `orchestrator.rs`, append near the top (after the existing `OrchestratorInputs` struct definition):

```rust
use crate::agent::config::WorkbenchModelsConfig;
use crate::workbench::llm_stage::{CodeInputs, PriorArtifact, ReviewInputs};
use crate::workbench::worktree_manager::worktree_path;

/// Translate `OrchestratorInputs` + the design doc + retry context into
/// `CodeInputs` for the LLMStage.
pub fn build_coder_inputs(
    inputs: &OrchestratorInputs,
    models: &WorkbenchModelsConfig,
    attempt: u8,
    prior_artifacts: Vec<PriorArtifact>,
) -> CodeInputs {
    CodeInputs {
        task_id: inputs.tapd_id.clone(),
        title: inputs.title.clone(),
        description: inputs.description.clone(),
        acs: inputs.acs.clone(),
        worktree_path: worktree_path(
            inputs.grok_home.to_str().unwrap(),
            &inputs.tapd_id,
        ),
        project_config_yaml: String::new(),
        prior_artifacts,
        attempt,
        primary_model: models.coder_model.clone(),
        fallback_model: models.coder_fallback.clone(),
    }
}

/// Translate `OrchestratorInputs` + design excerpt + diff into `ReviewInputs`.
pub fn build_reviewer_inputs(
    inputs: &OrchestratorInputs,
    models: &WorkbenchModelsConfig,
    design_excerpt: &str,
    diff: &str,
    prior_review: Option<String>,
    prior_verify: Option<String>,
    attempt: u8,
) -> ReviewInputs {
    ReviewInputs {
        task_id: inputs.tapd_id.clone(),
        worktree_path: worktree_path(
            inputs.grok_home.to_str().unwrap(),
            &inputs.tapd_id,
        ),
        design_excerpt: design_excerpt.to_string(),
        diff: diff.to_string(),
        prior_review,
        prior_verify,
        attempt,
        primary_model: models.reviewer_model.clone(),
        fallback_model: models.reviewer_fallback.clone(),
    }
}
```

- [ ] **Step 2: Add unit tests**

Append to the existing `#[cfg(test)] mod tests` block in `orchestrator.rs`:

```rust
    #[test]
    fn build_coder_inputs_carries_attempt_and_model() {
        let oi = OrchestratorInputs {
            tapd_id: "TAPD-1".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec!["ac1".into()],
            priority: 1,
            repo_root: std::path::PathBuf::from("/r"),
            grok_home: std::path::PathBuf::from("/g"),
            base_branch: "main".into(),
            tapd_owner: None,
            mr_reviewers: vec![],
            mr_assignees: vec![],
            project_id: "1".into(),
        };
        let mut models = WorkbenchModelsConfig::default();
        models.coder_fallback = Some("sonnet-4.5".into());
        let ci = build_coder_inputs(&oi, &models, 1, vec![]);
        assert_eq!(ci.task_id, "TAPD-1");
        assert_eq!(ci.attempt, 1);
        assert_eq!(ci.primary_model, models.coder_model);
        assert_eq!(ci.fallback_model.as_deref(), Some("sonnet-4.5"));
        assert!(ci.worktree_path.ends_with("TAPD-1"));
    }

    #[test]
    fn build_reviewer_inputs_carries_diff() {
        let oi = OrchestratorInputs {
            tapd_id: "TAPD-2".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec![],
            priority: 1,
            repo_root: std::path::PathBuf::from("/r"),
            grok_home: std::path::PathBuf::from("/g"),
            base_branch: "main".into(),
            tapd_owner: None,
            mr_reviewers: vec![],
            mr_assignees: vec![],
            project_id: "1".into(),
        };
        let models = WorkbenchModelsConfig::default();
        let ri = build_reviewer_inputs(
            &oi, &models, "## Goal\nx", "+ new line", None, None, 0,
        );
        assert_eq!(ri.diff, "+ new line");
        assert_eq!(ri.design_excerpt, "## Goal\nx");
        assert_eq!(ri.primary_model, models.reviewer_model);
    }
```

- [ ] **Step 3: Run the new tests**

Run: `cargo test --lib -p xai-grok-shell workbench::orchestrator::tests::build_coder_inputs_carries_attempt_and_model workbench::orchestrator::tests::build_reviewer_inputs_carries_diff`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs
git commit -m "feat(workbench v2.5): build_coder_inputs + build_reviewer_inputs"
```

> Phase 2 gate: `MvpAgent::create_stage_session` is implemented + tested, `MvpAgentLlmStage` exists, input builders compile + pass. Move on to Phase 3.

---

## Phase 3 — Orchestrator wiring

### Task 3.1: Add private `llm_stage` field + `with_llm_stage()` constructor

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs`

- [ ] **Step 1: Update `OrchestratorInputs`**

Replace the existing `OrchestratorInputs` struct definition with:

```rust
/// Inputs needed to drive a task through the pipeline.
pub struct OrchestratorInputs {
    pub tapd_id: String,
    pub title: String,
    pub description: String,
    pub acs: Vec<String>,
    pub priority: i32,
    pub repo_root: std::path::PathBuf,
    pub grok_home: std::path::PathBuf,
    pub base_branch: String,
    pub tapd_owner: Option<String>,
    pub mr_reviewers: Vec<String>,
    pub mr_assignees: Vec<String>,
    pub project_id: String,
    // Private field — the only mutator is `with_llm_stage`. This keeps
    // the public struct-construction API (used by 7+ call sites in tests
    // and by the dispatcher) unchanged.
    llm_stage: crate::workbench::llm_stage::DynLlmStage,
}

impl OrchestratorInputs {
    pub fn with_llm_stage(
        mut self,
        llm_stage: crate::workbench::llm_stage::DynLlmStage,
    ) -> Self {
        self.llm_stage = llm_stage;
        self
    }
}
```

> Note: the `pub` fields stay public (the hard constraint). The `llm_stage` field is private so callers MUST go through `with_llm_stage` to set it. Existing tests using struct-literal initialization (`OrchestratorInputs { … }`) will continue to compile because they don't reference the new field — Rust struct-update syntax handles missing fields.

- [ ] **Step 2: Default the `llm_stage` field via a safety-net impl**

Add a safety-net `LlmStage` impl and a `Default for OrchestratorInputs` so struct-literal init still compiles:

```rust
impl Default for OrchestratorInputs {
    fn default() -> Self {
        Self {
            tapd_id: String::new(),
            title: String::new(),
            description: String::new(),
            acs: Vec::new(),
            priority: 1,
            repo_root: std::path::PathBuf::from("."),
            grok_home: std::path::PathBuf::from("/tmp/grok"),
            base_branch: "main".into(),
            tapd_owner: None,
            mr_reviewers: Vec::new(),
            mr_assignees: Vec::new(),
            project_id: "1".into(),
            llm_stage: std::sync::Arc::new(FakeLlmStageAlwaysOk) as _,
        }
    }
}

/// Minimal default `LlmStage` for `OrchestratorInputs::default()`. Returns
/// Approved on every call without recording anything. Live production
/// uses `FakeLlmStage` (test-only) or `MvpAgentLlmStage` (real); this is
/// just a safety net so struct-update syntax in tests can leave the field
/// untouched.
struct FakeLlmStageAlwaysOk;
impl crate::workbench::llm_stage::LlmStage for FakeLlmStageAlwaysOk {
    fn code(&self, input: &CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + Send + '_>
    > {
        let body = "## Changes\n- stub\n## Self-check\n- [x] ok\n".to_string();
        Box::pin(async move {
            Ok(CodeOutputs {
                artifact_body: body,
                verdict: DevelopVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }
    fn review(&self, input: &ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + Send + '_>
    > {
        let body = "## Findings\n(none)\n## Summary\nLGTM.\n".to_string();
        Box::pin(async move {
            Ok(ReviewOutputs {
                artifact_body: body,
                verdict: ReviewVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }
}
```

Add the imports at the top of the file:

```rust
use crate::workbench::llm_stage::{
    CodeInputs, CodeOutputs, DevelopVerdict, DynLlmStage, LlmStage,
    ReviewInputs, ReviewOutputs, ReviewVerdict,
};
```

- [ ] **Step 3: Verify the full crate compiles**

Run: `cargo check -p xai-grok-shell --tests`
Expected: no errors. Existing tests using `OrchestratorInputs { … }` struct literals keep compiling.

- [ ] **Step 4: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs
git commit -m "refactor(workbench v2.5): OrchestratorInputs gains private llm_stage + with_llm_stage"
```

---

### Task 3.2: Replace `stub_coder` / `stub_reviewer` calls in `drive_task`

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs`

- [ ] **Step 1: Add helpers at the top of `orchestrator.rs`**

Below the imports block, add:

```rust
use crate::workbench::recovery::{decide_fallback, RoleFallback};

fn coder_role(models: &crate::agent::config::WorkbenchModelsConfig) -> RoleFallback {
    RoleFallback {
        primary: models.coder_model.clone(),
        fallback: models.coder_fallback.clone(),
    }
}

fn reviewer_role(models: &crate::agent::config::WorkbenchModelsConfig) -> RoleFallback {
    RoleFallback {
        primary: models.reviewer_model.clone(),
        fallback: models.reviewer_fallback.clone(),
    }
}
```

- [ ] **Step 2: Replace the develop stage block in `drive_task`**

Locate the section that currently reads:

```rust
    // 3. Develop
    if let Some(dead_state) = check_cancel() {
        save_state(&wt_path, &dead_state)?;
        return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
    }
    stub_coder(&wt_path, &inputs).await?;
    state = next_after_develop(true, 0);
    save_state(&wt_path, &state)?;
```

Replace it with:

```rust
    // 3. Develop — V2.5: real LLM call via trait injection.
    let models = crate::agent::config::WorkbenchModelsConfig::default();
    let mut develop_attempt: u8 = 0;
    let mut develop_fallback_used = false;
    let develop_out = loop {
        let started_at = chrono::Utc::now().timestamp_millis();
        let mut code_inputs_inner = build_coder_inputs(&inputs, &models, develop_attempt, vec![]);
        if develop_fallback_used {
            if let Some(fb) = code_inputs_inner.fallback_model.clone() {
                code_inputs_inner.primary_model = fb;
            }
        }
        match inputs.llm_stage.code(&code_inputs_inner).await {
            Ok(out) => {
                let finished_at = chrono::Utc::now().timestamp_millis();
                tokio::fs::create_dir_all(
                    wt_path.join(".workbench/stages").as_path(),
                ).await?;
                let env_body = out.artifact_body.clone();
                tokio::fs::write(
                    wt_path.join(artifact_path(3, "develop", develop_attempt)),
                    env_body,
                ).await?;
                let _ = store.record_task_metric(
                    &inputs.tapd_id,
                    "develop",
                    develop_attempt,
                    started_at,
                    finished_at,
                    &out.model,
                    if out.fallback_used { 1 } else { 0 },
                    out.child_session_id.as_deref(),
                );
                break out;
            }
            Err(e) => {
                tracing::warn!(tapd_id = %inputs.tapd_id, "coder attempt {} failed: {e}", develop_attempt);
                let next_model = decide_fallback(
                    &coder_role(&models),
                    develop_attempt,
                    develop_fallback_used,
                );
                match next_model {
                    Some(m) => {
                        develop_fallback_used = true;
                        develop_attempt += 1;
                        tracing::info!(tapd_id = %inputs.tapd_id, "developing fallback model {m}");
                    }
                    None => {
                        save_state(&wt_path, &TaskState::Dead {
                            reason: format!("coder_failed: {e}"),
                        })?;
                        return Ok(OrchestratorResult {
                            final_state: TaskState::Dead { reason: format!("coder_failed: {e}") },
                            branch,
                            worktree_path: wt_path,
                            mr_url: None,
                        });
                    }
                }
            }
        }
    };
    state = next_after_develop(
        matches!(develop_out.verdict, DevelopVerdict::Approved),
        develop_attempt,
    );
    save_state(&wt_path, &state)?;
```

> The loop preserves the hard constraint that `develop_attempt <= 2` before Dead (matches `decide_fallback`'s contract per spec §6.2.1).

- [ ] **Step 3: Replace the code-review stage block in `drive_task`**

Locate:

```rust
    // 4. Code Review
    if let Some(dead_state) = check_cancel() {
        save_state(&wt_path, &dead_state)?;
        return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
    }
    stub_reviewer(&wt_path, &inputs).await?;
    state = next_after_review(ReviewVerdict::Approved, 0);
    save_state(&wt_path, &state)?;
```

Replace it with the same loop pattern, calling `llm_stage.review(&review_inputs)` and routing through `decide_fallback(&reviewer_role(&models), ...)`. Use `artifact_path(4, "review", review_attempt)` for the output filename. Wire `store.record_task_metric(..., "review", ...)`.

- [ ] **Step 4: Delete the now-unused `stub_coder` and `stub_reviewer` functions**

Remove the `async fn stub_coder(...)` and `async fn stub_reviewer(...)` definitions from `orchestrator.rs`. Keep `stub_planner`, `stub_adjudicator`, `stub_runner` (they remain in scope per spec §3 Non-Goals).

- [ ] **Step 5: Verify compilation + run existing workbench e2e tests**

Run: `cargo test -p xai-grok-shell --test workbench_orchestrator_e2e`
Expected: tests pass with `FakeLlmStageAlwaysOk` wired by default (returning Approved verdicts, which the existing tests assume). If a test FAILS because it expects different stub text, fix the test to call `.with_llm_stage(FakeLlmStage::default().into_dyn())`.

- [ ] **Step 6: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs
git commit -m "feat(workbench v2.5): drive_task calls LlmStage.code/review with fallback loop"
```

---

### Task 3.3: Wire the dispatcher to construct LlmStage from the config flag

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs`

- [ ] **Step 1: Add a `use_real_llm` field on `WorkbenchDispatcher`**

In `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs`, locate the `WorkbenchDispatcher` struct. Add a new field:

```rust
pub struct WorkbenchDispatcher {
    ...
    /// V2.5: when true, the dispatcher wires MvpAgentLlmStage (real ACP);
    /// when false (default), wires FakeLlmStage for safety.
    pub use_real_llm: bool,
    /// V2.5: optional handle to the MvpAgent used by MvpAgentLlmStage.
    pub agent: Option<std::sync::Arc<crate::agent::mvp_agent::MvpAgent>>,
}
```

Then in the `WorkbenchDispatcher::new(...)` constructor (or wherever the struct is constructed in tests), add `use_real_llm: false, agent: None` to the struct-literal. If the existing constructor does not take an agent, add an `agent: Option<Arc<MvpAgent>>` parameter.

- [ ] **Step 2: Construct the LlmStage in `spawn_main_session`**

Replace the existing `spawn_main_session` body with the version that constructs an `LlmStage`:

```rust
    async fn spawn_main_session(&self, tapd_id: &str) -> anyhow::Result<String> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let tapd_id_owned = tapd_id.to_string();
        let store = self.store.clone();
        let gitlab = self.gitlab.clone();
        let session_id_for_blocking = session_id.clone();
        let use_real_llm = self.use_real_llm;
        let agent = self.agent.clone();
        tokio::task::spawn_blocking(move || -> String {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(_) => return session_id_for_blocking,
            };
            rt.block_on(async move {
                if let Some(g) = gitlab {
                    let llm_stage: crate::workbench::llm_stage::DynLlmStage = if use_real_llm {
                        if let Some(agent) = agent {
                            std::sync::Arc::new(
                                crate::workbench::llm_stage::MvpAgentLlmStage { agent }
                            ) as _
                        } else {
                            tracing::warn!("use_real_llm=true but no agent available; falling back to FakeLlmStage");
                            std::sync::Arc::new(
                                crate::workbench::test_helpers::FakeLlmStage::default(),
                            ) as _
                        }
                    } else {
                        std::sync::Arc::new(
                            crate::workbench::test_helpers::FakeLlmStage::default(),
                        ) as _
                    };
                    let inputs = OrchestratorInputs {
                        tapd_id: tapd_id_owned.clone(),
                        title: format!("Workbench task {}", tapd_id_owned),
                        description: String::new(),
                        acs: vec![],
                        priority: 1,
                        repo_root: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
                        grok_home: xai_grok_config::grok_home(),
                        base_branch: "main".into(),
                        tapd_owner: None,
                        mr_reviewers: vec![],
                        mr_assignees: vec![],
                        project_id: "1".into(),
                    }
                    .with_llm_stage(llm_stage);
                    let _ = drive_task(store.clone(), &g, inputs, None).await;
                }
            });
            session_id_for_blocking
        })
        .await
        .map_err(|e| anyhow::anyhow!("join error: {e}"))
    }
```

- [ ] **Step 3: Verify the crate compiles**

Run: `cargo check -p xai-grok-shell`
Expected: no errors.

- [ ] **Step 4: Run all existing workbench tests**

Run: `cargo test -p xai-grok-shell --test workbench_orchestrator_e2e --test workbench_pipeline_e2e -- --nocapture`
Expected: existing tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs
git commit -m "feat(workbench v2.5): dispatcher wires LlmStage from use_real_llm flag"
```

> Phase 3 gate: `drive_task` calls `llm_stage.code` / `llm_stage.review` with fallback loop; the dispatcher wires the right impl from `use_real_llm`. Move on to Phase 4 (test additions).

---

## Phase 4 — Tests + rollout

### Task 4.1: Wire `FakeLlmStage` into `workbench_orchestrator_e2e.rs`

**Files:**
- Modify: `crates/codegen/xai-grok-shell/tests/workbench_orchestrator_e2e.rs`

- [ ] **Step 1: Read the existing test**

Run: `rg -n "OrchestratorInputs|drive_task" crates/codegen/xai-grok-shell/tests/workbench_orchestrator_e2e.rs | head -20`
Expected: 1-5 hits locating the test's `OrchestratorInputs { … }` literal.

- [ ] **Step 2: Add `.with_llm_stage(...)` to existing test bodies**

```rust
    use xai_grok_shell::workbench::test_helpers::FakeLlmStage;
    let fake = FakeLlmStage::default();
    let inputs = OrchestratorInputs {
        tapd_id: "TAPD-1".into(),
        ...
    }
    .with_llm_stage(fake.into_dyn());
    let result = drive_task(store.clone(), &gitlab, inputs, None).await.unwrap();
    assert!(result.worktree_path.join(".workbench/stages/3-develop.md").exists());
    assert!(result.worktree_path.join(".workbench/stages/4-review.md").exists());
```

> If the existing test file does not need `.with_llm_stage` (it works through the safety-net default), leave it alone. The hard constraint (no breaking changes to existing tests) is preserved because the artifact filenames and contents stay the same.

- [ ] **Step 3: Run the existing test**

Run: `cargo test -p xai-grok-shell --test workbench_orchestrator_e2e -- --nocapture`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/tests/workbench_orchestrator_e2e.rs
git commit -m "test(workbench v2.5): wire FakeLlmStage in orchestrator e2e"
```

---

### Task 4.2: Add `tests/workbench_real_llm_e2e.rs`

**Files:**
- Create: `crates/codegen/xai-grok-shell/tests/workbench_real_llm_e2e.rs`

- [ ] **Step 1: Create the file with three e2e tests**

```rust
//! V2.5 E2E tests: LLM fallback flow.
//!
//! These tests verify that the orchestrator's fallback loop works end-to-end
//! against a `FakeLlmStage` configured to fail (or succeed) on demand.
//! Real ACP is exercised separately in Task 2.1's unit test.

use std::sync::Arc;

use xai_grok_shell::agent::config::WorkbenchModelsConfig;
use xai_grok_shell::workbench::llm_stage::DynLlmStage;
use xai_grok_shell::workbench::orchestrator::{drive_task, OrchestratorInputs};
use xai_grok_shell::workbench::state_machine::TaskState;
use xai_grok_shell::workbench::submitter::GitlabClient;
use xai_grok_shell::workbench::test_helpers::FakeLlmStage;

fn cfg_with_fallbacks() -> WorkbenchModelsConfig {
    let mut cfg = WorkbenchModelsConfig::default();
    cfg.coder_fallback = Some("sonnet-4.5".into());
    cfg.reviewer_fallback = Some("opus-4.1".into());
    cfg
}

fn base_inputs(tapd_id: &str) -> OrchestratorInputs {
    OrchestratorInputs {
        tapd_id: tapd_id.into(),
        title: format!("Workbench task {tapd_id}"),
        description: String::new(),
        acs: vec![],
        priority: 1,
        repo_root: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        grok_home: xai_grok_config::grok_home(),
        base_branch: "main".into(),
        tapd_owner: None,
        mr_reviewers: vec![],
        mr_assignees: vec![],
        project_id: "1".into(),
    }
}

fn fake_gitlab() -> GitlabClient {
    GitlabClient::new_for_test("http://localhost:0", "test-token")
}

#[tokio::test]
async fn fake_coder_success_records_metrics_row_with_fallback_used_zero() {
    let fake = Arc::new(FakeLlmStage::default());
    let stage: DynLlmStage = fake.clone();
    let store = xai_grok_shell::tapd::store::TapdStore::open_in_memory().unwrap().into();
    let inputs = base_inputs("TAPD-success-1").with_llm_stage(stage);
    let result = drive_task(store.clone(), &fake_gitlab(), inputs, None).await.unwrap();
    assert!(matches!(result.final_state, TaskState::Done { .. }));
    let rows = store.task_metrics("TAPD-success-1").unwrap();
    let develop_row = rows.iter().find(|r| r.stage == "develop").unwrap();
    assert_eq!(develop_row.fallback_used, 0, "primary success => fallback_used=0");
}

#[tokio::test]
async fn fake_coder_failure_triggers_fallback_then_succeeds() {
    let mut inner = FakeLlmStage::default();
    inner.fail_code = true; // first call fails => recovery picks fallback
    let fake = Arc::new(inner);
    let stage: DynLlmStage = fake.clone();
    let store = xai_grok_shell::tapd::store::TapdStore::open_in_memory().unwrap().into();
    let inputs = base_inputs("TAPD-fallback-1").with_llm_stage(stage);
    let _ = drive_task(store.clone(), &fake_gitlab(), inputs, None).await;
    // The orchestrator should route through the fallback path; assert it
    // reaches a non-Dead final state (Done if reviewer succeeds, etc).
}

#[tokio::test]
async fn fake_double_failure_routes_to_dead() {
    let mut inner = FakeLlmStage::default();
    inner.fail_code = true;
    inner.fail_review = true;
    let stage: DynLlmStage = Arc::new(inner);
    let store = xai_grok_shell::tapd::store::TapdStore::open_in_memory().unwrap().into();
    let inputs = base_inputs("TAPD-dead-1").with_llm_stage(stage);
    // No fallback configured for either role => double failure => Dead.
    let result = drive_task(store, &fake_gitlab(), inputs, None).await.unwrap();
    assert!(
        matches!(result.final_state, TaskState::Dead { .. }),
        "expected Dead, got {:?}", result.final_state
    );
}
```

- [ ] **Step 2: Resolve any compilation gaps**

The `TapdStore::open_in_memory` and `GitlabClient::new_for_test` helpers may not exist yet. If they don't, copy the minimal pattern from the existing `recovery_e2e.rs` and `metrics_e2e.rs` files. Do not add new dependencies.

- [ ] **Step 3: Run the new tests**

Run: `cargo test -p xai-grok-shell --test workbench_real_llm_e2e -- --nocapture`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/tests/workbench_real_llm_e2e.rs
git commit -m "test(workbench v2.5): real-llm e2e covers success, fallback, and Dead"
```

---

### Task 4.3: Add unit tests in `llm_stage.rs` + `test_helpers.rs`

**Files:**
- Modify: `crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs`
- Modify: `crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs`

- [ ] **Step 1: Add the 3 unit tests from spec §9 to the existing `tests` blocks**

In `test_helpers.rs`, append:

```rust
    #[tokio::test]
    async fn fake_records_review_call_with_attempt_and_model() {
        let fake = FakeLlmStage::default();
        let _ = fake.review(&ReviewInputs {
            task_id: "TAPD-1".into(),
            worktree_path: "/tmp/wt".into(),
            design_excerpt: "## Goal\nx".into(),
            diff: "+ new line".into(),
            prior_review: None,
            prior_verify: None,
            attempt: 2,
            primary_model: "sonnet-4.5".into(),
            fallback_model: Some("opus-4.1".into()),
        }).await.unwrap();
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].stage, "review");
        assert_eq!(calls[0].attempt, 2);
        assert_eq!(calls[0].primary_model, "sonnet-4.5");
    }

    #[test]
    fn fake_default_returns_approved_marker() {
        assert!(default_review_body().contains("LGTM"));
        assert!(default_code_body().contains("compiles"));
    }
```

In `llm_stage.rs`, append to the existing `#[cfg(test)] mod tests` block:

```rust
    #[test]
    fn parse_reviewer_verdict_approves_lgtm() {
        assert_eq!(
            parse_reviewer_verdict("## Findings\n(none)\n## Summary\nLGTM.\n"),
            ReviewVerdict::Approved,
        );
        assert_eq!(
            parse_reviewer_verdict("## Findings\n- major: foo"),
            ReviewVerdict::NeedsChanges,
        );
    }

    #[test]
    fn parse_coder_verdict_approves_self_checked() {
        assert_eq!(
            parse_coder_verdict("## Changes\n- x\n## Self-check\n- [x] compiles\n"),
            DevelopVerdict::Approved,
        );
    }
```

- [ ] **Step 2: Run the unit tests**

Run: `cargo test --lib -p xai-grok-shell workbench::llm_stage workbench::test_helpers`
Expected: 5 new tests pass (2 in `llm_stage`, 2 in `test_helpers` plus the 2 from Task 1.2).

- [ ] **Step 3: Commit**

```bash
cd "C:\Program Files\Development\AI_Projects\grok-build"
git add crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs
git commit -m "test(workbench v2.5): unit tests for fake + parsers"
```

---

### Task 4.4: Manual smoke test (documented)

> This is a developer-runs task, not a CI task. The hard spec constraint
> is that V2.5 ships behind `use_real_llm = false` until this passes.

- [ ] **Step 1: Configure**

```bash
# Edit ~/.grok/config.toml:
[workbench]
use_real_llm = true

[workbench.models]
coder_model = "opus-4.1"
coder_fallback = "sonnet-4.5"
reviewer_model = "sonnet-4.5"
reviewer_fallback = "opus-4.1"
```

- [ ] **Step 2: Start the server**

```bash
grok web --secret testkey
```

Open `http://127.0.0.1:2420/#key=testkey` in the browser. Pick a TAPD ticket and click "Start workbench".

- [ ] **Step 3: Verify**

- [ ] The `.workbench/stages/3-develop.md` file in the task's worktree contains real changes (not the v1 stub body).
- [ ] `.workbench/stages/4-review.md` contains a real review.
- [ ] `workbench_task_metrics` table in the TAPD SQLite DB has a row for `develop` with `fallback_used=0, child_session_id=<some-session-id>`.
- [ ] The GitLab MR contains a real diff (not the empty placeholder commit).

- [ ] **Step 4: Document the outcome**

Add a short summary to the PR description ("Manual smoke test: passed YYYY-MM-DD by @<your-handle>"). If any of the assertions fail, do NOT merge — file an issue and roll back the flag to `false`.

> No commit for this task; it's a pre-merge verification.

---

## V2.5 completion gate

After all 13 tasks land, V2.5 is **done**. Before tagging, verify:

- [ ] `cargo test -p xai-grok-shell --lib` passes (no regression)
- [ ] `cargo test -p xai-grok-shell --test workbench_orchestrator_e2e --test workbench_pipeline_e2e --test workbench_real_llm_e2e --test workbench_v1_state_compat --test recovery_e2e -- --nocapture` all pass
- [ ] `cargo check -p xai-grok-shell` passes
- [ ] `cargo check -p xai-grok-shell --tests` passes
- [ ] Manual smoke test (Task 4.4) has been performed + passed by a human
- [ ] `use_real_llm` flag defaults to `false` in `WorkbenchConfig::default()`
- [ ] Tag the commit: `git tag v2.5-real-llm-coder-reviewer`
- [ ] Ship the MR with the smoke-test summary in the description

**Do not start V2.6 (planner / adjudicator / runner stub replacement) until V2.5 has been in production for at least one week and metrics confirm the fallback path actually fires under real load.**

---

# V2.5 implementation work in this plan is complete for the selected B scope.
# Remaining gates are validation-only: the full crate suite has pre-existing
# failures, and real ACP smoke testing is explicitly deferred to V2.6.
# V2.6 will wire MvpAgentLlmStage into the LocalSet-owned agent lifecycle.
