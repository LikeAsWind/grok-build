// configFormOps 单元测试：草稿↔配置值转换与 section diff → PATCH 构建

import { describe, it, expect } from 'vitest'
import { buildSectionOps, readPath, toDraftValue, toConfigValue } from './configFormOps'
import type { ConfigFieldDef } from './grokConfigSchema'

const boolField: ConfigFieldDef = { key: 'enabled', label: '启用', type: 'bool', default: 'true' }
const numField: ConfigFieldDef = { key: 'timeout_secs', label: '超时', type: 'number' }
const arrField: ConfigFieldDef = { key: 'paths', label: '路径', type: 'stringArray' }
const mapField: ConfigFieldDef = { key: 'env', label: '环境变量', type: 'stringMap' }
const nestedField: ConfigFieldDef = { key: 'claude.skills', label: 'Claude skills', type: 'bool', default: 'true' }
const numMapField: ConfigFieldDef = { key: 'tool_timeouts', label: '工具超时', type: 'numberMap' }

describe('toDraftValue', () => {
  it('标量转字符串草稿', () => {
    expect(toDraftValue('bool', true)).toBe('true')
    expect(toDraftValue('number', 85)).toBe('85')
    expect(toDraftValue('string', 'abc')).toBe('abc')
  })

  it('缺失值转空草稿', () => {
    expect(toDraftValue('bool', undefined)).toBe('')
    expect(toDraftValue('stringArray', undefined)).toEqual([])
    expect(toDraftValue('stringMap', undefined)).toEqual({})
  })

  it('形状不符返回 null（复杂值）', () => {
    // codebase_indexing 可以是 bool 或 glob 数组
    expect(toDraftValue('bool', ['src/**'])).toBeNull()
    expect(toDraftValue('stringArray', 'not-an-array')).toBeNull()
  })
})

describe('toConfigValue', () => {
  it('数字校验', () => {
    expect(toConfigValue(numField, '120')).toBe(120)
    expect(() => toConfigValue(numField, 'abc')).toThrow('必须是数字')
  })

  it('numberMap 值转数字', () => {
    expect(toConfigValue(numMapField, { search: '30' })).toEqual({ search: 30 })
  })
})

describe('buildSectionOps', () => {
  it('仅写变化项，未变化不产生操作', () => {
    const original = { enabled: 'true', timeout_secs: '120' }
    const ops = buildSectionOps(['toolset', 'bash'], [boolField, numField], original, { ...original })
    expect(ops.set).toHaveLength(0)
    expect(ops.delete).toHaveLength(0)
  })

  it('变化项生成 set，类型正确', () => {
    const ops = buildSectionOps(
      ['toolset', 'bash'],
      [boolField, numField],
      { enabled: '', timeout_secs: '' },
      { enabled: 'false', timeout_secs: '300' },
    )
    expect(ops.set).toEqual([
      { path: ['toolset', 'bash', 'enabled'], value: false },
      { path: ['toolset', 'bash', 'timeout_secs'], value: 300 },
    ])
  })

  it('清空已有值生成 delete', () => {
    const ops = buildSectionOps(['skills'], [arrField], { paths: ['~/a'] }, { paths: [] })
    expect(ops.delete).toEqual([{ path: ['skills', 'paths'] }])
    expect(ops.set).toHaveLength(0)
  })

  it('本来就空的值清空不产生 delete', () => {
    const ops = buildSectionOps(['skills'], [arrField], { paths: [] }, { paths: [] })
    expect(ops.delete).toHaveLength(0)
  })

  it('带点的字段 key 拼进嵌套路径', () => {
    const ops = buildSectionOps(['compat'], [nestedField], { 'claude.skills': '' }, { 'claude.skills': 'false' })
    expect(ops.set).toEqual([{ path: ['compat', 'claude', 'skills'], value: false }])
  })

  it('映射整体写入', () => {
    const ops = buildSectionOps(
      ['mcp_servers', 'fs'],
      [mapField],
      { env: {} },
      { env: { PATH: '/usr/bin', DEBUG: '1' } },
    )
    expect(ops.set).toEqual([{ path: ['mcp_servers', 'fs', 'env'], value: { PATH: '/usr/bin', DEBUG: '1' } }])
  })
})

describe('readPath', () => {
  it('嵌套读取', () => {
    const cfg = { toolset: { bash: { timeout_secs: 120 } } }
    expect(readPath(cfg, ['toolset', 'bash', 'timeout_secs'])).toBe(120)
    expect(readPath(cfg, ['toolset', 'missing', 'x'])).toBeUndefined()
  })
})
