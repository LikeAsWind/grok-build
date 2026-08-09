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
  const { consumeAcpResponder } = await import('./acpPermissionBridge')
  const respond = consumeAcpResponder(requestId)
  if (respond) {
    // reply: 'once' | 'always' | 'reject'
    const outcomeId = reply === 'always' ? 'allow_always' : reply === 'reject' ? 'reject' : 'allow_once'
    respond({
      outcome: {
        outcome: reply === 'reject' ? 'cancelled' : 'selected',
        ...(reply !== 'reject' ? { optionId: outcomeId } : {}),
        ...(message ? { message } : {}),
      },
    })
    return true
  }
  // 回退 REST
  const sdk = getSDKClient()
  if (sessionId) {
    unwrap(
      await sdk.permission.respond({
        sessionID: sessionId,
        permissionID: requestId,
        directory: formatPathForApi(directory),
        response: reply,
      }),
    )
    return true
  }
  unwrap(
    await sdk.permission.reply({
      requestID: requestId,
      directory: formatPathForApi(directory),
      reply,
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
): Promise<boolean> {
  const { consumeAcpResponder } = await import('./acpPermissionBridge')
  const respond = consumeAcpResponder(requestId)
  if (respond) {
    // ACP AskUserQuestionExtResponse 格式: { outcome: "accepted", answers: { "header": ["answer"] } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answersMap: Record<string, string[]> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    answers.forEach((a: any) => {
      const key = a.question || a.header || ''
      const val = a.answer ?? a.response ?? ''
      if (key) answersMap[key] = [val]
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
