//! Trait abstraction over the LLM stages that V2.5 makes real
//! (coder + reviewer). Production wires `MvpAgentLlmStage` (real ACP);
//! tests wire `FakeLlmStage` (see `test_helpers`).

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DevelopVerdict {
    Approved,
    NeedsChanges,
}

#[derive(Clone, Debug)]
pub struct CodeInputs {
    pub task_id: String,
    pub title: String,
    pub description: String,
    pub acs: Vec<String>,
    pub worktree_path: PathBuf,
    pub project_config_yaml: String,
    pub prior_artifacts: Vec<PriorArtifact>,
    pub attempt: u8,
    pub primary_model: String,
    pub fallback_model: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PriorArtifact {
    pub stage: String,    // "design" | "adjudicate" | "review" | "verify"
    pub attempt: u8,
    pub body: String,
}

#[derive(Clone, Debug)]
pub struct CodeOutputs {
    pub artifact_body: String,        // body of 3-develop.md (frontmatter added by orchestrator)
    pub verdict: DevelopVerdict,
    pub model: String,
    pub fallback_used: bool,
    pub child_session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewVerdict {
    Approved,
    NeedsChanges,
}

#[derive(Clone, Debug)]
pub struct ReviewInputs {
    pub task_id: String,
    pub worktree_path: PathBuf,
    pub design_excerpt: String,
    pub diff: String,
    pub prior_review: Option<String>,
    pub prior_verify: Option<String>,
    pub attempt: u8,
    pub primary_model: String,
    pub fallback_model: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ReviewOutputs {
    pub artifact_body: String,
    pub verdict: ReviewVerdict,
    pub model: String,
    pub fallback_used: bool,
    pub child_session_id: Option<String>,
}

/// Trait abstraction over the two LLM stages V2.5 replaces.
/// Uses explicit `Pin<Box<…>>` instead of `async_trait` to avoid adding
/// a new top-level dependency (spec §4 soft constraint).
// Note: no `Send + Sync` bound. `MvpAgent` is !Send (contains RefCell + Rc);
// the orchestrator drives this through spawn_blocking + current-thread runtime,
// so the trait object lives on one thread. This matches the existing MvpAgent
// single-threaded architecture and the hard constraint that drive_task public
// signature stays unchanged (Task 3.1).
pub trait LlmStage {
    fn code<'a>(&'a self, input: &'a CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + 'a>
    >;
    fn review<'a>(&'a self, input: &'a ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + 'a>
    >;
}

pub type DynLlmStage = Arc<dyn LlmStage>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trait_object_compiles() {
        // Compile-only: ensure the trait + types can be referenced as DynLlmStage.
        fn _accepts_dyn(_l: DynLlmStage) {}
    }

    #[test]
    fn parse_reviewer_verdict_approves_lgtm() {
        assert_eq!(
            parse_reviewer_verdict("## Findings\n(none)\n## Summary\nLGTM.\n"),
            ReviewVerdict::Approved,
        );
        assert_eq!(
            parse_reviewer_verdict("## Findings\n- major: foo"),
            ReviewVerdict::NeedsChanges,
        );
    }

    #[test]
    fn parse_coder_verdict_approves_self_checked() {
        assert_eq!(
            parse_coder_verdict("## Changes\n- x\n## Self-check\n- [x] compiles\n"),
            DevelopVerdict::Approved,
        );
    }
}


use crate::agent::mvp_agent::MvpAgent;
use crate::workbench::prompts::{render_coder, render_reviewer, CoderInputs, ReviewerInputs};

/// Real implementation of `LlmStage`. Opens an ACP child session per call,
/// streams the prompt, captures the full text, parses it into the
/// appropriate outputs struct.
///
/// **V2.5 STUB**: `MvpAgent::create_stage_session` is itself a stub that
/// returns canned output (see session_lifecycle.rs and the V2.5 plan). The
/// real ACP integration is deferred to V2.6. This struct faithfully wires
/// the trait through to that stub; once V2.6 wires the stub to a real
/// subagent invocation, MvpAgentLlmStage starts producing real diffs.
pub struct MvpAgentLlmStage {
    pub agent: Arc<MvpAgent>,
}

impl LlmStage for MvpAgentLlmStage {
    fn code<'a>(&'a self, input: &'a CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + 'a>
    > {
        let agent = self.agent.clone();
        let input = input.clone();
        Box::pin(async move {
            let prompt = build_coder_prompt(&input);
            let (session_id, text) = agent.create_stage_session(&prompt).await?;
            let verdict = parse_coder_verdict(&text);
            Ok(CodeOutputs {
                artifact_body: text,
                verdict,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: Some(session_id),
            })
        })
    }

    fn review<'a>(&'a self, input: &'a ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + 'a>
    > {
        let agent = self.agent.clone();
        let input = input.clone();
        Box::pin(async move {
            let prompt = build_reviewer_prompt(&input);
            let (session_id, text) = agent.create_stage_session(&prompt).await?;
            let verdict = parse_reviewer_verdict(&text);
            Ok(ReviewOutputs {
                artifact_body: text,
                verdict,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: Some(session_id),
            })
        })
    }
}

fn build_coder_prompt(input: &CodeInputs) -> String {
    let pi = CoderInputs {
        task_id: input.task_id.clone(),
        design_md: extract_design(&input.prior_artifacts),
        previous_review: extract_prior(&input.prior_artifacts, "review"),
        previous_verify: extract_prior(&input.prior_artifacts, "verify"),
        retry_history: input.prior_artifacts.iter()
            .filter(|a| a.stage == "review" && a.attempt > 0)
            .map(|a| format!("attempt {}: reviewer needs_changes", a.attempt))
            .collect(),
        worktree_path: input.worktree_path.to_string_lossy().into_owned(),
        attempt: input.attempt,
    };
    render_coder(&pi)
}

fn build_reviewer_prompt(input: &ReviewInputs) -> String {
    let pi = ReviewerInputs {
        task_id: input.task_id.clone(),
        diff: input.diff.clone(),
        design_excerpt: input.design_excerpt.clone(),
        worktree_path: input.worktree_path.to_string_lossy().into_owned(),
        attempt: input.attempt,
    };
    render_reviewer(&pi)
}

fn extract_design(artifacts: &[PriorArtifact]) -> String {
    artifacts.iter()
        .find(|a| a.stage == "design")
        .map(|a| a.body.clone())
        .unwrap_or_else(|| "(none)".into())
}

fn extract_prior(artifacts: &[PriorArtifact], stage: &str) -> Option<String> {
    artifacts.iter()
        .find(|a| a.stage == stage)
        .map(|a| a.body.clone())
}

fn parse_coder_verdict(text: &str) -> DevelopVerdict {
    if text.contains("verdict: ok") || text.contains("## Self-check") {
        DevelopVerdict::Approved
    } else {
        DevelopVerdict::NeedsChanges
    }
}

fn parse_reviewer_verdict(text: &str) -> ReviewVerdict {
    if text.contains("LGTM") || text.contains("## Findings\n(none)") {
        ReviewVerdict::Approved
    } else {
        ReviewVerdict::NeedsChanges
    }
}
