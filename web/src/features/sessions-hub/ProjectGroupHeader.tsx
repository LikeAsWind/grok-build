// 文件夹视图项目分组头部：项目名 + 分支名 + 状态圆点 + 展开/折叠箭头 + 会话数。

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRightIcon } from '../../components/Icons'
import { useVcsInfo } from '../../hooks/useVcsInfo'
import { useBusySessions } from '../../store/activeSessionStore'
import { useNotifications } from '../../store/notificationStore'
import { getDirectoryName, isSameDirectory } from '../../utils'
import type { ApiSession } from '../../api'

export interface ProjectGroupHeaderProps {
  directory: string
  sessions: ApiSession[]
  isExpanded: boolean
  onToggle: () => void
}

interface ProjectStatusDot {
  dot: string
  pulse: boolean
}

/**
 * 项目分组的汇总状态圆点：跟 SessionListItem 的单会话状态徽章无关，
 * 这里只看该目录下所有 busy 会话/未读通知的汇总。
 * 优先级：等待权限 > 等待回答 > 重试中 > 工作中 > 已完成通知 > 无。
 */
function useProjectStatus(directory: string): ProjectStatusDot | null {
  const busySessions = useBusySessions()
  const notifications = useNotifications()

  return useMemo(() => {
    const dirBusy = busySessions.filter(b => isSameDirectory(b.directory, directory))

    if (dirBusy.length > 0) {
      if (dirBusy.some(b => b.pendingAction?.type === 'permission')) {
        return { dot: 'bg-yellow-500', pulse: false }
      }
      if (dirBusy.some(b => b.pendingAction?.type === 'question')) {
        return { dot: 'bg-yellow-500', pulse: false }
      }
      if (dirBusy.some(b => b.status.type === 'retry')) {
        return { dot: 'bg-red-500', pulse: false }
      }
      return { dot: 'bg-blue-500', pulse: true }
    }

    const hasUnreadCompleted = notifications.some(
      n => n.type === 'completed' && !n.read && isSameDirectory(n.directory, directory),
    )
    if (hasUnreadCompleted) {
      return { dot: 'bg-emerald-500', pulse: false }
    }

    return null
  }, [directory, busySessions, notifications])
}

export function ProjectGroupHeader({ directory, sessions, isExpanded, onToggle }: ProjectGroupHeaderProps) {
  const { t } = useTranslation('chat')
  const vcsDirectory = directory === '(none)' ? undefined : directory
  const { vcsInfo } = useVcsInfo(vcsDirectory)
  const statusDot = useProjectStatus(directory)

  const projectName = directory === '(none)' ? t('sessionsHub.noDirectory') : getDirectoryName(directory)
  const branch = vcsInfo?.branch

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className="w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-left hover:bg-bg-200/50 transition-colors"
    >
      <span className={`text-text-400 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
        <ChevronRightIcon size={12} />
      </span>

      {statusDot && (
        <span
          data-testid="status-dot"
          aria-hidden="true"
          className={`size-2 rounded-full shrink-0 ${statusDot.dot} ${statusDot.pulse ? 'animate-pulse' : ''}`}
        />
      )}

      <span className="flex-1 min-w-0 truncate text-[length:var(--fs-xs)] font-medium text-text-400 uppercase tracking-wider">
        {projectName}
        {branch && <span className="opacity-70"> · {branch}</span>}
      </span>

      <span className="text-[length:var(--fs-xs)] text-text-500 shrink-0">
        {t('sessionsHub.groupHeaderCount', { count: sessions.length })}
      </span>
    </button>
  )
}
