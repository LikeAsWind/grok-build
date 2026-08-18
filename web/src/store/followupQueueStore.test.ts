// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { shouldQueueFollowup } from './followupQueueStore'

describe('shouldQueueFollowup', () => {
  it('无 sessionId 时不排队（新会话首条消息直接发送）', () => {
    expect(shouldQueueFollowup({ sessionId: null, queuedCount: 0, sessionBusy: true })).toBe(false)
  })

  it('会话空闲且队列为空时不排队', () => {
    expect(shouldQueueFollowup({ sessionId: 's1', queuedCount: 0, sessionBusy: false })).toBe(false)
  })

  it('会话忙碌时必须排队——ACP 同会话不能并发 prompt，直接发送会静默阻塞在 acpPrompt 等上一轮收尾', () => {
    expect(shouldQueueFollowup({ sessionId: 's1', queuedCount: 0, sessionBusy: true })).toBe(true)
  })

  it('队列非空时即使空闲也排队（保持消息顺序，等 drain 依次发送）', () => {
    expect(shouldQueueFollowup({ sessionId: 's1', queuedCount: 2, sessionBusy: false })).toBe(true)
  })
})
