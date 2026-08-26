import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { acpExtRequest } from '../api/acpBridge'
import type { ContextInfo } from '../types/api/context'
import { useSessionStats } from './useSessionStats'
import type { SessionStats } from './useSessionStats'

const XAI_SESSION_INFO = 'x.ai/session/info'

export interface UseContextInfoResult {
  info: ContextInfo | null
  loading: boolean
  error: Error | null
  refresh: () => void
}

/**
 * 拉取后端 `ContextInfo` 快照。
 *
 * - 初次挂载时拉一次
 * - 每次 `session.idle` 触发时 refetch（turn 边界 token 用量稳定）
 * - 失败时 `info === null`，UI 层自己决定 fallback（本 hook 同时把本地 `useSessionStats`
 *   的结果通过 `local` 字段暴露，便于在加载前/失败时渲染本地估算）
 */
/** 后端启动阶段计时字段是后台任务异步填充的（技能发现重跑、MCP handshake 等待），
 * 跟会话初始化并行，不保证首次快照请求时已完成。这几个字段仍是 `undefined` 时，
 * 说明对应的 StatusBadge 还在转圈——需要继续轮询直到全部到位，不能只等 `session.idle`
 * （一个刚创建、还没发过消息的会话永远不会触发 idle，导致状态卡死转圈）。 */
function hasPendingStartupPhase(ctx: ContextInfo): boolean {
  return (
    ctx.skillDiscoveryElapsedMs === undefined ||
    ctx.systemPromptBuildElapsedMs === undefined ||
    ctx.toolRegistryPrepElapsedMs === undefined ||
    ctx.mcpStartupElapsedMs === undefined
  )
}

const STARTUP_POLL_INTERVAL_MS = 1000
/** 跟后端 `startup_phase_timing_tests.rs` 的 "5s 内必须填充" 承诺留够余量 */
const STARTUP_POLL_TIMEOUT_MS = 15000

export function useContextInfo(sessionId: string | null): UseContextInfoResult {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const inFlight = useRef<AbortController | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollStartedAt = useRef<number | null>(null)

  const clearPoll = useCallback(() => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const fetchInfo = useCallback(async (sid: string) => {
    inFlight.current?.abort()
    const ctrl = new AbortController()
    inFlight.current = ctrl
    setLoading(true)
    try {
      const resp = await acpExtRequest(XAI_SESSION_INFO, { sessionId: sid })
      if (ctrl.signal.aborted) return
      const ctx = unwrapContextInfo(resp)
      if (ctx) {
        setInfo(ctx)
        setError(null)
        if (hasPendingStartupPhase(ctx)) {
          pollStartedAt.current ??= Date.now()
          if (Date.now() - pollStartedAt.current < STARTUP_POLL_TIMEOUT_MS) {
            clearPoll()
            pollTimer.current = setTimeout(() => setTick((t) => t + 1), STARTUP_POLL_INTERVAL_MS)
          }
        } else {
          pollStartedAt.current = null
        }
      } else {
        setError(new Error('Unexpected response shape for x.ai/session/info'))
      }
    } catch (e) {
      if (ctrl.signal.aborted) return
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      if (!ctrl.signal.aborted) setLoading(false)
    }
  }, [clearPoll])

  useEffect(() => {
    if (!sessionId) {
      setInfo(null)
      setError(null)
      pollStartedAt.current = null
      clearPoll()
      return
    }
    void fetchInfo(sessionId)
    return () => {
      inFlight.current?.abort()
      clearPoll()
    }
  }, [sessionId, tick, fetchInfo, clearPoll])

  // 订阅 session.idle：每次 turn 结束 refetch
  useEffect(() => {
    if (!sessionId) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionID: string }>).detail
      if (detail?.sessionID === sessionId) setTick((t) => t + 1)
    }
    window.addEventListener('session.idle', handler as EventListener)
    return () => window.removeEventListener('session.idle', handler as EventListener)
  }, [sessionId])

  const refresh = useCallback(() => {
    pollStartedAt.current = null
    setTick((t) => t + 1)
  }, [])

  return { info, loading, error, refresh }
}

function isContextInfo(v: unknown): v is ContextInfo {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.used === 'number' && typeof r.total === 'number' && Array.isArray(r.usageCategories)
}

/**
 * 后端 `x.ai/session/info` 返回 `SessionInfoResponse { sessionId, cwd, context: ContextInfo, ... }`，
 * 这里把 `context` 字段拆出来。容忍直接返回 ContextInfo 的形状（用于单测）。
 */
function unwrapContextInfo(resp: unknown): ContextInfo | null {
  if (!resp || typeof resp !== 'object') return null
  const r = resp as Record<string, unknown>
  const ctx = r.context
  if (ctx && typeof ctx === 'object' && isContextInfo(ctx)) return ctx
  if (isContextInfo(resp)) return resp
  return null
}

/**
 * 同时返回 backend `ContextInfo` + 本地 fallback 的便捷 hook。
 * 调用方在 `info === null`（加载中 / 失败 / 该 session 没数据）时用 `local` 兜底渲染。
 */
export interface UseContextInfoWithLocalResult extends UseContextInfoResult {
  local: SessionStats
}

export function useContextInfoWithLocal(
  sessionId: string | null,
  contextLimit = 200000,
): UseContextInfoWithLocalResult {
  const remote = useContextInfo(sessionId)
  const local = useSessionStats(contextLimit)
  return { ...remote, local }
}

// re-export for backwards-compat with imports of `useSyncExternalStore` from this module
export { useSyncExternalStore }
