// PauseDialog: shows reason input, submits to x.ai/workbench/pause with the
// reason, surfaces server errors, and closes on success.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PauseDialog } from './PauseDialog'

const { acpExtRequestMock } = vi.hoisted(() => ({
  acpExtRequestMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
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
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}))

describe('PauseDialog', () => {
  beforeEach(() => {
    acpExtRequestMock.mockReset()
    acpExtRequestMock.mockResolvedValue({ ok: true })
  })

  it('renders reason textarea + Cancel/Pause buttons when open', () => {
    render(<PauseDialog isOpen tapdId="TAPD-1" onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByText('cancel')).toBeInTheDocument()
    expect(screen.getByText('pause')).toBeInTheDocument()
  })

  it('does not render anything when closed', () => {
    render(<PauseDialog isOpen={false} tapdId="TAPD-1" onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('submits tapd_id + trimmed reason; closes on success', async () => {
    const onClose = vi.fn()
    const onPaused = vi.fn()
    render(<PauseDialog isOpen tapdId="TAPD-1" onClose={onClose} onPaused={onPaused} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  user paused for review  ' },
    })
    fireEvent.click(screen.getByText('pause'))
    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/workbench/pause', {
      tapd_id: 'TAPD-1',
      reason: 'user paused for review',
    })
    expect(onPaused).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('submits reason=null when textarea is blank', async () => {
    render(<PauseDialog isOpen tapdId="TAPD-1" onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('pause'))
    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/workbench/pause', {
      tapd_id: 'TAPD-1',
      reason: null,
    })
  })

  it('surfaces server errors and does not close', async () => {
    acpExtRequestMock.mockRejectedValueOnce(new Error('server boom'))
    const onClose = vi.fn()
    render(<PauseDialog isOpen tapdId="TAPD-1" onClose={onClose} />)
    fireEvent.click(screen.getByText('pause'))
    await waitFor(() => expect(screen.getByText('server boom')).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Cancel button closes without calling ext', () => {
    const onClose = vi.fn()
    render(<PauseDialog isOpen tapdId="TAPD-1" onClose={onClose} />)
    fireEvent.click(screen.getByText('cancel'))
    expect(acpExtRequestMock).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

