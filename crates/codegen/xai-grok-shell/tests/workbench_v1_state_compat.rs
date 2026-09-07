//! v1-shaped `state.json` files must still deserialize cleanly under v2.
//! v1 only wrote `{"Running":{"stage":"...","attempt":0,"started_at":0}}`;
//! v2 adds `fallback_model` and `last_error` fields with `#[serde(default)]`.

use xai_grok_shell::workbench::state_machine::{Stage, TaskState};

#[test]
fn v1_state_json_loads_into_v2_running_with_none_fields() {
    let v1 = r#"{"kind":"running","stage":"develop","attempt":2,"started_at":1700000000}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 state.json should still load");
    match s {
        TaskState::Running { stage, attempt, started_at, fallback_model, last_error, .. } => {
            assert_eq!(stage, Stage::Develop);
            assert_eq!(attempt, 2);
            assert_eq!(started_at, 1700000000);
            assert!(fallback_model.is_none());
            assert!(last_error.is_none());
        }
        _ => panic!("expected Running"),
    }
}

#[test]
fn v1_state_json_with_done_loads() {
    let v1 = r#"{"kind":"done","mr_url":"https://x","finished_at":1700001000}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 Done should still load");
    assert!(matches!(s, TaskState::Done { .. }));
}

#[test]
fn v1_state_json_with_blocked_loads() {
    let v1 = r#"{"kind":"blocked_for_human","stage":"adjudicate","reason":"q1","payload":{}}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 BlockedForHuman should still load");
    match s {
        TaskState::BlockedForHuman { stage, .. } => assert_eq!(stage, Stage::Adjudicate),
        _ => panic!("expected BlockedForHuman"),
    }
}

#[test]
fn v1_state_json_with_dead_loads() {
    let v1 = r#"{"kind":"dead","reason":"runner crash"}"#;
    let s: TaskState = serde_json::from_str(v1).expect("v1 Dead should still load");
    assert!(matches!(s, TaskState::Dead { .. }));
}

