// ============================================
// WS 断开 → 在途 RPC 收尾 & 自动重连 测试
// 复现 Bug：ws.onclose 不 reject pending RPC，
// 在途 session/prompt 永不 settle → pendingPrompts 死锁，
// 会话永远卡「回复中」，后续消息全部排队夯死。
// ============================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Fake WebSocket（带极简 ACP server 应答）─────────────────────────

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  /** 捕获的出站帧（已 parse；"ping" 文本除外） */
  sentFrames: Record<string, unknown>[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState === FakeWebSocket.CONNECTING) {
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.()
      }
    })
  }

  send(data: string) {
    if (data === 'ping') return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    this.sentFrames.push(msg)
    // 极简 server：应答握手类请求；session/prompt 挂起不应答
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      if (msg.method === 'initialize') {
        this.reply(msg.id, { protocolVersion: 1, authMethods: [], _meta: {} })
      } else if (msg.method === 'authenticate' || msg.method === 'session/set_mode') {
        this.reply(msg.id, {})
      }
      // session/prompt：故意不应答，模拟在途
    }
  }

  reply(id: number, result: unknown) {
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) })
    })
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({})
  }

  /** 模拟服务端/网络异常断开 */
  serverDrop() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({})
  }
}

function flush(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>(r => setTimeout(r, 0)))
  return p
}

type Bridge = typeof import('./acpBridge')
type Store = typeof import('../store/messageStore')

const SID = 'reconnect-session-1'

describe('WS 断开时的在途 RPC 收尾', () => {
  let bridge: Bridge
  let messageStore: Store['messageStore']
  let idleEvents: string[]
  let unsubscribe: (() => void) | null = null

  beforeEach(async () => {
    vi.resetModules()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ wsPath: '/ws', version: 'test', cwd: 'C:\\test' }),
    })))
    sessionStorage.setItem('grok-secret', 'test-key')

    bridge = await import('./acpBridge')
    const storeMod = await import('../store/messageStore')
    messageStore = storeMod.messageStore
    messageStore.clearAll()

    idleEvents = []
    const { subscribeToEvents } = await import('./events')
    unsubscribe = subscribeToEvents({
      onSessionIdle: data => {
        idleEvents.push(data.sessionID)
        messageStore.handleSessionIdle(data.sessionID)
      },
    })
  })

  afterEach(() => {
    unsubscribe?.()
    bridge.disconnectAcpBridge()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('意外断开 → 在途 prompt reject，回合收尾、错误可重试', async () => {
    await bridge.ensureAcp()
    const ws = FakeWebSocket.instances[0]

    await bridge.acpPrompt({ sessionId: SID, text: 'hello' })
    await flush()
    expect(ws.sentFrames.some(f => f.method === 'session/prompt')).toBe(true)
    expect(messageStore.getIsStreaming(SID)).toBe(true)

    ws.serverDrop()
    await flush()

    // 在途 prompt 必须 settle：idle 广播 + streaming 复位 + 可重试错误
    expect(idleEvents).toContain(SID)
    expect(messageStore.getIsStreaming(SID)).toBe(false)
    const loadError = messageStore.getSessionState(SID)?.loadError
    expect(loadError).toBeTruthy()
    expect((loadError?.data as { isRetryable?: boolean } | undefined)?.isRetryable).toBe(true)
  })

  it('意外断开后再次发消息不被死 promise 卡住', async () => {
    await bridge.ensureAcp()
    const ws = FakeWebSocket.instances[0]

    await bridge.acpPrompt({ sessionId: SID, text: 'first' })
    await flush()
    ws.serverDrop()
    await flush()

    // 第二次 prompt：不得 await 一个永不 settle 的 prior
    await bridge.acpPrompt({ sessionId: SID, text: 'second' })
    await flush()

    const lastWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    const prompts = lastWs.sentFrames.filter(f => f.method === 'session/prompt')
    expect(prompts.length).toBe(1)
    expect(JSON.stringify(prompts[0].params)).toContain('second')
  })

  it('意外断开后自动重连并广播 acp:reconnected', async () => {
    await bridge.ensureAcp()
    const reconnected = vi.fn()
    window.addEventListener('acp:reconnected', reconnected)
    vi.useFakeTimers()
    try {
      FakeWebSocket.instances[0].serverDrop()
      expect(bridge.getAcpStatus()).toBe('disconnected')

      // 首次退避 1s；微任务（fetch stub / onopen / initialize）由 async 推进器 flush
      await vi.advanceTimersByTimeAsync(1_100)
      await vi.advanceTimersByTimeAsync(0)

      expect(FakeWebSocket.instances.length).toBe(2)
      expect(bridge.getAcpStatus()).toBe('connected')
      expect(reconnected).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      window.removeEventListener('acp:reconnected', reconnected)
    }
  })

  it('主动断开（disconnectAcpBridge）不触发自动重连', async () => {
    await bridge.ensureAcp()
    vi.useFakeTimers()
    try {
      bridge.disconnectAcpBridge()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(FakeWebSocket.instances.length).toBe(1)
      expect(bridge.getAcpStatus()).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })
})
