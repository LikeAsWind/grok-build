// ============================================
// PlanApprovalModal — Plan 审批弹窗
//
// 模型进入 plan 模式后请求退出执行时展示 plan.md 全文供审阅。
// 如果 [ui] yolo = true，useGlobalEvents 会自动批准，不弹此窗。
// 响应协议（exit_plan_mode/types.rs）：
//   approved  — 批准，开始实现
//   cancelled — 要求修改（可带 feedback），回到计划模式
//   abandoned — 放弃计划，退出计划模式
// ============================================

import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { getPlanApprovalRequest, subscribePlanApproval } from '../../store/planApprovalStore'
import { MarkdownRenderer } from '../../components'

const PlanApprovalModal = memo(function PlanApprovalModal() {
  const { t } = useTranslation('chat')
  const request = useSyncExternalStore(subscribePlanApproval, getPlanApprovalRequest)
  const [responding, setResponding] = useState(false)
  const [feedbackMode, setFeedbackMode] = useState(false)
  const [feedback, setFeedback] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  // 新请求到达时复位内部状态
  const requestRef = useRef(request)
  useEffect(() => {
    if (request !== requestRef.current) {
      requestRef.current = request
      setResponding(false)
      setFeedbackMode(false)
      setFeedback('')
    }
  }, [request])

  useEffect(() => {
    if (feedbackMode) feedbackRef.current?.focus()
  }, [feedbackMode])

  // 键盘：Enter 批准 / Esc 收起反馈框（反馈框内不劫持 Enter）
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (responding) return
      if (e.key === 'Enter' && !feedbackMode && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        setResponding(true)
        request.respond({ outcome: 'approved' })
      } else if (e.key === 'Escape' && feedbackMode) {
        e.preventDefault()
        setFeedbackMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, responding, feedbackMode])

  if (!request) return null

  const handleApprove = () => {
    setResponding(true)
    request.respond({ outcome: 'approved' })
  }

  const handleRequestChanges = () => {
    setResponding(true)
    request.respond({ outcome: 'cancelled', feedback: feedback.trim() || undefined })
  }

  const handleAbandon = () => {
    setResponding(true)
    request.respond({ outcome: 'abandoned' })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-border-200 bg-bg-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-100 px-5 py-4">
          <h2 className="text-[length:var(--fs-lg)] font-semibold text-text-100">
            {t('planApproval.title')}
          </h2>
          <span className="text-[length:var(--fs-sm)] text-text-400">{t('planApproval.subtitle')}</span>
        </div>

        {/* Plan content — plan.md 全文 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {request.planContent ? (
            <MarkdownRenderer content={request.planContent} />
          ) : (
            <p className="text-[length:var(--fs-sm)] text-text-200">
              {t('planApproval.emptyPlan')}
            </p>
          )}
        </div>

        {/* Feedback input（要求修改时展开） */}
        {feedbackMode && (
          <div className="border-t border-border-100 px-5 py-3">
            <textarea
              ref={feedbackRef}
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder={t('planApproval.feedbackPlaceholder')}
              rows={3}
              className="w-full resize-none rounded-md border border-border-200 bg-bg-000 px-3 py-2 text-[length:var(--fs-sm)] text-text-100 placeholder:text-text-500 focus:border-accent-main-100 focus:outline-none"
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-3 border-t border-border-100 px-5 py-4">
          <button
            type="button"
            disabled={responding}
            onClick={handleAbandon}
            className="rounded-md px-3 py-2 text-[length:var(--fs-sm)] text-text-400 transition-colors hover:text-danger-100 disabled:opacity-50"
          >
            {t('planApproval.abandon')}
          </button>
          <div className="flex gap-3">
            {feedbackMode ? (
              <button
                type="button"
                disabled={responding}
                onClick={handleRequestChanges}
                className="rounded-md border border-border-200 px-4 py-2 text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200 disabled:opacity-50"
              >
                {t('planApproval.sendFeedback')}
              </button>
            ) : (
              <button
                type="button"
                disabled={responding}
                onClick={() => setFeedbackMode(true)}
                className="rounded-md border border-border-200 px-4 py-2 text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200 disabled:opacity-50"
              >
                {t('planApproval.requestChanges')}
              </button>
            )}
            <button
              type="button"
              disabled={responding}
              onClick={handleApprove}
              className="rounded-md bg-text-100 px-4 py-2 text-[length:var(--fs-sm)] font-medium text-bg-000 transition-colors hover:bg-text-200 disabled:opacity-50"
            >
              {t('planApproval.approve')}
              <span className="ml-2 text-[length:var(--fs-xs)] opacity-70">⏎</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})

export default PlanApprovalModal
