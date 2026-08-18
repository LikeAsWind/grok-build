//! `EnterPlanMode` tool — new architecture (`Tool` trait).
//!
//! Gateway tool that the agent calls when it decides a task is complex enough
//! to warrant a planning phase before writing code. This is the
//! **agent-initiated** entry path into plan mode.
//!
//! On success it notifies orchestration (`PlanModeEntered`). Plan mode is
//! strictly read-only — the model gathers information, then passes its plan
//! content directly to `exit_plan_mode` when ready. No plan file is written.
//!
//! ## User Consent
//!
//! This tool requires user approval before executing. The UI should present a
//! confirmation dialog. If the user declines, the tool result is rejected and
//! the model receives `"User declined to enter plan mode."`.

use crate::notification::types::PlanModeEntered;
use crate::types::output::EnterPlanModeOutput;
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::resources::NotificationHandle;
use crate::types::template_renderer::TemplateRenderer;
use crate::types::tool::{ToolKind, ToolNamespace};

/// Input for the `EnterPlanMode` tool.
///
/// Empty object — no parameters. The decision to enter plan mode is a binary
/// gate. All configuration (workflow variant, explore agent count, etc.) comes
/// from feature flags and environment variables, not from the tool call.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct EnterPlanModeInput {}

/// `EnterPlanMode` tool: signals plan mode entry, returning a confirmation message.
///
/// Params: `()` — no per-tool configuration.
#[derive(Debug, Default)]
pub struct EnterPlanModeTool;

impl crate::types::tool_metadata::ToolMetadata for EnterPlanModeTool {
    fn kind(&self) -> ToolKind {
        ToolKind::EnterPlan
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn emitted_notifications(&self) -> &'static [&'static str] {
        &["PlanModeEntered"]
    }

    fn description_template(&self) -> &str {
        r#"Use this tool when a task has ambiguity about the right approach or when the user asks you to write a plan. This tool enables a read-only plan mode where you explore the codebase and create an implementation plan for the user."#
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        // EnterPlanMode can only exist if ExitPlanMode is also registered —
        // entering plan mode without the ability to exit would be a dead-end.
        use crate::implementations::grok_build::exit_plan_mode::ExitPlanModeTool;
        Expr::Value(ToolRequirement::Tool {
            namespace: crate::types::tool_metadata::ToolMetadata::tool_namespace(&ExitPlanModeTool)
                .to_string(),
            id: xai_tool_runtime::Tool::id(&ExitPlanModeTool).to_string(),
            if_params: None,
        })
    }
}

impl xai_tool_runtime::Tool for EnterPlanModeTool {
    type Args = EnterPlanModeInput;
    type Output = EnterPlanModeOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("enter_plan_mode").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "enter_plan_mode",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        // Read-only for permission UX; only FS write is seeding the session plan file.
        xai_tool_protocol::ToolCapabilities {
            is_read_only: true,
            tool_scope: Some(xai_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    #[tracing::instrument(name = "tool.enter_plan_mode", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        _input: EnterPlanModeInput,
    ) -> Result<EnterPlanModeOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;

        let (ask_user, exit_plan, task) = {
            let res = resources.lock().await;

            // Send notification first.
            if let Some(handle) = res.get::<NotificationHandle>() {
                handle.0.send_plan_mode_entered(PlanModeEntered {
                    tool_call_id: ctx.call_id.as_str().to_owned(),
                });
            }

            if let Some(renderer) = res.get::<TemplateRenderer>() {
                (
                    renderer
                        .tool_for_kind(ToolKind::AskUser)
                        .unwrap_or("ask_user_question")
                        .to_owned(),
                    renderer
                        .tool_for_kind(ToolKind::ExitPlan)
                        .unwrap_or("exit_plan_mode")
                        .to_owned(),
                    renderer
                        .tool_for_kind(ToolKind::Task)
                        .unwrap_or_default()
                        .to_owned(),
                )
            } else {
                (
                    "ask_user_question".to_owned(),
                    "exit_plan_mode".to_owned(),
                    String::new(),
                )
            }
        };

        let task_hint = if task.is_empty() {
            String::new()
        } else {
            format!(
                "\n     You can use the {task} tool with subagent_type=\"explore\" to \
                 parallelize codebase exploration without filling your context window."
            )
        };

        let message = format!(
            "You have entered plan mode. You should now focus on exploring the codebase \
             and designing an implementation plan.\n\n\
             In plan mode, you should:\n\
             1. Thoroughly explore the codebase to understand existing patterns{task_hint}\n\
             2. Identify similar features, codebase architecture, and understand trade-offs\n\
             3. Use {ask_user} if you need to clarify the approach\n\
             4. Design a concrete implementation strategy\n\
             5. When ready, use {exit_plan} to present your plan to the user."
        );

        tracing::info!("Entered plan mode");

        Ok(EnterPlanModeOutput::Entered { message })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::output::ToolOutput;
    use crate::types::resources::Resources;
    use crate::types::tool_metadata::test_ctx_with_call_id;
    use std::collections::HashMap;

    #[test]
    fn tool_name_and_description() {
        let tool = EnterPlanModeTool;
        assert_eq!(
            xai_tool_runtime::Tool::id(&tool).as_str(),
            "enter_plan_mode"
        );
        let desc = crate::types::tool_metadata::ToolMetadata::description_template(&tool);
        assert!(desc.contains("plan mode"));
    }

    #[test]
    fn tool_is_read_only() {
        let tool = EnterPlanModeTool;
        assert!(xai_tool_runtime::Tool::capabilities(&tool).is_read_only);
    }

    #[test]
    fn tool_kind_is_enter_plan() {
        let tool = EnterPlanModeTool;
        assert_eq!(
            crate::types::tool_metadata::ToolMetadata::kind(&tool),
            ToolKind::EnterPlan
        );
    }

    #[tokio::test]
    async fn enter_plan_mode_returns_confirmation() {
        let resources = Resources::new();
        let shared = resources.into_shared();
        let tool = EnterPlanModeTool;

        let result = xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "test-call"),
            EnterPlanModeInput {},
        )
        .await
        .unwrap();

        let EnterPlanModeOutput::Entered { ref message } = result;
        assert!(message.contains("entered plan mode"));
        assert!(message.contains("exploring the codebase"));
        assert!(message.contains("implementation plan"));
        assert!(message.contains("exit_plan_mode"));
        assert!(message.contains("ask_user_question"));
    }

    #[tokio::test]
    async fn sends_plan_mode_entered_notification() {
        use crate::notification::types::{ToolNotification, ToolNotificationHandle};

        let (handle, mut rx) = ToolNotificationHandle::channel();
        let mut resources = Resources::new();
        resources.insert(NotificationHandle(handle));
        let shared = resources.into_shared();
        let tool = EnterPlanModeTool;

        xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "call-42"),
            EnterPlanModeInput {},
        )
        .await
        .unwrap();

        let notification = rx.try_recv().expect("should have received a notification");
        match notification {
            ToolNotification::PlanModeEntered(entered) => {
                assert_eq!(entered.tool_call_id, "call-42");
            }
            other => panic!("Expected PlanModeEntered, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn works_without_notification_handle() {
        let resources = Resources::new();
        let shared = resources.into_shared();
        let tool = EnterPlanModeTool;

        let result = xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "test-call"),
            EnterPlanModeInput {},
        )
        .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn prompt_format_returns_message() {
        let resources = Resources::new();
        let shared = resources.into_shared();
        let tool = EnterPlanModeTool;

        let result = xai_tool_runtime::Tool::run(
            &tool,
            test_ctx_with_call_id(shared, "test-call"),
            EnterPlanModeInput {},
        )
        .await
        .unwrap();

        let output: ToolOutput = result.into();
        let prompt = output.to_prompt_format();
        assert!(prompt.contains("entered plan mode"));
        assert!(prompt.contains("exit_plan_mode"));
        assert!(prompt.contains("ask_user_question"));
        assert!(prompt.contains("5. When ready, use exit_plan_mode to present your plan to the user"));
    }

    #[tokio::test]
    async fn tool_hints_resolved_from_template_renderer() {
        let mut resources = Resources::new();
        let tools: HashMap<ToolKind, String> = [
            (ToolKind::AskUser, "AskUser".to_owned()),
            (ToolKind::ExitPlan, "FinishPlan".to_owned()),
            (ToolKind::Task, "delegate".to_owned()),
        ]
        .into();
        resources.insert(TemplateRenderer::new(tools, HashMap::new()));
        let shared = resources.into_shared();

        let result = xai_tool_runtime::Tool::run(
            &EnterPlanModeTool,
            test_ctx_with_call_id(shared, "t5"),
            EnterPlanModeInput {},
        )
        .await
        .unwrap();

        let EnterPlanModeOutput::Entered { message } = &result;
        assert!(message.contains("AskUser"));
        assert!(message.contains("FinishPlan"));
        assert!(message.contains("delegate"));
    }

    #[tokio::test]
    async fn tool_hints_default_without_template_renderer() {
        let resources = Resources::new();
        let shared = resources.into_shared();

        let result = xai_tool_runtime::Tool::run(
            &EnterPlanModeTool,
            test_ctx_with_call_id(shared, "t6"),
            EnterPlanModeInput {},
        )
        .await
        .unwrap();

        let EnterPlanModeOutput::Entered { message } = &result;
        assert!(message.contains("ask_user_question"));
        assert!(message.contains("exit_plan_mode"));
        assert!(
            !message.contains("subagent_type"),
            "task tool hint should be empty when no Task tool registered"
        );
    }
}
