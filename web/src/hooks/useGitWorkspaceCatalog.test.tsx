import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitWorkspaceCatalog } from './useGitWorkspaceCatalog'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const { getCurrentProjectMock, acpExtRequestMock, subscribeToEventsMock, onServerChangeMock } = vi.hoisted(() => ({
  getCurrentProjectMock: vi.fn(),
  acpExtRequestMock: vi.fn(),
  subscribeToEventsMock: vi.fn(),
  onServerChangeMock: vi.fn(),
}))
let latestServerChange: (() => void) | undefined

vi.mock('../api', () => ({
  getCurrentProject: (...args: unknown[]) => getCurrentProjectMock(...args),
}))

vi.mock('../api/acpBridge', () => ({
  acpExtRequest: (...args: unknown[]) => acpExtRequestMock(...args),
}))

vi.mock('../api/events', () => ({
  subscribeToEvents: (...args: unknown[]) => subscribeToEventsMock(...args),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    onServerChange: (...args: unknown[]) => onServerChangeMock(...args),
  },
}))

describe('useGitWorkspaceCatalog', () => {
  beforeEach(() => {
    getCurrentProjectMock.mockReset()
    acpExtRequestMock.mockReset()
    subscribeToEventsMock.mockReset()
    onServerChangeMock.mockReset()
    latestServerChange = undefined

    subscribeToEventsMock.mockReturnValue(vi.fn())
    onServerChangeMock.mockImplementation(listener => {
      latestServerChange = listener as () => void
      return vi.fn()
    })
    acpExtRequestMock.mockResolvedValue(['C:/repo', 'C:/repo-worktree'])
  })

  it('refetches workspace metadata on server endpoint changes while stale requests are in flight', async () => {
    const staleRequest = createDeferred<{ vcs: string; worktree: string }>()
    const freshRequest = createDeferred<{ vcs: string; worktree: string }>()

    getCurrentProjectMock.mockImplementationOnce(() => staleRequest.promise).mockImplementationOnce(() => freshRequest.promise)

    const directories = ['C:\\repo']
    const { result } = renderHook(() => useGitWorkspaceCatalog(directories))

    await waitFor(() => expect(getCurrentProjectMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      latestServerChange?.()
      await Promise.resolve()
    })

    expect(getCurrentProjectMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve({ vcs: 'git', worktree: 'C:/repo' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
    })

    await act(async () => {
      staleRequest.resolve({ vcs: 'git', worktree: 'C:/stale' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.catalog.get('C:/repo')?.rootDirectory).toBe('C:/repo')
    expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
  })
})
