export type SessionUiStatus =
  | { kind: 'working' }
  | { kind: 'needs_input' }
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'idle' }

export interface SessionUiStatusInput {
  id: string
  busy: boolean
  hasPendingAction: boolean
  latestNotification: { type: string; timestamp: number } | null
}

/**
 * 会话侧栏徽章状态，按优先级从本地信号派生：
 * busy（activeSessionStore.statusMap）→ 未答复的 permission/question
 * → 最近一条通知（error → failed，completed → completed）→ idle。
 */
export function deriveSessionUiStatus(input: SessionUiStatusInput): SessionUiStatus {
  if (input.busy) return { kind: 'working' }
  if (input.hasPendingAction) return { kind: 'needs_input' }
  const n = input.latestNotification
  if (n) {
    if (n.type === 'error') return { kind: 'failed' }
    if (n.type === 'completed') return { kind: 'completed' }
  }
  return { kind: 'idle' }
}
