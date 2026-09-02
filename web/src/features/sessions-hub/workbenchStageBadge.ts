// Maps a workbench TaskState into a UI badge (label + tone).
// Spec §15.1 — main session row displays current stage with this badge.

export type WorkbenchStageState =
  | { kind: 'pending' }
  | { kind: 'queued' }
  | { kind: 'running'; stage: 'brainstorm' | 'adjudicate' | 'develop' | 'code_review' | 'verify' | 'mr_submit'; attempt: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'done'; mrUrl: string }
  | { kind: 'dead'; reason: string }

export interface WorkbenchStageBadge {
  label: string
  tone: 'progress' | 'success' | 'danger' | 'muted'
}

const STAGE_LABEL: Record<NonNullable<Extract<WorkbenchStageState, { kind: 'running' }>['stage']>, string> = {
  brainstorm: '设计',
  adjudicate: '裁断',
  develop: '开发',
  code_review: '评审',
  verify: '验证',
  mr_submit: '提 MR',
}

export function deriveWorkbenchStage(state: WorkbenchStageState): WorkbenchStageBadge {
  switch (state.kind) {
    case 'pending':
      return { label: '待处理', tone: 'muted' }
    case 'queued':
      return { label: '排队', tone: 'muted' }
    case 'running':
      return { label: STAGE_LABEL[state.stage], tone: 'progress' }
    case 'blocked':
      return { label: '需人工', tone: 'danger' }
    case 'done':
      return { label: 'MR 已提交', tone: 'success' }
    case 'dead':
      return { label: '已失败', tone: 'danger' }
  }
}
