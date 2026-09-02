//! Adjudicator prompt template and renderer.

pub struct AdjudicatorInputs {
    pub task_id: String,
    pub design_excerpt: String,
    pub worktree_path: String,
    pub attempt: u8,
}

pub const ADJUDICATOR_PROMPT: &str = include_str!("adjudicator.md.tmpl");

pub fn render_adjudicator(i: &AdjudicatorInputs) -> String {
    ADJUDICATOR_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{design_excerpt}}", &i.design_excerpt)
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{attempt}}", &i.attempt.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_includes_inputs() {
        let i = AdjudicatorInputs {
            task_id: "TAPD-1".into(),
            design_excerpt: "## Open questions\n- foo".into(),
            worktree_path: "/tmp/wt".into(),
            attempt: 0,
        };
        let s = render_adjudicator(&i);
        assert!(s.contains("TAPD-1"));
        assert!(s.contains("/tmp/wt"));
        assert!(s.contains("## Open questions"));
    }

    #[test]
    fn render_leaves_unknown_placeholders_visible() {
        let i = AdjudicatorInputs {
            task_id: "TAPD-1".into(),
            design_excerpt: "x".into(),
            worktree_path: "/wt".into(),
            attempt: 0,
        };
        let s = render_adjudicator(&i);
        assert!(!s.contains("{{task_id}}"));
    }
}
