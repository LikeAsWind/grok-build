import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlanApprovalModal from './PlanApprovalModal'
import { setPlanApprovalRequest } from '../../store/planApprovalStore'
import type { PlanApprovalRequest } from '../../store/planApprovalStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../components', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

function openModal(): { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn()
  const request: PlanApprovalRequest = { planContent: '# Plan', respond }
  act(() => setPlanApprovalRequest(request))
  return { respond }
}

afterEach(() => {
  act(() => setPlanApprovalRequest(null))
  cleanup()
})

describe('PlanApprovalModal 键盘行为', () => {
  it('焦点在弹窗外时按 Enter 不应批准', () => {
    render(
      <div>
        <input data-testid="outside" />
        <PlanApprovalModal />
      </div>,
    )
    const { respond } = openModal()
    const outside = screen.getByTestId('outside')
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(respond).not.toHaveBeenCalled()
  })

  it('弹窗打开时批准按钮自动聚焦(Enter 走原生按钮激活)', () => {
    render(<PlanApprovalModal />)
    const { respond } = openModal()
    const approve = screen.getByRole('button', { name: /planApproval\.approve/ })
    expect(document.activeElement).toBe(approve)
    expect(respond).not.toHaveBeenCalled()
  })

  it('点击批准按钮发送 approved', () => {
    render(<PlanApprovalModal />)
    const { respond } = openModal()
    fireEvent.click(screen.getByRole('button', { name: /planApproval\.approve/ }))
    expect(respond).toHaveBeenCalledWith({ outcome: 'approved' })
  })

  it('反馈模式下 Escape 收起反馈框而不发送响应', () => {
    render(<PlanApprovalModal />)
    const { respond } = openModal()
    fireEvent.click(screen.getByRole('button', { name: /planApproval\.requestChanges/ }))
    const textarea = screen.getByPlaceholderText('planApproval.feedbackPlaceholder')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('planApproval.feedbackPlaceholder')).toBeNull()
    expect(respond).not.toHaveBeenCalled()
  })
})
