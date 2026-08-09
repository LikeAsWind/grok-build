// ============================================
// GrokConfigSettings - grok config.toml 全量可视化配置页
//
// schema 驱动（grokConfigSchema.ts）：分组导航 + 分区卡片，每张卡片
// 独立保存（仅写变化项，toml_edit 保留注释）；标注热生效/需重启；
// 未覆盖的 section 原样保留并以只读卡片提示
// ============================================

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { getGrokConfigParsed, patchGrokConfig, reloadBackend, reloadBackendConfig } from '../../../api/grokConfig'
import { refreshModels } from '../../../hooks/useModels'
import { settingsFieldClass, SettingsSection } from './SettingsUI'
import { ConfigFieldControl } from './ConfigFieldControl'
import {
  buildSectionOps,
  isDraftEmpty,
  readPath,
  toDraftValue,
  type DraftValue,
  type SectionDraft,
} from './configFormOps'
import {
  CONFIG_GROUPS,
  KEYED_TABLES,
  coveredTopLevelSections,
  type ConfigFieldDef,
  type ConfigSectionDef,
  type KeyedTableDef,
  type ReloadKind,
} from './grokConfigSchema'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function afterSaveReload(reload: ReloadKind | undefined) {
  if (reload) {
    await reloadBackend(reload)
    if (reload === 'models') void refreshModels()
  } else {
    // features/session/toolset/ui/permission 等非模型/MCP section：通用热重载
    await reloadBackendConfig().catch(() => {})
  }
}

/** 从 parsed 构建 section 草稿；复杂值（形状不符）记入 complexKeys */
function buildSectionDraft(
  parsed: Record<string, unknown> | undefined,
  sectionPath: string[],
  fields: ConfigFieldDef[],
): { draft: SectionDraft; complexKeys: Set<string> } {
  const draft: SectionDraft = {}
  const complexKeys = new Set<string>()
  for (const def of fields) {
    const raw = readPath(parsed, [...sectionPath, ...def.key.split('.')])
    const value = toDraftValue(def.type, raw)
    if (value === null) complexKeys.add(def.key)
    else draft[def.key] = value
  }
  return { draft, complexKeys }
}

// ── 字段行 ─────────────────────────────────────────────────────

function FieldRow({
  def,
  value,
  complex,
  customized,
  onChange,
}: {
  def: ConfigFieldDef
  value: DraftValue
  complex: boolean
  customized: boolean
  onChange: (v: DraftValue) => void
}) {
  const inline = def.type === 'bool'
  return (
    <div className={inline ? 'flex items-center justify-between gap-3 py-1' : 'py-1 space-y-1'}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[length:var(--fs-sm)] text-text-200">{def.label}</span>
          {customized && <span className="w-1.5 h-1.5 rounded-full bg-accent-main-100 shrink-0" title="已自定义" />}
        </div>
        {def.desc && <div className="text-[length:var(--fs-xs)] text-text-400 leading-relaxed">{def.desc}</div>}
      </div>
      <div className={inline ? 'shrink-0' : ''}>
        <ConfigFieldControl def={def} value={complex ? null : value} onChange={onChange} />
      </div>
    </div>
  )
}

// ── 分区卡片 ───────────────────────────────────────────────────

function SectionCard({
  section,
  parsed,
  onSaved,
}: {
  section: ConfigSectionDef
  parsed: Record<string, unknown> | undefined
  onSaved: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const sectionPath = section.id.split('.')
  const allFields = useMemo(() => [...section.fields, ...(section.advanced ?? [])], [section])
  const [{ draft: original, complexKeys }] = useState(() => buildSectionDraft(parsed, sectionPath, allFields))
  const [draft, setDraft] = useState<SectionDraft>(() => ({ ...original }))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const dirty = useMemo(() => JSON.stringify(original) !== JSON.stringify(draft), [original, draft])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const editable = allFields.filter(f => !complexKeys.has(f.key))
      const ops = buildSectionOps(sectionPath, editable, original, draft)
      if ((ops.set?.length ?? 0) + (ops.delete?.length ?? 0) > 0) {
        await patchGrokConfig(ops)
        await afterSaveReload(section.reload)
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const renderFields = (fields: ConfigFieldDef[]) =>
    fields.map(def => (
      <FieldRow
        key={def.key}
        def={def}
        value={draft[def.key] ?? ''}
        complex={complexKeys.has(def.key)}
        customized={!isDraftEmpty(original[def.key] ?? '')}
        onChange={v => setDraft(d => ({ ...d, [def.key]: v }))}
      />
    ))

  return (
    <div id={`cfg-${section.id.replace(/\./g, '-')}`} className="p-3 rounded-lg border border-border-200/50 bg-bg-100/50 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--fs-md)] font-medium text-text-100">{section.title}</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[length:var(--fs-xxs)] ${
                section.hot ? 'bg-accent-main-100/15 text-accent-main-100' : 'bg-bg-200 text-text-400'
              }`}
            >
              {section.hot ? t('grokConfig.hotBadge') : t('grokConfig.restartBadge')}
            </span>
          </div>
          {section.desc && <div className="text-[length:var(--fs-xs)] text-text-400 mt-0.5">{section.desc}</div>}
        </div>
        {dirty && (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setDraft({ ...original })} disabled={saving}>
              {t('common:cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? t('grokConfig.saving') : t('common:save')}
            </Button>
          </div>
        )}
      </div>

      <div className="divide-y divide-border-200/30">{renderFields(section.fields)}</div>

      {(section.advanced?.length ?? 0) > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            className="text-[length:var(--fs-xs)] text-accent-main-100 hover:text-accent-main-200 transition-colors"
          >
            {showAdvanced ? t('grokConfig.hideAdvanced') : t('grokConfig.showAdvanced')}
          </button>
          {showAdvanced && <div className="divide-y divide-border-200/30">{renderFields(section.advanced!)}</div>}
        </>
      )}

      {error && (
        <div className="text-[length:var(--fs-xs)] text-danger-100 bg-danger-100/10 border border-danger-100/20 rounded-md px-2.5 py-2 whitespace-pre-wrap font-mono">
          {error}
        </div>
      )}
    </div>
  )
}

// ── 动态键表（[section.<名>]，如 mcp_servers）────────────────────

function KeyedTableCard({
  table,
  parsed,
  onSaved,
}: {
  table: KeyedTableDef
  parsed: Record<string, unknown> | undefined
  onSaved: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const allFields = useMemo(() => [...table.fields, ...(table.advanced ?? [])], [table])
  const entries = useMemo(() => {
    const raw = readPath(parsed, [table.id])
    if (!isRecord(raw)) return [] as string[]
    return Object.keys(raw)
  }, [parsed, table.id])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [newEntry, setNewEntry] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const handleDelete = async () => {
    if (!deleteId) return
    try {
      await patchGrokConfig({ delete: [{ path: [table.id, deleteId] }] })
      await afterSaveReload(table.reload)
      setDeleteId(null)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDeleteId(null)
    }
  }

  const summarize = (id: string): string => {
    const raw = readPath(parsed, [table.id, id])
    if (!isRecord(raw)) return ''
    const cmd = typeof raw.command === 'string' ? raw.command : ''
    const url = typeof raw.url === 'string' ? raw.url : ''
    const enabled = raw.enabled === false ? ` · ${t('grokConfig.disabled')}` : ''
    return `${cmd || url}${enabled}`
  }

  return (
    <div id={`cfg-${table.id}`} className="p-3 rounded-lg border border-border-200/50 bg-bg-100/50 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--fs-md)] font-medium text-text-100">{table.title}</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[length:var(--fs-xxs)] ${
                table.hot ? 'bg-accent-main-100/15 text-accent-main-100' : 'bg-bg-200 text-text-400'
              }`}
            >
              {table.hot ? t('grokConfig.hotBadge') : t('grokConfig.restartBadge')}
            </span>
          </div>
          {table.desc && <div className="text-[length:var(--fs-xs)] text-text-400 mt-0.5">{table.desc}</div>}
        </div>
        <Button size="sm" onClick={() => setNewEntry(true)} disabled={newEntry}>
          {t('common:add')}
        </Button>
      </div>

      {error && (
        <div className="text-[length:var(--fs-xs)] text-danger-100 bg-danger-100/10 border border-danger-100/20 rounded-md px-2.5 py-2 whitespace-pre-wrap font-mono">
          {error}
        </div>
      )}

      {newEntry && (
        <KeyedEntryEditor
          table={table}
          allFields={allFields}
          parsed={parsed}
          entryId={null}
          existingIds={entries}
          onDone={saved => {
            setNewEntry(false)
            if (saved) onSaved()
          }}
        />
      )}

      {entries.map(id =>
        editingId === id ? (
          <KeyedEntryEditor
            key={id}
            table={table}
            allFields={allFields}
            parsed={parsed}
            entryId={id}
            existingIds={[]}
            onDone={saved => {
              setEditingId(null)
              if (saved) onSaved()
            }}
          />
        ) : (
          <div
            key={id}
            className="flex items-center gap-2 p-2 rounded-lg border border-border-200/40 hover:border-border-300 transition-colors min-w-0"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[length:var(--fs-sm)] font-medium text-text-100 truncate">{id}</div>
              <div className="text-[length:var(--fs-xs)] text-text-400 truncate font-mono">{summarize(id)}</div>
            </div>
            <button
              type="button"
              onClick={() => setEditingId(id)}
              className="shrink-0 h-7 px-2 rounded-md text-[length:var(--fs-xs)] text-accent-main-100 hover:bg-accent-main-100/10 transition-colors"
            >
              {t('common:edit')}
            </button>
            <button
              type="button"
              onClick={() => setDeleteId(id)}
              className="shrink-0 h-7 px-2 rounded-md text-[length:var(--fs-xs)] text-text-400 hover:text-danger-100 hover:bg-danger-100/10 transition-colors"
            >
              {t('common:delete')}
            </button>
          </div>
        ),
      )}
      {entries.length === 0 && !newEntry && (
        <div className="py-3 text-center text-[length:var(--fs-sm)] text-text-400">{t('grokConfig.noEntries')}</div>
      )}

      <ConfirmDialog
        isOpen={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={() => void handleDelete()}
        title={t('customModels.deleteTitle')}
        description={t('customModels.deleteConfirm', { id: deleteId ?? '' })}
        confirmText={t('common:delete')}
        cancelText={t('common:cancel')}
      />
    </div>
  )
}

function KeyedEntryEditor({
  table,
  allFields,
  parsed,
  entryId,
  existingIds,
  onDone,
}: {
  table: KeyedTableDef
  allFields: ConfigFieldDef[]
  parsed: Record<string, unknown> | undefined
  entryId: string | null
  existingIds: string[]
  onDone: (saved: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [{ draft: original, complexKeys }] = useState(() =>
    entryId ? buildSectionDraft(parsed, [table.id, entryId], allFields) : { draft: {} as SectionDraft, complexKeys: new Set<string>() },
  )
  const [id, setId] = useState(entryId ?? '')
  const [draft, setDraft] = useState<SectionDraft>(() => ({ ...original }))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    const trimmedId = id.trim()
    if (!trimmedId) {
      setError(t('customModels.idRequired'))
      return
    }
    if (!entryId && existingIds.includes(trimmedId)) {
      setError(t('customModels.idExists', { id: trimmedId }))
      return
    }
    setSaving(true)
    setError('')
    try {
      const editable = allFields.filter(f => !complexKeys.has(f.key))
      const ops = buildSectionOps([table.id, trimmedId], editable, entryId ? original : {}, draft)
      if ((ops.set?.length ?? 0) + (ops.delete?.length ?? 0) > 0) {
        await patchGrokConfig(ops)
        await afterSaveReload(table.reload)
      }
      onDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="p-3 rounded-lg border border-accent-main-100/30 bg-accent-main-100/[0.02] space-y-2">
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{table.idLabel}</label>
        <input
          type="text"
          value={id}
          disabled={!!entryId}
          onChange={e => {
            setId(e.target.value)
            setError('')
          }}
          spellCheck={false}
          className={`${settingsFieldClass} font-mono disabled:opacity-60`}
          autoFocus={!entryId}
        />
      </div>
      <div className="divide-y divide-border-200/30">
        {table.fields.map(def => (
          <FieldRow
            key={def.key}
            def={def}
            value={draft[def.key] ?? ''}
            complex={complexKeys.has(def.key)}
            customized={!isDraftEmpty(original[def.key] ?? '')}
            onChange={v => setDraft(d => ({ ...d, [def.key]: v }))}
          />
        ))}
      </div>
      {(table.advanced?.length ?? 0) > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            className="text-[length:var(--fs-xs)] text-accent-main-100 hover:text-accent-main-200 transition-colors"
          >
            {showAdvanced ? t('grokConfig.hideAdvanced') : t('grokConfig.showAdvanced')}
          </button>
          {showAdvanced && (
            <div className="divide-y divide-border-200/30">
              {table.advanced!.map(def => (
                <FieldRow
                  key={def.key}
                  def={def}
                  value={draft[def.key] ?? ''}
                  complex={complexKeys.has(def.key)}
                  customized={!isDraftEmpty(original[def.key] ?? '')}
                  onChange={v => setDraft(d => ({ ...d, [def.key]: v }))}
                />
              ))}
            </div>
          )}
        </>
      )}
      {error && (
        <p className="text-[length:var(--fs-xs)] text-danger-100 whitespace-pre-wrap font-mono">{error}</p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={() => onDone(false)} disabled={saving}>
          {t('common:cancel')}
        </Button>
        <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
          {saving ? t('grokConfig.saving') : t('common:save')}
        </Button>
      </div>
    </div>
  )
}

// ── 主页面 ─────────────────────────────────────────────────────

export function GrokConfigSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const [parsed, setParsed] = useState<Record<string, unknown> | undefined>()
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [activeGroup, setActiveGroup] = useState(CONFIG_GROUPS[0].id)
  /** 递增以强制重建卡片（重新读取 original 草稿） */
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const cfg = await getGrokConfigParsed()
      if (cfg.parseError) throw new Error(cfg.parseError)
      setParsed(isRecord(cfg.parsed) ? cfg.parsed : {})
      setPath(cfg.path)
      setReloadKey(k => k + 1)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const unknownSections = useMemo(() => {
    if (!parsed) return []
    const covered = coveredTopLevelSections()
    return Object.keys(parsed).filter(key => !covered.has(key))
  }, [parsed])

  const group = CONFIG_GROUPS.find(g => g.id === activeGroup) ?? CONFIG_GROUPS[0]
  const groupTables = KEYED_TABLES.filter(tbl =>
    (activeGroup === 'extensions' && tbl.id === 'mcp_servers') || (activeGroup === 'auth' && tbl.id === 'auth_provider'),
  )

  return (
    <SettingsSection
      title={t('grokConfig.title')}
      description={path ? t('grokConfig.descWithPath', { path }) : t('grokConfig.desc')}
      actions={
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          {t('common:refresh')}
        </Button>
      }
    >
      <div className="space-y-3">
        {loadError && (
          <div className="text-[length:var(--fs-xs)] text-danger-100 bg-danger-100/10 border border-danger-100/20 rounded-md px-2.5 py-2 whitespace-pre-wrap font-mono">
            {loadError}
          </div>
        )}
        {loading && <div className="py-6 text-center text-[length:var(--fs-sm)] text-text-400">{t('common:loading')}</div>}

        {!loading && !loadError && (
          <>
            {/* 分组导航 */}
            <div className="flex flex-wrap gap-1.5">
              {CONFIG_GROUPS.map(g => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setActiveGroup(g.id)}
                  className={`h-7 px-2.5 rounded-md text-[length:var(--fs-sm)] transition-colors ${
                    g.id === activeGroup
                      ? 'bg-accent-main-100/15 text-accent-main-100 font-medium'
                      : 'text-text-300 hover:text-text-100 hover:bg-bg-200/60'
                  }`}
                >
                  {g.title}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              {group.sections.map(section => (
                <SectionCard
                  key={`${section.id}-${reloadKey}`}
                  section={section}
                  parsed={parsed}
                  onSaved={() => void load()}
                />
              ))}
              {groupTables.map(table => (
                <KeyedTableCard key={`${table.id}-${reloadKey}`} table={table} parsed={parsed} onSaved={() => void load()} />
              ))}
            </div>

            {activeGroup === 'system' && unknownSections.length > 0 && (
              <div className="p-3 rounded-lg border border-border-200/40 bg-bg-100/30">
                <div className="text-[length:var(--fs-sm)] text-text-300 mb-1">{t('grokConfig.preservedTitle')}</div>
                <div className="text-[length:var(--fs-xs)] text-text-400 font-mono">{unknownSections.join(', ')}</div>
                <div className="text-[length:var(--fs-xs)] text-text-400 mt-1">{t('grokConfig.preservedHint')}</div>
              </div>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  )
}
