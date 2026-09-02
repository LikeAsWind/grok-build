//! Main session actor: state machine driver + child session event forwarder.
//!
//! The main session is the per-task session spawned by `WorkbenchDispatcher`
//! when a slot opens. It owns the `TaskState`, drives stage transitions by
//! calling the pure functions in `state_machine`, spawns child sessions for
//! LLM stages, and forwards their output to the parent session stream.
//!
//! For v1 most of this is a coordination layer; the actual LLM sessions are
//! spawned via existing `run_shell_child`. The piece implemented here is the
//! artifact validation + child-session prompt construction, which can be
//! unit-tested without a live LLM.

use std::path::Path;

use crate::agent::config::Priority;
use crate::workbench::artifacts::{ArtifactEnvelope as Env};
use crate::workbench::prompts::{PlannerInputs, render_planner};

/// Required sections in the planner's design.md artifact.
/// Per spec §6.1, the body must include all six.
const REQUIRED_SECTIONS: &[&str] = &[
    "## Goal",
    "## Approach",
    "## Files to modify",
    "## Edge cases",
    "## Out of scope",
    "## Open questions",
];

/// Validate that the planner wrote a well-formed `1-design.md`. Returns the
/// parsed envelope on success; returns Err with a list of missing sections
/// (and a one-line reason) on failure.
pub async fn validate_design_md(path: &Path) -> anyhow::Result<Env> {
    let raw = tokio::fs::read_to_string(path).await?;
    let env = Env::parse(&raw)?;
    for required in REQUIRED_SECTIONS {
        if !env.body.contains(required) {
            anyhow::bail!("design.md missing required section `{required}`");
        }
    }
    Ok(env)
}

/// Build the planner child session prompt + inputs. The actual session spawn
/// is performed by `run_shell_child` in the agent runtime; this function just
/// shapes the inputs.
pub fn build_planner_inputs(
    tapd_id: &str,
    title: &str,
    description: &str,
    acs: Vec<String>,
    worktree_path: &str,
    priority: Priority,
    project_yaml: &str,
    attempt: u8,
) -> String {
    render_planner(&PlannerInputs {
        task_id: tapd_id.into(),
        title: title.into(),
        description: description.into(),
        acs,
        worktree_path: worktree_path.into(),
        priority,
        project_config_yaml: project_yaml.into(),
        attempt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn planner_artifacts_validates_all_sections() {
        let tmp = tempfile::tempdir().unwrap();
        let stages = tmp.path().join(".workbench/stages");
        tokio::fs::create_dir_all(&stages).await.unwrap();
        let body = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: false\n---\n## Goal\nx\n## Approach\ny\n## Files to modify\n- a\n## Edge cases\n- b\n## Out of scope\n- c\n## Open questions\nNone.\n";
        tokio::fs::write(stages.join("1-design.md"), body).await.unwrap();

        let valid = validate_design_md(&stages.join("1-design.md")).await.unwrap();
        assert_eq!(valid.frontmatter.task_id, "TAPD-1");
        assert!(valid.body.contains("## Approach"));
    }

    #[tokio::test]
    async fn planner_artifact_rejects_missing_section() {
        let tmp = tempfile::tempdir().unwrap();
        let stages = tmp.path().join(".workbench/stages");
        tokio::fs::create_dir_all(&stages).await.unwrap();
        let body = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\n---\n## Goal\nx\n";
        tokio::fs::write(stages.join("1-design.md"), body).await.unwrap();
        let err = validate_design_md(&stages.join("1-design.md")).await.unwrap_err();
        let msg = err.to_string();
        // At least one of the required sections should be named in the error.
        assert!(
            REQUIRED_SECTIONS.iter().any(|s| msg.contains(s)),
            "error should mention a missing required section: {msg}"
        );
    }

    #[test]
    fn build_planner_inputs_substitutes() {
        let prompt = build_planner_inputs(
            "TAPD-1",
            "Fix login",
            "broken",
            vec!["AC1".into()],
            "/tmp/wt",
            Priority::Medium,
            "directory: /repo",
            0,
        );
        assert!(prompt.contains("TAPD-1"));
        assert!(prompt.contains("/tmp/wt"));
    }
}
