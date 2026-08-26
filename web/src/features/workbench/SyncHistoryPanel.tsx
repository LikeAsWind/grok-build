import { useTranslation } from 'react-i18next'
import type { TapdSyncRun } from '../../api/tapd'

export interface SyncHistoryPanelProps {
  runs: TapdSyncRun[]
}

const STATUS_TONE: Record<string, string> = {
  running: 'text-blue-500',
  success: 'text-emerald-500',
  failed: 'text-danger-100',
}

export function SyncHistoryPanel({ runs }: SyncHistoryPanelProps) {
  const { t } = useTranslation('workbench')

  if (runs.length === 0) {
    return <div className="text-[length:var(--fs-sm)] text-text-400 py-3 text-center">{t('syncHistoryEmpty')}</div>
  }

  return (
    <div className="flex flex-col gap-1">
      {runs.map(run => (
        <div key={run.id} className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-bg-200/40 text-[length:var(--fs-xs)]">
          <span className={`font-medium shrink-0 ${STATUS_TONE[run.status] ?? 'text-text-300'}`}>
            {t(`runStatus.${run.status}`)}
          </span>
          <span className="text-text-400 shrink-0">{t(`trigger.${run.trigger}`)}</span>
          <span className="text-text-500 shrink-0">{new Date(run.startedAt * 1000).toLocaleString()}</span>
          <span className="text-text-400 ml-auto shrink-0">
            {t('fetched')} {run.stats.fetched} · {t('added')} {run.stats.added} · {t('updated')} {run.stats.updated} ·{' '}
            {t('duplicate')} {run.stats.duplicate}
            {run.stats.failed > 0 && <span className="text-danger-100"> · {t('failed')} {run.stats.failed}</span>}
          </span>
          {run.error && (
            <span className="text-danger-100 truncate max-w-[200px]" title={run.error}>
              {run.error}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
