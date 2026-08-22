import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResidentSessionDiffStats } from './useResidentSessionDiffStats'
import type { ApiSession } from '../../api'

const acpExtRequestMock = vi.fn()

vi.mock('../../api/acpBridge', () => ({
  acpExtRequest: (...args: unknown[]) => acpExtRequestMock(...args),
}))

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    directory: 'C:\\repo',
    title: '会话',
    version: '',
    time: { created: 1000, updated: 2000 },
    ...overrides,
  } as ApiSession
}

describe('useResidentSessionDiffStats', () => {
  beforeEach(() => {
    acpExtRequestMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('活跃会话查询成功返回 isLive: true，且 ext 请求字段名是 sessionId（camelCase）', async () => {
    acpExtRequestMock.mockResolvedValue({
      stats: { acceptedLinesAdded: 20, acceptedLinesRemoved: 10 },
      pendingLinesAdded: 5,
      pendingLinesRemoved: 3,
      filesModified: 3,
    })

    const sessions = [makeSession({ id: 's1', additions: 10, deletions: 5, files: 2 })]
    const { result } = renderHook(() => useResidentSessionDiffStats(['s1'], sessions))

    await waitFor(() => expect(result.current.get('s1')).toBeDefined())

    // 关键回归：字段名必须是 sessionId，不是 session_id——否则后端会静默
    // 忽略该字段（GetSummaryRequest 带 rename_all = "camelCase"），查询恒失败。
    expect(acpExtRequestMock).toHaveBeenCalledWith('x.ai/hunk-tracker/get-summary', { sessionId: 's1' })
    expect(result.current.get('s1')).toEqual({
      additions: 25, // 20 + 5
      deletions: 13, // 10 + 3
      files: 3,
      isLive: true,
    })
  })

  it('查询失败回退到落盘快照并标记 isLive: false', async () => {
    acpExtRequestMock.mockRejectedValue(new Error('查询失败'))

    const sessions = [makeSession({ id: 's1', additions: 10, deletions: 5, files: 2 })]
    const { result } = renderHook(() => useResidentSessionDiffStats(['s1'], sessions))

    await waitFor(() => expect(result.current.get('s1')).toBeDefined())

    expect(result.current.get('s1')).toEqual({
      additions: 10,
      deletions: 5,
      files: 2,
      isLive: false,
    })
  })

  it('查询失败且无落盘快照时，Map 不包含该 session（返回 undefined，不是 null）', async () => {
    acpExtRequestMock.mockRejectedValue(new Error('查询失败'))

    const sessions = [makeSession({ id: 's1', additions: undefined, deletions: undefined, files: undefined })]
    const { result } = renderHook(() => useResidentSessionDiffStats(['s1'], sessions))

    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))
    // 没有触发 setStatsMap 到非空状态的路径，用短暂等待确认 Map 一直保持不包含 s1
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(result.current.has('s1')).toBe(false)
    expect(result.current.get('s1')).toBeUndefined()
  })

  it('residentIds/sessions 引用变化但内容相同时不重复查询', async () => {
    acpExtRequestMock.mockResolvedValue({
      stats: { acceptedLinesAdded: 10, acceptedLinesRemoved: 0 },
      pendingLinesAdded: 0,
      pendingLinesRemoved: 0,
      filesModified: 1,
    })

    const sessions1 = [makeSession({ id: 's1', additions: 10 })]
    const sessions2 = [makeSession({ id: 's1', additions: 10 })] // 内容相同，引用不同
    const residentIds1 = ['s1']
    const residentIds2 = ['s1'] // 内容相同，引用不同

    const { rerender } = renderHook(
      ({ residentIds, sessions }: { residentIds: string[]; sessions: ApiSession[] }) =>
        useResidentSessionDiffStats(residentIds, sessions),
      { initialProps: { residentIds: residentIds1, sessions: sessions1 } },
    )

    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))

    rerender({ residentIds: residentIds2, sessions: sessions2 })

    // 给 effect 一个 tick 的机会重跑（如果它真的会重跑的话），
    // 然后断言调用次数没有增加。
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acpExtRequestMock).toHaveBeenCalledTimes(1)
  })

  it('residentIds 内容相同但顺序不同时不重复查询', async () => {
    acpExtRequestMock.mockResolvedValue({
      stats: { acceptedLinesAdded: 1, acceptedLinesRemoved: 0 },
      pendingLinesAdded: 0,
      pendingLinesRemoved: 0,
      filesModified: 1,
    })

    const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2' })]

    const { rerender } = renderHook(
      ({ residentIds }: { residentIds: string[] }) => useResidentSessionDiffStats(residentIds, sessions),
      { initialProps: { residentIds: ['s1', 's2'] } },
    )

    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(2))

    // 同一批 id，顺序反过来——排序后的 key 应该相同，不触发重新查询
    rerender({ residentIds: ['s2', 's1'] })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acpExtRequestMock).toHaveBeenCalledTimes(2)
  })

  it('residentIds 内容真的变化时会重新查询', async () => {
    acpExtRequestMock.mockResolvedValue({
      stats: { acceptedLinesAdded: 1, acceptedLinesRemoved: 0 },
      pendingLinesAdded: 0,
      pendingLinesRemoved: 0,
      filesModified: 1,
    })

    const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2' })]

    const { rerender } = renderHook(
      ({ residentIds }: { residentIds: string[] }) => useResidentSessionDiffStats(residentIds, sessions),
      { initialProps: { residentIds: ['s1'] } },
    )

    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(1))

    rerender({ residentIds: ['s1', 's2'] })

    await waitFor(() => expect(acpExtRequestMock).toHaveBeenCalledTimes(3)) // 1 + 2 次新查询
  })

  it('部分查询失败不影响其它会话（P0 关键测试）', async () => {
    const sessions = [
      makeSession({ id: 's1', additions: 10, deletions: 5, files: 2 }),
      makeSession({ id: 's2', additions: 20, deletions: 10, files: 3 }),
      makeSession({ id: 's3', additions: 30, deletions: 15, files: 4 }),
    ]

    acpExtRequestMock
      .mockResolvedValueOnce({
        stats: { acceptedLinesAdded: 12, acceptedLinesRemoved: 6 },
        pendingLinesAdded: 0,
        pendingLinesRemoved: 0,
        filesModified: 2,
      })
      .mockRejectedValueOnce(new Error('s2 查询失败'))
      .mockResolvedValueOnce({
        stats: { acceptedLinesAdded: 35, acceptedLinesRemoved: 18 },
        pendingLinesAdded: 0,
        pendingLinesRemoved: 0,
        filesModified: 5,
      })

    const { result } = renderHook(() => useResidentSessionDiffStats(['s1', 's2', 's3'], sessions))

    await waitFor(() => {
      expect(result.current.get('s1')).toBeDefined()
      expect(result.current.get('s2')).toBeDefined()
      expect(result.current.get('s3')).toBeDefined()
    })

    expect(result.current.get('s1')).toEqual({
      additions: 12,
      deletions: 6,
      files: 2,
      isLive: true,
    })

    // s2 查询失败，回退到落盘快照
    expect(result.current.get('s2')).toEqual({
      additions: 20,
      deletions: 10,
      files: 3,
      isLive: false,
    })

    expect(result.current.get('s3')).toEqual({
      additions: 35,
      deletions: 18,
      files: 5,
      isLive: true,
    })
  })

  it('residentIds 为空时不发起任何请求', () => {
    const sessions = [makeSession({ id: 's1' })]
    const { result } = renderHook(() => useResidentSessionDiffStats([], sessions))

    expect(acpExtRequestMock).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })
})
