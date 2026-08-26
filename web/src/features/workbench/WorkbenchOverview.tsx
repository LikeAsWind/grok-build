// 工作台概览：紧凑横向统计条（待处理/处理中/已完成/失败 + 上次/下次同步）。
// 不用大卡片堆砌——延续 StatCard 的密度但横排展示，一眼看清全貌。

import { useTranslation } from 'react-i18next'
import type { TapdTaskCounts, TapdCursor } from '../../api/tapd'

function formatRelativeTime(
  t: (key: string, opts?: Record<string, unknown>) => string,
  unixSecs: number | null | undefined,
  now: number,
): string {
  if (!unixSecs) return ''
  const diffSecs = unixSecs - now
  const abs = Math.abs(diffSecs)
  const future = diffSecs > 0
  const prefix = future ? 'in' : 'ago'
  if (abs < 60) return future ? t('relativeTime.soon') : t('relativeTime.justNow')
  const mins = Math.round(abs / 60)
  if (mins < 60) return t(`relativeTime.minutes${prefix === 'in' ? 'In' : 'Ago'}`, { count: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t(`relativeTime.hours${prefix === 'in' ? 'In' : 'Ago'}`, { count: hours })
  const days = Math.round(hours / 24)
  return t(`relativeTime.days${prefix === 'in' ? 'In' : 'Ago'}`, { count: days })
}

interface StatChipProps {
  label: string
  value: number
  tone?: 'default' | 'warn' | 'danger' | 'success'
}

function StatChip({ label, value, tone = 'default' }: StatChipProps) {
  const toneClass = {
    default: 'text-text-100',
    warn: 'text-amber-500',
    danger: 'text-danger-100',
    success: 'text-emerald-500',
  }[tone]
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-[length:var(--fs-heading-2)] font-semibold tabular-nums ${toneClass}`}>{value}</span>
      <span className="text-[length:var(--fs-xs)] text-text-400">{label}</span>
    </div>
  )
}

export interface WorkbenchOverviewProps {
  counts: TapdTaskCounts
  cursor: TapdCursor | undefined
}

export function WorkbenchOverview({ counts, cursor }: WorkbenchOverviewProps) {
  const { t } = useTranslation('workbench')
  const now = Math.floor(Date.now() / 1000)

  return (
    <div className="flex items-center gap-6 flex-wrap">
      <StatChip label={t('pending')} value={counts.pending} />
      <StatChip label={t('processing')} value={counts.processing} tone={counts.processing > 0 ? 'warn' : 'default'} />
      <StatChip label={t('completed')} value={counts.completed} tone="success" />
      <StatChip label={t('failed')} value={counts.failed} tone={counts.failed > 0 ? 'danger' : 'default'} />

      <div className="ml-auto flex items-center gap-4 text-[length:var(--fs-xs)] text-text-400">
        <span>
          {t('lastSync')}: {cursor?.lastSyncFinishedAt ? formatRelativeTime(t, cursor.lastSyncFinishedAt, now) : t('never')}
        </span>
        {cursor?.nextSyncAt && (
          <span>
            {t('nextSync')}: {formatRelativeTime(t, cursor.nextSyncAt, now)}
          </span>
        )}
      </div>
    </div>
  )
}
