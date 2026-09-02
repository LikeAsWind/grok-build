//! Reviewer prompt template and renderer.

pub struct ReviewerInputs {
    pub task_id: String,
    pub diff: String,
    pub design_excerpt: String,
    pub worktree_path: String,
    pub attempt: u8,
}

pub const REVIEWER_PROMPT: &str = include_str!("reviewer.md.tmpl");

pub fn render_reviewer(i: &ReviewerInputs) -> String {
    REVIEWER_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{diff}}", &i.diff)
        .replace("{{design_excerpt}}", &i.design_excerpt)
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{attempt}}", &i.attempt.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_includes_diff_and_design() {
        let i = ReviewerInputs {
            task_id: "TAPD-1".into(),
            diff: "+ new line".into(),
            design_excerpt: "## Goal\nx".into(),
            worktree_path: "/tmp/wt".into(),
            attempt: 0,
        };
        let s = render_reviewer(&i);
        assert!(s.contains("+ new line"));
        assert!(s.contains("## Goal"));
        assert!(s.contains("/tmp/wt"));
    }

    #[test]
    fn render_leaves_unknown_placeholders_visible() {
        let i = ReviewerInputs {
            task_id: "TAPD-1".into(),
            diff: "x".into(),
            design_excerpt: "y".into(),
            worktree_path: "/wt".into(),
            attempt: 0,
        };
        let s = render_reviewer(&i);
        assert!(!s.contains("{{diff}}"));
        assert!(!s.contains("{{task_id}}"));
    }
}
