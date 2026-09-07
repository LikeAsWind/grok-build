//! End-to-end test for v2 §8.2.1 cross-project concurrency in WorkbenchDispatcher.
//!
//! Verifies the SlotAccountant layer can hold 5 tasks from 3 different
//! projects concurrently without global or per-project caps blocking any of
//! them — the new v2 default. This is the dispatcher-level proof that the
//! plan claim ("all 5 tasks from 3 projects... all dispatched, all run")
//! holds once SlotAccountant is wired into the dispatch loop.
//!
//! We exercise the SlotAccountant directly (the dispatcher dispatch loop is
//! already covered by workbench_pipeline_e2e + workbench_orchestrator_e2e;
//! the new question for v2 is whether the per-project accounting lets all
//! 5 tasks claim slots when none of the per-project caps is exceeded).

use xai_grok_shell::workbench::dispatcher::SlotAccountant;

#[test]
fn dispatcher_concurrency_e2e_five_tasks_three_projects_all_claim() {
    // v2 spec §8.2.1: global_max_active=5 + 3 projects. With no per-project
    // caps configured, all 5 slots should be claimable.
    let mut acc = SlotAccountant::new(5, 10);
    let projects = ["proj-a", "proj-b", "proj-c"];
    let tapd_ids = ["TAPD-1", "TAPD-2", "TAPD-3", "TAPD-4", "TAPD-5"];
    for (i, tapd_id) in tapd_ids.iter().enumerate() {
        let project = projects[i % projects.len()];
        assert!(
            acc.try_claim(tapd_id, project, None),
            "task {tapd_id} ({project}) must claim a slot"
        );
    }
    // After all 5 claims: project_counts should reflect the distribution.
    assert_eq!(acc.active_count(), 5);
    assert_eq!(acc.worktree_in_use(), 5);
}

#[test]
fn dispatcher_concurrency_e2e_per_project_cap_blocks_only_that_project() {
    // proj-a cap = 1, proj-b cap = 5, proj-c no cap. 5 tasks distributed
    // (2 to proj-a, 2 to proj-b, 1 to proj-c). proj-a rejects its second; the
    // others continue.
    let mut acc = SlotAccountant::new(10, 10);
    let plan = [
        ("TAPD-1", "proj-a", Some(1)),
        ("TAPD-2", "proj-b", Some(5)),
        ("TAPD-3", "proj-c", None),
        ("TAPD-4", "proj-b", Some(5)),
        ("TAPD-5", "proj-a", Some(1)), // rejected: proj-a cap hit
    ];
    let mut accepted = 0;
    let mut rejected = 0;
    for (tapd_id, project, cap) in plan.iter() {
        if acc.try_claim(tapd_id, project, *cap) {
            accepted += 1;
        } else {
            rejected += 1;
        }
    }
    assert_eq!(accepted, 4, "4 of 5 should claim (proj-a 2nd rejected)");
    assert_eq!(rejected, 1, "exactly TAPD-5 (proj-a) must be rejected");
    assert_eq!(acc.active_count(), 4);
    assert_eq!(acc.worktree_in_use(), 4);
}

#[test]
fn dispatcher_concurrency_e2e_release_frees_slot_for_same_project() {
    // Two proj-a tasks start; one finishes and releases; a third proj-a
    // task can then claim the freed slot.
    let mut acc = SlotAccountant::new(10, 10);
    assert!(acc.try_claim("TAPD-1", "proj-a", Some(2)));
    assert!(acc.try_claim("TAPD-2", "proj-a", Some(2)));
    assert!(!acc.try_claim("TAPD-3", "proj-a", Some(2)), "cap=2 already hit");
    acc.release("TAPD-1");
    assert!(acc.try_claim("TAPD-3", "proj-a", Some(2)), "freed slot must be reusable");
    assert_eq!(acc.active_count(), 2);
}

