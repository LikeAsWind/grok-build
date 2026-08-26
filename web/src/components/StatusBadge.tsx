import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircleIcon, CheckIcon, SpinnerIcon } from './Icons'
import { formatDuration } from '../utils/formatUtils'

export type StatusBadgeStatus = 'loading' | 'done' | 'failed'

export interface StatusBadgeProps {
  status: StatusBadgeStatus
  /** label: 通常是这一行的标题（"Skill discovery"） */
  label: ReactNode
  /** 完成态时显示的耗时；loading 态会被忽略 */
  durationMs?: number
}

export function StatusBadge({ status, label, durationMs }: StatusBadgeProps) {
  const { t } = useTranslation()
  const icon = (() => {
    if (status === 'loading') return <SpinnerIcon className="text-text-400 animate-spin" />
    if (status === 'failed') return <AlertCircleIcon className="text-danger-100" />
    return <CheckIcon className="text-success-100" />
  })()
  const right = (() => {
    if (status === 'loading') return <span className="text-text-400">{t('contextDetails.statusLoading')}</span>
    if (status === 'failed') return <span className="text-danger-100">{t('contextDetails.statusFailed')}</span>
    if (durationMs === undefined) return <span className="text-text-400">—</span>
    return <span className="text-text-400 tabular-nums">{formatDuration(durationMs)}</span>
  })()
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 w-4 h-4 flex items-center justify-center" aria-hidden="true">
          {icon}
        </span>
        <span className="truncate text-text-100">{label}</span>
      </div>
      <div className="shrink-0 text-sm">{right}</div>
    </div>
  )
}
