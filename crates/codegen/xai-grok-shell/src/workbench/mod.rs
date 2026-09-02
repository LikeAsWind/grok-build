//! TAPD workbench pipeline — automated 6-stage workflow that turns TAPD
//! tickets into GitLab MRs. See the spec at
//! `docs/superpowers/specs/2026-09-01-tapd-workbench-pipeline-design.md`.
//!
//! Module map (populated incrementally as the plan tasks land):
//! - [`dispatcher`] — `WorkbenchDispatcher` actor: priority queue, slot
//!   accounting, dispatch loop.
//! - [`state_machine`] — `TaskState`, `Stage`, `Priority` enums +
//!   transition table.
//! - [`artifacts`] — frontmatter parse / write, filename convention.
//! - [`worktree_manager`] — worktree create / list / delete + delayed GC.
//! - [`runner`] — `Verify` stage: test_command spawn, output capture, timeout.
//! - [`submitter`] — `MrSubmit` stage: GitLab REST client + MR payload +
//!   reviewer resolution.
//! - [`notifications`] — TAPD comment + Slack / Feishu webhook.
//! - [`prompts`] — per-role system prompt templates.
//! - [`main_session`] — main session actor: state machine driver + child
//!   session event forwarder.

pub mod artifacts;
pub mod dispatcher;
pub mod main_session;
pub mod notifications;
pub mod prompts;
pub mod runner;
pub mod state_machine;
pub mod submitter;
pub mod worktree_manager;








