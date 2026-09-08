//! v2 spec §9.2.1: GitLab MR comment re-trigger bridge.
//!
//! Inbound: a `POST /x.ai/workbench/mr_comment` HTTP endpoint on the local
//! server. The body is `{ tapd_id, author, body, mr_url }`. The handler
//! stores the comment in `workbench_mr_comments` and emits a
//! `x.ai/workbench/mr_comment` notification.
//!
//! Re-trigger: when the comment is `consumed = 0`, the dispatcher checks
//! on each `dispatch_pending` sweep; if so, the Adjudicate stage is
//! re-run with the comment as additional context. The comment body is
//! appended to `1-design.md` under a new `## External comment` section.
//! After Adjudicate re-runs, the comment is marked `consumed = 1`.
//!
//! This module is pure orchestration logic over the existing
//! `tapd::store::{insert_mr_comment, unconsumed_mr_comments,
//! mark_mr_comment_consumed}` DAO. The HTTP handler + dispatcher wiring
//! are out of scope here (deferred to M3.6 / follow-up).

use crate::tapd::store::{MrCommentRow, TapdStore};

/// True iff a comment row is eligible to retrigger Adjudicate.
/// Today any unconsumed comment qualifies; future filters could exclude
/// bot authors or comments on closed MRs.
pub fn should_retrigger(comment: &MrCommentRow) -> bool {
    !comment.consumed
}

/// Build the `## External comment` section appended to `1-design.md`
/// when a comment is picked up for re-trigger.
pub fn external_comment_section(comment: &MrCommentRow) -> String {
    format!(
        "---\n## External comment\n\n- **author:** {}\n- **received_at:** {}\n- **mr_url:** {}\n\n{}\n",
        comment.author, comment.received_at, comment.mr_url, comment.body,
    )
}

/// Pending comments for a task (unconsumed only). Thin wrapper over
/// `TapdStore::unconsumed_mr_comments` for symmetry with the rest of the
//! v2 workbench modules.
pub fn pending_for(store: &TapdStore, tapd_id: &str) -> rusqlite::Result<Vec<MrCommentRow>> {
    store.unconsumed_mr_comments(tapd_id)
}

/// Mark a comment consumed. Returns the number of rows affected (0 if
/// the comment was already consumed, 1 if this call flipped it).
pub fn consume(store: &TapdStore, comment_id: i64) -> rusqlite::Result<usize> {
    store.mark_mr_comment_consumed(comment_id)
}

/// Insert a comment. Thin wrapper for symmetry; the inbound HTTP handler
//! calls this on POST /x.ai/workbench/mr_comment.
pub fn record(store: &TapdStore, tapd_id: &str, mr_url: &str, author: &str, body: &str) -> rusqlite::Result<()> {
    store.insert_mr_comment(tapd_id, mr_url, author, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, consumed: bool) -> MrCommentRow {
        MrCommentRow {
            id,
            tapd_id: "TAPD-1".into(),
            mr_url: format!("https://gl/mr/{id}"),
            author: "alice".into(),
            body: "please address the test gap".into(),
            received_at: 1_700_000_000,
            consumed,
        }
    }

    #[test]
    fn should_retrigger_only_unconsumed() {
        assert!(should_retrigger(&row(1, false)));
        assert!(!should_retrigger(&row(2, true)));
    }

    #[test]
    fn external_comment_section_includes_metadata() {
        let s = external_comment_section(&row(7, false));
        assert!(s.starts_with("---\n## External comment\n"));
        assert!(s.contains("**author:** alice"));
        assert!(s.contains("**mr_url:** https://gl/mr/7"));
        assert!(s.contains("please address the test gap"));
    }

    fn tmp_store() -> (tempfile::TempDir, TapdStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = TapdStore::new(dir.path().join("wb.sqlite"));
        (dir, store)
    }

    #[test]
    fn record_then_pending_then_consume_lifecycle() {
        let (_dir, store) = tmp_store();
        record(&store, "TAPD-1", "https://gl/mr/1", "alice", "comment 1").unwrap();
        record(&store, "TAPD-1", "https://gl/mr/2", "bob", "comment 2").unwrap();

        let pending = pending_for(&store, "TAPD-1").unwrap();
        assert_eq!(pending.len(), 2);
        assert!(pending.iter().all(should_retrigger));

        // Mark the first one consumed; the other stays pending.
        let first_id = pending[0].id;
        let updated = consume(&store, first_id).unwrap();
        assert_eq!(updated, 1, "first call flips 0->1");

        let pending_after = pending_for(&store, "TAPD-1").unwrap();
        assert_eq!(pending_after.len(), 1);

        // Idempotent: a second consume on the same id returns 0.
        let updated_again = consume(&store, first_id).unwrap();
        assert_eq!(updated_again, 0, "second call: already consumed, no flip");
    }

    #[test]
    fn pending_for_unknown_task_returns_empty() {
        let (_dir, store) = tmp_store();
        assert!(pending_for(&store, "TAPD-none").unwrap().is_empty());
    }
}
