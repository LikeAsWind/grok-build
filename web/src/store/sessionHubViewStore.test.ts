import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionHubViewStore } from './sessionHubViewStore'

describe('sessionHubViewStore', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionHubViewStore.setViewMode('list')
  })

  it('默认视图模式为 list', async () => {
    // 单例在模块加载时已经构造过一次，beforeEach 的 setViewMode('list') 会
    // 掩盖真正的构造期默认值——用 resetModules + 动态 import 拿一个全新实例，
    // 在它身上直接断言默认值，而不是断言 setViewMode 的效果。
    // 再清一次 localStorage：上面 beforeEach 的 setViewMode('list') 会把 'list'
    // 写回 storage，不清掉的话下面的默认值断言即使源码默认值出错也可能巧合通过。
    localStorage.clear()
    vi.resetModules()
    const { sessionHubViewStore: freshStore } = await import('./sessionHubViewStore')
    expect(freshStore.getSnapshot().viewMode).toBe('list')
  })

  it('切换视图模式并持久化到 localStorage', () => {
    sessionHubViewStore.toggleViewMode()
    expect(sessionHubViewStore.getSnapshot().viewMode).toBe('folder')
    expect(localStorage.getItem('sessionHubViewMode')).toBe('folder')
  })

  it('toggleProject 标记为 manuallyTouched', () => {
    sessionHubViewStore.toggleProject('project-a')
    expect(sessionHubViewStore.getSnapshot().expandedProjects.has('project-a')).toBe(true)

    // 验证 manuallyTouched：用户手动折叠后，ensureDefaultExpanded 不再生效
    sessionHubViewStore.toggleProject('project-a') // 用户折叠
    sessionHubViewStore.ensureDefaultExpanded('project-a') // 系统尝试默认展开
    expect(sessionHubViewStore.getSnapshot().expandedProjects.has('project-a')).toBe(false)
  })

  it('getSnapshot 返回稳定引用', () => {
    const snapshot1 = sessionHubViewStore.getSnapshot()
    const snapshot2 = sessionHubViewStore.getSnapshot()
    expect(snapshot1).toBe(snapshot2) // 引用相等

    sessionHubViewStore.toggleViewMode()
    const snapshot3 = sessionHubViewStore.getSnapshot()
    expect(snapshot1).not.toBe(snapshot3) // 状态变更后引用不同
  })

  it('subscribe 注册的回调在状态变更时触发，取消订阅后不再触发', () => {
    const calls: number[] = []
    const unsubscribe = sessionHubViewStore.subscribe(() => calls.push(1))

    sessionHubViewStore.toggleViewMode()
    expect(calls.length).toBe(1)

    sessionHubViewStore.toggleProject('project-sub')
    expect(calls.length).toBe(2)

    unsubscribe()
    sessionHubViewStore.toggleViewMode()
    expect(calls.length).toBe(2)
  })

  it('ensureDefaultExpanded 仅在未展开时才展开并触发 notify', () => {
    const calls: number[] = []
    const unsubscribe = sessionHubViewStore.subscribe(() => calls.push(1))

    sessionHubViewStore.ensureDefaultExpanded('project-ensure')
    expect(sessionHubViewStore.getSnapshot().expandedProjects.has('project-ensure')).toBe(true)
    expect(calls.length).toBe(1)

    const snapshotAfterFirst = sessionHubViewStore.getSnapshot()
    sessionHubViewStore.ensureDefaultExpanded('project-ensure') // 已展开，不应再次触发
    expect(calls.length).toBe(1)
    expect(sessionHubViewStore.getSnapshot()).toBe(snapshotAfterFirst)

    unsubscribe()
  })

  it('getSnapshot().expandedProjects 是浅拷贝快照，外部修改不会污染内部状态', () => {
    sessionHubViewStore.toggleProject('project-immutable')
    const snapshot = sessionHubViewStore.getSnapshot()

    snapshot.expandedProjects.add('leaked-project')
    snapshot.expandedProjects.delete('project-immutable')

    // 触发一次新的 snapshot 生成，验证外部对旧 snapshot 的修改没有污染内部真实状态
    sessionHubViewStore.toggleProject('project-immutable-trigger')
    const freshSnapshot = sessionHubViewStore.getSnapshot()

    expect(freshSnapshot.expandedProjects.has('leaked-project')).toBe(false)
    expect(freshSnapshot.expandedProjects.has('project-immutable')).toBe(true)
  })

  it('toggleProject 后展开状态和 manuallyTouched 状态都写入 localStorage', () => {
    sessionHubViewStore.toggleProject('project-persist')

    const expanded = JSON.parse(localStorage.getItem('sessionHubExpandedProjects') ?? '[]')
    const touched = JSON.parse(localStorage.getItem('sessionHubManuallyTouched') ?? '[]')

    expect(expanded).toContain('project-persist')
    expect(touched).toContain('project-persist')
  })
})
