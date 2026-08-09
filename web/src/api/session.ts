// ============================================
// Session API Functions — ACP 化
// ============================================

import { normalizeTodoItems } from './todo'
import { acpNewSession, acpCancel, acpExtRequest, getServerCwd } from './acpBridge'
import type { ApiSession, SessionListParams, FileDiff } from './types'
import type { SessionStatusMap } from '../types/api/session'
import type { TodoItem } from '../types/api/event'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

interface RosterEntry {
  sessionId: string
  title?: string | null
  cwd: string
  lastChangeUnixMs?: number
}

// ============================================
// Session Status & Diff
// ============================================

/**
 * 获取所有 session 的当前状态
 * ACP 模式：状态通过 session.status 事件实时推送，这里返回空快照
 */
export async function getSessionStatus(_directory?: string): Promise<SessionStatusMap> {
  return {}
}

/**
 * 获取 session 的 diff
 * ACP 模式：diff 通过 session/update 中的 tool_call 内容块实时推送，无批量拉取
 */
export async function getSessionDiff(_sessionId: string, _directory?: string, _messageId?: string): Promise<FileDiff[]> {
  return []
}

// ============================================
// Session CRUD
// ============================================

/**
 * 获取 session 列表 → ACP x.ai/sessions/list
 */
export async function getSessions(_params: SessionListParams = {}): Promise<ApiSession[]> {
  const resp = (await acpExtRequest('x.ai/sessions/list')) as unknown
  if (!isRecord(resp) || !Array.isArray(resp.sessions)) return []
  return (resp.sessions as RosterEntry[]).map(mapRosterToSession)
}

function mapRosterToSession(entry: RosterEntry): ApiSession {
  const ts = entry.lastChangeUnixMs ?? Date.now()
  return {
    id: entry.sessionId,
    directory: entry.cwd,
    title: entry.title ?? '',
    version: '',
    time: { created: ts, updated: ts },
  } as unknown as ApiSession
}

/**
 * 获取单个 session
 */
export async function getSession(sessionId: string, _directory?: string): Promise<ApiSession> {
  // 先从列表查找
  try {
    const list = await getSessions()
    const found = list.find(s => s.id === sessionId)
    if (found) return found
  } catch { /* 列表失败，回退本地 */ }
  return {
    id: sessionId,
    directory: getServerCwd(),
    title: '',
    version: '',
    time: { created: Date.now(), updated: Date.now() },
  } as unknown as ApiSession
}

/**
 * 创建 session → ACP session/new
 */
export async function createSession(
  params: {
    directory?: string
    title?: string
    parentID?: string
  } = {},
): Promise<ApiSession> {
  const info = await acpNewSession(params.directory)
  return {
    id: info.id,
    directory: info.directory,
    title: params.title ?? info.title,
    version: '',
    time: info.time,
  } as unknown as ApiSession
}

/**
 * 更新 session（重命名/归档 → ACP ext）
 */
export async function updateSession(
  sessionId: string,
  params: { title?: string; time?: { archived?: number } },
  _directory?: string,
): Promise<ApiSession> {
  if (params.title !== undefined) {
    await acpExtRequest('x.ai/session/rename', { sessionId, title: params.title })
  }
  // 归档无直接 ACP 支持，回退为 close
  if (params.time?.archived) {
    await acpExtRequest('x.ai/session/close', { sessionId })
  }
  return getSession(sessionId)
}

/**
 * 删除 session → ACP x.ai/session/delete
 */
export async function deleteSession(sessionId: string, _directory?: string): Promise<boolean> {
  await acpExtRequest('x.ai/session/delete', { sessionId })
  return true
}

/**
 * 中止 session → ACP session/cancel
 */
export async function abortSession(sessionId: string, _directory?: string): Promise<boolean> {
  await acpCancel(sessionId)
  return true
}

/**
 * Fork session → ACP x.ai/session/fork
 */
export async function forkSession(sessionId: string, messageId?: string, directory?: string): Promise<ApiSession> {
  const resp = (await acpExtRequest('x.ai/session/fork', {
    sessionId,
    ...(messageId ? { messageId } : {}),
    ...(directory ? { directory } : {}),
  })) as unknown
  if (isRecord(resp) && typeof resp.sessionId === 'string') {
    return getSession(resp.sessionId as string, directory)
  }
  throw new Error('fork session 未返回 sessionId')
}

/**
 * 回退消息 → ACP x.ai/rewind/execute
 */
export async function revertMessage(
  sessionId: string,
  messageId: string,
  _partId?: string,
  _directory?: string,
): Promise<ApiSession> {
  await acpExtRequest('x.ai/rewind/execute', { sessionId, messageId })
  return getSession(sessionId)
}

/**
 * 恢复已回退的消息
 */
export async function unrevertSession(sessionId: string, _directory?: string): Promise<ApiSession> {
  // grok rewind 暂不支持全局 unrevert，清空 revert 点等价于无操作
  return getSession(sessionId)
}

/**
 * 分享 session → ACP x.ai/share_session
 */
export async function shareSession(sessionId: string, _directory?: string): Promise<ApiSession> {
  await acpExtRequest('x.ai/share_session', { sessionId })
  return getSession(sessionId)
}

/**
 * 取消分享 session
 */
export async function unshareSession(_sessionId: string, _directory?: string): Promise<ApiSession> {
  return getSession(_sessionId)
}

/**
 * 总结 session (compact)
 */
export async function summarizeSession(
  sessionId: string,
  _params: { providerID: string; modelID: string; auto?: boolean },
  _directory?: string,
): Promise<boolean> {
  await acpExtRequest('x.ai/compact_conversation', { sessionId })
  return true
}

/**
 * 获取当前可见用户消息对应的本轮 diff
 */
export async function getLastTurnDiff(_sessionId: string, _directory?: string): Promise<FileDiff[]> {
  return []
}

/**
 * 获取子 session
 * ACP roster 无父子关系，返回空
 */
export async function getSessionChildren(_sessionId: string, _directory?: string): Promise<ApiSession[]> {
  return []
}

/**
 * Session Todo
 */
export type ApiTodo = TodoItem

/**
 * 获取 session 的 todo 列表
 * ACP 模式：todo 由 plan 事件实时推送（todo.updated），初始快照为空
 */
export async function getSessionTodos(_sessionId: string, _directory?: string): Promise<ApiTodo[]> {
  return normalizeTodoItems([])
}
