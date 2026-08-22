// ============================================
// Session API Functions — ACP 化
// ============================================

import { normalizeTodoItems } from './todo'
import { acpNewSession, acpCancel, acpExtRequest, getServerCwd } from './acpBridge'
import { injectGlobalEvent } from './events'
import { sessionCwdForWire } from './sessionCwd'
import { QUEUED_MESSAGE_ID_PREFIX } from '../features/message/queuedMessage'
import type { ApiSession, SessionListParams, FileDiff } from './types'
import type { GlobalEvent } from '../types/api/event'
import type { SessionStatusMap } from '../types/api/session'
import type { TodoItem } from '../types/api/event'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 把 Web 端本地消息 id 映射为后端 prompt index。
 * 后端 rewind/fork 以 targetPromptIndex（用户 prompt 的序号）定位——
 * Web 的消息 id 是本地合成的（msg_u_*），后端不认识。
 * 序号 = 该用户消息在会话可见消息里的第几条 user 消息（排除排队占位）。
 */
async function promptIndexForMessage(sessionId: string, messageId: string): Promise<number> {
  const { messageStore } = await import('../store/messageStore')
  const state = messageStore.getSessionState(sessionId)
  const userMessages = (state?.messages ?? []).filter(
    m => m.info.role === 'user' && !m.info.id.startsWith(QUEUED_MESSAGE_ID_PREFIX),
  )
  const idx = userMessages.findIndex(m => m.info.id === messageId)
  if (idx < 0) throw new Error(`定位 prompt index 失败：未找到用户消息 ${messageId}`)
  return idx
}

interface RosterEntry {
  sessionId: string
  title?: string | null
  cwd: string
  lastChangeUnixMs?: number
  additions?: number
  deletions?: number
  files?: number
  /** true = 进程内仍有 resident actor 驱动该会话（不论 busy/idle）；false = 仅存在于磁盘 */
  resident?: boolean
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
    additions: entry.additions,
    deletions: entry.deletions,
    files: entry.files,
    resident: entry.resident,
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
 *
 * 后端契约（ForkSessionRequest，camelCase）：sourceSessionId / sourceCwd /
 * newCwd 必填，targetPromptIndex 可选——指定后新会话只包含该 prompt 之前的
 * 历史（点击的消息本身不包含，内容由调用方恢复到输入框）。
 */
export async function forkSession(sessionId: string, messageId?: string, directory?: string): Promise<ApiSession> {
  // 会话存储按 cwd 的 URL 编码目录定位，斜杠方向敏感——保持后端原生形式，
  // 不得强转成正斜杠（否则源/目标目录编码与既有会话不一致，fork 找不到源）。
  const sourceCwd = sessionCwdForWire(directory || getServerCwd())
  const resp = (await acpExtRequest('x.ai/session/fork', {
    sourceSessionId: sessionId,
    sourceCwd,
    newCwd: sourceCwd,
    ...(messageId ? { targetPromptIndex: await promptIndexForMessage(sessionId, messageId) } : {}),
  })) as unknown
  if (isRecord(resp) && typeof resp.newSessionId === 'string') {
    const forked = await getSession(resp.newSessionId, directory)
    // fork 不走 useSessions.create()，后端也没有 session.created 推送——
    // 手动广播，侧栏会话列表才能立即出现新分支
    injectGlobalEvent({
      directory: forked.directory,
      payload: { type: 'session.created', properties: { info: forked } },
    } as unknown as GlobalEvent)
    return forked
  }
  throw new Error('fork session 未返回 newSessionId')
}

/**
 * 回退消息 → ACP x.ai/rewind/execute
 *
 * 后端契约：targetPromptIndex 必填（messageId 后端不认识）；不带 force 是
 * 预检（success:false 不执行），Web 端点击撤销即确认，直接 force 执行。
 * rewind 到 index k = 删除第 k 条用户 prompt 及其之后的全部历史（破坏性）。
 */
export async function revertMessage(
  sessionId: string,
  messageId: string,
  _partId?: string,
  _directory?: string,
): Promise<ApiSession> {
  const targetPromptIndex = await promptIndexForMessage(sessionId, messageId)
  const resp = (await acpExtRequest('x.ai/rewind/execute', {
    sessionId,
    targetPromptIndex,
    force: true,
  })) as unknown
  if (isRecord(resp) && resp.success === false) {
    throw new Error(typeof resp.error === 'string' && resp.error ? resp.error : 'rewind 未成功')
  }
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
 * 获取子 session。
 * ACP roster 无父子关系——从 childSessionStore（subagent_spawned / 恢复的
 * completion 通知）读取记录，优先用 roster 里的真实 ApiSession，缺席时
 * 合成最小条目（title = spawn description）。
 */
export async function getSessionChildren(sessionId: string, _directory?: string): Promise<ApiSession[]> {
  const { childSessionStore } = await import('../store/childSessionStore')
  const infos = childSessionStore.getChildSessions(sessionId)
  if (!infos.length) return []
  const roster = await getSessions().catch(() => [] as ApiSession[])
  const byId = new Map(roster.map(s => [s.id, s]))
  return infos.map(info => {
    const live = byId.get(info.id)
    if (live) return { ...live, parentID: info.parentID, title: live.title || info.title } as ApiSession
    return {
      id: info.id,
      parentID: info.parentID,
      title: info.title,
      directory: '',
      version: '',
      time: { created: info.createdAt, updated: info.createdAt },
    } as unknown as ApiSession
  })
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
