import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homeViewStore } from './homeViewStore'

describe('homeViewStore', () => {
  beforeEach(() => {
    homeViewStore.setView('dashboard')
  })

  it('默认是仪表盘', () => {
    expect(homeViewStore.getSnapshot()).toBe('dashboard')
  })

  it('切到工作台后通知订阅者', () => {
    const listener = vi.fn()
    const unsubscribe = homeViewStore.subscribe(listener)

    homeViewStore.setView('workbench')
    expect(homeViewStore.getSnapshot()).toBe('workbench')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('重复设置同一个视图不重复通知（useSyncExternalStore 不必空转重渲染）', () => {
    const listener = vi.fn()
    const unsubscribe = homeViewStore.subscribe(listener)

    homeViewStore.setView('workbench')
    homeViewStore.setView('workbench')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('退订后不再收到通知', () => {
    const listener = vi.fn()
    homeViewStore.subscribe(listener)()

    homeViewStore.setView('workbench')
    expect(listener).not.toHaveBeenCalled()
  })
})
