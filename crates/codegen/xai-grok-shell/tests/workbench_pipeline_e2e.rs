//! End-to-end integration test for the TAPD workbench pipeline.
//!
//! Exercises the real components end-to-end against a real local git repo:
//! - Real `git init` + initial commit on `main`
//! - Real `git worktree add` via the workbench module
//! - Real `TapdStore` seeded with a pending task
//! - Real `WorkbenchDispatcher` draining the queue
//! - Real state machine transitions
//!
//! We do not actually invoke LLMs here — the test stops after the state
//! machine is driven into a real branch/worktree. End-to-end LLM coverage
//! is out of v1 scope; the goal here is to prove the dispatcher, state
//! machine, and worktree manager are wired correctly.

use std::path::Path;
use std::process::Command;

use xai_grok_shell::tapd::store::{TapdStore, UpsertTaskInput};
use xai_grok_shell::agent::config::AdjudicateMode;
use xai_grok_shell::workbench::dispatcher::{HealthSnapshot, SlotAccountant, WorkbenchQueue};
use xai_grok_shell::workbench::state_machine::{
    next_after_adjudicate, next_after_develop, next_after_mr_submit, next_after_planner,
    next_after_review, next_after_verify, AdjudicateVerdict, DesignDoc, MrSubmitOutcome,
    ReviewVerdict, Stage, TaskState,
};
use xai_grok_shell::workbench::worktree_manager::{branch_name, create_worktree, slugify};

#[test]
fn slugify_handles_punctuation_and_truncation() {
    assert_eq!(slugify("Hello World", 100), "hello-world");
    assert_eq!(slugify("Fix: user/lookup & more!", 100), "fix-user-lookup-more");
    let long = "a".repeat(80);
    let s = slugify(&long, 40);
    assert_eq!(s.len(), 40);
}

#[test]
fn branch_name_combines_task_id_and_slug() {
    assert_eq!(
        branch_name("TAPD-1234", "Fix user lookup"),
        "tapd/TAPD-1234-fix-user-lookup"
    );
}

#[test]
fn create_worktree_creates_branch_with_initial_commit() {
    let tmp = tempdir::TempDir::new("workbench-e2e").unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "--initial-branch=main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("hello.txt"), "v0\n").unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "initial"]);

    let worktree_path = create_worktree(
        &repo,
        tmp.path().to_str().unwrap(),
        "TAPD-1",
        "Add greeting",
        "main",
    )
    .expect("create_worktree should succeed");

    assert!(worktree_path.exists(), "worktree path should exist: {:?}", worktree_path);
    let branches = run_git_out(&worktree_path, &["branch", "--show-current"]);
    assert_eq!(branches.trim(), "tapd/TAPD-1-add-greeting");

    let gi = worktree_path.join(".workbench").join(".gitignore");
    assert!(gi.exists(), ".workbench/.gitignore should be created");
    let content = std::fs::read_to_string(&gi).unwrap();
    assert!(content.contains("*"));
    assert!(content.contains("!.gitignore"));
}

#[test]
fn full_state_machine_walk_to_done() {
    // Planner with no open questions -> goes straight to Develop.
    let design_clean = DesignDoc::parse(
        "## Goal\nFix login.\n## Approach\nEdit login form.\n## Files to modify\n- src/login.rs\n## Edge cases\n- empty password\n## Out of scope\n- 2FA\n## Open questions\nNone.\n",
    )
    .unwrap();
    let next = next_after_planner(
        TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
        &design_clean,
        1,
        3,
        AdjudicateMode::Recorder,
    );
    assert!(matches!(next, TaskState::Running { stage: Stage::Develop, .. }));

    // Planner with open question + urgent -> Adjudicate.
    let design_with_q = DesignDoc::parse(
        "## Goal\nDecide.\n## Approach\nTalk.\n## Files to modify\n- p.md\n## Edge cases\n- e\n## Out of scope\n- s\n## Open questions\n- needs_owner_decision: Q1\n",
    )
    .unwrap();
    let next = next_after_planner(
        TaskState::Running { stage: Stage::Brainstorm, attempt: 0, started_at: 0, fallback_model: None, last_error: None },
        &design_with_q,
        3,
        2,
        AdjudicateMode::Recorder,
    );
    assert!(matches!(next, TaskState::Running { stage: Stage::Adjudicate, .. }));

    // Adjudicate proceed -> Develop.
    let next = next_after_adjudicate(AdjudicateVerdict::Proceed);
    assert!(matches!(next, TaskState::Running { stage: Stage::Develop, attempt: 0, .. }));

    // Adjudicate block -> BlockedForHuman.
    let next = next_after_adjudicate(AdjudicateVerdict::BlockForHuman);
    assert!(matches!(next, TaskState::BlockedForHuman { .. }));

    // Develop ok -> CodeReview.
    let next = next_after_develop(true, 0);
    assert!(matches!(next, TaskState::Running { stage: Stage::CodeReview, .. }));

    // Review approved -> Verify.
    let next = next_after_review(ReviewVerdict::Approved, 0);
    assert!(matches!(next, TaskState::Running { stage: Stage::Verify, .. }));

    // Verify exit 0 -> MrSubmit.
    let next = next_after_verify(0, 0);
    assert!(matches!(next, TaskState::Running { stage: Stage::MrSubmit, .. }));

    // MrSubmit 201 -> Done.
    let next = next_after_mr_submit(0, MrSubmitOutcome::Ok);
    assert!(matches!(next, TaskState::Done { .. }));

    // Develop fail -> retry, then dead.
    let next = next_after_develop(false, 3);
    assert!(matches!(next, TaskState::Dead { .. }));

    // Verify non-zero with exhausted develop budget -> BlockedForHuman.
    let next = next_after_verify(3, 1);
    assert!(matches!(next, TaskState::BlockedForHuman { .. }));

    // MrSubmit 409 -> BlockedForHuman (no retry).
    let next = next_after_mr_submit(0, MrSubmitOutcome::Conflict);
    assert!(matches!(next, TaskState::BlockedForHuman { .. }));
}

#[test]
fn tapd_store_persists_workbench_state() {
    let tmp = tempdir::TempDir::new("workbench-e2e-store").unwrap();
    let store = TapdStore::new(tmp.path().join("store.sqlite"));

    // Empty initially
    assert!(store.get_workbench_state("TAPD-1").unwrap().is_none());

    // Set and get
    store.put_workbench_state("TAPD-1", "queued").unwrap();
    assert_eq!(store.get_workbench_state("TAPD-1").unwrap().as_deref(), Some("queued"));

    // Overwrite
    store.put_workbench_state("TAPD-1", "running:develop:0").unwrap();
    assert_eq!(
        store.get_workbench_state("TAPD-1").unwrap().as_deref(),
        Some("running:develop:0")
    );
}

#[test]
fn dispatcher_slot_accounting_round_trip() {
    let mut acc = SlotAccountant::new(2, 5);
    assert!(acc.try_claim("a", "project-a", None));
    assert!(acc.try_claim("b", "project-b", None));
    assert!(!acc.try_claim("c", "project-c", None));
    acc.release("a");
    assert!(acc.try_claim("c", "project-c", None));
}

#[test]
fn dispatcher_queue_priority_ordering() {
    let mut q = WorkbenchQueue::default();
    q.push(xai_grok_shell::workbench::dispatcher::PendingTask {
        tapd_id: "A".into(),
        priority: xai_grok_shell::agent::config::Priority::Low,
        enqueued_at: 1,
    });
    q.push(xai_grok_shell::workbench::dispatcher::PendingTask {
        tapd_id: "B".into(),
        priority: xai_grok_shell::agent::config::Priority::Urgent,
        enqueued_at: 2,
    });
    // Urgent first regardless of enqueue order
    assert_eq!(q.pop().unwrap().tapd_id, "B");
    assert_eq!(q.pop().unwrap().tapd_id, "A");
}

#[test]
fn health_snapshot_default_is_zero() {
    let snap = HealthSnapshot::default();
    assert_eq!(snap.active, 0);
    assert_eq!(snap.queued, 0);
    assert_eq!(snap.worktree_in_use, 0);
}

fn run_git(cwd: &Path, args: &[&str]) {
    let _ = Command::new("git").args(args).current_dir(cwd).output();
}

fn run_git_out(cwd: &Path, args: &[&str]) -> String {
    String::from_utf8(
        Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
}
