// useRouter hash 路由的回归测试。
// 重点盯住"#/workbench 但没选目录"这个状态 —— buildHash 之前会把它降级成 "#/"
// 导致 App.tsx 的 isWorkbenchActive 一直是 false,点了工作台没反应。
// 现在用 null sentinel 表达"在 workbench 但没选目录"。

import { beforeEach, describe, expect, it } from 'vitest'
import { buildHash, parseHash } from './useRouter'

beforeEach(() => {
  // parseHash 直接读 window.location.hash —— 测试里用赋值触发,不依赖 hashchange 事件
  window.location.hash = ''
})

describe('useRouter hash <-> state', () => {
  describe('parseHash', () => {
    it('"#/workbench" 解析为"在工作台但还没选目录" —— workbenchDirectory 必须是 null', () => {
      window.location.hash = '#/workbench'
      const state = parseHash()
      expect(state.sessionId).toBeNull()
      expect(state.workbenchDirectory).toBeNull()
    })

    it('"#/workbench?dir=C:/repo" 解析为"在工作台且选了这个目录"', () => {
      window.location.hash = '#/workbench?dir=C:/repo'
      const state = parseHash()
      expect(state.sessionId).toBeNull()
      expect(state.workbenchDirectory).toBe('C:/repo')
    })

    it('"#/" 解析为"不在工作台"', () => {
      window.location.hash = '#/'
      const state = parseHash()
      expect(state.workbenchDirectory).toBeUndefined()
    })

    it('"#/session/X" 解析为"不在工作台"', () => {
      window.location.hash = '#/session/X'
      const state = parseHash()
      expect(state.workbenchDirectory).toBeUndefined()
    })
  })

  describe('buildHash', () => {
    it('workbenchDirectory=null 写出纯 "#/workbench" —— 不能丢掉"在工作台"这件事', () => {
      expect(buildHash(null, undefined, null)).toBe('#/workbench')
    })

    it('workbenchDirectory=string 写出 "#/workbench?dir=..."', () => {
      expect(buildHash(null, undefined, 'C:/repo')).toBe('#/workbench?dir=C%3A%2Frepo')
    })

    it('workbenchDirectory=undefined 回到普通 home / session 路由', () => {
      expect(buildHash(null, undefined, undefined)).toBe('#/')
      expect(buildHash(null, 'C:/repo', undefined)).toBe('#/?dir=C%3A%2Frepo')
      expect(buildHash('sess-1', undefined, undefined)).toBe('#/session/sess-1')
    })
  })

  describe('round-trip', () => {
    it('parse(build(#/workbench)) 保留 null sentinel', () => {
      const built = buildHash(null, undefined, null)
      window.location.hash = built
      expect(parseHash()).toMatchObject({ workbenchDirectory: null })
    })

    it('parse(build(#/workbench?dir=X)) 保留 dir', () => {
      const built = buildHash(null, undefined, 'C:/repo')
      window.location.hash = built
      expect(parseHash()).toMatchObject({ workbenchDirectory: 'C:/repo' })
    })
  })
})
