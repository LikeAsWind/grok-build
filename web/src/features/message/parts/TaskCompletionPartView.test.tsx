import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, TaskCompletionPart } from '../../../types/message'
import { TaskCompletionPartView } from './TaskCompletionPartView'
import { TaskNotificationMessageView } from '../TaskNotificationMessageView'

describe('TaskCompletionPartView', () => {
  const part: TaskCompletionPart = {
    id: 'msg_tasknotif_t1:task',
    sessionID: 'session-1',
    messageID: 'msg_tasknotif_t1',
    type: 'task-completion',
    taskId: 't1',
    command: 'sleep 10; echo background-task-done',
    cwd: '/workspace',
    exitCode: 0,
    ok: true,
    output: 'background-task-done',
    endTime: new Date('2026-08-13T10:30:00').getTime(),
    receivedAt: Date.now(),
  }

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

  it('toggles output with a semantic button and shows completion time', () => {
    render(<TaskCompletionPartView part={part} />)

    const toggle = screen.getByRole('button', { name: /Background task completed/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // header 显示完成时间与退出徽标
    expect(toggle.textContent).toContain('exit 0')
    expect(toggle.textContent).toContain('10:30')

    fireEvent.click(toggle)
    act(() => {
      vi.advanceTimersByTime(16)
    })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('background-task-done')).toBeInTheDocument()
    expect(screen.getByText('/workspace')).toBeInTheDocument()
  })

  it('renders failed state with signal badge and truncated hint', () => {
    const failed: TaskCompletionPart = {
      ...part,
      id: 'msg_tasknotif_t2:task',
      messageID: 'msg_tasknotif_t2',
      taskId: 't2',
      ok: false,
      exitCode: undefined,
      signal: 'SIGKILL',
      truncated: true,
      outputFile: '/tmp/t2.log',
    }
    render(<TaskCompletionPartView part={failed} />)

    const toggle = screen.getByRole('button', { name: /Background task failed/i })
    expect(toggle.textContent).toContain('signal SIGKILL')

    fireEvent.click(toggle)
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(screen.getByText(/\/tmp\/t2\.log/)).toBeInTheDocument()
  })
})

describe('TaskNotificationMessageView', () => {
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
      id: 'msg_tasknotif_t1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: Date.now(), completed: Date.now() },
      parentID: '',
      modelID: 'grok',
      providerID: 'xai',
      mode: '',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: 'msg_tasknotif_t1:task',
        sessionID: 'session-1',
        messageID: 'msg_tasknotif_t1',
        type: 'task-completion',
        taskId: 't1',
        command: 'echo hi',
        exitCode: 0,
        ok: true,
        output: 'hi',
        endTime: Date.now(),
        receivedAt: Date.now(),
      } as TaskCompletionPart,
    ],
  } as Message

  it('renders fork action and triggers callback', async () => {
    const onFork = vi.fn()
    render(<TaskNotificationMessageView message={message} onFork={onFork} />)

    const forkButton = screen.getByRole('button', { name: /fork/i })
    fireEvent.click(forkButton)
    await act(async () => {
      vi.advanceTimersByTime(16)
    })
    expect(onFork).toHaveBeenCalledWith(message, undefined)
  })

  it('renders nothing but placeholder when part missing', () => {
    const empty = { ...message, parts: [] }
    const { container } = render(<TaskNotificationMessageView message={empty} />)
    expect(container.firstChild).toHaveClass('min-h-[24px]')
  })
})
