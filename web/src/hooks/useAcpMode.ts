import { useEffect, useState } from 'react'
import { getCurrentMode } from '../api/acpBridge'

// 会话模式（default / plan / ask）与后端保持同步：
// 初始值取 acpBridge 缓存（历史回放的 current_mode_update），
// 之后订阅 acp:modeChanged（后端驱动的切换，如 plan 审批通过退回 default）。
export function useAcpMode(
  sessionId: string | null | undefined,
): [string, (mode: string) => void] {
  const resolve = () => (sessionId && getCurrentMode(sessionId)) || 'default'
  const [mode, setMode] = useState(resolve)

  useEffect(() => {
    setMode(resolve())
    if (!sessionId) return
    const onModeChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId: string; modeId: string }
      if (detail.sessionId === sessionId) setMode(detail.modeId)
    }
    window.addEventListener('acp:modeChanged', onModeChanged)
    return () => window.removeEventListener('acp:modeChanged', onModeChanged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return [mode, setMode]
}
