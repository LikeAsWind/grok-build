// ReplayDialog: stage picker (6 stages) + optional reason + optional
// pre_approved toggle (only when allowPreApprove && stage === adjudicate).

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplayDialog } from './ReplayDialog'

const { acpExtRequestMock } = vi.hoisted(() => ({
  acpExtRequestMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  // Return the i18n key verbatim so we can assert on it.
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../api/acpBridge', () => ({
  acpExtRequest: (...args: unknown[]) => acpExtRequestMock(...args),
}))

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}))

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>,
  ),
}))

describe('ReplayDialog', () => {
  beforeEach(() => {
    acpExtRequestMock.mockReset()
    acpExtRequestMock.mockResolvedValue({ ok: true })
  })

  it('renders all 6 stages in the picker when open', () => {
    render(<ReplayDialog isOpen tapdId="TAPD-1" onClose={vi.fn()} />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toEqual([
      'brainstorm', 'adjudicate', 'develop', 'code_review', 'verify', 'mr_submit',
    ])
  })

  it('uses defaultStage when provided', () => {
    render(<ReplayDialog isOpen tapdId="TAPD-1" defaultStage="verify" onClose={vi.fn()} />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('verify')
  })

  it('submits tapd_id + replay_from + reason on Replay click', async () => {
    const onReplayed = vi.fn()
    render(<ReplayDialog isOpen tapdId="TAPD-1" onClose={vi.fn()} onReplayed={onReplayed} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'develop' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 're-do coder' } })
    fireEvent.click(screen.getByText('replay'))
    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/workbench/replay', {
      tapd_id: 'TAPD-1',
      replay_from: 'develop',
      reason: 're-do coder',
    })
    expect(onReplayed).toHaveBeenCalledWith('develop')
  })

  it('hides pre_approve checkbox unless allowPreApprove + stage=adjudicate', () => {
    const { rerender } = render(<ReplayDialog isOpen tapdId="TAPD-1" onClose={vi.fn()} />)
    // Default: allowPreApprove=false -> no checkbox
    expect(screen.queryByText('replayDialogPreApprove')).toBeNull()

    // allowPreApprove=true but stage=develop -> still no checkbox
    rerender(<ReplayDialog isOpen tapdId="TAPD-1" allowPreApprove onClose={vi.fn()} />)
    expect(screen.queryByText('replayDialogPreApprove')).toBeNull()

    // allowPreApprove=true AND stage=adjudicate -> checkbox appears
    rerender(<ReplayDialog isOpen tapdId="TAPD-1" allowPreApprove defaultStage="adjudicate" onClose={vi.fn()} />)
    expect(screen.getByText('replayDialogPreApprove')).toBeInTheDocument()
  })

  it('includes pre_approved=true when checkbox is checked', async () => {
    render(<ReplayDialog isOpen tapdId="TAPD-1" allowPreApprove defaultStage="adjudicate" onClose={vi.fn()} />)
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByText('replay'))
    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))
    const call = acpExtRequestMock.mock.calls[0][1] as Record<string, unknown>
    expect(call).toMatchObject({
      tapd_id: 'TAPD-1',
      replay_from: 'adjudicate',
      pre_approved: true,
    })
  })

  it('omits pre_approved when checkbox is unchecked', async () => {
    render(<ReplayDialog isOpen tapdId="TAPD-1" allowPreApprove defaultStage="adjudicate" onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('replay'))
    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))
    const call = acpExtRequestMock.mock.calls[0][1] as Record<string, unknown>
    expect('pre_approved' in call).toBe(false)
  })
})

