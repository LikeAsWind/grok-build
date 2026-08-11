// ============================================
// sessionCwdForWire —— 回归测试
// 锁定 bug「加载历史聊天记录一直转圈」的根因契约：
// 发给后端的 cwd 统一归一化为正斜杠（与磁盘多数派 %2F 目录一致）。
// ============================================

import { describe, it, expect } from 'vitest'
import { sessionCwdForWire } from './sessionCwd'

describe('sessionCwdForWire', () => {
  it('Windows 反斜杠路径归一化为正斜杠', () => {
    expect(sessionCwdForWire('C:\\Program Files\\Development\\AI_Projects\\grok-build'))
      .toBe('C:/Program Files/Development/AI_Projects/grok-build')
  })

  it('正斜杠路径保持不变', () => {
    expect(sessionCwdForWire('C:/Program Files/Development'))
      .toBe('C:/Program Files/Development')
  })

  it('Unix 路径保持不变', () => {
    expect(sessionCwdForWire('/home/user/project')).toBe('/home/user/project')
  })

  it('去掉首尾空白后再归一化斜杠', () => {
    expect(sessionCwdForWire('  C:\\a\\b  ')).toBe('C:/a/b')
  })

  it('同一逻辑盘的正反斜杠输入归一到同一目录键（消歧）', () => {
    // 同一个 cwd 的两种写法必须 encode 到同一个 session 目录，
    // 否则 session/list 看得到、session/load 却找不到（Path not found）。
    expect(sessionCwdForWire('C:\\Program Files\\grok-build'))
      .toBe(sessionCwdForWire('C:/Program Files/grok-build'))
  })
})
