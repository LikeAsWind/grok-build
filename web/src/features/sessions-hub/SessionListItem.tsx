// 单条会话条目：状态徽章 + 标题 + 相对时间 + 目录名 + hover 操作（重命名 / 删除）。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TrashIcon, PencilIcon } from '../../components/Icons'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { getDirectoryName } from '../../utils'
import type { ApiSession } from '../../api'
import type { SessionUiStatus } from './status'

const STATUS_DOT: Record<SessionUiStatus['kind'], string> = {
  working: 'bg-blue-500',
  needs_input: 'bg-yellow-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  idle: 'bg-bg-300',
}

export interface SessionListItemProps {
  session: ApiSession
  isSelected: boolean
  uiStatus: SessionUiStatus
  onSelect: (session: ApiSession) => void
  onRename: (sessionId: string, title: string) => Promise<void>
  onDelete: (sessionId: string) => Promise<void>
  /** 子会话嵌套展示：加左侧缩进 + 细左边框，不做展开/折叠或连接线 */
  indent?: boolean
}

function formatRelativeTime(t: (key: string, opts?: { count: number }) => string, ts: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ts) / 60_000))
  if (minutes < 1) return t('sessionsHub.justNow')
  if (minutes < 60) return t('sessionsHub.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('sessionsHub.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('sessionsHub.daysAgo', { count: days })
}

export function SessionListItem({
  session,
  isSelected,
  uiStatus,
  onSelect,
  onRename,
  onDelete,
  indent = false,
}: SessionListItemProps) {
  const { t } = useTranslation('chat')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title ?? '')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitRename = async () => {
    const title = draft.trim()
    setEditing(false)
    if (title && title !== (session.title ?? '')) {
      await onRename(session.id, title)
    }
  }

  const directoryName = session.directory ? getDirectoryName(session.directory) : ''

  return (
    <>
      <div
        data-selected={isSelected}
        data-indent={indent}
        onClick={() => onSelect(session)}
        className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isSelected ? 'bg-bg-200/80' : 'hover:bg-bg-200/50'
        } ${indent ? 'ml-4 border-l border-border-200/40 pl-2' : ''}`}
      >
        <span
          aria-label={uiStatus.kind}
          className={`size-2 rounded-full shrink-0 ${STATUS_DOT[uiStatus.kind]} ${uiStatus.kind === 'working' ? 'animate-pulse' : ''}`}
        />

        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  setDraft(session.title ?? '')
                  setEditing(false)
                }
              }}
              className="w-full h-6 px-1.5 text-[length:var(--fs-sm)] rounded bg-bg-100 border border-border-200 outline-none focus:border-accent-main-100"
              autoFocus
            />
          ) : (
            <div className="truncate text-[length:var(--fs-sm)] text-text-100">
              {session.title || t('sessionsHub.untitled')}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[length:var(--fs-xxs)] text-text-400">
            <span>{formatRelativeTime(t, session.time?.updated ?? 0, Date.now())}</span>
            {directoryName && (
              <span className="truncate max-w-[40%] font-mono opacity-80">{directoryName}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setDraft(session.title ?? '')
              setEditing(true)
            }}
            title={t('sessionsHub.renameSession')}
            className="p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-300"
          >
            <PencilIcon size={12} />
          </button>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setDeleteConfirmOpen(true)
            }}
            title={t('sessionsHub.deleteSession')}
            className="p-1 rounded text-text-400 hover:text-danger-100 hover:bg-danger-100/10"
          >
            <TrashIcon size={12} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={async () => {
          setDeleteConfirmOpen(false)
          await onDelete(session.id)
        }}
        title={t('sessionsHub.deleteSession')}
        description={t('sessionsHub.deleteConfirmBody')}
        confirmText={t('sessionsHub.delete')}
        variant="danger"
      />
    </>
  )
}