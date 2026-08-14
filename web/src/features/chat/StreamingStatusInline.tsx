// ============================================
// StreamingStatusInline — TUI 风格的流式状态行
//
// session busy 期间挂在消息流末尾：
//   等待响应… 1.1s   （prompt 已发出，首个 assistant chunk 未到）
//   回复中… 5s       （assistant 正在流式输出）
// processCollapseEnabled（Working 壳）开启时由壳负责计时，不渲染本组件。
// ============================================

import { memo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNow } from '../../hooks/useNow'
import type { Message } from '../../types/message'

export type StreamingPhase = 'waiting' | 'responding'

/** 最后一条 assistant 是否已开始产出（有 part 即算响应中） */
export function deriveStreamingPhase(visibleMessages: Message[]): StreamingPhase {
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    const m = visibleMessages[i]
    if (m.info.role === 'user') break
    if (m.info.role === 'assistant' && (m.isStreaming || m.parts.length > 0)) return 'responding'
  }
  return 'waiting'
}

function formatElapsed(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.floor(s % 60)}s`
}

export const StreamingStatusInline = memo(function StreamingStatusInline({
  isStreaming,
  phase,
}: {
  isStreaming: boolean
  phase: StreamingPhase
}) {
  const { t } = useTranslation('chat')
  // busy 起点：isStreaming false→true 时记录（组件常驻，避免因挂载时机丢起点）
  const startRef = useRef<number | null>(null)
  const wasStreamingRef = useRef(false)
  if (isStreaming && !wasStreamingRef.current) startRef.current = Date.now()
  wasStreamingRef.current = isStreaming

  const now = useNow(100, isStreaming)

  // isStreaming 结束后复位，防下次复用旧起点
  useEffect(() => {
    if (!isStreaming) startRef.current = null
  }, [isStreaming])

  if (!isStreaming || startRef.current === null) return null

  const elapsed = Math.max(0, now - startRef.current)
  const label = phase === 'waiting' ? t('streamingStatus.waiting') : t('streamingStatus.responding')

  return (
    <div className="flex items-center gap-2 py-1 text-[length:var(--fs-sm)] text-text-400">
      <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-text-400 border-t-transparent" />
      <span className="reasoning-shimmer-text">{label}</span>
      <span className="tabular-nums text-text-500">{formatElapsed(elapsed)}</span>
    </div>
  )
})
