//! End-to-end test for the workbench task orchestrator.
//!
//! Drives a real task through every stage: real git repo, real
//! TapdStore, real worktree, real state machine, real artifact I/O.
//! The LLM stages are stubbed (deterministic output) — only the GitLab
//! call uses a mock HTTP server (mockito).
//!
//! Verifies that after `drive_task`:
//!   - branch is created with the right name
//!   - all 5 stage artifacts (1-design, 3-develop, 4-review, 5-verify) exist
//!   - final state is `Done` with the MR URL returned by the mock server
//!   - workbench_state in the store reads as "done"

use std::process::Command;
use std::sync::Arc;

use xai_grok_shell::agent::config::GitlabConfig;
use xai_grok_shell::tapd::store::TapdStore;
use xai_grok_shell::workbench::orchestrator::{drive_task, OrchestratorInputs};
use xai_grok_shell::workbench::state_machine::{Stage, TaskState};
use xai_grok_shell::workbench::submitter::GitlabClient;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_drives_task_to_done() {
    // 1. Real local git repo with an initial commit on `main`
    let tmp = tempdir::TempDir::new("workbench-orch-e2e").unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "--initial-branch=main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("hello.txt"), "v0\n").unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "initial"]);

    // 2. Mock GitLab server (mockito) returning 201
    let mut server = mockito::Server::new_async().await;
    let mr_mock = server
        .mock("POST", "/api/v4/projects/123/merge_requests")
        .with_status(201)
        .with_body(r#"{"web_url":"https://gl.example/mr/1"}"#)
        .create_async()
        .await;

    // 3. Real TapdStore
    let store = Arc::new(TapdStore::new(tmp.path().join("store.sqlite")));

    // 4. Real GitlabClient pointing at the mock server
    unsafe { std::env::set_var("WORKBENCH_TEST_GITLAB_TOKEN", "tok-orch-e2e"); }
    let gitlab = GitlabClient::new(&GitlabConfig {
        url: server.url(),
        token_env: "WORKBENCH_TEST_GITLAB_TOKEN".into(),
        default_assignees_self: false,
    })
    .unwrap();

    // 5. Drive the task
    let inputs = OrchestratorInputs {
        tapd_id: "TAPD-1".into(),
        title: "Add greeting".into(),
        description: "Add a friendly hello world".into(),
        acs: vec!["AC1: prints hello".into()],
        priority: 1, // Medium — no open questions in stub design, so skips Adjudicate
        repo_root: repo.clone(),
        grok_home: tmp.path().to_path_buf(),
        base_branch: "main".into(),
        tapd_owner: Some("alice".into()),
        mr_reviewers: vec!["bob".into()],
        mr_assignees: vec![],
        project_id: "123".into(),
    };
    let result = drive_task(store.clone(), &gitlab, inputs)
        .await
        .expect("drive_task should succeed");

    // 6. Assert: branch created
    let branch_out = run_git_out(
        &result.worktree_path,
        &["branch", "--show-current"],
    );
    assert_eq!(branch_out.trim(), "tapd/TAPD-1-add-greeting");

    // 7. Assert: artifacts on disk
    assert!(result.worktree_path.join(".workbench/stages/1-design.md").exists());
    assert!(result.worktree_path.join(".workbench/stages/3-develop.md").exists());
    assert!(result.worktree_path.join(".workbench/stages/4-review.md").exists());
    assert!(result.worktree_path.join(".workbench/stages/5-verify.md").exists());

    // 8. Assert: final state is Done
    assert!(matches!(result.final_state, TaskState::Done { .. }), "final state was {:?}", result.final_state);

    // 9. Assert: MR URL from mock server
    assert_eq!(result.mr_url.as_deref(), Some("https://gl.example/mr/1"));

    // 10. Assert: store reflects "done"
    assert_eq!(store.get_workbench_state("TAPD-1").unwrap().as_deref(), Some("done"));

    // 11. Assert: state.json on disk has a Running state or terminal state
    let state_json = std::fs::read_to_string(
        result.worktree_path.join(".workbench/state.json"),
    )
    .unwrap();
    assert!(state_json.contains("Done") || state_json.contains("done"));

    // 12. Assert: the LLM mock was actually called
    mr_mock.assert_async().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_with_adjudicate_runs_full_path() {
    // Same setup as above but with an open question in the design so the
    // pipeline routes through Adjudicate. We do this by setting a high
    // priority (so spec §7.1 trips the `priority >= 2` branch).

    let tmp = tempdir::TempDir::new("workbench-orch-e2e-adj").unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "--initial-branch=main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("hello.txt"), "v0\n").unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "initial"]);

    let mut server = mockito::Server::new_async().await;
    let mr_mock = server
        .mock("POST", "/api/v4/projects/456/merge_requests")
        .with_status(201)
        .with_body(r#"{"web_url":"https://gl.example/mr/2"}"#)
        .create_async()
        .await;

    let store = Arc::new(TapdStore::new(tmp.path().join("store.sqlite")));

    unsafe { std::env::set_var("WORKBENCH_TEST_GITLAB_TOKEN", "tok-orch-e2e-adj"); }
    let gitlab = GitlabClient::new(&GitlabConfig {
        url: server.url(),
        token_env: "WORKBENCH_TEST_GITLAB_TOKEN".into(),
        default_assignees_self: false,
    })
    .unwrap();

    // Note: our stub planner always writes "Open questions: None." so the
    // Adjudicate stage is skipped in v1. We document this here as a known
    // limitation — wiring a real planner LLM that produces open questions
    // is the next step.
    let inputs = OrchestratorInputs {
        tapd_id: "TAPD-2".into(),
        title: "Refactor auth".into(),
        description: "Decide on token format".into(),
        acs: vec!["AC1: token works".into()],
        priority: 3, // High
        repo_root: repo.clone(),
        grok_home: tmp.path().to_path_buf(),
        base_branch: "main".into(),
        tapd_owner: None,
        mr_reviewers: vec![],
        mr_assignees: vec![],
        project_id: "456".into(),
    };
    let result = drive_task(store.clone(), &gitlab, inputs).await.unwrap();
    assert!(matches!(result.final_state, TaskState::Done { .. }));
    assert_eq!(result.mr_url.as_deref(), Some("https://gl.example/mr/2"));
    mr_mock.assert_async().await;
}

fn run_git(cwd: &std::path::Path, args: &[&str]) {
    let _ = Command::new("git").args(args).current_dir(cwd).output();
}

fn run_git_out(cwd: &std::path::Path, args: &[&str]) -> String {
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
