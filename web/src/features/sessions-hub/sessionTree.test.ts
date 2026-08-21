// buildSessionTree / resolveChildTitle 纯函数测试。
// 覆盖：顶层判定、父被筛掉时子提升为顶层、开关两种模式、祖孙关系不渲染（已知限制）、
// resolveChildTitle 的 fallback 与引用不变性。

import { describe, expect, it } from 'vitest'
import { buildSessionTree, resolveChildTitle } from './sessionTree'
import type { ApiSession } from '../../api'

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    directory: 'C:\\repo',
    title: 'session',
    version: '',
    time: { created: 1000, updated: 2000 },
    ...overrides,
  } as ApiSession
}

describe('buildSessionTree', () => {
  it('没有可解析父 id 的 session 归为顶层', () => {
    const a = makeSession({ id: 'a' })
    const b = makeSession({ id: 'b' })
    const { topLevel, childrenByParent } = buildSessionTree([a, b], {
      showAllChildren: false,
      selectedSessionId: null,
      busySessionIds: new Set(),
      getParentId: () => undefined,
    })
    expect(topLevel).toEqual([a, b])
    expect(childrenByParent.size).toBe(0)
  })

  it('父在当前 sessions 集合中时，子会话不进入顶层，挂到父的 childrenByParent 下', () => {
    const parent = makeSession({ id: 'p' })
    const child = makeSession({ id: 'c' })
    const { topLevel, childrenByParent } = buildSessionTree([parent, child], {
      showAllChildren: true,
      selectedSessionId: null,
      busySessionIds: new Set(),
      getParentId: id => (id === 'c' ? 'p' : undefined),
    })
    expect(topLevel).toEqual([parent])
    expect(childrenByParent.get('p')).toEqual([child])
  })

  it('父不在当前 sessions 集合（被筛掉）时，子会话提升为顶层', () => {
    const child = makeSession({ id: 'c' })
    const { topLevel, childrenByParent } = buildSessionTree([child], {
      showAllChildren: true,
      selectedSessionId: null,
      busySessionIds: new Set(),
      getParentId: id => (id === 'c' ? 'missing-parent' : undefined),
    })
    expect(topLevel).toEqual([child])
    expect(childrenByParent.size).toBe(0)
  })

  it('showAllChildren=true 时显示所有子会话', () => {
    const parent = makeSession({ id: 'p' })
    const c1 = makeSession({ id: 'c1' })
    const c2 = makeSession({ id: 'c2' })
    const { childrenByParent } = buildSessionTree([parent, c1, c2], {
      showAllChildren: true,
      selectedSessionId: null,
      busySessionIds: new Set(),
      getParentId: id => (id === 'c1' || id === 'c2' ? 'p' : undefined),
    })
    expect(childrenByParent.get('p')).toEqual([c1, c2])
  })

  it('showAllChildren=false 时只显示忙碌中或当前选中的子会话，其余被丢弃', () => {
    const parent = makeSession({ id: 'p' })
    const busyChild = makeSession({ id: 'busy' })
    const selectedChild = makeSession({ id: 'selected' })
    const idleChild = makeSession({ id: 'idle' })
    const { childrenByParent } = buildSessionTree([parent, busyChild, selectedChild, idleChild], {
      showAllChildren: false,
      selectedSessionId: 'selected',
      busySessionIds: new Set(['busy']),
      getParentId: id => (['busy', 'selected', 'idle'].includes(id) ? 'p' : undefined),
    })
    expect(childrenByParent.get('p')).toEqual([busyChild, selectedChild])
  })

  it('showAllChildren=false 且没有忙碌/选中子会话时，父没有 children 条目', () => {
    const parent = makeSession({ id: 'p' })
    const idleChild = makeSession({ id: 'idle' })
    const { childrenByParent } = buildSessionTree([parent, idleChild], {
      showAllChildren: false,
      selectedSessionId: null,
      busySessionIds: new Set(),
      getParentId: id => (id === 'idle' ? 'p' : undefined),
    })
    expect(childrenByParent.has('p')).toBe(false)
  })

  it('祖孙关系不渲染：孙会话既不提升为顶层也不出现在任何 childrenByParent 里（已知限制，与旧代码行为对齐）', () => {
    const grandparent = makeSession({ id: 'gp' })
    const parent = makeSession({ id: 'p' })
    const grandchild = makeSession({ id: 'gc' })
    const { topLevel, childrenByParent } = buildSessionTree([grandparent, parent, grandchild], {
      showAllChildren: true,
      selectedSessionId: null,
      busySessionIds: new Set(),
      getParentId: id => {
        if (id === 'p') return 'gp'
        if (id === 'gc') return 'p'
        return undefined
      },
    })
    expect(topLevel).toEqual([grandparent])
    expect(childrenByParent.get('gp')).toEqual([parent])
    expect(childrenByParent.has('gc')).toBe(false)
    for (const children of childrenByParent.values()) {
      expect(children.some(s => s.id === 'gc')).toBe(false)
    }
  })
})

describe('resolveChildTitle', () => {
  it('session.title 为空且 childInfo.title 有值时，返回带 fallback 标题的新对象', () => {
    const session = makeSession({ id: 'c', title: '' })
    const result = resolveChildTitle(session, { title: 'spawned description' })
    expect(result.title).toBe('spawned description')
    expect(result).not.toBe(session)
  })

  it('session.title 有值时，原样返回同一个引用（不产生新对象，避免无意义重渲染）', () => {
    const session = makeSession({ id: 'c', title: 'real title' })
    const result = resolveChildTitle(session, { title: 'spawned description' })
    expect(result).toBe(session)
  })

  it('childInfo 缺失时，原样返回同一个引用', () => {
    const session = makeSession({ id: 'c', title: '' })
    const result = resolveChildTitle(session, undefined)
    expect(result).toBe(session)
  })

  it('childInfo.title 为空字符串时，原样返回同一个引用', () => {
    const session = makeSession({ id: 'c', title: '' })
    const result = resolveChildTitle(session, { title: '' })
    expect(result).toBe(session)
  })
})
