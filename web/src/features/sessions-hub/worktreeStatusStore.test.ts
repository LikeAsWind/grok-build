import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreeStatusStore, subscribeWorktreeStatus } from './worktreeStatusStore'

describe('worktreeStatusStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    worktreeStatusStore.clearAll()
  })

  it('收到 x.ai/git/worktree/status 通知后通知订阅者', () => {
    const cb = vi.fn()
    const unsubscribe = subscribeWorktreeStatus('k1', cb)
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'progress',
      sessionId: 'k1',
      message: 'copying…',
    })
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ kind: 'progress', message: 'copying…' }))
    unsubscribe()
  })

  it('created 通知携带 worktreePath', () => {
    const cb = vi.fn()
    subscribeWorktreeStatus('k2', cb)
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'created',
      sessionId: 'k2',
      worktreePath: 'C:\\repo\\.claude\\worktrees\\w',
    })
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'created', worktreePath: 'C:\\repo\\.claude\\worktrees\\w' }),
    )
  })

  it('error 通知映射 kind=error', () => {
    const cb = vi.fn()
    subscribeWorktreeStatus('k3', cb)
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'error',
      sessionId: 'k3',
      message: 'boom',
    })
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', message: 'boom' }))
  })

  it('无关 ext 通知被忽略', () => {
    const cb = vi.fn()
    subscribeWorktreeStatus('k4', cb)
    worktreeStatusStore.onExtNotification('x.ai/other', {})
    expect(cb).not.toHaveBeenCalled()
  })
})