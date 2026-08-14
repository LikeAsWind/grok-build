// ============================================
// ACP 权限/问题桥接 — 监听 acpBridge 的 CustomEvent，
// 将 ACP session/request_permission 和 x.ai/ask_user_question
// 转译为 OpenCodeUI 的 permission.asked / question.asked 事件格式
// ============================================

import type { ApiPermissionRequest, ApiQuestionRequest } from './types'
import type { PermissionOptionInfo } from '../types/api/permission'

// ── 应答回调注册（请求 ID → ACP respond 函数 + 后端下发的选项）──────────

interface PendingAcpResponder {
  respond: (response: Record<string, unknown>) => void
  /** 后端 prompter 下发的选项；replyPermission 据此把语义值解析成真实 optionId */
  options: PermissionOptionInfo[]
}

const respondCallbacks = new Map<string, PendingAcpResponder>()

/** 注册 ACP 应答回调（options 供语义 reply 解析 optionId，回包须原样回显） */
export function registerAcpResponder(
  requestId: string,
  respond: (r: Record<string, unknown>) => void,
  options: PermissionOptionInfo[] = [],
) {
  respondCallbacks.set(requestId, { respond, options })
}

/** 查看待应答请求的选项列表（不消费；消费前调用） */
export function peekAcpPermissionOptions(requestId: string): PermissionOptionInfo[] {
  return respondCallbacks.get(requestId)?.options ?? []
}

/** 取回并消费 ACP 应答回调 */
export function consumeAcpResponder(requestId: string): ((r: Record<string, unknown>) => void) | null {
  const entry = respondCallbacks.get(requestId) ?? null
  respondCallbacks.delete(requestId)
  return entry?.respond ?? null
}

// ── 数据映射 ───────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function mapAcpPermissionToApi(params: Record<string, unknown>): ApiPermissionRequest | null {
  const sessionId = String(params.sessionId ?? params.session_id ?? '')
  const tc = isRecord(params.toolCall) ? params.toolCall : (isRecord(params.tool_call) ? params.tool_call : null)
  if (!tc || !sessionId) return null
  const title = typeof tc.title === 'string' ? tc.title : 'tool'
  const tool = typeof tc.title === 'string' ? tc.title : 'unknown'
  const args = isRecord(tc.rawInput) ? tc.rawInput : (isRecord(tc.raw_input) ? tc.raw_input : {})
  const options = Array.isArray(params.options) ? params.options : []
  const toolCallId = String(tc.toolCallId ?? tc.tool_call_id ?? '')
  const id = String(params.permissionId ?? params.permission_id ?? (toolCallId || `perm-${sessionId}-${Date.now()}`))
  return {
    id,
    sessionID: sessionId,
    tool,
    permission: tool,
    patterns: [title],
    args,
    // 内嵌权限 UI 按 tool.callID 关联工具卡片（findPermissionRequestForTool）
    ...(toolCallId ? { tool: { callID: toolCallId, messageID: '' } } : {}),
    options: options
      .map((o: unknown) => ({
        id: isRecord(o) ? String(o.optionId ?? o.option_id ?? '') : '',
        name: isRecord(o) ? String(o.name ?? '') : '',
        kind: isRecord(o) ? String(o.kind ?? 'allow_once') : 'allow_once',
      }))
      .filter(o => o.id !== ''),
  } as unknown as ApiPermissionRequest
}

export function mapAcpQuestionToApi(params: unknown): ApiQuestionRequest | null {
  if (!isRecord(params)) return null
  const sessionId = String(params.sessionId ?? params.session_id ?? '')
  const questions = Array.isArray(params.questions) ? params.questions : []
  if (!sessionId || questions.length === 0) return null
  const id = String(params.questionId ?? params.question_id ?? `q-${sessionId}-${Date.now()}`)
  const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId : ''
  return {
    id,
    sessionID: sessionId,
    questions: questions.map((q: unknown) => {
      if (!isRecord(q)) return { header: '', question: '' }
      return {
        header: String(q.header ?? q.question ?? ''),
        question: String(q.question ?? q.header ?? ''),
        options: Array.isArray(q.options) ? q.options : undefined,
      }
    }),
    ...(toolCallId ? { tool: { callID: toolCallId, messageID: '' } } : {}),
  } as unknown as ApiQuestionRequest
}
