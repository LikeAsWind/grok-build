import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, AgentCompletionPart } from '../../../types/message'
import { AgentCompletionPartView } from './AgentCompletionPartView'
import { TaskNotificationMessageView } from '../TaskNotificationMessageView'

const basePart: AgentCompletionPart = {
  id: 'msg_tasknotif_sag1:task',
  sessionID: 'session-1',
  messageID: 'msg_tasknotif_sag1',
  type: 'agent-completion',
  taskId: 'subagent:sag1',
  command: 'sag1',
  description: '查找代码引用',
  agentType: 'Explore',
  ok: true,
  output: '# 结果标题\n\n找到了 **42** 个引用。加粗文本应被渲染。',
  turns: 3,
  toolCalls: 7,
  durationMs: 1234,
  receivedAt: Date.now(),
}

describe('AgentCompletionPartView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => window.setTimeout(() => cb(performance.now()), 16))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function expand() {
    const toggle = screen.getByRole('button', { name: /Sub-agent completed/i })
    fireEvent.click(toggle)
    act(() => {
      vi.advanceTimersByTime(16)
    })
    return toggle
  }

  it('渲染完成态：标题 + 描述 + agentType 徽标', () => {
    render(<AgentCompletionPartView part={basePart} />)
    const toggle = screen.getByRole('button', { name: /Sub-agent completed/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.textContent).toContain('查找代码引用')
    expect(toggle.textContent).toContain('Explore')
  })

  it('markdown output 渲染为富文本而非 <pre>，展开体含统计行', () => {
    const { container } = render(<AgentCompletionPartView part={basePart} />)
    expand()
    // markdown：标题元素、加粗文本、无 <pre>
    expect(screen.getByRole('heading', { level: 1, name: '结果标题' })).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
    // 统计行：3 turns · 7 tools
    expect(screen.getByText(/3 turns.*7 tool calls/)).toBeInTheDocument()
    // duration footer：卡片下方 "1.2s total"（与消息 footer 同风格）
    expect(screen.getByText(/1\.2s total/)).toBeInTheDocument()
  })

  it('failed 态显示失败标题', () => {
    const failed: AgentCompletionPart = { ...basePart, ok: false, output: '运行超时' }
    render(<AgentCompletionPartView part={failed} />)
    expect(screen.getByRole('button', { name: /Sub-agent failed/i })).toBeInTheDocument()
  })

  it('无 output 时显示占位文案', () => {
    const empty: AgentCompletionPart = { ...basePart, output: undefined }
    render(<AgentCompletionPartView part={empty} />)
    expand()
    expect(screen.getByText('No output')).toBeInTheDocument()
  })
})

describe('TaskNotificationMessageView (agent-completion)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => window.setTimeout(() => cb(performance.now()), 16))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const message: Message = {
    info: {
      id: 'msg_tasknotif_sag1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 0, completed: 0 },
      parentID: '',
      modelID: 'grok',
      providerID: 'xai',
      mode: '',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [basePart],
  } as Message

  it('渲染 agent 卡而不渲染 bash 卡', () => {
    render(<TaskNotificationMessageView message={message} />)
    expect(screen.getByRole('button', { name: /Sub-agent completed/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Background task completed/i })).toBeNull()
  })
})
