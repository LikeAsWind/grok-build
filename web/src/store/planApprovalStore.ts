// ============================================
// planApprovalStore — Plan 审批状态
//
// 后端 x.ai/exit_plan_mode 到达时存入 pending 请求，
// PlanApprovalModal 消费并调用 respond 回传。
// ============================================

export interface PlanApprovalRequest {
  /** Plan 步骤列表 */
  entries: PlanEntry[]
  /** 回传审批结果的回调 */
  respond: (result: { approved: boolean }) => void
}

export interface PlanEntry {
  content: string
  status: string
  priority?: string
}

type Listener = () => void

let _pending: PlanApprovalRequest | null = null
const _listeners = new Set<Listener>()

export function getPlanApprovalRequest(): PlanApprovalRequest | null {
  return _pending
}

export function setPlanApprovalRequest(req: PlanApprovalRequest | null) {
  _pending = req
  _listeners.forEach(fn => fn())
}

export function subscribePlanApproval(fn: Listener): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
