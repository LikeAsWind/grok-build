//! Pause / resume / cancel intervention registry per v2 spec §7.2.1.
//!
//! The orchestrator consults `InterventionRegistry::token(task_id)` at each
//! stage boundary AND between LLM token chunks. On cancel, the in-flight
//! child session is sent `acp::Cancel` and the task transitions to
//! `Dead { reason: "user_cancelled" }`.
//!
//! All operations are idempotent: pausing an already-paused task is a
//! no-op (same token kept); cancelling a completed task is also a no-op.
//!
//! Persistence: when paused, the current `TaskState::Running` is saved to
//! `state.json` with `attempt` unchanged; on resume, the orchestrator
//! re-runs the current stage from scratch (LLM stages re-execute; tool
//! stages re-run). Pause granularity is one stage, not one LLM call (D9).

use std::sync::Arc;

use dashmap::DashMap;
use tokio_util::sync::CancellationToken;

#[derive(Default, Debug)]
pub struct InterventionRegistry {
    pause_tokens: DashMap<String, PauseEntry>,
}

#[derive(Debug)]
struct PauseEntry {
    token: CancellationToken,
    reason: Option<String>,
}

impl InterventionRegistry {
    pub fn new() -> Self {
        Self { pause_tokens: DashMap::new() }
    }

    /// Pause a task. Creates the pause token if missing, replaces the reason.
    /// Returns the reason string for the new (or pre-existing) pause.
    pub fn pause(&self, task_id: &str, reason: Option<String>) -> Option<String> {
        let mut entry = self.pause_tokens.entry(task_id.to_string()).or_insert_with(|| PauseEntry {
            token: CancellationToken::new(),
            reason: None,
        });
        if entry.reason.is_none() {
            entry.reason = reason.clone();
        }
        entry.reason.clone()
    }

    /// Resume a paused task. Removes the pause token (idempotent: if the
    /// task was never paused, this is a no-op).
    pub fn resume(&self, task_id: &str) {
        self.pause_tokens.remove(task_id);
    }

    /// Cancel a task. Sets the cancellation token; the orchestrator sees
    /// `is_cancelled()` and routes to `Dead { reason: "user_cancelled" }`.
    /// Idempotent: cancelling an already-cancelled task re-uses the same
    /// token (CancellationToken::cancel is itself idempotent).
    pub fn cancel(&self, task_id: &str) {
        let mut entry = self.pause_tokens.entry(task_id.to_string()).or_insert_with(|| PauseEntry {
            token: CancellationToken::new(),
            reason: None,
        });
        entry.token.cancel();
    }

    /// Look up the cancellation token for a task. The orchestrator passes
    /// this to `tokio::select!` between stage boundaries.
    pub fn token(&self, task_id: &str) -> Option<CancellationToken> {
        self.pause_tokens.get(task_id).map(|e| e.token.clone())
    }

    /// True if a task is currently paused (has an entry).
    pub fn is_paused(&self, task_id: &str) -> bool {
        self.pause_tokens.contains_key(task_id)
    }

    /// The reason recorded at pause time, if any.
    pub fn reason(&self, task_id: &str) -> Option<String> {
        self.pause_tokens.get(task_id).and_then(|e| e.reason.clone())
    }

    /// Wrap `Self` in `Arc` for sharing across the orchestrator + the
    /// ext-method handlers (which may live in different modules).
    pub fn into_arc(self) -> Arc<Self> {
        Arc::new(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_sets_token_for_task() {
        let reg = InterventionRegistry::new();
        assert!(reg.token("TAPD-1").is_none());
        reg.pause("TAPD-1", Some("user wanted to fix design".into()));
        let token = reg.token("TAPD-1").expect("token must exist after pause");
        assert!(!token.is_cancelled(), "pause must not also cancel");
        assert_eq!(reg.reason("TAPD-1").as_deref(), Some("user wanted to fix design"));
    }

    #[test]
    fn pause_idempotent_on_already_paused() {
        let reg = InterventionRegistry::new();
        reg.pause("TAPD-1", Some("first reason".into()));
        // Second pause with a different reason must NOT replace the existing
        // pause entry; the registry keeps the original reason + token.
        reg.pause("TAPD-1", Some("second reason".into()));
        assert!(reg.is_paused("TAPD-1"));
        // First reason is preserved (we only fill when None).
        assert_eq!(reg.reason("TAPD-1").as_deref(), Some("first reason"));
    }

    #[test]
    fn cancel_triggers_token() {
        let reg = InterventionRegistry::new();
        // Cancel a never-paused task: creates + cancels a fresh token.
        reg.cancel("TAPD-2");
        let token = reg.token("TAPD-2").expect("cancel must allocate a token");
        assert!(token.is_cancelled());
        // Idempotent: cancel again does not panic.
        reg.cancel("TAPD-2");
        assert!(token.is_cancelled());
    }

    #[test]
    fn lookup_unknown_task_returns_none() {
        let reg = InterventionRegistry::new();
        assert!(reg.token("nope").is_none());
        assert!(reg.is_paused("nope") == false);
        assert!(reg.reason("nope").is_none());
        // Resume on unknown is a silent no-op (does not panic).
        reg.resume("nope");
    }

    #[test]
    fn resume_removes_pause_entry() {
        let reg = InterventionRegistry::new();
        reg.pause("TAPD-3", None);
        assert!(reg.is_paused("TAPD-3"));
        reg.resume("TAPD-3");
        assert!(!reg.is_paused("TAPD-3"));
        assert!(reg.token("TAPD-3").is_none());
    }
}

