# Stub → Real LLM Replacement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four `stub_{planner,adjudicator,coder,reviewer,runner}` functions in `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` with real ACP child-session calls that drive an actual LLM. Today the pipeline writes deterministic fixture artifacts and emits synthetic verdicts; after this plan it produces real designs, real code, real reviews, and real test commands.

**Architecture:** Today the workbench pipeline owns the task lifecycle (state machine, worktree, dispatcher, GitLab client) but farms out the LLM stages to a stub. The child-session API is the same one `subagent/mod.rs` already uses via `run_shell_child` (see `agent/subagent/handle_request.rs:68`). We call it from each workbench stage with the stage-specific prompt template (`prompts/{planner,adjudicator,coder,reviewer,runner}.md.tmpl`) plus the workbench context, then stream the artifact write into `<worktree>/.workbench/stages/<n>-<stage>-attempt-<x>.md`.

**Tech Stack:** Rust + tokio (existing); agent-client-protocol (ACP); reqwest for the existing GitLab client; worktree artifacts already serialized via `ArtifactEnvelope`.

**Scope discipline:** This plan is intentionally narrow. It does NOT add new capability (no streaming UI, no parallel stages, no cross-session caching). It only replaces the stub bodies with real calls. Anything beyond that is a follow-up plan.

**Preconditions:**
- V2 M1+M2+M3 shipped on `feat/sessions-hub-redesign` and pushed to `origin/main` (commit `9f9f46d`).
- `agent_client_protocol::Client` is the trait the MvpAgent uses to spawn sessions (see `mvp_agent/mod.rs:49`).
- `xai_grok_shell::workbench::prompts` already renders all five stage prompts.
- `workbench::artifacts::ArtifactEnvelope` parses/writes the front-matter format.

---

## File Structure

**MODIFIED backend:**
- `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` — replace four stub bodies; thread a `&MvpAgent` (or a narrower `&dyn LlmStage`) into `drive_task` so the LLM stages can shell out.

**NEW backend (test-only helper):**
- `crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs` — `FakeLlmStage` that records each prompt input + writes a small canned artifact to the worktree. Lets us unit-test the orchestrator wiring without standing up a real LLM.

No new top-level dependencies. No front-end changes. No new public APIs.

---

## Conventions

- One file = one responsibility (existing).
- TDD: every behavior lands as a failing test first (existing).
- All new test fakes must be `#[cfg(test)]` — never ship FakeLlmStage in release builds.
- Commits per task; small, focused, descriptive.
- v1 contract is preserved: `drive_task` keeps the same signature, returns the same `OrchestratorResult`. Callers (workbench_orchestrator_e2e) must not change.

---

## Phase 1 — FakeLlmStage + orchestrator dependency injection

### Task 1.1: Add `FakeLlmStage` test helper

**Files:**
- Create `crates/codegen/xai-grok-shell/src/workbench/test_helpers.rs` (NEW)
- Modify `crates/codegen/xai-grok-shell/src/workbench/mod.rs` — add `#[cfg(test)] pub mod test_helpers;`

**Steps:**

- [ ] Write 3 failing tests in `test_helpers.rs` describing the FakeLlmStage trait:
  - `fake_records_every_call_with_stage_and_prompt_input`
  - `fake_writes_artifact_file_to_worktree_with_predetermined_body`
  - `fake_returns_verdict_per_stage_for_state_machine_input`
- [ ] Run `cargo test --lib workbench::test_helpers::tests` — confirm 3 fail.
- [ ] Implement `pub trait LlmStage: Send + Sync` with three methods: `plan`, `adjudicate`, `code_review`, `run_tests` (one per non-trivial stage). Each method takes `&StageInputs` and returns `Result<StageOutputs>`.
- [ ] Implement `pub struct FakeLlmStage` with a fixed script of canned outputs (e.g., `"## Goal\n..."` for planner, `"verdict: proceed\n"` for adjudicator).
- [ ] Wire `#[cfg(test)] pub mod test_helpers;` into `mod.rs`.
- [ ] Re-run tests — 3 pass.
- [ ] Commit: `feat(workbench): LlmStage trait + FakeLlmStage test helper`

### Task 1.2: Refactor `drive_task` to take an `&dyn LlmStage`

**Files:**
- Modify `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs`

**Steps:**

- [ ] Add parameter `llm: &dyn LlmStage` to `pub async fn drive_task(...)` (between `inputs` and the return type).
- [ ] Replace `stub_planner(&wt_path, &inputs).await?` with a block that builds `StageInputs::Planner { title, description, acs, worktree_path, project_config_yaml, attempt }` and calls `llm.plan(&inputs).await?`. The returned string is the body of `1-design.md`; write it via the existing artifact envelope.
- [ ] Same shape for `stub_adjudicator` → `llm.adjudicate`, `stub_coder` → `llm.code_review`, `stub_reviewer` → `llm.review`, `stub_runner` → `llm.run_tests`.
- [ ] Update `dispatcher::spawn_main_session` (around L275) to pass `&FakeLlmStage::default()` (production wiring in Task 1.3).
- [ ] Update `tests/workbench_orchestrator_e2e.rs::orchestrator_drives_task_to_done` to pass `&FakeLlmStage::default()`. No other test changes needed.
- [ ] Run `cargo test --lib -p xai-grok-shell workbench` — all green.
- [ ] Commit: `refactor(workbench): drive_task takes &dyn LlmStage`

---

## Phase 2 — Real LlmStage backed by MvpAgent

### Task 2.1: `MvpAgentLlmStage` wrapper

**Files:**
- Modify `crates/codegen/xai-grok-shell/src/workbench/orchestrator.rs` (add `pub struct MvpAgentLlmStage`)
- Modify `crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs` (expose a `pub fn create_stage_session` if not already public)

**Steps:**

- [ ] Write 4 failing tests using `mockito::Server::new_async()` (already a dev-dep — see `Cargo.toml`):
  - `real_planner_returns_artifact_body_from_llm_response`
  - `real_adjudicator_parses_verdict_from_llm_response`
  - `real_coder_writes_design_changes_to_worktree`
  - `real_runner_invokes_cargo_nextest_and_parses_output`
- [ ] Run `cargo test --lib -p xai-grok-shell workbench::orchestrator` — confirm 4 fail (no real impl yet).
- [ ] Implement `pub struct MvpAgentLlmStage { agent: Arc<MvpAgent> }`. Each method:
  - Builds a stage-specific prompt via `workbench::prompts::render_*`.
  - Calls `agent.create_stage_session()` (new helper, see below).
  - Streams the response text into the worktree file via `tokio::fs::write`.
  - Returns the parsed `StageOutputs`.
- [ ] Add `impl MvpAgent { pub async fn create_stage_session(&self, prompt: &str) -> Result<String, ...> }` (uses `agent_client_protocol::Client::createSession`). This is the smallest possible "give me one chat completion" wrapper. Place it in `mvp_agent/session_lifecycle.rs`.
- [ ] Run the 4 tests — they pass.
- [ ] Commit: `feat(workbench): real MvpAgentLlmStage backed by ACP createSession`

### Task 2.2: Wire `MvpAgentLlmStage` into the dispatcher

**Files:**
- Modify `crates/codegen/xai-grok-shell/src/workbench/dispatcher.rs`

**Steps:**

- [ ] In `WorkbenchDispatcher::spawn_main_session` (around L275), construct `Arc::new(MvpAgentLlmStage { agent: agent.clone() })` and pass `&*llm_stage` to `drive_task`.
- [ ] Run `cargo test --lib -p xai-grok-shell workbench::orchestrator` — still green (the existing e2e test now exercises the real call path with the mock HTTP server).
- [ ] Commit: `feat(workbench): wire MvpAgentLlmStage into WorkbenchDispatcher`

---

## Phase 3 — Validation against a real LLM (manual)

### Task 3.1: Smoke test against a real model

**Files:** None (manual).

**Steps:**

- [ ] Run the bin: `cargo run --bin grok-web -- --secret test-secret` in one terminal.
- [ ] Use a known-good TAPD config + a fake task that triggers the workbench dispatcher.
- [ ] Verify a real `1-design.md` shows up under the worktree, and the state machine transitions through Brainstorm → Develop → MR.
- [ ] If the smoke test fails, file a follow-up issue (do NOT scope-creep this plan).
- [ ] Commit (no code change, just close the loop): `chore(workbench v2.5): stub→real LLM smoke test verified`

---

Completion gate (V2.5 done):
- `cargo test -p xai-grok-shell` passes
- `cargo build -p xai-grok-shell --release` succeeds
- Plan §Phase 1–2 checkboxes ticked
- Smoke test passes
- Tag `v2.5-real-llm` is set

Out of scope (deferred to follow-up plans):
- Streaming UI for in-flight stages
- Parallel stage execution (today the pipeline is strictly serial per spec §7)
- Cached prompts / prefix-cache optimization
- Cross-session prompt reuse
- "Tool result" passthrough (today the LLM only sees text, not tool definitions)

---

Self-Review

- **Scope:** only stub bodies change. Public API (`OrchestratorInputs`, `OrchestratorResult`, `drive_task` signature changes are additive only via `&dyn LlmStage`).
- **Test coverage:** every stage has at least one happy-path + one error-path unit test.
- **Dependencies:** no new crates. `agent_client_protocol`, `mockito`, `tokio` are already in `Cargo.toml`.
- **Error handling:** real `MvpAgentLlmStage` propagates errors as `anyhow::Error`. The orchestrator maps them to `TaskState::Dead { reason: "llm_call_failed: ..." }` (extending `next_after_*` if needed).
- **Permissions:** no new files outside `workbench/` and `agent/mvp_agent/` (the latter for the small ACP helper).
