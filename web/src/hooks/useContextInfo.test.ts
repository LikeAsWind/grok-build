import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useContextInfo } from './useContextInfo'

const { acpExtRequestMock } = vi.hoisted(() => ({
  acpExtRequestMock: vi.fn(),
}))

vi.mock('../api/acpBridge', () => ({
  acpExtRequest: (...args: unknown[]) => acpExtRequestMock(...args),
}))

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    used: 100,
    total: 200000,
    systemPromptTokens: 10,
    toolDefinitionsCount: 1,
    toolDefinitionsTokens: 5,
    compactionCount: 0,
    turnCount: 0,
    toolCallCount: 0,
    messageCount: 0,
    messageTokens: 0,
    freeTokens: 199990,
    usagePct: 0,
    autoCompactThresholdPercent: 85,
    usageCategories: [],
    ...overrides,
  }
}

describe('useContextInfo', () => {
  beforeEach(() => {
    acpExtRequestMock.mockReset()
    // `shouldAdvanceTime` lets `waitFor`'s internal polling (which uses real
    // timers under the hood) keep progressing while we still control
    // `setTimeout` for the hook's own startup-phase poll via `advanceTimersByTime`.
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps polling while a startup phase is still pending, with no session.idle event', async () => {
    acpExtRequestMock
      .mockResolvedValueOnce({ context: baseContext() }) // all fields undefined -> pending
      .mockResolvedValueOnce({
        context: baseContext({
          skillDiscoveryElapsedMs: 12,
          systemPromptBuildElapsedMs: 8,
          toolRegistryPrepElapsedMs: 3,
          mcpStartupElapsedMs: 20,
        }),
      })

    const { result } = renderHook(() => useContextInfo('sess-1'))

    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))
    expect(result.current.info?.mcpStartupElapsedMs).toBeUndefined()

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.info?.mcpStartupElapsedMs).toBe(20))
  })

  it('stops polling once all startup phases have completed', async () => {
    acpExtRequestMock.mockResolvedValue({
      context: baseContext({
        skillDiscoveryElapsedMs: 12,
        systemPromptBuildElapsedMs: 8,
        toolRegistryPrepElapsedMs: 3,
        mcpStartupElapsedMs: 20,
      }),
    })

    renderHook(() => useContextInfo('sess-1'))

    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(acpExtRequestMock).toHaveBeenCalledTimes(1)
  })
})
