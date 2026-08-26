import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActivityHeatmap } from './ActivityHeatmap'
import type { DayActivity } from '../../types/api/dashboard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        heatmapTooltip: `${opts?.count} messages on ${opts?.date}`,
        heatmapCaption: 'Assistant messages across all sessions.',
      }
      return map[key] ?? key
    },
  }),
}))

function makeDays(count: number, startOffset = 0): DayActivity[] {
  const start = new Date('2026-06-01T00:00:00Z')
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + startOffset + i)
    return { date: d.toISOString().slice(0, 10), messageCount: i === count - 1 ? 10 : 0 }
  })
}

describe('ActivityHeatmap', () => {
  it('renders the legend caption', () => {
    render(<ActivityHeatmap days={makeDays(371)} />)
    expect(screen.getByText('Assistant messages across all sessions.')).toBeInTheDocument()
  })

  it('renders a month label at the start of the grid', () => {
    render(<ActivityHeatmap days={makeDays(371)} />)
    const expectedMonth = new Date('2026-06-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short' })
    expect(screen.getAllByText(expectedMonth).length).toBeGreaterThan(0)
  })

  it('shows a tooltip on hover with the message count and date, and hides it on mouse leave', () => {
    const days = makeDays(7)
    render(<ActivityHeatmap days={days} />)

    expect(screen.queryByText(/messages on/)).not.toBeInTheDocument()

    const grid = screen.getByRole('img', { name: 'activity heatmap' })
    const lastCell = grid.querySelector(`[data-date="${days[days.length - 1].date}"]`)
    expect(lastCell).not.toBeNull()

    fireEvent.mouseEnter(lastCell!)
    expect(screen.getByText(/10 messages on/)).toBeInTheDocument()

    fireEvent.mouseLeave(lastCell!)
    expect(screen.queryByText(/10 messages on/)).not.toBeInTheDocument()
  })
})
