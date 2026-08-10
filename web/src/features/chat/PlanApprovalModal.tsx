// ============================================
// PlanApprovalModal — Plan 审批弹窗
//
// 模型进入 plan 模式后请求退出执行时展示。
// 如果 [ui] yolo = true，useGlobalEvents 会自动批准，不弹此窗。
// ============================================

import { memo, useState, useSyncExternalStore } from 'react'
import { getPlanApprovalRequest, subscribePlanApproval, type PlanEntry } from '../../store/planApprovalStore'

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待处理',
}

const PlanApprovalModal = memo(function PlanApprovalModal() {
  const request = useSyncExternalStore(subscribePlanApproval, getPlanApprovalRequest)
  const [responding, setResponding] = useState(false)

  if (!request) return null

  const handleApprove = () => {
    setResponding(true)
    request.respond({ approved: true })
  }

  const handleReject = () => {
    setResponding(true)
    request.respond({ approved: false })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border-200 bg-bg-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-100 px-5 py-4">
          <h2 className="text-[length:var(--fs-lg)] font-semibold text-text-100">
            计划审批
          </h2>
        </div>

        {/* Plan steps */}
        <div className="max-h-64 overflow-y-auto px-5 py-4">
          {request.entries.length === 0 ? (
            <p className="text-[length:var(--fs-sm)] text-text-200">
              模型请求退出计划模式并开始执行。
            </p>
          ) : (
            <ul className="space-y-2">
              {request.entries.map((e: PlanEntry, i: number) => (
                <li key={i} className="flex items-start gap-2 text-[length:var(--fs-sm)]">
                  <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                    e.status === 'completed' ? 'bg-green-500'
                      : e.status === 'in_progress' ? 'bg-blue-500'
                      : 'bg-text-300'
                  }`} />
                  <span className="text-text-100">{e.content}</span>
                  {e.status && STATUS_LABEL[e.status] && (
                    <span className="shrink-0 rounded bg-bg-200 px-1.5 py-0.5 text-[length:var(--fs-xs)] text-text-400">
                      {STATUS_LABEL[e.status]}
                    </span>
                  )}
                  {e.priority && (
                    <span className="shrink-0 rounded bg-bg-200 px-1.5 py-0.5 text-[length:var(--fs-xs)] text-text-300">
                      {e.priority}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 border-t border-border-100 px-5 py-4">
          <button
            type="button"
            disabled={responding}
            onClick={handleReject}
            className="rounded-md border border-border-200 px-4 py-2 text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200 disabled:opacity-50"
          >
            拒绝
          </button>
          <button
            type="button"
            disabled={responding}
            onClick={handleApprove}
            className="rounded-md bg-primary-600 px-4 py-2 text-[length:var(--fs-sm)] text-white transition-colors hover:bg-primary-700 disabled:opacity-50"
          >
            同意并执行
          </button>
        </div>
      </div>
    </div>
  )
})

export default PlanApprovalModal
