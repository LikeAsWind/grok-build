import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { HomeDashboard } from './HomeDashboard'
import type { DashboardStats } from '../../types/api/dashboard'

const { getDashboardStatsMock } = vi.hoisted(() => ({
  getDashboardStatsMock: vi.fn(),
}))

vi.mock('../../api', () => ({
  getDashboardStats: (...args: unknown[]) => getDashboardStatsMock(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        greeting: "What's up next?",
        overview: 'Overview',
        models: 'Models',
        all: 'All',
        sessions: 'Sessions',
        messages: 'Messages',
        totalTokens: 'Total tokens',
        activeDays: 'Active days',
        currentStreak: 'Current streak',
        longestStreak: 'Longest streak',
        peakHour: 'Peak hour',
        favoriteModel: 'Favorite model',
        emptyTitle: 'No sessions yet',
        emptyDescription: 'Start your first conversation from the sidebar to see your stats here.',
        tokenComparison: `You've used ~${opts?.multiplier}x more tokens than The Hobbit`,
        in: 'in',
        out: 'out',
        heatmapSummary: `${opts?.count} messages in the last year`,
        heatmapTooltip: `${opts?.count} messages on ${opts?.date}`,
        heatmapCaption: 'Assistant messages across all sessions.',
      }
      return map[key] ?? key
    },
  }),
}))

function makeStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    totalSessions: 5,
    totalMessages: 120,
    totalTokens: 240_000,
    activeDays: 3,
    currentStreakDays: 2,
    longestStreakDays: 4,
    peakHour: 9,
    favoriteModel: 'grok-4',
    heatmap: [{ date: '2026-08-24', messageCount: 12 }],
    modelsByDay: [
      {
        date: '2026-08-24',
        byModel: [
          { modelId: 'grok-4', inputTokens: 1000, outputTokens: 200 },
          { modelId: 'sonnet-5', inputTokens: 500, outputTokens: 100 },
        ],
      },
    ],
    ...overrides,
  }
}

describe('HomeDashboard', () => {
  beforeEach(() => {
    getDashboardStatsMock.mockReset()
  })

  it('renders stat cards with values from the fetched snapshot', async () => {
    getDashboardStatsMock.mockResolvedValue(makeStats())
    render(<HomeDashboard />)

    await waitFor(() => expect(screen.getByText('Sessions')).toBeInTheDocument())
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('Favorite model')).toBeInTheDocument()
    expect(screen.getByText('grok-4')).toBeInTheDocument()
    expect(getDashboardStatsMock).toHaveBeenCalledWith(undefined)
  })

  it('shows the empty-state guidance when there are no sessions yet', async () => {
    getDashboardStatsMock.mockResolvedValue(makeStats({ totalSessions: 0 }))
    render(<HomeDashboard />)

    await waitFor(() => expect(screen.getByText('No sessions yet')).toBeInTheDocument())
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument()
  })

  it('switches to the Models tab and shows per-model usage', async () => {
    getDashboardStatsMock.mockResolvedValue(makeStats())
    render(<HomeDashboard />)

    await waitFor(() => expect(screen.getByText('Sessions')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))

    expect(screen.getByText('sonnet-5')).toBeInTheDocument()
  })

  it('keeps the activity heatmap visible regardless of the active tab', async () => {
    getDashboardStatsMock.mockResolvedValue(makeStats())
    render(<HomeDashboard />)

    await waitFor(() => expect(screen.getByText('Sessions')).toBeInTheDocument())
    expect(screen.getByRole('img', { name: 'activity heatmap' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(screen.getByRole('img', { name: 'activity heatmap' })).toBeInTheDocument()
  })

  it('refetches with the selected time window when a filter button is clicked', async () => {
    getDashboardStatsMock.mockResolvedValue(makeStats())
    render(<HomeDashboard />)

    await waitFor(() => expect(screen.getByText('Sessions')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '30d' }))

    await waitFor(() => expect(getDashboardStatsMock).toHaveBeenLastCalledWith(30))
  })

  it('shows an error message when the request fails', async () => {
    getDashboardStatsMock.mockRejectedValue(new Error('network down'))
    render(<HomeDashboard />)

    await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument())
  })
})

