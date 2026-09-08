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
pub trait LlmStage: Send + Sync {
    fn code(&self, input: &CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + Send + '_>
    >;
    fn review(&self, input: &ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + Send + '_>
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
}
