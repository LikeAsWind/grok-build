// v2 spec §9.2.3: ReplayDialog picks the stage to restart from. Always warns
// the user that prior artifacts are moved aside (D16: destructive replay).
// Supports an optional `pre_approved: true` flag for the human_pre_approve
// path (M2.8), which is only enabled when replay_from === "adjudicate" AND the
// task has a design doc to preview.
//
// Ext method: x.ai/workbench/replay with body
//   { tapd_id, replay_from, reason, pre_approved? }

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { acpExtRequest } from '../../api/acpBridge'

const STAGES = [
  'brainstorm', 'adjudicate', 'develop', 'code_review', 'verify', 'mr_submit',
] as const;
type Stage = typeof STAGES[number];

export interface ReplayDialogProps {
  isOpen: boolean
  tapdId: string
  defaultStage?: Stage
  /** True only when replay_from is "adjudicate" AND the task has a design doc to preview. */
  allowPreApprove?: boolean
  onClose: () => void
  onReplayed?: (stage: Stage) => void
}

export function ReplayDialog({
  isOpen,
  tapdId,
  defaultStage = 'develop',
  allowPreApprove = false,
  onClose,
  onReplayed,
}: ReplayDialogProps) {
  const { t } = useTranslation('workbench')
  const [stage, setStage] = useState<Stage>(defaultStage)
  const [reason, setReason] = useState('')
  const [preApprove, setPreApprove] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleReplay = async () => {
    setSubmitting(true)
    setError('')
    try {
      await acpExtRequest('x.ai/workbench/replay', {
        tapd_id: tapdId,
        replay_from: stage,
        reason: reason.trim() || null,
        ...(allowPreApprove && preApprove ? { pre_approved: true } : {}),
      })
      onReplayed?.(stage)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('replayDialogTitle')} width={460}>
      <div className="space-y-3">
        <div className="rounded border border-warning-100/40 bg-warning-100/10 p-2 text-[length:var(--fs-xs)] text-warning-100">
          {t('replayDialogWarning')}
        </div>
        <label className="block">
          <span className="text-[length:var(--fs-xs)] text-text-400 block mb-1">
            {t('replayDialogStage')}
          </span>
          <select
            className="w-full rounded border border-border-200/40 bg-bg-100 px-2 py-1 text-[length:var(--fs-sm)] text-text-100"
            value={stage}
            onChange={(e) => setStage(e.target.value as Stage)}
            disabled={submitting}
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {t(`replayStage_${s}`)}
              </option>
            ))}
          </select>
        </label>
        {allowPreApprove && stage === 'adjudicate' ? (
          <label className="flex items-center gap-2 text-[length:var(--fs-sm)] text-text-200">
            <input
              type="checkbox"
              checked={preApprove}
              onChange={(e) => setPreApprove(e.target.checked)}
              disabled={submitting}
            />
            {t('replayDialogPreApprove')}
          </label>
        ) : null}
        <label className="block">
          <span className="text-[length:var(--fs-xs)] text-text-400 block mb-1">
            {t('replayDialogReason')}
          </span>
          <input
            type="text"
            className="w-full rounded border border-border-200/40 bg-bg-100 px-2 py-1 text-[length:var(--fs-sm)] text-text-100"
            placeholder={t('replayDialogReasonPlaceholder')}
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
          <Button variant="primary" size="sm" onClick={handleReplay} disabled={submitting}>
            {submitting ? t('replaying') : t('replay')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

