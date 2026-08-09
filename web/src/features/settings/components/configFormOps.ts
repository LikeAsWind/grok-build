// ============================================
// 配置表单的取值/回写逻辑（schema 驱动，独立于渲染便于单测）
// ============================================

import type { ConfigFieldDef, ConfigFieldType } from './grokConfigSchema'
import type { GrokConfigPatch } from '../../../api/grokConfig'

/** 表单草稿值：标量统一字符串（'' = 未设置），数组/映射保持结构 */
export type DraftValue = string | string[] | Record<string, string>

export type SectionDraft = Record<string, DraftValue>

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 沿路径读取 parsed 配置里的值 */
export function readPath(root: Record<string, unknown> | undefined, path: string[]): unknown {
  let cur: unknown = root
  for (const seg of path) {
    if (!isRecord(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

function emptyDraft(type: ConfigFieldType): DraftValue {
  if (type === 'stringArray' || type === 'modelArray' || type === 'ruleArray') return []
  if (type === 'stringMap' || type === 'numberMap' || type === 'boolMap' || type === 'modelMap') return {}
  return ''
}

/**
 * 配置值 → 草稿值。类型不匹配（如 bool 位置出现数组）返回 null，
 * 渲染层显示为"复杂值"只读，保存时跳过该字段。
 */
export function toDraftValue(type: ConfigFieldType, value: unknown): DraftValue | null {
  if (value === undefined || value === null) return emptyDraft(type)
  switch (type) {
    case 'bool':
      return typeof value === 'boolean' ? String(value) : null
    case 'number':
      return typeof value === 'number' ? String(value) : null
    case 'string':
    case 'enum':
    case 'model':
      return typeof value === 'string' ? value : null
    case 'stringArray':
    case 'modelArray':
    case 'ruleArray':
      return Array.isArray(value) && value.every(v => typeof v === 'string') ? [...(value as string[])] : null
    case 'stringMap':
    case 'numberMap':
    case 'boolMap':
    case 'modelMap': {
      if (!isRecord(value)) return null
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(value)) {
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null
        out[k] = String(v)
      }
      return out
    }
  }
}

function draftEquals(a: DraftValue, b: DraftValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function isDraftEmpty(value: DraftValue): boolean {
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return Object.keys(value).length === 0
}

/** 草稿值 → 写入 TOML 的 JSON 值；抛错 = 校验失败 */
export function toConfigValue(def: ConfigFieldDef, draft: DraftValue): unknown {
  switch (def.type) {
    case 'bool':
      if (draft !== 'true' && draft !== 'false') throw new Error(`${def.label}: 非法布尔值`)
      return draft === 'true'
    case 'number': {
      const num = Number(draft)
      if (typeof draft !== 'string' || draft.trim() === '' || Number.isNaN(num)) {
        throw new Error(`${def.label}: 必须是数字`)
      }
      return num
    }
    case 'string':
    case 'enum':
    case 'model':
      return typeof draft === 'string' ? draft.trim() : ''
    case 'stringArray':
    case 'modelArray':
    case 'ruleArray':
      return Array.isArray(draft) ? draft.map(v => v.trim()).filter(Boolean) : []
    case 'stringMap':
    case 'numberMap':
    case 'boolMap':
    case 'modelMap': {
      const src = isRecord(draft) ? draft : {}
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(src)) {
        const key = k.trim()
        if (!key) continue
        if (def.type === 'numberMap') {
          const num = Number(v)
          if (Number.isNaN(num)) throw new Error(`${def.label}.${key}: 必须是数字`)
          out[key] = num
        } else if (def.type === 'boolMap') {
          out[key] = v === 'true'
        } else {
          out[key] = v
        }
      }
      return out
    }
  }
}

/**
 * 按 section 构建 PATCH：对比原值与草稿，仅写变化项；空值 = 删键。
 * 字段 key 支持 "a.b" 嵌套（拼进路径）。
 */
export function buildSectionOps(
  sectionPath: string[],
  fields: ConfigFieldDef[],
  original: SectionDraft,
  draft: SectionDraft,
): GrokConfigPatch {
  const set: Array<{ path: string[]; value: unknown }> = []
  const del: Array<{ path: string[] }> = []

  for (const def of fields) {
    const prev = original[def.key] ?? emptyDraft(def.type)
    const next = draft[def.key] ?? emptyDraft(def.type)
    if (draftEquals(prev, next)) continue

    const path = [...sectionPath, ...def.key.split('.')]
    if (isDraftEmpty(next)) {
      if (!isDraftEmpty(prev)) del.push({ path })
      continue
    }
    set.push({ path, value: toConfigValue(def, next) })
  }

  return { set, delete: del }
}
