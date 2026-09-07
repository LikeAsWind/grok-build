//! Verifies the v2 spec §6.2.1 model fallback policy end-to-end against
//! the in-memory `WorkbenchConfig` + `state_machine` + `recovery` modules.
//! The LLM calls are still stubbed in v2 M1; the test exercises the
//! *policy* (when to use fallback) rather than real network calls.

use xai_grok_shell::agent::config::{WorkbenchConfig, WorkbenchModelsConfig};
use xai_grok_shell::workbench::recovery::{decide_fallback, RoleFallback};
use xai_grok_shell::workbench::state_machine::{next_after_develop, Stage, TaskState};

fn cfg_with_fallbacks() -> WorkbenchConfig {
    let mut cfg = WorkbenchConfig::default();
    cfg.models = WorkbenchModelsConfig {
        planner_model: "opus-4.1".into(),
        planner_fallback: None,
        adjudicator_model: "sonnet-4.5".into(),
        adjudicator_fallback: None,
        coder_model: "opus-4.1".into(),
        coder_fallback: Some("sonnet-4.5".into()),
        reviewer_model: "sonnet-4.5".into(),
        reviewer_fallback: None,
    };
    cfg
}

fn coder_role(cfg: &WorkbenchConfig) -> RoleFallback {
    RoleFallback {
        primary: cfg.models.coder_model.clone(),
        fallback: cfg.models.coder_fallback.clone(),
    }
}

#[test]
fn fallback_decision_after_develop_failure_then_routes_to_develop_again() {
    let cfg = cfg_with_fallbacks();
    // 1st Develop attempt fails. State machine increments attempt to 1.
    let next = next_after_develop(false, 0);
    assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 1, .. }));
    // 2nd Develop attempt also fails (attempt=1 means one prior fail).
    // decide_fallback with attempt=1 + no fallback_used => returns Some.
    let decision = decide_fallback(&coder_role(&cfg), 1, false);
    assert_eq!(decision.as_deref(), Some("sonnet-4.5"));
    // 3rd attempt uses the fallback. If it also fails, state machine
    // routes to Dead (develop retries exhausted at attempt 3).
    let next = next_after_develop(false, 3);
    assert!(matches!(next, TaskState::Dead { .. }));
}

#[test]
fn no_fallback_when_role_has_no_fallback_configured() {
    let mut cfg = WorkbenchConfig::default();
    cfg.models.coder_fallback = None;
    // 1st Develop attempt fails (attempt 1) — no fallback configured,
    // so decide_fallback returns None even though attempt >= 1.
    let decision = decide_fallback(&coder_role(&cfg), 1, false);
    assert!(decision.is_none());
    // State machine still routes to next Develop attempt (or Dead if
    // attempt 3). The orchestrator consults decide_fallback and falls
    // back to v1 behavior (no fallback) when None.
}

