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
    Running { stage: Stage, attempt: u8, started_at: i64 },
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
    let needs_adj = design.has_open_questions() && (priority >= 2 || ac_count >= 5);
    if needs_adj {
        TaskState::Running {
            stage: Stage::Adjudicate,
            attempt: 0,
            started_at: now(),
        }
    } else {
        TaskState::Running {
            stage: Stage::Develop,
            attempt: 0,
            started_at: now(),
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
        }
    } else if retry_left(attempt, MAX) {
        TaskState::Running {
            stage: Stage::Develop,
            attempt: attempt + 1,
            started_at: now(),
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
        },
        ReviewVerdict::NeedsChanges => {
            if retry_left(develop_attempt, MAX) {
                TaskState::Running {
                    stage: Stage::Develop,
                    attempt: develop_attempt + 1,
                    started_at: now(),
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
        }
    } else if retry_left(prev_develop_attempt, DEVELOP_MAX) {
        TaskState::Running {
            stage: Stage::Develop,
            attempt: prev_develop_attempt + 1,
            started_at: now(),
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
        },
        MrSubmitOutcome::TransientError => TaskState::BlockedForHuman {
            stage: Stage::MrSubmit,
            reason: "GitLab API persistent failure".into(),
            payload: serde_json::json!({}),
        },
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
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0 },
            &design_without_open_q(),
            1, // Medium priority
            2,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));
    }

    #[test]
    fn planner_open_q_urgent_routes_to_adjudicate() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0 },
            &design_with_open_q(),
            3, // Urgent
            2,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Adjudicate, .. }));
    }

    #[test]
    fn planner_open_q_low_priority_few_acs_skips_adjudicate() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0 },
            &design_with_open_q(),
            0, // Low
            2,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));
    }

    #[test]
    fn planner_open_q_five_acs_routes_to_adjudicate() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0 },
            &design_with_open_q(),
            0, // Low priority but 5 ACs
            5,
        );
        assert!(matches!(next, TaskState::Running { stage: Stage::Adjudicate, .. }));
    }

    #[test]
    fn planner_exhausts_after_three_retries_goes_dead() {
        let next = next_after_planner(
            TaskState::Running { stage: Stage::Brainstorm, attempt: 3, started_at: 0 },
            &design_without_open_q(),
            1,
            2,
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
        assert!(!TaskState::Running { stage: Stage::Develop, attempt: 0, started_at: 0 }.is_terminal());
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
}
