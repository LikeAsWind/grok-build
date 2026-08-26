import { useCallback, useEffect, useState } from 'react'
import { getDashboardStats } from '../../api'
import type { DashboardStats } from '../../types/api/dashboard'

export interface UseDashboardStatsResult {
  stats: DashboardStats | null
  loading: boolean
  error: Error | null
}

/**
 * 拉取首页仪表盘统计快照（`x.ai/session_summaries/dashboard_stats`）。
 * `days` 变化（All/30d/7d 切换）时重新拉取。Overview 和 Models 两个 tab
 * 共用同一次请求 —— 后端一次性把两者需要的数据都算好返回。
 */
export function useDashboardStats(days?: number): UseDashboardStatsResult {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchStats = useCallback((signal: AbortSignal) => {
    setLoading(true)
    getDashboardStats(days)
      .then(result => {
        if (signal.aborted) return
        setStats(result)
        setError(null)
      })
      .catch(err => {
        if (signal.aborted) return
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false)
      })
  }, [days])

  useEffect(() => {
    const ctrl = new AbortController()
    fetchStats(ctrl.signal)
    return () => ctrl.abort()
  }, [fetchStats])

  return { stats, loading, error }
}

