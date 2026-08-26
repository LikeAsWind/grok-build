// 侧栏主面板：全局会话列表 + 状态筛选 + 按项目分组 + 通知铃铛。
// 对齐 Claude Code 桌面端：单一列表，会话自带目录与状态，不再按目录过滤。

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchIcon, CloseIcon, BellIcon, NewChatIcon, SidebarIcon, WorkbenchIcon } from '../../components/Icons'
import { useSessionContext } from '../../contexts/useSessionContext'
import { useBusySessions } from '../../store/activeSessionStore'
import { useNotifications, useUnreadNotificationCount } from '../../store/notificationStore'
import { childSessionStore } from '../../store/childSessionStore'
import { useLayoutStore } from '../../store/layoutStore'
import { sessionHubViewStore } from '../../store/sessionHubViewStore'
import { updateSession, type ApiSession } from '../../api'
import { getServerCwd } from '../../api/acpBridge'
import { uiErrorHandler } from '../../utils'
import { SidebarFooter } from '../chat/sidebar/SidebarFooter'
import { restoreAllChildSessions } from '../message/synthNotifPersist'
import { SessionListItem } from './SessionListItem'
import { NewSessionDialog } from './NewSessionDialog'
import { SessionHubFolderView } from './SessionHubFolderView'
import { ViewToggleButton } from './ViewToggleButton'
import { deriveSessionUiStatus, type SessionUiStatus } from './status'
import { buildSessionTree, resolveChildTitle } from './sessionTree'

export interface SessionHubPanelProps {
  onNewSession: () => void
  onSelectSession: (session: ApiSession) => void
  selectedSessionId: string | null
  isExpanded: boolean
  onToggleSidebar: () => void
  onOpenSettings?: () => void
  /** 打开 TAPD 工作台页（与仪表盘并列的首页入口） */
  onOpenWorkbench?: () => void
  /** 工作台页当前是否正在显示——高亮入口 */
  isWorkbenchActive?: boolean
}

type StatusFilter = 'all' | SessionUiStatus['kind']

function filterLabelKey(kind: StatusFilter): string {
  switch (kind) {
    case 'all':
      return 'filterAll'
    case 'working':
      return 'filterWorking'
    case 'needs_input':
      return 'filterNeedsInput'
    case 'completed':
      return 'filterCompleted'
    case 'failed':
      return 'filterFailed'
    case 'idle':
      return 'filterIdle'
  }
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

export function SessionHubPanel({
  onNewSession,
  onSelectSession,
  selectedSessionId,
  isExpanded,
  onToggleSidebar,
  onOpenSettings,
  onOpenWorkbench,
  isWorkbenchActive = false,
}: SessionHubPanelProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { sessions, isLoading, search, setSearch, refresh, deleteSession } = useSessionContext()
  const busySessions = useBusySessions()
  const notifications = useNotifications()
  const unreadCount = useUnreadNotificationCount()
  const { sidebarShowChildSessions } = useLayoutStore()

  // 启动预热：从持久化通知一次性重建全部子会话映射（幂等）。不预热的话首屏
  // （尚未打开任何会话）没有父子关系与标题数据——子会话会先平级显示「未命名会话」。
  useEffect(() => {
    restoreAllChildSessions()
  }, [])

  const childSessionVersion = useSyncExternalStore(
    childSessionStore.subscribe.bind(childSessionStore),
    childSessionStore.getVersion,
    childSessionStore.getVersion,
  )
  const getParentId = useCallback(
    (id: string) => childSessionStore.getSessionInfo(id)?.parentID,
    // childSessionVersion：subagent_spawned/markIdle/markError 到达时重算
    [childSessionVersion],
  )

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)
  const [newDialogOpen, setNewDialogOpen] = useState(false)
  const viewSnapshot = useSyncExternalStore(sessionHubViewStore.subscribe, sessionHubViewStore.getSnapshot)

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

  const { topLevel, childrenByParent } = useMemo(
    () =>
      buildSessionTree(filtered, {
        showAllChildren: sidebarShowChildSessions,
        selectedSessionId,
        busySessionIds: busyIds,
        getParentId,
      }),
    [filtered, sidebarShowChildSessions, selectedSessionId, busyIds, getParentId],
  )

  // 子会话刚 spawn 时 roster 里的 title 经常是空的，统一在这里用
  // childSessionStore 兜底一次，列表视图（renderSessionWithChildren）和文件夹视图
  // （SessionHubFolderView）共用这份结果，不必各自重复调用 resolveChildTitle。
  const resolvedChildrenByParent = useMemo(() => {
    const map = new Map<string, ApiSession[]>()
    childrenByParent.forEach((children, parentId) => {
      map.set(
        parentId,
        children.map(child => resolveChildTitle(child, childSessionStore.getSessionInfo(child.id))),
      )
    })
    return map
    // childSessionVersion：subagent_spawned/markIdle/markError 到达时重算标题兜底
  }, [childrenByParent, childSessionVersion])

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
      try {
        await deleteSession(sessionId)
        if (selectedSessionId === sessionId) {
          onNewSession()
        }
      } catch (e) {
        uiErrorHandler('delete session', e)
      }
    },
    [deleteSession, selectedSessionId, onNewSession],
  )

  const renderItem = (session: ApiSession, indent = false) => (
    <SessionListItem
      key={session.id}
      session={session}
      isSelected={session.id === selectedSessionId}
      uiStatus={statuses.get(session.id) ?? { kind: 'idle' }}
      onSelect={onSelectSession}
      onRename={handleRename}
      onDelete={handleDelete}
      indent={indent}
    />
  )

  // 顶层会话紧跟着渲染它的子会话（单层嵌套，见 sessionTree.ts）；有子会话时用同样
  // 的 space-y-0.5 包一层，保持行间距和无子会话时一致。用 resolvedChildrenByParent
  // （已统一做过标题兜底）而不是原始 childrenByParent，避免和文件夹视图各自重复
  // 调用 resolveChildTitle。
  const renderSessionWithChildren = (session: ApiSession) => {
    const children = resolvedChildrenByParent.get(session.id)
    if (!children?.length) return renderItem(session)
    return (
      <div key={session.id} className="space-y-0.5">
        {renderItem(session)}
        {children.map(child => renderItem(child, true))}
      </div>
    )
  }

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

      {/* 导航入口（工作台）+ 新建对话 */}
      <div className="flex flex-col gap-0.5 mx-2 -mt-2.5">
        {/* 工作台在「新对话」之上：先是"去哪个页面"，再是"开始做什么"，
            两组之间用 mb-1 分隔出层级 */}
        {onOpenWorkbench && (
          <button
            type="button"
            onClick={onOpenWorkbench}
            aria-label={t('sidebar.workbench')}
            aria-current={isWorkbenchActive ? 'page' : undefined}
            title={t('sidebar.workbenchHint')}
            className={`h-8 mb-1 flex items-center rounded-lg active:scale-[0.98] transition-all duration-300 group overflow-hidden ${
              isWorkbenchActive
                ? 'bg-accent-main-100/10 text-accent-main-100'
                : 'text-text-300 hover:text-text-100 hover:bg-bg-200'
            }`}
            style={{ width: showLabels ? '100%' : 32, paddingLeft: 6, paddingRight: 6 }}
          >
            <span className="size-5 flex items-center justify-center shrink-0">
              <WorkbenchIcon size={16} />
            </span>
            <span
              className="ml-2 text-[length:var(--fs-base)] whitespace-nowrap transition-opacity duration-300"
              style={{ opacity: showLabels ? 1 : 0 }}
            >
              {t('sidebar.workbench')}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setNewDialogOpen(true)}
          aria-label={t('sidebar.newChat')}
          title={t('sessionsHub.newChatDialogTitle')}
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
            {statusFilter !== 'all'
              ? `${t('sessionsHub.filter')}${t('sessionsHub.filterSeparator')}${t(`sessionsHub.${filterLabelKey(statusFilter)}`)}`
              : t('sessionsHub.filter')}
          </button>
          <ViewToggleButton />
          <button
            type="button"
            onClick={() => setBellOpen(!bellOpen)}
            className="ml-auto relative p-1 rounded-md text-text-400 hover:text-text-100"
            title={t('sessionsHub.notifications')}
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
                  {t(`sessionsHub.${filterLabelKey(kind)}`)}
                </button>
              ))}
            </div>
          )}

          {bellOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-64 max-h-72 overflow-y-auto custom-scrollbar rounded-lg border border-border-200/60 glass-alt shadow-sm p-1 bg-bg-100">
              {notifications.length === 0 ? (
                <div className="px-3 py-4 text-center text-[length:var(--fs-sm)] text-text-400">{t('sessionsHub.noNotifications')}</div>
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
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2">
        {isLoading && sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-text-400/70 text-[length:var(--fs-sm)]">{t('sessionsHub.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-400 opacity-60">
            <p className="text-[length:var(--fs-sm)]">{search ? t('sessionsHub.noMatches') : t('sessionsHub.noSessionsYet')}</p>
          </div>
        ) : viewSnapshot.viewMode === 'folder' ? (
          <SessionHubFolderView
            topLevel={topLevel}
            childrenByParent={resolvedChildrenByParent}
            selectedSessionId={selectedSessionId}
            uiStatusMap={statuses}
            onSelect={onSelectSession}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        ) : (
          <div className="mt-1 space-y-0.5">{topLevel.map(renderSessionWithChildren)}</div>
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
        onCreated={session => {
          setNewDialogOpen(false)
          onSelectSession(session)
        }}
      />
    </div>
  )
}
