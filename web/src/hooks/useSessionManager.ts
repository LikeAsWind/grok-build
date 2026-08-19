// ============================================
// useSessionManager - Session 加载和状态管理
// ============================================
//
// 职责：
// 1. 加载 session 消息（初始加载 + 懒加载历史）
// 2. 处理 undo/redo（调用 API + 更新 store）
// 3. 只管理单个 session 的加载状态，不再承担全局当前 session 同步

import { useCallback, useEffect, useRef } from 'react'
import { logger } from '../utils/logger'
import { toApiMessageWithParts } from '../utils/messageConversion'
import { messageStore, type SessionState } from '../store'
import {
  getSessionMessages,
  getSession,
  revertMessage,
  unrevertSession,
  type ApiMessageWithParts,
} from '../api'
import { acpLoadSession, finishAcpReplay } from '../api/acpBridge'
import { loadSynthMessages, restoreChildSessions } from '../features/message/synthNotifPersist'
import { sessionErrorHandler } from '../utils'
import { isSessionNotFoundError } from '../utils/sessionErrors'
import { INITIAL_MESSAGE_LIMIT, HISTORY_LOAD_BATCH_SIZE } from '../constants'
import type { MessageError } from '../types/message'

function toLoadMessageError(error: unknown): MessageError {
  const message = error instanceof Error ? error.message : String(error || 'Failed to load session')
  return {
    name: 'APIError',
    data: {
      message,
      isRetryable: true,
      responseBody: error instanceof Error ? error.stack : undefined,
    },
  }
}

interface UseSessionManagerOptions {
  sessionId: string | null
  directory?: string // 当前项目目录
  onLoadComplete?: () => void
  onError?: (error: Error) => void
  onSessionMissing?: (sessionId: string) => void
}

function preferCompatiblePartText(local: string, incoming: string): string {
  if (local === incoming) return incoming
  if (local.startsWith(incoming)) return local
  if (incoming.startsWith(local)) return incoming
  return incoming
}

function messageTimeIncomplete(time?: { completed?: number } | { created: number }) {
  if (!time) return true
  return !('completed' in time) || time.completed == null
}

function mergePartsForReload(
  localParts: ApiMessageWithParts['parts'],
  apiParts: ApiMessageWithParts['parts'],
): ApiMessageWithParts['parts'] {
  const localById = new Map(localParts.map(part => [part.id, part]))
  return apiParts.map(part => {
    const local = localById.get(part.id)
    if (!local || !('text' in local) || !('text' in part)) return part
    if (typeof local.text !== 'string' || typeof part.text !== 'string') return part
    const text = preferCompatiblePartText(local.text, part.text)
    if (text === part.text) return part
    return { ...part, text: text as typeof part.text }
  })
}

function mergeWithLocalStreamingMessages(
  apiMessages: ApiMessageWithParts[],
  localState?: SessionState,
): ApiMessageWithParts[] {
  if (!localState || localState.messages.length === 0) return apiMessages

  const localById = new Map(localState.messages.map(message => [message.info.id, message]))
  const apiIds = new Set(apiMessages.map(m => m.info.id))

  // 同 message：仅未定稿时 part 文本不回退；incoming 已 completed 则强制服务端
  const mergedApi = apiMessages.map(apiMessage => {
    const local = localById.get(apiMessage.info.id)
    if (!local) return apiMessage
    if (!messageTimeIncomplete(apiMessage.info.time)) return apiMessage
    const preserve = local.isStreaming || messageTimeIncomplete(local.info.time) || localState.isStreaming
    if (!preserve) return apiMessage
    return {
      ...apiMessage,
      parts: mergePartsForReload(local.parts as ApiMessageWithParts['parts'], apiMessage.parts),
    }
  })

  const localOnly = localState.isStreaming
    ? localState.messages.filter(m => !apiIds.has(m.info.id)).map(toApiMessageWithParts)
    : []

  if (localOnly.length === 0) return mergedApi

  return [...mergedApi, ...localOnly].sort((a, b) => {
    const aCreated = a.info.time?.created ?? 0
    const bCreated = b.info.time?.created ?? 0
    return aCreated - bCreated
  })
}

/** 刚通过 createSession 创建的 sessionId，loadSession 里跳过历史回放 */
const freshSessionIds = new Set<string>()

export function markSessionFresh(sessionId: string) {
  freshSessionIds.add(sessionId)
}

export function useSessionManager({ sessionId, directory, onLoadComplete, onError, onSessionMissing }: UseSessionManagerOptions) {
  const loadSequenceRef = useRef<Map<string, number>>(new Map())
  /** 每个 session 当前已请求的消息 limit（cursor），loadMore 时递增 */
  const cursorRef = useRef<Map<string, number>>(new Map())
  const loadSessionRef = useRef<(sid: string, options?: { force?: boolean }) => Promise<void>>(async () => {})

  // 使用 ref 保存 directory，避免依赖变化
  const directoryRef = useRef(directory)

  useEffect(() => {
    directoryRef.current = directory
  }, [directory])

  // ============================================
  // Load Session
  // ============================================

  const loadSession = useCallback(
    async (sid: string, options?: { force?: boolean }) => {
      const force = options?.force ?? false

      const seq = (loadSequenceRef.current.get(sid) ?? 0) + 1
      loadSequenceRef.current.set(sid, seq)
      const isStale = () => loadSequenceRef.current.get(sid) !== seq

      const dir = directoryRef.current

      // 检查是否已有消息（SSE 可能已经推送了）
      const existingState = messageStore.getSessionState(sid)
      const hasExistingMessages = existingState && existingState.messages.length > 0
      const hasLoadedBaseline = existingState?.loadState === 'loaded' && !existingState?.isStale

      // 如果已经有消息且正在 streaming，不能覆盖消息，但仍需加载元数据
      // 仅在「已经完整加载过」时才跳过覆盖；
      // 对于仅靠 SSE 暂存出来的 session（loadState=idle），仍要做一次完整拉取
      // force 模式下也不覆盖正在 streaming 且已加载的消息
      if (hasExistingMessages && existingState.isStreaming && hasLoadedBaseline) {
        // 异步加载 session 元数据（不阻塞）
        const dir = directoryRef.current
        Promise.all([
          getSession(sid, dir).catch(() => null),
          getSessionMessages(sid, INITIAL_MESSAGE_LIMIT, dir)
            .then(messages => ({ ok: true as const, messages }))
            .catch(() => ({ ok: false as const, messages: [] as ApiMessageWithParts[] })),
        ])
          .then(([sessionInfo, messagesResult]) => {
            if (isStale()) return

            if (messagesResult.ok) {
              cursorRef.current.set(sid, Math.max(INITIAL_MESSAGE_LIMIT, messagesResult.messages.length))
            }

            messageStore.updateSessionMetadata(sid, {
              ...(messagesResult.ok ? { hasMoreHistory: messagesResult.messages.length >= INITIAL_MESSAGE_LIMIT } : {}),
              directory: sessionInfo?.directory ?? dir ?? '',
              title: sessionInfo?.title,
              shareUrl: sessionInfo?.share?.url,
            })
          })
          .catch(() => {
            // 元数据加载失败不影响 streaming，静默忽略
          })
        if (!isStale()) {
          onLoadComplete?.()
        }
        return
      }

      messageStore.setLoadState(sid, 'loading')

      // 加载期间 acpPrompt 可能已往 messageStore 放了消息，跳过覆盖
      const preLoadMessages = messageStore.getSessionState(sid)?.messages.length ?? 0

      // ACP 历史回放
      const isFresh = freshSessionIds.has(sid)
      if (isFresh) {
        freshSessionIds.delete(sid)
      } else if (!hasExistingMessages) {
        // acpLoadSession 可能因 ACP 未连接或后端报错（如 cwd 目录编码不匹配
        // 导致 Path not found）而 reject。必须兜住：否则 loadState 停在
        // 'loading'，UI 无限转圈。失败则落到下方 snapshot 路径，由它的
        // catch 统一 setLoadError / onError。
        try {
          await acpLoadSession(sid)
        } catch (loadErr) {
          console.warn('[LOAD] session/load 失败，改走 snapshot 兜底:', loadErr)
        }
        // 等回放帧 settle。固定延时对大会话不够（残帧在 loaded 之后继续流入，
        // 表现为先见到部分消息、再「闪」出完整记录），对小会话又白等——改为
        // 静默检测：消息+part 总量连续两次采样（120ms 间隔）不变即视为回放
        // 结束；有内容上限 3s，始终无内容 1.2s 退出走 snapshot 兜底。
        const settleStart = Date.now()
        let prevSize = -1
        for (;;) {
          const replayMsgs = messageStore.getSessionState(sid)?.messages ?? []
          const size = replayMsgs.length + replayMsgs.reduce((n, m) => n + m.parts.length, 0)
          if (size > 0 && size === prevSize) break
          if (Date.now() - settleStart >= (size > 0 ? 3000 : 1200)) break
          prevSize = size
          await new Promise(resolve => setTimeout(resolve, 120))
        }
        // 回放事件已 settle，关闭回放窗口（此后 task_completed 恢复 idle-gated 缓冲）
        finishAcpReplay(sid)
        const msgs = messageStore.getSessionState(sid)?.messages.length ?? 0
        if (msgs > 0) {
          // history 已通过 session/update 进入 store，直接标记 loaded，跳过后续 setMessages 覆盖
          messageStore.updateSessionMetadata(sid, { loadState: 'loaded' })
          messageStore.handleSessionIdle(sid)
          const synthEntries = loadSynthMessages(sid)
          messageStore.injectSynthMessages(sid, synthEntries)
          restoreChildSessions(sid, synthEntries)
          onLoadComplete?.()
          return
        }
      }

      try {
        // 并行加载 session 信息和消息（传递 directory）
        const [sessionInfo, apiMessages] = await Promise.all([
          getSession(sid, dir).catch(() => null),
          getSessionMessages(sid, INITIAL_MESSAGE_LIMIT, dir),
        ])

        if (isStale()) return

        // ACP: 加载期间 acpPrompt 已放入消息，不覆盖
        if (preLoadMessages > 0) {
          messageStore.updateSessionMetadata(sid, {
            hasMoreHistory: apiMessages.length >= INITIAL_MESSAGE_LIMIT,
            directory: sessionInfo?.directory ?? dir ?? '',
            title: sessionInfo?.title,
            loadState: 'loaded',
            shareUrl: sessionInfo?.share?.url,
          })
          onLoadComplete?.()
          return
        }

        // 再次检查：加载期间 SSE 可能已经推送了更多消息
        // force 模式下（重连）始终用服务器数据覆盖，因为本地数据可能不完整
        const currentState = messageStore.getSessionState(sid)
        const shouldKeepStreamingOnly =
          !force &&
          !!currentState &&
          !currentState.isStale &&
          currentState.loadState === 'loaded' &&
          currentState.messages.length > apiMessages.length

        if (shouldKeepStreamingOnly) {
          // SSE 推送的消息比 API 返回的多，说明有新消息，跳过覆盖
          // 但仍需更新元数据，否则 hasMoreHistory 等状态可能停留在默认值
          messageStore.updateSessionMetadata(sid, {
            hasMoreHistory: apiMessages.length >= INITIAL_MESSAGE_LIMIT,
            directory: sessionInfo?.directory ?? dir ?? '',
            title: sessionInfo?.title,
            loadState: 'loaded',
            shareUrl: sessionInfo?.share?.url,
          })
          onLoadComplete?.()
          cursorRef.current.set(sid, Math.max(INITIAL_MESSAGE_LIMIT, apiMessages.length))
          return
        }

        const mergedMessages = mergeWithLocalStreamingMessages(apiMessages, currentState)

        // 设置消息到 store
        messageStore.setMessages(sid, mergedMessages, {
          directory: sessionInfo?.directory ?? dir ?? '',
          title: sessionInfo?.title,
          hasMoreHistory: apiMessages.length >= INITIAL_MESSAGE_LIMIT,
          revertState: sessionInfo?.revert ?? null,
          shareUrl: sessionInfo?.share?.url,
        })
        // 历史回放完成后，消息可能缺 completed 时间戳导致 isStreaming 误判
        messageStore.handleSessionIdle(sid)
        const synthEntries = loadSynthMessages(sid)
        messageStore.injectSynthMessages(sid, synthEntries)
        restoreChildSessions(sid, synthEntries)

        cursorRef.current.set(sid, Math.max(INITIAL_MESSAGE_LIMIT, apiMessages.length))

        // force 模式（如 SSE 重连）只静默刷新数据，不触发滚动
        if (!force) {
          onLoadComplete?.()
        }
      } catch (error) {
        if (isStale()) return
        sessionErrorHandler('load session', error)
        messageStore.setLoadError(sid, toLoadMessageError(error))
        if (isSessionNotFoundError(error)) {
          onSessionMissing?.(sid)
        }
        onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    },
    [onLoadComplete, onError, onSessionMissing],
  )

  // 保持 ref 同步，避免 effect 依赖 loadSession 导致重复触发
  useEffect(() => {
    loadSessionRef.current = loadSession
  }, [loadSession])

  // ============================================
  // Load More History
  // ============================================

  const loadMoreHistory = useCallback(async () => {
    if (!sessionId) return

    const state = messageStore.getSessionState(sessionId)
    if (!state) return

    const dir = state.directory || directoryRef.current
    const currentCursor = cursorRef.current.get(sessionId) ?? Math.max(INITIAL_MESSAGE_LIMIT, state.messages.length)
    const targetCursor = currentCursor + HISTORY_LOAD_BATCH_SIZE

    try {
      const apiMessages = await getSessionMessages(sessionId, targetCursor, dir)
      cursorRef.current.set(sessionId, targetCursor)

      const latestState = messageStore.getSessionState(sessionId)
      if (!latestState) return

      // 去重 + 按时间排序
      const existingIds = new Set(latestState.messages.map(m => m.info.id))
      const prependCandidates = apiMessages
        .filter(m => !existingIds.has(m.info.id))
        .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))

      const hasMore = apiMessages.length >= targetCursor
      messageStore.prependMessages(sessionId, prependCandidates, hasMore)
    } catch (error) {
      sessionErrorHandler('load more history', error)
    }
  }, [sessionId])

  // ============================================
  // Undo
  // ============================================

  const handleUndo = useCallback(
    async (userMessageId: string): Promise<boolean> => {
      if (!sessionId) return false

      // 获取当前 session 的 directory（优先用 store 中的，其次用传入的）
      const state = messageStore.getSessionState(sessionId)
      if (!state) return false

      const dir = state.directory || directoryRef.current

      try {
        // 调用 API 执行 rewind（内部把消息 id 映射为后端 targetPromptIndex）
        await revertMessage(sessionId, userMessageId, undefined, dir)

        // grok rewind 是破坏性截断（对齐 TUI）：后端已删除该 prompt 及其后
        // 的全部历史，redo 不可能——本地同步截断，不留 redo 假象。
        // （借用 truncateAfterRevert：先设 revert 点再截断，截断后清空 revertState）
        messageStore.setRevertState(sessionId, { messageId: userMessageId, history: [] })
        messageStore.truncateAfterRevert(sessionId)
        return true
      } catch (error) {
        sessionErrorHandler('undo', error)
        return false
      }
    },
    [sessionId],
  )

  // ============================================
  // Redo
  // ============================================

  const handleRedo = useCallback(async () => {
    if (!sessionId) return

    const state = messageStore.getSessionState(sessionId)
    if (!state?.revertState) return

    const { history } = state.revertState
    if (history.length === 0) return

    const dir = state.directory || directoryRef.current

    try {
      // 移除第一条历史记录（最早撤销的）
      const newHistory = history.slice(1)

      if (newHistory.length > 0) {
        // 还有更多历史，设置新的 revert 点
        const newRevertMessageId = newHistory[0].messageId
        await revertMessage(sessionId, newRevertMessageId, undefined, dir)

        messageStore.setRevertState(sessionId, {
          messageId: newRevertMessageId,
          history: newHistory,
        })
      } else {
        // 没有更多历史，完全清除 revert 状态
        await unrevertSession(sessionId, dir)
        messageStore.setRevertState(sessionId, null)
      }
    } catch (error) {
      sessionErrorHandler('redo', error)
    }
  }, [sessionId])

  // ============================================
  // Redo All
  // ============================================

  const handleRedoAll = useCallback(async () => {
    if (!sessionId) return

    const state = messageStore.getSessionState(sessionId)
    const dir = state?.directory || directoryRef.current

    try {
      await unrevertSession(sessionId, dir)
      messageStore.setRevertState(sessionId, null)
    } catch (error) {
      sessionErrorHandler('redo all', error)
    }
  }, [sessionId])

  // ============================================
  // Clear Revert
  // ============================================

  const clearRevert = useCallback(() => {
    if (!sessionId) return
    messageStore.setRevertState(sessionId, null)
  }, [sessionId])

  // ============================================
  // Effects
  // ============================================

  // 根据 sessionId 切换缓存视图。
  // focused pane / URL 的同步由 App 顶层统一负责，
  // 这里不再写任何“全局当前 session”状态。
  useEffect(() => {
    if (sessionId) {
      const cached = messageStore.getSessionState(sessionId)
      const canUseCached = !!cached && cached.loadState === 'loaded' && !cached.isStale && cached.messages.length > 0

      if (canUseCached) {
        const cachedCursor = Math.max(INITIAL_MESSAGE_LIMIT, cached.messages.length)
        const prevCursor = cursorRef.current.get(sessionId) ?? 0
        if (cachedCursor > prevCursor) {
          cursorRef.current.set(sessionId, cachedCursor)
        }

        logger.log('[SessionManager] switch:use-cached', {
          sessionId,
          cachedCount: cached.messages.length,
        })
        return
      }

      logger.log('[SessionManager] switch:fetch-session', { sessionId })
      void loadSessionRef.current(sessionId)
    }
  }, [sessionId])

  // ACP 意外断开自动重连成功后，重新拉取当前会话快照，
  // 补齐断线窗口内丢失的流式帧（后端 MvpAgent 跨重连持久，历史已落盘）
  useEffect(() => {
    if (!sessionId) return
    const onReconnected = () => {
      void loadSessionRef.current(sessionId)
    }
    window.addEventListener('acp:reconnected', onReconnected)
    return () => window.removeEventListener('acp:reconnected', onReconnected)
  }, [sessionId])

  return {
    loadSession,
    loadMoreHistory,
    handleUndo,
    handleRedo,
    handleRedoAll,
    clearRevert,
  }
}
