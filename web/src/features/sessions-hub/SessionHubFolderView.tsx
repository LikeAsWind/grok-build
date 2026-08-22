import { useMemo, useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionHubViewStore } from '../../store/sessionHubViewStore'
import { useResidentSessionDiffStats } from './useResidentSessionDiffStats'
import { ProjectGroup } from './ProjectGroup'
import { useDirectory } from '../../contexts/useDirectory'
import type { ApiSession } from '../../api'
import type { SessionUiStatus } from './status'
import { normalizeToForwardSlash } from '../../utils'

export interface SessionHubFolderViewProps {
  /** 已过滤（search + statusFilter）后的顶层会话——父会话被过滤掉时子会话会被提升为顶层，
   * 这个提升逻辑已经在 buildSessionTree 里做好，这里直接用 */
  topLevel: ApiSession[]
  /** 顶层会话 id → 其子会话列表（已按"始终显示子会话"开关过滤好，子会话标题已用 resolveChildTitle 兜底） */
  childrenByParent: Map<string, ApiSession[]>
  selectedSessionId: string | null
  uiStatusMap: Map<string, SessionUiStatus>
  onSelect: (session: ApiSession) => void
  onRename: (sessionId: string, title: string) => Promise<void>
  onDelete: (sessionId: string) => Promise<void>
}

/**
 * 文件夹视图组件：按目录分组会话，支持展开/折叠项目。
 *
 * 职责：
 * 1. 按 session.directory 分组（只看顶层会话，子会话跟着父走）
 * 2. 按最近活跃时间排序项目
 * 3. 组内会话按时间倒序
 * 4. 订阅 sessionHubViewStore 获取展开状态
 * 5. 首次渲染时调用 ensureDefaultExpanded（仅一次）
 * 6. 查询 resident sessions 的 diff 统计（含子会话）
 *
 * resident session 判断：读取 session.resident（来自 ACP roster 的
 * RosterEntry.resident 字段——true 表示进程内仍有 actor 驱动该会话，
 * 不论 busy/idle；false 表示仅存在于磁盘）。
 */
export function SessionHubFolderView({
  topLevel,
  childrenByParent,
  selectedSessionId,
  uiStatusMap,
  onSelect,
  onRename,
  onDelete,
}: SessionHubFolderViewProps) {
  const { t } = useTranslation('chat')
  const { currentDirectory } = useDirectory()

  // 订阅 sessionHubViewStore 的展开状态
  const snapshot = useSyncExternalStore(
    sessionHubViewStore.subscribe,
    sessionHubViewStore.getSnapshot,
  )

  // 首次默认展开当前目录（仅执行一次）
  const hasCalledEnsureDefault = useRef(false)
  useEffect(() => {
    if (!currentDirectory) return
    if (hasCalledEnsureDefault.current) return

    hasCalledEnsureDefault.current = true
    sessionHubViewStore.ensureDefaultExpanded(currentDirectory)
  }, [currentDirectory])

  // diff 统计查询/回退需要覆盖子会话，否则子会话永远查不到落盘快照数据
  const allSessions = useMemo(
    () => [...topLevel, ...Array.from(childrenByParent.values()).flat()],
    [topLevel, childrenByParent],
  )

  // resident sessions：进程内仍有 actor 驱动的会话（不论 busy/idle），
  // 才需要实时查询 hunk-tracker；其余会话走落盘快照。
  const residentIds = useMemo(
    () => allSessions.filter(s => s.resident).map(s => s.id),
    [allSessions],
  )

  // 并行查询 resident sessions 的 diff 统计
  const diffStatsMap = useResidentSessionDiffStats(residentIds, allSessions)

  // 按目录分组并排序——只按顶层会话的目录分组，子会话跟着父走
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, typeof topLevel>()

    topLevel.forEach(session => {
      const dir = session.directory ? normalizeToForwardSlash(session.directory) : '(none)'
      if (!groups.has(dir)) {
        groups.set(dir, [])
      }
      groups.get(dir)!.push(session)
    })

    // 计算每个项目的最近活跃时间并排序
    return Array.from(groups.entries())
      .map(([directory, sessionList]) => {
        const sorted = [...sessionList].sort(
          (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
        )
        const mostRecentTime = sorted[0]?.time?.updated ?? 0
        return [directory, sorted, mostRecentTime] as const
      })
      .sort((a, b) => b[2] - a[2])
      .map(([directory, sessionList]) => ({ directory, sessions: sessionList }))
  }, [topLevel])

  return (
    <div className="folder-view space-y-2 p-2">
      {groupedSessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-400 opacity-60">
          <p className="text-[length:var(--fs-sm)]">{t('sessionsHub.noSessionsYet')}</p>
        </div>
      ) : (
        groupedSessions.map(({ directory, sessions: projectSessions }) => {
          const isExpanded = snapshot.expandedProjects.has(directory)

          return (
            <ProjectGroup
              key={directory}
              directory={directory}
              sessions={projectSessions}
              isExpanded={isExpanded}
              diffStatsMap={diffStatsMap}
              onToggleExpand={() => sessionHubViewStore.toggleProject(directory)}
              selectedSessionId={selectedSessionId}
              uiStatusMap={uiStatusMap}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              childrenByParent={childrenByParent}
            />
          )
        })
      )}
    </div>
  )
}
