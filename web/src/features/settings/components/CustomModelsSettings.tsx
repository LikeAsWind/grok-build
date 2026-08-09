// ============================================
// CustomModelsSettings - 自定义模型 & 模型供应商 表格（config.toml 表单化 P1）
//
// 数据源：GET /config-file?format=json（[model.*] / [model_providers.*]）
// 写回：PATCH /config-file（toml_edit 结构化修改，保留注释）
// [model.*] 保存后由 shell config watcher 热重载，模型选择器即时可见
// ============================================

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { getGrokConfigParsed, patchGrokConfig, reloadBackendModels } from '../../../api/grokConfig'
import { refreshModels } from '../../../hooks/useModels'
import { settingsFieldClass, SettingsSection } from './SettingsUI'
import { SelectField } from './SelectField'

// ── 字段规格（数据驱动渲染）──────────────────────────────────────────

type FieldKind = 'text' | 'secret' | 'number' | 'select'

interface FieldSpec {
  key: string
  labelKey: string
  kind: FieldKind
  options?: string[] // select：'' 表示继承/默认
  mono?: boolean
  placeholder?: string
}

const API_BACKENDS = ['', 'chat_completions', 'responses', 'messages']

const MODEL_FIELDS: FieldSpec[] = [
  { key: 'name', labelKey: 'customModels.fields.name', kind: 'text' },
  { key: 'model', labelKey: 'customModels.fields.model', kind: 'text', mono: true },
  { key: 'base_url', labelKey: 'customModels.fields.baseUrl', kind: 'text', mono: true, placeholder: 'https://…/v1' },
  { key: 'api_backend', labelKey: 'customModels.fields.apiBackend', kind: 'select', options: API_BACKENDS },
  { key: 'model_provider', labelKey: 'customModels.fields.modelProvider', kind: 'select', options: [''] },
  { key: 'api_key', labelKey: 'customModels.fields.apiKey', kind: 'secret' },
  { key: 'env_key', labelKey: 'customModels.fields.envKey', kind: 'text', mono: true, placeholder: 'ANTHROPIC_API_KEY' },
  { key: 'context_window', labelKey: 'customModels.fields.contextWindow', kind: 'number' },
  { key: 'max_completion_tokens', labelKey: 'customModels.fields.maxTokens', kind: 'number' },
  { key: 'temperature', labelKey: 'customModels.fields.temperature', kind: 'number' },
  { key: 'description', labelKey: 'customModels.fields.description', kind: 'text' },
]

const PROVIDER_FIELDS: FieldSpec[] = [
  { key: 'base_url', labelKey: 'customModels.fields.baseUrl', kind: 'text', mono: true, placeholder: 'https://…/v1' },
  { key: 'api_backend', labelKey: 'customModels.fields.apiBackend', kind: 'select', options: API_BACKENDS },
  { key: 'api_key', labelKey: 'customModels.fields.apiKey', kind: 'secret' },
  { key: 'env_key', labelKey: 'customModels.fields.envKey', kind: 'text', mono: true },
  { key: 'context_window', labelKey: 'customModels.fields.contextWindow', kind: 'number' },
]

const NUMBER_FIELDS = new Set(['context_window', 'max_completion_tokens', 'temperature'])

// ── 添加模板 ─────────────────────────────────────────────────────

const TEMPLATES: Record<string, { idHint: string; fields: Record<string, string> }> = {
  anthropic: {
    idHint: 'claude-sonnet',
    fields: {
      model: 'claude-sonnet-4-5',
      base_url: 'https://api.anthropic.com/v1',
      api_backend: 'messages',
      env_key: 'ANTHROPIC_API_KEY',
      context_window: '200000',
    },
  },
  openai: {
    idHint: 'gpt-5',
    fields: {
      model: 'gpt-5',
      base_url: 'https://api.openai.com/v1',
      api_backend: 'responses',
      env_key: 'OPENAI_API_KEY',
      context_window: '400000',
    },
  },
  ollama: {
    idHint: 'ollama-llama',
    fields: {
      model: 'llama3',
      base_url: 'http://localhost:11434/v1',
      api_backend: 'chat_completions',
      context_window: '128000',
    },
  },
  custom: { idHint: 'my-model', fields: {} },
}

// ── 数据模型 ─────────────────────────────────────────────────────

interface Entry {
  id: string
  /** 原始字段（string 化，供表单编辑与 diff）；数字转字符串 */
  fields: Record<string, string>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function tableToEntries(table: unknown): Entry[] {
  if (!isRecord(table)) return []
  return Object.entries(table).map(([id, fields]) => {
    const flat: Record<string, string> = {}
    if (isRecord(fields)) {
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = String(v)
      }
    }
    return { id, fields: flat }
  })
}

/** 由「原值 vs 草稿」构建 PATCH 操作（空值=删键） */
function buildOps(section: string, id: string, original: Record<string, string> | null, draft: Record<string, string>) {
  const set: Array<{ path: string[]; value: unknown }> = []
  const del: Array<{ path: string[] }> = []
  const keys = new Set([...Object.keys(draft), ...(original ? Object.keys(original) : [])])
  for (const key of keys) {
    const next = (draft[key] ?? '').trim()
    const prev = original?.[key] ?? ''
    if (next === prev) continue
    if (!next) {
      if (original && key in original) del.push({ path: [section, id, key] })
      continue
    }
    let value: unknown = next
    if (NUMBER_FIELDS.has(key)) {
      const n = Number(next)
      if (Number.isNaN(n)) throw new Error(`${key} 必须是数字`)
      value = n
    }
    set.push({ path: [section, id, key], value })
  }
  return { set, delete: del }
}

// ── 字段输入控件 ─────────────────────────────────────────────────

function FieldInput({
  spec,
  value,
  onChange,
  providerIds,
}: {
  spec: FieldSpec
  value: string
  onChange: (v: string) => void
  providerIds: string[]
}) {
  const { t } = useTranslation('settings')
  const [reveal, setReveal] = useState(false)
  const cls = `${settingsFieldClass} ${spec.mono ? 'font-mono' : ''}`

  if (spec.kind === 'select') {
    const options = spec.key === 'model_provider' ? ['', ...providerIds] : (spec.options ?? [''])
    return (
      <SelectField
        value={value}
        options={options.map(opt => ({ value: opt, label: opt || t('customModels.inherit') }))}
        onChange={onChange}
        mono
        ariaLabel={t(spec.labelKey)}
      />
    )
  }
  if (spec.kind === 'secret') {
    return (
      <div className="relative">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={spec.placeholder}
          spellCheck={false}
          className={`${cls} pr-9`}
        />
        <button
          type="button"
          onClick={() => setReveal(r => !r)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-400 hover:text-text-200 text-[length:var(--fs-xs)]"
          aria-label={reveal ? t('customModels.hideSecret') : t('customModels.showSecret')}
        >
          {reveal ? '🙈' : '👁'}
        </button>
      </div>
    )
  }
  return (
    <input
      type="text"
      inputMode={spec.kind === 'number' ? 'decimal' : undefined}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={spec.placeholder}
      spellCheck={false}
      className={cls}
    />
  )
}

// ── 条目编辑器（模型/供应商共用）─────────────────────────────────

function EntryEditor({
  section,
  entry,
  isNew,
  fieldSpecs,
  providerIds,
  existingIds,
  onSaved,
  onCancel,
}: {
  section: 'model' | 'model_providers'
  entry: Entry
  isNew: boolean
  fieldSpecs: FieldSpec[]
  providerIds: string[]
  existingIds: string[]
  onSaved: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [id, setId] = useState(entry.id)
  const [draft, setDraft] = useState<Record<string, string>>({ ...entry.fields })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    const trimmedId = id.trim()
    if (!trimmedId) {
      setError(t('customModels.idRequired'))
      return
    }
    if (isNew && existingIds.includes(trimmedId)) {
      setError(t('customModels.idExists', { id: trimmedId }))
      return
    }
    setSaving(true)
    setError('')
    try {
      const ops = buildOps(section, trimmedId, isNew ? null : entry.fields, draft)
      if (ops.set.length === 0 && ops.delete.length === 0) {
        onCancel()
        return
      }
      await patchGrokConfig(ops)
      // grok web 模式无 config watcher：显式让后端重载模型，再刷新前端模型列表
      await reloadBackendModels()
      void refreshModels()
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-3 rounded-lg border border-accent-main-100/30 bg-accent-main-100/[0.02] space-y-2.5">
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">
          {t('customModels.fields.id')}
        </label>
        <input
          type="text"
          value={id}
          disabled={!isNew}
          onChange={e => {
            setId(e.target.value)
            setError('')
          }}
          spellCheck={false}
          className={`${settingsFieldClass} font-mono disabled:opacity-60`}
          autoFocus={isNew}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5">
        {fieldSpecs.map(spec => (
          <div key={spec.key}>
            <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t(spec.labelKey)}</label>
            <FieldInput
              spec={spec}
              value={draft[spec.key] ?? ''}
              onChange={v => {
                setDraft(d => ({ ...d, [spec.key]: v }))
                setError('')
              }}
              providerIds={providerIds}
            />
          </div>
        ))}
      </div>
      {error && (
        <p className="text-[length:var(--fs-xs)] text-danger-100 whitespace-pre-wrap font-mono">{error}</p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t('common:cancel')}
        </Button>
        <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
          {saving ? t('grokConfig.saving') : t('common:save')}
        </Button>
      </div>
    </div>
  )
}

// ── 密钥状态摘要 ─────────────────────────────────────────────────

function keyStatus(fields: Record<string, string>, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (fields.api_key) return t('customModels.keySet')
  if (fields.env_key) return `env:${fields.env_key}`
  if (fields.model_provider) return t('customModels.keyFromProvider')
  return '—'
}

// ── 主组件 ───────────────────────────────────────────────────────

export function CustomModelsSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const [models, setModels] = useState<Entry[]>([])
  const [providers, setProviders] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [newDraft, setNewDraft] = useState<Entry | null>(null)
  const [newProviderDraft, setNewProviderDraft] = useState<Entry | null>(null)
  const [pickingTemplate, setPickingTemplate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ section: 'model' | 'model_providers'; id: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const cfg = await getGrokConfigParsed()
      if (cfg.parseError) throw new Error(cfg.parseError)
      setModels(tableToEntries(cfg.parsed?.model))
      setProviders(tableToEntries(cfg.parsed?.model_providers))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const providerIds = providers.map(p => p.id)

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await patchGrokConfig({ delete: [{ path: [deleteTarget.section, deleteTarget.id] }] })
      await reloadBackendModels()
      void refreshModels()
      setDeleteTarget(null)
      void load()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      setDeleteTarget(null)
    }
  }

  const entryRow = (
    entry: Entry,
    section: 'model' | 'model_providers',
    onEdit: () => void,
  ) => (
    <div
      key={entry.id}
      className="flex items-center gap-2 p-2.5 rounded-lg border border-border-200/40 hover:border-border-300 transition-colors min-w-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[length:var(--fs-md)] font-medium text-text-100 truncate">{entry.id}</span>
          {entry.fields.api_backend && (
            <span className="shrink-0 px-1.5 py-0.5 rounded text-[length:var(--fs-xxs)] font-mono bg-bg-200/80 text-text-300">
              {entry.fields.api_backend}
            </span>
          )}
        </div>
        <div className="text-[length:var(--fs-xs)] text-text-400 truncate font-mono mt-0.5">
          {entry.fields.base_url || (entry.fields.model_provider ? `→ ${entry.fields.model_provider}` : t('customModels.defaultEndpoint'))}
          {' · '}
          {keyStatus(entry.fields, t)}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 h-7 px-2 rounded-md text-[length:var(--fs-xs)] text-accent-main-100 hover:bg-accent-main-100/10 transition-colors"
      >
        {t('common:edit')}
      </button>
      <button
        type="button"
        onClick={() => setDeleteTarget({ section, id: entry.id })}
        className="shrink-0 h-7 px-2 rounded-md text-[length:var(--fs-xs)] text-text-400 hover:text-danger-100 hover:bg-danger-100/10 transition-colors"
      >
        {t('common:delete')}
      </button>
    </div>
  )

  return (
    <>
      <SettingsSection
        title={t('customModels.title')}
        description={t('customModels.desc')}
        actions={
          <Button size="sm" onClick={() => setPickingTemplate(true)} disabled={!!newDraft || loading}>
            {t('customModels.addModel')}
          </Button>
        }
      >
        <div className="space-y-1.5">
          {loadError && (
            <div className="text-[length:var(--fs-xs)] text-danger-100 bg-danger-100/10 border border-danger-100/20 rounded-md px-2.5 py-2 whitespace-pre-wrap font-mono">
              {loadError}
            </div>
          )}
          {loading && <div className="py-6 text-center text-[length:var(--fs-sm)] text-text-400">{t('common:loading')}</div>}

          {pickingTemplate && (
            <div className="p-3 rounded-lg border border-border-200 bg-bg-100 space-y-2">
              <div className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('customModels.pickTemplate')}</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(TEMPLATES).map(([key, tpl]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setPickingTemplate(false)
                      setNewDraft({ id: tpl.idHint, fields: { ...tpl.fields } })
                    }}
                    className="p-2.5 rounded-lg border border-border-200/60 hover:border-accent-main-100/60 hover:bg-accent-main-100/5 text-left transition-colors"
                  >
                    <div className="text-[length:var(--fs-sm)] font-medium text-text-100">
                      {t(`customModels.templates.${key}`)}
                    </div>
                    <div className="text-[length:var(--fs-xxs)] text-text-400 font-mono mt-0.5 truncate">
                      {tpl.fields.api_backend || 'chat_completions'}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setPickingTemplate(false)}>
                  {t('common:cancel')}
                </Button>
              </div>
            </div>
          )}

          {newDraft && (
            <EntryEditor
              section="model"
              entry={newDraft}
              isNew
              fieldSpecs={MODEL_FIELDS}
              providerIds={providerIds}
              existingIds={models.map(m => m.id)}
              onSaved={() => {
                setNewDraft(null)
                void load()
              }}
              onCancel={() => setNewDraft(null)}
            />
          )}

          {models.map(entry =>
            editingId === entry.id ? (
              <EntryEditor
                key={entry.id}
                section="model"
                entry={entry}
                isNew={false}
                fieldSpecs={MODEL_FIELDS}
                providerIds={providerIds}
                existingIds={[]}
                onSaved={() => {
                  setEditingId(null)
                  void load()
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              entryRow(entry, 'model', () => setEditingId(entry.id))
            ),
          )}
          {!loading && models.length === 0 && !newDraft && (
            <div className="py-4 text-center text-[length:var(--fs-sm)] text-text-400">{t('customModels.empty')}</div>
          )}
          <p className="text-[length:var(--fs-xs)] text-text-400">{t('customModels.hotReloadHint')}</p>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('customModels.providersTitle')}
        description={t('customModels.providersDesc')}
        actions={
          <Button
            size="sm"
            onClick={() => setNewProviderDraft({ id: 'my-provider', fields: {} })}
            disabled={!!newProviderDraft || loading}
          >
            {t('common:add')}
          </Button>
        }
      >
        <div className="space-y-1.5">
          {newProviderDraft && (
            <EntryEditor
              section="model_providers"
              entry={newProviderDraft}
              isNew
              fieldSpecs={PROVIDER_FIELDS}
              providerIds={[]}
              existingIds={providerIds}
              onSaved={() => {
                setNewProviderDraft(null)
                void load()
              }}
              onCancel={() => setNewProviderDraft(null)}
            />
          )}
          {providers.map(entry =>
            editingProviderId === entry.id ? (
              <EntryEditor
                key={entry.id}
                section="model_providers"
                entry={entry}
                isNew={false}
                fieldSpecs={PROVIDER_FIELDS}
                providerIds={[]}
                existingIds={[]}
                onSaved={() => {
                  setEditingProviderId(null)
                  void load()
                }}
                onCancel={() => setEditingProviderId(null)}
              />
            ) : (
              entryRow(entry, 'model_providers', () => setEditingProviderId(entry.id))
            ),
          )}
          {!loading && providers.length === 0 && !newProviderDraft && (
            <div className="py-4 text-center text-[length:var(--fs-sm)] text-text-400">
              {t('customModels.providersEmpty')}
            </div>
          )}
        </div>
      </SettingsSection>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t('customModels.deleteTitle')}
        description={t('customModels.deleteConfirm', { id: deleteTarget?.id ?? '' })}
        confirmText={t('common:delete')}
        cancelText={t('common:cancel')}
      />
    </>
  )
}
