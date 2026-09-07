//! 6-stage workbench pipeline state machine.
//!
//! Spec §7 — deterministic transitions; LLM stages (Brainstorm, Adjudicate,
//! Develop, Code Review) drive retries via stage retry budgets; tool stages
//! (Verify, MrSubmit) have their own semantics (Verify reroutes to Develop
//! with no own budget; MrSubmit distinguishes transient vs auth/conflict).
//!
//! This module is **pure**: no I/O, no LLM calls. The dispatcher / main
//! session actor drive the state by calling these functions and persisting
//! the result via `state.json` (see T4.3).

use serde::{Deserialize, Serialize};

use crate::agent::config::AdjudicateMode;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Brainstorm,
    Adjudicate,
    Develop,
    #[serde(alias = "review")]
    CodeReview,
    Verify,
    MrSubmit,
}

impl Stage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Stage::Brainstorm => "brainstorm",
            Stage::Adjudicate => "adjudicate",
            Stage::Develop => "develop",
            Stage::CodeReview => "code_review",
            Stage::Verify => "verify",
            Stage::MrSubmit => "mr_submit",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskState {
    Queued { priority: String },
    Pending,
    Running {
        stage: Stage,
        attempt: u8,
        started_at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback_model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_error: Option<String>,
    },
    BlockedForHuman {
        stage: Stage,
        reason: String,
        payload: serde_json::Value,
    },
    Done { mr_url: String, finished_at: i64 },
    Dead { reason: String },
}

impl TaskState {
    /// True for terminal states (Done, BlockedForHuman, Dead) — the
    /// state machine should not be advanced further from these.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskState::Done { .. } | TaskState::BlockedForHuman { .. } | TaskState::Dead { .. }
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum AdjudicateVerdict {
    Proceed,
    BlockForHuman,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum MrSubmitOutcome {
    Ok,
    Conflict,
    AuthError,
    TransientError,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum DevelopVerdict {
    Ok,
    Fail(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReviewVerdict {
    Approved,
    NeedsChanges,
}

/// Lightweight in-memory representation of the design doc's Open Questions
/// section. We only need to know whether it has open questions that block
/// the coder; the LLM re-reads the full doc when it actually adjudicates.
#[derive(Clone, Debug)]
pub struct DesignDoc {
    pub raw: String,
}

impl DesignDoc {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        Ok(Self { raw: s.into() })
    }

    /// True if the design doc has any `## Open questions` items that
    /// would block the coder. A section that says exactly `None.` is
    /// treated as no questions.
    pub fn has_open_questions(&self) -> bool {
        let Some(idx) = self.raw.find("## Open questions") else {
            return false;
        };
        let tail = &self.raw[idx..];
        let body = tail
            .split_once("\n## ")
            .map(|(b, _)| b)
            .unwrap_or(tail);
        // "None." alone is treated as no questions
        if body.trim().lines().all(|l| {
            l.trim().is_empty() || l.trim() == "None." || l.trim().starts_with("## ")
        }) {
            return false;
        }
        body.lines().any(|l| l.trim_start().starts_with("- "))
    }

    /// True if the design has any open question tagged `critical:` (used
    /// by the `Gatekeeper` adjudicate mode to decide whether to block).
    /// Convention: open-question lines start with `- critical: <text>`
    /// or `- non_critical: <text>`; lines without a prefix are treated
    /// as non-critical (Recorder blocks them, Gatekeeper does not).
    pub fn has_critical_questions(&self) -> bool {
        // Open questions tagged `critical:` are detected by scanning the design body.
        // We treat any `- critical:` line as a critical question (per spec §7.2.4).
        self.raw
            .lines()
            .any(|l: &str| l.trim_start().starts_with("- critical:"))
    }
}

fn retry_left(attempt: u8, max: u8) -> bool {
    attempt < max
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// After the planner finishes, decide whether to run Adjudicate next or
/// skip directly to Develop. Spec §7.1: Adjudicate runs only when the
/// design has open questions AND (priority >= High OR ac_count >= 5).
pub fn next_after_planner(
    current: TaskState,
    design: &DesignDoc,
    priority: i32, // 0=Low, 1=Medium, 2=High, 3=Urgent (see Priority enum)
    ac_count: usize,
    mode: AdjudicateMode,
) -> TaskState {
    const MAX: u8 = 3;
    let attempt = match &current {
        TaskState::Running { attempt, .. } => *attempt,
        _ => 0,
    };
    if !retry_left(attempt, MAX) {
        return TaskState::Dead {
            reason: "brainstorm retries exhausted".into(),
        };
    }
    // AdjudicateMode determines when the Adjudicate stage runs.
    // - AlwaysSkip: skip Adjudicate entirely (Brainstorm -> Develop).
    // - Gatekeeper: only block on questions tagged `critical:`.
    // - Recorder: block on any open question (v1 behavior).
    let needs_adj = match mode {
        AdjudicateMode::AlwaysSkip => false,
        AdjudicateMode::Gatekeeper => {
            design.has_open_questions() && design.has_critical_questions()
        }
        AdjudicateMode::Recorder => {
            design.has_open_questions() && (priority >= 2 || ac_count >= 5)
        }
    };
    if needs_adj {
        TaskState::Running {
            stage: Stage::Adjudicate,
            attempt: 0,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        }
    } else {
        TaskState::Running {
            stage: Stage::Develop,
            attempt: 0,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        }
    }
}

/// After the adjudicator finishes, route based on the verdict.
pub fn next_after_adjudicate(verdict: AdjudicateVerdict) -> TaskState {
    match verdict {
        AdjudicateVerdict::Proceed => TaskState::Running {
            stage: Stage::Develop,
            attempt: 0,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        },
        AdjudicateVerdict::BlockForHuman => TaskState::BlockedForHuman {
            stage: Stage::Adjudicate,
            reason: "needs_owner_decision".into(),
            payload: serde_json::json!({}),
        },
    }
}

/// After the developer finishes, advance to Code Review on success or
/// retry Develop / go Dead on failure.
pub fn next_after_develop(ok: bool, attempt: u8) -> TaskState {
    const MAX: u8 = 3;
    if ok {
        TaskState::Running {
            stage: Stage::CodeReview,
            attempt: 0,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        }
    } else if retry_left(attempt, MAX) {
        TaskState::Running {
            stage: Stage::Develop,
            attempt: attempt + 1,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        }
    } else {
        TaskState::Dead {
            reason: "develop retries exhausted".into(),
        }
    }
}

/// After the reviewer finishes, route based on the verdict.
pub fn next_after_review(verdict: ReviewVerdict, develop_attempt: u8) -> TaskState {
    const MAX: u8 = 3;
    match verdict {
        ReviewVerdict::Approved => TaskState::Running {
            stage: Stage::Verify,
            attempt: 0,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        },
        ReviewVerdict::NeedsChanges => {
            if retry_left(develop_attempt, MAX) {
                TaskState::Running {
                    stage: Stage::Develop,
                    attempt: develop_attempt + 1,
                    started_at: now(),
                    fallback_model: None,
                    last_error: None,
                }
            } else {
                TaskState::BlockedForHuman {
                    stage: Stage::CodeReview,
                    reason: "develop retries exhausted".into(),
                    payload: serde_json::json!({}),
                }
            }
        }
    }
}

/// After the runner finishes, route based on the test exit code.
/// Spec §7.1 + §7.2: exit 0 -> MrSubmit; exit non-zero -> retry Develop
/// (consuming Develop's retry budget); runner crash/timeout -> Dead.
pub fn next_after_verify(prev_develop_attempt: u8, exit_code: i32) -> TaskState {
    const DEVELOP_MAX: u8 = 3;
    if exit_code == 0 {
        TaskState::Running {
            stage: Stage::MrSubmit,
            attempt: 0,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        }
    } else if retry_left(prev_develop_attempt, DEVELOP_MAX) {
        TaskState::Running {
            stage: Stage::Develop,
            attempt: prev_develop_attempt + 1,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        }
    } else {
        TaskState::BlockedForHuman {
            stage: Stage::Verify,
            reason: "verify keeps failing".into(),
            payload: serde_json::json!({}),
        }
    }
}

/// After the MR submit attempt, route based on the HTTP outcome.
pub fn next_after_mr_submit(attempt: u8, outcome: MrSubmitOutcome) -> TaskState {
    const MR_MAX: u8 = 3;
    match outcome {
        MrSubmitOutcome::Ok => TaskState::Done {
            mr_url: String::new(),
            finished_at: now(),
        },
        MrSubmitOutcome::Conflict | MrSubmitOutcome::AuthError => TaskState::BlockedForHuman {
            stage: Stage::MrSubmit,
            reason: "branch diverged or gitlab auth failed".into(),
            payload: serde_json::json!({}),
        },
        MrSubmitOutcome::TransientError if retry_left(attempt, MR_MAX) => TaskState::Running {
            stage: Stage::MrSubmit,
            attempt: attempt + 1,
            started_at: now(),
            fallback_model: None,
            last_error: None,
        },
        MrSubmitOutcome::TransientError => TaskState::BlockedForHuman {
            stage: Stage::MrSubmit,
            reason: "GitLab API persistent failure".into(),
            payload: serde_json::json!({}),
        },
    }
}

/// Restart a task from a given stage. Resets `attempt` to 0 and clears
/// `fallback_model` + `last_error` (the prior chain's state is no longer
/// relevant for the new chain). Used by `x.ai/workbench/replay` (D16).
pub fn next_after_replay(stage: Stage, _old_attempt: u8) -> TaskState {
    TaskState::Running {
        stage,
        attempt: 0,
        started_at: now(),
        fallback_model: None,
        last_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn design_with_open_q() -> DesignDoc {
        DesignDoc::parse(
            "## Goal\nfix\n## Approach\nx\n## Open questions\n- needs_owner_decision: Q1\n",
        )
        .unwrap()
    }
    fn design_without_open_q() -> DesignDoc {
        DesignDoc::parse("## Goal\nfix\n## Approach\nx\n## Open questions\nNone.\n").unwrap()
    }

    #[test]
    fn planner_no_open_q_routes_to_develop() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
            &design_without_open_q(),
            1, // Medium priority
            2,
            AdjudicateMode::Recorder,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));
    }

    #[test]
    fn planner_open_q_urgent_routes_to_adjudicate() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
            &design_with_open_q(),
            3, // Urgent
            2,
            AdjudicateMode::Recorder,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Adjudicate, .. }));
    }

    #[test]
    fn planner_open_q_low_priority_few_acs_skips_adjudicate() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
            &design_with_open_q(),
            0, // Low
            2,
            AdjudicateMode::Recorder,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));
    }

    #[test]
    fn planner_open_q_five_acs_routes_to_adjudicate() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
            &design_with_open_q(),
            0, // Low priority but 5 ACs
            5,
            AdjudicateMode::Recorder,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Adjudicate, .. }));
    }

    #[test]
    fn planner_exhausts_after_three_retries_goes_dead() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 3, started_at: 0, fallback_model: None, last_error: None },
            &design_without_open_q(),
            1,
            2,
            AdjudicateMode::Recorder,
        );
        assert!(matches!(next, TaskState::Dead { .. }));
    }

    #[test]
    fn adjudicate_proceed_goes_to_develop() {
        let next = next_after_adjudicate(AdjudicateVerdict::Proceed);
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));
    }

    #[test]
    fn adjudicate_block_for_human() {
        let next = next_after_adjudicate(AdjudicateVerdict::BlockForHuman);
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn develop_ok_advances_to_review() {
        let next = next_after_develop(true, 0);
        assert!(matches!(next, TaskState::Running { stage: Stage::CodeReview, .. }));
    }

    #[test]
    fn develop_fail_increments_attempt() {
        let next = next_after_develop(false, 1);
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 2, .. }));
    }

    #[test]
    fn develop_fail_exhausts_to_dead() {
        let next = next_after_develop(false, 3);
        assert!(matches!(next, TaskState::Dead { .. }));
    }

    #[test]
    fn review_approved_advances_to_verify() {
        let next = next_after_review(ReviewVerdict::Approved, 0);
        assert!(matches!(next, TaskState::Running { stage: Stage::Verify, .. }));
    }

    #[test]
    fn review_needs_changes_routes_back_to_develop() {
        let next = next_after_review(ReviewVerdict::NeedsChanges, 1);
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 2, .. }));
    }

    #[test]
    fn review_needs_changes_with_exhausted_develop_blocks() {
        let next = next_after_review(ReviewVerdict::NeedsChanges, 3);
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn verify_exit_zero_routes_to_mr_submit() {
        let next = next_after_verify(1, 0);
        assert!(matches!(next, TaskState::Running { stage: Stage::MrSubmit, .. }));
    }

    #[test]
    fn verify_exit_nonzero_routes_back_to_develop() {
        let next = next_after_verify(1, 1);
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 2, .. }));
    }

    #[test]
    fn verify_exhausts_develop_budget_blocks() {
        let next = next_after_verify(3, 1);
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn mr_submit_201_goes_done() {
        let next = next_after_mr_submit(1, MrSubmitOutcome::Ok);
        assert!(matches!(next, TaskState::Done { .. }));
    }

    #[test]
    fn mr_submit_409_blocks_no_retry() {
        let next = next_after_mr_submit(1, MrSubmitOutcome::Conflict);
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn mr_submit_401_blocks_no_retry() {
        let next = next_after_mr_submit(1, MrSubmitOutcome::AuthError);
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn mr_submit_5xx_increments_attempt() {
        let next = next_after_mr_submit(1, MrSubmitOutcome::TransientError);
        assert!(matches!(next, TaskState::Running { stage: Stage::MrSubmit, attempt: 2, .. }));
    }

    #[test]
    fn mr_submit_5xx_after_budget_blocks() {
        let next = next_after_mr_submit(3, MrSubmitOutcome::TransientError);
        assert!(matches!(next, TaskState::BlockedForHuman { .. }));
    }

    #[test]
    fn terminal_states_detected() {
        assert!(TaskState::Done { mr_url: "x".into(), finished_at: 1 }.is_terminal());
        assert!(TaskState::BlockedForHuman { stage: Stage::Adjudicate, reason: "x".into(), payload: serde_json::json!({}) }.is_terminal());
        assert!(TaskState::Dead { reason: "x".into() }.is_terminal());
        assert!(!TaskState::Pending.is_terminal());
        assert!(!TaskState::Running { stage: Stage::Develop, attempt: 0, started_at: 0, fallback_model: None, last_error: None }.is_terminal());
    }

    #[test]
    fn stage_serializes_to_snake_case() {
        assert_eq!(serde_json::to_string(&Stage::CodeReview).unwrap(), "\"code_review\"");
        assert_eq!(serde_json::to_string(&Stage::MrSubmit).unwrap(), "\"mr_submit\"");
    }

    #[test]
    fn design_doc_handles_missing_open_q_section() {
        let doc = DesignDoc::parse("## Goal\nx\n").unwrap();
        assert!(!doc.has_open_questions());
    }

    #[test]
    fn design_doc_detects_single_open_question() {
        let doc = DesignDoc::parse(
            "## Goal\nx\n## Open questions\n- needs_owner_decision: Q1\n",
        )
        .unwrap();
        assert!(doc.has_open_questions());
    }

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
        // v1 state.json uses internally-tagged enum (`#[serde(tag = "kind")]`),
        // so the actual on-disk shape is {"kind":"running",...}, not {"Running":{...}}.
        let v1_json = r#"{"kind":"running","stage":"develop","attempt":0,"started_at":0}"#;
        let s: TaskState = serde_json::from_str(v1_json).unwrap();
        match s {
            TaskState::Running { fallback_model, last_error, .. } => {
                assert!(fallback_model.is_none());
                assert!(last_error.is_none());
            }
            _ => panic!("expected Running"),
        }
    }

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

    #[test]
    fn has_critical_questions_detects_critical_prefix() {
        let doc = DesignDoc::parse(
            "## Open questions\n- critical: needs_owner_decision: Q1\n- non_critical: just FYI\n",
        ).unwrap();
        assert!(doc.has_critical_questions());
    }

    #[test]
    fn has_critical_questions_ignores_non_critical() {
        let doc = DesignDoc::parse(
            "## Open questions\n- non_critical: small thing\n- another small\n",
        ).unwrap();
        assert!(!doc.has_critical_questions());
    }

    #[test]
    fn next_after_planner_gatekeeper_passes_non_critical_questions() {
        // Gatekeeper mode only blocks on `- critical:` questions; non-critical
        // open questions skip Adjudicate even with high priority / many ACs.
        let doc = DesignDoc::parse(
            "## Open questions\n- non_critical: minor thing\n",
        ).unwrap();
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
            &doc,
            3, // Urgent
            10,
            AdjudicateMode::Gatekeeper,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));
    }

    #[test]
    fn next_after_planner_always_skip_goes_straight_to_develop() {
        // AlwaysSkip mode bypasses Adjudicate even with critical questions.
        let doc = DesignDoc::parse(
            "## Open questions\n- critical: needs_owner_decision: Q1\n",
        ).unwrap();
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
            &doc,
            3,
            10,
            AdjudicateMode::AlwaysSkip,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));
    }

    #[test]
    fn next_after_planner_recorder_blocks_on_any_open_question() {
        // Recorder (v1 behavior): blocks on any open question when priority
        // is High OR ac_count >= 5. Here ac_count = 5 triggers it.
        let doc = DesignDoc::parse(
            "## Open questions\n- just a question\n",
        ).unwrap();
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
            &doc,
            1, // Medium priority
            5,
            AdjudicateMode::Recorder,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Adjudicate, .. }));
    }


#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        let s = TaskState::Running { stage: Stage::Develop, attempt: 1, started_at: 1700000000, fallback_model: None, last_error: None };
        save_state(worktree, &s).await.unwrap();
        let loaded = load_state(worktree).await.unwrap().unwrap();
        match loaded {
                TaskState::Pending => {} // resume normalized Running -> Pending
                other => panic!("expected resume to normalize Running, got {:?}", other),
            }
    }

    #[tokio::test]
    async fn resume_preserves_terminal_states() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        let s = TaskState::Done { mr_url: "https://x".into(), finished_at: 1 };
        save_state(worktree, &s).await.unwrap();
        let loaded = load_state(worktree).await.unwrap().unwrap();
        assert!(matches!(loaded, TaskState::Done { .. }));

        let s = TaskState::BlockedForHuman { stage: Stage::Adjudicate, reason: "x".into(), payload: serde_json::json!({}) };
        save_state(worktree, &s).await.unwrap();
        let loaded = load_state(worktree).await.unwrap().unwrap();
        assert!(matches!(loaded, TaskState::BlockedForHuman { .. }));

        let s = TaskState::Dead { reason: "x".into() };
        save_state(worktree, &s).await.unwrap();
        let loaded = load_state(worktree).await.unwrap().unwrap();
        assert!(matches!(loaded, TaskState::Dead { .. }));
    }

    #[tokio::test]
    async fn load_returns_none_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = load_state(dir.path()).await.unwrap();
        assert!(loaded.is_none());
    }
}


}

/// Normalize a TaskState loaded from disk after a backend restart.
/// `Running` becomes `Pending` so the dispatcher re-claims the task and
/// restarts the current stage. Terminal states are kept as-is.
pub fn resume_state(s: TaskState) -> TaskState {
    match s {
        TaskState::Running { .. } => TaskState::Pending,
        other => other,
    }
}

/// Load the persisted TaskState from `<worktree>/.workbench/state.json`.
/// Returns Ok(None) if the file does not exist.
pub async fn load_state(worktree: &std::path::Path) -> anyhow::Result<Option<TaskState>> {
    let p = worktree.join(".workbench").join("state.json");
    if !p.exists() {
        return Ok(None);
    }
    let s = tokio::fs::read_to_string(&p).await?;
    let parsed: TaskState = serde_json::from_str(&s)?;
    Ok(Some(resume_state(parsed)))
}

/// Persist the TaskState to `<worktree>/.workbench/state.json`.
/// Pretty-printed for human inspection during debug.
pub async fn save_state(worktree: &std::path::Path, state: &TaskState) -> anyhow::Result<()> {
    let dir = worktree.join(".workbench");
    tokio::fs::create_dir_all(&dir).await?;
    let p = dir.join("state.json");
    let s = serde_json::to_string_pretty(state)?;
    tokio::fs::write(&p, s).await?;
    Ok(())
}

