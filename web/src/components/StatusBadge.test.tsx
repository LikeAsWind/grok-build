import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusBadge } from './StatusBadge'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'contextDetails.statusLoading': 'Loading…',
        'contextDetails.statusDone': 'Done',
        'contextDetails.statusFailed': 'Failed',
      }
      return map[key] ?? key
    },
  }),
}))

describe('StatusBadge', () => {
  it('renders loading state with label and loading copy', () => {
    render(<StatusBadge status="loading" label="MCP startup" />)
    expect(screen.getByText('MCP startup')).toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders done state with formatted duration', () => {
    render(<StatusBadge status="done" label="Skill discovery" durationMs={142} />)
    expect(screen.getByText('Skill discovery')).toBeInTheDocument()
    expect(screen.getByText('142ms')).toBeInTheDocument()
  })

  it('renders done state with dash when durationMs is undefined', () => {
    render(<StatusBadge status="done" label="X" />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders failed state with failed copy and ignores durationMs', () => {
    render(<StatusBadge status="failed" label="X" durationMs={200} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('200ms')).not.toBeInTheDocument()
  })

  it('formats sub-second durations as ms and ≥1s as s', () => {
    const { rerender } = render(<StatusBadge status="done" label="A" durationMs={42} />)
    expect(screen.getByText('42ms')).toBeInTheDocument()
    rerender(<StatusBadge status="done" label="A" durationMs={2500} />)
    expect(screen.getByText('2.5s')).toBeInTheDocument()
  })
})
