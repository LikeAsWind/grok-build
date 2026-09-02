//! Coder prompt template and renderer with retry-context injection.

pub struct CoderInputs {
    pub task_id: String,
    pub design_md: String,
    pub previous_review: Option<String>,
    pub previous_verify: Option<String>,
    pub retry_history: Vec<String>,
    pub worktree_path: String,
    pub attempt: u8,
}

pub const CODER_PROMPT: &str = include_str!("coder.md.tmpl");

/// Render the coder prompt. The retry block (history of prior attempts)
/// is only inserted when retry_history is non-empty; on the first attempt
/// the prompt stays focused on the design itself.
pub fn render_coder(i: &CoderInputs) -> String {
    let prev_review = i
        .previous_review
        .clone()
        .unwrap_or_else(|| "(none)".into());
    let prev_verify = i
        .previous_verify
        .clone()
        .unwrap_or_else(|| "(none)".into());
    let retry_history_block = if i.retry_history.is_empty() {
        String::new()
    } else {
        let items = i
            .retry_history
            .iter()
            .map(|r| format!("- {r}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("\n## Retry history\n{items}\n")
    };

    CODER_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{design_md}}", &i.design_md)
        .replace("{{previous_review}}", &prev_review)
        .replace("{{previous_verify}}", &prev_verify)
        .replace("{{retry_block}}", &retry_history_block)
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{attempt}}", &i.attempt.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> CoderInputs {
        CoderInputs {
            task_id: "TAPD-1".into(),
            design_md: "## Goal\nx".into(),
            previous_review: None,
            previous_verify: None,
            retry_history: vec![],
            worktree_path: "/tmp/wt".into(),
            attempt: 0,
        }
    }

    #[test]
    fn first_attempt_omits_retry_block() {
        let p = render_coder(&inputs());
        assert!(p.contains("(none)"));
        assert!(!p.contains("## Retry history"));
        assert!(!p.contains("{{retry_block}}"));
    }

    #[test]
    fn retry_attempt_includes_review_and_verify() {
        let mut i = inputs();
        i.previous_review = Some("- major: foo".into());
        i.previous_verify = Some("exit 1: bar failed".into());
        i.retry_history = vec!["attempt 0: reviewer needs_changes".into()];
        i.attempt = 1;
        let p = render_coder(&i);
        assert!(p.contains("- major: foo"));
        assert!(p.contains("exit 1: bar failed"));
        assert!(p.contains("## Retry history"));
        assert!(p.contains("attempt 0: reviewer needs_changes"));
    }

    #[test]
    fn design_md_is_substituted() {
        let mut i = inputs();
        i.design_md = "## Goal\nfix the login".into();
        let p = render_coder(&i);
        assert!(p.contains("## Goal\nfix the login"));
    }
}
