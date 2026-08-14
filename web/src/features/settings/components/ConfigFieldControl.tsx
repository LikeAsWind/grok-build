// ============================================
// 配置表单控件 —— schema 驱动的单字段渲染
// bool→开关 / enum→下拉 / 数组→chips / 映射→键值行 / string|number→输入框
// ============================================

import { useId, useState } from 'react'
import { useModels } from '../../../hooks/useModels'
import { settingsFieldClass } from './SettingsUI'
import { SelectField } from './SelectField'
import type { ConfigFieldDef } from './grokConfigSchema'
import type { DraftValue } from './configFormOps'

/** 权限规则组合器用的工具类别（compact 规则语法的工具名） */
const RULE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'WebFetch', 'WebSearch', 'MCPTool']

function Toggle({ value, defaultValue, onChange }: { value: string; defaultValue?: string; onChange: (v: string) => void }) {
  const effective = value === '' ? defaultValue === 'true' : value === 'true'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={effective}
      onClick={() => onChange(effective ? 'false' : 'true')}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        effective ? 'bg-accent-main-100' : 'bg-bg-300'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          effective ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

function ArrayEditor({
  value,
  onChange,
  mono,
  suggestions,
}: {
  value: string[]
  onChange: (v: string[]) => void
  mono?: boolean
  suggestions?: string[]
}) {
  const [input, setInput] = useState('')
  const listId = useId()
  const commit = () => {
    const item = input.trim()
    if (!item) return
    onChange([...value, item])
    setInput('')
  }
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((item, index) => (
            <span
              key={`${item}-${index}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-200/80 text-[length:var(--fs-xs)] text-text-200 ${mono ? 'font-mono' : ''}`}
            >
              {item}
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="text-text-400 hover:text-danger-100"
                aria-label="移除"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={input}
        list={suggestions?.length ? listId : undefined}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        onBlur={commit}
        placeholder="输入后回车添加"
        spellCheck={false}
        className={`${settingsFieldClass} font-mono`}
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.map(sug => (
            <option key={sug} value={sug} />
          ))}
        </datalist>
      ) : null}
    </div>
  )
}

/** 权限规则组合器：工具下拉 + 模式输入 → "Tool(pattern)" chips */
function RuleArrayEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [tool, setTool] = useState('Bash')
  const [pattern, setPattern] = useState('')

  const add = () => {
    const rule = pattern.trim() ? `${tool}(${pattern.trim()})` : tool
    if (value.includes(rule)) return
    onChange([...value, rule])
    setPattern('')
  }

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((item, index) => (
            <span
              key={`${item}-${index}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-200/80 text-[length:var(--fs-xs)] font-mono text-text-200"
            >
              {item}
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="text-text-400 hover:text-danger-100"
                aria-label="移除"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <SelectField
          value={tool}
          options={RULE_TOOLS.map(name => ({ value: name, label: name }))}
          onChange={setTool}
          mono
          className="!w-32 shrink-0"
          ariaLabel="工具"
        />
        <input
          type="text"
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={tool === 'Bash' ? 'git *' : tool === 'MCPTool' ? 'my-server__*' : 'src/**（留空 = 全部）'}
          spellCheck={false}
          className={`${settingsFieldClass} font-mono`}
        />
        <button
          type="button"
          onClick={add}
          className="shrink-0 h-8 px-2.5 rounded-md text-[length:var(--fs-xs)] font-medium text-accent-main-100 hover:bg-accent-main-100/10 transition-colors"
        >
          添加
        </button>
      </div>
    </div>
  )
}

/** 模型下拉：选项来自当前可用模型；当前值不在列表时保留为选项 */
function ModelSelect({
  value,
  defaultHint,
  onChange,
  className,
}: {
  value: string
  defaultHint?: string
  onChange: (v: string) => void
  className?: string
}) {
  const { models } = useModels()
  const ids = models.map(m => m.id)
  const known = value && !ids.includes(value) ? [value, ...ids] : ids
  const options = [
    { value: '', label: defaultHint ? `（默认: ${defaultHint}）` : '（默认）' },
    ...known.map(id => ({ value: id, label: id })),
  ]
  return <SelectField value={value} options={options} onChange={onChange} mono className={className} ariaLabel="模型" />
}

/** 模型数组：下拉选择添加为 chips（glob 模式可手输，用 datalist 提示） */
function ModelArrayEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { models } = useModels()
  return <ArrayEditor value={value} onChange={onChange} mono suggestions={models.map(m => m.id)} />
}

function MapEditor({
  value,
  onChange,
  valueKind,
}: {
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  valueKind: 'string' | 'number' | 'bool' | 'model'
}) {
  const entries = Object.entries(value)
  const [newKey, setNewKey] = useState('')

  const setEntry = (key: string, v: string) => onChange({ ...value, [key]: v })
  const removeEntry = (key: string) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }

  return (
    <div className="space-y-1.5">
      {entries.map(([key, v]) => (
        <div key={key} className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xs)] text-text-300" title={key}>
            {key}
          </span>
          {valueKind === 'bool' ? (
            <Toggle value={v || 'false'} onChange={next => setEntry(key, next)} />
          ) : valueKind === 'model' ? (
            <ModelSelect value={v} onChange={next => setEntry(key, next)} className="!w-48 shrink-0" />
          ) : (
            <input
              type="text"
              inputMode={valueKind === 'number' ? 'decimal' : undefined}
              value={v}
              onChange={e => setEntry(key, e.target.value)}
              spellCheck={false}
              className={`${settingsFieldClass} !w-40 font-mono`}
            />
          )}
          <button
            type="button"
            onClick={() => removeEntry(key)}
            className="shrink-0 text-text-400 hover:text-danger-100 text-[length:var(--fs-xs)] px-1"
            aria-label="移除"
          >
            ✕
          </button>
        </div>
      ))}
      <input
        type="text"
        value={newKey}
        onChange={e => setNewKey(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const key = newKey.trim()
            if (key && !(key in value)) {
              onChange({ ...value, [key]: valueKind === 'bool' ? 'true' : '' })
              setNewKey('')
            }
          }
        }}
        placeholder="新键名，回车添加"
        spellCheck={false}
        className={`${settingsFieldClass} font-mono`}
      />
    </div>
  )
}

export function ConfigFieldControl({
  def,
  value,
  onChange,
}: {
  def: ConfigFieldDef
  /** null = 文件里存在但形状与 schema 不符（复杂值），只读展示 */
  value: DraftValue | null
  onChange: (v: DraftValue) => void
}) {
  const [reveal, setReveal] = useState(false)

  if (value === null) {
    return <div className="text-[length:var(--fs-xs)] text-text-400 italic">复杂值（保持原样，不在表单中修改）</div>
  }

  switch (def.type) {
    case 'bool': {
      if (!def.invert) return <Toggle value={value as string} defaultValue={def.default} onChange={onChange} />
      // 取反显示：TOML 存 true = 开关关（如 [ui] yolo=true 呈现为"询问权限"关闭）
      const raw = value as string
      const flipped = raw === 'true' ? 'false' : raw === 'false' ? 'true' : ''
      return <Toggle value={flipped} defaultValue={def.default} onChange={v => onChange(v === 'true' ? 'false' : 'true')} />
    }
    case 'enum':
      return (
        <SelectField
          value={value as string}
          options={(def.options ?? ['']).map(opt => ({
            value: opt,
            label: opt || `（默认${def.default ? `: ${def.default}` : ''}）`,
          }))}
          onChange={onChange}
          ariaLabel={def.label}
        />
      )
    case 'model':
      return <ModelSelect value={value as string} defaultHint={def.default} onChange={onChange} />
    case 'ruleArray':
      return <RuleArrayEditor value={value as string[]} onChange={onChange} />
    case 'modelArray':
      return <ModelArrayEditor value={value as string[]} onChange={onChange} />
    case 'stringArray':
      return <ArrayEditor value={value as string[]} onChange={onChange} mono suggestions={def.suggestions} />
    case 'stringMap':
    case 'numberMap':
    case 'boolMap':
    case 'modelMap':
      return (
        <MapEditor
          value={value as Record<string, string>}
          onChange={onChange}
          valueKind={
            def.type === 'numberMap' ? 'number' : def.type === 'boolMap' ? 'bool' : def.type === 'modelMap' ? 'model' : 'string'
          }
        />
      )
    case 'number':
    case 'string':
    default: {
      if (def.secret) {
        return (
          <div className="relative">
            <input
              type={reveal ? 'text' : 'password'}
              value={value as string}
              onChange={e => onChange(e.target.value)}
              placeholder={def.default}
              spellCheck={false}
              className={`${settingsFieldClass} pr-9 font-mono`}
            />
            <button
              type="button"
              onClick={() => setReveal(r => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-400 hover:text-text-200 text-[length:var(--fs-xs)]"
              aria-label={reveal ? '隐藏' : '显示'}
            >
              {reveal ? '🙈' : '👁'}
            </button>
          </div>
        )
      }
      return (
        <input
          type="text"
          inputMode={def.type === 'number' ? 'decimal' : undefined}
          value={value as string}
          onChange={e => onChange(e.target.value)}
          placeholder={def.default}
          spellCheck={false}
          className={`${settingsFieldClass} ${def.mono || def.type === 'number' ? 'font-mono' : ''}`}
        />
      )
    }
  }
}
