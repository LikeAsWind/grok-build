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

  it('stale unsubscribe 不会误删同 key 新订阅者', () => {
    const cbA = vi.fn()
    const cbB = vi.fn()
    const unsubA = subscribeWorktreeStatus('kR', cbA)
    unsubA()  // 清空 'kR' 集合并删除 map 条目
    subscribeWorktreeStatus('kR', cbB)  // 同 key 重新订阅
    unsubA()  // 二次调用：set 已 replace，B 不受影响
    // 现在推一条 created 通知给 'kR'，cbB 必须仍然收到
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'created',
      sessionId: 'kR',
      worktreePath: 'C:\\w',
    })
    expect(cbB).toHaveBeenCalledWith(expect.objectContaining({ kind: 'created', worktreePath: 'C:\\w' }))
    expect(cbA).not.toHaveBeenCalled()
  })

  it('clearAll 后同 key 新订阅者不受 stale unsubscribe 影响', () => {
    const cbA = vi.fn()
    const cbB = vi.fn()
    const unsubA = subscribeWorktreeStatus('kC', cbA)
    worktreeStatusStore.clearAll()
    subscribeWorktreeStatus('kC', cbB)
    unsubA()  // stale 闭包引用旧 set
    worktreeStatusStore.onExtNotification('x.ai/git/worktree/status', {
      status: 'created',
      sessionId: 'kC',
      worktreePath: 'C:\\w',
    })
    expect(cbB).toHaveBeenCalled()
  })
})