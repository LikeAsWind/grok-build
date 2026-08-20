import { describe, expect, it } from 'vitest'
import { deriveSessionUiStatus } from './status'

describe('deriveSessionUiStatus', () => {
  it('忙碌会话是 working', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: true, hasPendingAction: false, latestNotification: null }),
    ).toEqual({ kind: 'working' })
  })

  it('忙碌 + 有未答复操作仍是 working（以忙碌为准）', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: true, hasPendingAction: true, latestNotification: null }),
    ).toEqual({ kind: 'working' })
  })

  it('未答复操作是 needs_input', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: false, hasPendingAction: true, latestNotification: null }),
    ).toEqual({ kind: 'needs_input' })
  })

  it('最近一条 error 通知是 failed', () => {
    expect(
      deriveSessionUiStatus({
        id: 's1',
        busy: false,
        hasPendingAction: false,
        latestNotification: { type: 'error', timestamp: 200 },
      }),
    ).toEqual({ kind: 'failed' })
  })

  it('completed 通知是 completed', () => {
    expect(
      deriveSessionUiStatus({
        id: 's2',
        busy: false,
        hasPendingAction: false,
        latestNotification: { type: 'completed', timestamp: 300 },
      }),
    ).toEqual({ kind: 'completed' })
  })

  it('没有任何信号是 idle', () => {
    expect(
      deriveSessionUiStatus({ id: 's1', busy: false, hasPendingAction: false, latestNotification: null }),
    ).toEqual({ kind: 'idle' })
  })
})
