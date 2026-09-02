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

/// Parse the adjudicator's verdict from a 1-design.md artifact.
/// Returns `Err` if the frontmatter is missing, lacks `verdict`, or has an
/// unknown verdict string. Used by the state machine to route after the
/// adjudicator stage completes.
pub fn parse_adjudicator_verdict(md: &str) -> anyhow::Result<crate::workbench::state_machine::AdjudicateVerdict> {
    use crate::workbench::artifacts::ArtifactEnvelope;
    let env = ArtifactEnvelope::parse(md)?;
    let verdict = env
        .frontmatter
        .extra
        .get("verdict")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing `verdict` frontmatter key"))?;
    match verdict {
        "proceed" => Ok(crate::workbench::state_machine::AdjudicateVerdict::Proceed),
        "block_for_human" => Ok(crate::workbench::state_machine::AdjudicateVerdict::BlockForHuman),
        other => anyhow::bail!("unknown verdict `{other}`"),
    }
}

#[cfg(test)]
mod adjudicator_parse_tests {
    use super::*;
    use crate::workbench::state_machine::AdjudicateVerdict;

    #[test]
    fn parse_proceed_verdict() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: true\nverdict: proceed\n---\n## Adjudication\n- auto-resolved: X\n";
        let verdict = parse_adjudicator_verdict(md).unwrap();
        assert_eq!(verdict, AdjudicateVerdict::Proceed);
    }

    #[test]
    fn parse_block_verdict() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: true\nverdict: block_for_human\n---\n## Adjudication\n- needs_owner_decision: Q1\n";
        let verdict = parse_adjudicator_verdict(md).unwrap();
        assert_eq!(verdict, AdjudicateVerdict::BlockForHuman);
    }

    #[test]
    fn verdict_parse_fails_when_missing() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nadjudicated: false\n---\nbody";
        assert!(parse_adjudicator_verdict(md).is_err());
    }

    #[test]
    fn verdict_parse_fails_on_unknown_value() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nverdict: maybe\n---\nbody";
        let err = parse_adjudicator_verdict(md).unwrap_err();
        assert!(err.to_string().contains("maybe"));
    }
}

/// Verdict produced by the Coder's `3-develop.md` artifact. Spec §6.3:
/// `verdict: ok | fail`, with `reason` for failures.
#[derive(Debug, PartialEq, Eq)]
pub enum DevelopVerdict {
    Ok,
    Fail(String),
}

pub fn parse_develop_verdict(md: &str) -> anyhow::Result<DevelopVerdict> {
    use crate::workbench::artifacts::ArtifactEnvelope;
    let env = ArtifactEnvelope::parse(md)?;
    let v = env
        .frontmatter
        .extra
        .get("verdict")
        .and_then(|x| x.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing verdict"))?;
    match v {
        "ok" => Ok(DevelopVerdict::Ok),
        "fail" => {
            let reason = env
                .frontmatter
                .extra
                .get("reason")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            Ok(DevelopVerdict::Fail(reason))
        }
        other => anyhow::bail!("unknown verdict `{other}`"),
    }
}

#[cfg(test)]
mod develop_parse_tests {
    use super::*;

    #[test]
    fn parse_develop_ok() {
        let md = "---\nstage: develop\ntask_id: TAPD-1\nattempt: 0\nverdict: ok\n---\nbody";
        assert_eq!(parse_develop_verdict(md).unwrap(), DevelopVerdict::Ok);
    }

    #[test]
    fn parse_develop_fail() {
        let md = "---\nstage: develop\ntask_id: TAPD-1\nattempt: 0\nverdict: fail\nreason: compile error\n---\nbody";
        match parse_develop_verdict(md).unwrap() {
            DevelopVerdict::Fail(r) => assert!(r.contains("compile")),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_develop_fail_without_reason() {
        let md = "---\nstage: develop\ntask_id: TAPD-1\nattempt: 0\nverdict: fail\n---\nbody";
        assert!(matches!(parse_develop_verdict(md).unwrap(), DevelopVerdict::Fail(_)));
    }
}

/// Verdict produced by the Reviewer's `4-review.md` artifact.
/// `Approved` requires zero critical AND fewer than 3 major.
#[derive(Debug, PartialEq, Eq)]
pub enum ReviewVerdict {
    Approved,
    NeedsChanges,
}

pub fn parse_review_verdict(md: &str) -> anyhow::Result<ReviewVerdict> {
    use crate::workbench::artifacts::ArtifactEnvelope;
    let env = ArtifactEnvelope::parse(md)?;
    let v = env
        .frontmatter
        .extra
        .get("verdict")
        .and_then(|x| x.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing verdict"))?;
    let crit = env
        .frontmatter
        .extra
        .get("critical_count")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let major = env
        .frontmatter
        .extra
        .get("major_count")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    match v {
        "approved" if crit == 0 && major < 3 => Ok(ReviewVerdict::Approved),
        "needs_changes" => Ok(ReviewVerdict::NeedsChanges),
        // A reviewer who wrote `approved` but reported critical/major counts
        // above the threshold is treated as `needs_changes` — that's the
        // spec's safety net against inconsistent verdicts.
        "approved" => Ok(ReviewVerdict::NeedsChanges),
        other => anyhow::bail!("unknown verdict `{other}`"),
    }
}

#[cfg(test)]
mod review_parse_tests {
    use super::*;

    #[test]
    fn approved_with_zero_critical() {
        let md = "---\nstage: review\ntask_id: TAPD-1\nattempt: 0\nverdict: approved\ncritical_count: 0\nmajor_count: 1\n---\nbody";
        assert_eq!(parse_review_verdict(md).unwrap(), ReviewVerdict::Approved);
    }

    #[test]
    fn needs_changes_with_one_critical() {
        let md = "---\nstage: review\ntask_id: TAPD-1\nattempt: 0\nverdict: needs_changes\ncritical_count: 1\nmajor_count: 0\n---\nbody";
        assert_eq!(parse_review_verdict(md).unwrap(), ReviewVerdict::NeedsChanges);
    }

    #[test]
    fn needs_changes_with_three_majors() {
        let md = "---\nstage: review\ntask_id: TAPD-1\nattempt: 0\nverdict: approved\ncritical_count: 0\nmajor_count: 3\n---\nbody";
        // approved + 3 majors => safety net flips to NeedsChanges.
        assert_eq!(parse_review_verdict(md).unwrap(), ReviewVerdict::NeedsChanges);
    }

    #[test]
    fn review_verdict_missing_is_error() {
        let md = "---\nstage: review\ntask_id: TAPD-1\nattempt: 0\n---\nbody";
        assert!(parse_review_verdict(md).is_err());
    }
}
