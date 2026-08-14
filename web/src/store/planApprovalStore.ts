// ============================================
// planApprovalStore — Plan 审批状态
//
// 后端 x.ai/exit_plan_mode 到达时存入 pending 请求，
// PlanApprovalModal 消费并调用 respond 回传。
// wire 协议见 exit_plan_mode/types.rs：
// 请求 { sessionId, toolCallId, planContent }，
// 响应 { outcome: "approved"|"cancelled"|"abandoned", feedback? }。
// ============================================

export interface PlanApprovalRequest {
  /** 计划全文（markdown，来自 plan.md）；后端可能为空 */
  planContent: string | null
  /** 回传审批结果的回调 */
  respond: (result: { outcome: 'approved' | 'cancelled' | 'abandoned'; feedback?: string }) => void
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
