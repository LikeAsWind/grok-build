import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getTapdWorkbenchStatus,
  subscribeTapdSyncStatus,
  triggerTapdSync,
  type TapdWorkbenchStatus,
} from '../../api/tapd'
import { handleError } from '../../utils'

export interface UseTapdWorkbenchResult {
  status: TapdWorkbenchStatus | null
  loading: boolean
  error: Error | null
  syncing: boolean
  triggerSync: () => Promise<void>
  refresh: () => void
}

/**
 * 工作台快照 + 手动同步。订阅 `x.ai/tapd/sync_status` 通知——同步开始/结束
 * 时自动重新拉取快照，UI 不需要轮询。
 */
export function useTapdWorkbench(directory: string | undefined): UseTapdWorkbenchResult {
  const [status, setStatus] = useState<TapdWorkbenchStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [syncing, setSyncing] = useState(false)
  const requestIdRef = useRef(0)

  const load = useCallback(() => {
    if (!directory) {
      setStatus(null)
      setLoading(false)
      return
    }
    const requestId = ++requestIdRef.current
    setLoading(true)
    getTapdWorkbenchStatus(directory)
      .then(result => {
        if (requestId !== requestIdRef.current) return
        setStatus(result)
        setError(null)
      })
      .catch(err => {
        if (requestId !== requestIdRef.current) return
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false)
      })
  }, [directory])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!directory) return
    return subscribeTapdSyncStatus(event => {
      if (event.directory !== directory) return
      setSyncing(event.phase === 'started')
      if (event.phase !== 'started') load()
    })
  }, [directory, load])

  const triggerSync = useCallback(async () => {
    if (!directory) return
    setSyncing(true)
    const reportError = handleError('trigger TAPD sync', 'api')
    try {
      await triggerTapdSync(directory)
    } catch (err) {
      reportError(err)
      setSyncing(false)
    }
  }, [directory])

  return { status, loading, error, syncing, triggerSync, refresh: load }
}
