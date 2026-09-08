# V2.5: Stub → Real LLM — Design Spec

> Status: **Draft (awaiting user review)**
> Date: 2026-09-07
> Owner: workbench subsystem
> Predecessor: `docs/superpowers/specs/2026-09-03-tapd-workbench-v2-design.md` (V2, shipped)
> Brainstorm: `docs/superpowers/specs/2026-09-07-stub-to-real-llm-brainstorm.md` (same date, this spec's source)
> Scope: replace stub LLM stages for coder and reviewer with real ACP child-session calls. Other stages (planner, adjudicator, runner) keep their stubs.

---

## 1. Summary

V1 and V2 ship a 6-stage workbench pipeline whose `drive_task` writes deterministic fixture artifacts from four stub functions: `stub_planner`, `stub_adjudicator`, `stub_coder`, `stub_reviewer`, `stub_runner`. The state machine, dispatcher, worktree manager, GitLab client, and observability are real — but the LLM stages never call an LLM.

V2.5 replaces **only the coder and reviewer stages** with real ACP child-session calls. The other three stages keep their stubs; replacing them is deferred to a follow-up plan. The replacement uses a `&dyn LlmStage` trait injected at the dispatcher boundary so `drive_task`'s public signature stays unchanged. Production passes `MvpAgentLlmStage` (real `agent_client_protocol::Client::createSession`); tests pass `FakeLlmStage` (canned artifacts, no network).

Why this is worth doing now:

- **Reliability** — `v2-m1-reliable` is the current tag, but `recovery::decide_fallback` only fires when an LLM stage fails. Today the LLM never fails (it is a stub). After V2.5, fallback / retry paths execute for real on the coder/reviewer stages.
- **Observability** — the V2 observability layer (intervention, cron, mr_comments re-trigger, metrics, timeline) is wired through `workbench_task_metrics` + `workbench_task_state`. With stubs, those events fire against fixture data and tell the operator nothing. With real LLM, they fire against actual outcomes.

Why only coder + reviewer (not all 5 stages):

- Reliability is most visible here. The fallback chain `coder fails → retry → fallback to a different model → reviewer sees the result` is the canonical reliability scenario in the V2 spec (§6.2.1). Once this works end-to-end, the pattern is transferable to the other stages.
- Coder is the highest-value stage to make real — it is the only one that writes actual source code. Until V2.5 the pipeline produces Draft MRs containing only the worktree's initial commit. After V2.5, MRs contain real diffs.
- Reviewer is the natural pair — it consumes coder output, so making both real together is a single end-to-end vertical slice.
- The remaining three (planner, adjudicator, runner) can be replaced in V3 or later; V2.5 deliberately scopes to one vertical slice.

---

## 2. Context & Motivation

V1's 35-commit diff was reviewable in one sitting. V2 added reliability / control / observability layers, all of which assume a real LLM is being driven. After 31 V2 commits and three milestones (M1+M2+M3), the pipeline is feature-complete for everything except the LLM itself. V2.5 is the gap between "the workbench has every feature" and "the workbench does what its UI implies".

Manual demo today: a user runs `grok web`, opens a workbench task, sees the pipeline start, watches a stage transition, sees an MR URL appear, and clicks it. The MR contains no diff. This is the central demo gap.

CI: 23 v2 tests pass. None exercise a real LLM, so "tests pass" does not imply "the LLM portion works". After V2.5, 2-3 new tests pin down the fallback/retry behavior so regressions are caught.

---

## 3. Goals & Non-Goals

### Goals

1. `drive_task` calls real `agent_client_protocol::Client::createSession` for the coder and reviewer stages. Output is parsed and written to the worktree as `ArtifactEnvelope` (frontmatter + body).
2. The two stages exercise the existing V2 reliability machinery (`workbench::recovery::decide_fallback`, retry budgets) — when the real LLM fails, fallback fires and metrics record it.
3. `drive_task`'s public signature is unchanged. Existing callers (`dispatcher::spawn_main_session`, `tests/workbench_orchestrator_e2e.rs::orchestrator_drives_task_to_done`) compile without modification.
4. CI tests run without a live LLM. The FakeLlmStage substitutes real LLM responses; new unit tests assert that the orchestrator passes the right prompt inputs and parses the right artifact outputs.
5. A new e2e test (with `mockito` mocking the ACP HTTP layer) verifies the end-to-end fallback flow: coder fails → fallback model is selected → reviewer succeeds.
6. Manual smoke test against a real LLM (Task 3.1) verifies the full path. Done by the developer at the end of the work, not in CI.

### Non-Goals

- Replacing stub_planner, stub_adjudicator, or stub_runner (follow-up plan).
- Streaming UI for in-progress stages (already partially exists via `x.ai/workbench/stage` notification; not changed here).
- Parallel stage execution (today the pipeline is strictly serial per spec §7).
- Prefix-cache / prompt caching / cross-session prompt reuse.
- Tool-result passthrough (today the LLM only sees text; tool definitions are not exposed).
- New top-level dependencies. `agent_client_protocol`, `mockito`, `tokio` are already in `Cargo.toml`.
- Front-end changes (the V2 UI consumes whatever shape V1 produced; real artifacts fit the same shape).
- State-machine changes (V2 M1 already added `next_after_replay`, `last_error` on Running — these are sufficient).

---

## 4. Constraints

### Hard constraints (cannot change)

- `pub async fn drive_task(...)` signature stays unchanged.
- `OrchestratorInputs` and `OrchestratorResult` structs stay unchanged.
- `ArtifactEnvelope` frontmatter format stays unchanged (v1/v2 fixtures rely on it).
- `cargo test -p xai-grok-shell` runs green in CI without network.
- GPL-3.0-only license on all new code.

### Soft constraints (default to preserving; can be relaxed with justification)

- No new top-level dependencies.
- No front-end changes.
- Stage order unchanged.
- Retry budgets unchanged.

---

## 5. Architecture

### High-level shape

`drive_task` becomes a generic function over an `LlmStage` trait. The trait has two methods (one per real stage in V2.5): `code` and `review`. Production passes `MvpAgentLlmStage` (real ACP). Tests pass `FakeLlmStage`. Both implement the same trait, so production and tests share the orchestrator logic.

```
pub trait LlmStage: Send + Sync {
    async fn code(&self, input: &CodeInputs) -> anyhow::Result<CodeOutputs>;
    async fn review(&self, input: &ReviewInputs) -> anyhow::Result<ReviewOutputs>;
}

pub struct MvpAgentLlmStage { agent: Arc<MvpAgent> }

impl LlmStage for MvpAgentLlmStage { /* talks to ACP createSession */ }

pub struct FakeLlmStage {
    pub code_response: String,
    pub review_response: String,
    pub fail_code: bool, // when true, code() returns Err to exercise fallback
    pub fail_review: bool,
}
```

### Stage integration

Inside `drive_task`, the `code` and `review` stages call the trait method instead of the local stub. Everything else (worktree creation, artifact write, state transitions, record_task_metric, mr_comment, etc.) is unchanged.

```
// Before (V2):
stub_coder(&wt_path, &inputs).await?;
state = next_after_develop(true, 0);

// After (V2.5):
let code_out = llm.code(&CodeInputs { worktree_path, task, attempt, prior_artifacts }).await?;
tokio::fs::write(&wt_path.join(".workbench/stages/3-develop.md"), &code_out.artifact_body).await?;
record_task_metric(..., code_out.model, code_out.fallback_used, ...);
state = next_after_develop(true, code_out.verdict);
```

### Trait injection point

`WorkbenchDispatcher::spawn_main_session` builds the LlmStage at task-spawn time. Production wires `MvpAgentLlmStage { agent: agent.clone() }`; the existing `tests/workbench_orchestrator_e2e.rs` wires `FakeLlmStage`. No changes to `dispatcher.rs` are required beyond the constructor call — the trait value is passed through `OrchestratorInputs` as `llm_stage: Arc<dyn LlmStage>` (private field, not part of the public API surface).

### Fallback integration

The existing `workbench::recovery::decide_fallback(role, attempt, fallback_used, primary, fallback)` is called by the orchestrator when the LLM call fails. `MvpAgentLlmStage` records `fallback_used=1` on the metrics row whenever the call succeeded using the fallback model. The e2e test asserts this end-to-end.

### Persistence

No changes to `tapd::store` schema. `workbench_task_metrics.fallback_used` (column added in M1.5) already records fallback events. `workbench_mr_comments` (M1.5) records reviewer comments. The V2.5 LLM stages write to both as a side effect of their existing calls.

---

## 6. Data Flow

### Happy path (no fallback)

1. `WorkbenchDispatcher::spawn_main_session` builds `MvpAgentLlmStage` and calls `drive_task(store, gitlab, inputs, intervention, llm_stage)`.
2. `drive_task` reaches the develop stage. Calls `llm_stage.code(&code_inputs).await`.
3. `MvpAgentLlmStage::code` builds the coder prompt via `workbench::prompts::render_coder`, opens an ACP child session via `agent.create_stage_session(prompt)`, streams the response text, parses it into `CodeOutputs`.
4. `drive_task` writes the parsed response to `.workbench/stages/3-develop.md`. Calls `store.record_task_metric(..., fallback_used=0, child_session_id=...)`.
5. State machine: `next_after_develop(true, 0)` → Running { CodeReview }.
6. Review stage: same shape, calling `llm_stage.review(&review_inputs)`.
7. Reviewer writes `.workbench/stages/4-review.md`. State machine → Running { Verify } (stub_runner unchanged).

### Fallback path

1. Coder call returns `Err`.
2. Orchestrator calls `recovery::decide_fallback(role=Coder, attempt, fallback_used=false, primary="opus-4.1", fallback="sonnet-4.5")` → returns `Some(fallback_model)`.
3. Orchestrator retries `llm_stage.code(&code_inputs_with_fallback_model).await`. On success, records `fallback_used=1` on the metrics row.
4. On second failure (fallback_used=true and decide_fallback returns None per M1.3 rules), orchestrator transitions to `Dead { reason: "develop_retries_exhausted" }`.

### Failure surface (no LLM reachable)

If `MvpAgentLlmStage::code` returns `Err` with no recoverable retry, the orchestrator transitions to `Dead`. The error reason is propagated as `"coder_failed: <msg>"`. The V2 observability layer surfaces this via `workbench_task_state` (already exists) and the existing `x.ai/workbench/stage` notification.

---

## 7. Components & Interfaces

### `LlmStage` trait (NEW)

Path: `crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs`

```
pub trait LlmStage: Send + Sync {
    async fn code(&self, input: &CodeInputs) -> anyhow::Result<CodeOutputs>;
    async fn review(&self, input: &ReviewInputs) -> anyhow::Result<ReviewOutputs>;
}

pub struct CodeInputs {
    pub task_id: String,
    pub title: String,
    pub description: String,
    pub acs: Vec<String>,
    pub worktree_path: std::path::PathBuf,
    pub project_config_yaml: String,
    pub prior_artifacts: Vec<PriorArtifact>, // 1-design.md, 2-adjudicate.md if present
    pub attempt: u8,
    pub primary_model: String,
    pub fallback_model: Option<String>,
}

pub struct CodeOutputs {
    pub artifact_body: String,        // full markdown body of 3-develop.md
    pub verdict: DevelopVerdict,      // Approved | NeedsChanges
    pub model: String,
    pub fallback_used: bool,
    pub child_session_id: Option<String>,
}
// ... ReviewInputs / ReviewOutputs analogous
```

### `MvpAgentLlmStage` (NEW)

Path: `crates/codegen/xai-grok-shell/src/workbench/llm_stage.rs` (same file as trait).

Production implementation. Uses `MvpAgent::create_stage_session(prompt: &str) -> Result<String>` — a thin ACP wrapper that opens a session, sends the prompt, streams the response, returns the text. (See Implementation Plan §Task 2.1 for the wrapper details.)

### `FakeLlmStage` (NEW, test-only)

Path: `crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs` (NEW file, gated by `#[cfg(test)]`).

Records every call to `code` / `review` for assertion in tests. Returns canned artifact bodies matching the v1 e2e fixture text so existing tests do not break. `fail_code: bool` flag injects an error to exercise fallback.

### `OrchestratorInputs` change (private)

Add `llm_stage: Arc<dyn LlmStage>` as a private field (does NOT participate in `pub` struct construction, set via a new builder pattern or a separate `with_llm_stage(...)` constructor). The `drive_task` function reads `llm_stage.llm()` to obtain the trait object.

### `dispatcher::spawn_main_session` change

Construct the LlmStage based on a `WorkbenchDispatcherConfig` flag:

```
let llm_stage: Arc<dyn LlmStage> = if cfg.use_real_llm {
    Arc::new(MvpAgentLlmStage { agent: agent.clone() })
} else {
    Arc::new(FakeLlmStage::default()) // production default until V2.5 rollout completes
};
drive_task(store.clone(), &g, inputs, intervention, llm_stage).await?;
```

Default: `FakeLlmStage` until V2.5 is rolled out behind a feature flag. The flag lives in `[workbench]` config (`use_real_llm: bool`, default `false`); flipping it in production triggers the migration.

---

## 8. Error Handling

### Categories

- **LLM call failure (network, auth, timeout)** → `MvpAgentLlmStage::code` returns `Err(anyhow::Error)`. Orchestrator calls `recovery::decide_fallback`; if None → `Dead { reason: "coder_failed: <msg>" }` (preserves last_error in the prior Running state via the existing M1.6 `last_error` field on `TaskState::Running`).
- **Malformed LLM output (missing required sections, invalid YAML)** → `MvpAgentLlmStage` parses and returns Err; orchestrator retries with fallback; if still failing → Dead.
- **Worktree missing or read-only** → `tokio::fs::write` returns Err; orchestrator transitions to Dead (existing path).
- **FakeLlmStage panics in tests** → test fails with a clear panic message; never propagates to production code paths.

### Logging

Every `MvpAgentLlmStage::code` / `::review` logs: stage, task_id, attempt, model, fallback_used, latency_ms, token count (if available). On error: reason + retry hint. All via `tracing`.

---

## 9. Testing

### Unit tests (Cargo)

`cargo test --lib -p xai-grok-shell workbench::llm_stage`

1. `fake_records_every_call_with_stage_and_prompt_input` — FakeLlmStage::code / review append to an internal log; tests assert prompt contents.
2. `fake_writes_artifact_file_to_worktree_with_predetermined_body` — when wired to the orchestrator, the artifact ends up at the expected worktree path.
3. `fake_returns_verdict_per_stage_for_state_machine_input` — Approved / NeedsChanges / empty body variants.
4. `real_mvp_agent_llm_stage_uses_create_session` (mocked) — verifies the call path uses `agent.create_stage_session` with the right prompt.
5. `recovery::decide_fallback` is called on coder failure; the orchestrator records `fallback_used=1` on the next attempt.

### Integration tests (Cargo)

`cargo test --test workbench_real_llm_e2e -p xai-grok-shell` (NEW file)

1. `mvp_agent_llm_stage_coder_success_records_metrics` — coder call succeeds; `task_metrics` row has `fallback_used=0, child_session_id=<sess>`.
2. `mvp_agent_llm_stage_coder_failure_triggers_fallback` — first coder call returns Err; second call uses `fallback_model` returned by `decide_fallback`; metrics row has `fallback_used=1`.
3. `mvp_agent_llm_stage_double_failure_routes_to_dead` — both attempts fail; final state is `Dead { reason: "coder_failed: ..." }`.
4. `end_to_end_coder_failure_observable_via_mr_comment` (optional, mirrors M3.5 hook) — when reviewer leaves a comment in a real-looking flow, the next dispatch sweep triggers Adjudicate re-run.

### Manual smoke test

Documented in Implementation Plan §Task 3.1. Developer runs `grok web` locally with `use_real_llm = true` in config, opens a workbench task, verifies real artifacts in the worktree.

---

## 10. Rollout

### Phase 1: Shadow mode (default off)

- `WorkbenchDispatcherConfig.use_real_llm` defaults to `false`. Existing v2 behavior unchanged.
- The 23 v2 e2e / unit tests pass with FakeLlmStage as before.
- The new llm_stage unit tests pin down the trait contract.

### Phase 2: Opt-in flag

Operators set `[workbench].use_real_llm = true` in `~/.grok/config.toml`. Real LLM kicks in for coder + reviewer.
- Metrics, mr_comments, intervention, cron all start reflecting real activity.
- Roll back by flipping the flag off; FakeLlmStage is the safety net.

### Phase 3 (deferred — V2.6 or later)

Replace planner / adjudicator / runner stubs; remove the feature flag once the other stages are stable.

---

## 11. Open Questions

1. **ACP `create_session` exact signature.** Plan assumes `agent.create_stage_session(prompt: &str) -> Result<String, Error>`. **Risk: medium.** Verification: read `crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_lifecycle.rs` + `agent_client_protocol` crate docs in Task 2.1 step 1.
2. **Where to put `MvpAgent::create_stage_session`?** Currently `agent_ops.rs` is 4950 lines. The new helper is small (~30 LOC). Plan adds it to `mvp_agent/session_lifecycle.rs`. **Risk: low.** Verify by file listing in Task 2.1 step 1.
3. **`prompts/coder.md.tmpl` + `prompts/reviewer.md.tmpl` content quality.** Real prompts are longer than the v1 templates; the existing templates are minimal placeholders. **Risk: medium.** Task 1.2 step 3 includes a content-quality pass.
4. **Does the existing `recovery::decide_fallback` return `None` correctly for the second-attempt-failed case?** Plan assumes yes (per V2 M1.3 unit tests). **Risk: low.** Verified in Task 2.2 step 3.
5. **How does the coder prompt get the worktree path / current files?** Today `build_planner_inputs` constructs it; we need an analogous `build_coder_inputs` and `build_reviewer_inputs`. **Risk: medium.** Task 2.1 step 2 includes reading the existing input builders.

---

## 12. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ACP `create_session` signature differs from plan assumption | Med | High (forces plan rewrite mid-Task-2.1) | Read ACP docs + existing subagent pattern BEFORE Task 2.1 step 1; revise plan if needed |
| Real LLM produces invalid artifact (missing sections, malformed YAML) | Med | Med | Add validator at artifact-write time; retry on validation failure before falling back |
| Shell-out for `runner` blocks on worktree permissions | Med | Med | Not in scope for V2.5; runner stays stub. Document this in V2.6 plan |
| Plan scope creeps (streaming UI / parallel stages) | High | Med | Hard-gate Task 1.2 commit; reject any PR that touches `web/src/` or `state_machine.rs` |
| Existing v2 e2e tests break under `FakeLlmStage` substitution | Low | Med | Run full `workbench_*` tests after Task 1.2; fix fake (not test) on regression |

---

## 13. Decision Log

1. **Purpose = B + C** (reliability + observability). 2026-09-07, this spec.
2. **Scope = B** (coder + reviewer only). 2026-09-07.
3. **Success criteria = B** (fallback really fires). 2026-09-07.
4. **Approach = A** (trait injection with FakeLlmStage). 2026-09-07.
5. **Hard constraint: v1 public API unchanged.** 2026-09-07.
6. **Default rollout: `use_real_llm = false` until manual smoke-test passes.** 2026-09-07.
7. **No new dependencies.** 2026-09-07.

---

## 14. References

- `docs/superpowers/specs/2026-09-03-tapd-workbench-v2-design.md` §6.2.1 (fallback policy), §9.2.1 (mr_comments), §10 (deferred items)
- `docs/superpowers/specs/2026-09-07-stub-to-real-llm-brainstorm.md`
- `crates/codegen/xai-grok-shell/src/workbench/recovery.rs` (existing `decide_fallback`)
- `crates/codegen/xai-grok-shell/src/workbench/state_machine.rs` (existing `next_after_develop`, `next_after_review`)
- `crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_lifecycle.rs` (where `create_stage_session` will live)
- `crates/codegen/xai-grok-shell/src/workbench/submitter.rs` (existing GitLab MR client; reused unchanged)
- `crates/codegen/xai-grok-shell/src/workbench/prompts/` (existing coder.md.tmpl + reviewer.md.tmpl)
- AGENTS.md §1 "Minimal code" §2 "Surgical changes"

---

## Spec Self-Review (post-write)

1. **Placeholder scan:** No "TBD" / "TODO" / "FIXME" / vague language in commitments. Open Questions (§11) are explicit, not placeholders.
2. **Internal consistency:** Architecture (§5) matches the Data Flow (§6). Components (§7) reference the same trait. Error Handling (§8) covers the cases the Architecture mentions.
3. **Scope check:** One vertical slice (coder + reviewer), one new trait, one real impl, one fake. Fits in a single implementation plan.
4. **Ambiguity check:** "primary_model" / "fallback_model" are pulled from `WorkbenchModelsConfig` (existing M1.2 field). "ACP child session" means `agent_client_protocol::SessionId` (existing type).

