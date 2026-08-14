// ============================================
// Permission & Question API Functions
// 基于 @opencode-ai/sdk: /permission, /question 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { ApiPermissionRequest, PermissionReply, ApiQuestionRequest, QuestionAnswer } from './types'

// ============================================
// Permission API
// ============================================

/**
 * 获取待处理的权限请求列表
 * ACP 模式：权限请求由 session/request_permission 实时推送（交互对话框阶段接入），
 * 无历史快照可拉取
 */
export async function getPendingPermissions(_sessionId?: string, _directory?: string): Promise<ApiPermissionRequest[]> {
  return []
}

/**
 * 语义 reply → 后端下发 options 里对应 kind 的 optionId。
 * 后端按 optionId 查表映射 outcome（查不到 = Error 拒绝执行），
 * 因此必须回显真实 id，不能造。匹配不到时回退 kind 惯例 id
 * （always-allow / allow-once / reject-once，对齐后端 fallback_options）。
 */
function resolveOptionId(reply: 'once' | 'always' | 'reject', options: Array<{ id: string; kind: string }>): string {
  const kindOf = (kinds: string[]) => options.find(o => kinds.includes(o.kind))?.id
  switch (reply) {
    case 'always':
      return kindOf(['allow_always']) ?? kindOf(['allow_once']) ?? 'always-allow'
    case 'reject':
      return kindOf(['reject_once']) ?? 'reject-once'
    default:
      return kindOf(['allow_once']) ?? 'allow-once'
  }
}

/**
 * 回复权限请求
 * ACP 模式优先：检查是否有待处理的 respond 回调（来自 acp:requestPermission），
 * 有则直接回包给 ACP；无则走 REST（已 stub 安全返回）
 */
export async function replyPermission(
  requestId: string,
  reply: PermissionReply,
  message?: string,
  directory?: string,
  sessionId?: string,
): Promise<boolean> {
  // ACP 模式：检查待处理的 respond 回调
  const { consumeAcpResponder, peekAcpPermissionOptions } = await import('./acpPermissionBridge')
  const options = peekAcpPermissionOptions(requestId)
  const respond = consumeAcpResponder(requestId)
  if (respond) {
    // 动态按钮直接携带 optionId；语义值（once/always/reject）解析成对应选项。
    // 拒绝也走 selected + reject-once（cancelled 语义是"取消提问"，非用户拒绝）。
    const optionId = typeof reply === 'object' ? reply.optionId : resolveOptionId(reply, options)
    respond({
      outcome: {
        outcome: 'selected',
        optionId,
        ...(message ? { message } : {}),
      },
    })
    return true
  }
  // 回退 REST（stub 路径只认语义值；optionId 形式降级为 once）
  const restReply = typeof reply === 'object' ? 'once' : reply
  const sdk = getSDKClient()
  if (sessionId) {
    unwrap(
      await sdk.permission.respond({
        sessionID: sessionId,
        permissionID: requestId,
        directory: formatPathForApi(directory),
        response: restReply,
      }),
    )
    return true
  }
  unwrap(
    await sdk.permission.reply({
      requestID: requestId,
      directory: formatPathForApi(directory),
      reply: restReply,
      message,
    }),
  )
  return true
}

// ============================================
// Question API
// ============================================

/**
 * 获取待处理的问题请求列表
 * ACP 模式：同权限请求，实时推送、无历史快照
 */
export async function getPendingQuestions(_sessionId?: string, _directory?: string): Promise<ApiQuestionRequest[]> {
  return []
}

/**
 * 回复问题请求
 */
export async function replyQuestion(
  requestId: string,
  answers: QuestionAnswer[],
  directory?: string,
  questions?: { header?: string; question?: string }[],
): Promise<boolean> {
  const { consumeAcpResponder } = await import('./acpPermissionBridge')
  const respond = consumeAcpResponder(requestId)
  if (respond) {
    // ACP AskUserQuestionExtResponse 格式: { outcome: "accepted", answers: { "header": ["answer"] } }
    // QuestionAnswer = string[], parallel to questions[] — 用 question header 做 key
    const answersMap: Record<string, string[]> = {}
    answers.forEach((selected, idx) => {
      const key = questions?.[idx]?.header || questions?.[idx]?.question || `q${idx}`
      answersMap[key] = Array.isArray(selected) ? selected : [String(selected)]
    })
    respond({ outcome: 'accepted', answers: answersMap })
    return true
  }
  const sdk = getSDKClient()
  unwrap(await sdk.question.reply({ requestID: requestId, directory: formatPathForApi(directory), answers }))
  return true
}

/**
 * 拒绝问题请求
 */
export async function rejectQuestion(requestId: string, directory?: string): Promise<boolean> {
  const { consumeAcpResponder } = await import('./acpPermissionBridge')
  const respond = consumeAcpResponder(requestId)
  if (respond) {
    respond({ outcome: 'cancelled' })
    return true
  }
  const sdk = getSDKClient()
  unwrap(await sdk.question.reject({ requestID: requestId, directory: formatPathForApi(directory) }))
  return true
}
