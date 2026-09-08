//! Test-only helpers for the workbench pipeline. NOT compiled into release.

#![cfg(test)]

use std::sync::{Arc, Mutex};

use crate::workbench::llm_stage::{
    CodeInputs, CodeOutputs, DevelopVerdict, DynLlmStage, LlmStage,
    ReviewInputs, ReviewOutputs, ReviewVerdict,
};

/// One recorded call to the fake LLM, captured for assertion in tests.
#[derive(Clone, Debug)]
pub struct RecordedCall {
    pub stage: &'static str,        // "code" | "review"
    pub task_id: String,
    pub attempt: u8,
    pub primary_model: String,
    pub fallback_model: Option<String>,
    pub worktree_path: std::path::PathBuf,
}

/// Test double for `LlmStage`. Returns canned artifact bodies matching the
/// v1 e2e fixture text so the existing 23 v2 tests do not break.
pub struct FakeLlmStage {
    pub code_response: String,
    pub review_response: String,
    pub fail_code: bool,
    pub fail_review: bool,
    pub calls: Mutex<Vec<RecordedCall>>,
}

impl Default for FakeLlmStage {
    fn default() -> Self {
        Self {
            code_response: default_code_body(),
            review_response: default_review_body(),
            fail_code: false,
            fail_review: false,
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl FakeLlmStage {
    pub fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }

    pub fn into_dyn(self) -> DynLlmStage {
        Arc::new(self) as DynLlmStage
    }
}

impl LlmStage for FakeLlmStage {
    fn code(&self, input: &CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<CodeOutputs>> + Send + '_>
    > {
        let input = input.clone();
        let resp = self.code_response.clone();
        let fail = self.fail_code;
        self.calls.lock().unwrap().push(RecordedCall {
            stage: "code",
            task_id: input.task_id.clone(),
            attempt: input.attempt,
            primary_model: input.primary_model.clone(),
            fallback_model: input.fallback_model.clone(),
            worktree_path: input.worktree_path.clone(),
        });
        Box::pin(async move {
            if fail {
                anyhow::bail!("FakeLlmStage: fail_code=true");
            }
            Ok(CodeOutputs {
                artifact_body: resp,
                verdict: DevelopVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }

    fn review(&self, input: &ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<ReviewOutputs>> + Send + '_>
    > {
        let input = input.clone();
        let resp = self.review_response.clone();
        let fail = self.fail_review;
        self.calls.lock().unwrap().push(RecordedCall {
            stage: "review",
            task_id: input.task_id.clone(),
            attempt: input.attempt,
            primary_model: input.primary_model.clone(),
            fallback_model: input.fallback_model.clone(),
            worktree_path: input.worktree_path.clone(),
        });
        Box::pin(async move {
            if fail {
                anyhow::bail!("FakeLlmStage: fail_review=true");
            }
            Ok(ReviewOutputs {
                artifact_body: resp,
                verdict: ReviewVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }
}

fn default_code_body() -> String {
    // Matches the body produced by v1's stub_coder exactly.
    "## Changes\n- edited src/{slug}.rs\n## Self-check\n- [x] compiles\n".into()
}

fn default_review_body() -> String {
    // Matches v1's stub_reviewer body.
    "## Findings\n(none)\n## Summary\nLGTM.\n".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_records_code_call() {
        let fake = FakeLlmStage::default();
        let _ = fake.code(&CodeInputs {
            task_id: "TAPD-1".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec![],
            worktree_path: "/tmp/wt".into(),
            project_config_yaml: String::new(),
            prior_artifacts: vec![],
            attempt: 0,
            primary_model: "opus-4.1".into(),
            fallback_model: Some("sonnet-4.5".into()),
        }).await.unwrap();
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].stage, "code");
        assert_eq!(calls[0].task_id, "TAPD-1");
        assert_eq!(calls[0].fallback_model.as_deref(), Some("sonnet-4.5"));
    }

    #[tokio::test]
    async fn fake_fail_code_returns_err() {
        let mut fake = FakeLlmStage::default();
        fake.fail_code = true;
        let res = fake.code(&CodeInputs {
            task_id: "TAPD-1".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec![],
            worktree_path: "/tmp/wt".into(),
            project_config_yaml: String::new(),
            prior_artifacts: vec![],
            attempt: 0,
            primary_model: "opus-4.1".into(),
            fallback_model: None,
        }).await;
        assert!(res.is_err());
    }
}
