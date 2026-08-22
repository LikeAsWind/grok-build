import { useEffect, useRef, useState } from 'react'
import { acpExtRequest } from '../../api/acpBridge'
import type { ApiSession } from '../../api'

export interface SessionDiffStats {
  additions: number
  deletions: number
  files: number
  /** true = 来自实时查询；false = 来自落盘快照（可能过时）*/
  isLive: boolean
}

interface RawDiffStats {
  additions: number
  deletions: number
  files: number
}

interface QueryResult {
  id: string
  data: RawDiffStats | null
  success: boolean
}

/**
 * 并行查询多个活跃会话的 diff 统计（不是真正的 batch API）。
 *
 * 注意：这不是后端的 batch-summary 接口，而是前端并行发起多个
 * x.ai/hunk-tracker/get-summary 请求。每个会话一个独立请求。
 *
 * ACP ext 请求体走 camelCase（后端 `GetSummaryRequest` 带
 * `#[serde(rename_all = "camelCase")]`），字段名必须是 `sessionId`——
 * 传 `session_id` 会被 serde 当未知字段忽略，`#[serde(default)]`
 * 让它静默变成 `None`，后端直接 reject，查询恒失败但不报错。
 *
 * 状态流：
 * - 进入文件夹视图时触发一次查询
 * - resident session 列表内容变化时重新查询（按内容比较，不是按数组引用）
 * - 暂不实现自动轮询刷新（等实际需求再加）
 */
export function useResidentSessionDiffStats(
  residentIds: string[],
  sessions: ApiSession[]
): Map<string, SessionDiffStats> {
  const [statsMap, setStatsMap] = useState<Map<string, SessionDiffStats>>(new Map())

  // sessions 数组几乎每次 roster 刷新都会换新引用（即使内容不变）。
  // 用 ref 存最新快照，effect 内部读取，不放进依赖数组——避免 sessions
  // 引用抖动触发重复查询（P0：sessions 引用变化但内容相同时不应重查）。
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  // 依赖按内容而非引用比较：residentIds 数组引用同样会抖动，
  // 用逗号拼接成字符串才能让 useEffect 的依赖比较落在"内容相同"上。
  // 先排序再拼接——否则同一批 id 换个顺序（后端 roster 按最近改动时间
  // 排序，活跃会话的顺序会随活动频繁变化）也会被当成"内容变了"重新查询。
  const residentIdsKey = [...residentIds].sort().join(',')

  useEffect(() => {
    const ids = residentIdsKey ? residentIdsKey.split(',') : []

    if (ids.length === 0) {
      setStatsMap(prev => (prev.size === 0 ? prev : new Map()))
      return
    }

    let cancelled = false

    // 并行查询所有活跃会话（每个会话一个独立请求）
    const promises: Promise<QueryResult>[] = ids.map(id =>
      acpExtRequest('x.ai/hunk-tracker/get-summary', { sessionId: id })
        .then((resp: unknown) => {
          const summary = resp as {
            stats?: { acceptedLinesAdded?: number; acceptedLinesRemoved?: number }
            pendingLinesAdded?: number
            pendingLinesRemoved?: number
            filesModified?: number
          }
          const additions =
            (summary.stats?.acceptedLinesAdded ?? 0) + (summary.pendingLinesAdded ?? 0)
          const deletions =
            (summary.stats?.acceptedLinesRemoved ?? 0) + (summary.pendingLinesRemoved ?? 0)
          const files = summary.filesModified ?? 0
          return { id, data: { additions, deletions, files }, success: true }
        })
        .catch((err: unknown): QueryResult => {
          console.warn(`[useResidentSessionDiffStats] 查询会话 ${id} 的 diff 统计失败，回退到落盘快照`, err)
          return { id, data: null, success: false }
        })
    )

    Promise.all(promises).then(results => {
      if (cancelled) return

      const sessionById = new Map(sessionsRef.current.map(s => [s.id, s]))
      const map = new Map<string, SessionDiffStats>()

      results.forEach(({ id, data, success }) => {
        const session = sessionById.get(id)
        if (!session) return

        if (success && data) {
          map.set(id, { ...data, isLive: true })
        } else {
          // 查询失败，回退到落盘快照，标记为 stale（isLive: false）
          const { additions, deletions, files } = session

          if (additions != null || deletions != null || files != null) {
            map.set(id, {
              additions: additions ?? 0,
              deletions: deletions ?? 0,
              files: files ?? 0,
              isLive: false,
            })
          }
          // Map 中没有数据时，不放这个 key（返回 undefined）
        }
      })

      setStatsMap(map)
    })

    return () => {
      cancelled = true
    }
  }, [residentIdsKey])

  return statsMap
}
