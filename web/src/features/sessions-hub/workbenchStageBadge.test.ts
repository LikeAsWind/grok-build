import { describe, it, expect } from 'vitest'
import { deriveWorkbenchStage } from './workbenchStageBadge'

describe('workbenchStageBadge', () => {
  it('done renders success tone', () => {
    expect(deriveWorkbenchStage({ kind: 'done', mrUrl: 'https://x' })).toEqual({
      label: 'MR 已提交',
      tone: 'success',
    })
  })

  it('blocked renders danger tone', () => {
    expect(deriveWorkbenchStage({ kind: 'blocked', reason: 'needs_owner_decision' })).toEqual({
      label: '需人工',
      tone: 'danger',
    })
  })

  it('dead renders danger tone', () => {
    expect(deriveWorkbenchStage({ kind: 'dead', reason: 'crash' })).toEqual({
      label: '已失败',
      tone: 'danger',
    })
  })

  it('running uses stage label', () => {
    expect(deriveWorkbenchStage({ kind: 'running', stage: 'develop', attempt: 0 })).toEqual({
      label: '开发',
      tone: 'progress',
    })
    expect(deriveWorkbenchStage({ kind: 'running', stage: 'adjudicate', attempt: 0 })).toEqual({
      label: '裁断',
      tone: 'progress',
    })
  })

  it('queued and pending render muted', () => {
    expect(deriveWorkbenchStage({ kind: 'queued' })).toEqual({ label: '排队', tone: 'muted' })
    expect(deriveWorkbenchStage({ kind: 'pending' })).toEqual({ label: '待处理', tone: 'muted' })
  })
})
