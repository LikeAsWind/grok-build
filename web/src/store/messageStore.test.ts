import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiMessage, ApiMessageWithParts, ApiPart } from '../api/types'
import type { Message } from '../types/message'
import { messageStore } from './messageStore'

function createAssistantMessage(id: string, sessionID = 'session-1'): ApiMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'chat',
    agent: 'build',
    path: {
      cwd: '/workspace',
      root: '/workspace',
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: {
      created: 1,
      completed: 2,
    },
  }
}

function createTextPart(
  id: string,
  messageID: string,
  text: string,
  sessionID = 'session-1',
): ApiPart & { sessionID: string; messageID: string } {
  return {
    id,
    sessionID,
    messageID,
    type: 'text',
    text,
  }
}

function createMessageWithParts(id: string, text: string, sessionID = 'session-1'): ApiMessageWithParts {
  return {
    info: createAssistantMessage(id, sessionID),
    parts: [createTextPart(`part-${id}`, id, text, sessionID)],
  }
}

describe('messageStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('applies a part update when the message already exists', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createTextPart('part-1', 'message-1', 'hello'))

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(1)
    expect(state?.messages[0].parts).toHaveLength(1)
    expect(state?.messages[0].parts[0]).toMatchObject({ id: 'part-1', type: 'text', text: 'hello' })
  })

  it('silently drops a part update when the message does not exist yet', () => {
    // Part arrives before message — should be silently dropped (no pending queue)
    messageStore.handlePartUpdated(createTextPart('part-1', 'message-1', 'hello'))

    const state = messageStore.getSessionState('session-1')
    // session-1 doesn't exist because handlePartUpdated doesn't ensureSession
    expect(state).toBeUndefined()
  })

  it('marks cached sessions stale after reconnect and clears the flag after a fresh load', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])

    expect(messageStore.isSessionStale('session-1')).toBe(false)

    messageStore.markAllSessionsStale()
    expect(messageStore.isSessionStale('session-1')).toBe(true)

    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello again')])
    expect(messageStore.isSessionStale('session-1')).toBe(false)
  })

  it('accepts exported message envelopes that use message instead of info', () => {
    messageStore.setMessages('session-1', [
      {
        message: createAssistantMessage('message-1'),
        parts: [createTextPart('part-message-1', 'message-1', 'hello')],
      } as unknown as ApiMessageWithParts,
    ])

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(1)
    expect(state?.messages[0].info.id).toBe('message-1')
    expect(state?.messages[0].parts[0]).toMatchObject({ id: 'part-message-1', type: 'text', text: 'hello' })
  })

  it('truncates messages after revert point', () => {
    messageStore.setMessages('session-1', [
      createMessageWithParts('message-1', 'one'),
      createMessageWithParts('message-2', 'two'),
      createMessageWithParts('message-3', 'three'),
    ])
    messageStore.setRevertState('session-1', {
      messageId: 'message-2',
      history: [],
    })

    messageStore.truncateAfterRevert('session-1')

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(1)
    expect(state?.messages[0].info.id).toBe('message-1')
    expect(state?.revertState).toBeNull()
  })

  it('removes a part from a message', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])

    messageStore.handlePartRemoved({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-message-1',
    })

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages[0].parts).toHaveLength(0)
  })

  it('deduplicates messages in prependMessages', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-2', 'two')])

    messageStore.prependMessages(
      'session-1',
      [createMessageWithParts('message-1', 'one'), createMessageWithParts('message-2', 'duplicate')],
      true,
    )

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(2)
    expect(state?.messages[0].info.id).toBe('message-1')
    expect(state?.messages[1].info.id).toBe('message-2')
  })

  it('creates a session when starting streaming', () => {
    messageStore.setStreaming('session-1', true)

    const state = messageStore.getSessionState('session-1')
    expect(state?.isStreaming).toBe(true)
    expect(state?.messages).toHaveLength(0)
    expect(state?.loadState).toBe('idle')
  })

  it('does not create a session when stopping streaming for a missing session', () => {
    messageStore.setStreaming('session-1', false)

    expect(messageStore.getSessionState('session-1')).toBeUndefined()
  })

  it('does not regress longer live part text when a shorter snapshot arrives while streaming', () => {
    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello world')],
      },
    ])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    messageStore.handlePartUpdated({
      ...createTextPart('part-message-1', 'message-1', 'hello'),
    })

    expect(messageStore.getSessionState('session-1')?.messages[0].parts[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('adopts a longer server snapshot when reloading messages', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello world')])

    expect(messageStore.getSessionState('session-1')?.messages[0].parts[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('keeps longer live text when setMessages receives a shorter server snapshot while streaming', () => {
    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello world')],
      },
    ])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello')],
      },
    ])

    expect(messageStore.getSessionState('session-1')?.messages[0].parts[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('adopts completed server text even when local live text was longer', () => {
    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello world extra')],
      },
    ])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    // 定稿：completed 快照强制采用服务端，不再 preserve
    const completed = createMessageWithParts('message-1', 'hello world')
    if (completed.info.role === 'assistant') {
      completed.info.time = { created: 1, completed: 99 }
    }
    messageStore.setMessages('session-1', [completed])

    expect(messageStore.getSessionState('session-1')?.messages[0].parts[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('forces completed message part updates from the server', () => {
    const completed = createMessageWithParts('message-1', 'hello world extra')
    if (completed.info.role === 'assistant') {
      completed.info.time = { created: 1, completed: 10 }
    }
    messageStore.setMessages('session-1', [completed])

    messageStore.handlePartUpdated({
      ...createTextPart('part-message-1', 'message-1', 'hello world'),
    })

    expect(messageStore.getSessionState('session-1')?.messages[0].parts[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('flushes mutable part deltas for multiple sessions in the same frame', () => {
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])
    messageStore.setMessages('session-2', [createMessageWithParts('message-2', 'world', 'session-2')])

    const beforeMessage1 = messageStore.getSessionState('session-1')?.messages[0]
    const beforeMessage2 = messageStore.getSessionState('session-2')?.messages[0]

    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-message-1',
      field: 'text',
      delta: '!',
    })
    messageStore.handlePartDelta({
      sessionID: 'session-2',
      messageID: 'message-2',
      partID: 'part-message-2',
      field: 'text',
      delta: '?',
    })

    const scheduledFrame = rafCallbacks[0]
    if (!scheduledFrame) {
      throw new Error('Expected requestAnimationFrame callback to be scheduled')
    }
    scheduledFrame(0)

    const afterMessage1 = messageStore.getSessionState('session-1')?.messages[0]
    const afterMessage2 = messageStore.getSessionState('session-2')?.messages[0]

    expect(afterMessage1?.parts[0]).toMatchObject({ text: 'hello!' })
    expect(afterMessage2?.parts[0]).toMatchObject({ text: 'world?' })
    expect(afterMessage1).not.toBe(beforeMessage1)
    expect(afterMessage2).not.toBe(beforeMessage2)
  })

  it('preserves settled part references when another part receives a delta', () => {
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return 1
    })

    const message = createMessageWithParts('message-1', 'settled')
    message.parts.push(createTextPart('part-live', 'message-1', 'live'))
    messageStore.setMessages('session-1', [message])

    const beforeMessage = messageStore.getSessionState('session-1')?.messages[0]
    const beforeSettledPart = beforeMessage?.parts[0]
    const beforeLivePart = beforeMessage?.parts[1]

    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-live',
      field: 'text',
      delta: ' text',
    })
    rafCallbacks[0]?.(0)

    const afterMessage = messageStore.getSessionState('session-1')?.messages[0]
    expect(afterMessage).not.toBe(beforeMessage)
    expect(afterMessage?.parts[0]).toBe(beforeSettledPart)
    expect(afterMessage?.parts[1]).not.toBe(beforeLivePart)
    expect(afterMessage?.parts[1]).toMatchObject({ text: 'live text' })
  })

  it('notifies only subscribers for changed sessions', () => {
    const session1Subscriber = vi.fn()
    const session2Subscriber = vi.fn()
    const allSubscriber = vi.fn()
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return rafCallbacks.length
    })

    const unsubscribeSession1 = messageStore.subscribeSession('session-1', session1Subscriber)
    const unsubscribeSession2 = messageStore.subscribeSession('session-2', session2Subscriber)
    const unsubscribeAll = messageStore.subscribe(allSubscriber)

    messageStore.setMessages('session-2', [createMessageWithParts('message-2', 'world', 'session-2')])
    rafCallbacks.shift()?.(0)

    expect(session1Subscriber).not.toHaveBeenCalled()
    expect(session2Subscriber).toHaveBeenCalledTimes(1)
    expect(allSubscriber).toHaveBeenCalledTimes(1)

    unsubscribeSession1()
    unsubscribeSession2()
    unsubscribeAll()
  })
})

describe('injectSynthMessages 锚点定位', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  function userMsg(id: string, text: string): ApiMessageWithParts {
    return {
      info: { ...createAssistantMessage(id), role: 'user' } as ApiMessage,
      parts: [createTextPart(`part-${id}`, id, text)],
    }
  }

  function synthNotif(taskId: string): Message {
    return {
      info: {
        id: `msg_tasknotif_${taskId}`,
        sessionID: 'session-1',
        role: 'assistant',
        time: { created: 100, completed: 100 },
      } as Message['info'],
      parts: [],
    }
  }

  function ids() {
    return (messageStore.getSessionState('session-1')?.messages ?? []).map(m => m.info.id)
  }

  it('锚点用户消息命中：插到该轮之后、下一条用户消息之前', () => {
    messageStore.setMessages('session-1', [
      userMsg('u1', '启动子代理'),
      createMessageWithParts('a1', '好的，已启动'),
      userMsg('u2', '另一个问题'),
      createMessageWithParts('a2', '回答'),
    ])
    messageStore.injectSynthMessages('session-1', [
      { message: synthNotif('t1'), anchor: { userText: '启动子代理', userIndex: 1 } },
    ])
    expect(ids()).toEqual(['u1', 'a1', 'msg_tasknotif_t1', 'u2', 'a2'])
  })

  it('锚点未命中或缺失：追加到末尾', () => {
    messageStore.setMessages('session-1', [userMsg('u1', 'hello'), createMessageWithParts('a1', 'hi')])
    messageStore.injectSynthMessages('session-1', [
      { message: synthNotif('t1'), anchor: { userText: '不存在的文本', userIndex: 1 } },
      { message: synthNotif('t2') },
    ])
    expect(ids()).toEqual(['u1', 'a1', 'msg_tasknotif_t1', 'msg_tasknotif_t2'])
  })

  it('存在 wake 回复：卡片紧贴其前（优先于文本锚点）', () => {
    messageStore.setMessages('session-1', [
      userMsg('u1', '启动子代理'),
      createMessageWithParts('a1', '好的'),
      createMessageWithParts('msg_wake_t1', '任务完成，结果是……'),
      userMsg('u2', '继续'),
    ])
    messageStore.injectSynthMessages('session-1', [
      { message: synthNotif('t1'), anchor: { userText: '继续', userIndex: 2 } },
    ])
    expect(ids()).toEqual(['u1', 'a1', 'msg_tasknotif_t1', 'msg_wake_t1', 'u2'])
  })

  it('同 id 已存在（live/回放已按事件流定位）：跳过，不重定位', () => {
    messageStore.setMessages('session-1', [
      userMsg('u1', '启动子代理'),
      createMessageWithParts('a1', '好的'),
      createMessageWithParts('msg_tasknotif_t1', '通知'),
      userMsg('u2', '下一轮'),
    ])
    messageStore.injectSynthMessages('session-1', [
      { message: synthNotif('t1'), anchor: { userText: '下一轮', userIndex: 2 } },
    ])
    expect(ids()).toEqual(['u1', 'a1', 'msg_tasknotif_t1', 'u2'])
  })

  it('多条通知共享同一锚点：保持持久化顺序', () => {
    messageStore.setMessages('session-1', [
      userMsg('u1', '并行跑两个任务'),
      createMessageWithParts('a1', '已启动'),
      userMsg('u2', '后续'),
    ])
    messageStore.injectSynthMessages('session-1', [
      { message: synthNotif('t1'), anchor: { userText: '并行跑两个任务', userIndex: 1 } },
      { message: synthNotif('t2'), anchor: { userText: '并行跑两个任务', userIndex: 1 } },
    ])
    expect(ids()).toEqual(['u1', 'a1', 'msg_tasknotif_t1', 'msg_tasknotif_t2', 'u2'])
  })

  it('完整锚点全等匹配：不被前缀扩展的后续消息误命中', () => {
    messageStore.setMessages('session-1', [
      userMsg('u1', '跑一下测试'),
      createMessageWithParts('a1', '好'),
      userMsg('u2', '跑一下测试，然后部署'),
      createMessageWithParts('a2', '完成'),
    ])
    messageStore.injectSynthMessages('session-1', [
      { message: synthNotif('t1'), anchor: { userText: '跑一下测试', userIndex: 1 } },
    ])
    expect(ids()).toEqual(['u1', 'a1', 'msg_tasknotif_t1', 'u2', 'a2'])
  })

  it('重复文本靠序数消歧：命中第 N 条而非最新一条', () => {
    messageStore.setMessages('session-1', [
      userMsg('u1', '继续'),
      createMessageWithParts('a1', 'r1'),
      userMsg('u2', '继续'),
      createMessageWithParts('a2', 'r2'),
      userMsg('u3', '收尾'),
      createMessageWithParts('a3', 'r3'),
    ])
    messageStore.injectSynthMessages('session-1', [
      { message: synthNotif('t1'), anchor: { userText: '继续', userIndex: 1 } },
    ])
    expect(ids()).toEqual(['u1', 'a1', 'msg_tasknotif_t1', 'u2', 'a2', 'u3', 'a3'])
  })
})
