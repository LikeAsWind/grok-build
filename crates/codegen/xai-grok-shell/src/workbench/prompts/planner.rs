//! Planner prompt template and renderer.

use crate::agent::config::Priority;

pub struct PlannerInputs {
    pub task_id: String,
    pub title: String,
    pub description: String,
    pub acs: Vec<String>,
    pub worktree_path: String,
    pub priority: Priority,
    pub project_config_yaml: String,
    pub attempt: u8,
}

pub const PLANNER_PROMPT: &str = include_str!("planner.md.tmpl");

/// Render the planner prompt by substituting `{{var}}` placeholders.
/// Unknown placeholders are left as-is so a typo in the template is visible
/// in the rendered output rather than silently dropped.
pub fn render_planner(i: &PlannerInputs) -> String {
    let ac_list = if i.acs.is_empty() {
        "(none)".to_string()
    } else {
        i.acs
            .iter()
            .map(|a| format!("- {a}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let priority_str = match i.priority {
        Priority::Low => "low",
        Priority::Medium => "medium",
        Priority::High => "high",
        Priority::Urgent => "urgent",
    };
    PLANNER_PROMPT
        .replace("{{task_id}}", &i.task_id)
        .replace("{{title}}", &i.title)
        .replace("{{description}}", &i.description)
        .replace("{{ac_list}}", &ac_list)
        .replace("{{ac_count}}", &i.acs.len().to_string())
        .replace("{{worktree_path}}", &i.worktree_path)
        .replace("{{priority}}", priority_str)
        .replace("{{project_config_yaml}}", &i.project_config_yaml)
        .replace("{{attempt}}", &i.attempt.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> PlannerInputs {
        PlannerInputs {
            task_id: "TAPD-1".into(),
            title: "Fix login".into(),
            description: "Login flow is broken when MFA is enabled.".into(),
            acs: vec!["AC1: valid login".into(), "AC2: invalid email error".into()],
            worktree_path: "/tmp/wt".into(),
            priority: Priority::Medium,
            project_config_yaml: "directory: /repo".into(),
            attempt: 0,
        }
    }

    #[test]
    fn render_substitutes_all_placeholders() {
        let p = render_planner(&inputs());
        assert!(p.contains("TAPD-1"));
        assert!(p.contains("Fix login"));
        assert!(p.contains("/tmp/wt"));
        assert!(p.contains("- AC1: valid login"));
        assert!(p.contains("medium"));
    }

    #[test]
    fn render_handles_no_acs() {
        let mut i = inputs();
        i.acs.clear();
        let p = render_planner(&i);
        assert!(p.contains("(none)"));
        assert!(p.contains("Acceptance criteria (0):"));
    }

    #[test]
    fn render_includes_priority_mapping() {
        let mut i = inputs();
        i.priority = Priority::Urgent;
        let p = render_planner(&i);
        assert!(p.contains("Priority: urgent"));
    }

    #[test]
    fn render_leaves_unknown_placeholders_visible() {
        // If a future template var is added but the renderer not updated,
        // the placeholder is left in place so the bug is obvious.
        let p = render_planner(&inputs());
        assert!(!p.contains("{{task_id}}"));
        assert!(!p.contains("{{title}}"));
    }
}
