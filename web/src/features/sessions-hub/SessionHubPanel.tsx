// 侧栏主面板：全局会话列表 + 状态筛选 + 按项目分组 + 通知铃铛。
// 对齐 Claude Code 桌面端：单一列表，会话自带目录与状态，不再按目录过滤。

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchIcon, CloseIcon, BellIcon, NewChatIcon, SidebarIcon, CheckIcon } from '../../components/Icons'
import { useSessionContext } from '../../contexts/useSessionContext'
import { useBusySessions } from '../../store/activeSessionStore'
import { useNotifications, useUnreadNotificationCount } from '../../store/notificationStore'
import { updateSession, deleteSession as apiDeleteSession, type ApiSession } from '../../api'
import { getServerCwd } from '../../api/acpBridge'
import { getDirectoryName, normalizeToForwardSlash, uiErrorHandler } from '../../utils'
import { SidebarFooter } from '../chat/sidebar/SidebarFooter'
import { SessionListItem } from './SessionListItem'
import { NewSessionDialog } from './NewSessionDialog'
import { deriveSessionUiStatus, type SessionUiStatus } from './status'

export interface SessionHubPanelProps {
  onNewSession: () => void
  onSelectSession: (session: ApiSession) => void
  selectedSessionId: string | null
  isExpanded: boolean
  onToggleSidebar: () => void
  onOpenSettings?: () => void
}

type StatusFilter = 'all' | SessionUiStatus['kind']

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: '全部',
  working: 'Working',
  needs_input: 'Needs input',
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
}

function deriveAllStatuses(
  sessions: ApiSession[],
  busyIds: Set<string>,
  notifications: { type: string; sessionId: string; timestamp: number }[],
): Map<string, SessionUiStatus> {
  const map = new Map<string, SessionUiStatus>()
  for (const s of sessions) {
    const latest = notifications
      .filter(n => n.sessionId === s.id)
      .sort((a, b) => b.timestamp - a.timestamp)[0]
    map.set(
      s.id,
      deriveSessionUiStatus({
        id: s.id,
        busy: busyIds.has(s.id),
        hasPendingAction: false,
        latestNotification: latest ?? null,
      }),
    )
  }
  return map
}

function groupByDirectory(sessions: ApiSession[]): Array<{ directory: string; sessions: ApiSession[] }> {
  const groups = new Map<string, ApiSession[]>()
  for (const s of sessions) {
    const key = s.directory ? normalizeToForwardSlash(s.directory) : '(none)'
    const list = groups.get(key)
    if (list) list.push(s)
    else groups.set(key, [s])
  }
  return Array.from(groups.entries()).map(([directory, list]) => ({ directory, sessions: list }))
}

export function SessionHubPanel({
  onNewSession,
  onSelectSession,
  selectedSessionId,
  isExpanded,
  onToggleSidebar,
  onOpenSettings,
}: SessionHubPanelProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { sessions, isLoading, search, setSearch, refresh } = useSessionContext()
  const busySessions = useBusySessions()
  const notifications = useNotifications()
  const unreadCount = useUnreadNotificationCount()

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [groupByProject, setGroupByProject] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)
  const [newDialogOpen, setNewDialogOpen] = useState(false)

  const busyIds = useMemo(() => new Set(busySessions.map(b => b.sessionId)), [busySessions])
  const statuses = useMemo(
    () => deriveAllStatuses(sessions, busyIds, notifications),
    [sessions, busyIds, notifications],
  )

  const filtered = useMemo(() => {
    let list = sessions
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(s => (s.title ?? '').toLowerCase().includes(q))
    }
    if (statusFilter !== 'all') {
      list = list.filter(s => statuses.get(s.id)?.kind === statusFilter)
    }
    return list
  }, [sessions, search, statusFilter, statuses])

  const groups = useMemo(() => groupByDirectory(filtered), [filtered])

  const handleRename = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await updateSession(sessionId, { title })
        await refresh()
      } catch (e) {
        uiErrorHandler('rename session', e)
      }
    },
    [refresh],
  )

  const handleDelete = useCallback(
    async (sessionId: string) => {
      await apiDeleteSession(sessionId)
      if (selectedSessionId === sessionId) {
        onNewSession()
      }
    },
    [selectedSessionId, onNewSession],
  )

  const renderItem = (session: ApiSession) => (
    <SessionListItem
      key={session.id}
      session={session}
      isSelected={session.id === selectedSessionId}
      uiStatus={statuses.get(session.id) ?? { kind: 'idle' }}
      onSelect={onSelectSession}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  )

  const showLabels = isExpanded

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="mobile-safe-topbar-14 shrink-0 flex items-center">
        <div
          className="overflow-hidden transition-[width,padding,opacity] duration-300 ease-out"
          style={{ width: showLabels ? 'auto' : 0, paddingLeft: showLabels ? 16 : 0, opacity: showLabels ? 1 : 0 }}
        >
          <a href="/" className="flex items-center whitespace-nowrap">
            <span className="text-[length:var(--fs-heading-3)] font-semibold text-text-100 tracking-tight">
              {t('header.openCode')}
            </span>
          </a>
        </div>
        <div
          className="flex-1 flex items-center transition-all duration-300 ease-out"
          style={{ justifyContent: showLabels ? 'flex-end' : 'center', paddingRight: showLabels ? 8 : 0 }}
        >
          <button
            onClick={onToggleSidebar}
            aria-label={isExpanded ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar')}
            className="h-8 w-8 flex items-center justify-center rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-200 active:scale-[0.98] transition-all duration-200"
          >
            <SidebarIcon size={16} />
          </button>
        </div>
      </div>

      {/* New chat */}
      <div className="flex flex-col gap-0.5 mx-2 -mt-2.5">
        <button
          type="button"
          onClick={() => setNewDialogOpen(true)}
          aria-label={t('sidebar.newChat')}
          title="新建会话"
          className="h-8 flex items-center rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-200 active:scale-[0.98] transition-all duration-300 group overflow-hidden"
          style={{ width: showLabels ? '100%' : 32, paddingLeft: 6, paddingRight: 6 }}
        >
          <span className="size-5 flex items-center justify-center shrink-0">
            <NewChatIcon size={16} />
          </span>
          <span
            className="ml-2 text-[length:var(--fs-base)] whitespace-nowrap transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {t('sidebar.newChat')}
          </span>
        </button>

        {/* Search */}
        {showLabels ? (
          <div className="relative w-full">
            <span className="pointer-events-none absolute left-[6px] top-1/2 -translate-y-1/2 size-5 flex items-center justify-center text-text-300">
              <SearchIcon size={16} />
            </span>
            <input
              type="text"
              name="sidebar-chat-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('sidebar.searchChats')}
              aria-label={t('sidebar.searchChats')}
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full appearance-none rounded-lg border-0 bg-transparent pl-[34px] pr-[26px] text-[length:var(--fs-base)] text-text-100 shadow-none outline-none ring-0 placeholder:text-text-300 transition-shadow focus-visible:ring-1 focus-visible:ring-accent-main-100/30"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-[6px] top-1/2 flex size-[14px] -translate-y-1/2 items-center justify-center text-text-400 hover:text-text-100"
                aria-label={t('sidebar.clearSearch')}
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
        ) : null}

        {/* Filter row */}
        <div className="flex items-center gap-1 relative">
          <button
            type="button"
            onClick={() => setFilterOpen(!filterOpen)}
            className={`h-7 px-2 rounded-md text-[length:var(--fs-xs)] transition-colors ${
              statusFilter !== 'all' ? 'text-accent-main-100' : 'text-text-400 hover:text-text-200'
            }`}
          >
            筛选{statusFilter !== 'all' ? `: ${FILTER_LABELS[statusFilter]}` : ''}
          </button>
          <button
            type="button"
            onClick={() => setGroupByProject(!groupByProject)}
            className={`h-7 px-2 rounded-md text-[length:var(--fs-xs)] transition-colors flex items-center gap-1 ${
              groupByProject ? 'text-accent-main-100' : 'text-text-400 hover:text-text-200'
            }`}
            title="按项目分组"
          >
            <CheckIcon size={12} className={groupByProject ? '' : 'opacity-0'} />
            分组
          </button>
          <button
            type="button"
            onClick={() => setBellOpen(!bellOpen)}
            className="ml-auto relative p-1 rounded-md text-text-400 hover:text-text-100"
            title="通知"
          >
            <BellIcon size={14} />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 size-3.5 flex items-center justify-center rounded-full bg-accent-main-100 text-[length:var(--fs-xxs)] text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {filterOpen && (
            <div className="absolute left-0 top-full mt-1 z-30 min-w-[140px] rounded-lg border border-border-200/60 glass-alt shadow-sm p-1 bg-bg-100">
              {(['all', 'working', 'needs_input', 'completed', 'failed', 'idle'] as StatusFilter[]).map(kind => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    setStatusFilter(kind)
                    setFilterOpen(false)
                  }}
                  className={`w-full text-left px-2 py-1 rounded-md text-[length:var(--fs-sm)] transition-colors ${
                    statusFilter === kind ? 'text-accent-main-100 bg-accent-main-100/10' : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'
                  }`}
                >
                  {FILTER_LABELS[kind]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Bell popover: 通知历史 */}
        {bellOpen && (
          <div className="absolute right-2 top-[86px] z-30 w-64 max-h-72 overflow-y-auto custom-scrollbar rounded-lg border border-border-200/60 glass-alt shadow-sm p-1 bg-bg-100">
            {notifications.length === 0 ? (
              <div className="px-3 py-4 text-center text-[length:var(--fs-sm)] text-text-400">暂无通知</div>
            ) : (
              notifications.map(n => (
                <div key={n.id} className="px-2 py-1.5 border-b border-border-200/30 last:border-b-0">
                  <div className="text-[length:var(--fs-xs)] text-text-200 truncate">{n.title}</div>
                  <div className="text-[length:var(--fs-xxs)] text-text-400 truncate">{n.body}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2">
        {isLoading && sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-text-400/70 text-[length:var(--fs-sm)]">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-400 opacity-60">
            <p className="text-[length:var(--fs-sm)]">{search ? '没有匹配的会话' : '还没有会话，点上方新建'}</p>
          </div>
        ) : groupByProject ? (
          groups.map(group => (
            <div key={group.directory} className="mt-2">
              <div className="flex items-center gap-1.5 px-2 py-1 text-[length:var(--fs-xs)] font-medium text-text-400 uppercase tracking-wider">
                <span className="truncate">{group.directory === '(none)' ? '无目录' : getDirectoryName(group.directory)}</span>
                <span className="text-text-500">· {group.sessions.length}</span>
              </div>
              <div className="space-y-0.5">{group.sessions.map(renderItem)}</div>
            </div>
          ))
        ) : (
          <div className="mt-1 space-y-0.5">{filtered.map(renderItem)}</div>
        )}
      </div>

      {/* Footer */}
      <SidebarFooter
        showLabels={showLabels}
        connectionState="connected"
        contextLimit={200000}
        onOpenSettings={onOpenSettings}
      />

      {/* 新建会话对话框 */}
      <NewSessionDialog
        isOpen={newDialogOpen}
        initialDirectory={getServerCwd()}
        onClose={() => setNewDialogOpen(false)}
        onCreated={() => {
          setNewDialogOpen(false)
          onNewSession()
        }}
      />
    </div>
  )
}
