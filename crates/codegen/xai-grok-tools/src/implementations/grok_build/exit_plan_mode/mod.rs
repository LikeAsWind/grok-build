//! `ExitPlanMode` tool — new architecture (`Tool` trait).
//!
//! Signals that the agent has finished planning and is ready for the user to
//! review and approve the plan. The tool reads the plan file from disk (it does
//! NOT accept plan content as input) and surfaces it via:
//!
//! 1. A `PlanModeExited` **notification** sent to the gateway/client, carrying
//!    the plan content so the client can present it for user approval.
//! 2. A structured **`ExitPlanModeOutput`** returned to the model, containing
//!    the plan content (or an empty-plan message).
//!
//! The actual approval flow (yes/no with feedback, context clear, mode
//! transition) happens on the client side — this tool just says "I'm done,
//! here's the plan."
//!
//! ## Plan File
//!
//! The plan file path defaults to `.grok/plan.md` relative to the session
//! `Cwd`. The tool reads it via the `FileSystem` resource (the same async FS
//! abstraction used by `ReadFile` and `SearchReplace`).

pub mod types;

pub use types::{ExitPlanModeExtRequest, ExitPlanModeExtResponse};

use crate::notification::types::PlanModeExited;
use crate::types::output::ExitPlanModeOutput;
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::resources::NotificationHandle;
use crate::types::tool::{ToolKind, ToolNamespace};

/// Input for the `ExitPlanMode` tool.
///
/// The model passes its plan content directly as markdown. No file
/// intermediary — Plan Mode is strictly read-only.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ExitPlanModeInput {
    /// The plan content in markdown format.
    pub plan_content: String,
}

/// `ExitPlanMode` tool.
///
/// Reads the plan file from disk and signals to the orchestration layer that
/// the agent is done planning. The client receives a `PlanModeExited`
/// notification with the plan content and is responsible for presenting the
/// approval UI.
///
/// Params: `()` — no per-tool configuration.
#[derive(Debug, Default)]
pub struct ExitPlanModeTool;

impl crate::types::tool_metadata::ToolMetadata for ExitPlanModeTool {
    fn kind(&self) -> ToolKind {
        ToolKind::ExitPlan
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn emitted_notifications(&self) -> &'static [&'static str] {
        &["PlanModeExited"]
    }

    fn description_template(&self) -> &str {
        r#"Exit plan mode and present your plan to the user.

Use this after you have finished writing your plan to the plan file in plan mode."#
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        // ExitPlanMode can only exist if EnterPlanMode is also registered —
        // exiting plan mode without the ability to enter would be nonsensical.
        use crate::implementations::grok_build::enter_plan_mode::EnterPlanModeTool;
        Expr::Value(ToolRequirement::Tool {
            namespace: crate::types::tool_metadata::ToolMetadata::tool_namespace(
                &EnterPlanModeTool,
            )
            .to_string(),
            id: xai_tool_runtime::Tool::id(&EnterPlanModeTool).to_string(),
            if_params: None,
        })
    }
}

impl xai_tool_runtime::Tool for ExitPlanModeTool {
    type Args = ExitPlanModeInput;
    type Output = ExitPlanModeOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("exit_plan_mode").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "exit_plan_mode",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: true,
            tool_scope: Some(xai_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    #[tracing::instrument(name = "tool.exit_plan_mode", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: ExitPlanModeInput,
    ) -> Result<ExitPlanModeOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;

        let plan_content = if input.plan_content.trim().is_empty() {
            None
        } else {
            Some(input.plan_content)
        };

        // Notify the gateway / client.
        {
            let res = resources.lock().await;
            if let Some(handle) = res.get::<NotificationHandle>() {
                handle.0.send_plan_mode_exited(PlanModeExited {
                    tool_call_id: ctx.call_id.as_str().to_owned(),
                    plan_content: plan_content.clone(),
                });
            }
        }

        match plan_content {
            Some(content) => {
                tracing::info!(
                    plan_chars = content.len(),
                    "Exiting plan mode with plan content"
                );

                let message = "Your plan has been approved. You can now start coding.".to_owned();

                Ok(ExitPlanModeOutput::PlanReady {
                    message,
                    plan_content: content,
                })
            }
            None => {
                tracing::info!("Exiting plan mode with empty plan content");

                Ok(ExitPlanModeOutput::EmptyPlan {
                    message:
                        "Plan mode exit approved. No plan content was provided — you can proceed."
                            .to_string(),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::output::ToolOutput;
    use crate::types::resources::Resources;
    use crate::types::tool_metadata::test_ctx_with_call_id;

    #[test]
    fn tool_name_and_description() {
        let tool = ExitPlanModeTool;
        assert_eq!(xai_tool_runtime::Tool::id(&tool).as_str(), "exit_plan_mode");
        let desc = crate::types::tool_metadata::ToolMetadata::description_template(&tool);
        assert!(desc.contains("Exit plan mode"));
    }

    #[test]
    fn tool_is_read_only() {
        assert!(xai_tool_runtime::Tool::capabilities(&ExitPlanModeTool).is_read_only);
    }

    #[test]
    fn tool_kind_is_exit_plan() {
        assert_eq!(
            crate::types::tool_metadata::ToolMetadata::kind(&ExitPlanModeTool),
            ToolKind::ExitPlan
        );
    }

    #[tokio::test]
    async fn exit_with_plan_content() {
        let resources = Resources::new();
        let shared = resources.into_shared();
        let tool = ExitPlanModeTool;

        let result = xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "test-call"),
            ExitPlanModeInput {
                plan_content: "# My Plan\n\n1. Do thing A\n2. Do thing B\n".to_string(),
            },
        )
        .await
        .unwrap();

        match result {
            ExitPlanModeOutput::PlanReady {
                ref message,
                ref plan_content,
            } => {
                assert!(message.contains("plan has been approved"));
                assert!(message.contains("start coding"));
                assert!(plan_content.contains("Do thing A"));
                assert!(plan_content.contains("Do thing B"));
            }
            other => panic!("Expected PlanReady, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn exit_with_empty_plan_content() {
        let resources = Resources::new();
        let shared = resources.into_shared();
        let tool = ExitPlanModeTool;

        let result = xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "test-call"),
            ExitPlanModeInput {
                plan_content: "   \n  \n".to_string(),
            },
        )
        .await
        .unwrap();

        match result {
            ExitPlanModeOutput::EmptyPlan { ref message } => {
                assert!(message.contains("Plan mode exit approved"));
                assert!(message.contains("No plan content was provided"));
                assert!(message.contains("you can proceed"));
            }
            other => panic!("Expected EmptyPlan, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn sends_plan_mode_exited_notification_with_content() {
        use crate::notification::types::{ToolNotification, ToolNotificationHandle};

        let (handle, mut rx) = ToolNotificationHandle::channel();
        let mut resources = Resources::new();
        resources.insert(NotificationHandle(handle));
        let shared = resources.into_shared();
        let tool = ExitPlanModeTool;

        xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "call-99"),
            ExitPlanModeInput {
                plan_content: "The plan".to_string(),
            },
        )
        .await
        .unwrap();

        let notification = rx.try_recv().expect("should have received a notification");
        match notification {
            ToolNotification::PlanModeExited(exited) => {
                assert_eq!(exited.tool_call_id, "call-99");
                assert_eq!(exited.plan_content, Some("The plan".to_string()));
            }
            other => panic!("Expected PlanModeExited, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn works_without_notification_handle() {
        let resources = Resources::new();
        let shared = resources.into_shared();
        let tool = ExitPlanModeTool;

        let result = xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "test-call"),
            ExitPlanModeInput {
                plan_content: "A plan".to_string(),
            },
        )
        .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn prompt_format_includes_plan_content() {
        let resources = Resources::new();
        let shared = resources.into_shared();
        let tool = ExitPlanModeTool;

        let result = xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "test-call"),
            ExitPlanModeInput {
                plan_content: "Step 1\nStep 2".to_string(),
            },
        )
        .await
        .unwrap();

        let output: ToolOutput = result.into();
        let prompt = output.to_prompt_format();
        assert!(prompt.contains("plan has been approved"));
        assert!(prompt.contains("Step 1"));
        assert!(prompt.contains("Step 2"));
        assert!(prompt.contains("## Plan:"));
    }
}
