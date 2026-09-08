//! End-to-end task orchestrator.
//!
//! Coordinates the full workbench pipeline for one task: creates a worktree,
//! runs the state machine through all 6 stages, writes the per-stage
//! artifacts, and submits the MR via the GitLab client. This is what the
//! `main_session` actor will call once the LLM is wired in.
//!
//! For v1, LLM stages are stubbed by deterministic functions that write
//! the expected artifacts and return synthetic verdicts. The state machine
//! transitions and artifact I/O are real; the LLM is the only piece
//! left to be replaced with a real child-session call.
//!
//! Spec §4–§10.

use std::path::Path;
use std::sync::Arc;

use crate::tapd::store::TapdStore;
use crate::workbench::artifacts::{ArtifactEnvelope, artifact_path};
use crate::agent::config::AdjudicateMode;
use crate::workbench::state_machine::{
    AdjudicateVerdict, DesignDoc, MrSubmitOutcome, ReviewVerdict, Stage, TaskState,
    next_after_adjudicate, next_after_develop, next_after_mr_submit, next_after_planner,
    next_after_review, next_after_verify,
};
use crate::workbench::intervention::InterventionRegistry;
use crate::workbench::submitter::{
    build_mr_payload, classify_response, resolve_assignees, resolve_reviewers, GitlabClient,
};
use crate::workbench::worktree_manager::{branch_name, worktree_path};

/// Inputs needed to drive a task through the pipeline.
pub struct OrchestratorInputs {
    pub tapd_id: String,
    pub title: String,
    pub description: String,
    pub acs: Vec<String>,
    pub priority: i32,
    pub repo_root: std::path::PathBuf,
    pub grok_home: std::path::PathBuf,
    pub base_branch: String,
    pub tapd_owner: Option<String>,
    pub mr_reviewers: Vec<String>,
    pub mr_assignees: Vec<String>,
    pub project_id: String,
    /// V2.5: LLM stage injected via trait. Set to
    /// `FakeLlmStageAlwaysOk::default_into_dyn()` for safe struct-literal
    /// init, or use `.with_llm_stage(...)` after construction.
    pub llm_stage: crate::workbench::llm_stage::DynLlmStage,
}

impl OrchestratorInputs {
    /// Chainable constructor for the LLM stage.
    pub fn with_llm_stage(
        mut self,
        llm_stage: crate::workbench::llm_stage::DynLlmStage,
    ) -> Self {
        self.llm_stage = llm_stage;
        self
    }
}

/// Minimal default `LlmStage` for struct-literal init. Returns Approved
/// on every call without recording anything.
pub struct FakeLlmStageAlwaysOk;
impl crate::workbench::llm_stage::LlmStage for FakeLlmStageAlwaysOk {
    fn code<'a>(&'a self, input: &'a crate::workbench::llm_stage::CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<crate::workbench::llm_stage::CodeOutputs>> + 'a>
    > {
        let body = "## Changes\n- stub\n## Self-check\n- [x] ok\n".to_string();
        Box::pin(async move {
            Ok(crate::workbench::llm_stage::CodeOutputs {
                artifact_body: body,
                verdict: crate::workbench::llm_stage::DevelopVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }
    fn review<'a>(&'a self, input: &'a crate::workbench::llm_stage::ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<crate::workbench::llm_stage::ReviewOutputs>> + 'a>
    > {
        let body = "## Findings\n(none)\n## Summary\nLGTM.\n".to_string();
        Box::pin(async move {
            Ok(crate::workbench::llm_stage::ReviewOutputs {
                artifact_body: body,
                verdict: crate::workbench::llm_stage::ReviewVerdict::Approved,
                model: input.primary_model.clone(),
                fallback_used: false,
                child_session_id: None,
            })
        })
    }
}

impl FakeLlmStageAlwaysOk {
    /// Convenience: wrap self in `Arc<dyn LlmStage>` for struct-literal init.
    pub fn default_into_dyn() -> crate::workbench::llm_stage::DynLlmStage {
        std::sync::Arc::new(Self) as crate::workbench::llm_stage::DynLlmStage
    }

    pub fn into_dyn_with_models(
        models: WorkbenchModelsConfig,
    ) -> crate::workbench::llm_stage::DynLlmStage {
        std::sync::Arc::new(ConfiguredFakeLlmStage { models })
    }
}

struct ConfiguredFakeLlmStage {
    models: WorkbenchModelsConfig,
}

impl crate::workbench::llm_stage::LlmStage for ConfiguredFakeLlmStage {
    fn models(&self) -> WorkbenchModelsConfig {
        self.models.clone()
    }

    fn code<'a>(&'a self, input: &'a crate::workbench::llm_stage::CodeInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<crate::workbench::llm_stage::CodeOutputs>> + 'a>
    > {
        <FakeLlmStageAlwaysOk as crate::workbench::llm_stage::LlmStage>::code(
            &FakeLlmStageAlwaysOk,
            input,
        )
    }

    fn review<'a>(&'a self, input: &'a crate::workbench::llm_stage::ReviewInputs) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<crate::workbench::llm_stage::ReviewOutputs>> + 'a>
    > {
        <FakeLlmStageAlwaysOk as crate::workbench::llm_stage::LlmStage>::review(
            &FakeLlmStageAlwaysOk,
            input,
        )
    }
}

use crate::agent::config::WorkbenchModelsConfig;
use crate::workbench::llm_stage::{CodeInputs, DevelopVerdict, PriorArtifact, ReviewInputs};
use crate::workbench::llm_stage::ReviewVerdict as LlmReviewVerdict;
use crate::workbench::recovery::{decide_fallback, RoleFallback};
fn coder_role(models: &WorkbenchModelsConfig) -> RoleFallback {
    RoleFallback {
        primary: models.coder_model.clone(),
        fallback: models.coder_fallback.clone(),
    }
}

fn reviewer_role(models: &WorkbenchModelsConfig) -> RoleFallback {
    RoleFallback {
        primary: models.reviewer_model.clone(),
        fallback: models.reviewer_fallback.clone(),
    }
}

/// Translate `OrchestratorInputs` + the design doc + retry context into
/// `CodeInputs` for the LLMStage.
pub fn build_coder_inputs(
    inputs: &OrchestratorInputs,
    models: &WorkbenchModelsConfig,
    attempt: u8,
    prior_artifacts: Vec<PriorArtifact>,
) -> CodeInputs {
    CodeInputs {
        task_id: inputs.tapd_id.clone(),
        title: inputs.title.clone(),
        description: inputs.description.clone(),
        acs: inputs.acs.clone(),
        worktree_path: worktree_path(
            inputs.grok_home.to_str().unwrap(),
            &inputs.tapd_id,
        ),
        project_config_yaml: String::new(),
        prior_artifacts,
        attempt,
        primary_model: models.coder_model.clone(),
        fallback_model: models.coder_fallback.clone(),
    }
}

/// Translate `OrchestratorInputs` + design excerpt + diff into `ReviewInputs`.
pub fn build_reviewer_inputs(
    inputs: &OrchestratorInputs,
    models: &WorkbenchModelsConfig,
    design_excerpt: &str,
    diff: &str,
    prior_review: Option<String>,
    prior_verify: Option<String>,
    attempt: u8,
) -> ReviewInputs {
    ReviewInputs {
        task_id: inputs.tapd_id.clone(),
        worktree_path: worktree_path(
            inputs.grok_home.to_str().unwrap(),
            &inputs.tapd_id,
        ),
        design_excerpt: design_excerpt.to_string(),
        diff: diff.to_string(),
        prior_review,
        prior_verify,
        attempt,
        primary_model: models.reviewer_model.clone(),
        fallback_model: models.reviewer_fallback.clone(),
    }
}

/// Result of a single orchestration pass.
pub struct OrchestratorResult {
    pub final_state: TaskState,
    pub branch: String,
    pub worktree_path: std::path::PathBuf,
    pub mr_url: Option<String>,
}

/// Stub: planner LLM call. Writes `1-design.md` with the expected sections
/// and an "Open questions: None." block (so the pipeline skips Adjudicate).
async fn stub_planner(
    worktree: &Path,
    inputs: &OrchestratorInputs,
) -> anyhow::Result<DesignDoc> {
    let design_md = format!(
        "## Goal\n{goal}\n## Approach\nAuto-generated by stub planner.\n## Files to modify\n- src/{slug}.rs\n## Edge cases\n- none\n## Out of scope\n- none\n## Open questions\nNone.\n",
        goal = inputs.title,
        slug = inputs.tapd_id.to_lowercase(),
    );
    let env = ArtifactEnvelope {
        frontmatter: crate::workbench::artifacts::ArtifactFrontmatter {
            stage: Stage::Brainstorm,
            task_id: inputs.tapd_id.clone(),
            attempt: 0,
            extra: Default::default(),
        },
        body: design_md,
    };
    let path = worktree.join(artifact_path(1, "design", 0));
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    tokio::fs::write(&path, env.to_string()).await?;
    let design = DesignDoc::parse(&env.body)?;
    Ok(design)
}

/// Stub: adjudicator LLM call. Always returns Proceed.
async fn stub_adjudicator(worktree: &Path, inputs: &OrchestratorInputs) -> anyhow::Result<()> {
    let body = "## Adjudication\n- auto-resolved: design has no open questions\n";
    let env = ArtifactEnvelope {
        frontmatter: crate::workbench::artifacts::ArtifactFrontmatter {
            stage: Stage::Adjudicate,
            task_id: inputs.tapd_id.clone(),
            attempt: 0,
            extra: [("verdict".to_string(), serde_yaml::Value::String("proceed".into()))]
                .into_iter()
                .collect(),
        },
        body: body.into(),
    };
    let path = worktree.join(artifact_path(2, "adjudicate", 0));
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    tokio::fs::write(&path, env.to_string()).await?;
    Ok(())
}


/// Stub: runner. Skips the test command (no test runner wired in v1) and
/// returns exit 0. Writes 5-verify.md.
async fn stub_runner(worktree: &Path, inputs: &OrchestratorInputs) -> anyhow::Result<()> {
    let body = "## Command\n(none — v1 stub)\n## Exit code\n0\n";
    let env = ArtifactEnvelope {
        frontmatter: crate::workbench::artifacts::ArtifactFrontmatter {
            stage: Stage::Verify,
            task_id: inputs.tapd_id.clone(),
            attempt: 0,
            extra: [
                ("exit_code".to_string(), serde_yaml::Value::Number(0.into())),
                ("verdict".to_string(), serde_yaml::Value::String("pass".into())),
            ]
            .into_iter()
            .collect(),
        },
        body: body.into(),
    };
    let path = worktree.join(artifact_path(5, "verify", 0));
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    tokio::fs::write(&path, env.to_string()).await?;
    Ok(())
}

/// Drive one task from Pending to Done. Writes `state.json` after each
/// transition so a backend crash mid-pipeline can resume from the last
/// persisted state. Returns the final TaskState + MR URL.
pub async fn drive_task(
    store: Arc<TapdStore>,
    gitlab: &GitlabClient,
    inputs: OrchestratorInputs,
    intervention: Option<Arc<InterventionRegistry>>,
) -> anyhow::Result<OrchestratorResult> {
    // Helper: if the user has cancelled (or paused + cancelled) this task,
    // short-circuit to `Dead { reason: "user_cancelled" }`. Checked between
    // stages AND before each stub LLM call so we abort promptly (D2).
    let check_cancel = || -> Option<TaskState> {
        let reg = intervention.as_ref()?;
        let token = reg.token(&inputs.tapd_id)?;
        if token.is_cancelled() {
            Some(TaskState::Dead { reason: "user_cancelled".into() })
        } else {
            None
        }
    };
    let branch = branch_name(&inputs.tapd_id, &inputs.title);
    let wt_path = worktree_path(inputs.grok_home.to_str().unwrap(), &inputs.tapd_id);
    crate::workbench::worktree_manager::create_worktree(
        &inputs.repo_root,
        inputs.grok_home.to_str().unwrap(),
        &inputs.tapd_id,
        &inputs.title,
        &inputs.base_branch,
    )?;
    let mut state = TaskState::Pending;
    save_state(&wt_path, &state)?;
    let models = inputs.llm_stage.models();

    // 1. Brainstorm
    if let Some(dead_state) = check_cancel() {
        save_state(&wt_path, &dead_state)?;
        return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
    }
    let design = stub_planner(&wt_path, &inputs).await?;
    state = next_after_planner(state, &design, inputs.priority, inputs.acs.len(), AdjudicateMode::Recorder);
    save_state(&wt_path, &state)?;

    // 2. Adjudicate (only when needed)
    if matches!(state, TaskState::Running { stage: Stage::Adjudicate, .. }) {
        if let Some(dead_state) = check_cancel() {
            save_state(&wt_path, &dead_state)?;
            return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
        }
        stub_adjudicator(&wt_path, &inputs).await?;
        state = next_after_adjudicate(AdjudicateVerdict::Proceed);
        save_state(&wt_path, &state)?;
    }

    // 3. Develop — V2.5: real LLM call via trait injection + fallback loop.
    if let Some(dead_state) = check_cancel() {
        save_state(&wt_path, &dead_state)?;
        return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
    }
    let mut develop_attempt: u8 = 0;
    let mut develop_fallback_used = false;
    let develop_out: crate::workbench::llm_stage::CodeOutputs = loop {
        let started_at = chrono::Utc::now().timestamp_millis();
        let mut code_inputs_inner = build_coder_inputs(&inputs, &models, develop_attempt, vec![]);
        if develop_fallback_used {
            if let Some(fb) = code_inputs_inner.fallback_model.clone() {
                code_inputs_inner.primary_model = fb;
            }
        }
        match inputs.llm_stage.code(&code_inputs_inner).await {
            Ok(out) => {
                let finished_at = chrono::Utc::now().timestamp_millis();
                tokio::fs::create_dir_all(wt_path.join(".workbench/stages").as_path()).await?;
                let env_body = out.artifact_body.clone();
                tokio::fs::write(
                    wt_path.join(artifact_path(3, "develop", develop_attempt)),
                    env_body,
                ).await?;
                let _ = store.record_task_metric(
                    &inputs.tapd_id,
                    "develop",
                    develop_attempt,
                    started_at,
                    finished_at,
                    &out.model,
                    if develop_fallback_used || out.fallback_used { 1 } else { 0 },
                    out.child_session_id.as_deref(),
                );
                break out;
            }
            Err(e) => {
                tracing::warn!(tapd_id = %inputs.tapd_id, "coder attempt {} failed: {e}", develop_attempt);
                let next_model = decide_fallback(
                    &coder_role(&models),
                    develop_attempt,
                    develop_fallback_used,
                );
                match next_model {
                    Some(m) => {
                        develop_fallback_used = true;
                        develop_attempt += 1;
                        tracing::info!(tapd_id = %inputs.tapd_id, "developing fallback model {m}");
                    }
                    None => {
                        let dead = TaskState::Dead { reason: format!("coder_failed: {e}") };
                        save_state(&wt_path, &dead)?;
                        return Ok(OrchestratorResult {
                            final_state: dead,
                            branch,
                            worktree_path: wt_path,
                            mr_url: None,
                        });
                    }
                }
            }
        }
    };
    state = next_after_develop(
        matches!(develop_out.verdict, DevelopVerdict::Approved),
        develop_attempt,
    );
    save_state(&wt_path, &state)?;

    // 4. Code Review — V2.5: same trait-injection + fallback pattern.
    if let Some(dead_state) = check_cancel() {
        save_state(&wt_path, &dead_state)?;
        return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
    }
    let mut review_attempt: u8 = 0;
    let mut review_fallback_used = false;
    let review_out: crate::workbench::llm_stage::ReviewOutputs = loop {
        let started_at = chrono::Utc::now().timestamp_millis();
        let mut review_inputs_inner = build_reviewer_inputs(
            &inputs,
            &models,
            "(none)",
            "(none)",
            None,
            None,
            review_attempt,
        );
        if review_fallback_used {
            if let Some(fb) = review_inputs_inner.fallback_model.clone() {
                review_inputs_inner.primary_model = fb;
            }
        }
        match inputs.llm_stage.review(&review_inputs_inner).await {
            Ok(out) => {
                let finished_at = chrono::Utc::now().timestamp_millis();
                tokio::fs::create_dir_all(wt_path.join(".workbench/stages").as_path()).await?;
                let env_body = out.artifact_body.clone();
                tokio::fs::write(
                    wt_path.join(artifact_path(4, "review", review_attempt)),
                    env_body,
                ).await?;
                let _ = store.record_task_metric(
                    &inputs.tapd_id,
                    "review",
                    review_attempt,
                    started_at,
                    finished_at,
                    &out.model,
                    if review_fallback_used || out.fallback_used { 1 } else { 0 },
                    out.child_session_id.as_deref(),
                );
                break out;
            }
            Err(e) => {
                tracing::warn!(tapd_id = %inputs.tapd_id, "reviewer attempt {} failed: {e}", review_attempt);
                let next_model = decide_fallback(
                    &reviewer_role(&models),
                    review_attempt,
                    review_fallback_used,
                );
                match next_model {
                    Some(m) => {
                        review_fallback_used = true;
                        review_attempt += 1;
                        tracing::info!(tapd_id = %inputs.tapd_id, "reviewer fallback model {m}");
                    }
                    None => {
                        let dead = TaskState::Dead { reason: format!("reviewer_failed: {e}") };
                        save_state(&wt_path, &dead)?;
                        return Ok(OrchestratorResult {
                            final_state: dead,
                            branch,
                            worktree_path: wt_path,
                            mr_url: None,
                        });
                    }
                }
            }
        }
    };
    state = next_after_review(
        match review_out.verdict {
            LlmReviewVerdict::Approved => crate::workbench::state_machine::ReviewVerdict::Approved,
            LlmReviewVerdict::NeedsChanges => crate::workbench::state_machine::ReviewVerdict::NeedsChanges,
        },
        review_attempt,
    );
    save_state(&wt_path, &state)?;

    // 5. Verify (stub: pass)
    if let Some(dead_state) = check_cancel() {
        save_state(&wt_path, &dead_state)?;
        return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
    }
    stub_runner(&wt_path, &inputs).await?;
    state = next_after_verify(0, 0);
    save_state(&wt_path, &state)?;

    // 6. MrSubmit — actually call GitLab
    let reviewers = resolve_reviewers(&inputs.mr_reviewers, inputs.tapd_owner.as_deref(), &[]);
    let assignees = resolve_assignees(&inputs.mr_assignees, inputs.tapd_owner.as_deref());
    let payload = build_mr_payload(
        &inputs.tapd_id,
        &inputs.title,
        &inputs.description,
        &inputs.acs,
        &branch,
        &inputs.base_branch,
        &assignees,
        &reviewers,
    );
    if let Some(dead_state) = check_cancel() {
        save_state(&wt_path, &dead_state)?;
        return Ok(OrchestratorResult { final_state: dead_state, branch, worktree_path: wt_path, mr_url: None });
    }
    let mr_url = match gitlab.create_merge_request(&inputs.project_id, &payload).await {
        Ok(resp) => {
            let outcome = classify_response(crate::workbench::submitter::GitlabCreateMrResponse {
                status: resp.status,
                body: resp.body.clone(),
            });
            let mr_url = resp.mr_url();
            state = next_after_mr_submit(0, outcome);
            save_state(&wt_path, &state)?;
            mr_url
        }
        Err(_) => {
            state = next_after_mr_submit(0, MrSubmitOutcome::TransientError);
            save_state(&wt_path, &state)?;
            None
        }
    };

    store.put_workbench_state(&inputs.tapd_id, "done")?;
    Ok(OrchestratorResult {
        final_state: state,
        branch,
        worktree_path: wt_path,
        mr_url,
    })
}

fn save_state(worktree: &Path, state: &TaskState) -> anyhow::Result<()> {
    use crate::workbench::state_machine::save_state;
    // Block_on-style synchronous save (we're in an async fn but tokio's
    // current_thread runtime means we can't easily .await a sync fn here
    // without the runtime handle). For v1 test we just write the JSON
    // directly using the same code path.
    let json = serde_json::to_string_pretty(state)?;
    let dir = worktree.join(".workbench");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("state.json"), json)?;
    // Reference save_state to keep the API surface available.
    let _ = save_state;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_coder_inputs_carries_attempt_and_model() {
        let oi = OrchestratorInputs {
            tapd_id: "TAPD-1".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec!["ac1".into()],
            priority: 1,
            repo_root: std::path::PathBuf::from("/r"),
            grok_home: std::path::PathBuf::from("/g"),
            base_branch: "main".into(),
            tapd_owner: None,
            mr_reviewers: vec![],
            mr_assignees: vec![],
            project_id: "1".into(),
            llm_stage: FakeLlmStageAlwaysOk::default_into_dyn(),
        };
        let mut models = WorkbenchModelsConfig::default();
        models.coder_fallback = Some("sonnet-4.5".into());
        let ci = build_coder_inputs(&oi, &models, 1, vec![]);
        assert_eq!(ci.task_id, "TAPD-1");
        assert_eq!(ci.attempt, 1);
        assert_eq!(ci.primary_model, models.coder_model);
        assert_eq!(ci.fallback_model.as_deref(), Some("sonnet-4.5"));
        assert!(ci.worktree_path.ends_with("TAPD-1"));
    }

    #[test]
    fn build_reviewer_inputs_carries_diff() {
        let oi = OrchestratorInputs {
            tapd_id: "TAPD-2".into(),
            title: "t".into(),
            description: "d".into(),
            acs: vec![],
            priority: 1,
            repo_root: std::path::PathBuf::from("/r"),
            grok_home: std::path::PathBuf::from("/g"),
            base_branch: "main".into(),
            tapd_owner: None,
            mr_reviewers: vec![],
            mr_assignees: vec![],
            project_id: "1".into(),
            llm_stage: FakeLlmStageAlwaysOk::default_into_dyn(),
        };
        let models = WorkbenchModelsConfig::default();
        let ri = build_reviewer_inputs(
            &oi, &models, "## Goal\nx", "+ new line", None, None, 0,
        );
        assert_eq!(ri.diff, "+ new line");
        assert_eq!(ri.design_excerpt, "## Goal\nx");
        assert_eq!(ri.primary_model, models.reviewer_model);
    }

    #[test]
    fn save_state_writes_json_to_worktree() {
        let tmp = tempdir::TempDir::new("orchestrator-state").unwrap();
        let state = TaskState::Running { stage: Stage::Develop, attempt: 0, started_at: 0, fallback_model: None, last_error: None };
        save_state(tmp.path(), &state).unwrap();
        let json = std::fs::read_to_string(tmp.path().join(".workbench/state.json")).unwrap();
        assert!(json.contains("develop"), "json should contain develop: {}", json);
        assert!(json.contains("attempt"));
    }
}


