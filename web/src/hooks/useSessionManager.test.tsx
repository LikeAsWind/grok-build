import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'

const {
  getSessionMock,
  getSessionMessagesMock,
  messageStoreMock,
  sessionErrorHandlerMock,
  acpLoadSessionMock,
  finishAcpReplayMock,
  resetAcpTurnStateMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  messageStoreMock: {
    getSessionState: vi.fn(),
    setLoadState: vi.fn(),
    setLoadError: vi.fn(),
    setMessages: vi.fn(),
    updateSessionMetadata: vi.fn(),
    prependMessages: vi.fn(),
    setRevertState: vi.fn(),
    clearSession: vi.fn(),
    handleSessionIdle: vi.fn(),
    injectSynthMessages: vi.fn(),
  },
  sessionErrorHandlerMock: vi.fn(),
  acpLoadSessionMock: vi.fn(),
  finishAcpReplayMock: vi.fn(),
  resetAcpTurnStateMock: vi.fn(),
}))

vi.mock('../api', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  getSessionMessages: (...args: unknown[]) => getSessionMessagesMock(...args),
  revertMessage: vi.fn(),
  unrevertSession: vi.fn(),
  extractUserMessageContent: vi.fn(),
}))

vi.mock('../api/acpBridge', () => ({
  acpLoadSession: (...args: unknown[]) => acpLoadSessionMock(...args),
  finishAcpReplay: (...args: unknown[]) => finishAcpReplayMock(...args),
  resetAcpTurnState: (...args: unknown[]) => resetAcpTurnStateMock(...args),
}))

vi.mock('../features/message/synthNotifPersist', () => ({
  loadSynthMessages: vi.fn(() => []),
  restoreChildSessions: vi.fn(),
}))

vi.mock('../store', () => ({
  messageStore: messageStoreMock,
}))

vi.mock('../utils', () => ({
  sessionErrorHandler: (...args: unknown[]) => sessionErrorHandlerMock(...args),
}))

/** 构造最小 SessionState;messages 数量用 count 表示 */
function fakeState(count: number, overrides: Record<string, unknown> = {}) {
  return {
    messages: Array.from({ length: count }, (_, i) => ({
      info: { id: `msg_${i}`, role: i % 2 ? 'assistant' : 'user', sessionID: 's1', time: { created: i } },
      parts: [],
    })),
    loadState: 'idle',
    isStale: false,
    isStreaming: false,
    directory: '',
    ...overrides,
  }
}

function renderManager() {
  // sessionId 传 null:阻止 effect 自动加载,由测试手动调 loadSession
  return renderHook(() => useSessionManager({ sessionId: null, directory: '/workspace/demo' }))
}

describe('useSessionManager', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    getSessionMessagesMock.mockReset()
    Object.values(messageStoreMock).forEach(fn => fn.mockReset())
    sessionErrorHandlerMock.mockReset()
    acpLoadSessionMock.mockReset()
    finishAcpReplayMock.mockReset()
    resetAcpTurnStateMock.mockReset()

    messageStoreMock.getSessionState.mockReturnValue(null)
    getSessionMock.mockResolvedValue({ id: 's1', directory: '/workspace/demo' })
    getSessionMessagesMock.mockResolvedValue([])
    acpLoadSessionMock.mockResolvedValue(undefined)
  })

  // ACP 模式：session/load 路径与 REST 不同，onSessionMissing 由 ACP 错误事件驱动
  it.skip('reports missing route sessions when loading returns not found', async () => {
    /* 原 REST 用例保留占位 */
  })

  it('部分缓存(无 loaded 基线)时仍走 ACP 回放,先清残留', async () => {
    // store 里已有 1 条消息(如后台会话事件顺带写入),但从未完整加载过
    let state = fakeState(1)
    messageStoreMock.getSessionState.mockImplementation(() => state)
    messageStoreMock.clearSession.mockImplementation(() => {
      state = fakeState(0)
    })
    acpLoadSessionMock.mockImplementation(async () => {
      // 模拟回放帧写入全量历史
      state = fakeState(3, { loadState: 'loading' })
    })

    const { result } = renderManager()
    await result.current.loadSession('s1')

    // 必须发起回放(旧实现因 hasExistingMessages=true 而跳过 → 红)
    expect(acpLoadSessionMock).toHaveBeenCalledWith('s1')
    // 清残留必须发生在回放之前
    expect(resetAcpTurnStateMock).toHaveBeenCalledWith('s1')
    expect(messageStoreMock.clearSession.mock.invocationCallOrder[0]).toBeLessThan(
      acpLoadSessionMock.mock.invocationCallOrder[0],
    )
    // 回放完成后标记 loaded
    expect(messageStoreMock.updateSessionMetadata).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ loadState: 'loaded' }),
    )
  })

  it('已有完整 loaded 基线时不重复回放', async () => {
    messageStoreMock.getSessionState.mockReturnValue(fakeState(2, { loadState: 'loaded' }))

    const { result } = renderManager()
    await result.current.loadSession('s1')

    expect(acpLoadSessionMock).not.toHaveBeenCalled()
  })

  it('回放进行中第二次 loadSession 等待首个完成,不提前标 loaded', async () => {
    let state: ReturnType<typeof fakeState> | null = null
    messageStoreMock.getSessionState.mockImplementation(() => state)

    let resolveReplay!: () => void
    acpLoadSessionMock.mockImplementation(() => {
      // 首帧到达:store 里出现部分消息
      state = fakeState(1, { loadState: 'loading' })
      return new Promise<void>(r => {
        resolveReplay = () => {
          // 回放剩余帧到齐
          state = fakeState(3, { loadState: 'loading' })
          r()
        }
      })
    })

    const { result } = renderManager()
    const first = result.current.loadSession('s1')
    // 等首帧进入 store(acpLoadSession 已被调用)
    await waitFor(() => expect(acpLoadSessionMock).toHaveBeenCalledTimes(1))

    const second = result.current.loadSession('s1')
    // 让第二个调用有机会(错误地)走完 snapshot 路径
    await new Promise(r => setTimeout(r, 20))

    // 第二个调用不得提前把部分快照标成 loaded(旧实现走 snapshot 恒等 → 红)
    expect(messageStoreMock.updateSessionMetadata).not.toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ loadState: 'loaded' }),
    )
    expect(messageStoreMock.setMessages).not.toHaveBeenCalled()
    // 也不允许发起第二次回放(消息 id 本地生成,双回放必然重复)
    expect(acpLoadSessionMock).toHaveBeenCalledTimes(1)

    resolveReplay()
    await Promise.all([first, second])

    // 首个回放完成后才标 loaded,且只标一次
    const loadedCalls = messageStoreMock.updateSessionMetadata.mock.calls.filter(
      ([, meta]) => (meta as { loadState?: string }).loadState === 'loaded',
    )
    expect(loadedCalls).toHaveLength(1)
  })

  it('acpLoadSession resolve 后立即标 loaded,不依赖 requestAnimationFrame', async () => {
    // 后台标签页 RAF 被浏览器冻结——加载流程绝不能 await RAF
    const rafSpy = vi.fn(() => 0)
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    try {
      let state: ReturnType<typeof fakeState> | null = null
      messageStoreMock.getSessionState.mockImplementation(() => state)
      acpLoadSessionMock.mockImplementation(async () => {
        state = fakeState(2, { loadState: 'loading' })
      })

      const { result } = renderManager()
      // RAF 永不回调:旧实现会永远挂起(→ 超时红),新实现 300ms 内完成
      await Promise.race([
        result.current.loadSession('s1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loadSession 挂起:仍在等待 requestAnimationFrame')), 300)),
      ])

      expect(messageStoreMock.updateSessionMetadata).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ loadState: 'loaded' }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
