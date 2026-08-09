// ============================================
// Message API Functions
// 基于 @opencode-ai/sdk: /session/{sessionID}/message 相关接口
// ============================================

import { acpPrompt } from './acpBridge'
import type {
  ApiMessageWithParts,
  ApiAgentPart,
  ApiTextPart,
  ApiFilePart,
  Attachment,
  RevertedMessage,
  SendMessageParams,
  SendMessageResponse,
} from './types'

type UserContentSource = {
  parts: Array<
    | ApiTextPart
    | ApiFilePart
    | ApiAgentPart
    | {
        type: string
      }
  >
}

function isTextUserContentPart(part: UserContentSource['parts'][number]): part is ApiTextPart {
  return part.type === 'text' && 'text' in part
}

function isFileUserContentPart(part: UserContentSource['parts'][number]): part is ApiFilePart {
  return part.type === 'file' && 'mime' in part && 'url' in part
}

function isAgentUserContentPart(part: UserContentSource['parts'][number]): part is ApiAgentPart {
  return part.type === 'agent' && 'name' in part
}

// ============================================
// Message Query
// ============================================

/**
 * 获取 session 的消息列表
 *
 * ACP 模式：消息以 session/update 流实时进入 messageStore，
 * 这里返回内存快照（loadSession 拿它回填等价于恒等操作，不会清掉实时消息）。
 * 历史回放（session/load）在会话管理阶段接入。
 */
export async function getSessionMessages(
  sessionId: string,
  _limit?: number,
  _directory?: string,
): Promise<ApiMessageWithParts[]> {
  const { messageStore } = await import('../store/messageStore')
  const state = messageStore.getSessionState(sessionId)
  if (!state) return []
  return state.messages.map(m => ({ info: m.info, parts: m.parts }) as ApiMessageWithParts)
}

/**
 * 获取 session 的消息数量
 */
export async function getSessionMessageCount(sessionId: string): Promise<number> {
  const messages = await getSessionMessages(sessionId)
  return messages.length
}

// ============================================
// Message Content Extraction
// ============================================

/**
 * 从 API 消息中提取用户消息内容（文本+附件）
 */
export function extractUserMessageContent(message: UserContentSource): RevertedMessage {
  const { parts } = message

  const textParts = parts.filter((part): part is ApiTextPart => isTextUserContentPart(part) && !part.synthetic)
  const text = textParts.map(p => p.text).join('\n')

  const attachments: Attachment[] = []

  const getSourcePath = (source: ApiFilePart['source']): string | undefined => {
    if (!source || !('path' in source)) return undefined
    return source.path
  }

  for (const part of parts) {
    if (isFileUserContentPart(part)) {
      const isFolder = part.mime === 'application/x-directory'
      const sourcePath = getSourcePath(part.source)
      attachments.push({
        id: part.id || crypto.randomUUID(),
        type: isFolder ? 'folder' : 'file',
        displayName: part.filename || sourcePath || 'file',
        url: part.url,
        mime: part.mime,
        relativePath: sourcePath,
        textRange: part.source?.text
          ? {
              value: part.source.text.value,
              start: part.source.text.start,
              end: part.source.text.end,
            }
          : undefined,
      })
    } else if (isAgentUserContentPart(part)) {
      attachments.push({
        id: part.id || crypto.randomUUID(),
        type: 'agent',
        displayName: part.name,
        agentName: part.name,
        textRange: part.source
          ? {
              value: part.source.value,
              start: part.source.start,
              end: part.source.end,
            }
          : undefined,
      })
    }
  }

  return { text, attachments }
}

// ============================================
// Send Message
// ============================================

/**
 * 同步发送消息（ACP: 发出 prompt，流式回复经 acpBridge 注入事件）
 */
export async function sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
  await sendMessageAsync(params)
  return {} as SendMessageResponse
}

/**
 * 异步发送消息 — 立即返回，AI 响应通过 ACP session/update 流推送
 */
export async function sendMessageAsync(params: SendMessageParams): Promise<void> {
  // 附件（文件/agent 提及）在后续阶段接入 ACP prompt content blocks，
  // 目前只发送文本
  await acpPrompt({
    sessionId: params.sessionId,
    text: params.text,
    modelId: params.model?.modelID,
    agent: params.agent,
    variant: params.variant,
    mode: params.mode,
  })
}
