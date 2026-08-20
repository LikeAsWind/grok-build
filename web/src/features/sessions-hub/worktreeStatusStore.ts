// ============================================
// worktreeStatusStore - x.ai/git/worktree/status 进度订阅
// 后端 WorktreeStatus 形状（serde tag="status"）：
//   { status: "progress", sessionId, message }
//   { status: "created",  sessionId, worktreePath, commit, ... }
//   { status: "error",    sessionId, message }
// 通知经 acpBridge 的 acp:extNotification 广播（见 api/acpBridge.ts
// handleExtNotification——未识别的 ext 通知原样转发）。
// ============================================

export interface WorktreeProgress {
  kind: 'progress' | 'created' | 'error'
  message?: string
  worktreePath?: string
}

type Key = string
type Listener = (progress: WorktreeProgress) => void

const listeners = new Map<Key, Set<Listener>>()

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export const worktreeStatusStore = {
  subscribe(key: Key, listener: Listener): () => void {
    let set = listeners.get(key)
    if (!set) {
      set = new Set()
      listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0 && listeners.get(key) === set) {
        listeners.delete(key)
      }
    }
  },

  onExtNotification(method: string, params: unknown): void {
    if (method !== 'x.ai/git/worktree/status' || !isRecord(params)) return
    const key = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (!key) return
    const set = listeners.get(key)
    if (!set || set.size === 0) return
    let progress: WorktreeProgress
    if (params.status === 'progress') {
      progress = { kind: 'progress', message: typeof params.message === 'string' ? params.message : undefined }
    } else if (params.status === 'created') {
      progress = {
        kind: 'created',
        worktreePath: typeof params.worktreePath === 'string' ? params.worktreePath : undefined,
      }
    } else if (params.status === 'error') {
      progress = { kind: 'error', message: typeof params.message === 'string' ? params.message : undefined }
    } else {
      return
    }
    for (const listener of [...set]) {
      listener(progress)
    }
  },

  clearAll(): void {
    listeners.clear()
  },
}

export function subscribeWorktreeStatus(key: Key, listener: Listener): () => void {
  return worktreeStatusStore.subscribe(key, listener)
}

if (typeof window !== 'undefined') {
  window.addEventListener('acp:extNotification', (event: Event) => {
    const detail = (event as CustomEvent<{ method: string; params: unknown }>).detail
    if (detail) {
      worktreeStatusStore.onExtNotification(detail.method, detail.params)
    }
  })
}