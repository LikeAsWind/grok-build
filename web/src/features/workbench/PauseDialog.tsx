// v2 spec §7.2.1: PauseDialog confirms a user-initiated pause.
// Optional reason is passed to x.ai/workbench/pause ext method, which records
// it on the intervention registry and emits `x.ai/workbench/stage` with
// stage: "paused" (consumed by the WorkbenchHeader "Paused" badge).
//
// Cancel + dismiss without pausing both leave the task running. The dialog
// disables the Pause button while the ext request is in flight.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { acpExtRequest } from '../../api/acpBridge'
import { handleError } from '../../utils'

export interface PauseDialogProps {
  isOpen: boolean
  tapdId: string
  onClose: () => void
  onPaused?: () => void
}

export function PauseDialog({ isOpen, tapdId, onClose, onPaused }: PauseDialogProps) {
  const { t } = useTranslation('workbench')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handlePause = async () => {
    setSubmitting(true)
    setError('')
    try {
      await acpExtRequest('x.ai/workbench/pause', {
        tapd_id: tapdId,
        reason: reason.trim() || null,
      })
      onPaused?.()
      onClose()
    } catch (e) {
      setError(handleError(e).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('pauseDialogTitle')} width={420}>
      <div className="space-y-3">
        <p className="text-[length:var(--fs-sm)] text-text-400">
          {t('pauseDialogDesc', { tapdId })}
        </p>
        <label className="block">
          <span className="text-[length:var(--fs-xs)] text-text-400 block mb-1">
            {t('pauseDialogReason')}
          </span>
          <textarea
            className="w-full rounded border border-border-200/40 bg-bg-100 px-2 py-1 text-[length:var(--fs-sm)] text-text-100 resize-y min-h-[60px]"
            placeholder={t('pauseDialogReasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
          />
        </label>
        {error && (
          <div className="text-[length:var(--fs-xs)] text-danger-100">{error}</div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handlePause} disabled={submitting}>
            {submitting ? t('pausing') : t('pause')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

