import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../components/ui'
import { CodeBlock } from '../../../components/CodeBlock'
import { StatusBadge } from '../../../components/StatusBadge'
import { useCurrentSessionId } from '../../../store'
import { useSessionStats } from '../../../hooks'
import { useContextInfo } from '../../../hooks/useContextInfo'
import type { ContextInfo } from '../../../types/api/context'

interface ContextDetailsDialogProps {
  isOpen: boolean
  onClose: () => void
  /** 已废弃：弹窗现在直接读后端 `ContextInfo.total`；保留 prop 仅为现有调用方不破坏。 */
  contextLimit?: number
}

/** TUI `fmt_tok_big` 的最小版：≥1M → `1.0m`，≥1k → `36.7k`，否则整数 */
function fmtTokBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 保留两位小数，clamp 到 [0, 100] */
function fmtPct(used: number, total: number): string {
  if (total <= 0) return '0.00%'
  return `${Math.min(100, (used / total) * 100).toFixed(2)}%`
}

export function ContextDetailsDialog({ isOpen, onClose }: ContextDetailsDialogProps) {
  const { t } = useTranslation(['chat', 'common'])

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('contextDetails.context')} width={900} className="w-full">
      {/* 关闭时不挂 body，避免 useContextInfo 在流式时空转 */}
      {isOpen ? <ContextInfoPanel /> : null}
    </Dialog>
  )
}

// ============================================
// 后端 ContextInfo 渲染（Claude Code 风格）+ System Prompt
// ============================================

function ContextInfoPanel() {
  const sessionId = useCurrentSessionId()
  const { info, error } = useContextInfo(sessionId)
  const { t } = useTranslation(['chat', 'common'])

  // loading / error / 空：回退到本地估算（只显示窗口 + used）
  const stats = useSessionStats(info?.total ?? 200000)
  const localUsed = stats.contextUsed
  const localPct = stats.contextPercent

  if (!info) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <div className="text-sm text-text-400">
            {error
              ? t('contextDetails.loadError')
              : localUsed > 0
                ? `${fmtTokBig(localUsed)} / ${fmtTokBig(stats.contextLimit)} tokens (${localPct.toFixed(2)}%)`
                : '—'}
          </div>
        </div>
        {!error && localUsed === 0 && (
          <div className="text-xs text-text-500">{t('contextDetails.statusLoading')}</div>
        )}
      </div>
    )
  }

  return (
    <>
      <ContextInfoContent info={info} />
      <SystemPromptSection systemPrompt={info.systemPrompt} />
    </>
  )
}

function ContextInfoContent({ info }: { info: ContextInfo }) {
  const { t } = useTranslation(['chat', 'common'])
  const used = info.used
  const total = info.total
  const pct = fmtPct(used, total)

  // bar segments（按 TUI `cells_for` 顺序：System → Messages → Overhead → Free）
  const systemTokens = info.systemPromptTokens
  const messageTokens = info.messageTokens
  const overheadTokens = Math.max(0, used - systemTokens - messageTokens)
  const freeTokens = info.freeTokens
  const sum = Math.max(1, systemTokens + messageTokens + overheadTokens + freeTokens)
  const segPct = (n: number) => `${(n / sum) * 100}%`

  // 自动压缩状态
  const threshold = info.autoCompactThresholdPercent
  const usagePct = total > 0 ? (used / total) * 100 : 0
  const aboveThreshold = usagePct >= threshold
  const inTipBand = usagePct >= 80 && usagePct < threshold
  const remainingTokens = Math.max(0, total - used)
  const approxRemaining = Math.round(remainingTokens * (threshold / 100) - (used - (total * threshold) / 100))

  // 信息行（tools + usageCategories）
  const toolRow = {
    label: t('contextDetails.toolDefinitions'),
    tokens: info.toolDefinitionsTokens,
    detail: `${info.toolDefinitionsCount} tools`,
  }
  const extraRows = info.usageCategories.map((c) => ({
    label: c.label,
    tokens: c.tokens,
    detail: c.detail ?? '',
  }))

  return (
    <div className="flex flex-col gap-4">
      {/* Header + Sub-header */}
      <div className="flex flex-col gap-0.5">
        <div className="text-[length:var(--fs-xs)] font-medium text-text-400">
          {t('contextDetails.context')}
        </div>
        <div className="text-[length:var(--fs-xl)] text-text-100 font-mono tabular-nums">
          {fmtTokBig(used)} / {fmtTokBig(total)} tokens ({pct})
        </div>
      </div>

      {/* Categorical stacked bar */}
      <div
        className="w-full h-2 rounded-full overflow-hidden bg-bg-300 flex"
        role="img"
        aria-label="context usage breakdown"
      >
        {systemTokens > 0 && (
          <div className="h-full bg-text-500" style={{ width: segPct(systemTokens) }} />
        )}
        {messageTokens > 0 && (
          <div className="h-full bg-accent-main-100" style={{ width: segPct(messageTokens) }} />
        )}
        {overheadTokens > 0 && (
          <div
            className="h-full bg-violet-100"
            style={{ width: segPct(overheadTokens) }}
          />
        )}
        {freeTokens > 0 && (
          <div className="h-full bg-bg-300" style={{ width: segPct(freeTokens) }} />
        )}
      </div>

      {/* Legend rows（按 TUI 顺序：System / Messages / Overhead / Free） */}
      <div className="flex flex-col gap-1">
        <LegendRow color="bg-text-500" label={t('contextDetails.systemPrompt')} tokens={systemTokens} pct={fmtPct(systemTokens, total)} />
        <LegendRow color="bg-accent-main-100" label={t('contextDetails.messages')} tokens={messageTokens} pct={fmtPct(messageTokens, total)} />
        {overheadTokens > 0 && (
          <LegendRow color="bg-violet-100" label={t('contextDetails.overhead')} tokens={overheadTokens} pct={fmtPct(overheadTokens, total)} />
        )}
        <LegendRow color="bg-bg-300" label={t('contextDetails.free')} tokens={freeTokens} pct={fmtPct(freeTokens, total)} hollow />
      </div>

      {/* Informational rows */}
      <div className="flex flex-col gap-1 border-t border-border-200/40 pt-3">
        <InfoRow color="bg-accent-skill" row={toolRow} total={total} />
        {extraRows.map((r, i) => (
          <InfoRow key={`${r.label}-${i}`} color="bg-accent-skill" row={r} total={total} />
        ))}
      </div>

      {/* Startup phases (NEW) */}
      <div className="flex flex-col gap-1 border-t border-border-200/40 pt-3">
        <div className="text-[length:var(--fs-xs)] font-medium text-text-400 mb-1">
          {t('contextDetails.startup')}
        </div>
        <StatusBadge
          status={info.skillDiscoveryElapsedMs === undefined ? 'loading' : 'done'}
          label={t('contextDetails.skillDiscovery')}
          durationMs={info.skillDiscoveryElapsedMs}
        />
        <StatusBadge
          status={info.systemPromptBuildElapsedMs === undefined ? 'loading' : 'done'}
          label={t('contextDetails.systemPromptBuild')}
          durationMs={info.systemPromptBuildElapsedMs}
        />
        <StatusBadge
          status={info.toolRegistryPrepElapsedMs === undefined ? 'loading' : 'done'}
          label={t('contextDetails.toolRegistryPrep')}
          durationMs={info.toolRegistryPrepElapsedMs}
        />
        <StatusBadge
          status={info.mcpStartupElapsedMs === undefined ? 'loading' : 'done'}
          label={t('contextDetails.mcpStartup')}
          durationMs={info.mcpStartupElapsedMs}
        />
      </div>

      {/* Auto-compact status */}
      <div className="flex flex-col gap-1 border-t border-border-200/40 pt-3 text-[length:var(--fs-sm)]">
        {aboveThreshold ? (
          <div className="text-warning-100">
            {t('contextDetails.autoCompactTriggers', { pct: threshold })}
          </div>
        ) : (
          <div className="text-text-400">
            {t('contextDetails.autoCompactAt', { pct: threshold, remaining: fmtTokBig(Math.max(0, approxRemaining)) })}
          </div>
        )}
        {inTipBand && (
          <div className="text-warning-100">{t('contextDetails.compactTip')}</div>
        )}
      </div>

      {/* Footer stats */}
      <div className="text-[length:var(--fs-xs)] text-text-400 border-t border-border-200/40 pt-3">
        {t('contextDetails.turnsToolCallsCompactions', {
          t: info.turnCount,
          tc: info.toolCallCount,
          c: info.compactionCount,
        })}
      </div>
    </div>
  )
}

function LegendRow({
  color,
  label,
  tokens,
  pct,
  hollow,
}: {
  color: string
  label: string
  tokens: number
  pct: string
  hollow?: boolean
}) {
  return (
    <div className="flex items-center gap-2 text-[length:var(--fs-sm)]">
      <span
        className={`inline-block w-2.5 h-2.5 ${color} ${hollow ? 'border border-border-300' : ''}`}
        aria-hidden="true"
      />
      <span className="text-text-200">{label}</span>
      <span className="ml-auto text-text-100 font-mono tabular-nums">{fmtTokBig(tokens)}</span>
      <span className="text-text-400 font-mono tabular-nums w-16 text-right">{pct}</span>
    </div>
  )
}

function InfoRow({
  color,
  row,
  total,
}: {
  color: string
  row: { label: string; tokens: number; detail: string }
  total: number
}) {
  return (
    <div className="flex items-center gap-2 text-[length:var(--fs-sm)]">
      <span className={`inline-block w-2.5 h-2.5 ${color} opacity-70`} aria-hidden="true" />
      <span className="text-text-200">{row.label}</span>
      <span className="text-text-400">{row.detail}</span>
      <span className="ml-auto text-text-100 font-mono tabular-nums">{fmtTokBig(row.tokens)}</span>
      <span className="text-text-400 font-mono tabular-nums w-16 text-right">
        {fmtPct(row.tokens, total)}
      </span>
    </div>
  )
}

// ============================================
// 下半：当前生效的 System Prompt 全文
// ============================================

function SystemPromptSection({ systemPrompt }: { systemPrompt: string | undefined }) {
  const { t } = useTranslation(['chat', 'common'])

  return (
    <div className="mt-6">
      <div className="text-[length:var(--fs-xs)] font-medium text-text-400 mb-2">
        {t('contextDetails.systemPrompt')}
      </div>
      {systemPrompt ? (
        <CodeBlock code={systemPrompt} language="markdown" maxHeight={420} wordwrap className="select-text" />
      ) : (
        <div className="text-[length:var(--fs-sm)] text-text-500">{t('contextDetails.systemPromptUnavailable')}</div>
      )}
    </div>
  )
}
