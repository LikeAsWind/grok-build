import { useTranslation } from 'react-i18next'
import type { TapdTask } from '../../api/tapd'
import { queueStateBadge } from './taskStatus'
import { translateTapdStatus } from './tapdStatus'

export interface WorkbenchTaskRowProps {
  task: TapdTask
  onOpen: (task: TapdTask) => void
}

const PRIORITY_TONE: Record<string, string> = {
  high: 'text-danger-100',
  urgent: 'text-danger-100',
  middle: 'text-amber-500',
  medium: 'text-amber-500',
  low: 'text-text-400',
}

export function WorkbenchTaskRow({ task, onOpen }: WorkbenchTaskRowProps) {
  const { t } = useTranslation('workbench')
  const badge = queueStateBadge(task.queueState)
  const priorityTone = task.priority ? PRIORITY_TONE[task.priority.toLowerCase()] ?? 'text-text-400' : ''

  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-bg-200/50 transition-colors group"
    >
      <span
        data-testid="queue-state-dot"
        aria-hidden="true"
        className={`size-2 rounded-full shrink-0 ${badge.dot} ${task.queueState === 'processing' ? 'animate-pulse' : ''}`}
        title={t(badge.labelKey)}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[length:var(--fs-sm)] text-text-100 truncate">{task.title}</span>
          {task.retryCount > 0 && (
            <span className="text-[length:var(--fs-xxs)] text-text-500 shrink-0">
              {t('retryCount', { count: task.retryCount, max: task.maxRetries })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[length:var(--fs-xs)] text-text-400 mt-0.5">
          <span className="font-mono">{task.tapdId}</span>
          <span>·</span>
          <span>{translateTapdStatus(task.status, t)}</span>
          {task.module && (
            <>
              <span>·</span>
              <span className="truncate">{task.module}</span>
            </>
          )}
          {task.owner && (
            <>
              <span>·</span>
              <span className="truncate">{task.owner}</span>
            </>
          )}
        </div>
      </div>

      {task.priority && (
        <span className={`text-[length:var(--fs-xs)] font-medium shrink-0 ${priorityTone}`}>{task.priority}</span>
      )}
    </button>
  )
}
