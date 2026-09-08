//! End-to-end test for v2 §9.2.1: GitLab MR comment re-trigger.
//!
//! Verifies the lifecycle:
//!   1. A comment is recorded in `workbench_mr_comments`.
//!   2. `pending_for` returns it; `should_retrigger` is true.
//!   3. `append_to_design_and_consume` writes the "## External comment"
//!      section to `1-design.md` and flips consumed=1.
//!   4. `pending_for` no longer returns it; `consume` is a no-op.
//!
use xai_grok_shell::tapd::store::TapdStore;
use xai_grok_shell::workbench::mr_comments::{
    append_to_design_and_consume, consume, external_comment_section, pending_for, record,
    should_retrigger,
};

fn tmp_store() -> (tempfile::TempDir, TapdStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = TapdStore::new(dir.path().join("wb.sqlite"));
    (dir, store)
}

#[test]
fn comment_lifecycle_record_pending_consume() {
    let (_dir, store) = tmp_store();
    record(&store, "TAPD-1", "https://gl/mr/42", "alice", "please add tests").unwrap();

    let pending = pending_for(&store, "TAPD-1").unwrap();
    assert_eq!(pending.len(), 1);
    let c = &pending[0];
    assert!(should_retrigger(c));
    assert_eq!(c.author, "alice");
    assert_eq!(c.mr_url, "https://gl/mr/42");
}

#[test]
fn external_comment_section_includes_all_metadata() {
    let (_dir, store) = tmp_store();
    record(&store, "TAPD-1", "https://gl/mr/7", "bob", "use snake_case").unwrap();
    let pending = pending_for(&store, "TAPD-1").unwrap();
    let s = external_comment_section(&pending[0]);
    assert!(s.contains("## External comment"));
    assert!(s.contains("**author:** bob"));
    assert!(s.contains("**mr_url:** https://gl/mr/7"));
    assert!(s.contains("use snake_case"));
}

#[test]
fn append_to_design_writes_section_and_consumes() {
    let (dir, store) = tmp_store();
    let design = dir.path().join("1-design.md");
    std::fs::write(&design, "## Goal\nfix\n").unwrap();

    record(&store, "TAPD-1", "https://gl/mr/42", "alice", "please add tests").unwrap();
    let pending = pending_for(&store, "TAPD-1").unwrap();
    assert!(should_retrigger(&pending[0]));

    append_to_design_and_consume(&store, &pending[0], &design).unwrap();

    // The design file has the original Goal + the appended section.
    let body = std::fs::read_to_string(&design).unwrap();
    assert!(body.contains("## Goal"));
    assert!(body.contains("## External comment"));
    assert!(body.contains("**author:** alice"));
    assert!(body.contains("please add tests"));

    // Comment is consumed; pending list is empty.
    assert!(pending_for(&store, "TAPD-1").unwrap().is_empty());

    // Second consume on the same id is a no-op.
    let id = pending[0].id;
    consume(&store, id).unwrap();
}

#[test]
fn append_to_design_creates_file_when_missing() {
    let (dir, store) = tmp_store();
    let design = dir.path().join("1-design.md");
    assert!(!design.exists());

    record(&store, "TAPD-1", "https://gl/mr/1", "alice", "fix").unwrap();
    let pending = pending_for(&store, "TAPD-1").unwrap();
    append_to_design_and_consume(&store, &pending[0], &design).unwrap();

    assert!(design.exists(), "design file should be created on append");
    let body = std::fs::read_to_string(&design).unwrap();
    assert!(body.contains("## External comment"));
}
