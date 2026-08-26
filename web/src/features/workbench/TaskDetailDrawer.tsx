import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { ExternalLinkIcon } from '../../components/Icons'
import type { TapdTask } from '../../api/tapd'
import { queueStateBadge } from './taskStatus'

export interface TaskDetailDrawerProps {
  task: TapdTask | null
  onClose: () => void
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border-200/30">
      <span className="text-[length:var(--fs-xs)] text-text-400 shrink-0">{label}</span>
      <span className="text-[length:var(--fs-sm)] text-text-100 text-right break-words">{value}</span>
    </div>
  )
}

export function TaskDetailDrawer({ task, onClose }: TaskDetailDrawerProps) {
  const { t } = useTranslation('workbench')
  const badge = task ? queueStateBadge(task.queueState) : null

  return (
    <Dialog isOpen={!!task} onClose={onClose} title={task?.title ?? t('taskDetail')} width={480}>
      {task && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 pb-2">
            <span className={`size-2 rounded-full shrink-0 ${badge?.dot}`} />
            <span className="text-[length:var(--fs-sm)] text-text-200">{badge && t(badge.labelKey)}</span>
          </div>

          <DetailRow label={t('module')} value={task.module} />
          <DetailRow label={t('priority')} value={task.priority} />
          <DetailRow label={t('owner')} value={task.owner} />
          <DetailRow label="Status" value={task.status} />
          <DetailRow label={t('createdAt')} value={task.tapdCreatedAt} />
          <DetailRow label={t('modifiedAt')} value={task.tapdModifiedAt} />
          {task.lastError && (
            <div className="mt-2 p-2 rounded-md bg-danger-100/10 border border-danger-100/20 text-[length:var(--fs-xs)] text-danger-100 whitespace-pre-wrap">
              {task.lastError}
            </div>
          )}

          <div className="pt-3">
            <a href={task.tapdUrl} target="_blank" rel="noreferrer">
              <Button variant="secondary" size="sm">
                <ExternalLinkIcon size={13} />
                {t('viewInTapd')}
              </Button>
            </a>
          </div>
        </div>
      )}
    </Dialog>
  )
}
