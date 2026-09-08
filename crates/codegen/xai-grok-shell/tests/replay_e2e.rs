//! End-to-end test for v2 §9.2.3: replay re-runs a task from a chosen stage,
//! resetting `attempt` to 0. Verifies the state-machine contract directly
//! because the orchestrator-level replay pipeline is the same `next_after_replay`
//! already covered by state_machine unit tests + this round-trip.
//!
use xai_grok_shell::workbench::state_machine::{Stage, TaskState, next_after_replay};

#[test]
fn replay_resets_attempt_to_0() {
    // Pre-condition: any state where the user can request replay.
    let prior = TaskState::Running {
        stage: Stage::Develop,
        attempt: 5,
        started_at: 0,
        fallback_model: Some("gpt-5".into()),
        last_error: Some("previous fail".into()),
    };
    // discard prior; we only care about the next state.
    let _ = prior;

    // Replay from Develop: attempt resets, fallback + error cleared.
    let next = next_after_replay(Stage::Develop, 5);
    match next {
        TaskState::Running { stage, attempt, fallback_model, last_error, .. } => {
            assert_eq!(stage, Stage::Develop, "replay_from = Develop");
            assert_eq!(attempt, 0, "attempt resets regardless of old attempt");
            assert!(fallback_model.is_none(), "fallback_model cleared");
            assert!(last_error.is_none(), "last_error cleared");
        }
        _ => panic!("expected Running, got {:?}", next),
    }
}

#[test]
fn replay_supports_every_stage() {
    for &stage in &[Stage::Brainstorm, Stage::Adjudicate, Stage::Develop, Stage::CodeReview, Stage::Verify, Stage::MrSubmit] {
        let next = next_after_replay(stage, 3);
        match next {
            TaskState::Running { stage: got, attempt, .. } => {
                assert_eq!(got, stage, "replay_from stage echoed");
                assert_eq!(attempt, 0);
            }
            _ => panic!("expected Running, got {:?}", next),
        }
    }
}

#[test]
fn replay_state_distinguishable_from_initial_pending() {
    // v1 spec: replay moves to Running (not Pending). The dispatcher can
    // then dispatch this task immediately.
    let next = next_after_replay(Stage::Develop, 0);
    assert!(matches!(next, TaskState::Running { .. }), "expected Running, got {:?}", next);
    assert!(!matches!(next, TaskState::Pending), "should not be Pending");
}
