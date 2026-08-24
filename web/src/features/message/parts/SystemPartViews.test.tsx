import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompactionPart, PatchPart, RetryPart, StepFinishPart } from '../../../types/message'
import { CompactionPartView, PatchPartView, RetryPartView } from './SystemPartViews'
import { StepFinishPartView } from './StepFinishPartView'
import { INFO_LINE_CLASSNAME } from './InfoLine'

describe('SystemPartViews', () => {
  const basePart = {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
  }

  const retryPart: RetryPart = {
    ...basePart,
    type: 'retry',
    attempt: 2,
    error: { data: { message: 'network timeout', isRetryable: true, statusCode: 504 } },
    time: { created: Date.now() },
  } as RetryPart
  const patchPart: PatchPart = {
    ...basePart,
    type: 'patch',
    hash: 'abcdef123456',
    files: ['src/app.tsx', 'src/store/messageStore.ts'],
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

  it('toggles retry details with a semantic button', () => {
    render(<RetryPartView part={retryPart} />)

    const toggle = screen.getByRole('button', { name: /Retry attempt 2/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    act(() => {
      vi.advanceTimersByTime(16)
    })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('network timeout')).toBeInTheDocument()
  })

  it('toggles patch details with a semantic button', () => {
    render(<PatchPartView part={patchPart} />)

    const toggle = screen.getByRole('button', { name: /2 files changed/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    act(() => {
      vi.advanceTimersByTime(16)
    })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('src/app.tsx')).toBeInTheDocument()
  })

  describe('CompactionPartView', () => {
    const compactionBase = { ...basePart, type: 'compaction' as const }

    it('running 态显示百分比 + spinner，不显示 token 数', () => {
      const part: CompactionPart = { ...compactionBase, status: 'running', percentage: 92 }
      render(<CompactionPartView part={part} />)
      expect(screen.getByText(/92/)).toBeInTheDocument()
    })

    it('completed 态带 before/after/duration 时显示节省百分比和耗时', () => {
      const part: CompactionPart = {
        ...compactionBase,
        status: 'completed',
        tokensBefore: 164200,
        tokensAfter: 42100,
        elapsedMs: 3200,
      }
      render(<CompactionPartView part={part} />)
      // (164200 - 42100) / 164200 ≈ 74%
      expect(screen.getByText(/74%/)).toBeInTheDocument()
      expect(screen.getByText(/3\.2s/)).toBeInTheDocument()
    })

    it('token 对比用共享的 formatNumber 缩写格式，跟 Step 完成信息用同一套格式化函数', () => {
      const part: CompactionPart = {
        ...compactionBase,
        status: 'completed',
        tokensBefore: 164200,
        tokensAfter: 42100,
        elapsedMs: 3200,
      }
      render(<CompactionPartView part={part} />)
      // formatNumber(164200) === '164.2k'，formatNumber(42100) === '42.1k'——
      // 不是原始整数 164200/42100，也不是拼进一整句翻译模板里的字符串。
      expect(screen.getByText(/164\.2k.*42\.1k/)).toBeInTheDocument()
    })

    it('completed 态缺少 tokensBefore 时回退到只显示 after（不显示 NaN%）', () => {
      const part: CompactionPart = { ...compactionBase, status: 'completed', tokensAfter: 5000 }
      render(<CompactionPartView part={part} />)
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
      expect(screen.getByText(/5(\.0)?k|5000/)).toBeInTheDocument()
    })

    it('failed 态显示压缩失败提示', () => {
      const part: CompactionPart = { ...compactionBase, status: 'failed' }
      render(<CompactionPartView part={part} />)
      expect(screen.getByText('Compaction failed')).toBeInTheDocument()
    })

    it('cancelled 态显示压缩已取消提示', () => {
      const part: CompactionPart = { ...compactionBase, status: 'cancelled' }
      render(<CompactionPartView part={part} />)
      expect(screen.getByText('Compaction cancelled')).toBeInTheDocument()
    })

    it('completed 态的用量行和 StepFinishPartView 渲染出同一个共享 InfoLine 容器（真正复用组件，不是各自重写）', () => {
      const compactionPart: CompactionPart = {
        ...compactionBase,
        status: 'completed',
        tokensBefore: 164200,
        tokensAfter: 42100,
        elapsedMs: 3200,
      }
      const { container: compactionContainer } = render(<CompactionPartView part={compactionPart} />)
      const compactionInfoLine = compactionContainer.querySelector('[data-testid="info-line"]')
      expect(compactionInfoLine).not.toBeNull()
      expect(compactionInfoLine!.className).toContain(INFO_LINE_CLASSNAME)

      const stepFinishPart: StepFinishPart = {
        ...basePart,
        type: 'step-finish',
        reason: 'end_turn',
        cost: 0,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const { container: stepContainer } = render(<StepFinishPartView part={stepFinishPart} />)
      const stepInfoLine = stepContainer.querySelector('[data-testid="info-line"]')
      expect(stepInfoLine).not.toBeNull()
      // 两处的信息行使用完全相同的基础 class 字符串——同一个 InfoLine 组件渲染的结果。
      expect(stepInfoLine!.className.replace(' justify-center', '')).toBe(compactionInfoLine!.className.replace(' justify-center', ''))
    })
  })
})
