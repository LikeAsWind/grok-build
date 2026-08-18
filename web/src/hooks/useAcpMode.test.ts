import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAcpMode } from './useAcpMode'

const modes = new Map<string, string>()

vi.mock('../api/acpBridge', () => ({
  getCurrentMode: (sessionId: string) => modes.get(sessionId) ?? '',
}))

afterEach(() => modes.clear())

function emitModeChanged(sessionId: string, modeId: string) {
  window.dispatchEvent(new CustomEvent('acp:modeChanged', { detail: { sessionId, modeId } }))
}

describe('useAcpMode', () => {
  it('无 sessionId 时为 default', () => {
    const { result } = renderHook(() => useAcpMode(undefined))
    expect(result.current[0]).toBe('default')
  })

  it('加载会话时读取该会话已有模式', () => {
    modes.set('s1', 'plan')
    const { result } = renderHook(() => useAcpMode('s1'))
    expect(result.current[0]).toBe('plan')
  })

  it('后端 acp:modeChanged 驱动按钮切换', () => {
    const { result } = renderHook(() => useAcpMode('s1'))
    expect(result.current[0]).toBe('default')
    act(() => emitModeChanged('s1', 'plan'))
    expect(result.current[0]).toBe('plan')
    act(() => emitModeChanged('s1', 'default'))
    expect(result.current[0]).toBe('default')
  })

  it('忽略其他会话的模式变更', () => {
    const { result } = renderHook(() => useAcpMode('s1'))
    act(() => emitModeChanged('s2', 'plan'))
    expect(result.current[0]).toBe('default')
  })

  it('切换 sessionId 时重新读取模式', () => {
    modes.set('s2', 'plan')
    const { result, rerender } = renderHook(({ sid }) => useAcpMode(sid), {
      initialProps: { sid: 's1' },
    })
    expect(result.current[0]).toBe('default')
    rerender({ sid: 's2' })
    expect(result.current[0]).toBe('plan')
  })

  it('本地 setMode 仍可用（用户点按钮切换）', () => {
    const { result } = renderHook(() => useAcpMode('s1'))
    act(() => result.current[1]('plan'))
    expect(result.current[0]).toBe('plan')
  })
})
