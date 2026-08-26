// ============================================
// TAPD 工作台 API — 重接 ACP ext(x.ai/tapd/*)
//
// 后端 ext handler：crates/codegen/xai-grok-shell/src/extensions/tapd.rs
// ============================================

import { acpExtRequest } from './acpBridge'

export interface TapdSyncStats {
  fetched: number
  added: number
  updated: number
  duplicate: number
  failed: number
}

export interface TapdCursor {
  directory: string
  workspaceId: string
  lastSyncedModified?: string | null
  lastSyncStartedAt?: number | null
  lastSyncFinishedAt?: number | null
  lastSyncStatus?: string | null
  lastSyncError?: string | null
  lastSyncDurationMs?: number | null
  lastSyncStats: TapdSyncStats
  isSyncing: boolean
  nextSyncAt?: number | null
}

export interface TapdTaskCounts {
  pending: number
  processing: number
  completed: number
  failed: number
}

export interface TapdTask {
  id: string
  directory: string
  workspaceId: string
  entityType: string
  tapdId: string
  title: string
  status: string
  priority?: string | null
  module?: string | null
  owner?: string | null
  tapdCreatedAt?: string | null
  tapdModifiedAt?: string | null
  queueState: 'pending' | 'processing' | 'completed' | 'failed'
  enqueuedAt: number
  completedAt?: number | null
  retryCount: number
  maxRetries: number
  lastError?: string | null
  tapdUrl: string
}

export interface TapdSyncRun {
  id: number
  directory: string
  startedAt: number
  finishedAt?: number | null
  trigger: 'manual' | 'scheduled' | 'startup_recovery'
  status: 'running' | 'success' | 'failed'
  stats: TapdSyncStats
  error?: string | null
}

/** 当前生效的绑定：显式 `[tapd.projects.*]` 或由 default_workspace_id 推导。 */
export interface TapdBinding {
  directory: string
  workspaceId: string
  entityTypes: string[]
  moduleFilter: string[]
  /** false = 继承默认 workspace，config.toml 里还没有这个目录的条目 */
  explicit: boolean
}

export interface TapdWorkbenchStatus {
  bound: boolean
  binding?: TapdBinding
  cursor?: TapdCursor
  counts: TapdTaskCounts
  modules: string[]
  recentRuns: TapdSyncRun[]
}

export interface TapdTaskListFilter {
  queueState?: string
  entityType?: string
  module?: string
  search?: string
  sort?: string
  limit?: number
  offset?: number
}

/** 工作台快照：绑定状态 + 概览统计 + 最近同步记录，一次拿全。 */
export async function getTapdWorkbenchStatus(directory: string): Promise<TapdWorkbenchStatus> {
  const resp = await acpExtRequest('x.ai/tapd/status', { directory })
  return resp as TapdWorkbenchStatus
}

export async function listTapdTasks(directory: string, filter: TapdTaskListFilter = {}): Promise<TapdTask[]> {
  const resp = await acpExtRequest('x.ai/tapd/tasks/list', { directory, filter })
  return (resp as { tasks: TapdTask[] }).tasks
}

/** 手动触发同步；复用与定时任务完全相同的核心逻辑。省略 directory 时同步全部已绑定项目。 */
export async function triggerTapdSync(directory?: string): Promise<void> {
  await acpExtRequest('x.ai/tapd/sync/trigger', directory ? { directory } : {})
}

export interface TapdSyncStatusEvent {
  directory: string
  phase: 'started' | 'succeeded' | 'failed'
}

/** 订阅 x.ai/tapd/sync_status 通知（经 acpBridge 的 acp:extNotification 广播）。 */
export function subscribeTapdSyncStatus(listener: (event: TapdSyncStatusEvent) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ method: string; params: unknown }>).detail
    if (detail?.method === 'x.ai/tapd/sync_status') {
      listener(detail.params as TapdSyncStatusEvent)
    }
  }
  window.addEventListener('acp:extNotification', handler)
  return () => window.removeEventListener('acp:extNotification', handler)
}
