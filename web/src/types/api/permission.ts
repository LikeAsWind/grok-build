import type {
  PermissionRequest as SDKPermissionRequest,
  QuestionAnswer as SDKQuestionAnswer,
  QuestionInfo as SDKQuestionInfo,
  QuestionOption as SDKQuestionOption,
  QuestionRequest as SDKQuestionRequest,
} from '@opencode-ai/sdk/v2/client'

export type PermissionToolInfo = NonNullable<SDKPermissionRequest['tool']>

/** ACP 权限请求下发的可选项（后端 prompter 动态构建，如 allow-always-command） */
export interface PermissionOptionInfo {
  /** 后端 PermissionOptionId，回包时原样回显 */
  id: string
  /** 后端生成的展示文案（可能含动态命令，如 "Always allow: git push"） */
  name: string
  /** ACP wire kind：allow_once / allow_always / reject_once / reject_always */
  kind: string
}

export type PermissionRequest = SDKPermissionRequest & {
  /** ACP 模式下后端下发的选项列表；REST 旧路径无此字段 */
  options?: PermissionOptionInfo[]
}

/**
 * 权限应答：语义值（once/always/reject，由 replyPermission 解析成后端
 * options 里对应 kind 的 optionId）或直接指定 optionId（动态按钮路径）。
 */
export type PermissionReply = 'once' | 'always' | 'reject' | { optionId: string }

export type QuestionOption = SDKQuestionOption

export type QuestionInfo = SDKQuestionInfo

export type QuestionRequest = SDKQuestionRequest

export type QuestionAnswer = SDKQuestionAnswer
